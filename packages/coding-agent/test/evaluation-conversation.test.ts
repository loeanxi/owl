import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildEvaluationContext,
	type EvaluationInvocation,
	type EvaluationInvocationResult,
	type EvaluationInvoker,
} from "../src/core/evaluation/model.ts";
import { EvaluationService, type EvaluationServiceOptions } from "../src/core/evaluation/service.ts";
import { EvaluationStore } from "../src/core/evaluation/store.ts";
import type {
	EvaluationModel,
	EvaluationRun,
	EvaluationRunView,
	EvaluationTask,
} from "../src/core/evaluation/types.ts";

const task: EvaluationTask = {
	id: "G03",
	version: 1,
	title: "Fixed evaluation",
	category: "svg",
	outputType: "svg",
	prompt: "Draw the fixed geometry.",
	input: "fixed input",
	builtin: true,
	rubric: ["structure", "clarity", "visual"].map((id) => ({ id, label: id, description: id })),
	checks: [
		{ id: "format", kind: "format", label: "Format" },
		{ id: "geometry", kind: "geometry", label: "Geometry" },
	],
};
const model: EvaluationModel = {
	provider: "offline-fixture",
	modelId: "fixture-one",
	name: "Private fixture model",
	sourceName: "Private provider",
	supportedThinkingLevels: ["default", "high"],
	contextWindow: 100_000,
	maxTokens: 1000,
	pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const sdkModel: Model<Api> = {
	id: model.modelId,
	name: model.name,
	provider: model.provider,
	api: "openai-completions",
	baseUrl: "https://offline.invalid",
	input: ["text"],
	reasoning: true,
	contextWindow: model.contextWindow,
	maxTokens: model.maxTokens,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const initialOutput = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
function reply(text = initialOutput): EvaluationInvocationResult {
	return {
		text,
		thinking: "supplier reasoning",
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
		costUsd: 0.00005,
		stopReason: "stop",
		error: null,
		actualModel: {
			provider: model.provider,
			modelId: model.modelId,
			responseModel: "private-upstream",
			forwardedThinkingLevel: "high",
			providerThinkingLevel: "high",
		},
	};
}
function gate<T>() {
	let release: (value: T) => void = () => {
		throw new Error("Uninitialized fixture gate");
	};
	const promise = new Promise<T>((done) => {
		release = done;
	});
	return { promise, release };
}
const directories: string[] = [];
const services: EvaluationService[] = [];
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const directory of directories.splice(0)) {
		const target = resolve(directory);
		if (!target.startsWith(`${resolve(tmpdir())}\\`) || !target.includes("owl-evaluation-conversation-"))
			throw new Error("Unsafe conversation fixture cleanup target");
		await rm(target, { recursive: true, force: true });
	}
});
async function setup(invoke: EvaluationInvoker = async () => reply(), options: Partial<EvaluationServiceOptions> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "owl-evaluation-conversation-"));
	directories.push(directory);
	const service = new EvaluationService({
		agentDir: directory,
		builtinTasks: [task],
		listModels: async () => [model],
		invoke,
		timeoutMs: 3000,
		check: async (tested, output) => ({
			artifact: { type: tested.outputType, content: output, previewAllowed: true },
			checks: [{ id: "format", label: "Format", status: "passed", detail: "Offline fixture" }],
		}),
		...options,
	});
	services.push(service);
	return { service, directory };
}
async function get(service: EvaluationService, runId: string) {
	return (await service.handle({ action: "run.get", runId })) as EvaluationRunView;
}
async function waitUntil(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 2500;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("Offline conversation fixture did not settle");
		await new Promise((done) => setTimeout(done, 5));
	}
}
async function start(service: EvaluationService, samples: 1 | 3 | 5 = 1) {
	const run = (await service.handle({
		action: "run.start",
		name: "Offline conversation",
		taskIds: [task.id],
		samples,
		profiles: [{ id: "frozen-profile", provider: model.provider, modelId: model.modelId, thinkingLevel: "high" }],
	})) as EvaluationRunView;
	await waitUntil(async () => (await get(service, run.id)).status !== "running");
	return await get(service, run.id);
}
async function settledFollowup(service: EvaluationService, runId: string, resultId: string) {
	await waitUntil(
		async () =>
			(await get(service, runId)).results
				.find((result) => result.id === resultId)
				?.followups.every((turn) => turn.status !== "running" && turn.status !== "queued") ?? false,
	);
	return (await get(service, runId)).results.find((result) => result.id === resultId)!;
}

describe("independent evaluation mini-conversations", () => {
	it("retains failed provider turns without retrying and excludes them from later conversation history", async () => {
		const calls: EvaluationInvocation[] = [];
		const { service } = await setup(async (request) => {
			calls.push(request);
			if (!request.conversation) return { ...reply("retained initial partial"), stopReason: "length" };
			if (request.conversation.prompt === "failed followup")
				return { ...reply("retained failed partial"), stopReason: "error", error: "private provider unavailable" };
			return reply("successful continuation");
		});
		const run = await start(service);
		const resultId = run.results[0].id;
		expect(run.results[0].status).toBe("failed");
		await service.handle({ action: "conversation.send", runId: run.id, resultId, prompt: "failed followup" });
		const failed = await settledFollowup(service, run.id, resultId);
		expect(failed.followups[0]).toMatchObject({ status: "failed", output: "retained failed partial" });
		expect(failed.followups[0].error).not.toContain("private provider");
		await service.handle({ action: "conversation.send", runId: run.id, resultId, prompt: "continue" });
		await settledFollowup(service, run.id, resultId);
		expect(calls).toHaveLength(3);
		expect(calls[2].conversation).toEqual({
			originalAnswer: "retained initial partial",
			turns: [],
			prompt: "continue",
		});
		expect((await get(service, run.id)).results[0].status).toBe("failed");
	});

	it("caps exploration turns without making an extra model call", async () => {
		let count = 0;
		const { service } = await setup(async (request) => {
			count++;
			return reply(request.conversation ? "small response" : initialOutput);
		});
		const run = await start(service);
		const resultId = run.results[0].id;
		for (let index = 0; index < 20; index++) {
			await service.handle({ action: "conversation.send", runId: run.id, resultId, prompt: `question ${index}` });
			await settledFollowup(service, run.id, resultId);
		}
		await expect(
			service.handle({ action: "conversation.send", runId: run.id, resultId, prompt: "one too many" }),
		).rejects.toThrow("20 次");
		expect(count).toBe(21);
		expect((await get(service, run.id)).results[0].followups).toHaveLength(20);
	});

	it("streams a real isolated followup, retains the scored first answer, and replays only successful text turns", async () => {
		const requests: EvaluationInvocation[] = [];
		const firstGate = gate<EvaluationInvocationResult>();
		const { service, directory } = await setup(async (request) => {
			requests.push(request);
			if (!request.conversation) return reply();
			if (request.conversation.prompt === "first question") {
				request.onPartial("", "followup reasoning delta");
				return firstGate.promise;
			}
			return reply("second answer");
		});
		const run = await start(service);
		const resultId = run.results[0].id;
		await service.handle({
			action: "run.reveal",
			runId: run.id,
			taskId: task.id,
			sample: 1,
			mode: "score",
			ratings: { [resultId]: { scores: { structure: 4, clarity: 3, visual: 5 }, note: "first answer only" } },
		});
		const before = await get(service, run.id);
		const begun = (await service.handle({
			action: "conversation.send",
			runId: run.id,
			resultId,
			prompt: " first question ",
		})) as EvaluationRunView;
		expect(begun.status).toBe("completed");
		expect(begun.results[0].followups[0]).toMatchObject({ prompt: "first question", status: "queued" });
		await waitUntil(() => requests.length === 2);
		const thinking = await get(service, run.id);
		expect(thinking.results[0].followups[0]).toMatchObject({
			status: "running",
			generationPhase: "thinking",
			thinking: "followup reasoning delta",
		});
		requests[1].onPartial("first answer delta", "followup reasoning delta");
		expect((await get(service, run.id)).results[0].followups[0]).toMatchObject({
			output: "first answer delta",
			generationPhase: "answering",
		});
		firstGate.release(reply("first answer"));
		await settledFollowup(service, run.id, resultId);
		await service.handle({ action: "conversation.send", runId: run.id, resultId, prompt: "second question" });
		const result = await settledFollowup(service, run.id, resultId);
		expect(requests[1].conversation).toEqual({ originalAnswer: initialOutput, turns: [], prompt: "first question" });
		expect(requests[2].conversation).toEqual({
			originalAnswer: initialOutput,
			turns: [{ prompt: "first question", output: "first answer" }],
			prompt: "second question",
		});
		expect(requests[2].profile).toEqual(requests[0].profile);
		const { followups: _beforeTurns, ...beforeInitial } = before.results[0];
		const { followups: turns, ...afterInitial } = result;
		expect(afterInitial).toEqual(beforeInitial);
		expect(turns).toHaveLength(2);
		expect(turns.every((turn) => turn.status === "completed" && turn.generationPhase === undefined)).toBe(true);
		const summaries = await service.handle({ action: "run.list" });
		expect(summaries).toEqual([
			expect.objectContaining({ total: 1, completed: 1, pending: 0, rated: 1, revealed: 1 }),
		]);
		const persisted = JSON.parse(
			await readFile(join(directory, "model-evaluations", "runs", `${run.id}.json`), "utf8"),
		) as EvaluationRun;
		expect(persisted.results[0].followups?.[1].output).toBe("second answer");
		expect(persisted.results[0].rating).toEqual(before.results[0].rating);
	});

	it("projects live followup reasoning anonymously and reveals only the selected group's metrics", async () => {
		const { service } = await setup(async (request) => (request.conversation ? reply("plain explanation") : reply()));
		const run = await start(service, 3);
		const resultId = run.results[0].id;
		await service.handle({ action: "conversation.send", runId: run.id, resultId, prompt: "Explain it" });
		const result = await settledFollowup(service, run.id, resultId);
		const turn = result.followups[0];
		expect(turn).toMatchObject({
			prompt: "Explain it",
			output: "plain explanation",
			thinking: "supplier reasoning",
			artifact: null,
			checks: [],
			status: "completed",
		});
		for (const field of ["startedAt", "finishedAt", "durationMs", "usage", "costUsd", "actualModel"])
			expect(turn).not.toHaveProperty(field);
		const revealed = (await service.handle({
			action: "run.reveal",
			runId: run.id,
			taskId: task.id,
			sample: 1,
			mode: "skip",
		})) as EvaluationRunView;
		expect(revealed.results[0].followups[0]).toMatchObject({
			usage: reply().usage,
			costUsd: reply().costUsd,
			actualModel: reply().actualModel,
		});
		expect(revealed.results.filter((entry) => entry.sample !== 1).every((entry) => entry.profile === undefined)).toBe(
			true,
		);
	});

	it("builds SDK user/assistant messages without tools, project state, reasoning blocks, or forged signatures", async () => {
		const { service } = await setup();
		const run = await start(service);
		await service.handle({ action: "run.reveal", runId: run.id, taskId: task.id, sample: 1, mode: "skip" });
		const profile = (await get(service, run.id)).results[0].profile!;
		const context = buildEvaluationContext(
			{
				task,
				profile,
				signal: new AbortController().signal,
				onPartial: () => {},
				conversation: {
					originalAnswer: "first reply",
					turns: [{ prompt: "previous question", output: "previous reply" }],
					prompt: "new question",
				},
			},
			sdkModel,
		);
		expect(context.messages.map((entry) => entry.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		expect(context.messages.map((entry) => entry.content)).toEqual([
			"Draw the fixed geometry.\n\nfixed input",
			[{ type: "text", text: "first reply" }],
			"previous question",
			[{ type: "text", text: "previous reply" }],
			"new question",
		]);
		expect(context).not.toHaveProperty("tools");
		expect(context).not.toHaveProperty("systemPrompt");
		for (const message of context.messages.filter((entry) => entry.role === "assistant")) {
			expect(message).toMatchObject({
				api: sdkModel.api,
				provider: model.provider,
				model: model.modelId,
				stopReason: "stop",
			});
			expect(JSON.stringify(message)).not.toMatch(/thinking|signature|responseId/);
		}
	});

	it("cancels one turn independently, ignores late deltas, and excludes incomplete turns from the next context", async () => {
		const calls: EvaluationInvocation[] = [];
		const { service } = await setup(async (request) => {
			if (!request.conversation) return reply();
			calls.push(request);
			if (calls.length === 1) {
				request.onPartial("retained partial", "retained reasoning");
				return new Promise<EvaluationInvocationResult>(() => {});
			}
			return reply("resumed answer");
		});
		const run = await start(service);
		const resultId = run.results[0].id;
		const begun = (await service.handle({
			action: "conversation.send",
			runId: run.id,
			resultId,
			prompt: "stop this",
		})) as EvaluationRunView;
		await waitUntil(() => calls.length === 1);
		await service.handle({
			action: "conversation.cancel",
			runId: run.id,
			resultId,
			followupId: begun.results[0].followups[0].id,
		});
		const cancelled = await settledFollowup(service, run.id, resultId);
		expect(cancelled.status).toBe("completed");
		expect(cancelled.followups[0]).toMatchObject({
			status: "cancelled",
			output: "retained partial",
			thinking: "retained reasoning",
		});
		expect(cancelled.followups[0].error).not.toContain("用户停止");
		calls[0].onPartial("late answer", "late thinking");
		expect((await get(service, run.id)).results[0].followups[0].output).toBe("retained partial");
		await service.handle({ action: "conversation.send", runId: run.id, resultId, prompt: "continue normally" });
		await settledFollowup(service, run.id, resultId);
		expect(calls[1].conversation?.turns).toEqual([]);
		expect((await get(service, run.id)).status).toBe("completed");
	});

	it("shares the two-call limit, cancels queued work, and prioritizes explicit followups before remaining evaluation calls", async () => {
		const followupCalls: EvaluationInvocation[] = [];
		let initialCalls = 0;
		const { service } = await setup(async (request) => {
			if (!request.conversation) {
				initialCalls++;
				return reply();
			}
			followupCalls.push(request);
			return new Promise<EvaluationInvocationResult>(() => {});
		});
		const run = await start(service, 5);
		for (const index of [0, 1, 2])
			await service.handle({
				action: "conversation.send",
				runId: run.id,
				resultId: run.results[index].id,
				prompt: `turn ${index}`,
			});
		await waitUntil(() => followupCalls.length === 2);
		const current = await get(service, run.id);
		expect(current.results[2].followups[0].status).toBe("queued");
		await service.handle({
			action: "conversation.cancel",
			runId: run.id,
			resultId: current.results[2].id,
			followupId: current.results[2].followups[0].id,
		});
		const nextRun = (await service.handle({
			action: "run.start",
			name: "Remaining evaluation",
			taskIds: [task.id],
			samples: 1,
			profiles: [{ id: "next-profile", provider: model.provider, modelId: model.modelId, thinkingLevel: "high" }],
		})) as EvaluationRunView;
		await service.handle({
			action: "conversation.send",
			runId: run.id,
			resultId: run.results[3].id,
			prompt: "priority turn",
		});
		await service.handle({
			action: "conversation.cancel",
			runId: run.id,
			resultId: current.results[0].id,
			followupId: current.results[0].followups[0].id,
		});
		await waitUntil(() => followupCalls.length === 3);
		expect(followupCalls[2].conversation?.prompt).toBe("priority turn");
		expect(initialCalls).toBe(5);
		expect((await get(service, nextRun.id)).results[0].status).toBe("queued");
		expect((await get(service, run.id)).results[1].followups[0].status).toBe("running");
		expect(followupCalls.filter((entry) => !entry.signal.aborted)).toHaveLength(2);
	});

	it("restores nested queued/running turns as interrupted without changing a completed first evaluation", async () => {
		const { service, directory } = await setup(async (request) =>
			request.conversation ? reply("successful turn") : reply(),
		);
		const run = await start(service);
		await service.handle({
			action: "conversation.send",
			runId: run.id,
			resultId: run.results[0].id,
			prompt: "first question",
		});
		await settledFollowup(service, run.id, run.results[0].id);
		await service.close();
		const store = new EvaluationStore(directory);
		const stored = store.getRun(run.id);
		const turn = stored.results[0].followups![0];
		turn.status = "running";
		turn.output = "retained partial";
		turn.generationPhase = "answering";
		stored.results[0].followups!.push({ ...turn, id: "queued-turn", status: "queued", output: "" });
		store.saveRun(stored);
		const restored = new EvaluationStore(directory).getRun(run.id);
		expect(restored.status).toBe("completed");
		expect(restored.results[0].status).toBe("completed");
		expect(restored.results[0].output).toBe(initialOutput);
		expect(
			restored.results[0].followups?.every(
				(entry) => entry.status === "interrupted" && entry.generationPhase === undefined,
			),
		).toBe(true);
		expect(restored.results[0].followups?.[0].output).toBe("retained partial");
	});

	it("validates prompts and bounded history before queuing, rejects active duplicate turns, and leaves original records intact", async () => {
		const { service, directory } = await setup(async (request) =>
			request.conversation ? new Promise<EvaluationInvocationResult>(() => {}) : reply(),
		);
		const run = await start(service);
		const resultId = run.results[0].id;
		for (const prompt of ["  ", "x".repeat(10_001)])
			await expect(service.handle({ action: "conversation.send", runId: run.id, resultId, prompt })).rejects.toThrow(
				"10000",
			);
		expect((await get(service, run.id)).results[0].followups).toEqual([]);
		const store = new EvaluationStore(directory);
		const snapshot = store.getRun(run.id);
		snapshot.profiles[0].model.contextWindow = 1200;
		store.saveRun(snapshot);
		const replacement = new EvaluationService({
			agentDir: directory,
			listModels: async () => [model],
			invoke: async () => reply(),
			check: async () => ({ artifact: null, checks: [] }),
		});
		services.push(replacement);
		await expect(
			replacement.handle({ action: "conversation.send", runId: run.id, resultId, prompt: "small question" }),
		).rejects.toThrow("上下文");
		expect((await get(replacement, run.id)).results[0].followups).toEqual([]);
		await service.handle({ action: "conversation.send", runId: run.id, resultId, prompt: "active question" });
		await expect(
			service.handle({ action: "conversation.send", runId: run.id, resultId, prompt: "duplicate question" }),
		).rejects.toThrow("正在生成");
		await service.close();
		const stopped = new EvaluationStore(directory).getRun(run.id);
		expect(stopped.status).toBe("completed");
		expect(stopped.results[0].followups?.[0].status).toBe("interrupted");
	});

	it("checks followup artifacts without the original fixed requirements, accepts plain explanations, and accepts bare JSON", async () => {
		const checked: EvaluationTask[] = [];
		const { service } = await setup(async (request) => (request.conversation ? reply() : reply()), {
			check: async (tested, output) => {
				checked.push(structuredClone(tested));
				return { artifact: { type: tested.outputType, content: output, previewAllowed: true }, checks: [] };
			},
		});
		const run = await start(service);
		await service.handle({
			action: "conversation.send",
			runId: run.id,
			resultId: run.results[0].id,
			prompt: "change geometry",
		});
		await settledFollowup(service, run.id, run.results[0].id);
		expect(checked[0]).toEqual(task);
		expect(checked[1]).toMatchObject({
			id: "conversation-G03",
			builtin: false,
			checks: [{ id: "format", kind: "format", label: "Format" }],
		});
		const jsonTask: EvaluationTask = { ...task, id: "json-fixture", outputType: "json" };
		const jsonFixture = await setup(
			async (request) => reply(request.conversation ? '{"changed":true}' : '{"original":true}'),
			{ builtinTasks: [jsonTask] },
		);
		const begun = (await jsonFixture.service.handle({
			action: "run.start",
			name: "JSON fixture",
			taskIds: [jsonTask.id],
			samples: 1,
			profiles: [{ id: "json-profile", provider: model.provider, modelId: model.modelId, thinkingLevel: "default" }],
		})) as EvaluationRunView;
		await waitUntil(async () => (await get(jsonFixture.service, begun.id)).status === "completed");
		await jsonFixture.service.handle({
			action: "conversation.send",
			runId: begun.id,
			resultId: begun.results[0].id,
			prompt: "change json",
		});
		const result = await settledFollowup(jsonFixture.service, begun.id, begun.results[0].id);
		expect(result.followups[0].artifact).toMatchObject({ type: "json", content: '{"changed":true}' });
	});
});
