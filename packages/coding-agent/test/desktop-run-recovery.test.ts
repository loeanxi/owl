import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as runtimeModule from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerEventMessage,
	ServerResponseMessage,
	SessionQueueSnapshot,
	SessionSnapshotPayload,
} from "../src/modes/desktop/protocol.ts";
import {
	DesktopRunRecovery,
	desktopQueuedMessages,
	legacyDesktopRunCheckpoint,
	prepareInterruptedRun,
} from "../src/modes/desktop/run-recovery.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) {
		if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-run-recovery-"))
			throw new Error("Unsafe recovery cleanup target");
		await rm(root, { recursive: true, force: true });
	}
});

async function isolatedProfile() {
	const root = resolve(await mkdtemp(join(tmpdir(), "owl-run-recovery-")));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	return { root, agentDir, cwd };
}

function seedRun(cwd: string, agentDir: string) {
	const manager = SessionManager.create(cwd);
	const store = new DesktopRunRecovery(agentDir, () => {});
	store.begin(manager);
	manager.appendMessage({ role: "user", content: "finish the task", timestamp: Date.now() });
	store.boundary(manager);
	return { manager, store };
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function toolReply(id: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: "write",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("desktop durable run checkpoints", () => {
	it("repairs only tool gaps belonging to the interrupted run boundary", async () => {
		const { agentDir, cwd } = await isolatedProfile();
		const manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: "old paused task", timestamp: Date.now() });
		const oldAssistant = manager.appendMessage({
			...fauxAssistantMessage(""),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "old-uncertain", name: "write", arguments: {} }],
		});
		const store = new DesktopRunRecovery(agentDir, () => {});
		store.begin(manager);
		manager.appendMessage({ role: "user", content: "active task", timestamp: Date.now() });
		manager.appendMessage({
			...fauxAssistantMessage(""),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "active-uncertain", name: "write", arguments: {} }],
		});
		store.preserveForRestart();
		store.releaseAfterShutdown();
		const run = new DesktopRunRecovery(agentDir, () => {}).claimInterrupted()[0]!;
		expect(run.initialLeafId).toBe(oldAssistant);
		prepareInterruptedRun(manager, run);
		const results = manager.buildSessionProjection().messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => message.toolCallId)).toEqual(["active-uncertain"]);
	});

	it("keeps complete queued user content and deduplicates delivered instructions by persisted id", async () => {
		const { agentDir, cwd } = await isolatedProfile();
		const { manager, store } = seedRun(cwd, agentDir);
		const harness = await createHarness({ sessionManager: manager });
		try {
			const image = { type: "image" as const, data: "retained-queued-image", mimeType: "image/png" };
			await harness.session.steer("same instruction", [image]);
			await harness.session.followUp("same instruction", [image]);
			store.captureQueue(manager, harness.session.agent);
			const queues = desktopQueuedMessages(harness.session.agent);
			expect(queues.steering).toHaveLength(1);
			expect(queues.followUp).toHaveLength(1);
			const steering = queues.steering[0]!;
			const followUp = queues.followUp[0]!;
			expect(steering).toMatchObject({
				content: [{ type: "text", text: "same instruction" }, image],
				owlQueueId: expect.any(String),
			});
			expect(
				"owlQueueId" in steering && "owlQueueId" in followUp && steering.owlQueueId !== followUp.owlQueueId,
			).toBe(true);
			// Crash after the first queue entry appends but before checkpoint cleanup.
			if (steering.role !== "user") throw new Error("Missing queued user");
			manager.appendMessage(steering);
			store.preserveForRestart();
			store.releaseAfterShutdown();
			const run = new DesktopRunRecovery(agentDir, () => {}).claimInterrupted()[0]!;
			prepareInterruptedRun(SessionManager.open(manager.getSessionFile()!), run);
			expect(run.pendingMessages).toHaveLength(1);
			expect(run.pendingMessages?.[0]).toMatchObject({
				lane: "followUp",
				message: { content: [{ type: "text", text: "same instruction" }, image] },
			});
			expect(
				manager.getEntries().findLast((entry) => entry.type === "message" && entry.message.role === "user"),
			).toMatchObject({ message: { owlQueueId: expect.any(String) } });
		} finally {
			harness.cleanup();
		}
	});

	it("migrates only a verified old bridge run and derives its input boundary from entry ids", async () => {
		const { agentDir, cwd } = await isolatedProfile();
		const manager = SessionManager.create(cwd);
		const firstUser = manager.appendMessage({ role: "user", content: "old task", timestamp: Date.now() });
		const oldAnswer = manager.appendMessage(fauxAssistantMessage("old task completed"));
		const currentUser = manager.appendMessage({ role: "user", content: "current task", timestamp: Date.now() });
		const assistant = manager.appendMessage(fauxAssistantMessage("first current step"));
		const snapshot: SessionSnapshotPayload = {
			sessionId: manager.getSessionId(),
			cwd,
			running: true,
			runStartMessageIndex: 3,
			messages: manager.buildSessionProjection().messages,
			messageEntryIds: [firstUser, oldAnswer, currentUser, assistant],
			header: manager.getHeader(),
		};
		const run = legacyDesktopRunCheckpoint(manager, snapshot, 99999999, agentDir, Date.now());
		expect(run.initialLeafId).toBe(oldAnswer);
		expect(() =>
			legacyDesktopRunCheckpoint(manager, { ...snapshot, running: false }, process.pid, agentDir, Date.now()),
		).toThrow("仍在运行");
		expect(() =>
			legacyDesktopRunCheckpoint(
				manager,
				{ ...snapshot, runStartMessageIndex: undefined },
				process.pid,
				agentDir,
				Date.now(),
			),
		).toThrow("运行边界");
		const store = new DesktopRunRecovery(agentDir, () => {});
		store.importLegacyRuns([run]);
		expect(() => store.importLegacyRuns([run])).toThrow("已有运行检查点");
		const claimed = new DesktopRunRecovery(agentDir, () => {}).claimInterrupted();
		expect(claimed.map((item) => item.sessionId)).toEqual([manager.getSessionId()]);
		expect(() => prepareInterruptedRun(manager, claimed[0]!)).not.toThrow();
	});

	it("does not claim a running owner and preserves only unfinished runs across shutdown", async () => {
		const { agentDir, cwd } = await isolatedProfile();
		const { manager, store } = seedRun(cwd, agentDir);
		const competitor = new DesktopRunRecovery(agentDir, () => {});
		expect(competitor.claimInterrupted()).toEqual([]);
		const finished = SessionManager.create(cwd);
		store.begin(finished);
		finished.appendMessage({ role: "user", content: "done", timestamp: Date.now() });
		store.finish(finished.getSessionId());
		store.preserveForRestart();
		store.finish(manager.getSessionId()); // Settlement produced by shutdown must not erase the intent.
		expect(competitor.claimInterrupted()).toEqual([]); // Old runtimes are still alive until release.
		store.releaseAfterShutdown();
		const runs = competitor.claimInterrupted();
		expect(runs.map((run) => run.sessionId)).toEqual([manager.getSessionId()]);
		expect(new DesktopRunRecovery(agentDir, () => {}).claimInterrupted()).toEqual([]);
	});

	it("repairs legacy checkpoint timing from the first original user after its durable boundary", async () => {
		const { agentDir, cwd } = await isolatedProfile();
		const manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: "older task", timestamp: 1_000 });
		const boundary = manager.appendMessage(fauxAssistantMessage("older task done"));
		const originalStartedAt = Date.now() - 12 * 60_000;
		manager.appendMessage({ role: "user", content: "original task", timestamp: originalStartedAt });
		manager.appendCustomMessageEntry("owl.resume", "restart continuation", false);
		manager.appendMessage({ role: "user", content: "queued instruction", timestamp: Date.now() - 1_000 });
		const store = new DesktopRunRecovery(agentDir, () => {});
		store.importLegacyRuns([
			{
				sessionId: manager.getSessionId(),
				sessionPath: manager.getSessionFile()!,
				agentDir,
				runId: "legacy-run",
				ownerId: "legacy-bridge",
				ownerPid: process.pid,
				ownerReleased: true,
				startedAt: Date.now() - 24_000,
				updatedAt: Date.now(),
				initialLeafId: boundary,
				completedTools: {},
			},
		]);
		const [run] = store.claimInterrupted();
		expect(run?.startedAt).toBe(originalStartedAt);
		expect(run?.runId).toBe("legacy-run");
		const persisted = JSON.parse(readFileSync(join(agentDir, "desktop-run-checkpoints.json"), "utf8"));
		expect(persisted.runs[manager.getSessionId()].startedAt).toBe(originalStartedAt);
	});

	it("manual cancellation clears intent before a shutdown race", async () => {
		const { agentDir, cwd } = await isolatedProfile();
		const { manager, store } = seedRun(cwd, agentDir);
		store.finish(manager.getSessionId());
		store.preserveForRestart();
		store.releaseAfterShutdown();
		expect(new DesktopRunRecovery(agentDir, () => {}).claimInterrupted()).toEqual([]);
	});

	it("restores completed tool results and marks uncertain calls without executing them", async () => {
		const { agentDir, cwd } = await isolatedProfile();
		const { manager, store } = seedRun(cwd, agentDir);
		manager.appendMessage({
			...fauxAssistantMessage(""),
			stopReason: "toolUse",
			content: ["persisted", "saved-gap", "uncertain"].map((id) => ({
				type: "toolCall" as const,
				id,
				name: "write",
				arguments: { path: id },
			})),
		});
		manager.appendMessage(toolReply("persisted", "already in transcript"));
		store.toolCompleted(manager.getSessionId(), toolReply("saved-gap", "completed before result append"));
		store.preserveForRestart();
		store.releaseAfterShutdown();
		const successor = new DesktopRunRecovery(agentDir, () => {});
		const run = successor.claimInterrupted()[0]!;
		const reopened = SessionManager.open(manager.getSessionFile()!);
		prepareInterruptedRun(reopened, run);
		prepareInterruptedRun(reopened, run); // The persisted repairs themselves are idempotent.
		const results = reopened.buildSessionProjection().messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(3);
		expect(results.find((message) => message.toolCallId === "saved-gap")).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "completed before result append" }],
		});
		expect(results.find((message) => message.toolCallId === "uncertain")).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("不要自动重放") }],
		});
		expect(reopened.buildSessionProjection().messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("does not resume a run whose input was never persisted or whose branch changed", async () => {
		const { agentDir, cwd } = await isolatedProfile();
		const manager = SessionManager.create(cwd);
		const store = new DesktopRunRecovery(agentDir, () => {});
		store.begin(manager);
		store.preserveForRestart();
		store.releaseAfterShutdown();
		const run = new DesktopRunRecovery(agentDir, () => {}).claimInterrupted()[0]!;
		expect(() => prepareInterruptedRun(manager, run)).toThrow("输入尚未落盘");
		manager.appendMessage({ role: "user", content: "input", timestamp: Date.now() });
		expect(() => prepareInterruptedRun(manager, { ...run, initialLeafId: "other-branch" })).toThrow("分支已变化");
	});

	it("claims a checkpoint after its real owning process is forcibly killed", async () => {
		const { root, agentDir, cwd } = await isolatedProfile();
		const script = join(root, "checkpoint-owner.mjs");
		const sessionSource = pathToFileURL(
			fileURLToPath(new URL("../src/core/session-manager.ts", import.meta.url)),
		).href;
		const recoverySource = pathToFileURL(
			fileURLToPath(new URL("../src/modes/desktop/run-recovery.ts", import.meta.url)),
		).href;
		writeFileSync(
			script,
			`import { SessionManager } from ${JSON.stringify(sessionSource)};\nimport { DesktopRunRecovery } from ${JSON.stringify(recoverySource)};\nconst manager = SessionManager.create(${JSON.stringify(cwd)});\nconst store = new DesktopRunRecovery(${JSON.stringify(agentDir)}, console.error);\nstore.begin(manager);\nmanager.appendMessage({ role: 'user', content: 'hard kill task', timestamp: Date.now() });\nstore.boundary(manager);\nconsole.log(manager.getSessionId());\nsetInterval(() => {}, 1000);\n`,
		);
		const child = spawn(process.execPath, [script], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, OWL_CODING_AGENT_DIR: agentDir },
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		try {
			const id = await new Promise<string>((done, reject) => {
				const timeout = setTimeout(() => reject(new Error(`Child checkpoint timeout: ${stderr}`)), 10000);
				child.once("error", (error) => {
					clearTimeout(timeout);
					reject(error);
				});
				child.once("exit", (code) => {
					clearTimeout(timeout);
					reject(new Error(`Checkpoint owner exited ${code}: ${stderr}`));
				});
				child.stdout.once("data", (chunk) => {
					clearTimeout(timeout);
					done(String(chunk).trim());
				});
			});
			expect(new DesktopRunRecovery(agentDir, () => {}).claimInterrupted()).toEqual([]);
			await killChild(child);
			const runs = new DesktopRunRecovery(agentDir, () => {}).claimInterrupted();
			expect(runs).toHaveLength(1);
			expect(runs[0]?.sessionId).toBe(id);
			const reopened = SessionManager.open(runs[0]!.sessionPath);
			expect(() => prepareInterruptedRun(reopened, runs[0]!)).not.toThrow();
		} finally {
			if (child.exitCode === null && child.signalCode === null) await killChild(child);
		}
	});
});

async function killChild(child: ChildProcess): Promise<void> {
	const exited = new Promise<void>((done) => {
		child.once("exit", () => done());
	});
	child.kill("SIGKILL");
	await exited;
}

async function connect(port: number) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const events: ServerEventMessage[] = [];
	socket.on("message", (data) => {
		const message = JSON.parse(String(data)) as ServerEventMessage;
		if (message.type === "event") events.push(message);
	});
	await new Promise<void>((done, reject) => {
		socket.once("open", done);
		socket.once("error", reject);
	});
	function request<T>(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage & { result?: T }> {
		const id = randomUUID();
		return new Promise((done, reject) => {
			const timer = setTimeout(() => {
				socket.off("message", receive);
				reject(new Error("Recovery bridge request timed out"));
			}, 8000);
			const receive = (data: unknown) => {
				const message = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
				if (message.type !== "response" || message.id !== id) return;
				clearTimeout(timer);
				socket.off("message", receive);
				done(message);
			};
			socket.on("message", receive);
			socket.send(JSON.stringify({ ...payload, id }));
		});
	}
	return { socket, request, events };
}

it("publishes one run clock across start events, snapshots and bridge restart, and resets a fresh task", async () => {
	const { agentDir, cwd } = await isolatedProfile();
	const originalEntered = deferred();
	const releaseOriginal = deferred();
	const resumedEntered = deferred();
	const releaseResumed = deferred();
	const freshEntered = deferred();
	const releaseFresh = deferred();
	const harnesses: Harness[] = [];
	const createRuntime = runtimeModule.createAgentSessionRuntime;
	vi.spyOn(runtimeModule, "createAgentSessionRuntime").mockImplementation(async (create, options) => {
		const runtime = await createRuntime(create, options);
		const harness = await createHarness({ sessionManager: runtime.session.sessionManager });
		await runtime.dispose();
		harnesses.push(harness);
		const original = harnesses.length === 1;
		harness.setResponses([
			async () => {
				(original ? originalEntered : resumedEntered).resolve();
				await (original ? releaseOriginal : releaseResumed).promise;
				return fauxAssistantMessage("done");
			},
		]);
		return new runtimeModule.AgentSessionRuntime(harness.session, runtime.services, create);
	});
	type RunTiming = { runId: string; startedAt: number };
	type TimedSnapshot = SessionSnapshotPayload & { run?: RunTiming };
	type TimedRunning = { running: string[]; runs?: Array<RunTiming & { sessionId: string }> };
	let bridge: DesktopServerHandle | undefined;
	const sockets: WebSocket[] = [];
	try {
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		const first = await connect(bridge.port);
		sockets.push(first.socket);
		const created = await first.request<TimedSnapshot>({ type: "session.create", cwd });
		const sessionId = created.result!.sessionId;
		await first.request({ type: "session.prompt", sessionId, message: "original task" });
		await originalEntered.promise;
		const before = (await first.request<TimedSnapshot>({ type: "session.resume", sessionId })).result!;
		expect(before.run).toEqual({ runId: expect.any(String), startedAt: expect.any(Number) });
		const clock = before.run!;
		expect(
			first.events.find((message) => (message.event as { type?: string }).type === "agent_start")?.event,
		).toMatchObject(clock);
		expect((await first.request<TimedRunning>({ type: "session.running" })).result?.runs).toEqual([
			{ sessionId, ...clock },
		]);
		const closing = bridge.close();
		releaseOriginal.resolve();
		await closing;
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		await resumedEntered.promise;
		const second = await connect(bridge.port);
		sockets.push(second.socket);
		const restored = (await second.request<TimedSnapshot>({ type: "session.resume", sessionId })).result!;
		expect(restored.run).toEqual(clock);
		expect((await second.request<TimedRunning>({ type: "session.running" })).result?.runs).toEqual([
			{ sessionId, ...clock },
		]);
		const settled = new Promise<void>((done) =>
			harnesses[1]!.session.subscribe((event) => {
				if (event.type === "agent_settled") done();
			}),
		);
		releaseResumed.resolve();
		await settled;
		expect((await second.request<TimedSnapshot>({ type: "session.resume", sessionId })).result?.run).toBeUndefined();
		harnesses[1]!.setResponses([
			async () => {
				freshEntered.resolve();
				await releaseFresh.promise;
				return fauxAssistantMessage("new task done");
			},
		]);
		const freshSentAt = Date.now();
		await second.request({ type: "session.prompt", sessionId, message: "a genuinely new task" });
		await freshEntered.promise;
		const fresh = (await second.request<TimedSnapshot>({ type: "session.resume", sessionId })).result!.run!;
		expect(fresh.runId).not.toBe(clock.runId);
		expect(fresh.startedAt).toBeGreaterThanOrEqual(freshSentAt);
		expect(
			second.events.find((message) => (message.event as { type?: string }).type === "agent_start")?.event,
		).toMatchObject(fresh);
		expect((await second.request<TimedRunning>({ type: "session.running" })).result?.runs).toEqual([
			{ sessionId, ...fresh },
		]);
	} finally {
		releaseOriginal.resolve();
		releaseResumed.resolve();
		releaseFresh.resolve();
		for (const socket of sockets) socket.terminate();
		await bridge?.close();
		for (const harness of harnesses) harness.cleanup();
	}
});

it("automatically resumes once after a real bridge shutdown, preserving user and tool history", async () => {
	const { agentDir, cwd } = await isolatedProfile();
	const providerEntered = deferred();
	const releaseProvider = deferred();
	const resumedEntered = deferred();
	const releaseResumed = deferred();
	const harnesses: Harness[] = [];
	const createRuntime = runtimeModule.createAgentSessionRuntime;
	const factory = vi.spyOn(runtimeModule, "createAgentSessionRuntime").mockImplementation(async (create, options) => {
		const runtime = await createRuntime(create, options);
		const harness = await createHarness({ sessionManager: runtime.session.sessionManager });
		await runtime.dispose();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				if (harnesses.length === 1) {
					providerEntered.resolve();
					await releaseProvider.promise;
				} else {
					resumedEntered.resolve();
					await releaseResumed.promise;
				}
				return fauxAssistantMessage("remaining work complete");
			},
		]);
		return new runtimeModule.AgentSessionRuntime(harness.session, runtime.services, create);
	});
	let bridge: DesktopServerHandle | undefined;
	const sockets: WebSocket[] = [];
	try {
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		const first = await connect(bridge.port);
		sockets.push(first.socket);
		const created = await first.request<SessionSnapshotPayload>({ type: "session.create", cwd });
		const sessionId = created.result!.sessionId;
		await first.request({ type: "session.prompt", sessionId, message: "original task" });
		await providerEntered.promise;
		const queuedImage = { type: "image" as const, data: "retained-bridge-image", mimeType: "image/png" };
		await first.request({
			type: "session.prompt",
			sessionId,
			message: "same queued instruction",
			images: [queuedImage],
			streamingBehavior: "steer",
		});
		await first.request({
			type: "session.prompt",
			sessionId,
			message: "same queued instruction",
			images: [queuedImage],
			streamingBehavior: "followUp",
		});
		await first.request({
			type: "session.prompt",
			sessionId,
			message: "promoted instruction",
			streamingBehavior: "followUp",
		});
		const beforeQueue = await first.request<{ queue: SessionQueueSnapshot }>({
			type: "session.stats",
			sessionId,
		});
		expect({
			steering: beforeQueue.result?.queue.steering.map((item) => item.text),
			followUp: beforeQueue.result?.queue.followUp.map((item) => item.text),
		}).toEqual({
			steering: ["same queued instruction"],
			followUp: ["same queued instruction", "promoted instruction"],
		});
		// Disconnecting or reselecting history must not launch another provider run.
		await Promise.all([
			first.request({ type: "session.resume", sessionId }),
			first.request({ type: "session.resume", sessionId }),
		]);
		expect(factory).toHaveBeenCalledTimes(1);
		const closing = bridge.close();
		releaseProvider.resolve();
		await closing;
		bridge = undefined;
		expect(
			Object.keys(JSON.parse(readFileSync(join(agentDir, "desktop-run-checkpoints.json"), "utf8")).runs),
		).toEqual([sessionId]);
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		await resumedEntered.promise;
		const second = await connect(bridge.port);
		const third = await connect(bridge.port);
		sockets.push(second.socket, third.socket);
		const running = await second.request<{ running: string[] }>({ type: "session.running" });
		expect(running.result?.running).toEqual([sessionId]);
		const [restored, concurrent] = await Promise.all([
			second.request<SessionSnapshotPayload>({ type: "session.resume", sessionId }),
			third.request<SessionSnapshotPayload>({ type: "session.resume", sessionId }),
		]);
		expect(restored.result?.recovery?.status).toBe("resuming");
		expect(concurrent.result?.running).toBe(true);
		expect(factory).toHaveBeenCalledTimes(2);
		const restoredQueue = await second.request<{ queue: SessionQueueSnapshot }>({
			type: "session.stats",
			sessionId,
		});
		// Steering is intentionally delivered at the recovery turn's first provider boundary.
		expect({
			steering: restoredQueue.result?.queue.steering.map((item) => item.text),
			followUp: restoredQueue.result?.queue.followUp.map((item) => item.text),
		}).toEqual({
			steering: [],
			followUp: ["same queued instruction", "promoted instruction"],
		});
		const actualQueue = desktopQueuedMessages(harnesses[1]!.session.agent);
		expect(actualQueue.steering).toEqual([]);
		expect(
			restored.result?.messages.find(
				(message) => message !== null && typeof message === "object" && "owlQueueId" in message,
			),
		).toMatchObject({
			content: [{ type: "text", text: "same queued instruction" }, queuedImage],
			owlQueueId: expect.any(String),
		});
		expect(actualQueue.followUp[0]).toMatchObject({
			content: [{ type: "text", text: "same queued instruction" }, queuedImage],
			owlQueueId: expect.any(String),
		});
		const promotedId = restoredQueue.result!.queue.followUp[1].messageId;
		await second.request({ type: "session.queue.promote", sessionId, messageId: promotedId });
		await second.request({ type: "session.queue.remove", sessionId, lane: "steering", messageId: promotedId });
		const changedQueue = await second.request<{ queue: SessionQueueSnapshot }>({
			type: "session.stats",
			sessionId,
		});
		expect({
			steering: changedQueue.result?.queue.steering.map((item) => item.text),
			followUp: changedQueue.result?.queue.followUp.map((item) => item.text),
		}).toEqual({ steering: [], followUp: ["same queued instruction"] });
		expect(
			restored.result?.messages.filter((message) => (message as { role?: string }).role === "user"),
		).toHaveLength(2);
		expect(
			restored.result?.messages.filter(
				(message) => (message as { customType?: string }).customType === "owl.resume",
			),
		).toHaveLength(1);
		// Manual stop wins even if another restart begins before settlement.
		await second.request({ type: "session.abort", sessionId });
		expect(JSON.parse(readFileSync(join(agentDir, "desktop-run-checkpoints.json"), "utf8")).runs).toEqual({});
		releaseResumed.resolve();
		await bridge.close();
		bridge = undefined;
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		const final = await connect(bridge.port);
		sockets.push(final.socket);
		expect((await final.request<{ running: string[] }>({ type: "session.running" })).result?.running).toEqual([]);
		expect(factory).toHaveBeenCalledTimes(2);
	} finally {
		releaseProvider.resolve();
		releaseResumed.resolve();
		for (const socket of sockets) socket.terminate();
		await bridge?.close();
		for (const harness of harnesses) harness.cleanup();
	}
});

it("serializes concurrent first mounts and leaves completed history idle on reconnect", async () => {
	const { agentDir, cwd } = await isolatedProfile();
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "already complete", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("done"));
	const entered = deferred();
	const release = deferred();
	const harnesses: Harness[] = [];
	const createRuntime = runtimeModule.createAgentSessionRuntime;
	const factory = vi.spyOn(runtimeModule, "createAgentSessionRuntime").mockImplementation(async (create, options) => {
		entered.resolve();
		await release.promise;
		const runtime = await createRuntime(create, options);
		const harness = await createHarness({ sessionManager: runtime.session.sessionManager });
		harnesses.push(harness);
		await runtime.dispose();
		return new runtimeModule.AgentSessionRuntime(harness.session, runtime.services, create);
	});
	const bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	const first = await connect(bridge.port);
	const second = await connect(bridge.port);
	try {
		const mounting = first.request<SessionSnapshotPayload>({
			type: "session.resume",
			sessionId: manager.getSessionId(),
		});
		await entered.promise;
		const competing = second.request<SessionSnapshotPayload>({
			type: "session.resume",
			sessionId: manager.getSessionId(),
		});
		release.resolve();
		const responses = await Promise.all([mounting, competing]);
		expect(responses.every((response) => response.ok && response.result?.running === false)).toBe(true);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(harnesses[0]?.eventsOfType("agent_start")).toEqual([]);
		expect(existsSync(join(agentDir, "desktop-run-checkpoints.json"))).toBe(true);
	} finally {
		release.resolve();
		first.socket.terminate();
		second.socket.terminate();
		await bridge.close();
		for (const harness of harnesses) harness.cleanup();
	}
});
