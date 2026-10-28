import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	code: "代码",
	copy: "复制",
	copied: "已复制",
	copyFailed: "复制失败，请重试",
	expandCode: "展开代码",
	collapseCode: "收起代码",
	expandTable: "展开表格",
	collapseTable: "收起表格",
	tableLabel: "表格",
	tableScroll: "可左右滚动查看其余列",
	tableScrollLeft: "可向左滚动查看其余列",
	tableScrollRight: "可向右滚动查看其余列",
	tocTitle: "本页要点",
	tocSection: "{n} 节",
	sources: "来源",
	sourcesUntitled: "未命名来源",
} as const;

const en: Record<keyof typeof zh, string> = {
	code: "Code",
	copy: "Copy",
	copied: "Copied",
	copyFailed: "Copy failed. Try again.",
	expandCode: "Expand code",
	collapseCode: "Collapse code",
	expandTable: "Expand table",
	collapseTable: "Collapse table",
	tableLabel: "Table",
	tableScroll: "Scroll left or right to see more columns",
	tableScrollLeft: "Scroll left to see more columns",
	tableScrollRight: "Scroll right to see more columns",
	tocTitle: "On this page",
	tocSection: "{n} sections",
	sources: "Sources",
	sourcesUntitled: "Untitled source",
};

export const replyReadingText = (key: keyof typeof zh, vars?: Record<string, string | number>): string =>
	(getUiLanguage() === "en" ? en : zh)[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));

export function useReplyReadingText(): typeof replyReadingText {
	useT();
	return replyReadingText;
}
