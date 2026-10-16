import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = { sending: "正在提交…", failed: "尚未确认提交结果，原内容已保留", retry: "原样重试", later: "稍后处理", details: "查看详情", workspace: "项目", session: "会话", unknownWorkspace: "项目目录暂不可用", approve: "允许此操作", waiting: "等待提交确认" };
const en: Record<keyof typeof zh, string> = { sending: "Submitting…", failed: "Submission not confirmed; your input is preserved", retry: "Retry unchanged", later: "Handle later", details: "View details", workspace: "Project", session: "Conversation", unknownWorkspace: "Project directory unavailable", approve: "Allow this operation", waiting: "Awaiting confirmation" };

export function usePendingRequestCopy(): typeof zh {
	useT();
	return getUiLanguage() === "en" ? en : zh;
}
