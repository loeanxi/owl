import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	EvaluationInvocation,
	EvaluationInvocationResult,
	EvaluationInvoker,
} from "../src/core/evaluation/model.ts";
import { EvaluationService } from "../src/core/evaluation/service.ts";
import { EvaluationStore } from "../src/core/evaluation/store.ts";
import type {
	EvaluationModel,
	EvaluationRun,
	EvaluationRunView,
	EvaluationTask,
} from "../src/core/evaluation/types.ts";

const task: EvaluationTask = {
	id: "policy-fixture",
	version: 1,
	title: "Offline completion policy",
	category: "svg",
	outputType: "svg",
	prompt: "Draw a simple circle.",
	builtin: true,
	rubric: [1, 2, 3].map((id) => ({ id: String(id), label: String(id), description: String(id) })),
	checks: [],
};
const model: EvaluationModel = {
	provider: "offline-policy",
	modelId: "fixture",
	name: "Offline model",
	sourceName: "Offline fixture",
	supportedThinkingLevels: ["default", "high"],
	contextWindow: 1_000_000,
	maxTokens: 384_000,
	pricing: null,
};
const response: EvaluationInvocationResult = {
	text: '<svg xmlns="http://www.w3.org/2000/svg"/>',
	thinking: "collected thoughts",
	usage: null,
	costUsd: null,
	stopReason: "stop",
	error: null,
};
const directories: string[] = [];
const services: EvaluationService[] = [];
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	vi.useRealTimers();
	for (const directory of directories.splice(0)) {
		const absolute = resolve(directory);
		if (!absolute.startsWith(resolve(tmpdir())) || !absolute.includes("owl-evaluation-policy-"))
			throw new Error("Unsafe policy fixture cleanup path");
		await rm(absolute, { recursive: true, force: true });
	}
});
async function fixture(invoke: EvaluationInvoker, listModels = async () => [structuredClone(model)]) {
	const directory = await mkdtemp(join(tmpdir(), "owl-evaluation-policy-"));
	directories.push(directory);
	const service = new EvaluationService({
		agentDir: directory,
		builtinTasks: [task],
		listModels,
		invoke,
		check: async () => ({ artifact: null, checks: [] }),
	});
	services.push(service);
	return { service, directory };
}
async function start(service: EvaluationService) {
	return (await service.handle({
		action: "run.start",
		name: "Policy fixture",
		taskIds: [task.id],
		samples: 1,
		profiles: [{ id: "frozen", provider: model.provider, modelId: model.modelId, thinkingLevel: "high" }],
	})) as EvaluationRunView;
}
async function read(service: EvaluationService, runId: string) {
	return (await service.handle({ action: "run.get", runId })) as EvaluationRunView;
}
async function flush() {
	for (let step = 0; step < 15; step++) await Promise.resolve();
}

describe("completion-prioritized evaluation requests", () => {
	it("uses configured output capacity instead of a common 32768 ceiling", async () => {
		let invoked: EvaluationInvocation | undefined;
		const { service } = await fixture(async (request) => {
			invoked = request;
			return response;
		});
		const run = await start(service);
		await flush();
		expect(invoked?.profile.maxTokens).toBe(384_000);
		expect(invoked?.profile.timeoutMs).toBe(0);
		expect((await read(service, run.id)).results[0]).not.toHaveProperty("requestPolicy");
		const revealed = (await service.handle({
			action: "run.reveal",
			runId: run.id,
			taskId: task.id,
			sample: 1,
			mode: "skip",
		})) as EvaluationRunView;
		expect(revealed.results[0]).toMatchObject({
			requestPolicy: { maxTokens: 384_000, idleTimeoutMs: 120_000, timeoutMs: 0 },
		});
	});

	it("allows continuously growing thinking beyond ten minutes and still obeys manual cancellation", async () => {
		vi.useFakeTimers();
		let invoked: EvaluationInvocation | undefined;
		const { service } = await fixture(async (request) => {
			invoked = request;
			request.onPartial("", "thought");
			return new Promise(() => {});
		});
		const run = await start(service);
		await flush();
		for (let minute = 1; minute <= 12; minute++) {
			await vi.advanceTimersByTimeAsync(60_000);
			invoked?.onPartial("", "thought".repeat(minute + 1));
			expect((await read(service, run.id)).results[0].status).toBe("running");
		}
		invoked?.onPartial("answer after long thinking", "thought".repeat(13));
		await service.handle({ action: "run.cancel", runId: run.id });
		await flush();
		const cancelled = await read(service, run.id);
		expect(invoked?.signal.aborted).toBe(true);
		expect(cancelled.results[0]).toMatchObject({
			status: "cancelled",
			output: "answer after long thinking",
			thinking: "thought".repeat(13),
		});
	});

	it("times out first content when empty snapshots never carry thinking or body", async () => {
		vi.useFakeTimers();
		let invoked: EvaluationInvocation | undefined;
		const { service } = await fixture(async (request) => {
			invoked = request;
			return new Promise(() => {});
		});
		const run = await start(service);
		await flush();
		await vi.advanceTimersByTimeAsync(60_000);
		invoked?.onPartial("", "");
		await vi.advanceTimersByTimeAsync(60_001);
		await flush();
		expect((await read(service, run.id)).results[0]).toMatchObject({ status: "failed", output: "", thinking: "" });
		expect(invoked?.signal.aborted).toBe(true);
	});

	it("resets idle only on new content and ignores duplicate or whitespace-only snapshots", async () => {
		vi.useFakeTimers();
		let invoked: EvaluationInvocation | undefined;
		const { service } = await fixture(async (request) => {
			invoked = request;
			request.onPartial("", "first thought");
			return new Promise(() => {});
		});
		const run = await start(service);
		await flush();
		await vi.advanceTimersByTimeAsync(90_000);
		invoked?.onPartial("body appeared", "first thought");
		await vi.advanceTimersByTimeAsync(90_000);
		invoked?.onPartial("body appeared", "first thought");
		expect((await read(service, run.id)).results[0].status).toBe("running");
		invoked?.onPartial("body appeared   ", "first thought\n");
		await vi.advanceTimersByTimeAsync(30_001);
		await flush();
		const stopped = (await read(service, run.id)).results[0];
		expect(stopped.status).toBe("failed");
		expect(stopped.output).toContain("body appeared");
		expect(stopped.error).not.toMatch(/时间上限|超过时间/);
	});

	it("stops the content watchdog after invocation so checking is not mistaken for idle model output", async () => {
		vi.useFakeTimers();
		let finishChecking: (() => void) | undefined;
		const checked = new Promise<void>((done) => {
			finishChecking = done;
		});
		const { service } = await fixture(async () => response);
		// A separate injected service retains the same normal constructor policy.
		await service.close();
		const directory = directories.at(-1)!;
		const replacement = new EvaluationService({
			agentDir: directory,
			builtinTasks: [task],
			listModels: async () => [model],
			invoke: async () => response,
			check: async () => {
				await checked;
				return { artifact: null, checks: [] };
			},
		});
		services.push(replacement);
		const run = await start(replacement);
		await flush();
		await vi.advanceTimersByTimeAsync(720_000);
		expect((await read(replacement, run.id)).results[0]).toMatchObject({
			status: "running",
			generationPhase: "checking",
		});
		finishChecking?.();
		await flush();
		expect((await read(replacement, run.id)).results[0].status).toBe("completed");
	});

	it("retries a legacy failure with current capacity while preserving its original profile and attempt", async () => {
		const { service, directory } = await fixture(async () => ({ ...response, stopReason: "length" }));
		const initial = await start(service);
		await flush();
		await service.close();
		const store = new EvaluationStore(directory);
		const legacy = store.getRun(initial.id);
		legacy.profiles[0].maxTokens = 32_768;
		legacy.profiles[0].timeoutMs = 600_000;
		delete legacy.results[0].requestPolicy;
		const original = structuredClone(legacy.results[0]);
		const frozenProfile = structuredClone(legacy.profiles[0]);
		store.saveRun(legacy);
		let invoked: EvaluationInvocation | undefined;
		const replacement = new EvaluationService({
			agentDir: directory,
			builtinTasks: [task],
			listModels: async () => [{ ...model, maxTokens: 131_072 }],
			invoke: async (request) => {
				invoked = request;
				return response;
			},
			check: async () => ({ artifact: null, checks: [] }),
		});
		services.push(replacement);
		await replacement.handle({ action: "run.retry", runId: initial.id, resultId: original.id });
		await flush();
		expect(invoked?.profile.maxTokens).toBe(131_072);
		expect(invoked?.profile.thinkingLevel).toBe(frozenProfile.thinkingLevel);
		const saved = JSON.parse(
			await readFile(join(directory, "model-evaluations", "runs", `${initial.id}.json`), "utf8"),
		) as EvaluationRun;
		expect(saved.profiles).toEqual([frozenProfile]);
		expect(saved.results[0]).toEqual(original);
		expect(saved.results[1]).toMatchObject({
			requestPolicy: { maxTokens: 131_072, idleTimeoutMs: 120_000, timeoutMs: 0 },
		});
	});

	it("does not reserve an entire model output window before a legal followup and records its effective context clamp", async () => {
		const calls: EvaluationInvocation[] = [];
		const { service, directory } = await fixture(
			async (request) => {
				calls.push(request);
				return response;
			},
			async () => [{ ...model, contextWindow: 64_000, maxTokens: 64_000 }],
		);
		const initial = await start(service);
		await flush();
		await service.handle({
			action: "conversation.send",
			runId: initial.id,
			resultId: initial.results[0].id,
			prompt: "Please improve the completed artifact.",
		});
		await flush();
		expect(calls).toHaveLength(2);
		expect(calls[1].profile.maxTokens).toBeGreaterThan(32_768);
		expect(calls[1].profile.maxTokens).toBeLessThan(64_000);
		const saved = JSON.parse(
			await readFile(join(directory, "model-evaluations", "runs", `${initial.id}.json`), "utf8"),
		) as EvaluationRun;
		expect(saved.results[0].followups?.[0].requestPolicy?.maxTokens).toBe(calls[1].profile.maxTokens);
		expect(saved.profiles[0].maxTokens).toBe(64_000);
	});

	it("uses the same content idle policy for followups and lets growing thinking complete beyond ten minutes", async () => {
		vi.useFakeTimers();
		let request: EvaluationInvocation | undefined;
		let finish: ((value: EvaluationInvocationResult) => void) | undefined;
		const { service } = await fixture(async (invocation) => {
			if (!invocation.conversation) return response;
			request = invocation;
			invocation.onPartial("", "thought");
			return new Promise((done) => {
				finish = done;
			});
		});
		const initial = await start(service);
		await flush();
		await service.handle({
			action: "conversation.send",
			runId: initial.id,
			resultId: initial.results[0].id,
			prompt: "Please improve it",
		});
		await flush();
		for (let minute = 1; minute <= 12; minute++) {
			await vi.advanceTimersByTimeAsync(60_000);
			request?.onPartial("", "thought".repeat(minute + 1));
			expect((await read(service, initial.id)).results[0].followups[0].status).toBe("running");
		}
		finish?.({ ...response, text: "final followup answer" });
		await flush();
		expect((await read(service, initial.id)).results[0].followups[0]).toMatchObject({
			status: "completed",
			output: "final followup answer",
		});
	});

	it("freezes active call policy even when configured capacity changes before a later request", async () => {
		let current = structuredClone(model);
		let invoked: EvaluationInvocation | undefined;
		const { service, directory } = await fixture(
			async (request) => {
				invoked = request;
				return new Promise(() => {});
			},
			async () => [structuredClone(current)],
		);
		const run = await start(service);
		await flush();
		current = { ...current, maxTokens: 131_072 };
		invoked?.onPartial("still using frozen request", "collected thinking");
		expect(invoked?.profile.maxTokens).toBe(384_000);
		await service.handle({ action: "run.cancel", runId: run.id });
		await flush();
		const saved = JSON.parse(
			await readFile(join(directory, "model-evaluations", "runs", `${run.id}.json`), "utf8"),
		) as EvaluationRun;
		expect(saved.results[0].requestPolicy?.maxTokens).toBe(384_000);
	});
});
