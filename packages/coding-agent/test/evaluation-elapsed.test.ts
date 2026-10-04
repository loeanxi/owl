import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluationRunView } from "../src/core/evaluation/service.ts";
import type {
	EvaluationFollowup,
	EvaluationResult,
	EvaluationResultStatus,
	EvaluationRun,
} from "../src/core/evaluation/types.ts";

const startedAt = "2026-10-04T00:00:00.000Z";
const started = Date.parse(startedAt);
const hiddenFields = ["startedAt", "finishedAt", "durationMs", "usage", "costUsd", "actualModel"];

function followup(overrides: Partial<EvaluationFollowup> = {}): EvaluationFollowup {
	return {
		id: "followup-1",
		prompt: "Continue the answer",
		status: "running",
		output: "",
		thinking: "supplier reasoning",
		generationPhase: "thinking",
		artifact: null,
		checks: [],
		error: "private upstream error",
		startedAt,
		finishedAt: null,
		durationMs: null,
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
		costUsd: 0.0001,
		actualModel: {
			provider: "private-provider",
			modelId: "private-model",
			responseModel: "private-upstream",
			forwardedThinkingLevel: "high",
			providerThinkingLevel: "high",
		},
		...overrides,
	};
}

function result(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
	const { prompt: _prompt, ...turn } = followup();
	return {
		...turn,
		id: "result-1",
		taskId: "task-1",
		sample: 1,
		attempt: 1,
		profileId: "private-profile",
		rating: null,
		retryOf: null,
		followups: [followup()],
		...overrides,
	};
}

function run(entry: EvaluationResult, revealed = false): EvaluationRun {
	return {
		id: "run-1",
		name: "Offline timing projection",
		createdAt: startedAt,
		updatedAt: startedAt,
		status: "running",
		samples: 1,
		tasks: [],
		profiles: [
			{
				id: "private-profile",
				provider: "private-provider",
				modelId: "private-model",
				thinkingLevel: "high",
				maxTokens: 1000,
				timeoutMs: 600_000,
				model: {
					provider: "private-provider",
					modelId: "private-model",
					name: "Private model",
					sourceName: "Private provider",
					supportedThinkingLevels: ["high"],
					contextWindow: 100_000,
					maxTokens: 1000,
					pricing: null,
				},
			},
		],
		results: [entry],
		groups: [{ taskId: entry.taskId, sample: 1, resultIds: [entry.id], revealed }],
	};
}

afterEach(() => vi.restoreAllMocks());

describe("anonymous evaluation elapsed runtime", () => {
	it.each([
		["输出达到长度限制，答案可能不完整", "已达到该次请求的输出额度，回答未完成；新尝试将使用当前完成优先规则。"],
		["模型测评请求超时", "该次请求达到时间上限，已停止；新尝试将使用当前完成优先规则。"],
		["模型测评首包等待超时", "等待期间没有收到新的思考或正文，连接等待已结束；已有内容已保留。"],
		["模型测评内容空闲超时", "等待期间没有收到新的思考或正文，连接等待已结束；已有内容已保留。"],
		["用户取消测评", "已取消"],
		["用户停止追问", "已取消"],
	])("publishes safe information for exact local error %s and retains its original after reveal", (error, safe) => {
		const status = safe === "已取消" ? "cancelled" : "failed";
		const stored = run(result({ status, error, followups: [followup({ status, error })] }));
		const anonymous = evaluationRunView(stored).results[0];
		expect(anonymous.error).toBe(safe);
		expect(anonymous.followups[0].error).toBe(safe);
		expect(anonymous.status).toBe(status);
		expect(anonymous.followups[0].status).toBe(status);
		stored.groups[0].revealed = true;
		const revealed = evaluationRunView(stored).results[0];
		expect(revealed.error).toBe(error);
		expect(revealed.followups[0].error).toBe(error);
	});

	it("does not expose provider errors containing local error substrings, model identities, paths, or credentials", () => {
		for (const error of [
			"输出达到长度限制，答案可能不完整: private-provider/private-model",
			"模型测评请求超时 at C:/private/auth.json key=private-fixture-key",
			"用户停止追问 rejected by private-upstream",
		]) {
			const stored = run(result({ status: "failed", error, followups: [followup({ status: "failed", error })] }));
			const anonymous = evaluationRunView(stored).results[0];
			expect(anonymous.error).toBe("本次生成未完成；揭晓后可查看详细原因");
			expect(anonymous.followups[0].error).toBe("本次追问未完成；揭晓后可查看详细原因");
			stored.groups[0].revealed = true;
			const revealed = evaluationRunView(stored).results[0];
			expect(revealed.error).toBe(error);
			expect(revealed.followups[0].error).toBe(error);
		}
	});

	it("updates initial and followup runtime from one clock snapshot without exposing protected metadata", () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(started + 12_345);
		const stored = run(result({ followups: [followup({ startedAt: "2026-10-04T00:00:05.000Z" })] }));
		const before = structuredClone(stored);
		const first = evaluationRunView(stored).results[0];
		expect(first.elapsedMs).toBe(12_345);
		expect(first.followups[0].elapsedMs).toBe(7_345);
		for (const entry of [first, first.followups[0]]) {
			for (const field of hiddenFields) expect(entry).not.toHaveProperty(field);
			expect(entry.error).not.toContain("private upstream");
		}
		expect(first).not.toHaveProperty("profile");
		expect(first).not.toHaveProperty("profileId");
		clock.mockReturnValue(started + 15_345);
		const later = evaluationRunView(stored).results[0];
		expect(later.elapsedMs).toBe(15_345);
		expect(later.followups[0].elapsedMs).toBe(10_345);
		expect(first.elapsedMs).toBe(12_345);
		expect(stored).toEqual(before);
	});

	it.each<EvaluationResultStatus>(["completed", "failed", "cancelled", "interrupted"])(
		"freezes %s runtime across later queries and falls back to finished timestamps for older records",
		(status) => {
			const clock = vi.spyOn(Date, "now").mockReturnValue(started + 60_000);
			const stored = run(
				result({
					status,
					durationMs: 1567,
					finishedAt: "2026-10-04T00:00:10.000Z",
					followups: [followup({ status, finishedAt: "2026-10-04T00:00:05.000Z" })],
				}),
			);
			const first = evaluationRunView(stored).results[0];
			expect(first.elapsedMs).toBe(1567);
			expect(first.followups[0].elapsedMs).toBe(5000);
			clock.mockReturnValue(started + 3600_000);
			const later = evaluationRunView(stored).results[0];
			expect(later.elapsedMs).toBe(first.elapsedMs);
			expect(later.followups[0].elapsedMs).toBe(first.followups[0].elapsedMs);
		},
	);

	it("keeps queue waiting separate from runtime even if stale timing fields exist", () => {
		vi.spyOn(Date, "now").mockReturnValue(started + 10_000);
		const stale = { status: "queued", startedAt, durationMs: 500 } as const;
		const view = evaluationRunView(run(result({ ...stale, followups: [followup(stale)] }))).results[0];
		expect(view.elapsedMs).toBeNull();
		expect(view.followups[0].elapsedMs).toBeNull();
	});

	it.each([null, "invalid date"])("returns unknown runtime when the start timestamp is %s", (timestamp) => {
		vi.spyOn(Date, "now").mockReturnValue(started + 10_000);
		for (const status of ["running", "failed"] as const) {
			const timing = { status, startedAt: timestamp, durationMs: 500 };
			const view = evaluationRunView(run(result({ ...timing, followups: [followup(timing)] }))).results[0];
			expect(view.elapsedMs).toBeNull();
			expect(view.followups[0].elapsedMs).toBeNull();
		}
	});

	it("clamps clock skew and never projects nonfinite or malformed terminal timings", () => {
		vi.spyOn(Date, "now").mockReturnValue(started - 5000);
		const active = evaluationRunView(run(result())).results[0];
		expect(active.elapsedMs).toBe(0);
		expect(active.followups[0].elapsedMs).toBe(0);
		const invalid = { status: "failed", durationMs: Number.NaN, finishedAt: "invalid date" } as const;
		const ended = evaluationRunView(run(result({ ...invalid, followups: [followup(invalid)] }))).results[0];
		expect(ended.elapsedMs).toBeNull();
		expect(ended.followups[0].elapsedMs).toBeNull();
	});

	it("keeps a completed first answer frozen while its followup runs and restores full metadata after reveal", () => {
		vi.spyOn(Date, "now").mockReturnValue(started + 20_000);
		const stored = run(result({ status: "completed", durationMs: 1500 }));
		const anonymous = evaluationRunView(stored).results[0];
		expect(anonymous.elapsedMs).toBe(1500);
		expect(anonymous.followups[0].elapsedMs).toBe(20_000);
		stored.groups[0].revealed = true;
		const revealed = evaluationRunView(stored).results[0];
		expect(revealed.elapsedMs).toBe(anonymous.elapsedMs);
		expect(revealed.followups[0].elapsedMs).toBe(anonymous.followups[0].elapsedMs);
		expect(revealed.profile?.id).toBe("private-profile");
		for (const entry of [revealed, revealed.followups[0]])
			for (const field of hiddenFields) expect(entry).toHaveProperty(field);
	});
});
