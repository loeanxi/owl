import type { TodoItem } from "../hooks/todo.ts";

export function summarizeTodos(todos: readonly TodoItem[]): {
	completed: number;
	total: number;
	current?: TodoItem;
	allDone: boolean;
} {
	const completed = todos.filter((item) => item.status === "completed").length;
	return {
		completed,
		total: todos.length,
		current: todos.find((item) => item.status === "in_progress") ?? todos.find((item) => item.status !== "completed"),
		allDone: todos.length > 0 && completed === todos.length,
	};
}
