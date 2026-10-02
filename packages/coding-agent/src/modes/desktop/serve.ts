/**
 * pire desktop bridge.
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
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import { createAgentSessionFromServices, createAgentSessionServices, type AgentSessionServices } from "../../core/agent-session-services.ts";
import type { InlineExtension } from "../../core/extensions/index.ts";
import {
	type AgentSessionRuntime,
	createAgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
} from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { connectMcpServers, type McpConnections } from "../../core/mcp-lite.ts";
import type { McpServerConfig } from "../../core/mcp-servers.ts";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import { toJsonEvent, type JsonAgentSessionEvent } from "../json-event.ts";
import type {
	DesktopClientRequest,
	DesktopServerMessage,
	SessionCreateRequest,
} from "./protocol.ts";

export type {
	DesktopClientRequest,
	DesktopServerMessage,
	ModelInfoMessage,
	PermissionRequestMessage,
	ServerEventMessage,
	ServerResponseMessage,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface DesktopServerOptions {
	port?: number;
	host?: string;
	/** Default agent dir (defaults to PI_CODING_AGENT_DIR / ~/.pi/agent). */
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
	const onDiagnostic = options.onDiagnostic ?? ((message: string) => console.error(`[pire] ${message}`));
	/** sessionId → live runtime + event subscription */
	const sessions = new Map<
		string,
		{ runtime: AgentSessionRuntime; unsubscribe: () => void }
	>();
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
			let model;
			if (modelSpec?.model) {
				model = modelSpec.provider
					? services.modelRuntime.getModel(modelSpec.provider, modelSpec.model)
					: services.modelRuntime.getModels().find((candidate) => candidate.id === modelSpec.model);
				if (!model) {
					throw new Error(
						`Model not found: ${[modelSpec.provider, modelSpec.model].filter(Boolean).join("/")}`,
					);
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
			name: "pire-permissions",
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
				const services = await getListingServices();
				const models = services.modelRuntime.getModels().map((model) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
					contextWindow: model.contextWindow,
				}));
				reply(ws, request.id, { ok: true, result: models });
				return;
			}
			case "settings.get": {
				const agentDir = defaultAgentDir();
				const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then(
					(m) => m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
				);
				reply(ws, request.id, {
					ok: true,
					result: { agentDir, settings: settingsManager.getGlobalSettings() },
				});
				return;
			}
			case "settings.set": {
				const agentDir = defaultAgentDir();
				const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then(
					(m) => m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
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

	const httpServer = createServer((_request, response) => {
		response.writeHead(426).end("pire desktop bridge: WebSocket only");
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
	const port = portArg > 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PI_RE_PORT ?? 8787);
	void startDesktopServer({ port }).then((handle) => {
		console.log(`pire desktop bridge listening on http://127.0.0.1:${handle.port}`);
	});
}

export type { JsonAgentSessionEvent };
