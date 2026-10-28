import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCard } from "../hooks/transcript.ts";
import { isResultEchoed, taskListLabel, taskListOf, taskListProgress } from "./claude-task-list.ts";

function card(extra: Partial<ToolCard> = {}): ToolCard {
	return { id: "t1", name: "todo", args: "{}", summary: "任务清单", status: "ok", ...extra };
}

const todos = [
	{ content: "读源码", status: "completed" as const },
	{ content: "改接缝", status: "in_progress" as const },
	{ content: "跑测试", status: "pending" as const },
];

test("a card with a task list snapshot is a task list", () => {
	const list = taskListOf(card({ output: { text: "任务清单已更新", totalLines: 1, todos } }));
	assert.equal(list?.items.length, 3);
	assert.equal(list?.updated, true);
});

test("a card without the snapshot is not a task list", () => {
	assert.equal(taskListOf(card()), undefined);
	assert.equal(taskListOf(card({ output: { text: "随便什么", totalLines: 1 } })), undefined);
});

test("the label follows the call state", () => {
	assert.equal(taskListLabel(card({ status: "running" })), "updating");
	assert.equal(taskListLabel(card({ status: "pending" })), "updating");
	assert.equal(taskListLabel(card({ status: "ok" })), "updated");
	assert.equal(taskListLabel(card({ status: "error" })), "updated");
});

test("the task list result is echoed away — the card already says it", () => {
	// Claude 的 resultEcho：结果原文不再重复显示，清单卡本身已经表达了同样的信息。
	assert.equal(isResultEchoed(card({ output: { text: "任务清单已更新 — 3 items", totalLines: 1, todos } })), true);
	assert.equal(isResultEchoed(card({ output: { text: "别的输出", totalLines: 1 } })), false);
});

test("the progress counts each state", () => {
	const list = taskListOf(card({ output: { text: "", totalLines: 0, todos } }))!;
	assert.deepEqual(taskListProgress(list), { total: 3, completed: 1, inProgress: 1 });
});
