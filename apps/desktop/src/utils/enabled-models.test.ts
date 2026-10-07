import assert from "node:assert/strict";
import { test } from "node:test";
import {
	filterProvidersByEnabledModels,
	isModelMarkedInUse,
	nextEnabledModelsAfterToggle,
	parseEnabledModels,
} from "./enabled-models.ts";

const groups = [
	{
		id: "deepseek",
		models: [
			{ id: "deepseek-v4-flash", name: "DeepSeek V4.1 Flash" },
			{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
		],
	},
	{
		id: "github-copilot",
		models: [{ id: "claude-fable-5", name: "Claude Fable 5" }],
	},
];

test("parseEnabledModels: null/undefined/非数组 → null；有效字符串保留", () => {
	assert.equal(parseEnabledModels(undefined), null);
	assert.equal(parseEnabledModels(null), null);
	assert.equal(parseEnabledModels("x"), null);
	assert.deepEqual(parseEnabledModels(["a/b", "", 1, "c/d"]), ["a/b", "c/d"]);
	assert.deepEqual(parseEnabledModels([]), []);
});

test("未配置时全部视为使用中；有 allowlist 时仅命中项勾选", () => {
	assert.equal(isModelMarkedInUse("deepseek", "deepseek-v4-flash", null), true);
	assert.equal(isModelMarkedInUse("deepseek", "deepseek-v4-flash", ["deepseek/deepseek-v4-pro"]), false);
	assert.equal(isModelMarkedInUse("deepseek", "deepseek-v4-pro", ["deepseek/deepseek-v4-pro"]), true);
	assert.equal(isModelMarkedInUse("deepseek", "deepseek-v4-pro", ["deepseek-v4-pro:high"]), true);
});

test("取消一项后写入剩余 allowlist；再勾回全部则清除为 null", () => {
	const afterUncheck = nextEnabledModelsAfterToggle(groups, null, "deepseek", "deepseek-v4-flash", false);
	assert.deepEqual(afterUncheck, ["deepseek/deepseek-v4-pro", "github-copilot/claude-fable-5"]);

	const afterRecheck = nextEnabledModelsAfterToggle(
		groups,
		afterUncheck,
		"deepseek",
		"deepseek-v4-flash",
		true,
	);
	assert.equal(afterRecheck, null);
});

test("全部取消 → 空数组；空数组过滤结果为空列表", () => {
	let current: string[] | null = null;
	for (const group of groups) {
		for (const model of group.models) {
			current = nextEnabledModelsAfterToggle(groups, current, group.id, model.id, false);
		}
	}
	assert.deepEqual(current, []);
	assert.deepEqual(filterProvidersByEnabledModels(groups, current), []);
});

test("filterProvidersByEnabledModels: null 原样；allowlist 只留命中供应商", () => {
	assert.equal(filterProvidersByEnabledModels(groups, null).length, 2);
	const filtered = filterProvidersByEnabledModels(groups, ["github-copilot/claude-fable-5"]);
	assert.equal(filtered.length, 1);
	assert.equal(filtered[0]?.id, "github-copilot");
	assert.equal(filtered[0]?.models.length, 1);
});
