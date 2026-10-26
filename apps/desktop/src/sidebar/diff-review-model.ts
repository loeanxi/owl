import { formatFileRef } from "./file-ref.ts";

export type DiffReviewMode = "diff" | "before" | "after";
export interface DiffReviewTarget {
	path: string;
	side: "old" | "new";
	line: number;
}
export interface DiffReviewComment {
	id: number;
	target: DiffReviewTarget;
	text: string;
	staged: boolean;
	/** Git is queried by the selected new path even when commenting on a renamed old path. */
	requestPath: string;
	/** The exact diff seen when the user wrote this comment. */
	snapshot: string;
}

export function diffCommentKey(target: DiffReviewTarget): string {
	return JSON.stringify([target.path, target.side, target.line]);
}

export function formatDiffFeedback(comments: readonly DiffReviewComment[], english: boolean): string {
	const heading = english ? "Please address these change-review comments. Check the referenced context first and preserve other existing changes." : "请按以下改动意见调整代码，先核对对应上下文，并保留其他已有改动。";
	// 引用格式与侧边栏定位、行内路径芯片一致：`路径:行号`。
	const legend = english
		? "Each `path:line` reference is the exact line the sidebar pointed at (the line number counts on the side named in the note); use the same anchor when you want the user to look at it."
		: "每条意见前的 `路径:行号` 就是侧边栏指的那一行（行号按括号里写的那一侧计数）；需要用户核对时用同一个锚点指回去即可。";
	return [heading, legend, ...comments.map((comment, index) => {
		const side = english ? comment.target.side === "old" ? "old" : "new" : comment.target.side === "old" ? "修改前" : "修改后";
		const area = english ? comment.staged ? "staged" : "working tree" : comment.staged ? "暂存区" : "工作区";
		const ref = formatFileRef({ path: comment.target.path, line: comment.target.line });
		return `${index + 1}. \`${ref}\` (${area}, ${side})\n${comment.text}`;
	})].join("\n\n");
}
