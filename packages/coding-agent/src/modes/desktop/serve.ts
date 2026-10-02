/**
 * owl desktop bridge.
 *
 * JSON over WebSocket between the desktop UI and agent sessions.
 * - Session lifecycle rides on AgentSessionRuntime (same factory pattern as the
 *   CLI: services per cwd, session bound to them).
 * - Wire events are the same JsonAgentSessionEvent stream print mode emits
 *   (partials stripped, tool calls carry id + name).
 * - Tool approvals: with approvalMode "confirm", a built-in extension turns
 *   every tool_call into a permission_request round-trip to the UI.
 * - v1 scope: create / prompt / abort / list / models / settings. Resume, fork,
 *   and diff-level approvals land with the desktop UI.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type WebSocket, WebSocketServer } from "ws";
import { getAgentDir } from "../../config.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../core/agent-session-services.ts";
import type { InlineExtension, ToolDefinition } from "../../core/extensions/index.ts";
import { connectMcpServers, type McpConnections } from "../../core/mcp-lite.ts";
import type { McpServerConfig } from "../../core/mcp-servers.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { type JsonAgentSessionEvent, toJsonEvent } from "../json-event.ts";

// ---------------------------------------------------------------------------
// models.json — owl 的模型声明（唯一模型来源；不复用 pi 内置目录）
// ---------------------------------------------------------------------------

const SUPPORTED_MODEL_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

interface ModelFileEntry {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

interface ProviderFileEntry {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: ModelFileEntry[];
}

interface ModelsFile {
	providers?: Record<string, ProviderFileEntry>;
}

function declaredProviderModels(models: ModelsFile): ProviderModelsMessage[] {
	const result: ProviderModelsMessage[] = [];
	for (const [id, provider] of Object.entries(models.providers ?? {})) {
		result.push({
			id,
			...(provider.name ? { name: provider.name } : {}),
			authSource: "models_json",
			models: (provider.models ?? []).map((model) => ({
				id: model.id,
				name: model.name ?? model.id,
				...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
			})),
		});
	}
	return result;
}

function readModelsFile(agentDir: string): ModelsFile {
	try {
		return JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8")) as ModelsFile;
	} catch {
		return {};
	}
}

function writeModelsFile(agentDir: string, models: ModelsFile): void {
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`);
}

import type {
	DesktopClientRequest,
	DesktopServerMessage,
	ProviderModelsMessage,
	SessionCreateRequest,
} from "./protocol.ts";

/** 打开系统默认浏览器（OAuth 授权用）。 */
function openInBrowser(url: string): void {
	try {
		spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
	} catch {
		// 打不开就让用户手动复制链接（URL 会通过事件广播给 UI）
	}
}

export type {
	DesktopClientRequest,
	DesktopServerMessage,
	ModelInfoMessage,
	PermissionRequestMessage,
	ProviderModelsMessage,
	ServerEventMessage,
	ServerResponseMessage,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static UI — single-port mode: the bridge also serves the built desktop UI,
// so `node serve.js` alone is the whole app. Override with OWL_UI_DIR.
// ---------------------------------------------------------------------------

const UI_CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json",
};

function resolveUiRoot(): string | null {
	const explicit = process.env.OWL_UI_DIR;
	if (explicit && existsSync(join(explicit, "index.html"))) return explicit;
	// 从本文件位置向上找仓库根的 apps/desktop/dist，不依赖固定层级
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "apps", "desktop", "dist");
		if (existsSync(join(candidate, "index.html"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function serveUi(uiRoot: string, requestPath: string, response: ServerResponse, headOnly: boolean): void {
	let relative = "/";
	try {
		relative = normalize(decodeURIComponent(requestPath.split("?")[0] ?? "/"));
	} catch {
		// 非法编码按 "/" 处理
	}
	let filePath = join(uiRoot, relative.replace(/^[/\\]+/, ""));
	// 目录穿越防护：逃出 uiRoot 一律回退 SPA 入口
	if (filePath !== uiRoot && !filePath.startsWith(uiRoot + sep)) filePath = join(uiRoot, "index.html");
	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		filePath = join(uiRoot, "index.html"); // SPA fallback
	}
	try {
		const body = readFileSync(filePath);
		response.writeHead(200, {
			"Content-Type": UI_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
		});
		response.end(headOnly ? undefined : body);
	} catch {
		response.writeHead(500).end();
	}
}

export interface DesktopServerOptions {
	port?: number;
	host?: string;
	/** Default agent dir (defaults to OWL_CODING_AGENT_DIR / ~/.owl/agent). */
	agentDir?: string;
	/** Default cwd for session.create requests that omit one. */
	cwd?: string;
	/** MCP servers (name → config); when omitted, read from settings.json `mcpServers`. */
	mcpServers?: Record<string, McpServerConfig>;
	/** Called for diagnostics; defaults to console.error. */
	onDiagnostic?: (message: string) => void;
}

export interface DesktopServerHandle {
	port: number;
	close(): Promise<void>;
}

export async function startDesktopServer(options: DesktopServerOptions = {}): Promise<DesktopServerHandle> {
	const onDiagnostic = options.onDiagnostic ?? ((message: string) => console.error(`[owl] ${message}`));
	/** sessionId → live runtime + event subscription */
	const sessions = new Map<string, { runtime: AgentSessionRuntime; unsubscribe: () => void }>();
	const clients = new Set<WebSocket>();
	/** requestId → resolver for tool calls awaiting a user decision */
	const pendingPermissions = new Map<string, { sessionId: string; resolve: (approved: boolean) => void }>();
	/** Shared services for non-session queries (models.list); built lazily. */
	let listServices: AgentSessionServices | undefined;
	/** MCP connections established at startup. */
	let mcp: McpConnections | undefined;

	function resolveMcpServerConfigs(): Record<string, McpServerConfig> {
		if (options.mcpServers) return options.mcpServers;
		try {
			const raw = JSON.parse(readFileSync(join(defaultAgentDir(), "settings.json"), "utf-8")) as {
				mcpServers?: Record<string, McpServerConfig>;
			};
			return raw.mcpServers ?? {};
		} catch {
			return {};
		}
	}

	async function getMcpTools(): Promise<ToolDefinition[]> {
		if (!mcp) {
			const servers = resolveMcpServerConfigs();
			mcp =
				Object.keys(servers).length > 0
					? await connectMcpServers(servers, onDiagnostic)
					: { tools: [], connections: [], close: async () => {} };
		}
		return mcp.tools;
	}

	/** 进行中的登录（auth.login 长请求）与其待回答的界面提问。 */
	let activeLogin: { controller: AbortController } | null = null;
	let pendingPrompt: {
		ask: { type: string; message?: string; placeholder?: string; options?: readonly { id: string; label: string }[] };
		resolve: (value: string) => void;
		reject: (error: Error) => void;
	} | null = null;

	function broadcast(message: DesktopServerMessage): void {
		const payload = JSON.stringify(message);
		for (const client of clients) {
			if (client.readyState === client.OPEN) {
				client.send(payload);
			}
		}
	}

	function reply(ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }): void {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify({ type: "response", id, ...result }));
		}
	}

	function defaultAgentDir(): string {
		return options.agentDir ?? getAgentDir();
	}

	async function getListingServices(): Promise<AgentSessionServices> {
		if (!listServices) {
			listServices = await createAgentSessionServices({
				cwd: options.cwd ?? process.cwd(),
				agentDir: defaultAgentDir(),
			});
		}
		return listServices;
	}
	void getListingServices; // owl: models.list 已改为只读 models.json，保留 getter 备后续声明式扩展

	function buildFactory(
		agentDir: string,
		modelSpec: { provider?: string; model?: string } | undefined,
		extensionFactories: InlineExtension[],
	): CreateAgentSessionRuntimeFactory {
		return async (runtimeOptions) => {
			const services = await createAgentSessionServices({
				cwd: runtimeOptions.cwd,
				agentDir,
				resourceLoaderOptions: { extensionFactories },
			});
			let model: ReturnType<typeof services.modelRuntime.getModel>;
			if (modelSpec?.model) {
				model = modelSpec.provider
					? services.modelRuntime.getModel(modelSpec.provider, modelSpec.model)
					: services.modelRuntime.getModels().find((candidate) => candidate.id === modelSpec.model);
				if (!model) {
					throw new Error(`Model not found: ${[modelSpec.provider, modelSpec.model].filter(Boolean).join("/")}`);
				}
			}
			const session = await createAgentSessionFromServices({
				services,
				sessionManager: runtimeOptions.sessionManager,
				customTools: await getMcpTools(),
				...(model ? { model } : {}),
			});
			return { ...session, services, diagnostics: services.diagnostics };
		};
	}

	async function createSession(ws: WebSocket, request: SessionCreateRequest): Promise<void> {
		const cwd = request.cwd ?? options.cwd ?? process.cwd();
		const agentDir = request.agentDir ?? defaultAgentDir();
		const sessionManager = SessionManager.create(cwd);
		const confirmMode = request.approvalMode === "confirm";
		const sessionIdHolder: { current: string } = { current: "" };
		const permissionExtension: InlineExtension = {
			name: "owl-permissions",
			factory: (pi) => {
				pi.on("tool_call", async (event) => {
					if (!confirmMode) return {};
					const requestId = randomUUID();
					const approved = await new Promise<boolean>((resolve) => {
						pendingPermissions.set(requestId, {
							sessionId: sessionIdHolder.current,
							resolve,
						});
						broadcast({
							type: "permission_request",
							requestId,
							sessionId: sessionIdHolder.current,
							toolName: event.toolName,
							input: event.input,
						});
					});
					return approved ? {} : { block: true, reason: "Denied by user" };
				});
			},
		};
		const runtime = await createAgentSessionRuntime(
			buildFactory(agentDir, { provider: request.provider, model: request.model }, [permissionExtension]),
			{ cwd, agentDir, sessionManager },
		);
		const sessionId = runtime.session.sessionManager.getSessionId();
		sessionIdHolder.current = sessionId;
		const unsubscribe = runtime.session.subscribe((event) => {
			broadcast({ type: "event", sessionId, event: toJsonEvent(event) });
		});
		sessions.set(sessionId, { runtime, unsubscribe });
		reply(ws, request.id, {
			ok: true,
			result: { sessionId, cwd, header: runtime.session.sessionManager.getHeader() },
		});
	}

	async function handleRequest(ws: WebSocket, request: DesktopClientRequest): Promise<void> {
		switch (request.type) {
			case "ping": {
				reply(ws, request.id, { ok: true, result: "pong" });
				return;
			}
			case "session.create": {
				await createSession(ws, request);
				return;
			}
			case "session.prompt": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				reply(ws, request.id, { ok: true });
				try {
					await session.runtime.session.prompt(request.message, {
						...(request.images ? { images: request.images as ImageContent[] } : {}),
					});
				} catch (error) {
					onDiagnostic(error instanceof Error ? error.message : String(error));
				}
				return;
			}
			case "session.abort": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				await session.runtime.session.abort();
				reply(ws, request.id, { ok: true });
				return;
			}
			case "session.list": {
				const found = await SessionManager.listAll(request.sessionDir);
				reply(ws, request.id, { ok: true, result: found });
				return;
			}
			case "models.list": {
				// owl 模型来源 = models.json 声明（自定义接入） ∪ 有凭据的内置供应商（登录/API Key 激活）。
				// 内置目录本身不再直接暴露：只有用户主动配置过凭据的供应商才会带出目录模型。
				const agentDir = defaultAgentDir();
				const declared = declaredProviderModels(readModelsFile(agentDir));
				const credentialed: ProviderModelsMessage[] = [];
				try {
					const services = await getListingServices();
					const byProvider = new Map<string, ProviderModelsMessage>();
					const available = services.modelRuntime
						.getAvailableSnapshot()
						.filter((model) => services.modelRuntime.getProviderAuthStatus(model.provider).source === "stored");
					for (const model of available) {
						let group = byProvider.get(model.provider);
						if (!group) {
							group = { id: model.provider, models: [] };
							byProvider.set(model.provider, group);
						}
						if (!group.models.some((entry) => entry.id === model.id)) {
							group.models.push({
								id: model.id,
								name: model.name,
								...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
							});
						}
					}
					credentialed.push(...byProvider.values());
				} catch {
					// services 不可用时跳过凭据部分
				}
				const declaredIds = new Set(declared.map((group) => group.id));
				reply(ws, request.id, {
					ok: true,
					result: [...declared, ...credentialed.filter((group) => !declaredIds.has(group.id))],
				});
				return;
			}
			case "models.putProvider": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				const { key, baseUrl, api } = request.provider;
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
					reply(ws, request.id, { ok: false, error: "供应商 ID 只能包含字母、数字、点、下划线、连字符" });
					return;
				}
				if (!/^https?:\/\//.test(baseUrl)) {
					reply(ws, request.id, { ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" });
					return;
				}
				if (!SUPPORTED_MODEL_APIS.has(api)) {
					reply(ws, request.id, {
						ok: false,
						error: `api 必须是：${[...SUPPORTED_MODEL_APIS].join(" / ")}`,
					});
					return;
				}
				const existing = models.providers?.[key];
				models.providers = {
					...(models.providers ?? {}),
					[key]: {
						...existing,
						...(request.provider.name ? { name: request.provider.name } : {}),
						baseUrl,
						api,
						...(request.provider.apiKey ? { apiKey: request.provider.apiKey } : {}),
						models: existing?.models ?? [],
					},
				};
				writeModelsFile(agentDir, models);
				reply(ws, request.id, { ok: true, result: declaredProviderModels(readModelsFile(agentDir)) });
				return;
			}
			case "models.putModel": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				const provider = models.providers?.[request.providerKey];
				if (!provider) {
					reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
					return;
				}
				if (!request.model.id.trim()) {
					reply(ws, request.id, { ok: false, error: "模型 ID 不能为空" });
					return;
				}
				const entry: ModelFileEntry = { id: request.model.id.trim() };
				if (request.model.name) entry.name = request.model.name;
				if (request.model.contextWindow) entry.contextWindow = request.model.contextWindow;
				if (request.model.maxTokens) entry.maxTokens = request.model.maxTokens;
				if (request.model.reasoning != null) entry.reasoning = request.model.reasoning;
				const rest = (provider.models ?? []).filter((m) => m.id !== entry.id);
				provider.models = [...rest, entry];
				writeModelsFile(agentDir, models);
				reply(ws, request.id, { ok: true, result: declaredProviderModels(readModelsFile(agentDir)) });
				return;
			}
			case "models.removeModel": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				const provider = models.providers?.[request.providerKey];
				if (!provider) {
					reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
					return;
				}
				provider.models = (provider.models ?? []).filter((m) => m.id !== request.modelId);
				writeModelsFile(agentDir, models);
				reply(ws, request.id, { ok: true, result: declaredProviderModels(readModelsFile(agentDir)) });
				return;
			}
			case "models.removeProvider": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				if (!models.providers?.[request.providerKey]) {
					reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
					return;
				}
				delete models.providers[request.providerKey];
				writeModelsFile(agentDir, models);
				reply(ws, request.id, { ok: true, result: declaredProviderModels(readModelsFile(agentDir)) });
				return;
			}
			case "auth.providers": {
				// 内置厂商目录（供桌面下拉选择）：id / 显示名 / 支持的认证方式
				const services = await getListingServices();
				const result = services.modelRuntime.getProviders().map((provider) => ({
					id: provider.id,
					name: provider.name,
					oauth: Boolean(provider.auth?.oauth),
					apiKey: Boolean(provider.auth?.apiKey),
				}));
				reply(ws, request.id, { ok: true, result });
				return;
			}
			case "auth.login": {
				// pi /login 的桌面版：oauth 走浏览器（notify 里开浏览器 + 广播进度），api_key 直接落 auth.json。
				// 流程中的提问（AuthPrompt）转发到界面，由 auth.prompt.respond 带回答案。
				const services = await getListingServices();
				const controller = new AbortController();
				activeLogin = { controller };
				try {
					await services.modelRuntime.login(request.provider, request.authType, {
						signal: controller.signal,
						prompt: (ask) => {
							const answer = new Promise<string>((resolve, reject) => {
								pendingPrompt = { ask, resolve, reject };
							});
							const cleanup = () => {
								pendingPrompt = null;
							};
							answer.then(cleanup, cleanup);
							broadcast({
								type: "event",
								sessionId: "",
								event: { type: "auth_prompt", ask },
							});
							return answer;
						},
						notify: (event) => {
							// auth_url（回调流）与 device_code（设备码流）都自动打开对应页面
							if (event.type === "auth_url") openInBrowser(event.url);
							if (event.type === "device_code") openInBrowser(event.verificationUri);
							broadcast({
								type: "event",
								sessionId: "",
								event: { type: "auth_notify", detail: event },
							});
						},
					});
					reply(ws, request.id, { ok: true, result: { provider: request.provider, authType: request.authType } });
				} catch (error) {
					reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				} finally {
					activeLogin = null;
					pendingPrompt = null;
				}
				return;
			}
			case "auth.prompt.respond": {
				if (!pendingPrompt) {
					reply(ws, request.id, { ok: false, error: "当前没有等待回答的登录提问" });
					return;
				}
				pendingPrompt.resolve(request.answer);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "auth.cancel": {
				activeLogin?.controller.abort();
				pendingPrompt?.reject(new Error("登录已取消"));
				pendingPrompt = null;
				reply(ws, request.id, { ok: true });
				return;
			}
			case "settings.get": {
				const agentDir = defaultAgentDir();
				const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
					m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
				);
				reply(ws, request.id, {
					ok: true,
					result: { agentDir, settings: settingsManager.getGlobalSettings() },
				});
				return;
			}
			case "settings.set": {
				const agentDir = defaultAgentDir();
				const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
					m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
				);
				const settings = settingsManager.applyGlobalOverridesAndSave(request.values as never);
				reply(ws, request.id, { ok: true, result: settings });
				return;
			}
			case "permission.response": {
				const pending = pendingPermissions.get(request.requestId);
				if (!pending) {
					reply(ws, request.id, { ok: false, error: `Unknown permission request: ${request.requestId}` });
					return;
				}
				pendingPermissions.delete(request.requestId);
				pending.resolve(request.approved);
				reply(ws, request.id, { ok: true });
				return;
			}
		}
	}

	const uiRoot = resolveUiRoot();
	const httpServer = createServer((request, response) => {
		if (!uiRoot) {
			response.writeHead(426).end("owl desktop bridge: WebSocket only");
			return;
		}
		serveUi(uiRoot, request.url ?? "/", response, request.method === "HEAD");
	});
	const wss = new WebSocketServer({ server: httpServer });
	wss.on("connection", (ws) => {
		clients.add(ws);
		ws.on("message", (data) => {
			let request: DesktopClientRequest;
			try {
				request = JSON.parse(String(data)) as DesktopClientRequest;
			} catch {
				reply(ws, "?", { ok: false, error: "Invalid JSON" });
				return;
			}
			void handleRequest(ws, request).catch((error) => {
				reply(ws, request.id ?? "?", {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		});
		ws.on("close", () => clients.delete(ws));
	});

	const port = options.port ?? 8787;
	const host = options.host ?? "127.0.0.1";
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, host, resolve);
	});

	return {
		port,
		async close() {
			for (const { unsubscribe } of sessions.values()) unsubscribe();
			sessions.clear();
			for (const client of clients) client.close();
			wss.close();
			await mcp?.close();
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

// ---------------------------------------------------------------------------
// Entry: node dist/modes/desktop/serve.js [--port 8787]
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const portArg = process.argv.indexOf("--port");
	const port = portArg > 0 ? Number(process.argv[portArg + 1]) : Number(process.env.OWL_PORT ?? 8787);
	void startDesktopServer({ port }).then((handle) => {
		console.log(`owl desktop bridge listening on http://127.0.0.1:${handle.port}`);
	});
}

export type { JsonAgentSessionEvent };
