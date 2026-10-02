/**
 * 侧边栏服务注册表 —— 移植自 dsh-better-sidebar 的 ctx.betterSidebar 服务
 * 设计：内置 tab 与第三方扩展走同一套 registerTab / registerFileViewer API，
 * 注册返回 disposer（组件卸载即注销）。
 *
 * 与上游的差异：不经过 cordis Context，注册表是模块级单例（owl 桌面端只有
 * 一个工作台实例）；viewer 按 kind 两档（image / editor），文件打开时按扩展
 * 名匹配。
 */
import { useSyncExternalStore } from "react";
import type { SidebarApi } from "./api.ts";
import type { BridgeClient } from "../bridge/client.ts";
import type { GitStatusResult } from "../bridge/protocol.ts";
import type { SidebarStore, SidebarTab } from "./store.ts";

/** 每个 tab 组件收到的公共 props。 */
export interface TabComponentProps {
	api: SidebarApi;
	store: SidebarStore;
	/** 当前项目目录（绝对路径）。 */
	cwd: string;
	tab: SidebarTab;
	/** 原始桥客户端（需要会话级 API 的 tab 用：侧边对话自建会话等）。 */
	client: BridgeClient;
	/** 从树/搜索打开一个文件（走 viewer 匹配）。 */
	onOpenFile: (path: string) => void;
	/** 文件树发生变更（含增删改后）——changes tab 用它刷新状态。 */
	gitStatus: GitStatusResult | undefined;
	onGitRefresh: () => void;
}

export interface TabDefinition {
	/** tab kind（稳定 id 前缀）。 */
	kind: string;
	/** 单例 tab 的默认标题；文件 tab 的标题取文件名。 */
	title: string;
	icon: (size?: number) => React.ReactNode;
	component: React.ComponentType<TabComponentProps>;
	/** 文件 viewer 的扩展名匹配（image / editor 类 tab 声明）。 */
	exts?: readonly string[];
}

interface RegistrySnapshot {
	byKind: ReadonlyMap<string, TabDefinition>;
	/** 扩展名 → kind（viewer 匹配，小写、不带点）。 */
	byExt: ReadonlyMap<string, string>;
}

const registry = new Map<string, TabDefinition>();
const listeners = new Set<() => void>();
let snapshot: RegistrySnapshot = { byKind: new Map(), byExt: new Map() };

function rebuildSnapshot(): void {
	const byKind = new Map(registry);
	const byExt = new Map<string, string>();
	for (const def of registry.values()) {
		for (const ext of def.exts ?? []) byExt.set(ext.toLowerCase(), def.kind);
	}
	snapshot = { byKind, byExt };
	for (const listener of listeners) listener();
}

/** 注册一个 tab 定义；返回 disposer。同名 kind 覆盖（HMR 场景）。 */
export function registerTab(def: TabDefinition): () => void {
	registry.set(def.kind, def);
	rebuildSnapshot();
	return () => {
		const current = registry.get(def.kind);
		if (current === def) {
			registry.delete(def.kind);
			rebuildSnapshot();
		}
	};
}

/** 注册表快照的订阅 hook（无撕裂读取）。 */
export function useTabRegistry(): RegistrySnapshot {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => snapshot,
		() => snapshot,
	);
}

/** 文件扩展名 → viewer kind（未命中返回 editor 兜底）。 */
export function viewerKindFor(path: string): string {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	return snapshot.byExt.get(ext) ?? "editor";
}

/** 图片类扩展名（决定双击行为与图标着色）。 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

export function isImagePath(path: string): boolean {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	return dot > 0 && IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase());
}
