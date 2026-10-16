import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	copy: "复制",
	more: "更多操作",
	moreShort: "更多",
	userActions: "消息操作",
	copying: "正在复制",
	copied: "已复制",
	copyFailed: "复制失败，请重试",
	editImpact: "重新发送会从这条消息继续，并替换后续对话。",
} as const;

const en: Record<keyof typeof zh, string> = {
	copy: "Copy",
	more: "More actions",
	moreShort: "More",
	userActions: "Message actions",
	copying: "Copying",
	copied: "Copied",
	copyFailed: "Copy failed. Try again.",
	editImpact: "Resending continues from this message and replaces the following conversation.",
};

export const messageActionsText = (key: keyof typeof zh): string => (getUiLanguage() === "en" ? en : zh)[key];

export function useMessageActionsText(): typeof messageActionsText {
	useT();
	return messageActionsText;
}
