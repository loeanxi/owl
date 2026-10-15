import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	EvaluationInvocation,
	EvaluationInvocationResult,
	EvaluationInvoker,
} from "../src/core/evaluation/model.ts";
import {
	EvaluationService,
	type EvaluationServiceOptions,
	isTransientEvaluationError,
} from "../src/core/evaluation/service.ts";
import { EvaluationStore } from "../src/core/evaluation/store.ts";
import type {
	EvaluationBootstrap,
	EvaluationModel,
	EvaluationRequest,
	EvaluationRunSummary,
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
	extra: Partial<EvaluationServiceOptions> = {},
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
		...extra,
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

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("evaluation queue and lifecycle", () => {
	it("retries only the newest attempt and refuses new attempts in a revealed group", async () => {
		let count = 0;
		const { service } = await setup(async () => {
			count++;
			return count === 1
				? { ...structuredClone(reply), stopReason: "error", error: "fake provider rejected" }
				: structuredClone(reply);
		});
		const done = await settle(service, (await start(service)).id);
		const failed = done.results.find((result) => result.status === "failed");
		await service.handle({ action: "run.retry", runId: done.id, resultId: failed?.id ?? "" });
		await expect(service.handle({ action: "run.retry", runId: done.id, resultId: failed?.id ?? "" })).rejects.toThrow(
			"最新",
		);
		const finished = await settle(service, done.id);
		const newest = finished.results.find((result) => result.retryOf === failed?.id);
		expect(newest?.attempt).toBe(2);
		await service.handle({ action: "run.reveal", runId: done.id, taskId: task.id, sample: 1, mode: "skip" });
		await expect(service.handle({ action: "run.retry", runId: done.id, resultId: newest?.id ?? "" })).rejects.toThrow(
			"已揭晓",
		);
	});

	it("continues cancelled results as new attempts", async () => {
		let hang = true;
		const { service } = await setup(async () =>
			hang ? new Promise<EvaluationInvocationResult>(() => {}) : structuredClone(reply),
		);
		const begun = await start(service);
		await service.handle({ action: "run.cancel", runId: begun.id });
		await settle(service, begun.id);
		hang = false;
		const resumed = (await service.handle({ action: "run.resume", runId: begun.id })) as EvaluationRunView;
		expect(resumed.results).toHaveLength(4);
		const finished = await settle(service, begun.id);
		expect(finished.status).toBe("completed");
		expect(
			finished.results.filter((result) => result.status === "completed").map((result) => result.attempt),
		).toEqual([2, 2]);
		await expect(service.handle({ action: "run.resume", runId: begun.id })).rejects.toThrow("没有");
	});

	it("focused views carry answer content for one task sample only", async () => {
		const { service } = await setup();
		const done = await settle(service, (await start(service, 3)).id);
		expect(done.results.every((result) => result.output === reply.text && !result.contentOmitted)).toBe(true);
		const focused = (await service.handle({
			action: "run.get",
			runId: done.id,
			focus: { taskId: task.id, sample: 2 },
		})) as EvaluationRunView;
		for (const result of focused.results) {
			expect(result.status).toBe("completed");
			if (result.sample === 2) {
				expect(result.output).toBe(reply.text);
				expect(result.contentOmitted).toBeUndefined();
			} else {
				expect(result).toMatchObject({ output: "", thinking: "", artifact: null, contentOmitted: true });
			}
		}
		const none = (await service.handle({ action: "run.get", runId: done.id, focus: null })) as EvaluationRunView;
		expect(none.results.every((result) => result.contentOmitted === true)).toBe(true);
	});

	it("repeats transiently failed calls from scratch, including streams cut off midway, within the retry budget", async () => {
		const calls = new Map<string, number>();
		const restartedFrom: string[] = [];
		const { service } = await setup(
			async (request) => {
				const count = (calls.get(request.profile.modelId) ?? 0) + 1;
				calls.set(request.profile.modelId, count);
				if (request.profile.modelId === "model-one") {
					if (count === 1) throw new Error("429 Too Many Requests");
					if (count === 2) {
						request.onPartial("", "long reasoning");
						throw new Error("网关内部错误：terminated");
					}
					const [summary] = (await service.handle({ action: "run.list" })) as EvaluationRunSummary[];
					const view = (await service.handle({
						action: "run.get",
						runId: summary.id,
						focus: { taskId: task.id, sample: 1 },
					})) as EvaluationRunView;
					restartedFrom.push(view.results.map((result) => result.thinking).join("|"));
					return structuredClone(reply);
				}
				request.onPartial("partial body", "");
				return { ...structuredClone(reply), text: "partial body", stopReason: "error", error: "503 overloaded" };
			},
			1000,
			undefined,
			{ transientRetryDelaysMs: [0, 0] },
		);
		const done = await settle(service, (await start(service)).id);
		const revealed = (await service.handle({
			action: "run.reveal",
			runId: done.id,
			taskId: task.id,
			sample: 1,
			mode: "skip",
		})) as EvaluationRunView;
		const byModel = (id: string) => revealed.results.find((result) => result.profile?.modelId === id);
		expect(byModel("model-one")?.status).toBe("completed");
		expect(restartedFrom).toHaveLength(1);
		expect(restartedFrom[0]).not.toContain("long reasoning");
		expect(byModel("model-two")).toMatchObject({ status: "failed", output: "partial body" });
		expect(calls.get("model-one")).toBe(3);
		expect(calls.get("model-two")).toBe(3);
		expect(isTransientEvaluationError("fake provider rejected")).toBe(false);
		expect(isTransientEvaluationError("fetch failed")).toBe(true);
		expect(
			isTransientEvaluationError(
				"Connect error unavailable: Cursor GOAWAY (errorCode=0): upstream connection closed",
			),
		).toBe(true);
		expect(isTransientEvaluationError("上游流中断，费用待核对：terminated")).toBe(true);
		expect(isTransientEvaluationError("输出达到长度限制，答案可能不完整")).toBe(false);
	});

	it("draws again when a call ends normally without any answer, then reports the empty answer once the budget is spent", async () => {
		const calls = new Map<string, number>();
		const { service } = await setup(
			async (request) => {
				const count = (calls.get(request.profile.modelId) ?? 0) + 1;
				calls.set(request.profile.modelId, count);
				if (request.profile.modelId === "model-one" && count > 1) return structuredClone(reply);
				request.onPartial("", "planning only");
				return { ...structuredClone(reply), text: "", thinking: "planning only" };
			},
			1000,
			undefined,
			{ transientRetryDelaysMs: [0] },
		);
		const done = await settle(service, (await start(service)).id);
		const revealed = (await service.handle({
			action: "run.reveal",
			runId: done.id,
			taskId: task.id,
			sample: 1,
			mode: "skip",
		})) as EvaluationRunView;
		const byModel = (id: string) => revealed.results.find((result) => result.profile?.modelId === id);
		expect(byModel("model-one")?.status).toBe("completed");
		expect(byModel("model-two")).toMatchObject({ status: "failed", error: "模型未输出答案" });
		expect(calls.get("model-one")).toBe(2);
		expect(calls.get("model-two")).toBe(2);
	});

	it("limits calls per provider while other providers keep running", async () => {
		const providerModels: EvaluationModel[] = ["p1", "p2"].flatMap((provider) =>
			["m1", "m2"].map((modelId) => ({ ...models[0], provider, modelId, name: `${provider}-${modelId}` })),
		);
		const active = new Map<string, number>();
		const peaks = new Map<string, number>();
		let total = 0;
		let peak = 0;
		const { service } = await setup(
			async (request) => {
				const provider = request.profile.provider;
				const now = (active.get(provider) ?? 0) + 1;
				active.set(provider, now);
				peaks.set(provider, Math.max(peaks.get(provider) ?? 0, now));
				total++;
				peak = Math.max(peak, total);
				await pause(20);
				active.set(provider, (active.get(provider) ?? 1) - 1);
				total--;
				return structuredClone(reply);
			},
			1000,
			undefined,
			{ listModels: async () => structuredClone(providerModels), concurrency: 4, providerConcurrency: 1 },
		);
		const begun = (await service.handle({
			action: "run.start",
			name: "providers",
			taskIds: [task.id],
			samples: 1,
			profiles: providerModels.map((model, index) => ({
				id: `p-${index}`,
				provider: model.provider,
				modelId: model.modelId,
				thinkingLevel: "default",
			})),
		})) as EvaluationRunView;
		await settle(service, begun.id);
		expect(peaks.get("p1")).toBe(1);
		expect(peaks.get("p2")).toBe(1);
		expect(peak).toBe(2);
	});

	it("cancelling an evaluation also stops its queued follow-ups", async () => {
		let followupCalls = 0;
		const { service } = await setup(
			async (request) => {
				if (request.conversation) followupCalls++;
				if (request.profile.modelId === "model-two") return new Promise<EvaluationInvocationResult>(() => {});
				return structuredClone(reply);
			},
			1000,
			undefined,
			{ concurrency: 1 },
		);
		const begun = await start(service);
		let answered: EvaluationRunView | undefined;
		for (let attempt = 0; attempt < 100 && !answered; attempt++) {
			const current = (await service.handle({ action: "run.get", runId: begun.id })) as EvaluationRunView;
			const statuses = current.results.map((result) => result.status);
			if (statuses.includes("completed") && statuses.includes("running")) answered = current;
			else await pause(5);
		}
		const completed = answered?.results.find((result) => result.status === "completed");
		const sent = (await service.handle({
			action: "conversation.send",
			runId: begun.id,
			resultId: completed?.id ?? "",
			prompt: "再改一下",
		})) as EvaluationRunView;
		expect(sent.results.find((result) => result.id === completed?.id)?.followups[0]?.status).toBe("queued");
		await expect(service.handle({ action: "run.delete", runId: begun.id })).rejects.toThrow("取消");
		await service.handle({ action: "run.cancel", runId: begun.id });
		const cancelled = await settle(service, begun.id);
		expect(cancelled.results.find((result) => result.id === completed?.id)?.followups[0]?.status).toBe("cancelled");
		await pause(20);
		expect(followupCalls).toBe(0);
	});

	it("sets aside an unreadable run file and deletes runs and custom tasks on request", async () => {
		const { service, directory } = await setup();
		const done = await settle(service, (await start(service)).id);
		await writeFile(join(directory, "model-evaluations", "runs", "broken.json"), "{not json");
		const reloaded = new EvaluationService({
			agentDir: directory,
			builtinTasks: [task],
			listModels: async () => models,
			invoke: async () => reply,
		});
		services.push(reloaded);
		const boot = (await reloaded.handle({ action: "bootstrap" })) as EvaluationBootstrap;
		expect(boot.warnings).toHaveLength(1);
		expect(boot.runs.map((run) => run.id)).toEqual([done.id]);
		const names = await readdir(join(directory, "model-evaluations", "runs"));
		expect(names.some((name) => name.startsWith("broken.json.corrupt-"))).toBe(true);
		const remaining = (await reloaded.handle({ action: "run.delete", runId: done.id })) as EvaluationRunSummary[];
		expect(remaining).toEqual([]);
		await expect(reloaded.handle({ action: "run.get", runId: done.id })).rejects.toThrow("不存在");
		await expect(reloaded.handle({ action: "task.delete", taskId: task.id })).rejects.toThrow("内置");
		await reloaded.handle({ action: "task.save", task: { ...task, id: "my-task" } });
		const tasks = (await reloaded.handle({ action: "task.delete", taskId: "my-task" })) as EvaluationTask[];
		expect(tasks.map((entry) => entry.id)).toEqual([task.id]);
	});
});
