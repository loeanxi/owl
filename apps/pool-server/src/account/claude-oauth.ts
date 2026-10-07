/**
 * Claude 订阅号授权 —— 移植自 manager `ClaudeOAuthService`。
 * 生成 PKCE 链接，管理员把回调地址或授权码粘贴回来，服务端再换 token。
 */
import { createHash, randomBytes } from "node:crypto";
import type { AccountStore } from "owl-pool";
import { BusinessError, parseCredentials } from "owl-pool";
import { type ClaudeTokenOptions, exchangeClaudeAuthorizationCode } from "../gateway/claude-token.ts";

const PENDING_TTL_MS = 600_000;

export interface ClaudeOauthConfig extends ClaudeTokenOptions {
	authorizeUrl: string;
	redirectUri: string;
	scopes: string;
}

interface PendingFlow {
	verifier: string;
	state: string;
	createdAt: number;
	expectedCredentials: string;
}

export class ClaudeOauthLogin {
	readonly #accounts: AccountStore;
	readonly #config: ClaudeOauthConfig;
	readonly #pending = new Map<string, PendingFlow>();

	constructor(accounts: AccountStore, config: ClaudeOauthConfig) {
		this.#accounts = accounts;
		this.#config = config;
	}

	login(accountId: string): Record<string, unknown> {
		const account = this.#accounts.require(accountId);
		if (account.platform !== "CLAUDE") {
			throw BusinessError.of("account.platformMismatch", "账号平台不是 CLAUDE");
		}
		const verifier = base64Url(32);
		const state = base64Url(16);
		this.#pending.set(accountId, {
			verifier,
			state,
			createdAt: Date.now(),
			expectedCredentials: JSON.stringify(account.credentials),
		});
		const params = new URLSearchParams({
			code: "true",
			client_id: this.#config.clientId,
			response_type: "code",
			redirect_uri: this.#config.redirectUri,
			scope: this.#config.scopes,
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			state,
		});
		return {
			platform: "CLAUDE",
			authorizeUrl: `${this.#config.authorizeUrl}?${params.toString()}`,
			expiresInSeconds: PENDING_TTL_MS / 1000,
			status: "PENDING",
			message: "在浏览器打开授权链接并登录 Claude，授权后把回调地址（或页面显示的授权码）粘贴到登录输入框完成绑定",
		};
	}

	status(accountId: string): Record<string, unknown> {
		const account = this.#accounts.require(accountId);
		const credentials = parseCredentials(account);
		const bound = text(credentials.refreshToken) !== null || text(credentials.apiKey) !== null;
		const pending = this.#pending.get(accountId);
		const pendingAlive = pending !== undefined && pending.createdAt + PENDING_TTL_MS > Date.now();
		return {
			platform: "CLAUDE",
			authenticated: bound,
			pending: pendingAlive,
			authType: text(credentials.authType) ?? "apikey",
			status: bound ? "COMPLETED" : pendingAlive ? "PENDING" : "FAILED",
			message: bound
				? "CLAUDE 账号凭证已绑定"
				: pendingAlive
					? "等待授权：在浏览器完成 Claude 登录后，把回调地址或授权码粘贴到输入框"
					: "尚未绑定凭证：点击重新发起授权，或直接粘贴 refreshToken / apiKey",
		};
	}

	async input(accountId: string, raw: string): Promise<void> {
		const pending = this.#pending.get(accountId);
		if (pending === undefined || pending.createdAt + PENDING_TTL_MS <= Date.now()) {
			this.#pending.delete(accountId);
			throw BusinessError.of("account.oauthFlowExpired", "授权流程不存在或已过期，请重新发起");
		}
		if (raw.trim().length === 0) {
			throw BusinessError.of("account.oauthInputRequired", "请粘贴授权回调地址或授权码");
		}
		const parsed = parseOauthCode(raw.trim());
		if (parsed.state !== null && parsed.state !== pending.state) {
			throw BusinessError.of("account.oauthStateMismatch", "授权回调 state 不匹配，请重新发起授权");
		}
		if (parsed.code === null) {
			throw BusinessError.of("account.oauthInputRequired", "回调地址中未找到授权码 code");
		}
		try {
			await exchangeClaudeAuthorizationCode(
				this.#accounts,
				this.#config,
				accountId,
				parsed.code,
				pending.verifier,
				pending.expectedCredentials,
			);
		} finally {
			this.#pending.delete(accountId);
		}
	}

	cancel(accountId: string): void {
		this.#pending.delete(accountId);
	}
}

export function parseOauthCode(raw: string): { code: string | null; state: string | null } {
	const trimmed = raw.trim();
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			throw BusinessError.of("account.oauthInputRequired", "回调地址解析失败，请粘贴完整地址或裸授权码");
		}
		const code = url.searchParams.get("code") ?? fragmentParam(url.hash, "code");
		const state = url.searchParams.get("state") ?? fragmentParam(url.hash, "state");
		if (code === null) {
			const last = url.pathname.split("/").pop() ?? "";
			return { code: last.length > 0 ? last : null, state };
		}
		return { code, state };
	}
	const hash = trimmed.indexOf("#");
	if (hash > 0) {
		return { code: trimmed.slice(0, hash), state: hash < trimmed.length - 1 ? trimmed.slice(hash + 1) : null };
	}
	return { code: trimmed, state: null };
}

function fragmentParam(hash: string, key: string): string | null {
	const body = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!body.includes("=")) {
		return null;
	}
	return new URLSearchParams(body).get(key);
}

function base64Url(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

function text(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 || trimmed.startsWith("****") ? null : trimmed;
}
