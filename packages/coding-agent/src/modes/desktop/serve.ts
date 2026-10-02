/**
 * pire desktop bridge.
 *
 * JSON over WebSocket between the desktop UI and agent sessions.
 * - Session lifecycle rides on AgentSessionRuntime (same factory pattern as the
 *   CLI: services per cwd, session bound to them).
 * - Wire events are the same JsonAgentSessionEvent stream print mode emits
 *   (partials stripped, tool calls carry id + name).
 * - v1 scope: create / prompt / abort / list. Resume, fork, permission events,
 *   and MCP tools land with the desktop UI (Phase 2).
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import { createAgentSessionServices } from "../../core/agent-session-services.ts";
import { createAgentSessionFromServices } from "../../core/agent-session-services.ts";
import {
	type AgentSessionRuntime,
	createAgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
} from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { toJsonEvent, type JsonAgentSessionEvent } from "../json-event.ts";

// ---------------------------------------------------------------------------
// Wire protocol (shared with the desktop UI)
// ---------------------------------------------------------------------------

export interface SessionCreateRequest {
	type: "session.create";
	id: string;
	cwd?: string;
	provider?: string;
	model?: string;
	agentDir?: string;
}

export interface SessionPromptRequest {
	type: "session.prompt";
	id: string;
	sessionId: string;
	message: string;
	images?: ImageContent[];
}

export interface SessionAbortRequest {
	type: "session.abort";
	id: string;
	sessionId: string;
}

export interface SessionListRequest {
	type: "session.list";
	id: string;
	sessionDir?: string;
}

export interface PingRequest {
	type: "ping";
	id: string;
}

export type DesktopClientRequest =
	| SessionCreateRequest
	| SessionPromptRequest
	| SessionAbortRequest
	| SessionListRequest
	| PingRequest;

export type ServerEventMessage = {
	type: "event";
	sessionId: string;
	event: JsonAgentSessionEvent;
};

export type ServerResponseMessage = {
	type: "response";
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

export type DesktopServerMessage = ServerEventMessage | ServerResponseMessage;

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
		{ runtime: AgentSessionRuntime; unsubscribe: () => void; clients: Set<WebSocket> }
	>();
	const clients = new Set<WebSocket>();

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

	function buildFactory(
		agentDir: string,
		modelSpec?: { provider?: string; model?: string },
	): CreateAgentSessionRuntimeFactory {
		return async (runtimeOptions) => {
			const services = await createAgentSessionServices({
				cwd: runtimeOptions.cwd,
				agentDir,
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
				...(model ? { model } : {}),
			});
			return { ...session, services, diagnostics: services.diagnostics };
		};
	}

	async function createSession(ws: WebSocket, request: SessionCreateRequest): Promise<void> {
		const cwd = request.cwd ?? options.cwd ?? process.cwd();
		const agentDir = request.agentDir ?? options.agentDir ?? getAgentDir();
		const sessionManager = SessionManager.create(cwd);
		const runtime = await createAgentSessionRuntime(
			buildFactory(agentDir, { provider: request.provider, model: request.model }),
			{ cwd, agentDir, sessionManager },
		);
		const sessionId = runtime.session.sessionManager.getSessionId();
		const unsubscribe = runtime.session.subscribe((event) => {
			broadcast({ type: "event", sessionId, event: toJsonEvent(event) });
		});
		sessions.set(sessionId, { runtime, unsubscribe, clients: new Set() });
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
						...(request.images ? { images: request.images } : {}),
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
