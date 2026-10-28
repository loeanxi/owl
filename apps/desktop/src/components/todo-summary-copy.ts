import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = { current: "当前：", next: "待处理：", done: "任务清单已完成", separate: "计划事项与工具操作分别记录" };
const en: Record<keyof typeof zh, string> = {
	current: "Current: ",
	next: "Next: ",
	done: "Task list completed",
	separate: "Plan items and tool actions are tracked separately",
};

export function useTodoSummaryText(): typeof zh {
	useT();
	return getUiLanguage() === "en" ? en : zh;
}
