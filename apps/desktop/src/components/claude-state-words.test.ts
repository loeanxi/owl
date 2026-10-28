import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCard } from "../hooks/transcript.ts";
import {
	CLAUDE_STATE_WORDS,
	claudeCellStateOf,
	claudeGroupState,
	claudeLiveLabel,
	claudeStateWord,
} from "./claude-state-words.ts";

function card(status: ToolCard["status"], name = "read"): ToolCard {
	return { id: name + status, name, args: "{}", summary: "", status, startedAt: 1 };
}

test("the state word table is Claude's own copy", () => {
	// Lj 的逐字默认词：Failed / Stopped / Denied / Needs approval。
	assert.deepEqual(CLAUDE_STATE_WORDS.failed, { word: "Failed", tone: "danger" });
	assert.deepEqual(CLAUDE_STATE_WORDS.stopped, { word: "Stopped", tone: "secondary" });
	assert.deepEqual(CLAUDE_STATE_WORDS.denied, { word: "Denied", tone: "secondary" });
	assert.deepEqual(CLAUDE_STATE_WORDS.blocked, { word: "Needs approval", tone: "warning" });
});

test("done and running have no state word, like Vj()'s null branch", () => {
	assert.equal(claudeStateWord("done"), undefined);
	assert.equal(claudeStateWord("running"), undefined);
	assert.equal(claudeStateWord("failed")?.word, "Failed");
	assert.equal(claudeStateWord("stopped")?.word, "Stopped");
});

test("owl statuses map onto Claude's cell states", () => {
	// cancelled 是用户停的：落到 stopped，不是 failed。
	assert.equal(claudeCellStateOf({ status: "cancelled" }), "stopped");
	assert.equal(claudeCellStateOf({ status: "error" }), "failed");
	assert.equal(claudeCellStateOf({ status: "running" }), "running");
	assert.equal(claudeCellStateOf({ status: "pending" }), "running");
	assert.equal(claudeCellStateOf({ status: "ok" }), "done");
});

test("the group state takes the worst outstanding outcome", () => {
	assert.equal(claudeGroupState([card("ok"), card("running")]), "running");
	assert.equal(claudeGroupState([card("ok"), card("error")]), "failed");
	assert.equal(claudeGroupState([card("ok"), card("cancelled")]), "stopped");
	assert.equal(claudeGroupState([card("ok"), card("ok")]), "done");
	// 失败优先于被停：组头只容一个状态词。
	assert.equal(claudeGroupState([card("cancelled"), card("error")]), "failed");
});

test("the live label is the last running tool's progressive phrase", () => {
	const cards = [
		{ ...card("ok", "read"), args: JSON.stringify({ path: "src/a.ts" }) },
		{ ...card("running", "bash"), args: JSON.stringify({ command: "npm test" }) },
	];
	assert.equal(claudeLiveLabel(cards), "Running a command");
	assert.equal(claudeLiveLabel([cards[0]!]), undefined);
});
