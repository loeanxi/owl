import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { EvaluationInvocationResult } from "../src/core/evaluation/model.ts";
import type { EvaluationBootstrap, EvaluationRunView, EvaluationTask } from "../src/core/evaluation/types.ts";
import type { DesktopClientRequestWithoutId, ServerResponseMessage } from "../src/modes/desktop/protocol.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";

it("routes evaluation RPCs over the real bridge and leaves background work alive when its socket disconnects", async () => {
	const directory = await mkdtemp(join(tmpdir(), "owl-evaluation-bridge-test-"));
	const absolute = resolve(directory);
	if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-evaluation-bridge-test-"))
		throw new Error("Unsafe bridge cleanup target");
	const agentDir = join(directory, "profile");
	const cwd = join(directory, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	const task: EvaluationTask = {
		id: "bridge-task",
		title: "Bridge fixture",
		version: 1,
		builtin: true,
		category: "code",
		outputType: "code",
		prompt: "fixture",
		checks: [],
		rubric: ["clarity", "correctness", "scope"].map((id) => ({ id, label: id, description: id })),
	};
	let finish: ((result: EvaluationInvocationResult) => void) | undefined;
	const forbiddenFetch: typeof fetch = async () => {
		throw new Error("Paid or remote calls are forbidden in bridge tests");
	};
	const bridge = await startDesktopServer({
		port: 0,
		agentDir,
		cwd,
		mcpServers: {},
		onDiagnostic: () => {},
		evaluation: {
			builtinTasks: [task],
			idleTimeoutMs: 2000,
			listModels: async () => [
				{
					provider: "fake",
					modelId: "isolated",
					name: "Offline fixture",
					sourceName: "Fake provider",
					supportedThinkingLevels: ["default"],
					contextWindow: 8000,
					maxTokens: 1000,
					pricing: null,
				},
			],
			invoke: async (request) => {
				request.onPartial("background partial", "");
				return new Promise<EvaluationInvocationResult>((done) => {
					finish = done;
				});
			},
			check: async (_task, output) => ({
				artifact: { type: "code", content: output, previewAllowed: false },
				checks: [],
			}),
		},
		news: {
			fetch: forbiddenFetch,
			listModels: () => [],
			callModel: async () => {
				throw new Error("News model calls are forbidden");
			},
			resolveModel: async () => {
				throw new Error("News model calls are forbidden");
			},
		},
	});
	const sockets: WebSocket[] = [];
	try {
		async function connect() {
			const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, {
				headers: { Origin: `http://127.0.0.1:${bridge.port}` },
			});
			sockets.push(socket);
			await new Promise<void>((done, reject) => {
				socket.once("open", done);
				socket.once("error", reject);
			});
			return socket;
		}
		function request<T>(
			socket: WebSocket,
			payload: DesktopClientRequestWithoutId,
		): Promise<ServerResponseMessage & { result?: T }> {
			const id = randomUUID();
			return new Promise((done, reject) => {
				const timer = setTimeout(() => {
					socket.off("message", receive);
					reject(new Error("Fake bridge request timed out"));
				}, 1500);
				const receive = (data: unknown) => {
					const response = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
					if (response.type !== "response" || response.id !== id) return;
					clearTimeout(timer);
					socket.off("message", receive);
					done(response);
				};
				socket.on("message", receive);
				socket.send(JSON.stringify({ ...payload, id }));
			});
		}
		const first = await connect();
		const bootstrap = await request<EvaluationBootstrap>(first, {
			type: "evaluation.request",
			request: { action: "bootstrap" },
		});
		expect(bootstrap).toMatchObject({
			ok: true,
			result: {
				tasks: [expect.objectContaining({ id: task.id })],
				models: [expect.objectContaining({ modelId: "isolated" })],
				runs: [],
			},
		});
		const started = await request<EvaluationRunView>(first, {
			type: "evaluation.request",
			request: {
				action: "run.start",
				name: "Bridge run",
				taskIds: [task.id],
				profiles: [{ id: "profile", provider: "fake", modelId: "isolated", thinkingLevel: "default" }],
				samples: 1,
			},
		});
		expect(started.ok).toBe(true);
		const runId = started.result?.id;
		if (!runId) throw new Error("No evaluation run returned");
		expect(await request(first, { type: "ping" })).toMatchObject({ ok: true, result: "pong" });
		first.terminate();
		if (!finish) throw new Error("No fake invocation started");
		finish({
			text: "background final answer",
			thinking: "private reasoning",
			stopReason: "stop",
			usage: null,
			costUsd: null,
			error: null,
		});
		const second = await connect();
		const read = await request<EvaluationRunView>(second, {
			type: "evaluation.request",
			request: { action: "run.get", runId },
		});
		expect(read).toMatchObject({
			ok: true,
			result: {
				status: "completed",
				results: [expect.objectContaining({ output: "background final answer", status: "completed" })],
			},
		});
		expect(JSON.stringify(read)).not.toContain("Offline fixture");
		expect(read.result?.results[0].thinking).toBe("private reasoning");
		for (const field of ["profile", "profileId", "usage", "costUsd", "durationMs", "actualModel"])
			expect(read.result?.results[0]).not.toHaveProperty(field);
	} finally {
		for (const socket of sockets) socket.terminate();
		await bridge.close();
		vi.unstubAllEnvs();
		await rm(absolute, { recursive: true, force: true });
	}
});
