import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	filters: "搜索范围",
	allProjects: "全部项目",
	currentProject: "当前项目",
	includeArchived: "包含归档",
	contents: "聊天内容",
	metadata: "会话与项目",
	loading: "正在搜索聊天内容…",
	offline: "连接断开，恢复连接后会继续搜索。",
	failed: "搜索失败",
	retry: "重试",
	empty: "正文中没有找到匹配内容。试试其他关键词，或包含归档。",
	chat: "普通对话",
	research: "研究会话",
	archived: "已归档",
	user: "你",
	assistant: "Owl",
	noProject: "未关联项目",
	more: "显示更多",
	limit: "已显示前 200 条结果，请缩小搜索范围或补充关键词。",
} as const;

const en: Record<keyof typeof zh, string> = {
	filters: "Search scope",
	allProjects: "All projects",
	currentProject: "Current project",
	includeArchived: "Include archived",
	contents: "Chat contents",
	metadata: "Chats and projects",
	loading: "Searching chat contents…",
	offline: "Disconnected. Search will resume when the connection returns.",
	failed: "Search failed",
	retry: "Retry",
	empty: "No matching messages. Try other keywords or include archived chats.",
	chat: "Chat",
	research: "Research",
	archived: "Archived",
	user: "You",
	assistant: "Owl",
	noProject: "No project",
	more: "Show more",
	limit: "Showing the first 200 results. Narrow the scope or add keywords.",
};

export const sessionSearchText = (key: keyof typeof zh): string => (getUiLanguage() === "en" ? en : zh)[key];

export function useSessionSearchText(): typeof sessionSearchText {
	useT();
	return sessionSearchText;
}
