/**
 * SDK 桥运行时客户端 —— 移植自 manager `bridge/SdkRuntimeClient`。
 * 每个隔离账号一个 node 子进程：stdin 写 JSON 行请求，stdout 读事件帧
 * （单帧 4MiB 上限），stderr 只吞不透（原始 SDK 诊断可能含密钥/内容）。
 * 事件类型：result/done/error 终结并摘除监听，其余推给监听器。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type Account, GatewayFault, type Platform } from "owl-pool";

export interface SdkRuntimeOptions {
	nodeExecutable: string;
	script: string;
	platform: Platform;
	account: Account;
	/** 账号隔离 home（内含 gateway-sessions 工作区）。 */
	accountHome: string;
	credentials: Record<string, unknown>;
	userHome: string;
	initializeTimeoutMs?: number;
}

export interface BridgeEvent {
	event: string;
	code?: string;
	data?: unknown;
	[key: string]: unknown;
}

type EventListener = (event: BridgeEvent) => void;

export class SdkRuntimeClient {
	readonly #process: ChildProcess;
	readonly #workspace: string;
	readonly #listeners = new Map<string, EventListener>();
	#writeLine: ((line: string) => Promise<void>) | null = null;
	#closed = false;
	#lastAccess = Date.now();

	private constructor(process: ChildProcess, workspace: string) {
		this.#process = process;
		this.#workspace = workspace;
	}

	/** 创建并等待 initialize 完成；失败即关闭进程。 */
	static async create(options: SdkRuntimeOptions): Promise<SdkRuntimeClient> {
		const script = options.script;
		if (!existsSync(script)) {
			throw new GatewayFault(503, "runtime_not_installed", "SDK bridge is not installed");
		}
		mkdirSync(options.accountHome, { recursive: true });
		const home = realpathSync(options.accountHome);
		cleanGeneratedChildren(join(home, "runtime"), "bridge-");
		cleanGeneratedChildren(join(home, "gateway-sessions"), "runtime-");
		const sessionRoot = join(home, "gateway-sessions");
		mkdirSync(sessionRoot, { recursive: true });
		const workspace = realpathSync(mktempDir(sessionRoot, "runtime-"));

		// 环境白名单清洗：子进程读不到开发环境密钥（安全加固清单 #13）
		const pass = new Set([
			"PATH",
			"SYSTEMROOT",
			"WINDIR",
			"COMSPEC",
			"PATHEXT",
			"TEMP",
			"TMP",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"ALL_PROXY",
			"NO_PROXY",
			"SSL_CERT_FILE",
			"NODE_EXTRA_CA_CERTS",
			"LANG",
			"LC_ALL",
		]);
		const env: Record<string, string> = { NO_OPEN_BROWSER: "1", CI: "1" };
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && pass.has(key.toUpperCase())) {
				env[key] = value;
			}
		}
		const child = spawn(options.nodeExecutable, [script, "--platform", options.platform, "--home", home], {
			cwd: workspace,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const client = new SdkRuntimeClient(child, workspace);
		// stdout 专用于协议帧；stderr 只吞不透
		child.stderr?.on("data", () => {});
		const readline = createInterface({ input: child.stdout! });
		readline.on("line", (line) => client.#onLine(line));
		child.on("exit", () => client.close());

		client.#writeLine = (line: string) =>
			new Promise<void>((resolve, reject) => {
				const stdin = child.stdin;
				if (stdin === null) {
					reject(new Error("stdin closed"));
					return;
				}
				stdin.write(`${line}\n`, "utf8", (error) => (error === null ? resolve() : reject(error)));
			});

		try {
			const result = await client.request(
				"initialize",
				{
					credentials: options.credentials ?? {},
					workspace,
					// 真 OS profile 根：隔离 env 之外，Cursor 配额回退要读桌面应用 state.vscdb
					userHome: options.userHome,
				},
				options.initializeTimeoutMs ?? 30_000,
			);
			if (result.initialized !== true) {
				throw new GatewayFault(502, "runtime_protocol_error", "平台运行组件初始化失败");
			}
			return client;
		} catch (error) {
			client.close();
			throw error;
		}
	}

	get workspace(): string {
		return this.#workspace;
	}

	/** 请求-响应；error 事件转 GatewayFault（映射见 failure()）。 */
	request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const settle = (fn: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				fn();
			};
			const id = this.start(method, params, (event) => {
				if (event.event === "error") {
					settle(() => reject(failure(event)));
				} else if (event.event === "result") {
					settle(() => resolve((event.data ?? {}) as Record<string, unknown>));
				}
			});
			timer = setTimeout(
				() => {
					settle(() => reject(new GatewayFault(504, "runtime_timeout", "模型服务响应超时")));
					this.#listeners.delete(id);
				},
				Math.max(1, timeoutMs),
			);
		});
	}

	/** 流式入口：登记监听器并返回请求 id（done/result/error 自动摘除）。 */
	start(method: string, params: Record<string, unknown>, listener: EventListener): string {
		if (!this.isAlive()) {
			throw new GatewayFault(503, "runtime_unavailable", "模型服务暂时不可用");
		}
		const id = randomUUID();
		this.#listeners.set(id, listener);
		this.#lastAccess = Date.now();
		this.#write(id, method, params);
		return id;
	}

	#write(id: string, method: string, params: Record<string, unknown>): void {
		const writeLine = this.#writeLine;
		if (writeLine === null) {
			this.#listeners.delete(id);
			throw new GatewayFault(503, "runtime_unavailable", "模型服务连接未就绪");
		}
		writeLine(JSON.stringify({ id, method, params }))
			.then(() => {
				this.#lastAccess = Date.now();
			})
			.catch(() => {
				this.#listeners.delete(id);
			});
	}

	detach(id: string | null | undefined): void {
		if (id !== null && id !== undefined) {
			this.#listeners.delete(id);
		}
	}

	isAlive(): boolean {
		return !this.#closed && this.#process.exitCode === null && this.#process.signalCode === null;
	}

	idleFor(durationMs: number): boolean {
		return this.#listeners.size === 0 && Date.now() - this.#lastAccess > durationMs;
	}

	#onLine(line: string): void {
		try {
			if (line.length > 4_194_304) {
				throw new Error("Bridge event too large");
			}
			const event = JSON.parse(line) as BridgeEvent;
			if (typeof event.event !== "string") {
				throw new Error("Invalid bridge frame");
			}
			if ((event.id === null || event.id === undefined) && event.event === "error") {
				throw new Error("Bridge startup failed");
			}
			const id = String(event.id ?? "");
			const terminal = event.event === "result" || event.event === "done" || event.event === "error";
			const listener = this.#listeners.get(id);
			if (listener === undefined) {
				return;
			}
			if (terminal) {
				this.#listeners.delete(id);
			}
			listener(event);
		} catch {
			// 原始 SDK 输出可能含密钥或内容，绝不进入日志；协议帧损坏即关闭进程
			this.close();
		}
	}

	close(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		const failure: BridgeEvent = { event: "error", code: "runtime_closed" };
		for (const [id, listener] of [...this.#listeners]) {
			if (this.#listeners.delete(id)) {
				try {
					listener(failure);
				} catch {
					// 忽略
				}
			}
		}
		try {
			if (this.#process.exitCode === null) {
				void this.#writeLine?.(JSON.stringify({ id: randomUUID(), method: "shutdown", params: {} }));
			}
		} catch {
			// 忽略
		}
		setTimeout(() => {
			try {
				if (this.#process.exitCode === null) {
					this.#process.kill();
				}
			} catch {
				// 忽略
			}
			try {
				rmSync(this.#workspace, { recursive: true, force: true });
			} catch {
				// 忽略
			}
		}, 1000);
	}
}

/** 桥 error 码 → 网关受控错误（原始 SDK 诊断不外泄）。 */
export function failure(event: Record<string, unknown>): GatewayFault {
	const code = String(event.code ?? "upstream_unavailable").toLowerCase();
	if (code.includes("qoder_cli")) {
		return new GatewayFault(
			503,
			"qoder_runtime_unavailable",
			"Qoder CN 运行组件未启动，请检查 bridge 依赖后重新授权",
		);
	}
	if (code.includes("auth") || code.includes("login")) {
		return new GatewayFault(503, "upstream_auth_required", "当前模型暂时不可用，请联系管理员");
	}
	if (code.includes("rate") || code.includes("quota")) {
		return new GatewayFault(429, "upstream_capacity", "当前模型资源繁忙，请稍后重试");
	}
	if (code.includes("timeout")) {
		return new GatewayFault(
			504,
			code.includes("tool") ? "tool_result_timeout" : "upstream_timeout",
			"模型或工具结果响应超时",
		);
	}
	if (code.includes("unsupported") || code.includes("invalid")) {
		return new GatewayFault(400, "unsupported_request", "当前模型不支持这项请求参数或能力");
	}
	if (code.includes("cancel")) {
		return new GatewayFault(409, "request_cancelled", "请求已取消");
	}
	return new GatewayFault(502, "upstream_unavailable", "模型服务暂时不可用");
}

function cleanGeneratedChildren(dir: string, prefix: string): void {
	if (!existsSync(dir)) {
		return;
	}
	try {
		for (const entry of readdirSync(dir)) {
			if (entry.startsWith(prefix)) {
				rmSync(join(dir, entry), { recursive: true, force: true });
			}
		}
	} catch {
		// 忽略
	}
}

function mktempDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}
