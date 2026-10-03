import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MailAccountStatus } from "./types.ts";

export interface GoogleClient {
	clientId: string;
	clientSecret: string;
}

export interface StoredMailAccount {
	id: string;
	email: string;
	label: string;
	status: MailAccountStatus;
	scopes: string[];
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	lastSyncedAt?: string;
	error?: string;
}

export interface MailStoreData {
	client?: GoogleClient;
	accounts: StoredMailAccount[];
}

export type SecretTransform = (value: string) => Promise<string>;

// The fixed script reads secrets only through stdin. Windows DPAPI binds ciphertext
// to the current Windows user; credentials never appear in argv or process logs.
const DPAPI_SCRIPT = `Add-Type -AssemblyName System.Security
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String($inputData.value)
if ($inputData.action -eq 'seal') {
  $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Console]::Out.Write([Convert]::ToBase64String($result))`;

function dpapi(value: string, action: "seal" | "unseal"): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], {
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.resume();
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Windows 邮箱授权保护超时，请重试。"));
		}, 15_000);
		timer.unref();
		child.on("error", () => reject(new Error("无法使用 Windows 用户凭据保护邮箱授权。")));
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 || !output.trim()) {
				reject(new Error("无法读取或保护邮箱授权，请使用原 Windows 用户重试。"));
				return;
			}
			resolve(action === "seal" ? output.trim() : Buffer.from(output.trim(), "base64").toString("utf8"));
		});
		child.stdin.on("error", () => reject(new Error("无法保护邮箱授权。")));
		child.stdin.end(
			JSON.stringify({ action, value: action === "seal" ? Buffer.from(value).toString("base64") : value }),
		);
	});
}

export class MailStore {
	readonly path: string;
	private readonly directory: string;
	private readonly seal?: SecretTransform;
	private readonly unseal?: SecretTransform;
	private readonly protection: string;
	private saveQueue: Promise<void> = Promise.resolve();

	constructor(agentDir: string, seal?: SecretTransform, unseal?: SecretTransform) {
		if (Boolean(seal) !== Boolean(unseal)) throw new Error("邮箱凭据保护函数必须成对配置。");
		this.directory = join(agentDir, "mail");
		this.path = join(this.directory, "accounts.json");
		this.seal = seal ?? (process.platform === "win32" ? (value) => dpapi(value, "seal") : undefined);
		this.unseal = unseal ?? (process.platform === "win32" ? (value) => dpapi(value, "unseal") : undefined);
		this.protection = seal ? "custom" : process.platform === "win32" ? "windows-dpapi" : "file-permissions";
	}

	async load(): Promise<MailStoreData> {
		let content: string;
		try {
			content = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [] };
			throw new Error("无法读取本机邮箱配置。");
		}
		try {
			const envelope = JSON.parse(content) as { version: number; protection: string; payload: string };
			if (
				envelope.version !== 1 ||
				envelope.protection !== this.protection ||
				typeof envelope.payload !== "string"
			) {
				throw new Error("Unsupported mailbox store");
			}
			const data = JSON.parse(this.unseal ? await this.unseal(envelope.payload) : envelope.payload) as MailStoreData;
			if (!Array.isArray(data.accounts)) throw new Error("Invalid mailbox store");
			return data;
		} catch {
			throw new Error("无法解锁本机邮箱授权，请使用原系统用户和凭据保护方式。");
		}
	}

	save(data: MailStoreData): Promise<void> {
		const snapshot = JSON.stringify(data);
		const operation = this.saveQueue
			.catch(() => {})
			.then(async () => {
				await mkdir(this.directory, { recursive: true, mode: 0o700 });
				const payload = this.seal ? await this.seal(snapshot) : snapshot;
				const temporary = `${this.path}.${randomUUID()}.tmp`;
				// Non-Windows hosts use owner-only directory/file permissions. No secret
				// encryption claim is made for this portable fallback.
				try {
					await writeFile(temporary, JSON.stringify({ version: 1, protection: this.protection, payload }), {
						mode: 0o600,
						flag: "wx",
					});
					await rename(temporary, this.path);
				} finally {
					await unlink(temporary).catch(() => undefined);
				}
			});
		this.saveQueue = operation;
		return operation;
	}
}
