import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as runtimeModule from "../src/core/agent-session-runtime.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerEventMessage,
	ServerResponseMessage,
	SessionSnapshotPayload,
} from "../src/modes/desktop/protocol.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("resume snapshots carry the actual active run boundary through settlement and user-less continuation", async () => {
	const root = await mkdtemp(join(tmpdir(), "owl-active-snapshot-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	const settling = deferred();
	const releaseSettlement = deferred();
	const providerEntered = deferred();
	const releaseProvider = deferred();
	let first = true;
	let harness: Harness | undefined;
	const createRuntime = runtimeModule.createAgentSessionRuntime;
	const factory = vi.spyOn(runtimeModule, "createAgentSessionRuntime").mockImplementation(async (create, options) => {
		// Substitute only the provider/session factory; run the real session and desktop bridge.
		const runtime = await createRuntime(create, options);
		harness = await createHarness({
			sessionManager: runtime.session.sessionManager,
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async () => {
						if (!first) return;
						first = false;
						settling.resolve();
						await releaseSettlement.promise;
					});
				},
			],
		});
		await runtime.dispose();
		return new runtimeModule.AgentSessionRuntime(harness.session, runtime.services, create);
	});
	const bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	const socket = new WebSocket("ws://127.0.0.1:" + bridge.port + "/ws");
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		function request<T>(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage & { result?: T }> {
			const id = randomUUID();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					socket.off("message", receive);
					reject(new Error("Snapshot bridge request timed out"));
				}, 8000);
				const receive = (data: unknown) => {
					const response = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
					if (response.type !== "response" || response.id !== id) return;
					clearTimeout(timer);
					socket.off("message", receive);
					resolve(response);
				};
				socket.on("message", receive);
				socket.send(JSON.stringify({ ...payload, id }));
			});
		}
		function settledEvent(): Promise<ServerEventMessage> {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					socket.off("message", receive);
					reject(new Error("Snapshot settlement timed out"));
				}, 8000);
				const receive = (data: unknown) => {
					const message = JSON.parse(String(data)) as ServerEventMessage;
					if (message.type !== "event" || (message.event as { type?: string }).type !== "agent_settled") return;
					clearTimeout(timer);
					socket.off("message", receive);
					resolve(message);
				};
				socket.on("message", receive);
			});
		}
		const created = await request<SessionSnapshotPayload>({ type: "session.create", cwd });
		expect(created.ok).toBe(true);
		expect(created.result?.running).toBe(false);
		if (!harness || !created.result) throw new Error("Missing faux bridge session");
		const sessionId = created.result.sessionId;
		const manager = harness.session.sessionManager;
		let retainedOldAssistantId = "";
		for (let index = 0; index < 3; index++) {
			manager.appendMessage({ role: "user", content: "old task " + index, timestamp: Date.now() });
			retainedOldAssistantId = manager.appendMessage(fauxAssistantMessage("old reply " + index));
		}
		harness.session.refreshContext();
		harness.setResponses([fauxAssistantMessage("successful reply")]);
		const run = harness.session.prompt("start");
		await settling.promise;
		expect(harness.session.agent.state.isStreaming).toBe(false);
		const resumed = await request<SessionSnapshotPayload>({ type: "session.resume", sessionId });
		expect(resumed.result?.running).toBe(true);
		expect(resumed.result?.runStartMessageIndex).toBeTypeOf("number");
		if (!resumed.result) throw new Error("Missing active snapshot");
		const snapshot = resumed.result;
		expect(snapshot.messages.slice(snapshot.runStartMessageIndex)).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "successful reply" }],
			}),
		);
		// The active run's projection can shrink after compaction or context edits.
		// A new compaction summary must not make retained old assistant entries part of this run.
		manager.appendCompaction("old tasks summarized", retainedOldAssistantId, 1000);
		const compacted = await request<SessionSnapshotPayload>({ type: "session.resume", sessionId });
		if (!compacted.result || compacted.result.runStartMessageIndex === undefined)
			throw new Error("Missing compacted boundary");
		expect(compacted.result.messages.slice(compacted.result.runStartMessageIndex)).toContainEqual(
			expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "successful reply" }] }),
		);
		expect(compacted.result.messages.slice(compacted.result.runStartMessageIndex)).not.toContainEqual(
			expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "old reply 2" }] }),
		);
		manager.appendContextEdit(retainedOldAssistantId, { content: "retained old reply rewritten" });
		const rewritten = await request<SessionSnapshotPayload>({ type: "session.resume", sessionId });
		if (!rewritten.result || rewritten.result.runStartMessageIndex === undefined)
			throw new Error("Missing edited boundary");
		expect(rewritten.result.messages.slice(0, rewritten.result.runStartMessageIndex)).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: [{ type: "text", text: "retained old reply rewritten" }],
			}),
		);
		manager.appendContextEdit(retainedOldAssistantId, null);
		const omitted = await request<SessionSnapshotPayload>({ type: "session.resume", sessionId });
		if (!omitted.result || omitted.result.runStartMessageIndex === undefined)
			throw new Error("Missing omitted boundary");
		expect(omitted.result.messages.slice(omitted.result.runStartMessageIndex)).toContainEqual(
			expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "successful reply" }] }),
		);
		const settled = settledEvent();
		await request({ type: "session.abort", sessionId });
		releaseSettlement.resolve();
		await run;
		expect((await settled).event).toMatchObject({ type: "agent_settled", aborted: true });
		const idle = await request<SessionSnapshotPayload>({ type: "session.resume", sessionId });
		expect(idle.result?.running).toBe(false);
		expect(idle.result?.runStartMessageIndex).toBeUndefined();
		harness.setResponses([
			async () => {
				providerEntered.resolve();
				await releaseProvider.promise;
				return fauxAssistantMessage("must not finish");
			},
		]);
		const continuation = harness.session.resumeAfterPause("continue");
		await providerEntered.promise;
		const continued = await request<SessionSnapshotPayload>({ type: "session.resume", sessionId });
		expect(continued.result?.running).toBe(true);
		if (!continued.result || continued.result.runStartMessageIndex === undefined)
			throw new Error("Missing continuation boundary");
		const continuationSnapshot = continued.result;
		expect(continuationSnapshot.messages.slice(continuationSnapshot.runStartMessageIndex)).not.toContainEqual(
			expect.objectContaining({ role: "assistant" }),
		);
		expect(continuationSnapshot.messages.slice(0, continuationSnapshot.runStartMessageIndex)).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "successful reply" }],
			}),
		);
		const continuationSettled = settledEvent();
		await request({ type: "session.abort", sessionId });
		releaseProvider.resolve();
		await continuation;
		expect((await continuationSettled).event).toMatchObject({ type: "agent_settled", aborted: true });
	} finally {
		releaseSettlement.resolve();
		releaseProvider.resolve();
		socket.terminate();
		await bridge.close();
		harness?.cleanup();
		factory.mockRestore();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});
