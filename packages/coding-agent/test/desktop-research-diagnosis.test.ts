import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { RESEARCH_DIAGNOSIS_ENTRY } from "../src/core/research/diagnosis.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerEventMessage,
	ServerResponseMessage,
	SessionSnapshotPayload,
} from "../src/modes/desktop/protocol.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";

it("carries a real faux Agent refusal through bridge events, snapshots and process restart only in research", async () => {
	const root = resolve(await mkdtemp(join(tmpdir(), "owl-diagnosis-bridge-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-diagnosis-bridge-"))
		throw new Error("Unsafe diagnosis bridge fixture cleanup target");
	const agentDir = join(root, "profile");
	const cwd = join(root, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	const faux = registerFauxProvider({
		provider: "research-diagnosis-fixture",
		models: [
			{ id: "fixture-model", name: "Offline fixture", contextWindow: 128000, maxTokens: 1024, reasoning: false },
		],
	});
	const provider = String(faux.getModel().provider);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			plugins: [],
			defaultProvider: provider,
			defaultModel: faux.models[0].id,
			cacheWarming: { mode: "off" },
			owlMemory: { enabled: false },
		}),
	);
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: "https://unused.invalid/v1",
					api: faux.api,
					apiKey: "offline-faux-test-key",
					models: [
						{
							id: faux.models[0].id,
							name: "Offline fixture",
							contextWindow: 128000,
							maxTokens: 1024,
							reasoning: false,
						},
					],
				},
			},
		}),
	);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	const noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("External requests forbidden in diagnosis bridge fixture");
	});
	vi.stubGlobal("fetch", noFetch);
	const start = () =>
		startDesktopServer({
			port: 0,
			agentDir,
			cwd,
			mcpServers: {},
			onDiagnostic: () => {},
			news: {
				fetch: noFetch,
				listModels: () => [],
				callModel: async () => {
					throw new Error("News model calls forbidden");
				},
				resolveModel: async () => {
					throw new Error("News model calls forbidden");
				},
			},
		});
	let server = await start();
	const sockets: WebSocket[] = [];
	const events: ServerEventMessage[] = [];
	async function connect() {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
		sockets.push(socket);
		await new Promise<void>((done, reject) => {
			socket.once("open", done);
			socket.once("error", reject);
		});
		socket.on("message", (data) => {
			const value = JSON.parse(String(data)) as ServerEventMessage;
			if (value.type === "event") events.push(value);
		});
		return socket;
	}
	function rpc(
		socket: WebSocket,
		payload: DesktopClientRequestWithoutId,
	): Promise<ServerResponseMessage & { result?: SessionSnapshotPayload }> {
		const id = randomUUID();
		return new Promise((done, reject) => {
			const timer = setTimeout(() => {
				socket.off("message", listener);
				reject(new Error(`RPC timeout: ${payload.type}`));
			}, 10000);
			const listener = (data: WebSocket.RawData) => {
				const response = JSON.parse(String(data)) as ServerResponseMessage & { result?: SessionSnapshotPayload };
				if (response.type !== "response" || response.id !== id) return;
				clearTimeout(timer);
				socket.off("message", listener);
				done(response);
			};
			socket.on("message", listener);
			socket.send(JSON.stringify({ ...payload, id }));
		});
	}
	async function waitForEntry(socket: WebSocket, sessionId: string) {
		return new Promise<void>((done, reject) => {
			const timer = setTimeout(() => {
				socket.off("message", listener);
				reject(new Error("Diagnosis entry event timed out"));
			}, 10000);
			const listener = (data: WebSocket.RawData) => {
				const response = JSON.parse(String(data)) as ServerEventMessage & {
					event: { type?: string; entry?: { customType?: string } };
				};
				if (
					response.type !== "event" ||
					response.sessionId !== sessionId ||
					response.event.type !== "entry_appended" ||
					response.event.entry?.customType !== RESEARCH_DIAGNOSIS_ENTRY
				)
					return;
				clearTimeout(timer);
				socket.off("message", listener);
				done();
			};
			socket.on("message", listener);
		});
	}
	try {
		const socket = await connect();
		const created = await rpc(socket, { type: "session.create", cwd, researchMode: "auto", approvalMode: "auto" });
		expect(created.ok, created.error).toBe(true);
		if (!created.result) throw new Error("Missing research snapshot");
		const id = created.result.sessionId;
		expect(created.result.researchDiagnosis).toBeUndefined();
		faux.setResponses([
			{
				...fauxAssistantMessage("Explicit refusal", { stopReason: "error", errorMessage: "Provider refusal" }),
				refusal: { source: "provider", text: "Explicit refusal" },
				rawStopReason: "completed",
			},
		]);
		const entry = waitForEntry(socket, id);
		expect(
			(await rpc(socket, { type: "session.prompt", sessionId: id, message: "解释自编程序已有的静态调用链" })).ok,
		).toBe(true);
		await entry;
		const current = await rpc(socket, { type: "session.resume", sessionId: id });
		expect(current.result?.researchDiagnosis, JSON.stringify(current.result?.researchDiagnosis)).toMatchObject({
			status: "upstream_refusal",
			ownerSessionId: id,
			evidence: [{ source: "provider", rawStopReason: "completed" }],
		});
		expect(faux.state.callCount).toBe(1);
		const ordinary = await rpc(socket, { type: "session.create", cwd });
		expect(ordinary.result?.researchMode).toBeUndefined();
		expect(ordinary.result?.researchDiagnosis).toBeUndefined();
		if (!ordinary.result) throw new Error("Missing ordinary snapshot");
		await server.close();
		server = await start();
		const reopened = await connect();
		const resumed = await rpc(reopened, { type: "session.resume", sessionId: id });
		expect(resumed.ok, resumed.error).toBe(true);
		expect(resumed.result?.researchDiagnosis).toEqual(current.result?.researchDiagnosis);
		const ordinaryResumed = await rpc(reopened, { type: "session.resume", sessionId: ordinary.result.sessionId });
		expect(ordinaryResumed.result?.researchDiagnosis).toBeUndefined();
		expect(noFetch).not.toHaveBeenCalled();
	} finally {
		for (const socket of sockets) socket.close();
		await server.close();
		faux.unregister();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
}, 30000);
