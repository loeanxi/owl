import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as runtimeModule from "../src/core/agent-session-runtime.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerEventMessage,
	ServerResponseMessage,
} from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";
import * as toolManager from "../src/utils/tools-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

function deferred() {
	let release = () => {};
	const promise = new Promise<void>((done) => {
		release = done;
	});
	return { promise, release };
}

async function withBridge(
	options: HarnessOptions,
	run: (fixture: {
		harness: Harness;
		sessionId: string;
		events: ServerEventMessage[];
		responses: ServerResponseMessage[];
		request: (payload: DesktopClientRequestWithoutId) => Promise<ServerResponseMessage>;
	}) => Promise<void>,
) {
	const root = resolve(await mkdtemp(join(tmpdir(), "owl-prompt-acceptance-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-prompt-acceptance-"))
		throw new Error("Unsafe prompt acceptance cleanup target");
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ plugins: [], cacheWarming: "off" }));
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	vi.spyOn(toolManager, "ensureTool").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("External requests forbidden in acceptance tests");
		}),
	);
	const createRuntime = runtimeModule.createAgentSessionRuntime;
	let harness: Harness | undefined;
	vi.spyOn(runtimeModule, "createAgentSessionRuntime").mockImplementation(async (create, runtimeOptions) => {
		const runtime = await createRuntime(create, runtimeOptions);
		harness = await createHarness({ ...options, sessionManager: runtime.session.sessionManager });
		await runtime.dispose();
		return new runtimeModule.AgentSessionRuntime(harness.session, runtime.services, create);
	});
	let bridge: DesktopServerHandle | undefined;
	let socket: WebSocket | undefined;
	try {
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
		const connected = socket;
		const events: ServerEventMessage[] = [];
		const responses: ServerResponseMessage[] = [];
		connected.on("message", (data) => {
			const message = JSON.parse(String(data)) as ServerEventMessage | ServerResponseMessage;
			if (message.type === "event") events.push(message);
			if (message.type === "response") responses.push(message);
		});
		await new Promise<void>((done, reject) => {
			connected.once("open", done);
			connected.once("error", reject);
		});
		function request(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage> {
			const id = randomUUID();
			return new Promise((done, reject) => {
				const timer = setTimeout(() => {
					connected.off("message", receive);
					reject(new Error(`Prompt acceptance request timed out: ${payload.type}`));
				}, 5_000);
				const receive = (data: unknown) => {
					const response = JSON.parse(String(data)) as ServerResponseMessage;
					if (response.type !== "response" || response.id !== id) return;
					clearTimeout(timer);
					connected.off("message", receive);
					done(response);
				};
				connected.on("message", receive);
				connected.send(JSON.stringify({ ...payload, id }));
			});
		}
		const created = await request({ type: "session.create", cwd });
		expect(created.ok).toBe(true);
		const sessionId = (created.result as { sessionId: string }).sessionId;
		if (!harness) throw new Error("Faux runtime was not mounted");
		await run({ harness, sessionId, events, responses, request });
	} finally {
		socket?.terminate();
		await bridge?.close();
		harness?.cleanup();
		await rm(root, { recursive: true, force: true });
	}
}

it("rejects missing credentials before accepting or persisting attached input", async () => {
	await withBridge({ withConfiguredAuth: false }, async ({ harness, sessionId, request, events }) => {
		const result = await request({
			type: "session.prompt",
			sessionId,
			message: "retain these materials",
			attachedPaths: ["notes.md"],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/API key/i);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.messages.filter((message) => message.role === "user")).toEqual([]);
		expect(events.some((message) => (message.event as { type?: string }).type === "agent_start")).toBe(false);
	});
});

it("rejects compaction and missing-model preflight failures with a single failure response", async () => {
	await withBridge({}, async ({ harness, sessionId, request, responses }) => {
		// Hold the same gate used by a real compact() invocation without running a summarization model.
		Object.defineProperty(harness.session, "_compactionAbortController", {
			value: new AbortController(),
			writable: true,
		});
		const compacting = await request({ type: "session.prompt", sessionId, message: "keep draft" });
		expect(compacting).toMatchObject({ ok: false, error: expect.stringContaining("compaction") });
		Object.defineProperty(harness.session, "_compactionAbortController", { value: undefined, writable: true });
		vi.spyOn(harness.session, "model", "get").mockReturnValue(undefined);
		const noModel = await request({ type: "session.prompt", sessionId, message: "keep draft" });
		expect(noModel.ok).toBe(false);
		expect(noModel.error).toMatch(/model/i);
		expect(responses.filter((response) => response.id === compacting.id)).toHaveLength(1);
		expect(responses.filter((response) => response.id === noModel.id)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(0);
	});
});

it("acknowledges a started prompt before its faux response finishes and preserves queued materials", async () => {
	const entered = deferred();
	const release = deferred();
	await withBridge({}, async ({ harness, sessionId, request, events }) => {
		harness.setResponses([
			async () => {
				entered.release();
				await release.promise;
				return fauxAssistantMessage("completed");
			},
			fauxAssistantMessage("follow-up complete"),
		]);
		try {
			expect(await request({ type: "session.prompt", sessionId, message: "first task" })).toMatchObject({
				ok: true,
			});
			await entered.promise;
			expect(harness.session.isStreaming).toBe(true);
			expect(events.some((message) => (message.event as { type?: string }).type === "agent_settled")).toBe(false);
			const image = { type: "image" as const, data: "retained-queued-image", mimeType: "image/png" };
			expect(
				await request({
					type: "session.prompt",
					sessionId,
					message: "then inspect",
					attachedPaths: ["notes.md"],
					images: [image],
					streamingBehavior: "followUp",
				}),
			).toMatchObject({ ok: true });
			const queued = harness.session.agent.peekQueuedMessages();
			expect(queued).toMatchObject([
				{
					role: "user",
					content: [{ type: "text", text: "[Attached files for this turn]\n- notes.md\n\nthen inspect" }, image],
				},
			]);
		} finally {
			release.release();
			await harness.session.waitForIdle();
		}
	});
});

it("acknowledges input handled by an extension without starting a model", async () => {
	await withBridge(
		{
			extensionFactories: [
				{
					name: "handled-input",
					factory: (pi) => {
						pi.on("input", async () => ({ action: "handled" }));
					},
				},
			],
		},
		async ({ harness, sessionId, request }) => {
			expect(await request({ type: "session.prompt", sessionId, message: "handled locally" })).toMatchObject({
				ok: true,
			});
			expect(harness.faux.state.callCount).toBe(0);
		},
	);
});

it("exposes failures after acceptance and clears the optimistic running state without a second response", async () => {
	await withBridge({}, async ({ harness, sessionId, request, events, responses }) => {
		vi.spyOn(harness.session.agent, "prompt").mockRejectedValue(new Error("local dispatch failed after acceptance"));
		const accepted = await request({ type: "session.prompt", sessionId, message: "do the task" });
		expect(accepted.ok).toBe(true);
		await vi.waitFor(() =>
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionId,
						event: expect.objectContaining({
							type: "auto_retry_end",
							success: false,
							finalError: "local dispatch failed after acceptance",
							requestFailed: true,
						}),
					}),
					expect.objectContaining({ sessionId, event: { type: "agent_settled", aborted: false } }),
				]),
			),
		);
		expect(responses.filter((response) => response.id === accepted.id)).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
	});
});

it("rejects an aborted task continuation without credentials before appending a hidden resume message", async () => {
	await withBridge({ withConfiguredAuth: false }, async ({ harness, sessionId, request, events }) => {
		harness.sessionManager.appendMessage({ role: "user", content: "paused task", timestamp: Date.now() });
		harness.sessionManager.appendMessage(fauxAssistantMessage("paused", { stopReason: "aborted" }));
		const entriesBefore = harness.sessionManager.getEntries().length;
		const result = await request({ type: "session.continue", sessionId, message: "continue" });
		expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/API key/i) });
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(harness.faux.state.callCount).toBe(0);
		expect(events.some((message) => (message.event as { type?: string }).type === "agent_start")).toBe(false);
	});
});
