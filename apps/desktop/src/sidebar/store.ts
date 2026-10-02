/**
 * 侧边栏工作台状态：打开的 tab、激活项、未保存标记、展开的目录——全部按
 * 项目目录持久化到 localStorage（dsh-better-sidebar 按 sessionId 持久化，
 * owl 的工作台跟着项目走，会话切换布局不换）。
 *
 * 实现是同步快照的外部 store（state 不可变替换 + listener 集合），React 经
 * useSyncExternalStore 消费（注册表与 dsh-better-sidebar 的 service.ts 同一
 * 设计）。fs_changed 事件总线也挂在这里：Workbench 收桥事件后分发，各视图
 * 自行决定增量重列。
 */
import { useSyncExternalStore } from "react";

export interface SidebarTab {
	/** 稳定 id：单例 tab = kind；文件 tab = `${kind}:${path}`。 */
	id: string;
	/** 注册表里的 kind（files / changes / editor / image / …）。 */
	kind: string;
	title: string;
	/** 文件类 tab 的 workspace 相对路径。 */
	path?: string;
}

export interface SidebarState {
	tabs: SidebarTab[];
	activeId: string | null;
	/** editor tab id → 未保存。不持久化。 */
	dirty: Record<string, boolean>;
	/** 展开的目录（workspace 相对，POSIX）。 */
	expanded: string[];
}

function projectKeyOf(cwd: string): string {
	return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

const EMPTY_STATE: SidebarState = { tabs: [], activeId: null, dirty: {}, expanded: [] };

export class SidebarStore {
	private listeners = new Set<() => void>();
	private fsListeners = new Set<(dirs: string[]) => void>();
	private state: SidebarState;
	private readonly key: string;

	constructor(cwd: string) {
		this.key = `owl.workbench.state.${projectKeyOf(cwd)}`;
		this.state = this.load();
	}

	private load(): SidebarState {
		try {
			const raw = localStorage.getItem(this.key);
			if (raw === null) return EMPTY_STATE;
			const parsed = JSON.parse(raw) as { tabs?: SidebarTab[]; activeId?: string | null; expanded?: string[] };
			const tabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
			return {
				tabs,
				activeId: parsed.activeId ?? tabs[0]?.id ?? null,
				dirty: {},
				expanded: Array.isArray(parsed.expanded) ? parsed.expanded : [],
			};
		} catch {
			return EMPTY_STATE;
		}
	}

	private commit(next: SidebarState): void {
		this.state = next;
		try {
			localStorage.setItem(
				this.key,
				JSON.stringify({ tabs: next.tabs, activeId: next.activeId, expanded: next.expanded }),
			);
		} catch {
			// 配额满等场景：布局丢就丢，不能拖垮 UI
		}
		for (const listener of this.listeners) listener();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getState = (): SidebarState => this.state;

	/** 打开单例 tab（files / changes）：已开则激活。 */
	openSingleton(kind: string): void {
		const existing = this.state.tabs.find((tab) => tab.id === kind);
		if (existing !== undefined) {
			this.activate(kind);
			return;
		}
		const tab: SidebarTab = { id: kind, kind, title: kind === "files" ? "文件" : kind === "changes" ? "文件变动" : kind };
		this.commit({
			...this.state,
			tabs: [...this.state.tabs, tab],
			activeId: tab.id,
		});
	}

	/** 打开文件 tab（editor / image），按路径去重。 */
	openFileTab(kind: string, path: string, title: string): void {
		const id = `${kind}:${path}`;
		const existing = this.state.tabs.find((tab) => tab.id === id);
		if (existing !== undefined) {
			this.activate(id);
			return;
		}
		const tab: SidebarTab = { id, kind, title, path };
		this.commit({
			...this.state,
			tabs: [...this.state.tabs, tab],
			activeId: tab.id,
		});
	}

	activate(id: string): void {
		if (this.state.tabs.some((tab) => tab.id === id)) {
			this.commit({ ...this.state, activeId: id });
		}
	}

	closeTab(id: string): void {
		const index = this.state.tabs.findIndex((tab) => tab.id === id);
		if (index < 0) return;
		const tabs = this.state.tabs.filter((tab) => tab.id !== id);
		const dirty = { ...this.state.dirty };
		delete dirty[id];
		let activeId = this.state.activeId;
		if (activeId === id) {
			activeId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
		}
		this.commit({ ...this.state, tabs, activeId, dirty });
	}

	closeOthers(id: string): void {
		const keep = this.state.tabs.find((tab) => tab.id === id);
		if (keep === undefined) return;
		this.commit({ ...this.state, tabs: [keep], activeId: id, dirty: this.state.dirty[id] ? { [id]: true } : {} });
	}

	setDirty(id: string, dirty: boolean): void {
		if (Boolean(this.state.dirty[id]) === dirty) return;
		const next = { ...this.state.dirty };
		if (dirty) next[id] = true;
		else delete next[id];
		this.commit({ ...this.state, dirty: next });
	}

	toggleExpanded(dir: string): void {
		const set = new Set(this.state.expanded);
		if (set.has(dir)) set.delete(dir);
		else set.add(dir);
		this.commit({ ...this.state, expanded: [...set] });
	}

	/** 路径重命名后同步已开的文件 tab（id/title/path）与展开目录。 */
	remapPath(oldPath: string, newPath: string): void {
		const mapOne = (path: string): string => (path === oldPath || path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path);
		let changed = false;
		const tabs = this.state.tabs.map((tab) => {
			if (tab.path === undefined) return tab;
			const mapped = mapOne(tab.path);
			if (mapped === tab.path) return tab;
			changed = true;
			return { ...tab, id: `${tab.kind}:${mapped}`, path: mapped, title: mapped.split("/").pop() ?? mapped };
		});
		const expanded = this.state.expanded.map(mapOne);
		if (expanded.join("\u0000") !== this.state.expanded.join("\u0000")) changed = true;
		if (!changed) return;
		this.commit({ ...this.state, tabs, expanded });
	}

	/** 移除已删路径的文件 tab 与展开目录。 */
	dropPath(path: string): void {
		const affected = (target: string): boolean => target === path || target.startsWith(`${path}/`);
		const tabs = this.state.tabs.filter((tab) => tab.path === undefined || !affected(tab.path));
		const expanded = this.state.expanded.filter((dir) => !affected(dir));
		const dirty = { ...this.state.dirty };
		for (const tab of this.state.tabs) {
			if (tab.path !== undefined && affected(tab.path)) delete dirty[tab.id];
		}
		let activeId = this.state.activeId;
		if (activeId !== null && !tabs.some((tab) => tab.id === activeId)) {
			activeId = tabs.at(-1)?.id ?? null;
		}
		this.commit({ tabs, activeId, dirty, expanded });
	}

	// -- fs_changed 总线 -----------------------------------------------------

	fsChanged(dirs: string[]): void {
		for (const listener of this.fsListeners) listener(dirs);
	}

	onFsChanged(listener: (dirs: string[]) => void): () => void {
		this.fsListeners.add(listener);
		return () => this.fsListeners.delete(listener);
	}
}

/** 订阅 store 状态的 hook。 */
export function useSidebarState(store: SidebarStore): SidebarState {
	return useSyncExternalStore(store.subscribe, store.getState);
}

/** 归一化项目 key（与 SidebarStore 的持久化 key 同规则）。 */
export function normProjectKey(cwd: string): string {
	return projectKeyOf(cwd);
}
