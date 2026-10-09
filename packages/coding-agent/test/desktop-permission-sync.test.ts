import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeClient } from "../../../apps/desktop/src/bridge/client.ts";
import {
	applyPermissionQueueEvent,
	approvalModeFromEvent,
	PermissionResponseTracker,
} from "../../../apps/desktop/src/bridge/permission-state.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { DesktopPermissionQueue } from "../src/modes/desktop/permission-queue.ts";
import type {
	ApprovalMode,
	DesktopClientRequestWithoutId,
	PermissionRequestMessage,
	ServerEventMessage,
	ServerResponseMessage,
	SessionSnapshotPayload,
} from "../src/modes/desktop/protocol.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it("broadcasts another client's decision so both UIs clear that request while keeping other-session approvals", async () => {
	vi.stubGlobal("WebSocket", WebSocket);
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((done) => server.once("listening", done));
	const queue = new DesktopPermissionQueue((message) => {
		for (const socket of server.clients) socket.send(JSON.stringify(message));
	});
	server.on("connection", (socket) => {
		socket.on("message", (data) => {
			const request = JSON.parse(String(data)) as { id: string; type: string; requestId: string; approved: boolean };
			const ok = queue.resolve(request.requestId, request.approved);
			socket.send(JSON.stringify({ type: "response", id: request.id, ok }));
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test bridge port");
	const clients = [
		new BridgeClient(`ws://127.0.0.1:${address.port}/ws`),
		new BridgeClient(`ws://127.0.0.1:${address.port}/ws`),
	];
	const uiQueues: PermissionRequestMessage[][] = [[], []];
	try {
		await Promise.all(
			clients.map(
				(client, index) =>
					new Promise<void>((done) => {
						client.onPermissionRequest((request) => uiQueues[index].push(request));
						client.onSessionEvent((event) => {
							uiQueues[index] = applyPermissionQueueEvent(uiQueues[index], event);
						});
						client.onStatus((connected) => {
							if (connected) done();
						});
						client.connect();
					}),
			),
		);
		const selected = {
			type: "permission_request" as const,
			requestId: randomUUID(),
			sessionId: "evaluation",
			toolName: "bash",
			input: {},
		};
		const unrelated = { ...selected, requestId: randomUUID(), sessionId: "ordinary-chat" };
		const selectedDecision = queue.request(selected);
		const unrelatedDecision = queue.request(unrelated);
		await vi.waitFor(() => expect(uiQueues.map((requests) => requests.length)).toEqual([2, 2]));
		await clients[0].respondPermission(selected.requestId, true);
		expect(await selectedDecision).toBe(true);
		await vi.waitFor(() =>
			expect(uiQueues.map((requests) => requests.map((request) => request.sessionId))).toEqual([
				["ordinary-chat"],
				["ordinary-chat"],
			]),
		);
		queue.cancelSession("ordinary-chat");
		expect(await unrelatedDecision).toBe(false);
	} finally {
		for (const client of clients) client.disconnect();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((done) => server.close(() => done()));
	}
});

it("switches only the selected session to auto and resolves its older waiting tools without changing the UI default", async () => {
	const events: ServerEventMessage[] = [];
	const pending: PermissionRequestMessage[] = [];
	const queue = new DesktopPermissionQueue((message) => {
		if (message.type === "permission_request") pending.push(message);
		if (message.type === "event") events.push(message);
	});
	const first = queue.request({
		type: "permission_request",
		requestId: "first",
		sessionId: "evaluation",
		toolName: "write",
		input: {},
	});
	const second = queue.request({
		type: "permission_request",
		requestId: "second",
		sessionId: "ordinary-chat",
		toolName: "write",
		input: {},
	});
	queue.changeMode("evaluation", "auto");
	let visible = pending;
	const defaultMode: ApprovalMode = "confirm";
	let currentMode: ApprovalMode = defaultMode;
	for (const event of events) {
		visible = applyPermissionQueueEvent(visible, event);
		if (event.sessionId === "evaluation") currentMode = approvalModeFromEvent(event) ?? currentMode;
	}
	await expect(first).resolves.toBe(true);
	expect(visible.map((request) => request.sessionId)).toEqual(["ordinary-chat"]);
	expect(currentMode).toBe("auto");
	expect(defaultMode).toBe("confirm");
	queue.cancelSession("ordinary-chat");
	await expect(second).resolves.toBe(false);
});

it("times out unresolved approvals as denied and pendingMessages lists every session", async () => {
	vi.useFakeTimers();
	try {
		const events: ServerEventMessage[] = [];
		const queue = new DesktopPermissionQueue(
			(message) => {
				if (message.type === "event") events.push(message);
			},
			{ timeoutMs: 1_000 },
		);
		const first = queue.request({
			type: "permission_request",
			requestId: "timeout-a",
			sessionId: "s1",
			toolName: "bash",
			input: {},
		});
		const second = queue.request({
			type: "permission_request",
			requestId: "timeout-b",
			sessionId: "s2",
			toolName: "write",
			input: {},
		});
		expect(
			queue
				.pendingMessages()
				.map((request) => request.requestId)
				.sort(),
		).toEqual(["timeout-a", "timeout-b"]);
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(first).resolves.toBe(false);
		await expect(second).resolves.toBe(false);
		expect(queue.pendingMessages()).toEqual([]);
		expect(
			events
				.filter((event) => (event.event as { type: string }).type === "permission_resolved")
				.map((event) => (event.event as { reason: string }).reason),
		).toEqual(["timeout", "timeout"]);
	} finally {
		vi.useRealTimers();
	}
});

it("plan accepts pending reads, rejects pending writes, and confirm keeps legitimate decisions pending", async () => {
	const events: ServerEventMessage[] = [];
	const queue = new DesktopPermissionQueue((message) => {
		if (message.type === "event") events.push(message);
	});
	const read = queue.request({
		type: "permission_request",
		requestId: "read",
		sessionId: "plan-target",
		toolName: "read",
		input: {},
	});
	const write = queue.request({
		type: "permission_request",
		requestId: "write",
		sessionId: "plan-target",
		toolName: "write",
		input: {},
	});
	const ordinary = queue.request({
		type: "permission_request",
		requestId: "ordinary",
		sessionId: "ordinary",
		toolName: "write",
		input: {},
	});
	queue.changeMode("ordinary", "confirm");
	expect(queue.forSession("ordinary")).toHaveLength(1);
	queue.changeMode("plan-target", "plan");
	await expect(read).resolves.toBe(true);
	await expect(write).resolves.toBe(false);
	expect(
		events
			.filter((event) => (event.event as { type: string }).type === "permission_resolved")
			.every((event) => event.sessionId === "plan-target"),
	).toBe(true);
	queue.cancelSession("ordinary");
	await expect(ordinary).resolves.toBe(false);
});

it("terminal events prevent optimistic-response failures from reviving stale modals, while a plain disconnect permits retry", () => {
	const request = {
		type: "permission_request" as const,
		requestId: "retire-me",
		sessionId: "evaluation",
		toolName: "write",
		input: {},
	};
	for (const terminal of [
		{ type: "permission_resolved", requestId: request.requestId, approved: true, reason: "response" },
		{ type: "approval_mode_changed", approvalMode: "auto" },
		{ type: "approval_mode_changed", approvalMode: "plan" },
		{ type: "agent_settled" },
	]) {
		const tracker = new PermissionResponseTracker();
		const attempt = tracker.begin(request);
		const duplicate = tracker.begin(request);
		tracker.observe({ type: "event", sessionId: request.sessionId, event: terminal }, []);
		expect(tracker.canRestore(attempt)).toBe(false);
		expect(tracker.canRestore(duplicate)).toBe(false);
		tracker.finish(attempt);
		tracker.finish(duplicate);
	}
	const tracker = new PermissionResponseTracker();
	const pending = tracker.begin(request);
	tracker.observe(
		{ type: "event", sessionId: "other", event: { type: "approval_mode_changed", approvalMode: "auto" } },
		[request],
	);
	expect(tracker.canRestore(pending)).toBe(true);
	tracker.finish(pending);
});

it("terminal-before-submit and mode/resolution ordering stay safe through bounded terminal-cache eviction", () => {
	const tracker = new PermissionResponseTracker();
	const request = {
		type: "permission_request" as const,
		requestId: "retire-me",
		sessionId: "evaluation",
		toolName: "write",
		input: {},
	};
	tracker.observe(
		{ type: "event", sessionId: request.sessionId, event: { type: "approval_mode_changed", approvalMode: "auto" } },
		[request],
	);
	const attempt = tracker.begin(request);
	tracker.observe(
		{
			type: "event",
			sessionId: request.sessionId,
			event: { type: "permission_resolved", requestId: request.requestId, approved: true, reason: "mode-change" },
		},
		[],
	);
	for (let index = 0; index < 600; index++)
		tracker.observe(
			{
				type: "event",
				sessionId: "other",
				event: { type: "permission_resolved", requestId: `other-${index}`, approved: false, reason: "response" },
			},
			[],
		);
	expect(tracker.canRestore(attempt)).toBe(false);
	tracker.finish(attempt);
});

it("real bridge observer resume preserves auto and returns actual mode while explicit overrides remain supported", async () => {
	const root = resolve(await mkdtemp(join(tmpdir(), "owl-approval-bridge-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-approval-bridge-"))
		throw new Error("Unsafe fixture cleanup path");
	const agentDir = join(root, "profile");
	const cwd = join(root, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ plugins: [], cacheWarming: "off", owlMemory: { enabled: false } }),
	);
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"offline-approval": {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					apiKey: "offline-fixture-key",
					models: [
						{ id: "fixture-model", name: "Fixture", contextWindow: 128000, maxTokens: 4096, reasoning: false },
					],
				},
			},
		}),
	);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	const noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("Provider requests forbidden in approval test");
	});
	vi.stubGlobal("fetch", noFetch);
	const legacy = SessionManager.create(cwd);
	legacy.appendMessage({ role: "user", content: "Legacy approval fixture", timestamp: Date.now() });
	const prompt = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
		this: AgentSession,
		message,
	) {
		this.sessionManager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
	});
	const start = () => startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	let server = await start();
	let sockets = [new WebSocket(`ws://127.0.0.1:${server.port}/ws`), new WebSocket(`ws://127.0.0.1:${server.port}/ws`)];
	const rpc = (socket: WebSocket, payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage> => {
		const id = randomUUID();
		return new Promise((done, reject) => {
			const timer = setTimeout(() => reject(new Error(`Test RPC timeout: ${payload.type}`)), 10000);
			const listener = (data: WebSocket.RawData) => {
				const message = JSON.parse(String(data)) as ServerResponseMessage;
				if (message.type !== "response" || message.id !== id) return;
				clearTimeout(timer);
				socket.off("message", listener);
				done(message);
			};
			socket.on("message", listener);
			socket.send(JSON.stringify({ ...payload, id }));
		});
	};
	try {
		await Promise.all(
			sockets.map(
				(socket) =>
					new Promise<void>((done, reject) => {
						socket.once("open", done);
						socket.once("error", reject);
					}),
			),
		);
		const created = await rpc(sockets[0], {
			type: "session.create",
			cwd,
			provider: "offline-approval",
			model: "fixture-model",
			approvalMode: "auto",
		});
		expect(created.ok).toBe(true);
		const initial = created.result as SessionSnapshotPayload;
		expect(initial.approvalMode).toBe("auto");
		const observer = await rpc(sockets[1], {
			type: "session.resume",
			sessionId: initial.sessionId,
			approvalModeFallback: "confirm",
		});
		expect((observer.result as SessionSnapshotPayload).approvalMode).toBe("auto");
		const explicit = await rpc(sockets[1], {
			type: "session.resume",
			sessionId: initial.sessionId,
			approvalMode: "confirm",
		});
		expect((explicit.result as SessionSnapshotPayload).approvalMode).toBe("confirm");
		await rpc(sockets[0], { type: "session.setApprovalMode", sessionId: initial.sessionId, approvalMode: "auto" });
		const unchanged = await rpc(sockets[1], { type: "session.resume", sessionId: initial.sessionId });
		expect((unchanged.result as SessionSnapshotPayload).approvalMode).toBe("auto");
		const saved: Array<{ sessionId: string; mode: "confirm" | "plan" }> = [];
		for (const mode of ["confirm", "plan"] as const) {
			const created = await rpc(sockets[0], {
				type: "session.create",
				cwd,
				provider: "offline-approval",
				model: "fixture-model",
				approvalMode: mode,
			});
			const snapshot = created.result as SessionSnapshotPayload;
			await rpc(sockets[0], {
				type: "session.prompt",
				sessionId: snapshot.sessionId,
				message: "Persist fixture history without a provider call",
			});
			saved.push({ sessionId: snapshot.sessionId, mode });
		}
		for (const socket of sockets) socket.terminate();
		await server.close();
		server = await start();
		sockets = [new WebSocket(`ws://127.0.0.1:${server.port}/ws`)];
		await new Promise<void>((done, reject) => {
			sockets[0].once("open", done);
			sockets[0].once("error", reject);
		});
		for (const { sessionId, mode } of saved) {
			const restored = await rpc(sockets[0], { type: "session.resume", sessionId, approvalModeFallback: "auto" });
			expect(restored.ok).toBe(true);
			expect((restored.result as SessionSnapshotPayload).approvalMode).toBe(mode);
		}
		const safeLegacy = await rpc(sockets[0], {
			type: "session.resume",
			sessionId: legacy.getSessionId(),
			approvalModeFallback: "confirm",
		});
		expect(safeLegacy.ok).toBe(true);
		expect((safeLegacy.result as SessionSnapshotPayload).approvalMode).toBe("confirm");
		expect(noFetch).not.toHaveBeenCalled();
	} finally {
		prompt.mockRestore();
		for (const socket of sockets) socket.terminate();
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});
