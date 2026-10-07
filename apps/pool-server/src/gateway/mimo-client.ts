/**
 * MiMo 对话上游 —— 移植自 manager `mimo/MimoServeRuntime` + `MimoProcess`
 * + `MimoUpstreamChatClient`。
 *
 * 按账号维护隔离的 `mimo serve` 进程：MIMOCODE_HOME 指向账号的独立目录
 * （凭据 mimoHome 必须是已存在目录，先用该目录完成 mimo providers login）；
 * /v1 需 `mimo llm-server issue` 签发的 Bearer token；上游即 OpenAI 兼容，
 * 非流式直转，流式取回完整 SSE 文本后逐帧转发。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
	type Account,
	OpenAiStreamCompletion,
	type Platform,
	parseCredentials,
	SseEventReader,
	type UpstreamChatClient,
	UpstreamException,
} from "owl-pool";

export interface MimoConfig {
	executable: string;
	hostname: string;
	requestTimeoutMs: number;
	readyTimeoutMs: number;
}

export interface MimoClientOptions {
	config: MimoConfig;
	/** 全部 MIMO 账号（用于 mimoHome 唯一性校验）。 */
	allAccounts(): Account[];
	fetchImpl?: typeof fetch;
}

interface ServeEntry {
	process: ReturnType<typeof spawn>;
	baseUrl: string;
	bearer: string;
	home: string;
}

/** 每账号隔离的 mimo serve 管理器。 */
export class MimoServeManager {
	readonly #config: MimoConfig;
	readonly #allAccounts: () => Account[];
	readonly #entries = new Map<string, ServeEntry>();

	constructor(options: MimoClientOptions) {
		this.#config = options.config;
		this.#allAccounts = options.allAccounts;
	}

	stop(): void {
		for (const entry of this.#entries.values()) {
			try {
				entry.process.kill();
			} catch {
				// 忽略
			}
		}
		this.#entries.clear();
	}

	async clientFor(account: Account): Promise<ServeEntry> {
		const home = this.resolveHome(account);
		const existing = this.#entries.get(account.id);
		if (existing !== undefined && existing.home === home && existing.process.exitCode === null) {
			return existing;
		}
		this.stopAccount(account.id);
		try {
			const entry = await this.boot(home);
			this.#entries.set(account.id, entry);
			return entry;
		} catch (error) {
			throw new UpstreamException(
				"SERVER",
				`MiMo 运行时启动失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	stopAccount(accountId: string): void {
		const entry = this.#entries.get(accountId);
		if (entry !== undefined) {
			this.#entries.delete(accountId);
			try {
				entry.process.kill();
			} catch {
				// 忽略
			}
		}
	}

	/** mimoHome 凭据：必须为已存在的绝对路径目录，且全池唯一。 */
	#resolveHome(account: Account): string {
		const credentials = parseCredentials(account);
		const raw = credentials.mimoHome;
		if (typeof raw !== "string" || raw.trim().length === 0) {
			throw new UpstreamException("BAD_REQUEST", "MIMO 账号必须提供独立的 mimoHome 绝对路径");
		}
		const home = resolve(raw.trim());
		if (!existsSync(home)) {
			throw new UpstreamException(
				"BAD_REQUEST",
				"mimoHome 目录不存在或路径无效；请先用该 MIMOCODE_HOME 完成 mimo providers login",
			);
		}
		for (const [otherId] of this.#entries) {
			if (otherId !== account.id) {
				const other = this.#allAccounts().find((item) => item.id === otherId);
				const otherRaw = other === undefined ? null : parseCredentials(other).mimoHome;
				if (typeof otherRaw === "string" && resolve(otherRaw.trim()) === home) {
					throw new UpstreamException("BAD_REQUEST", "mimoHome 已被其他 MIMO 账号使用");
				}
			}
		}
		return home;
	}

	// 公开包装供内部两处调用
	resolveHome(account: Account): string {
		return this.#resolveHome(account);
	}

	async #boot(home: string): Promise<ServeEntry> {
		const port = await freePort();
		mkdirSync(home, { recursive: true });
		const serve = this.start(["serve", "--port", String(port), "--hostname", this.#config.hostname, "--pure"], home);
		const baseUrl = `http://${this.#config.hostname}:${port}`;
		const entry: ServeEntry = { process: serve, baseUrl, bearer: "", home };
		if (!(await this.awaitReady(entry))) {
			serve.kill();
			throw new Error("mimo serve did not become ready");
		}
		const token = await this.mintLlmToken(home);
		if (token.trim().length === 0) {
			serve.kill();
			throw new Error("mimo llm-server issue did not return api_key");
		}
		entry.bearer = token;
		return entry;
	}

	async boot(home: string): Promise<ServeEntry> {
		return this.#boot(home);
	}

	#start(args: string[], home: string): ReturnType<typeof spawn> {
		const executable = this.#config.executable;
		const argv: string[] = [];
		if (/\.cmd$/i.test(executable)) {
			argv.push("cmd.exe", "/c");
		}
		argv.push(executable, ...args);
		return spawn(argv[0]!, argv.slice(1), { cwd: home, env: { ...process.env, MIMOCODE_HOME: home } });
	}

	start(args: string[], home: string): ReturnType<typeof spawn> {
		return this.#start(args, home);
	}

	/** /v1 必须带 llm-server 签发的 Bearer token，与 serve 绑定同一工作目录。 */
	async mintLlmToken(home: string): Promise<string> {
		const proc = this.#start(["llm-server", "issue", "--json", "--label", "owl-mimo-pool", "--ttl", "30d"], home);
		let out = "";
		let err = "";
		proc.stdout?.on("data", (chunk) => {
			out += String(chunk);
		});
		proc.stderr?.on("data", (chunk) => {
			err += String(chunk);
		});
		const code = await new Promise<number | null>((resolveExit) => {
			const timer = setTimeout(() => {
				proc.kill("SIGKILL");
				resolveExit(-1);
			}, 30_000);
			proc.on("exit", (exitCode) => {
				clearTimeout(timer);
				resolveExit(exitCode);
			});
		});
		if (code !== 0) {
			throw new Error(`mimo llm-server issue failed: ${(err + out).trim().slice(0, 200)}`);
		}
		try {
			const parsed = JSON.parse(out) as Record<string, unknown>;
			return String(parsed.api_key ?? parsed.apiKey ?? "");
		} catch {
			throw new Error(`cannot parse mimo llm-server issue JSON: ${truncate(out, 120)}`);
		}
	}

	async awaitReady(entry: ServeEntry): Promise<boolean> {
		const deadline = Date.now() + this.#config.readyTimeoutMs;
		while (Date.now() < deadline) {
			if (entry.process.exitCode !== null) {
				return false;
			}
			try {
				const response = await fetch(`${entry.baseUrl}/v1/models`, {
					headers: { Authorization: `Bearer ${entry.bearer}` },
					signal: AbortSignal.timeout(2000),
				});
				if (response.status < 500) {
					return true;
				}
			} catch {
				// serve 尚未监听
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 200));
		}
		return false;
	}
}

async function freePort(): Promise<number> {
	const net = await import("node:net");
	return new Promise((resolvePort, rejectPort) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			server.close(() => resolvePort(port));
		});
		server.on("error", rejectPort);
	});
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max);
}

/** MiMo 对话客户端：上游即 OpenAI 兼容（本地 serve 端口）。 */
export class MimoChatClient implements UpstreamChatClient {
	readonly #manager: MimoServeManager;
	readonly #options: MimoClientOptions;

	constructor(manager: MimoServeManager, options: MimoClientOptions) {
		this.#manager = manager;
		this.#options = options;
	}

	platform(): Platform {
		return "MIMO";
	}

	async chatCompletion(account: Account, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		const entry = await this.#manager.clientFor(account);
		const request = normalizeMimoPayload(payload, false);
		const response = await this.post(entry, request);
		const parsed = (await response.json()) as Record<string, unknown>;
		if (parsed.error !== null && typeof parsed.error === "object") {
			const message = (parsed.error as Record<string, unknown>).message;
			throw new UpstreamException("SERVER", `MiMo 拒绝请求: ${String(message ?? "unknown")}`);
		}
		return parsed;
	}

	async chatCompletionStream(
		account: Account,
		payload: Record<string, unknown>,
		onChunk: (chunkJson: string) => void,
	): Promise<void> {
		const entry = await this.#manager.clientFor(account);
		const request = normalizeMimoPayload(payload, true);
		const response = await this.post(entry, request);
		// mimo serve 对 stream:true 回完整 SSE 文本；逐帧转发
		const completion = new OpenAiStreamCompletion();
		const sse = new SseEventReader();
		const text = await response.text();
		for (const line of text.split("\n")) {
			const event = sse.next(line.replace(/\r$/, ""));
			if (event === null) {
				continue;
			}
			const data = event.data;
			if (data.trim() === "[DONE]") {
				completion.done();
				break;
			}
			try {
				completion.observe(JSON.parse(data));
			} catch {
				// 聚合容错
			}
			onChunk(data);
		}
		completion.requireComplete();
	}

	async post(entry: ServeEntry, body: unknown): Promise<Response> {
		const response = await this.#options.fetchImpl?.(`${entry.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${entry.bearer}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream, application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.#options.config.requestTimeoutMs),
		});
		if (response === undefined) {
			throw new UpstreamException("SERVER", "fetch 未配置");
		}
		return response;
	}
}

/** 归一：模型缺省 mimo-auto、剥 mimo/ 前缀、强制 stream 标志。 */
export function normalizeMimoPayload(payload: Record<string, unknown>, stream: boolean): Record<string, unknown> {
	const request: Record<string, unknown> = { ...payload };
	let model = typeof request.model === "string" ? request.model : "mimo-auto";
	if (model.trim().length === 0) {
		model = "mimo-auto";
	}
	if (model.toLowerCase().startsWith("mimo/")) {
		model = model.slice(model.indexOf("/") + 1);
	}
	request.model = model;
	request.stream = stream;
	return request;
}
