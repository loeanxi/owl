/**
 * 改动审批状态 → 给模型看的一段话。
 *
 * 模型写完文件后，改动进「改动审批」卡片等用户决定：保留还是撤销。用户在侧栏
 * 做的这个决定，模型原来完全看不见（它只知道自己写成功了），于是可能拿已被
 * 撤销的版本继续往下做。这里把待审与已决状态整理成模型能读的两行字，
 * 随 sidebar_context 一起给它。
 */
import type { DiffApprovalFileSummary } from "../bridge/protocol.ts";

export interface ReviewStateSummary {
	/** 还在等用户决定的文件。 */
	pending: string[];
	/** 用户已经决定的文件：`路径（已保留 / 已撤销）`。 */
	decided: string[];
}

/** 把审批清单压成待审/已决两组（纯函数，便于单测）。 */
export function summarizeReviewState(files: readonly DiffApprovalFileSummary[]): ReviewStateSummary {
	const pending: string[] = [];
	const decided: string[] = [];
	for (const file of files) {
		if (file.status === "pending") pending.push(file.displayPath);
		else decided.push(`${file.displayPath}（${file.status === "reverted" ? "已撤销" : "已保留"}）`);
	}
	return { pending, decided };
}
