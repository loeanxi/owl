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
	return [heading, ...comments.map((comment, index) => {
		const side = english ? comment.target.side === "old" ? "old" : "new" : comment.target.side === "old" ? "修改前" : "修改后";
		const area = english ? comment.staged ? "staged" : "working tree" : comment.staged ? "暂存区" : "工作区";
		return `${index + 1}. ${JSON.stringify(comment.target.path)} (${area}, ${side}:${comment.target.line})\n${comment.text}`;
	})].join("\n\n");
}
