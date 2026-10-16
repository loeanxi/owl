import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as runtimeModule from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { snapshotAgentQueue } from "../src/core/session-queue.ts";
import type {
	DesktopClientRequestWithoutId,
	SessionQueueActionResult,
	SessionQueueGetResult,
	SessionQueueReturnedGetResult,
	SessionQueueReturnedListResult,
	SessionQueueSnapshot,
	SessionQueueTakeResult,
	SessionSnapshotPayload,
} from "../src/modes/desktop/protocol.ts";
import { DesktopRunRecovery } from "../src/modes/desktop/run-recovery.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";
import * as atomicFile from "../src/utils/atomic-file.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let directory: string;
let cwd: string;
let agentDir: string;
let bridge: DesktopServerHandle;
let socket: WebSocket;
let harness: Harness;
let harnesses: Harness[];
let sessionId: string;
let released: ReturnType<typeof Promise.withResolvers<void>>;
let noFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
	directory = resolve(await mkdtemp(join(tmpdir(), "owl-queue-materials-")));
	if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith("owl-queue-materials-"))
		throw new Error("Unsafe cleanup target");
	agentDir = join(directory, "profile");
	cwd = join(directory, "workspace");
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
				fixture: {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					apiKey: "offline-fixture-key",
					models: [{ id: "offline", name: "offline", reasoning: false, contextWindow: 128000, maxTokens: 4096 }],
				},
			},
		}),
	);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("Provider calls forbidden in queue materials test");
	});
	vi.stubGlobal("fetch", noFetch);
	const entered = Promise.withResolvers<void>();
	released = Promise.withResolvers<void>();
	harnesses = [];
	const createRuntime = runtimeModule.createAgentSessionRuntime;
	vi.spyOn(runtimeModule, "createAgentSessionRuntime").mockImplementation(async (create, options) => {
		const runtime = await createRuntime(create, options);
		harness = await createHarness({ sessionManager: runtime.session.sessionManager });
		harnesses.push(harness);
		await runtime.dispose();
		harness.setResponses([
			async () => {
				entered.resolve();
				await released.promise;
				return fauxAssistantMessage("done");
			},
		]);
		return new runtimeModule.AgentSessionRuntime(harness.session, runtime.services, create);
	});
	bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	socket = await connect(bridge.port);
	const created = await rpc<SessionSnapshotPayload>({
		type: "session.create",
		cwd,
		provider: "fixture",
		model: "offline",
	});
	expect(created.ok).toBe(true);
	sessionId = created.result!.sessionId;
	await rpc({ type: "session.prompt", sessionId, message: "initial task" });
	await entered.promise;
});

afterEach(async () => {
	const closing = bridge?.close();
	released?.resolve();
	socket?.terminate();
	await closing;
	for (const created of harnesses ?? []) created.cleanup();
	expect(noFetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

async function connect(port: number): Promise<WebSocket> {
	const connected = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	await new Promise<void>((done, reject) => {
		connected.once("open", done);
		connected.once("error", reject);
	});
	return connected;
}

function rpc<T = unknown>(payload: DesktopClientRequestWithoutId) {
	const id = randomUUID();
	return new Promise<{ ok: boolean; error?: string; result?: T }>((done, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", receive);
			reject(new Error(`RPC timeout: ${payload.type}`));
		}, 10_000);
		const receive = (data: unknown) => {
			const response = JSON.parse(String(data)) as {
				type: string;
				id: string;
				ok: boolean;
				error?: string;
				result?: T;
			};
			if (response.type !== "response" || response.id !== id) return;
			clearTimeout(timer);
			socket.off("message", receive);
			done(response);
		};
		socket.on("message", receive);
		socket.send(JSON.stringify({ ...payload, id }));
	});
}

async function queueInput(
	text: string,
	imageData = "original-image",
	attachedPaths: string[] = [],
	lane: "steer" | "followUp" = "followUp",
) {
	const image = { type: "image" as const, data: imageData, mimeType: "image/png" };
	expect(
		(
			await rpc({
				type: "session.prompt",
				sessionId,
				message: text,
				images: [image],
				attachedPaths,
				streamingBehavior: lane,
			})
		).ok,
	).toBe(true);
	const queue = (await rpc<{ queue: SessionQueueSnapshot }>({ type: "session.stats", sessionId })).result!.queue;
	const entries = lane === "steer" ? queue.steering : queue.followUp;
	return { messageId: entries.at(-1)!.messageId, image, queue };
}

describe("stable queue identity and complete returned input over the real bridge", () => {
	it("same-text entries retain independent stable IDs and stale repeated removal cannot touch the next one", async () => {
		const one = await queueInput("same text", "image-one");
		const two = await queueInput("same text", "image-two");
		expect(one.messageId).not.toBe(two.messageId);
		const removed = await rpc<SessionQueueActionResult>({
			type: "session.queue.remove",
			sessionId,
			lane: "followUp",
			messageId: one.messageId,
		});
		expect(removed.ok).toBe(true);
		expect(removed.result!.queue.followUp.map((item) => item.messageId)).toEqual([two.messageId]);
		const repeated = await rpc<SessionQueueActionResult>({
			type: "session.queue.remove",
			sessionId,
			lane: "followUp",
			messageId: one.messageId,
		});
		expect(repeated.ok).toBe(false);
		expect(repeated.result!.queue.followUp.map((item) => item.messageId)).toEqual([two.messageId]);
		const input = await rpc<SessionQueueGetResult>({
			type: "session.queue.get",
			sessionId,
			messageId: two.messageId,
		});
		expect(input.result?.input.images).toEqual([two.image]);
	});

	it("promotes an exact follow-up once and returns the latest queue on repeated or wrong-lane actions", async () => {
		const one = await queueInput("one");
		const two = await queueInput("two");
		const promoted = await rpc<SessionQueueActionResult>({
			type: "session.queue.promote",
			sessionId,
			messageId: two.messageId,
		});
		expect(promoted.result!.queue.steering.map((item) => item.messageId)).toEqual([two.messageId]);
		expect(promoted.result!.queue.followUp.map((item) => item.messageId)).toEqual([one.messageId]);
		const repeated = await rpc<SessionQueueActionResult>({
			type: "session.queue.promote",
			sessionId,
			messageId: two.messageId,
		});
		expect(repeated.ok).toBe(false);
		expect(repeated.result?.queue).toEqual(promoted.result?.queue);
		const wrongLane = await rpc<SessionQueueActionResult>({
			type: "session.queue.remove",
			sessionId,
			lane: "followUp",
			messageId: two.messageId,
		});
		expect(wrongLane.ok).toBe(false);
		expect(wrongLane.result?.queue).toEqual(promoted.result?.queue);
	});

	it("broadcasts small metadata while get and take preserve original text, images and file references", async () => {
		const updates: SessionQueueSnapshot[] = [];
		const observe = (data: unknown) => {
			const message = JSON.parse(String(data)) as { type: string; event?: { type?: string } & SessionQueueSnapshot };
			if (message.type === "event" && message.event?.type === "queue_update") updates.push(message.event);
		};
		socket.on("message", observe);
		const text = `[Attached files for this turn]\n- user-authored literal header\n\n${"正文内容".repeat(200)}`;
		const { messageId, image, queue } = await queueInput(text, "private-base64-pixels", ["src/a.ts", "docs/说明.md"]);
		expect(queue.followUp[0]).toMatchObject({
			messageId,
			text: text.slice(0, 500),
			textTruncated: true,
			imageCount: 1,
			attachedPaths: ["src/a.ts", "docs/说明.md"],
			state: "queued",
		});
		expect(JSON.stringify(queue)).not.toContain(image.data);
		await rpc({ type: "ping" });
		expect(updates.at(-1)?.followUp[0]).toMatchObject({
			messageId,
			imageCount: 1,
			attachedPaths: ["src/a.ts", "docs/说明.md"],
		});
		expect(JSON.stringify(updates)).not.toContain(image.data);
		expect((await rpc<SessionSnapshotPayload>({ type: "session.resume", sessionId })).result?.queue).toEqual(queue);
		socket.off("message", observe);
		const preview = await rpc<SessionQueueGetResult>({ type: "session.queue.get", sessionId, messageId });
		expect(preview.result?.input).toEqual({
			messageId,
			text,
			images: [image],
			attachedPaths: ["src/a.ts", "docs/说明.md"],
			state: "queued",
		});
		const operationId = randomUUID();
		const taken = await rpc<SessionQueueTakeResult>({
			type: "session.queue.take",
			sessionId,
			messageId,
			operationId,
		});
		expect(taken.ok).toBe(true);
		expect(taken.result?.receipt).toMatchObject({
			receiptId: operationId,
			sourceSessionId: sessionId,
			sourceCwd: cwd,
			input: { messageId, text, images: [image], attachedPaths: ["src/a.ts", "docs/说明.md"] },
		});
		expect(taken.result?.queue.followUp).toEqual([]);
		expect(harness.session.getQueuedMessage(messageId)).toBeUndefined();
		const summaries = await rpc<SessionQueueReturnedListResult>({ type: "session.queue.returned.list", sessionId });
		expect(summaries.result?.receipts[0]).toMatchObject({
			receiptId: operationId,
			imageCount: 1,
			textTruncated: true,
		});
		expect(JSON.stringify(summaries.result)).not.toContain(image.data);
	});

	it("retries a take by operation token without removing another identical input, even after reconnect", async () => {
		const first = await queueInput("same", "first-image");
		const second = await queueInput("same", "second-image");
		const operationId = randomUUID();
		const taken = await rpc<SessionQueueTakeResult>({
			type: "session.queue.take",
			sessionId,
			messageId: first.messageId,
			operationId,
		});
		socket.terminate();
		socket = await connect(bridge.port);
		const repeated = await rpc<SessionQueueTakeResult>({
			type: "session.queue.take",
			sessionId,
			messageId: first.messageId,
			operationId,
		});
		expect(repeated.ok).toBe(true);
		expect(repeated.result?.receipt).toEqual(taken.result?.receipt);
		expect(repeated.result?.queue.followUp.map((item) => item.messageId)).toEqual([second.messageId]);
		const wrongBinding = await rpc({
			type: "session.queue.take",
			sessionId,
			messageId: second.messageId,
			operationId,
		});
		expect(wrongBinding).toMatchObject({ ok: false, error: expect.stringContaining("另一条输入") });
		expect(harness.session.getQueuedMessage(second.messageId)).toBeDefined();
		const wrongSession = await rpc({
			type: "session.queue.take",
			sessionId: "unrelated-session",
			messageId: first.messageId,
			operationId,
		});
		expect(wrongSession).toMatchObject({ ok: false, error: expect.stringContaining("另一条输入") });
		expect(
			(await rpc({ type: "session.queue.get", sessionId: "unrelated-session", messageId: second.messageId })).ok,
		).toBe(false);
	});

	it("does not rebind an explicitly removed receipt token to a different pending input", async () => {
		const first = await queueInput("first");
		const second = await queueInput("second");
		const operationId = randomUUID();
		await rpc({ type: "session.queue.take", sessionId, messageId: first.messageId, operationId });
		await rpc({ type: "session.queue.returned.remove", receiptId: operationId });
		const rebound = await rpc({ type: "session.queue.take", sessionId, messageId: second.messageId, operationId });
		expect(rebound).toMatchObject({ ok: false, error: expect.stringContaining("显式移除") });
		expect(harness.session.getQueuedMessage(second.messageId)).toBeDefined();
	});

	it("refuses to take a drained in-flight input while allowing a read-only full preview", async () => {
		const first = await queueInput("about to deliver", "in-flight-image");
		const second = await queueInput("still queued", "pending-image");
		const drained = harness.session.agent.takeFollowUpAt(0);
		expect(drained).toMatchObject({ owlQueueId: first.messageId });
		const preview = await rpc<SessionQueueGetResult>({
			type: "session.queue.get",
			sessionId,
			messageId: first.messageId,
		});
		expect(preview.result?.input).toMatchObject({ state: "delivering", images: [first.image] });
		const taken = await rpc<SessionQueueActionResult>({
			type: "session.queue.take",
			sessionId,
			messageId: first.messageId,
			operationId: randomUUID(),
		});
		expect(taken.ok).toBe(false);
		expect(taken.error).toContain("已开始处理");
		expect(harness.session.getQueuedMessage(second.messageId)).toBeDefined();
		expect(
			(await rpc<SessionQueueReturnedListResult>({ type: "session.queue.returned.list" })).result?.receipts,
		).toEqual([]);
	});

	it("keeps the complete live input pending if the durable receipt cannot be written", async () => {
		const { messageId, image } = await queueInput("must not be lost", "disk-failure-image", ["important.ts"]);
		const operationId = randomUUID();
		const save = atomicFile.atomicWriteFileSync;
		const injected = vi.spyOn(atomicFile, "atomicWriteFileSync").mockImplementation((path, data, options) => {
			if (
				path === join(agentDir, "desktop-run-checkpoints.json") &&
				typeof data === "string" &&
				data.includes(`receipt:${operationId}`)
			) {
				throw new Error("fixture disk full");
			}
			return save(path, data, options);
		});
		const failed = await rpc<SessionQueueActionResult>({
			type: "session.queue.take",
			sessionId,
			messageId,
			operationId,
		});
		expect(failed).toMatchObject({ ok: false, error: "fixture disk full" });
		expect(harness.session.getQueuedMessage(messageId)).toBeDefined();
		const intact = await rpc<SessionQueueGetResult>({ type: "session.queue.get", sessionId, messageId });
		expect(intact.result?.input).toMatchObject({
			text: "must not be lost",
			images: [image],
			attachedPaths: ["important.ts"],
		});
		expect(
			(await rpc<SessionQueueReturnedListResult>({ type: "session.queue.returned.list" })).result?.receipts,
		).toEqual([]);
		injected.mockRestore();
		expect((await rpc({ type: "session.queue.take", sessionId, messageId, operationId })).ok).toBe(true);
	});

	it("does not remove or promote a neighbour when the queue persistence write fails", async () => {
		const first = await queueInput("first");
		const second = await queueInput("second");
		const save = atomicFile.atomicWriteFileSync;
		const injected = vi.spyOn(atomicFile, "atomicWriteFileSync").mockImplementation((path, data, options) => {
			if (path === join(agentDir, "desktop-run-checkpoints.json")) throw new Error("fixture checkpoint failure");
			return save(path, data, options);
		});
		expect(
			(await rpc({ type: "session.queue.remove", sessionId, lane: "followUp", messageId: first.messageId })).ok,
		).toBe(false);
		expect((await rpc({ type: "session.queue.promote", sessionId, messageId: second.messageId })).ok).toBe(false);
		expect(snapshotAgentQueue(harness.session.agent).followUp).toHaveLength(2);
		expect(snapshotAgentQueue(harness.session.agent).steering).toHaveLength(0);
		injected.mockRestore();
	});

	it("the receipt transaction prevents replay even if a process stops before live queue removal", async () => {
		const secondaryProfile = join(directory, "transaction-profile");
		await mkdir(secondaryProfile);
		const manager = SessionManager.create(cwd, join(secondaryProfile, "history"));
		manager.appendMessage({ role: "user", content: "independent running task", timestamp: Date.now() });
		const secondary = await createHarness({ sessionManager: manager });
		try {
			const store = new DesktopRunRecovery(secondaryProfile, () => {});
			store.begin(manager);
			const image = { type: "image" as const, data: "exact-before-removal", mimeType: "image/png" };
			await secondary.session.followUp("transactional input", [image]);
			store.captureQueue(manager, secondary.session.agent);
			const message = snapshotAgentQueue(secondary.session.agent).followUp[0];
			if (!("owlQueueId" in message) || typeof message.owlQueueId !== "string")
				throw new Error("Missing queue identity");
			const operationId = randomUUID();
			store.takeQueuedInput(manager, secondary.session.agent, message.owlQueueId, operationId);
			// Deliberately omit removing the real Agent entry: this is the crash boundary.
			expect(secondary.session.getQueuedMessage(message.owlQueueId)).toBeDefined();
			store.preserveForRestart();
			store.releaseAfterShutdown();
			const restarted = new DesktopRunRecovery(secondaryProfile, () => {});
			expect(restarted.claimInterrupted()[0].pendingMessages).toEqual([]);
			expect(restarted.returnedInput(operationId)?.input).toMatchObject({
				text: "transactional input",
				images: [image],
			});
			expect(new DesktopRunRecovery(agentDir, () => {}).returnedInput(operationId)).toBeUndefined();
			restarted.removeReturnedInput(operationId);
			restarted.captureQueue(manager, secondary.session.agent);
			expect(restarted.queue(manager.getSessionId(), secondary.session.agent)?.followUp).toEqual([]);
		} finally {
			secondary.cleanup();
		}
	});

	it("persists receipts before live removal so a crash cannot replay an already returned input", async () => {
		const { messageId, image } = await queueInput("returned before crash", "crash-safe-image", ["file.ts"]);
		const recovery = new DesktopRunRecovery(agentDir, () => {});
		// Use the actual bridge owner record to inspect the atomic durable transaction.
		const operationId = randomUUID();
		const taken = await rpc<SessionQueueTakeResult>({
			type: "session.queue.take",
			sessionId,
			messageId,
			operationId,
		});
		expect(taken.ok).toBe(true);
		const durable = JSON.parse(readFileSync(join(agentDir, "desktop-run-checkpoints.json"), "utf8")) as {
			runs: Record<string, { pendingMessages: Array<{ message: { owlQueueId: string } }> }>;
		};
		expect(durable.runs[sessionId].pendingMessages.some((item) => item.message.owlQueueId === messageId)).toBe(false);
		expect(recovery.returnedInput(operationId)?.input).toMatchObject({
			text: "returned before crash",
			images: [image],
			attachedPaths: ["file.ts"],
		});
	});

	it("keeps returned material across session deletion and bridge restart, and removes it only on an explicit request", async () => {
		const { messageId, image } = await queueInput("keep after deletion", "retained-after-restart", ["src/保留.ts"]);
		const operationId = randomUUID();
		await rpc({ type: "session.queue.take", sessionId, messageId, operationId });
		const pending = await queueInput("explicitly delete this pending input", "discard-on-session-delete");
		const deleting = rpc({ type: "session.delete", sessionId });
		released.resolve();
		expect((await deleting).ok).toBe(true);
		expect(new DesktopRunRecovery(agentDir, () => {}).queue(sessionId)?.followUp ?? []).toEqual([]);
		socket.terminate();
		await bridge.close();
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		socket = await connect(bridge.port);
		const returned = await rpc<SessionQueueReturnedGetResult>({
			type: "session.queue.returned.get",
			receiptId: operationId,
		});
		expect(returned.result?.receipt.input).toMatchObject({
			messageId,
			text: "keep after deletion",
			images: [image],
			attachedPaths: ["src/保留.ts"],
		});
		const repeated = await rpc<SessionQueueTakeResult>({
			type: "session.queue.take",
			sessionId,
			messageId,
			operationId,
		});
		expect(repeated.result?.receipt).toEqual(returned.result?.receipt);
		expect(
			(await rpc<SessionQueueReturnedListResult>({ type: "session.queue.returned.list" })).result?.receipts,
		).toHaveLength(1);
		expect((await rpc({ type: "session.queue.get", sessionId, messageId: pending.messageId })).ok).toBe(false);
		expect((await rpc({ type: "session.queue.returned.remove", receiptId: operationId })).ok).toBe(true);
		expect((await rpc({ type: "session.queue.returned.get", receiptId: operationId })).ok).toBe(false);
		expect((await rpc({ type: "session.queue.take", sessionId, messageId, operationId })).ok).toBe(false);
	});

	it("restores paused steering and follow-up material after a restart without executing either", async () => {
		const steering = await queueInput("paused steering", "paused-steering-image", ["src/方向.ts"], "steer");
		const followUp = await queueInput("paused next task", "paused-follow-image", ["docs/资料.md"]);
		const settled = Promise.withResolvers<void>();
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.resolve();
		});
		await rpc({ type: "session.abort", sessionId });
		released.resolve();
		await settled.promise;
		unsubscribe();
		expect(JSON.parse(readFileSync(join(agentDir, "desktop-run-checkpoints.json"), "utf8")).runs).toEqual({});
		socket.terminate();
		await bridge.close();
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		socket = await connect(bridge.port);
		expect((await rpc<{ running: string[] }>({ type: "session.running" })).result?.running).toEqual([]);
		expect(harnesses).toHaveLength(1);
		const restored = await rpc<SessionSnapshotPayload>({ type: "session.resume", sessionId });
		expect(restored.result?.running).toBe(false);
		expect(restored.result?.queue?.steering.map((item) => item.messageId)).toEqual([steering.messageId]);
		expect(restored.result?.queue?.followUp.map((item) => item.messageId)).toEqual([followUp.messageId]);
		await rpc({ type: "ping" });
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isIdle).toBe(true);
		const full = await rpc<SessionQueueGetResult>({
			type: "session.queue.get",
			sessionId,
			messageId: followUp.messageId,
		});
		expect(full.result?.input).toMatchObject({
			text: "paused next task",
			images: [followUp.image],
			attachedPaths: ["docs/资料.md"],
			state: "queued",
		});
		const receipt = await rpc<SessionQueueTakeResult>({
			type: "session.queue.take",
			sessionId,
			messageId: followUp.messageId,
			operationId: randomUUID(),
		});
		expect(receipt.ok).toBe(true);
		expect(receipt.result?.queue.steering.map((item) => item.messageId)).toEqual([steering.messageId]);
	});

	it("retains archived pending material while leaving the archived run stopped after restart", async () => {
		const pending = await queueInput("archive retained input", "archived-pixels", ["archive/file.ts"]);
		await rpc({ type: "session.archive", sessionId });
		const closing = bridge.close();
		released.resolve();
		await closing;
		socket.terminate();
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		socket = await connect(bridge.port);
		expect((await rpc<{ running: string[] }>({ type: "session.running" })).result?.running).toEqual([]);
		expect(harnesses).toHaveLength(1);
		const restored = await rpc<SessionSnapshotPayload>({ type: "session.resume", sessionId });
		expect(restored.result?.running).toBe(false);
		expect(restored.result?.queue?.followUp[0]).toMatchObject({ messageId: pending.messageId, imageCount: 1 });
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			(await rpc<SessionQueueGetResult>({ type: "session.queue.get", sessionId, messageId: pending.messageId }))
				.result?.input.images,
		).toEqual([pending.image]);
	});

	it("does not resurrect a consumed input from a stale passive checkpoint, and leaves an empty queue empty", async () => {
		const passiveProfile = join(directory, "passive-profile");
		await mkdir(passiveProfile);
		const manager = SessionManager.create(cwd, join(passiveProfile, "history"));
		manager.appendMessage({ role: "user", content: "standalone task", timestamp: Date.now() });
		const original = await createHarness({ sessionManager: manager });
		let restored: Harness | undefined;
		try {
			const store = new DesktopRunRecovery(passiveProfile, () => {});
			store.begin(manager);
			await original.session.followUp("already delivered", [
				{ type: "image", data: "delivered-image", mimeType: "image/png" },
			]);
			store.captureQueue(manager, original.session.agent);
			const consumed = original.session.agent.takeFollowUpAt(0);
			if (!consumed || consumed.role !== "user") throw new Error("No queued input");
			manager.appendMessage(consumed);
			// Simulate a crash after transcript persistence but before updating the passive slot.
			store.finish(manager.getSessionId());
			const stalePath = join(passiveProfile, "desktop-run-checkpoints.json");
			const stale = JSON.parse(readFileSync(stalePath, "utf8")) as { pendingQueues: Record<string, unknown[]> };
			stale.pendingQueues[manager.getSessionId()] = [{ lane: "followUp", message: consumed }];
			await writeFile(stalePath, JSON.stringify(stale));
			const restarted = new DesktopRunRecovery(passiveProfile, () => {});
			expect(restarted.claimInterrupted()).toEqual([]);
			restored = await createHarness({ sessionManager: SessionManager.open(manager.getSessionFile()!) });
			restarted.restoreQueue(restored.session.sessionManager, restored.session.agent);
			expect(snapshotAgentQueue(restored.session.agent)).toEqual({ steering: [], followUp: [] });
			restarted.captureQueue(restored.session.sessionManager, restored.session.agent);
			restarted.finish(manager.getSessionId(), restored.session);
			expect(restarted.queue(manager.getSessionId(), restored.session.agent)).toEqual({
				steering: [],
				followUp: [],
			});
		} finally {
			original.cleanup();
			restored?.cleanup();
		}
	});

	it("retains a drained but not yet persisted input when a stop cancels automatic execution", async () => {
		const passiveProfile = join(directory, "in-flight-stop-profile");
		await mkdir(passiveProfile);
		const manager = SessionManager.create(cwd, join(passiveProfile, "history"));
		manager.appendMessage({ role: "user", content: "standalone task", timestamp: Date.now() });
		const original = await createHarness({ sessionManager: manager });
		let restored: Harness | undefined;
		try {
			const store = new DesktopRunRecovery(passiveProfile, () => {});
			store.begin(manager);
			const image = { type: "image" as const, data: "not-delivered-original", mimeType: "image/png" };
			await original.session.followUp("not yet durable", [image]);
			store.captureQueue(manager, original.session.agent);
			original.session.agent.takeFollowUpAt(0);
			store.finish(manager.getSessionId(), original.session);
			const restarted = new DesktopRunRecovery(passiveProfile, () => {});
			expect(restarted.claimInterrupted()).toEqual([]);
			restored = await createHarness({ sessionManager: SessionManager.open(manager.getSessionFile()!) });
			restarted.restoreQueue(restored.session.sessionManager, restored.session.agent);
			const raw = snapshotAgentQueue(restored.session.agent).followUp;
			expect(raw).toHaveLength(1);
			expect(raw[0]).toMatchObject({ owlQueueInput: { text: "not yet durable", images: [image] } });
			expect(restored.session.isIdle).toBe(true);
		} finally {
			original.cleanup();
			restored?.cleanup();
		}
	});
});
