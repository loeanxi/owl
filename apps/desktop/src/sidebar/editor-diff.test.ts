import assert from "node:assert/strict";
import { test } from "node:test";
import { editorDiffMarks } from "./editor-diff.ts";

const GIT_HEADER = "diff --git a/x.ts b/x.ts\nindex 111..222 100644\n--- a/x.ts\n+++ b/x.ts\n";

function hunkBody(oldStart: number, newStart: number, body: string): string {
	return `@@ -${oldStart},${body.split("\n").length} +${newStart},${body.split("\n").length} @@\n${body}`;
}

function hunk(oldStart: number, newStart: number, body: string): string {
	return `${GIT_HEADER}${hunkBody(oldStart, newStart, body)}`;
}

test("add lines carry new-file line numbers", () => {
	const marks = editorDiffMarks(hunk(3, 3, " const a = 1;\n+const b = 2;\n+const c = 3;\n const d = 4;"));
	assert.deepEqual(marks.hunks, [{ addLines: [4, 5], dels: [] }]);
	assert.equal(marks.firstLine, 4);
});

test("del run between context lines anchors at the following line", () => {
	const marks = editorDiffMarks(hunk(3, 3, " const a = 1;\n-const b = 2;\n-const b2 = 22;\n const c = 3;"));
	assert.deepEqual(marks.hunks, [{ addLines: [], dels: [{ atLine: 4, lines: ["const b = 2;", "const b2 = 22;"] }] }]);
	assert.equal(marks.firstLine, 4);
});

test("del run before an add anchors at the added line", () => {
	const marks = editorDiffMarks(hunk(3, 3, " const a = 1;\n-const b = 2;\n+const b = 20;\n const c = 3;"));
	assert.deepEqual(marks.hunks, [{ addLines: [4], dels: [{ atLine: 4, lines: ["const b = 2;"] }] }]);
});

test("leading dels anchor at the first kept line of the hunk", () => {
	const marks = editorDiffMarks(hunk(5, 5, "-const a = 1;\n-const a2 = 11;\n const b = 2;"));
	assert.deepEqual(marks.hunks, [{ addLines: [], dels: [{ atLine: 5, lines: ["const a = 1;", "const a2 = 11;"] }] }]);
});

test("trailing dels anchor one past the last new-file line of the hunk", () => {
	const marks = editorDiffMarks(hunk(3, 3, " const a = 1;\n-const b = 2;\n-const b2 = 22;"));
	assert.deepEqual(marks.hunks, [{ addLines: [], dels: [{ atLine: 4, lines: ["const b = 2;", "const b2 = 22;"] }] }]);
});

test("pure-deletion hunk anchors at its new start", () => {
	const marks = editorDiffMarks(hunk(5, 5, "-const a = 1;\n-const a2 = 11;"));
	assert.deepEqual(marks.hunks, [{ addLines: [], dels: [{ atLine: 5, lines: ["const a = 1;", "const a2 = 11;"] }] }]);
});

test("multiple hunks stay in order and firstLine points at the first change", () => {
	const text = `${GIT_HEADER}${hunkBody(2, 2, "+const a = 1;\n const b = 2;")}\n${hunkBody(10, 12, " const c = 3;\n-const d = 4;")}`;
	const marks = editorDiffMarks(text);
	assert.equal(marks.hunks.length, 2);
	assert.deepEqual(marks.hunks[0], { addLines: [2], dels: [] });
	assert.deepEqual(marks.hunks[1], { addLines: [], dels: [{ atLine: 13, lines: ["const d = 4;"] }] });
	assert.equal(marks.firstLine, 2);
});

test("no diff content yields empty marks", () => {
	assert.deepEqual(editorDiffMarks("没有差异"), { hunks: [], firstLine: undefined });
	assert.deepEqual(editorDiffMarks(""), { hunks: [], firstLine: undefined });
});
