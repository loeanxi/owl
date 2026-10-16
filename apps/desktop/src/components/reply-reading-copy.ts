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
};

export const replyReadingText = (key: keyof typeof zh): string => (getUiLanguage() === "en" ? en : zh)[key];

export function useReplyReadingText(): typeof replyReadingText {
	useT();
	return replyReadingText;
}
