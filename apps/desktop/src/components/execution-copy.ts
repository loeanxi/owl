import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	tasks: "后台任务", toolOutput: "工具输出",
	delivery: "选择补充发送方式", steer: "当前动作后补充", steerHint: "Enter 发送，当前动作结束后处理，不停止正在执行的操作。",
	queue: "本轮结束后发送", queueHint: "保留在排队列表，当前这轮完成后再处理。", queuePlaceholder: "补充要求，Enter 在当前动作结束后处理",
	queueShortcut: "本轮结束后发送（输入框发送菜单）", steeringShortcut: "补充到当前这轮（当前动作结束后处理）",
	projectGuide: "会话与项目：左侧栏管理历史会话；「文件 → 打开项目…」（Ctrl+Shift+O）切换工作目录，会话历史按项目归档，随时切回。",
} as const;

const en: Record<keyof typeof zh, string> = {
	tasks: "Background tasks", toolOutput: "Tool output",
	delivery: "Choose message delivery", steer: "Add after the current action", steerHint: "Enter sends for the next action boundary without stopping the current operation.",
	queue: "Send after this turn", queueHint: "Keep this message queued until the current turn finishes.", queuePlaceholder: "Add instructions; Enter applies them after the current action",
	queueShortcut: "Send after this turn (composer delivery menu)", steeringShortcut: "Add to this turn after the current action",
	projectGuide: "Sessions and projects: use the sidebar for history and File → Open project (Ctrl+Shift+O) to switch working directories. History is kept per project.",
};

export function executionText(key: keyof typeof zh): string { return (getUiLanguage() === "en" ? en : zh)[key]; }
export function useExecutionText(): typeof executionText { useT(); return executionText; }
