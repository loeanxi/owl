import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeGroupPhrase, claudeToolCategory } from "./claude-tool-phrases.ts";

test("owl's tool names map onto Claude's categories", () => {
	assert.equal(claudeToolCategory("read"), "read");
	assert.equal(claudeToolCategory("write"), "write");
	assert.equal(claudeToolCategory("edit"), "edit");
	assert.equal(claudeToolCategory("grep"), "grep");
	// owl 的 find 就是「按 glob 模式找文件」。
	assert.equal(claudeToolCategory("find"), "glob");
	assert.equal(claudeToolCategory("glob"), "glob");
	assert.equal(claudeToolCategory("bash"), "bash");
	assert.equal(claudeToolCategory("powershell"), "bash");
	assert.equal(claudeToolCategory("task"), "task");
	assert.equal(claudeToolCategory("web_search"), "web");
	assert.equal(claudeToolCategory("ls"), "ls");
	// owl 没有的工具不该硬凑一个类别。
	assert.equal(claudeToolCategory("some_custom_tool"), undefined);
});

test("the group copy follows Claude's singular and plural rules", () => {
	// Claude: read → "Read a file" / "Read {count} files"
	assert.equal(claudeGroupPhrase("read", 1), "Read a file");
	assert.equal(claudeGroupPhrase("read", 3), "Read 3 files");
	// Claude: write → "Created a file" / "Created {count} files"
	assert.equal(claudeGroupPhrase("write", 1), "Created a file");
	assert.equal(claudeGroupPhrase("write", 2), "Created 2 files");
	// Claude: edit → "Edited a file" / "Edited {count} files"
	assert.equal(claudeGroupPhrase("edit", 1), "Edited a file");
	assert.equal(claudeGroupPhrase("edit", 2), "Edited 2 files");
	// Claude: bash → "Ran a command" / "Ran {count} commands"
	assert.equal(claudeGroupPhrase("bash", 1), "Ran a command");
	assert.equal(claudeGroupPhrase("bash", 2), "Ran 2 commands");
	// Claude: task → "Ran an agent" / "Ran {count} agents"
	assert.equal(claudeGroupPhrase("task", 1), "Ran an agent");
	assert.equal(claudeGroupPhrase("task", 2), "Ran 2 agents");
});

test("the categories without a count keep Claude's fixed wording", () => {
	assert.equal(claudeGroupPhrase("grep", 1), "Searched files");
	assert.equal(claudeGroupPhrase("grep", 7), "Searched files");
	assert.equal(claudeGroupPhrase("glob", 1), "Looked for files");
	assert.equal(claudeGroupPhrase("web", 1), "Searched the web");
	assert.equal(claudeGroupPhrase("ls", 1), "Listed files");
	assert.equal(claudeGroupPhrase("ls", 4), "Listed files");
});

test("the remaining Claude categories keep their own wording", () => {
	assert.equal(claudeGroupPhrase("web_fetch", 1), "Read a page");
	assert.equal(claudeGroupPhrase("web_fetch", 3), "Read 3 pages");
	assert.equal(claudeGroupPhrase("code", 1), "Ran code");
	assert.equal(claudeGroupPhrase("code", 4), "Ran code 4 times");
	assert.equal(claudeGroupPhrase("skill", 1), "Loaded a skill");
	assert.equal(claudeGroupPhrase("skill", 2), "Loaded 2 skills");
	assert.equal(claudeGroupPhrase("notebook_edit", 1), "Edited a notebook");
	assert.equal(claudeGroupPhrase("notebook_edit", 2), "Edited 2 notebooks");
	assert.equal(claudeGroupPhrase("delete_file", 1), "Deleted a file");
	assert.equal(claudeGroupPhrase("delete_file", 2), "Deleted 2 files");
	assert.equal(claudeGroupPhrase("share", 1), "Shared files");
	assert.equal(claudeGroupPhrase("share", 2, { shareCountsFiles: true }), "Shared 2 files");
	assert.equal(claudeGroupPhrase("exit_plan_mode", 1), "Proposed a plan");
	assert.equal(claudeGroupPhrase("tool_search", 1), "Loaded tools");
});

test("the browser branch switches on the failed flag", () => {
	assert.equal(claudeGroupPhrase("browser", 1), "Used Claude in Chrome");
	assert.equal(claudeGroupPhrase("browser", 3), "Used Claude in Chrome (3 actions)");
	assert.equal(claudeGroupPhrase("browser", 1, { failed: true }), "Failed to use Claude in Chrome");
	assert.equal(claudeGroupPhrase("browser", 3, { failed: true }), "Failed to use Claude in Chrome (3 attempts)");
});
