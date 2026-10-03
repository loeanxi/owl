import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser } from "linkedom";
import type { EvaluationProfile, EvaluationResultView, EvaluationRunView } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import { evaluationStatistics, groupResults, isolatedPreview, profileKey, selectProfile } from "./evaluation-model.ts";

const profile: EvaluationProfile = {
	id: "profile-a", provider: "fixture", modelId: "model", thinkingLevel: "default", maxTokens: 8192, timeoutMs: 1000,
	model: { provider: "fixture", modelId: "model", name: "Fixture model", sourceName: "Fixture", supportedThinkingLevels: ["default", "high"], contextWindow: 32768, maxTokens: 8192, pricing: null },
};

function result(id: string, overrides: Partial<EvaluationResultView> = {}): EvaluationResultView {
	return { id, taskId: "G01", sample: 1, attempt: 1, anonymousLabel: "A", revealed: true, profile, status: "completed", output: "", thinking: "", artifact: null, checks: [{ id: "format", label: "Format", status: "passed", detail: "Valid" }], error: null, durationMs: 1000, costUsd: null, usage: null, rating: null, retryOf: null, ...overrides };
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
	assert.deepEqual(stats[0].criterionStats.map((item) => ({ id: item.id, total: item.total, count: item.count, sampleCount: item.sampleCount })), [{ id: "r1", total: 4, count: 1, sampleCount: 2 }]);
	assert.equal(stats[0].durationCount, 2);
	assert.equal(stats[0].durationTotal, 3000);
	assert.equal(stats[0].costCount, 1);
	assert.equal(stats[0].costTotal, 0.12);
	assert.deepEqual(evaluationStatistics(run([result("a")]), "html"), []);
});

test("summary keeps each scoring axis separate and never mixes SVG, JSON or custom rules with the same label", () => {
	const fixture = run([]);
	const svgRubric = [
		{ id: "structure", label: "结构关系", description: "检查形状连接与空间关系。" },
		{ id: "action", label: "动作表达", description: "检查骑车动作。" },
		{ id: "clarity", label: "视觉清晰度", description: "检查构图与辨识度。" },
	];
	const svgTask = { ...fixture.tasks[0], rubric: svgRubric };
	const sameStandardTask = { ...svgTask, id: "G06" };
	const jsonTask = { ...svgTask, id: "G07", outputType: "json" as const, rubric: [
		{ id: "relation", label: "关系判断", description: "检查最终颜色与可见数量。" },
		{ id: "transform", label: "变换理解", description: "检查defs/use与平移。" },
		{ id: "complete", label: "答案完整性", description: "检查规定JSON字段。" },
	] };
	const customTask = { ...svgTask, id: "U-custom", builtin: false, rubric: svgRubric.map((item) => ({ ...item, description: `我的不同规则：${item.description}` })) };
	fixture.tasks = [svgTask, sameStandardTask, jsonTask, customTask];
	fixture.results = [
		result("svg", { taskId: "G01", rating: { scores: { structure: 5, action: 3, clarity: 4 }, note: "" } }),
		result("svg-again", { taskId: "G06", rating: { scores: { structure: 1, action: 5, clarity: 2 }, note: "" } }),
		result("json", { taskId: "G07", rating: { scores: { relation: 1, transform: 2, complete: 5 }, note: "" } }),
		result("custom", { taskId: "U-custom", rating: { scores: { structure: 2, action: 4, clarity: 1 }, note: "" } }),
		result("ungraded", { taskId: "G01", rating: null, durationMs: null, costUsd: null }),
		result("anonymous", { taskId: "G01", revealed: false, rating: { scores: { structure: 5, action: 5, clarity: 5 }, note: "" } }),
		result("failed", { taskId: "G01", status: "failed", checks: [], rating: null }),
	];
	const stats = evaluationStatistics(fixture, "svg")[0];
	assert.equal(stats.count, 6);
	assert.equal(stats.scored, 4);
	assert.equal(stats.costCount, 0);
	assert.equal(stats.criterionStats.length, 9);
	assert.equal(Object.hasOwn(stats, "scoreTotal"), false);
	for (const [id, total] of [["structure", 6], ["action", 8], ["clarity", 6]] as const) {
		const axis = stats.criterionStats.find((item) => item.id === id && item.description === svgRubric.find((item) => item.id === id)?.description);
		assert.ok(axis);
		assert.equal(axis.total, total);
		assert.equal(axis.count, 2);
		assert.equal(axis.sampleCount, 3);
		assert.deepEqual(axis.taskIds, ["G01", "G06"]);
	}
	assert.deepEqual(stats.criterionStats.filter((item) => item.taskIds.includes("G07")).map((item) => ({ id: item.id, mean: item.total / item.count, count: item.count, sampleCount: item.sampleCount })), [
		{ id: "relation", mean: 1, count: 1, sampleCount: 1 },
		{ id: "transform", mean: 2, count: 1, sampleCount: 1 },
		{ id: "complete", mean: 5, count: 1, sampleCount: 1 },
	]);
	assert.deepEqual(stats.criterionStats.filter((item) => item.taskIds.includes("U-custom")).map((item) => ({ id: item.id, mean: item.total / item.count, count: item.count })), [
		{ id: "structure", mean: 2, count: 1 },
		{ id: "action", mean: 4, count: 1 },
		{ id: "clarity", mean: 1, count: 1 },
	]);
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

test("HTML preview preserves form submit handlers while removing outbound actions and enforcing restrictive CSP", () => {
	const parserDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
	Object.defineProperty(globalThis, "DOMParser", { value: DOMParser, configurable: true });
	try {
		const preview = isolatedPreview('<html><head><meta http-equiv="refresh" content="0;url=https://outside.test"><base href="https://outside.test"></head><body><form id="repair-form" action="https://outside.test" target="_top"><input id="device"><button id="submit">Submit</button></form><a id="outside" href="https://outside.test">Outside</a><script>document.getElementById("repair-form").addEventListener("submit",event=>event.preventDefault())</script></body></html>', "html");
		const document = new DOMParser().parseFromString(preview, "text/html");
		assert.equal(document.querySelector("#repair-form")?.tagName, "FORM");
		assert.equal(document.querySelector("#repair-form")?.hasAttribute("action"), false);
		assert.equal(document.querySelector("#repair-form")?.hasAttribute("target"), false);
		assert.ok(document.querySelector("#device"));
		assert.ok(document.querySelector("#submit"));
		assert.match(document.querySelector("script")?.textContent ?? "", /addEventListener\("submit"/);
		assert.equal(document.querySelector("#outside")?.hasAttribute("href"), false);
		assert.match(preview, /form-action 'none'/);
		assert.match(preview, /connect-src 'none'/);
		assert.match(preview, /script-src 'unsafe-inline'/);
		assert.doesNotMatch(preview, /http-equiv="refresh"/);
		assert.match(isolatedPreview('<html><body><svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg></body></html>', "svg"), /script-src 'none'/);
	} finally {
		if (parserDescriptor) Object.defineProperty(globalThis, "DOMParser", parserDescriptor);
		else Reflect.deleteProperty(globalThis, "DOMParser");
	}
});
