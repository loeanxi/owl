import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	currentProject: "当前项目",
	recentTasks: "继续最近任务",
} as const;

const en: Record<keyof typeof zh, string> = {
	currentProject: "Current project",
	recentTasks: "Continue recent tasks",
};

export const startPageText = (key: keyof typeof zh): string => (getUiLanguage() === "en" ? en : zh)[key];

export function useStartPageText(): typeof startPageText {
	useT();
	return startPageText;
}
