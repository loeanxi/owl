/**
 * Claude 的任务清单（taskList family）。
 *
 * 规格来源：Claude Desktop 打包渲染层 `c05b96c7f-DklIyA-P.js`
 *
 *   ac.taskList = {
 *     partsForm: true,
 *     labelShapes: e => [`Started "${e}"`, `Completed "${e}"`],
 *     resultEcho: e => /^Updated task #\d+ status\.?$/.test(e),
 *   }
 *   oc(e)：`task_list_row === true && title_source === "authored"` → 归到 taskList family
 *   sc(e)：结果的**每一行**都命中 resultEcho 时，原始输出不显示，只回显标签
 *
 * 也就是说 Claude 有两件事：
 *  1. 清单在回答流里是**行**（每步一行，自带 pending / in_progress / completed 状态）；
 *  2. 「Updated task #3 status.」这种结果**不回显原文** —— 原文已经被清单本身表达了。
 *
 * owl 的对应：todo 工具回传整份清单快照（`details.todos`），渲染成一张行内清单卡；
 * 原始那段「任务清单已更新 — N items: …」是重复信息，按 resultEcho 的口径回显掉。
 */

import type { TaskListItem, ToolCard } from "../hooks/transcript.ts";

/** 一张清单卡。 */
export type TaskListCard = {
	items: TaskListItem[];
	/** 这次调用是整体替换清单（true）还是只读（false）。 */
	updated: boolean;
};

/** 清单标签的形态：进行中 / 已完成。 */
export type TaskListLabel = "updating" | "updated";

/** 这张工具卡是不是任务清单。 */
export function taskListOf(card: ToolCard): TaskListCard | undefined {
	const todos = card.output?.todos;
	if (!Array.isArray(todos) || todos.length === 0) return undefined;
	return { items: todos, updated: true };
}

/** 清单的标签形态（Claude 的 `todo_write → "Updating the plan"`）。 */
export function taskListLabel(card: ToolCard): TaskListLabel {
	return card.status === "running" || card.status === "pending" ? "updating" : "updated";
}

/**
 * 结果是否被回显掉。
 *
 * Claude 的口径：清单这一类工具的结果不再重复显示原文 ——
 * 清单卡已经把同样的信息说清楚了。owl 的 todo 工具原始输出正是这种重复。
 */
export function isResultEchoed(card: ToolCard): boolean {
	return taskListOf(card) !== undefined;
}

/** 清单的完成度（给折叠标题用）。 */
export function taskListProgress(card: TaskListCard): { total: number; completed: number; inProgress: number } {
	let completed = 0;
	let inProgress = 0;
	for (const item of card.items) {
		if (item.status === "completed") completed += 1;
		else if (item.status === "in_progress") inProgress += 1;
	}
	return { total: card.items.length, completed, inProgress };
}
