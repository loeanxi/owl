import { getUiLanguage } from "../i18n/index.ts";

const zh = { promote: "提前处理", remove: "取消排队" } as const;
const en: Record<keyof typeof zh, string> = { promote: "Process earlier", remove: "Cancel queued message" };
export function promptQueueText(key: keyof typeof zh): string {
	return (getUiLanguage() === "en" ? en : zh)[key];
}
