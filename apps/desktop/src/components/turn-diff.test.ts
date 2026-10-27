import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyChip, parseChangedLines, type TurnDiffSummary } from "./turn-diff.ts";

function summary(overrides: Partial<TurnDiffSummary> = {}): TurnDiffSummary {
	return {
		added: 0,
		removed: 0,
		paths: [],
		removedLines: new Set(),
		addedLines: new Set(),
		...overrides,
	};
}

test("unified diff lines are split into added and removed sets", () => {
	const diff = [
		"diff --git a/src/app.ts b/src/app.ts",
		"--- a/src/app.ts",
		"+++ b/src/app.ts",
		"@@ -1,4 +1,4 @@",
		" const before = 1;",
		"-const removed = 2;",
		"+const added = 3;",
		" const after = 4;",
	].join("\n");
	const parsed = parseChangedLines(diff);
	assert.deepEqual([...parsed.removed], ["const removed = 2;"]);
	assert.deepEqual([...parsed.added], ["const added = 3;"]);
});

test("diff headers and hunk markers never count as changed lines", () => {
	const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -0,0 +1 @@", "+real change"].join("\n");
	const parsed = parseChangedLines(diff);
	assert.deepEqual([...parsed.removed], []);
	assert.deepEqual([...parsed.added], ["real change"]);
});

test("a chip matching a removed line is tinted removed", () => {
	const state = summary({ removedLines: new Set(["v=20260926-4"]) });
	assert.equal(classifyChip("v=20260926-4", state), "removed");
});

test("a chip matching an added line is tinted added", () => {
	const state = summary({ addedLines: new Set(["const billing = true"]) });
	assert.equal(classifyChip("const billing = true", state), "added");
});

test("a chip that is only part of a changed line still picks that line's tint", () => {
	// 集合里存的是归一化后的行内容（去引号、小写）。
	const state = summary({ removedLines: new Set(["v=20260926-4"]) });
	assert.equal(classifyChip("v=20260926-4", state), "removed");
});

test("a short identifier that is a word in a changed line picks that line's tint", () => {
	// billing 落在被新增的那一行的词边界内 —— 与 Claude 一样，chip 指向被改的那行就染色。
	const state = summary({ addedLines: new Set(["const billing = true;"]) });
	assert.equal(classifyChip("billing", state), "added");
});

test("an identifier that only appears as part of a longer word is not tinted", () => {
	// billing 不是 legacybillingconfig 的词，不能因为包含就染色。
	const state = summary({ addedLines: new Set(["const legacybillingconfig = true;"]) });
	assert.equal(classifyChip("billing", state), undefined);
});

test("a long fragment of a changed line still picks that line's tint", () => {
	const state = summary({ removedLines: new Set(["const legacybillingconfig = true;"]) });
	assert.equal(classifyChip("legacybillingconfig", state), "removed");
});

test("a chip pointing at a changed file but no changed line is tinted modified", () => {
	const state = summary({ paths: ["src/admin/style.css"] });
	assert.equal(classifyChip("style.css", state), "modified");
});

test("an unrelated chip keeps the default styling", () => {
	const state = summary({ paths: ["src/admin/style.css"], removedLines: new Set(["gone"]) });
	assert.equal(classifyChip("billing", state), undefined);
});

test("removal wins over addition when a chip matches both", () => {
	const state = summary({
		removedLines: new Set(["same"]),
		addedLines: new Set(["same"]),
	});
	assert.equal(classifyChip("same", state), "removed");
});
