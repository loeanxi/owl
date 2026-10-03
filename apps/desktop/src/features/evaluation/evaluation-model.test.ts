import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluationProfile, EvaluationResultView, EvaluationRunView } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import { evaluationStatistics, groupResults, profileKey, selectProfile } from "./evaluation-model.ts";

const profile: EvaluationProfile = {
	id: "profile-a", provider: "fixture", modelId: "model", thinkingLevel: "default", maxTokens: 8192, timeoutMs: 1000,
	model: { provider: "fixture", modelId: "model", name: "Fixture model", sourceName: "Fixture", supportedThinkingLevels: ["default", "high"], contextWindow: 32768, maxTokens: 8192, pricing: null },
};

function result(id: string, overrides: Partial<EvaluationResultView> = {}): EvaluationResultView {
	return { id, taskId: "G01", sample: 1, attempt: 1, anonymousLabel: "A", revealed: true, profile, status: "completed", output: "", artifact: null, checks: [{ id: "format", label: "Format", status: "passed", detail: "Valid" }], error: null, durationMs: 1000, costUsd: null, usage: null, rating: null, retryOf: null, ...overrides };
}

function run(results: EvaluationResultView[]): EvaluationRunView {
	return { id: "fixture-run", name: "Fixture", createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z", status: "completed", samples: 1, profileCount: 1, tasks: [{ id: "G01", version: 1, title: "SVG task", category: "svg", prompt: "Fixture", outputType: "svg", builtin: true, rubric: [{ id: "r1", label: "Quality", description: "" }], checks: [] }], results, groups: [{ taskId: "G01", sample: 1, revealed: true, resultIds: ["b", "a", "retry"] }] };
}

test("revealing profile identity keeps server card order, including retained retry attempts", () => {
	const anonymous = run([result("a", { revealed: false, profile: undefined }), result("b", { revealed: false, profile: undefined }), result("retry", { attempt: 2, retryOf: "b", revealed: false, profile: undefined })]);
	const before = groupResults(anonymous, "G01", 1).map((entry) => entry.id);
	const revealed = run(anonymous.results.map((entry) => ({ ...entry, revealed: true, profile })));
	assert.deepEqual(before, ["b", "a", "retry"]);
	assert.deepEqual(groupResults(revealed, "G01", 1).map((entry) => entry.id), before);
	assert.deepEqual(groupResults(revealed, "G01", 2), []);
});

test("summary excludes anonymous metrics and does not convert unknown cost, unchecked behavior or unscored work into zero", () => {
	const stats = evaluationStatistics(run([
		result("known", { rating: { scores: { r1: 4, r2: 2 }, note: "" }, costUsd: 0.12 }),
		result("unknown", { durationMs: null, checks: [{ id: "behavior", label: "Behavior", status: "unchecked", detail: "No runtime" }] }),
		result("hidden", { revealed: false, profile: undefined, costUsd: 0.50, durationMs: 90_000 }),
		result("failure", { status: "failed", durationMs: 2000, checks: [], error: "Failed" }),
	]), "svg");
	assert.equal(stats.length, 1);
	assert.equal(stats[0].count, 3);
	assert.equal(stats[0].checked, 1);
	assert.equal(stats[0].passed, 1);
	assert.equal(stats[0].unchecked, 2);
	assert.equal(stats[0].failed, 1);
	assert.equal(stats[0].scored, 1);
	assert.equal(stats[0].scoreTotal, 3);
	assert.equal(stats[0].durationCount, 2);
	assert.equal(stats[0].durationTotal, 3000);
	assert.equal(stats[0].costCount, 1);
	assert.equal(stats[0].costTotal, 0.12);
	assert.deepEqual(evaluationStatistics(run([result("a")]), "html"), []);
});

test("zero price remains a known metric and configurations distinguish provider and thinking level", () => {
	const zero = evaluationStatistics(run([result("free", { costUsd: 0 })]), "svg")[0];
	assert.equal(zero.costCount, 1);
	assert.equal(zero.costTotal, 0);
	const high = { ...profile, id: profileKey(profile.provider, profile.modelId, "high"), thinkingLevel: "high" as const };
	assert.notEqual(profileKey("one", "model", "default"), profileKey("two", "model", "default"));
	assert.notEqual(profileKey("one", "model", "default"), profileKey("one", "model", "high"));
	const selected = selectProfile([profile], high, true);
	assert.equal(selected.length, 2);
	assert.equal(selectProfile(selected, high, true).length, 2);
	assert.deepEqual(selectProfile(selected, high, false), [profile]);
});
