import assert from "node:assert/strict";
import { test } from "node:test";
import type { TodoItem } from "../hooks/todo.ts";
import { summarizeTodos } from "./todo-summary.ts";

test("reports only real completed todos and prioritizes the current in-progress task", () => {
	const todos: TodoItem[] = [
		{ content: "读取相关实现", status: "completed" },
		{ content: "后续说明", status: "pending" },
		{ content: "核对异常结果", status: "in_progress" },
		{ content: "提供最后结果", status: "pending" },
	];
	assert.deepEqual(summarizeTodos(todos), { completed: 1, total: 4, current: todos[2], allDone: false });
	assert.equal(todos[2]?.status, "in_progress");
});

test("an empty checklist has no completion claim or current task", () => {
	assert.deepEqual(summarizeTodos([]), { completed: 0, total: 0, current: undefined, allDone: false });
});

test("falls back to the first unfinished todo when none is in progress", () => {
	const todos: TodoItem[] = [
		{ content: "已完成的事项", status: "completed" },
		{ content: "接下来核对", status: "pending" },
		{ content: "最后说明", status: "pending" },
	];
	assert.equal(summarizeTodos(todos).current, todos[1]);
});

test("unknown, missing, cancelled and error statuses never count as completed", () => {
	for (const status of [undefined, "unknown", "done", "ok", "cancelled", "error", "COMPLETED"]) {
		const item: TodoItem = { content: "未确认完成的真实事项", ...(status === undefined ? {} : { status }) };
		assert.deepEqual(
			summarizeTodos([item]),
			{ completed: 0, total: 1, current: item, allDone: false },
			String(status),
		);
	}
});

test("all-done state requires every actual checklist item to be completed", () => {
	const todos: TodoItem[] = [
		{ content: "第一项", status: "completed" },
		{ content: "第二项", status: "completed" },
	];
	assert.deepEqual(summarizeTodos(todos), { completed: 2, total: 2, current: undefined, allDone: true });
	const unknown: TodoItem = { content: "还没有核对状态" };
	assert.deepEqual(summarizeTodos([...todos, unknown]), { completed: 2, total: 3, current: unknown, allDone: false });
});
