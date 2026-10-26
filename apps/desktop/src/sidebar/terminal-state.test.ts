import assert from "node:assert/strict";
import test from "node:test";
import { clearTerminalTail, peekTerminalTail, reportTerminalTail } from "./terminal-state.ts";

test("terminal tail is remembered per terminal and the latest one wins", () => {
	reportTerminalTail("terminal:a", "第一段输出");
	reportTerminalTail("terminal:b", "第二段输出");
	assert.equal(peekTerminalTail("terminal:a"), "第一段输出");
	assert.equal(peekTerminalTail("terminal:b"), "第二段输出");
	// 不指定时取最近有输出的那个。
	assert.equal(peekTerminalTail(), "第二段输出");
	assert.equal(peekTerminalTail("terminal:missing"), "");
	clearTerminalTail("terminal:b");
	assert.equal(peekTerminalTail("terminal:b"), "");
	clearTerminalTail("terminal:a");
});
