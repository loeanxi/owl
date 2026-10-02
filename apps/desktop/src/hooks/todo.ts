import type { ChatEntry } from "./transcript.ts";

/** todo 工具清单项（渲染防御：字段缺失按默认处理）。 */
export type TodoItem = { content: string; status?: string; priority?: string };

/** 解析 todo 工具调用的 args 字符串；不是写入调用（无 todos 数组）返回 undefined。 */
export function parseTodoArgs(args: string): TodoItem[] | undefined {
	if (!args) return undefined;
	try {
		const parsed = JSON.parse(args) as { todos?: TodoItem[] };
		if (!Array.isArray(parsed.todos)) return undefined;
		return parsed.todos.filter((item) => typeof item?.content === "string");
	} catch {
		return undefined;
	}
}

/**
 * 转录里最近一次 todo 写入的清单 = 会话当前任务状态（读取调用不带 todos，
 * 不改变状态，跳过）。args 在 toolcall_end 才落上，流式中的空 args 自然被忽略。
 */
export function latestTodoState(entries: ChatEntry[]): TodoItem[] | undefined {
	let result: TodoItem[] | undefined;
	for (const entry of entries) {
		if (entry.kind !== "assistant") continue;
		for (const tool of entry.tools) {
			const todos = tool.name === "todo" ? parseTodoArgs(tool.args) : undefined;
			if (todos) result = todos;
		}
	}
	return result;
}
