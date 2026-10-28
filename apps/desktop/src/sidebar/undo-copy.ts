import { useSyncExternalStore } from "react";
import { getUiLanguage, subscribeUiLanguage } from "../i18n/index.ts";

const copy = {
	zh: {
		turn: "仅撤销本轮改动",
		workspace: "按操作审查工作区改动",
		scope: "仅移除所选操作的改动；保留后续修改和手动修改。重叠冲突将保留原文件。",
		preview: "预览撤销范围",
		confirm: "确认撤销可处理文件",
		cancel: "取消",
		retry: "重新预览并重试",
		loading: "正在检查撤销范围…",
		applying: "正在撤销…",
		title: "撤销预览",
		ready: "可以撤销",
		conflict: "已保留：无法安全撤销",
		noReady: "没有可以安全撤销的文件，请先处理冲突后重新预览。",
		truncated: "预览内容过长，已截断",
		unavailable: "没有本轮的操作记录，无法安全撤销。",
		legacy: "旧记录缺少操作前后快照，无法按轮次撤销。",
		warning: "需注意",
		failed: "撤销未完成",
		network: "请求未完成，结果可能尚未同步。重新预览会先检查文件和操作的最新状态。",
		success: "撤销完成",
		kept: "已保留所选改动",
		result: "已处理操作",
		failures: "未处理文件",
		refreshing: "无法读取改动记录",
		baseline: "恢复到所选操作之前（工作区范围）",
	},
	en: {
		turn: "Undo this turn only",
		workspace: "Review workspace changes by operation",
		scope: "Remove only the selected operations. Later and manual edits are preserved; overlapping conflicts leave the file unchanged.",
		preview: "Preview undo",
		confirm: "Confirm undo for safe files",
		cancel: "Cancel",
		retry: "Preview again and retry",
		loading: "Checking undo scope…",
		applying: "Undoing…",
		title: "Undo preview",
		ready: "Ready to undo",
		conflict: "Preserved: cannot safely undo",
		noReady: "No files can be safely undone. Resolve conflicts and preview again.",
		truncated: "The preview is truncated",
		unavailable: "No operation record for this turn; safe undo is unavailable.",
		legacy: "This older record has no before and after snapshots; turn undo is unavailable.",
		warning: "Needs attention",
		failed: "Undo incomplete",
		network:
			"The request did not complete and its outcome may be pending. A new preview checks the latest file and operation state first.",
		success: "Undo complete",
		kept: "Selected changes kept",
		result: "Operations processed",
		failures: "Files not processed",
		refreshing: "Unable to read changes",
		baseline: "Restore before selected operations (workspace scope)",
	},
};

export function useUndoCopy(): typeof copy.zh {
	return copy[useSyncExternalStore(subscribeUiLanguage, getUiLanguage)];
}
