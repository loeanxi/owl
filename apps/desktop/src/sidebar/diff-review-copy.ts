import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	diff: "对比", before: "修改前", after: "修改后", fragments: "仅显示变更附近的片段", comment: "添加改动意见",	locate: "定位到这一行", placeholder: "说明这处改动需要怎样调整…",
	add: "添加意见", cancel: "取消", remove: "移除意见", send: "发送改动意见", sending: "正在发送…", count: "{n} 条改动意见", sent: "意见已发送到当前对话",
	noSession: "打开一个对话后可发送意见", changed: "对应文件的差异已变化，请重新核对后添加意见", failed: "未能发送意见，请重试", draft: "改动意见", openFile: "打开完整文件",
	oldLine: "修改前第 {n} 行", newLine: "修改后第 {n} 行", empty: "填写具体意见后再添加", checking: "正在核对文件差异…",
};
const en: Record<keyof typeof zh, string> = {
	diff: "Diff", before: "Before", after: "After", fragments: "Only sections near changes are shown", comment: "Add review comment",	locate: "Locate this line", placeholder: "Describe how this change should be adjusted…",
	add: "Add comment", cancel: "Cancel", remove: "Remove comment", send: "Send review comments", sending: "Sending…", count: "{n} review comments", sent: "Comments sent to this conversation",
	noSession: "Open a conversation to send comments", changed: "The referenced diff changed. Review it again before commenting", failed: "Could not send comments. Try again", draft: "Review comments", openFile: "Open full file",
	oldLine: "Old line {n}", newLine: "New line {n}", empty: "Enter a specific comment first", checking: "Checking file diffs…",
};
export function diffReviewText(key: keyof typeof zh, vars?: Record<string, number>): string {
	const value = (getUiLanguage() === "en" ? en : zh)[key];
	return vars ? value.replace(/\{(\w+)\}/g, (raw, name: string) => name in vars ? String(vars[name]) : raw) : value;
}
export function useDiffReviewText(): typeof diffReviewText {
	useT();
	return diffReviewText;
}
