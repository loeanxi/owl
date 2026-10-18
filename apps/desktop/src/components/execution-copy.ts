import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	normal: "正常", thinking: "思考", verbose: "详细",
	normalDesc: "收起工具记录，保留当前进展", thinkingDesc: "增加可展开的思考记录", verboseDesc: "逐项显示工具、命令与输出",
	view: "视图", viewMenu: "执行记录视图", cycleView: "切换执行记录视图", globalPreference: "全局显示偏好，适用于主会话；不改变任务执行。",
	terminal: "终端", tasks: "后台任务", toolOutput: "工具输出", changes: "改动",
	shortcut: "快捷键", captureShortcut: "更改快捷键", pressShortcut: "按组合键，Esc 取消", resetShortcut: "恢复默认", shortcutConflict: "该快捷键已用于其他操作。", shortcutInvalid: "请使用 Ctrl、Alt 或 Meta 组合键。",
	delivery: "选择补充发送方式", steer: "当前动作后补充", steerHint: "Enter 发送，当前动作结束后处理，不停止正在执行的操作。",
	queue: "本轮结束后发送", queueHint: "保留在排队列表，当前这轮完成后再处理。", queuePlaceholder: "补充要求，Enter 在当前动作结束后处理",
	queueShortcut: "本轮结束后发送（输入框发送菜单）", steeringShortcut: "补充到当前这轮（当前动作结束后处理）",
	projectGuide: "会话与项目：左侧栏管理历史会话；「文件 → 打开项目…」（Ctrl+Shift+O）切换工作目录，会话历史按项目归档，随时切回。Ctrl+O 切换执行记录视图。",
} as const;

const en: Record<keyof typeof zh, string> = {
	normal: "Normal", thinking: "Thinking", verbose: "Verbose",
	normalDesc: "Collapse tool records and keep current progress", thinkingDesc: "Include expandable thinking records", verboseDesc: "Show each tool, command and output",
	view: "view", viewMenu: "Execution view", cycleView: "Cycle execution view", globalPreference: "Global display preference for main conversations; execution stays unchanged.",
	terminal: "Terminal", tasks: "Background tasks", toolOutput: "Tool output", changes: "Changes",
	shortcut: "Shortcut", captureShortcut: "Change shortcut", pressShortcut: "Press a shortcut; Esc cancels", resetShortcut: "Reset", shortcutConflict: "This shortcut is already assigned to another action.", shortcutInvalid: "Use a Ctrl, Alt or Meta shortcut.",
	delivery: "Choose message delivery", steer: "Add after the current action", steerHint: "Enter sends for the next action boundary without stopping the current operation.",
	queue: "Send after this turn", queueHint: "Keep this message queued until the current turn finishes.", queuePlaceholder: "Add instructions; Enter applies them after the current action",
	queueShortcut: "Send after this turn (composer delivery menu)", steeringShortcut: "Add to this turn after the current action",
	projectGuide: "Sessions and projects: use the sidebar for history and File → Open project (Ctrl+Shift+O) to switch working directories. History is kept per project. Ctrl+O cycles the execution view.",
};

export function executionText(key: keyof typeof zh): string { return (getUiLanguage() === "en" ? en : zh)[key]; }
export function useExecutionText(): typeof executionText { useT(); return executionText; }
