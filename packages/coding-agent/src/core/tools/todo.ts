import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const todoStatuses = ["pending", "in_progress", "completed"] as const;
const todoPriorities = ["high", "medium", "low"] as const;

const todoItemSchema = Type.Object({
	content: Type.String({ description: "Task description, concise and actionable" }),
	status: Type.Optional(
		Type.Union(
			todoStatuses.map((s) => Type.Literal(s)),
			{ description: "pending | in_progress | completed (default: pending)" },
		),
	),
	priority: Type.Optional(
		Type.Union(
			todoPriorities.map((p) => Type.Literal(p)),
			{ description: "high | medium | low (default: medium)" },
		),
	),
});

const todoSchema = Type.Object({
	todos: Type.Optional(
		Type.Array(todoItemSchema, {
			description:
				"Full replacement task list. Omit to read the current list without changing it. Send every task each time, not just the delta.",
		}),
	),
});

export const todoToolSystemPromptContribution = {
	snippet: "读取或整体更新会话任务清单（多步骤工作的进度跟踪）",
	guidelines: [
		"todo 工具是全量替换语义：每次调用传入完整清单，不是增量修改",
		"任务开始前列出全部步骤；每完成一步立即把该任务标为 completed、下一任务标为 in_progress 后再继续工作",
		"同一时刻最多一个任务处于 in_progress；全部完成后清点一遍再收尾汇报",
	],
} as const;

export type TodoToolInput = Static<typeof todoSchema>;

export type TodoItem = {
	content: string;
	status: (typeof todoStatuses)[number];
	priority: (typeof todoPriorities)[number];
};

export interface TodoToolDetails {
	/** Current task list snapshot after this call. */
	todos: TodoItem[];
	/** Whether this call replaced the list (vs. read-only). */
	updated: boolean;
	/** Non-fatal normalizations applied to the submitted list. */
	notes: string[];
}

const MAX_TODO_ITEMS = 50;

const STATUS_ICONS: Record<TodoItem["status"], string> = {
	completed: "[x]",
	in_progress: "[>]",
	pending: "[ ]",
};

function renderList(todos: TodoItem[]): string {
	if (todos.length === 0) return "(The task list is empty)";
	return todos.map((item, index) => `${STATUS_ICONS[item.status]} ${index + 1}. ${item.content}`).join("\n");
}

function summarize(todos: TodoItem[]): string {
	const completed = todos.filter((t) => t.status === "completed").length;
	const inProgress = todos.filter((t) => t.status === "in_progress").length;
	const pending = todos.filter((t) => t.status === "pending").length;
	return `${todos.length} items: ${completed} completed, ${inProgress} in progress, ${pending} pending`;
}

/**
 * Validate and normalize a submitted list. Normalizations are collected as notes so the
 * model can self-correct; nothing here throws.
 */
function normalizeItems(input: Static<typeof todoItemSchema>[]): { items: TodoItem[]; notes: string[] } {
	const notes: string[] = [];
	const emptyContent = input.filter((t) => t.content.trim().length === 0).length;
	if (emptyContent > 0) notes.push(`${emptyContent} tasks had empty content`);
	let items: TodoItem[] = input
		.filter((t) => t.content.trim().length > 0)
		.map((raw) => ({
			content: raw.content.trim(),
			status: raw.status ?? "pending",
			priority: raw.priority ?? "medium",
		}));
	if (items.length > MAX_TODO_ITEMS) {
		items = items.slice(0, MAX_TODO_ITEMS);
		notes.push(`List truncated to ${MAX_TODO_ITEMS} items`);
	}
	let seenInProgress = false;
	let demoted = 0;
	for (const item of items) {
		if (item.status === "in_progress") {
			if (seenInProgress) {
				item.status = "pending";
				demoted++;
			} else {
				seenInProgress = true;
			}
		}
	}
	if (demoted > 0) {
		notes.push(
			`Only one task may be in_progress at a time; ${demoted} extra in_progress task(s) were reset to pending`,
		);
	}
	return { items, notes };
}

export interface TodoToolOptions {
	/** Initial list (e.g. restored from a previous session). Default: empty */
	initialTodos?: TodoItem[];
}

/**
 * Session-scoped task list. State lives in the tool closure: one tool instance is built
 * per agent session, and the model always sends the full list on update, so a runtime
 * rebuild (which creates a fresh instance) self-heals on the next write.
 */
export function createTodoToolDefinition(
	_cwd: string,
	options?: TodoToolOptions,
): ToolDefinition<typeof todoSchema, TodoToolDetails> {
	let todos: TodoItem[] = (options?.initialTodos ?? []).map((item) => ({ ...item }));

	return {
		name: "todo",
		label: "任务清单",
		description:
			"Read or replace the session task list for tracking multi-step work. Pass `todos` to replace the whole list (full snapshot each time); omit it to read the current list. At most one task may be in_progress.",
		promptSnippet: todoToolSystemPromptContribution.snippet,
		promptGuidelines: [...todoToolSystemPromptContribution.guidelines],
		parameters: todoSchema,
		async execute(_toolCallId, input: TodoToolInput) {
			if (input.todos === undefined) {
				return {
					content: [{ type: "text", text: `当前任务清单 — ${summarize(todos)}\n${renderList(todos)}` }],
					details: { todos: todos.map((t) => ({ ...t })), updated: false, notes: [] },
				};
			}

			const { items, notes } = normalizeItems(input.todos);
			todos = items;

			const lines = [`任务清单已更新 — ${summarize(todos)}`, renderList(todos)];
			for (const note of notes) lines.push(`\n注意：${note}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { todos: todos.map((t) => ({ ...t })), updated: true, notes },
			};
		},
	};
}

export function createTodoTool(cwd: string, options?: TodoToolOptions): AgentTool<typeof todoSchema> {
	return wrapToolDefinition(createTodoToolDefinition(cwd, options));
}
