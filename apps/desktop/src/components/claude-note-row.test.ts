import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_NOTE_MAX_CHARS, claudeNoteIsSingleLine, claudeNoteLabel } from "./claude-narration.ts";

test("a note shows its first line, like Claude's note cell", () => {
	// Claude 的 ie() 说明行：label = 首行正文（是「行」，不是「句」）。
	assert.equal(claudeNoteLabel("现状摸清了。先写后端 billing 领域。"), "现状摸清了。先写后端 billing 领域。");
	assert.equal(claudeNoteLabel("第一行\n第二行\n第三行"), "第一行");
});

test("the note label drops markdown decoration", () => {
	assert.equal(claudeNoteLabel("**加粗**的 `代码` 一行"), "加粗的 代码 一行");
	assert.equal(claudeNoteLabel("- 列表项"), "列表项");
	assert.equal(claudeNoteLabel("# 标题"), "标题");
});

test("the note label is truncated at Claude's 200 characters", () => {
	const long = "x".repeat(500);
	const label = claudeNoteLabel(long);
	assert.equal(label.length, CLAUDE_NOTE_MAX_CHARS + 1);
	assert.ok(label.endsWith("…"));
});

test("an empty note has no label", () => {
	assert.equal(claudeNoteLabel(""), "");
	assert.equal(claudeNoteLabel("   \n  "), "");
});

test("a single-line note is suppressed entirely, like Claude's cellSuppressed", () => {
	// Claude 的 ie()：说明只有一行（首行即全部内容）时整行不渲染。
	assert.equal(claudeNoteIsSingleLine("先看一下目录结构。"), true);
	assert.equal(claudeNoteIsSingleLine("第一行\n第二行"), false);
	assert.equal(claudeNoteIsSingleLine(""), false);
});
