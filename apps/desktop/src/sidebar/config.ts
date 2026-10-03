/**
 * 侧边卡片配置（settings.json 的 owlSidebar）的 UI 侧镜像。
 *
 * settings.json 是唯一事实源；这里持有最近一次拉取/保存的快照，供工作台
 * 工具行、空态卡片、快捷入口、文件打开回退等热路径同步读取。设置页保存
 * 成功与 App 连桥拉取设置时调用 setSidebarConfig，改动即时生效。
 * 模块级单例与 registry.ts 同款取舍（桌面端只有一个工作台实例）。
 */
import { useSyncExternalStore } from "react";
import { fileViewerForPath, isImagePath, viewerKindFor } from "./registry.ts";

export interface SidebarConfig {
	/** 停用的侧边卡片（工作台 tab kind：files/changes/terminal/browser/tasks/impression/sidechat）。 */
	disabledTabs: string[];
	/** 停用的文件预览 viewer（image / editor）。 */
	disabledViewers: string[];
	/** 为模型注入 sidebar_open 工具（桥端消费，这里仅回显设置态）。 */
	injectOpenTool: boolean;
}

const DEFAULTS: SidebarConfig = { disabledTabs: [], disabledViewers: [], injectOpenTool: false };

let current: SidebarConfig = DEFAULTS;
const listeners = new Set<() => void>();

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** settings.json 的 owlSidebar 原始值 → 规范化配置（容忍手改的脏数据）。 */
export function parseSidebarSettings(raw: unknown): SidebarConfig {
	if (typeof raw !== "object" || raw === null) return DEFAULTS;
	const obj = raw as Record<string, unknown>;
	return {
		disabledTabs: stringList(obj.disabledTabs),
		disabledViewers: stringList(obj.disabledViewers),
		injectOpenTool: obj.injectOpenTool === true,
	};
}

export function getSidebarConfig(): SidebarConfig {
	return current;
}

export function setSidebarConfig(next: SidebarConfig): void {
	if (next === current) return;
	current = next;
	for (const listener of listeners) listener();
}

/** 订阅配置快照的 hook（无撕裂读取）。 */
export function useSidebarConfig(): SidebarConfig {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
		() => current,
	);
}

/** 侧边卡片（单例/多实例 tab kind）是否启用。 */
export function isTabKindEnabled(kind: string, cfg: SidebarConfig = current): boolean {
	return !cfg.disabledTabs.includes(kind);
}

/**
 * 文件 → viewer kind（带停用回退）：图片预览停用时回退编辑器（代码预览是
 * 万物兜底）；解析出的 viewer 也被停用（如关掉「代码」）返回 undefined，
 * 调用方交给系统默认程序打开。
 */
export function viewerKindForPath(path: string, cfg: SidebarConfig = current): string | undefined {
	const plugin = fileViewerForPath(path);
	if (plugin?.workspaceViewerId) {
		return cfg.disabledViewers.includes(plugin.kind) || cfg.disabledTabs.includes(plugin.kind) ? undefined : plugin.kind;
	}
	// Binary documents belong in the system's document app, never the text editor.
	if (/\.(?:pdf|docx?|xlsx?|xlsm|pptx?|pptm|odt|ods|odp|rtf|zip|7z)$/i.test(path)) return undefined;
	let kind = isImagePath(path) ? "image" : viewerKindFor(path);
	if (kind === "document" && cfg.disabledViewers.includes("editor")) return undefined;
	if (kind === "image" && cfg.disabledViewers.includes("image")) kind = "editor";
	return cfg.disabledViewers.includes(kind) ? undefined : kind;
}
