import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ProgressCallback, RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getAgentDir } from "../../config.ts";

export const REA_PACKAGE_VERSION = "6.4.0";
export const REA_ALLOWED_TOOLS = [
	"binary_session",
	"open_binary",
	"close_binary",
	"binary_overview",
	"list_procedures",
	"list_strings",
	"analyze_function",
	"procedure_references",
	"get_call_graph",
	"analyze_javascript_application",
	"inspect_analysis_view",
	"export_evidence_bundle",
	"inspect_managed_artifact",
	"inspect_managed_members",
	"inspect_managed_native_boundaries",
] as const;

const CALL_TIMEOUT_MS = 360_000;
const CONNECT_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_CONFIGURATION_BYTES = 16_384;

export interface ResearchReaInventory {
	status: "available" | "toolMissing" | "invalidConfiguration";
	version?: string;
	packageRoot?: string;
	nodePath?: string;
	entryPath?: string;
	configPath: string;
	ghidraHome?: string;
	javaHome?: string;
	message: string;
}

export interface ResearchReaCleanup {
	status: "complete" | "cleanupIncomplete";
	ownerSessionId: string;
	errors: string[];
}

export type ResearchReaSdkClient = Pick<Client, "connect" | "listTools" | "callTool" | "getServerVersion" | "close">;

/** Host-only injection points, never accepted from a model tool request. */
export interface ResearchReaClientOptions {
	agentDir?: string;
	environment?: NodeJS.ProcessEnv;
	clientFactory?: () => ResearchReaSdkClient;
	transportFactory?: (parameters: StdioServerParameters) => Transport;
}

export class ResearchReaError extends Error {
	readonly cleanup?: ResearchReaCleanup;

	constructor(message: string, cleanup?: ResearchReaCleanup) {
		super(message);
		this.name = "ResearchReaError";
		this.cleanup = cleanup;
	}
}

interface Connection {
	client: ResearchReaSdkClient;
	transport: Transport;
	tools: Set<string>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readConfiguration(
	path: string,
	maximumBytes = MAX_CONFIGURATION_BYTES,
): Promise<Record<string, unknown>> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size > maximumBytes) throw new Error("REA 配置文件无效或超出大小上限");
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("REA 工具链配置必须是 JSON 对象");
	return value as Record<string, unknown>;
}

function absolutePath(value: unknown, label: string): string {
	if (typeof value !== "string" || !isAbsolute(value) || /[\x00\r\n]/.test(value)) {
		throw new Error(`${label} 必须是绝对本地路径`);
	}
	return value;
}

async function installedPath(value: unknown, label: string, directory: boolean): Promise<string> {
	const path = await realpath(absolutePath(value, label));
	const stat = await lstat(path);
	if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`${label} 类型不正确`);
	return path;
}

/** A deadline also bounds transport startup and mocks that do not honor SDK cancellation. */
async function boundedRequest<T>(
	request: (options: RequestOptions) => Promise<T>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	onProgress?: ProgressCallback,
): Promise<T> {
	signal?.throwIfAborted();
	const controller = new AbortController();
	let rejectBoundary: (reason: unknown) => void = () => {};
	const boundary = new Promise<never>((_resolve, reject) => {
		rejectBoundary = reject;
	});
	const abort = () => {
		const reason = signal?.reason ?? new Error("REA 操作已取消");
		controller.abort(reason);
		rejectBoundary(reason);
	};
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => {
		const reason = new Error(`REA 请求超过 ${timeoutMs} ms，已终止本次连接`);
		controller.abort(reason);
		rejectBoundary(reason);
	}, timeoutMs);
	try {
		return await Promise.race([
			request({
				signal: controller.signal,
				timeout: timeoutMs,
				maxTotalTimeout: timeoutMs,
				resetTimeoutOnProgress: false,
				...(onProgress ? { onprogress: onProgress } : {}),
			}),
			boundary,
		]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

/** One session owner, one subprocess and one REA Evidence ledger. Never registers global MCP tools. */
export class ResearchReaClient {
	readonly ownerSessionId: string;
	private readonly options: ResearchReaClientOptions;
	private readonly agentDir: string;
	private readonly environment: NodeJS.ProcessEnv;
	private connection?: Connection;
	private activeController?: AbortController;
	private cleanupPromise?: Promise<ResearchReaCleanup>;
	private cleanupFailure?: ResearchReaCleanup;
	private disposed = false;

	constructor(ownerSessionId: string, options: ResearchReaClientOptions = {}) {
		if (!ownerSessionId.trim()) throw new Error("REA 必须绑定会话");
		this.ownerSessionId = ownerSessionId;
		this.options = options;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.environment = options.environment ?? process.env;
	}

	/** File-only inventory; it does not spawn REA, Ghidra or any selected application. */
	async inventory(): Promise<ResearchReaInventory> {
		const toolRoot = join(this.agentDir, "tools", "research-rea");
		const configPath = join(toolRoot, "rea-toolchain.json");
		let version: string | undefined;
		let packageRoot: string | undefined;
		let nodePath: string | undefined;
		try {
			let configuration: Record<string, unknown>;
			try {
				configuration = await readConfiguration(configPath);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				configuration = {
					version: REA_PACKAGE_VERSION,
					packageRoot: join(toolRoot, "node_modules", "rea-agents"),
					nodePath: process.execPath,
				};
			}
			if (configuration.version !== REA_PACKAGE_VERSION)
				throw new Error(`REA 工具链只接受固定版本 ${REA_PACKAGE_VERSION}`);
			packageRoot = await installedPath(configuration.packageRoot, "REA packageRoot", true);
			const metadata = await readConfiguration(join(packageRoot, "package.json"), 256 * 1024);
			version = typeof metadata.version === "string" ? metadata.version : undefined;
			if (metadata.name !== "rea-agents" || version !== REA_PACKAGE_VERSION) {
				throw new Error(
					`REA 包身份或版本不匹配：需要 rea-agents@${REA_PACKAGE_VERSION}，实际 ${String(metadata.name)}@${String(version)}`,
				);
			}
			nodePath = await installedPath(configuration.nodePath, "REA nodePath", false);
			const entryPath = await installedPath(join(packageRoot, "scripts", "rea.mjs"), "REA 入口", false);
			const localEntry = relative(packageRoot, entryPath);
			if (isAbsolute(localEntry) || localEntry === ".." || localEntry.startsWith(`..${sep}`))
				throw new Error("REA 入口离开已核验安装目录");
			await installedPath(join(packageRoot, "dist", "main.js"), "REA MCP runtime", false);
			let ghidraHome = configuration.ghidraHome;
			let javaHome = configuration.javaHome;
			if (ghidraHome === undefined || javaHome === undefined) {
				try {
					const native = await readConfiguration(
						join(this.agentDir, "tools", "research-decompilers", "native-toolchain.json"),
					);
					ghidraHome ??= native.ghidraHome;
					javaHome ??= native.javaHome;
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				}
			}
			const selectedGhidra =
				ghidraHome === undefined ? undefined : await installedPath(ghidraHome, "Ghidra 安装", true);
			const selectedJava = javaHome === undefined ? undefined : await installedPath(javaHome, "Java 安装", true);
			return {
				status: "available",
				version,
				packageRoot,
				nodePath,
				entryPath,
				configPath,
				...(selectedGhidra ? { ghidraHome: selectedGhidra } : {}),
				...(selectedJava ? { javaHome: selectedJava } : {}),
				message: selectedGhidra
					? "REA 固定版本已就绪；原生分析可用性由会话查询核验"
					: "REA 固定版本已就绪；未配置 Ghidra，静态 JavaScript 和托管程序集仍可查询",
			};
		} catch (error) {
			return {
				status:
					error instanceof Error && "code" in error && error.code === "ENOENT"
						? "toolMissing"
						: "invalidConfiguration",
				configPath,
				...(version ? { version } : {}),
				...(packageRoot ? { packageRoot } : {}),
				...(nodePath ? { nodePath } : {}),
				message: errorText(error),
			};
		}
	}

	async call(
		name: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onProgress?: ProgressCallback,
	): Promise<CallToolResult> {
		if (!(REA_ALLOWED_TOOLS as readonly string[]).includes(name))
			throw new ResearchReaError(`当前会话未开放 REA 工具：${name}`);
		if (this.disposed) throw new ResearchReaError("REA 会话已关闭");
		if (this.cleanupFailure) throw new ResearchReaError("REA 上次清理未完成，拒绝重用会话", this.cleanupFailure);
		if (this.activeController) throw new ResearchReaError("REA 同一会话不能并行改变分析状态");
		signal?.throwIfAborted();
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		this.activeController = controller;
		try {
			if (!this.connection) await this.connect(controller.signal);
			const connection = this.connection;
			if (!connection || this.disposed) throw new Error("REA 连接已关闭");
			if (!connection.tools.has(name)) throw new Error(`已连接的 REA 未声明工具：${name}`);
			// SDK 1.x puts RequestOptions in the third argument. Keep both Evidence representations intact.
			return (await boundedRequest(
				(options) => connection.client.callTool({ name, arguments: params }, undefined, options),
				controller.signal,
				CALL_TIMEOUT_MS,
				onProgress,
			)) as CallToolResult;
		} catch (error) {
			const cleanup = await this.cleanup(false);
			throw new ResearchReaError(errorText(error), cleanup);
		} finally {
			signal?.removeEventListener("abort", abort);
			this.activeController = undefined;
		}
	}

	private async connect(signal: AbortSignal): Promise<void> {
		const inventory = await this.inventory();
		if (inventory.status !== "available" || !inventory.packageRoot || !inventory.nodePath || !inventory.entryPath) {
			throw new Error(inventory.message);
		}
		signal.throwIfAborted();
		const env: Record<string, string> = {};
		for (const key of [
			"APPDATA",
			"LOCALAPPDATA",
			"PATH",
			"PATHEXT",
			"PROCESSOR_ARCHITECTURE",
			"SYSTEMDRIVE",
			"SYSTEMROOT",
			"TEMP",
			"TMP",
			"USERNAME",
			"USERPROFILE",
			"PROGRAMFILES",
			"HOMEDRIVE",
			"HOMEPATH",
			"COMSPEC",
			"HOME",
			"LOGNAME",
			"USER",
			"LANG",
			"LC_ALL",
		]) {
			const source = Object.keys(this.environment).find((entry) => entry.toUpperCase() === key);
			const value = source === undefined ? undefined : this.environment[source];
			if (value !== undefined && !value.startsWith("()")) env[key] = value;
		}
		env.REA_MCP_MAX_RESPONSE_BYTES = String(MAX_RESPONSE_BYTES);
		env.REA_GHIDRA_STARTUP_TIMEOUT_MS = "330000";
		if (inventory.ghidraHome) {
			env.GHIDRA_INSTALL_DIR = inventory.ghidraHome;
			env.REA_ANALYSIS_PROVIDER = "ghidra";
		}
		if (inventory.javaHome) env.JAVA_HOME = inventory.javaHome;
		const parameters: StdioServerParameters = {
			command: inventory.nodePath,
			args: [inventory.entryPath, "mcp"],
			env,
			cwd: inventory.packageRoot,
			stderr: "pipe",
			maxBufferSize: MAX_RESPONSE_BYTES,
		};
		const transport = this.options.transportFactory?.(parameters) ?? new StdioClientTransport(parameters);
		if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
		const client = this.options.clientFactory?.() ?? new Client({ name: "owl-research", version: "1.0.0" });
		this.connection = { client, transport, tools: new Set() };
		await boundedRequest((options) => client.connect(transport, options), signal, CONNECT_TIMEOUT_MS);
		if (client.getServerVersion()?.version !== REA_PACKAGE_VERSION)
			throw new Error(`REA 实际服务版本不是 ${REA_PACKAGE_VERSION}`);
		const listing = await boundedRequest(
			(options) => client.listTools(undefined, options),
			signal,
			CONNECT_TIMEOUT_MS,
		);
		this.connection.tools = new Set(
			listing.tools
				.map((tool) => tool.name)
				.filter((name) => (REA_ALLOWED_TOOLS as readonly string[]).includes(name)),
		);
	}

	private cleanup(graceful: boolean): Promise<ResearchReaCleanup> {
		if (this.cleanupPromise) return this.cleanupPromise;
		const connection = this.connection;
		if (!connection)
			return Promise.resolve(
				this.cleanupFailure ?? { status: "complete", ownerSessionId: this.ownerSessionId, errors: [] },
			);
		this.connection = undefined;
		this.cleanupPromise = (async () => {
			const errors: string[] = [];
			if (graceful && connection.tools.has("close_binary")) {
				try {
					const result = await boundedRequest(
						(options) => connection.client.callTool({ name: "close_binary", arguments: {} }, undefined, options),
						undefined,
						CLOSE_TIMEOUT_MS,
					);
					if (result.isError) errors.push(`close_binary: ${JSON.stringify(result)}`);
				} catch (error) {
					errors.push(`close_binary: ${errorText(error)}`);
				}
			}
			try {
				await boundedRequest(() => connection.client.close(), undefined, CLOSE_TIMEOUT_MS);
			} catch (error) {
				errors.push(`MCP client: ${errorText(error)}`);
			}
			try {
				await boundedRequest(() => connection.transport.close(), undefined, CLOSE_TIMEOUT_MS);
			} catch (error) {
				errors.push(`MCP transport: ${errorText(error)}`);
			}
			const result: ResearchReaCleanup = {
				status: errors.length ? "cleanupIncomplete" : "complete",
				ownerSessionId: this.ownerSessionId,
				errors,
			};
			if (errors.length) this.cleanupFailure = result;
			return result;
		})().finally(() => {
			this.cleanupPromise = undefined;
		});
		return this.cleanupPromise;
	}

	async close(): Promise<ResearchReaCleanup> {
		this.disposed = true;
		const active = this.activeController;
		active?.abort(new Error("REA 会话已关闭"));
		return await this.cleanup(active === undefined);
	}
}
