import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	readFile: "读取 {name}",
	writeFile: "写入 {name}",
	editFile: "编辑 {name}",
	runCheck: "运行项目检查",
	runBash: "运行 Bash 命令",
	runPowerShell: "运行 PowerShell 命令",
	toolAction: "确认 {tool} 操作",
	readingRegion: "执行内容与请求详情",
	input: "执行内容",
	changePreview: "变更预览",
	source: "来源与完整参数",
	tool: "工具",
	fullInput: "完整参数",
	moreLines: "还有 {n} 行未显示",
	totalLines: "共 {n} 行",
} as const;

const en: Record<keyof typeof zh, string> = {
	readFile: "Read {name}",
	writeFile: "Write {name}",
	editFile: "Edit {name}",
	runCheck: "Run project checks",
	runBash: "Run a Bash command",
	runPowerShell: "Run a PowerShell command",
	toolAction: "Confirm {tool} operation",
	readingRegion: "Execution input and request details",
	input: "Execution input",
	changePreview: "Change preview",
	source: "Source and full parameters",
	tool: "Tool",
	fullInput: "Full parameters",
	moreLines: "{n} more lines not shown",
	totalLines: "{n} lines in total",
};

export function permissionDialogText(key: keyof typeof zh, vars?: Record<string, string>): string {
	const template = (getUiLanguage() === "en" ? en : zh)[key];
	return vars ? template.replace(/\{(\w+)\}/g, (raw, name: string) => name in vars ? vars[name]! : raw) : template;
}

export function usePermissionDialogText(): typeof permissionDialogText {
	useT();
	return permissionDialogText;
}
