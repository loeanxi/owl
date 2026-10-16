import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AgentSession } from "../src/core/agent-session.ts";
import * as runtimeModule from "../src/core/agent-session-runtime.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerResponseMessage,
	SessionSnapshotPayload,
	SessionStatsResult,
} from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

let directory: string;
let cwd: string;
let bridge: DesktopServerHandle;
let socket: WebSocket;
let sessions: Map<string, AgentSession>;
let releases: Array<() => void>;
let noFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
	directory = resolve(await mkdtemp(join(tmpdir(), "owl-model-settings-order-")));
	if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith("owl-model-settings-order-")) {
		throw new Error("Unsafe fixture cleanup target");
	}
	const agentDir = join(directory, "profile");
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
				"offline-order": {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					apiKey: "offline-fixture-key",
					models: ["initial", "older", "latest"].map((id) => ({
						id,
						name: id,
						reasoning: true,
						contextWindow: 128000,
						maxTokens: 4096,
					})),
				},
			},
		}),
	);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("Provider requests forbidden in model ordering test");
	});
	vi.stubGlobal("fetch", noFetch);
	sessions = new Map();
	releases = [];
	const create = runtimeModule.createAgentSessionRuntime;
	vi.spyOn(runtimeModule, "createAgentSessionRuntime").mockImplementation(async (...args) => {
		const runtime = await create(...args);
		sessions.set(runtime.session.sessionId, runtime.session);
		return runtime;
	});
	bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
	await new Promise<void>((done, reject) => {
		socket.once("open", done);
		socket.once("error", reject);
	});
});

afterEach(async () => {
	for (const release of releases) release();
	socket?.terminate();
	await bridge?.close();
	expect(noFetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

function rpc<T = unknown>(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage & { result?: T }> {
	const id = randomUUID();
	return new Promise((done, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", receive);
			reject(new Error(`Fixture RPC timed out: ${payload.type}`));
		}, 10_000);
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

async function createSession() {
	const created = await rpc<SessionSnapshotPayload>({
		type: "session.create",
		cwd,
		provider: "offline-order",
		model: "initial",
	});
	expect(created.ok).toBe(true);
	const sessionId = created.result!.sessionId;
	const session = sessions.get(sessionId);
	if (!session) throw new Error("Missing live fixture session");
	return { sessionId, session };
}

function authGate(session: AgentSession) {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	releases.push(() => released.resolve());
	const checkAuth = session.modelRuntime.checkAuth.bind(session.modelRuntime);
	let first = true;
	const check = vi.spyOn(session.modelRuntime, "checkAuth").mockImplementation(async (...args) => {
		if (first) {
			first = false;
			entered.resolve();
			await released.promise;
		}
		return checkAuth(...args);
	});
	return { entered: entered.promise, release: () => released.resolve(), check };
}

describe("real bridge session setting serialization", () => {
	it("a slow older auth cannot overwrite a newer model or an acknowledged thinking choice", async () => {
		const { sessionId, session } = await createSession();
		const gate = authGate(session);
		const order: string[] = [];
		const older = rpc<SessionStatsResult>({
			type: "session.setModel",
			sessionId,
			provider: "offline-order",
			model: "older",
		}).then((response) => {
			order.push("older");
			return response;
		});
		await gate.entered;
		const latest = rpc<SessionStatsResult>({
			type: "session.setModel",
			sessionId,
			provider: "offline-order",
			model: "latest",
		}).then((response) => {
			order.push("latest");
			return response;
		});
		const thinking = rpc<SessionStatsResult>({ type: "session.setThinkingLevel", sessionId, level: "medium" }).then(
			(response) => {
				order.push("thinking");
				return response;
			},
		);
		await rpc({ type: "ping" });
		expect(gate.check).toHaveBeenCalledTimes(1);
		expect(order).toEqual([]);
		gate.release();
		const [oldResponse, newResponse, thinkingResponse] = await Promise.all([older, latest, thinking]);
		expect(oldResponse).toMatchObject({ ok: true, result: { model: { id: "older" } } });
		expect(newResponse).toMatchObject({ ok: true, result: { model: { id: "latest" } } });
		expect(thinkingResponse).toMatchObject({
			ok: true,
			result: { model: { id: "latest" }, thinkingLevel: "medium" },
		});
		expect(order).toEqual(["older", "latest", "thinking"]);
		expect(session.model?.id).toBe("latest");
		expect(session.thinkingLevel).toBe("medium");
	});

	it("one session's delayed auth does not block a different session", async () => {
		const one = await createSession();
		const two = await createSession();
		const gate = authGate(one.session);
		const blocked = rpc({
			type: "session.setModel",
			sessionId: one.sessionId,
			provider: "offline-order",
			model: "older",
		});
		await gate.entered;
		const independent = await rpc<SessionStatsResult>({
			type: "session.setModel",
			sessionId: two.sessionId,
			provider: "offline-order",
			model: "latest",
		});
		expect(independent).toMatchObject({ ok: true, result: { model: { id: "latest" } } });
		expect(one.session.model?.id).toBe("initial");
		gate.release();
		expect((await blocked).ok).toBe(true);
	});

	it("a failed auth returns current host state and does not poison the next queued switch", async () => {
		const { sessionId, session } = await createSession();
		const checkAuth = session.modelRuntime.checkAuth.bind(session.modelRuntime);
		let first = true;
		vi.spyOn(session.modelRuntime, "checkAuth").mockImplementation(async (...args) => {
			if (first) {
				first = false;
				throw new Error("fixture auth failed");
			}
			return checkAuth(...args);
		});
		const failed = rpc<SessionStatsResult>({
			type: "session.setModel",
			sessionId,
			provider: "offline-order",
			model: "older",
		});
		const latest = rpc<SessionStatsResult>({
			type: "session.setModel",
			sessionId,
			provider: "offline-order",
			model: "latest",
		});
		expect(await failed).toMatchObject({
			ok: false,
			error: "fixture auth failed",
			result: { model: { id: "initial" } },
		});
		expect(await latest).toMatchObject({ ok: true, result: { model: { id: "latest" } } });
	});

	it("waits for an older model-select extension before applying a later thinking setting", async () => {
		const { sessionId, session } = await createSession();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		releases.push(() => released.resolve());
		const emit = session.extensionRunner.emit.bind(session.extensionRunner);
		const dispatch: typeof session.extensionRunner.emit = async (event) => {
			if (event.type === "model_select" && event.model.id === "older") {
				entered.resolve();
				await released.promise;
			}
			return emit(event);
		};
		vi.spyOn(session.extensionRunner, "emit").mockImplementation(dispatch);
		const switching = rpc({ type: "session.setModel", sessionId, provider: "offline-order", model: "older" });
		await entered.promise;
		let acknowledged = false;
		const thinking = rpc<SessionStatsResult>({ type: "session.setThinkingLevel", sessionId, level: "high" }).then(
			(response) => {
				acknowledged = true;
				return response;
			},
		);
		await rpc({ type: "ping" });
		expect(acknowledged).toBe(false);
		released.resolve();
		expect((await switching).ok).toBe(true);
		expect(await thinking).toMatchObject({ ok: true, result: { thinkingLevel: "high" } });
		expect(session.thinkingLevel).toBe("high");
	});

	it("reports the actual partially applied model when its model-select extension throws", async () => {
		const { sessionId, session } = await createSession();
		const emit = session.extensionRunner.emit.bind(session.extensionRunner);
		const dispatch: typeof session.extensionRunner.emit = async (event) => {
			if (event.type === "model_select" && event.model.id === "older")
				throw new Error("fixture model-select failed after mutation");
			return emit(event);
		};
		vi.spyOn(session.extensionRunner, "emit").mockImplementation(dispatch);
		expect(
			await rpc<SessionStatsResult>({
				type: "session.setModel",
				sessionId,
				provider: "offline-order",
				model: "older",
			}),
		).toMatchObject({
			ok: false,
			error: "fixture model-select failed after mutation",
			result: { model: { id: "older" } },
		});
		expect(session.model?.id).toBe("older");
		expect(
			await rpc<SessionStatsResult>({
				type: "session.setModel",
				sessionId,
				provider: "offline-order",
				model: "latest",
			}),
		).toMatchObject({ ok: true, result: { model: { id: "latest" } } });
	});

	it("retires queued settings before unloading instead of mutating a disposed or replacement instance", async () => {
		const { sessionId, session } = await createSession();
		// Persist history without invoking a provider; an untouched blank session has no JSONL to delete.
		session.sessionManager.appendMessage({ role: "user", content: "Fixture history", timestamp: Date.now() });
		const gate = authGate(session);
		const older = rpc({ type: "session.setModel", sessionId, provider: "offline-order", model: "older" });
		await gate.entered;
		const queued = rpc({ type: "session.setModel", sessionId, provider: "offline-order", model: "latest" });
		const deleting = rpc({ type: "session.delete", sessionId });
		await rpc({ type: "ping" });
		gate.release();
		expect(await older).toMatchObject({ ok: false, error: expect.stringContaining("已卸载") });
		expect(await queued).toMatchObject({ ok: false, error: expect.stringContaining("已卸载") });
		expect((await deleting).ok).toBe(true);
		expect(session.model?.id).toBe("older");
		expect(gate.check).toHaveBeenCalledTimes(1);
	});

	it("keeps a replacement runtime under the same session ID independent from the retired queue", async () => {
		const { sessionId, session } = await createSession();
		const gate = authGate(session);
		const older = rpc({ type: "session.setModel", sessionId, provider: "offline-order", model: "older" });
		await gate.entered;
		const queued = rpc({ type: "session.setModel", sessionId, provider: "offline-order", model: "latest" });
		const replacing = rpc({ type: "session.setPreset", sessionId, agentPreset: "pi" });
		await rpc({ type: "ping" });
		gate.release();
		expect((await older).ok).toBe(false);
		expect((await queued).ok).toBe(false);
		expect(await replacing).toMatchObject({ ok: true, result: { agentPreset: "pi" } });
		const replacement = sessions.get(sessionId);
		expect(replacement).toBeDefined();
		expect(replacement).not.toBe(session);
		expect(replacement?.model?.id).toBe("initial");
		expect(
			await rpc<SessionStatsResult>({
				type: "session.setModel",
				sessionId,
				provider: "offline-order",
				model: "latest",
			}),
		).toMatchObject({ ok: true, result: { model: { id: "latest" } } });
		expect(replacement?.model?.id).toBe("latest");
		expect(session.model?.id).toBe("older");
	});
});
