import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	EvaluationInvocation,
	EvaluationInvocationResult,
	EvaluationInvoker,
} from "../src/core/evaluation/model.ts";
import { EvaluationService, type EvaluationServiceOptions } from "../src/core/evaluation/service.ts";
import { EvaluationStore } from "../src/core/evaluation/store.ts";
import type {
	EvaluationModel,
	EvaluationRequest,
	EvaluationRunView,
	EvaluationTask,
} from "../src/core/evaluation/types.ts";

const task: EvaluationTask = {
	id: "test-svg",
	version: 1,
	title: "测试图形",
	category: "svg",
	outputType: "svg",
	prompt: "Draw a bicycle.",
	input: "fixed fixture",
	builtin: true,
	rubric: [
		{ id: "structure", label: "结构", description: "结构合理" },
		{ id: "clarity", label: "清楚", description: "内容清楚" },
		{ id: "visual", label: "视觉", description: "视觉清晰" },
	],
	checks: [{ id: "format", kind: "format", label: "格式" }],
};
const models: EvaluationModel[] = [
	{
		provider: "test-provider",
		modelId: "model-one",
		name: "模型一",
		sourceName: "测试来源",
		supportedThinkingLevels: ["default", "off", "high"],
		contextWindow: 100_000,
		maxTokens: 1000,
		pricing: null,
	},
	{
		provider: "test-provider",
		modelId: "model-two",
		name: "模型二",
		sourceName: "测试来源",
		supportedThinkingLevels: ["default", "off"],
		contextWindow: 100_000,
		maxTokens: 1000,
		pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
	},
];
const reply: EvaluationInvocationResult = {
	text: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>',
	thinking: "private reasoning",
	usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
	costUsd: 0.00005,
	stopReason: "stop",
	error: null,
};

const directories: string[] = [];
const services: EvaluationService[] = [];
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const directory of directories.splice(0)) {
		const target = resolve(directory);
		if (!target.startsWith(resolve(tmpdir())) || !target.includes("owl-evaluation-test-"))
			throw new Error("Unsafe test cleanup target");
		await rm(target, { recursive: true, force: true });
	}
});

async function setup(
	invoke: EvaluationInvoker = async () => structuredClone(reply),
	idleTimeoutMs = 1000,
	check?: EvaluationServiceOptions["check"],
) {
	const directory = await mkdtemp(join(tmpdir(), "owl-evaluation-test-"));
	directories.push(directory);
	const service = new EvaluationService({
		agentDir: directory,
		builtinTasks: [structuredClone(task)],
		listModels: async () => structuredClone(models),
		invoke,
		idleTimeoutMs,
		check:
			check ??
			(async (tested, text) => ({
				artifact: { type: tested.outputType, content: text, previewAllowed: true },
				checks: [{ id: "format", label: "格式", status: "passed", detail: "fixture checked" }],
			})),
	});
	services.push(service);
	return { directory, service };
}

async function start(service: EvaluationService, samples: 1 | 3 | 5 = 1): Promise<EvaluationRunView> {
	return (await service.handle({
		action: "run.start",
		name: "测试测评",
		taskIds: [task.id],
		profiles: models.map((model, index) => ({
			id: `profile-${index}`,
			provider: model.provider,
			modelId: model.modelId,
			thinkingLevel: "default",
		})),
		samples,
	})) as EvaluationRunView;
}

async function settle(service: EvaluationService, runId: string): Promise<EvaluationRunView> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const run = (await service.handle({ action: "run.get", runId })) as EvaluationRunView;
		if (run.results.every((result) => result.status !== "running" && result.status !== "queued")) return run;
		await new Promise((done) => setTimeout(done, 5));
	}
	throw new Error("Fake evaluation did not finish");
}

describe("durable model evaluation", () => {
	it("publishes supplier thinking and partial answers before completion while masking identity and retaining progress on cancellation", async () => {
		const pending = new Map<string, EvaluationInvocation>();
		let markReady: (() => void) | undefined;
		const ready = new Promise<void>((done) => {
			markReady = done;
		});
		const { service, directory } = await setup(async (request) => {
			pending.set(request.profile.modelId, request);
			request.onPartial("", "fixture private first reasoning");
			if (pending.size === 2) markReady?.();
			return new Promise<EvaluationInvocationResult>(() => {});
		});
		const started = await start(service);
		expect(started.results.every((result) => result.thinking === "" && result.generationPhase === "waiting")).toBe(
			true,
		);
		await ready;
		const waiting = (await service.handle({ action: "run.get", runId: started.id })) as EvaluationRunView;
		expect(
			waiting.results.every(
				(result) =>
					result.status === "running" &&
					result.output === "" &&
					result.artifact === null &&
					result.thinking === "fixture private first reasoning" &&
					result.generationPhase === "thinking",
			),
		).toBe(true);
		for (const request of pending.values())
			request.onPartial("first body paragraph", "fixture private first reasoning");
		const first = (await service.handle({ action: "run.get", runId: started.id })) as EvaluationRunView;
		expect(
			first.results.every(
				(result) =>
					result.status === "running" &&
					result.output === "first body paragraph" &&
					result.generationPhase === "answering",
			),
		).toBe(true);
		for (const request of pending.values())
			request.onPartial("first body paragraph\n\nsecond body paragraph", "fixture private later reasoning");
		const growing = (await service.handle({ action: "run.get", runId: started.id })) as EvaluationRunView;
		expect(growing.results.every((result) => result.output === "first body paragraph\n\nsecond body paragraph")).toBe(
			true,
		);
		expect(first.results.every((result) => result.output === "first body paragraph")).toBe(true);
		expect(growing.results.every((result) => result.thinking === "fixture private later reasoning")).toBe(true);
		for (const result of growing.results)
			for (const field of ["profile", "profileId", "usage", "costUsd", "durationMs", "actualModel"])
				expect(result).not.toHaveProperty(field);
		await service.handle({ action: "run.cancel", runId: started.id });
		const cancelled = await settle(service, started.id);
		for (const request of pending.values()) {
			expect(request.signal.aborted).toBe(true);
			request.onPartial("late ignored body", "late ignored reasoning");
		}
		expect(
			cancelled.results.every(
				(result) =>
					result.status === "cancelled" &&
					result.output === "first body paragraph\n\nsecond body paragraph" &&
					result.thinking === "fixture private later reasoning" &&
					result.generationPhase === undefined,
			),
		).toBe(true);
		const afterLate = (await service.handle({ action: "run.get", runId: started.id })) as EvaluationRunView;
		expect(afterLate.results.map((result) => result.output)).toEqual(
			cancelled.results.map((result) => result.output),
		);
		const persisted = JSON.parse(
			await readFile(join(directory, "model-evaluations", "runs", `${started.id}.json`), "utf8"),
		) as { results: { output: string; thinking: string; status: string }[] };
		expect(
			persisted.results.every(
				(result) =>
					result.status === "cancelled" &&
					result.output === "first body paragraph\n\nsecond body paragraph" &&
					result.thinking === "fixture private later reasoning",
			),
		).toBe(true);
	});

	it("responds before generation, limits concurrency, persists snapshots, and masks identities until scoring", async () => {
		let active = 0;
		let peak = 0;
		const inputs: string[] = [];
		const { service, directory } = await setup(async (request) => {
			active++;
			peak = Math.max(peak, active);
			inputs.push(`${request.task.prompt}\n${request.task.input}`);
			request.onPartial("part", "hidden reasoning");
			await new Promise((done) => setTimeout(done, 20));
			active--;
			return {
				...structuredClone(reply),
				costUsd: request.profile.model.pricing ? reply.costUsd : null,
				actualModel: {
					provider: request.profile.provider,
					modelId: request.profile.modelId,
					responseModel: `${request.profile.modelId}-actual`,
					forwardedThinkingLevel: null,
					providerThinkingLevel: null,
				},
			};
		});
		const begun = await start(service, 3);
		expect(begun.status).toBe("running");
		expect(begun.results).toHaveLength(6);
		const done = await settle(service, begun.id);
		expect(peak).toBe(2);
		expect(inputs).toEqual(Array(6).fill("Draw a bicycle.\nfixed fixture"));
		for (const result of done.results) {
			expect(result.status).toBe("completed");
			expect(result).not.toHaveProperty("profile");
			expect(result).not.toHaveProperty("profileId");
			expect(result.thinking).toBe("private reasoning");
			expect(result).not.toHaveProperty("durationMs");
			expect(result).not.toHaveProperty("usage");
			expect(result).not.toHaveProperty("costUsd");
			expect(result).not.toHaveProperty("actualModel");
		}
		expect(done).not.toHaveProperty("profiles");
		const persisted = JSON.parse(
			await readFile(join(directory, "model-evaluations", "runs", `${begun.id}.json`), "utf8"),
		);
		expect(persisted.tasks[0].version).toBe(1);
		expect(persisted.profiles[0].model.name).toBe("模型一");
		expect(persisted.results[0].thinking).toBe("private reasoning");
		const group = done.groups[0];
		const rated = (await service.handle({
			action: "run.reveal",
			runId: done.id,
			taskId: task.id,
			sample: 1,
			mode: "score",
			ratings: Object.fromEntries(
				group.resultIds.map((id) => [id, { scores: { structure: 4, clarity: 3, visual: 5 }, note: "说明" }]),
			),
		})) as EvaluationRunView;
		expect(
			rated.results
				.filter((result) => result.sample === 1)
				.every((result) => result.profile && result.rating && result.usage),
		).toBe(true);
		expect(rated.results.filter((result) => result.sample !== 1).every((result) => !result.profile)).toBe(true);
	});

	it("keeps anonymous ordering stable after reload; skip reveals but never fabricates ratings", async () => {
		const { service, directory } = await setup();
		const done = await settle(service, (await start(service)).id);
		const order = done.results.map((result) => result.id);
		await service.close();
		const replacement = new EvaluationService({
			agentDir: directory,
			builtinTasks: [task],
			listModels: async () => models,
			invoke: async () => reply,
		});
		services.push(replacement);
		const restored = (await replacement.handle({ action: "run.get", runId: done.id })) as EvaluationRunView;
		expect(restored.results.map((result) => result.id)).toEqual(order);
		const revealed = (await replacement.handle({
			action: "run.reveal",
			runId: done.id,
			taskId: task.id,
			sample: 1,
			mode: "skip",
		})) as EvaluationRunView;
		expect(revealed.results.every((result) => result.revealed && result.rating === null && result.profile)).toBe(
			true,
		);
		const summaries = await replacement.handle({ action: "run.list" });
		expect(summaries).toEqual([expect.objectContaining({ rated: 0, revealed: 1 })]);
	});

	it("validates every successful score before mutating any result", async () => {
		const { service } = await setup();
		const done = await settle(service, (await start(service)).id);
		await expect(
			service.handle({
				action: "run.reveal",
				runId: done.id,
				taskId: task.id,
				sample: 1,
				mode: "score",
				ratings: { [done.results[0].id]: { scores: { structure: 3, clarity: 4, visual: 5 }, note: "" } },
			}),
		).rejects.toThrow("评分");
		expect(
			((await service.handle({ action: "run.get", runId: done.id })) as EvaluationRunView).results.every(
				(result) => !result.revealed && !result.rating,
			),
		).toBe(true);
		await expect(
			service.handle({
				action: "run.reveal",
				runId: done.id,
				taskId: task.id,
				sample: 1,
				mode: "score",
				ratings: Object.fromEntries(
					done.results.map((result) => [result.id, { scores: { structure: 0, clarity: 2, visual: 3 }, note: "" }]),
				),
			}),
		).rejects.toThrow("1 至 5");
	});

	it("appends to a target count and retains failed originals on retry", async () => {
		let count = 0;
		const { service } = await setup(async () => {
			count++;
			return count === 1
				? { ...reply, text: "partial failed output", stopReason: "error", error: "fake provider rejected" }
				: reply;
		});
		const done = await settle(service, (await start(service)).id);
		const failed = done.results.find((result) => result.status === "failed");
		expect(failed?.output).toBe("partial failed output");
		const appended = (await service.handle({
			action: "run.append",
			runId: done.id,
			samples: 3,
		})) as EvaluationRunView;
		expect(appended.results).toHaveLength(6);
		await expect(service.handle({ action: "run.append", runId: done.id, samples: 3 })).rejects.toThrow("大于当前");
		await settle(service, done.id);
		const retried = (await service.handle({
			action: "run.retry",
			runId: done.id,
			resultId: failed?.id ?? "",
		})) as EvaluationRunView;
		expect(retried.results).toHaveLength(7);
		for (const result of done.results) {
			expect(retried.results.find((entry) => entry.id === result.id)?.anonymousLabel).toBe(result.anonymousLabel);
		}
		const finished = await settle(service, done.id);
		expect(finished.results.find((result) => result.id === failed?.id)?.status).toBe("failed");
		expect(finished.results.find((result) => result.retryOf === failed?.id)?.status).toBe("completed");
		expect(count).toBe(7);
	});

	it("cancels queued and running calls, keeps partial answers, and returns without waiting for a hung provider", async () => {
		const { service } = await setup(async (request) => {
			request.onPartial("retained partial", "private thinking");
			return new Promise<EvaluationInvocationResult>(() => {});
		});
		const begun = await start(service, 3);
		await service.handle({ action: "run.cancel", runId: begun.id });
		const done = await settle(service, begun.id);
		expect(done.status).toBe("cancelled");
		expect(done.results.every((result) => result.status === "cancelled")).toBe(true);
		expect(done.results.some((result) => result.output === "retained partial")).toBe(true);
	});

	it("times out a hung model and restores interrupted work after a process restart", async () => {
		const { service, directory } = await setup(async (request) => {
			request.onPartial("timeout partial", "reasoning");
			return new Promise<EvaluationInvocationResult>(() => {});
		}, 20);
		const done = await settle(service, (await start(service)).id);
		expect(done.results.every((result) => result.status === "failed" && result.output === "timeout partial")).toBe(
			true,
		);
		const store = new EvaluationStore(directory);
		const record = store.getRun(done.id);
		record.status = "running";
		record.results[0].status = "running";
		record.results[1].status = "queued";
		store.saveRun(record);
		const restored = new EvaluationStore(directory).getRun(done.id);
		expect(restored.status).toBe("interrupted");
		expect(restored.results.every((result) => result.status === "interrupted")).toBe(true);
		expect(restored.results[0].output).toBe("timeout partial");
	});

	it("copies custom tasks with independent versions and rejects builtin mutation and unsupported model effort", async () => {
		const { service } = await setup();
		await expect(service.handle({ action: "task.save", task })).rejects.toThrow("复制");
		const custom = (await service.handle({
			action: "task.save",
			task: { ...task, id: "my-task" },
		})) as EvaluationTask;
		expect(custom.builtin).toBe(false);
		expect(custom.version).toBe(1);
		expect(
			(
				(await service.handle({
					action: "task.save",
					task: { ...custom, prompt: "Changed prompt" },
				})) as EvaluationTask
			).version,
		).toBe(2);
		const request: EvaluationRequest = {
			action: "run.start",
			name: "bad",
			samples: 1,
			taskIds: [task.id],
			profiles: [
				{ id: "bad-profile", provider: models[1].provider, modelId: models[1].modelId, thinkingLevel: "high" },
			],
		};
		await expect(service.handle(request)).rejects.toThrow("档位");
		await expect(service.handle({ ...request, profiles: [] })).rejects.toThrow("1 至 12");
	});

	it("measures model generation independently of checker execution", async () => {
		const { service } = await setup(
			async () => reply,
			1000,
			async () => {
				await new Promise((done) => setTimeout(done, 60));
				return { artifact: null, checks: [] };
			},
		);
		const finished = await settle(service, (await start(service)).id);
		const revealed = (await service.handle({
			action: "run.reveal",
			runId: finished.id,
			taskId: task.id,
			sample: 1,
			mode: "skip",
		})) as EvaluationRunView;
		expect(
			revealed.results.every(
				(result) => result.durationMs !== null && result.durationMs !== undefined && result.durationMs < 50,
			),
		).toBe(true);
	});

	it("exposes checking phase while preserving collected thinking and removes phase for completed results", async () => {
		let markChecking: (() => void) | undefined;
		let releaseChecking: (() => void) | undefined;
		let count = 0;
		const checkingStarted = new Promise<void>((done) => {
			markChecking = done;
		});
		const checkerGate = new Promise<void>((done) => {
			releaseChecking = done;
		});
		const { service } = await setup(
			async () => reply,
			1000,
			async () => {
				count++;
				if (count === 2) markChecking?.();
				await checkerGate;
				return { artifact: null, checks: [] };
			},
		);
		const begun = await start(service);
		await checkingStarted;
		const checking = (await service.handle({ action: "run.get", runId: begun.id })) as EvaluationRunView;
		expect(
			checking.results.every(
				(result) =>
					result.status === "running" &&
					result.generationPhase === "checking" &&
					result.output === reply.text &&
					result.thinking === reply.thinking,
			),
		).toBe(true);
		expect(checking.results.every((result) => result.profile === undefined && result.usage === undefined)).toBe(true);
		releaseChecking?.();
		const complete = await settle(service, begun.id);
		expect(
			complete.results.every(
				(result) =>
					result.status === "completed" &&
					result.generationPhase === undefined &&
					result.thinking === reply.thinking,
			),
		).toBe(true);
	});
});
