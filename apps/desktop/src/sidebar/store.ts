/**
 * 侧边栏工作台状态 —— 移植 dsh-better-sidebar 的 split tree：tab 挂在二叉
 * 分屏树上（leaf = 一组 tab + 激活项；split = row/col 二分 + ratio），tab 可
 * 拖到目标 leaf 边缘 25% 区域切开 50/50、拖到中心合并，空 leaf 自动折叠
 * （state.ts 的 moveTab/insertLeafAt/removeLeafAt 同款语义）。
 *
 * 持久化按项目目录进 localStorage，v2 存树；旧版平面 tab 列表读取时自动
 * 迁移成单 leaf。state 快照里同时给出摊平的 tabs 与全局 activeId，让
 * BottomDockBar / 工具行这类消费者不必关心树结构。
 *
 * React 经 useSyncExternalStore 消费；fs_changed 事件总线也挂在这里。
 */
import { useSyncExternalStore } from "react";

export interface SidebarTab {
	/** 稳定 id：单例 tab = kind；文件 tab = `${kind}:${path}`。 */
	id: string;
	/** 注册表里的 kind（files / changes / tasks / sidechat / editor / image / …）。 */
	kind: string;
	title: string;
	/** 文件类 tab 的 workspace 相对路径。 */
	path?: string;
}

/** tab 拖放落点：leaf 四边 25% 区域（切开）或中心（合并进该 leaf）。 */
export type DropZone = "left" | "right" | "up" | "down" | "center";

export type SplitNode =
	| { id: string; kind: "leaf"; tabs: SidebarTab[]; activeTab: string | null }
	| { id: string; kind: "split"; dir: "row" | "col"; ratio: number; a: SplitNode; b: SplitNode };

export interface SidebarState {
	tree: SplitNode;
	/** 当前聚焦的 leaf id（激活 tab 所在的 leaf）。 */
	activePane: string;
	/** 全树摊平的 tab（派生快照，供工具行/底部栏按 kind 查询）。 */
	tabs: SidebarTab[];
	/** 全局激活 tab id（activePane 的 activeTab，派生）。 */
	activeId: string | null;
	/** tab id → 未保存。不持久化。 */
	dirty: Record<string, boolean>;
	/** 展开的目录（workspace 相对，POSIX）。 */
	expanded: string[];
}

let seq = 0;
function freshId(prefix: string): string {
	seq = (seq + 1) % Number.MAX_SAFE_INTEGER;
	return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function makeLeaf(tabs: SidebarTab[] = [], activeTab: string | null = tabs[0]?.id ?? null): SplitNode {
	return { id: freshId("leaf"), kind: "leaf", tabs, activeTab };
}

function flatten(node: SplitNode, out: SidebarTab[]): SidebarTab[] {
	if (node.kind === "leaf") out.push(...node.tabs);
	else {
		flatten(node.a, out);
		flatten(node.b, out);
	}
	return out;
}

function firstLeaf(node: SplitNode): Extract<SplitNode, { kind: "leaf" }> {
	return node.kind === "leaf" ? node : firstLeaf(node.a);
}

function findLeaf(node: SplitNode, leafId: string): Extract<SplitNode, { kind: "leaf" }> | undefined {
	if (node.kind === "leaf") return node.id === leafId ? node : undefined;
	return findLeaf(node.a, leafId) ?? findLeaf(node.b, leafId);
}

function findLeafWithTab(node: SplitNode, tabId: string): Extract<SplitNode, { kind: "leaf" }> | undefined {
	if (node.kind === "leaf") return node.tabs.some((tab) => tab.id === tabId) ? node : undefined;
	return findLeafWithTab(node.a, tabId) ?? findLeafWithTab(node.b, tabId);
}

/** 深度优先替换指定 leaf（split 节点原样重建）。 */
function replaceLeaf(
	node: SplitNode,
	leafId: string,
	fn: (leaf: Extract<SplitNode, { kind: "leaf" }>) => SplitNode,
): SplitNode {
	if (node.kind === "leaf") return node.id === leafId ? fn(node) : node;
	return { ...node, a: replaceLeaf(node.a, leafId, fn), b: replaceLeaf(node.b, leafId, fn) };
}

/** 折叠空 leaf：空 leaf → null；单边 null 的 split → 另一边；全 null → null。 */
function prune(node: SplitNode): SplitNode | null {
	if (node.kind === "leaf") return node.tabs.length > 0 ? node : null;
	const a = prune(node.a);
	const b = prune(node.b);
	if (a && b) return { ...node, a, b };
	return a ?? b;
}

/** 从树上移除一个 tab，随后折叠空 leaf；整树空时回一个空 leaf（工作台空态）。 */
function removeTab(node: SplitNode, tabId: string): SplitNode {
	const leaf = findLeafWithTab(node, tabId);
	if (!leaf) return node;
	const next = prune(
		replaceLeaf(node, leaf.id, (l) => ({
			...l,
			tabs: l.tabs.filter((tab) => tab.id !== tabId),
			activeTab:
				l.activeTab === tabId ? (l.tabs.find((tab) => tab.id !== tabId)?.id ?? null) : l.activeTab,
		})),
	);
	return next ?? makeLeaf();
}

/** 把目标 leaf 按落点方向切开 50/50，新 leaf 装着 tab 落在 zone 一侧。 */
function splitLeafAt(node: SplitNode, leafId: string, zone: DropZone, tab: SidebarTab): SplitNode {
	const target = findLeaf(node, leafId);
	if (!target) return node;
	const holder = makeLeaf([tab], tab.id);
	const first = zone === "left" || zone === "up";
	const replacement: SplitNode = {
		id: freshId("split"),
		kind: "split",
		dir: zone === "left" || zone === "right" ? "row" : "col",
		ratio: 0.5,
		a: first ? holder : target,
		b: first ? target : holder,
	};
	return replaceLeaf(node, leafId, () => replacement);
}

function setRatioAt(node: SplitNode, splitId: string, ratio: number): SplitNode {
	if (node.kind === "leaf") return node;
	if (node.id === splitId) return { ...node, ratio };
	return { ...node, a: setRatioAt(node.a, splitId, ratio), b: setRatioAt(node.b, splitId, ratio) };
}

const VALID_TAB_KIND = /^[a-z][a-z0-9-]*$/i;

/** 结构化清洗（DSH sanitizeState 同职责）：重建 id、去重、夹 ratio、限深。 */
function sanitizeNode(raw: unknown, seen: Set<string>, depth: number): SplitNode | null {
	if (depth > 12 || typeof raw !== "object" || raw === null) return null;
	const node = raw as Record<string, unknown>;
	if (node.kind === "leaf" || Array.isArray(node.tabs)) {
		const tabs: SidebarTab[] = [];
		for (const item of Array.isArray(node.tabs) ? node.tabs : []) {
			if (typeof item !== "object" || item === null) continue;
			const entry = item as Record<string, unknown>;
			if (typeof entry.id !== "string" || typeof entry.kind !== "string") continue;
			if (!VALID_TAB_KIND.test(entry.kind) || seen.has(entry.id)) continue;
			seen.add(entry.id);
			tabs.push({
				id: entry.id,
				kind: entry.kind,
				title: typeof entry.title === "string" ? entry.title : entry.kind,
				...(typeof entry.path === "string" ? { path: entry.path } : {}),
			});
		}
		const active =
			typeof node.activeTab === "string" && tabs.some((tab) => tab.id === node.activeTab)
				? node.activeTab
				: (tabs[0]?.id ?? null);
		return { id: freshId("leaf"), kind: "leaf", tabs, activeTab: active };
	}
	if (node.kind === "split") {
		const a = sanitizeNode(node.a, seen, depth + 1);
		const b = sanitizeNode(node.b, seen, depth + 1);
		if (!a && !b) return null;
		if (!a || !b) return a ?? b;
		const ratio =
			typeof node.ratio === "number" && Number.isFinite(node.ratio)
				? Math.min(0.92, Math.max(0.08, node.ratio))
				: 0.5;
		return {
			id: freshId("split"),
			kind: "split",
			dir: node.dir === "col" ? "col" : "row",
			ratio,
			a,
			b,
		};
	}
	return null;
}

function projectKeyOf(cwd: string): string {
	return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function emptyState(): SidebarState {
	const tree = makeLeaf();
	return { tree, activePane: tree.id, tabs: [], activeId: null, dirty: {}, expanded: [] };
}

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
		let tree: SplitNode;
		let activePane: string | undefined;
		let expanded: string[] = [];
		try {
			const raw = localStorage.getItem(this.key);
			if (raw === null) return emptyState();
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const seen = new Set<string>();
			if (parsed && parsed.v === 2) {
				const sanitized = parsed.tree !== undefined ? sanitizeNode(parsed.tree, seen, 0) : null;
				tree = sanitized ?? makeLeaf();
				activePane = typeof parsed.activePane === "string" ? parsed.activePane : undefined;
			} else if (parsed && Array.isArray(parsed.tabs)) {
				// 旧版平面格式（v1）：整体迁成一个 leaf
				tree =
					sanitizeNode({ kind: "leaf", tabs: parsed.tabs, activeTab: parsed.activeId }, seen, 0) ?? makeLeaf();
			} else {
				return emptyState();
			}
			if (Array.isArray(parsed.expanded)) expanded = parsed.expanded.map(String);
		} catch {
			return emptyState();
		}
		const leaves: string[] = [];
		const collect = (node: SplitNode): void => {
			if (node.kind === "leaf") leaves.push(node.id);
			else {
				collect(node.a);
				collect(node.b);
			}
		};
		collect(tree);
		if (!activePane || !leaves.includes(activePane)) activePane = leaves[0];
		return this.snapshot(tree, activePane, expanded, {});
	}

	/** 树 → 对外快照：派生 tabs / activeId，消费者无感树结构。 */
	private snapshot(
		tree: SplitNode,
		activePane: string,
		expanded: string[],
		dirty: Record<string, boolean>,
	): SidebarState {
		const pane = findLeaf(tree, activePane) ?? firstLeaf(tree);
		return {
			tree,
			activePane: pane.id,
			tabs: flatten(tree, []),
			activeId: pane.activeTab,
			dirty,
			expanded,
		};
	}

	private write(): void {
		try {
			localStorage.setItem(
				this.key,
				JSON.stringify({
					v: 2,
					tree: this.state.tree,
					activePane: this.state.activePane,
					expanded: this.state.expanded,
				}),
			);
		} catch {
			// 配额满等场景：布局丢就丢，不能拖垮 UI
		}
	}

	private commit(
		next: Partial<Pick<SidebarState, "tree" | "activePane" | "expanded" | "dirty">>,
		opts?: { persist?: boolean },
	): void {
		this.state = this.snapshot(
			next.tree ?? this.state.tree,
			next.activePane ?? this.state.activePane,
			next.expanded ?? this.state.expanded,
			next.dirty ?? this.state.dirty,
		);
		if (opts?.persist !== false) this.write();
		for (const listener of this.listeners) listener();
	}

	/** 拖拽过程中的临时更新（分隔条调 ratio）不落盘，松手时 persist()。 */
	persist(): void {
		this.write();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getState = (): SidebarState => this.state;

	// -- 打开 tab -------------------------------------------------------------

	/** 打开单例 tab（files / changes / tasks / sidechat…）：全局去重，插入当前 leaf。 */
	openSingleton(kind: string, title?: string): void {
		const existing = this.state.tabs.find((tab) => tab.id === kind);
		if (existing !== undefined) {
			this.activate(kind);
			return;
		}
		this.insertTab({ id: kind, kind, title: title ?? kind });
	}

	/** 打开文件 tab（editor / image），按路径去重。 */
	openFileTab(kind: string, path: string, title: string): void {
		const id = `${kind}:${path}`;
		const existing = this.state.tabs.find((tab) => tab.id === id);
		if (existing !== undefined) {
			this.activate(id);
			return;
		}
		this.insertTab({ id, kind, title, path });
	}

	private insertTab(tab: SidebarTab): void {
		const pane = findLeaf(this.state.tree, this.state.activePane) ? this.state.activePane : firstLeaf(this.state.tree).id;
		const tree = replaceLeaf(this.state.tree, pane, (leaf) => ({
			...leaf,
			tabs: [...leaf.tabs, tab],
			activeTab: tab.id,
		}));
		this.commit({ tree, activePane: pane });
	}

	activate(id: string): void {
		const leaf = findLeafWithTab(this.state.tree, id);
		if (!leaf) return;
		const tree = replaceLeaf(this.state.tree, leaf.id, (l) => ({ ...l, activeTab: id }));
		this.commit({ tree, activePane: leaf.id });
	}

	activateLeaf(leafId: string): void {
		if (findLeaf(this.state.tree, leafId)) this.commit({ activePane: leafId });
	}

	closeTab(id: string): void {
		const leaf = findLeafWithTab(this.state.tree, id);
		if (!leaf) return;
		const index = leaf.tabs.findIndex((tab) => tab.id === id);
		const remaining = leaf.tabs.filter((tab) => tab.id !== id);
		const nextActive =
			leaf.activeTab === id ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? null) : leaf.activeTab;
		const pruned = prune(
			replaceLeaf(this.state.tree, leaf.id, (l) => ({ ...l, tabs: remaining, activeTab: nextActive })),
		);
		// leaf 空了就折叠；整树空则回到空 leaf（工作台空态卡片）
		const tree = pruned ?? makeLeaf();
		const dirty = { ...this.state.dirty };
		delete dirty[id];
		const activePane = findLeaf(tree, this.state.activePane) ? this.state.activePane : firstLeaf(tree).id;
		this.commit({ tree, activePane, dirty });
	}

	/** 关闭其他：leaf 内语义（只留该 leaf 的这个 tab），其他分屏不动。 */
	closeOthers(id: string): void {
		const leaf = findLeafWithTab(this.state.tree, id);
		if (!leaf) return;
		const tree = replaceLeaf(this.state.tree, leaf.id, (l) => ({ ...l, tabs: [l.tabs.find((tab) => tab.id === id)!], activeTab: id }));
		const dirty = this.state.dirty[id] ? { [id]: true } : {};
		this.commit({ tree, dirty });
	}

	// -- 拖拽分屏（dsh-better-sidebar 的 moveTab 语义） -----------------------

	/**
	 * 把 tab 拖到目标 leaf：center = 合并进该 leaf；边缘 = 把目标 leaf 切开
	 * 50/50，tab 落在新 leaf。来源 leaf 因此变空时自动折叠。
	 */
	moveTab(tabId: string, targetLeafId: string, zone: DropZone): void {
		const srcLeaf = findLeafWithTab(this.state.tree, tabId);
		const dstLeaf = findLeaf(this.state.tree, targetLeafId);
		if (!srcLeaf || !dstLeaf) return;
		const tab = srcLeaf.tabs.find((entry) => entry.id === tabId)!;

		if (srcLeaf.id === dstLeaf.id) {
			if (zone === "center" || srcLeaf.tabs.length === 1) {
				this.activate(tabId);
				return;
			}
			// 同 leaf 边缘 = 把自己切开
			const tree = removeTab(this.state.tree, tabId);
			if (!findLeaf(tree, targetLeafId)) return;
			const next = splitLeafAt(tree, targetLeafId, zone, tab);
			this.commit({ tree: next, activePane: targetLeafId });
			return;
		}

		const tree = removeTab(this.state.tree, tabId);
		if (!findLeaf(tree, targetLeafId)) return;
		const next =
			zone === "center"
				? replaceLeaf(tree, targetLeafId, (leaf) => ({ ...leaf, tabs: [...leaf.tabs, tab], activeTab: tab.id }))
				: splitLeafAt(tree, targetLeafId, zone, tab);
		this.commit({ tree: next, activePane: targetLeafId });
	}

	/** 分隔条拖拽调比例（夹 0.08–0.92，与 DSH 一致）；persist=false 时不落盘。 */
	setRatio(splitId: string, ratio: number, opts?: { persist?: boolean }): void {
		if (this.state.tree.kind !== "split") return;
		const tree = setRatioAt(this.state.tree, splitId, Math.min(0.92, Math.max(0.08, ratio)));
		this.commit({ tree }, { persist: opts?.persist });
	}

	setDirty(id: string, dirty: boolean): void {
		if (Boolean(this.state.dirty[id]) === dirty) return;
		const next = { ...this.state.dirty };
		if (dirty) next[id] = true;
		else delete next[id];
		this.commit({ dirty: next });
	}

	toggleExpanded(dir: string): void {
		const set = new Set(this.state.expanded);
		if (set.has(dir)) set.delete(dir);
		else set.add(dir);
		this.commit({ expanded: [...set] });
	}

	/** 展开一条路径的全部祖先（搜索结果定位用），目录本身不展开。 */
	expandTo(path: string): void {
		const segments = path.split("/").filter(Boolean);
		const set = new Set(this.state.expanded);
		let prefix = "";
		for (let index = 0; index < segments.length - 1; index += 1) {
			prefix = prefix === "" ? segments[index]! : `${prefix}/${segments[index]}`;
			set.add(prefix);
		}
		this.commit({ expanded: [...set] });
	}

	/** 路径重命名后同步已开的文件 tab（id/title/path）与展开目录。 */
	remapPath(oldPath: string, newPath: string): void {
		const mapOne = (path: string): string =>
			path === oldPath || path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
		const remapLeaf = (node: SplitNode): SplitNode => {
			if (node.kind === "leaf") {
				return {
					...node,
					tabs: node.tabs.map((tab) => {
						if (tab.path === undefined) return tab;
						const mapped = mapOne(tab.path);
						if (mapped === tab.path) return tab;
						return { ...tab, id: `${tab.kind}:${mapped}`, path: mapped, title: mapped.split("/").pop() ?? mapped };
					}),
				};
			}
			return { ...node, a: remapLeaf(node.a), b: remapLeaf(node.b) };
		};
		const tree = remapLeaf(this.state.tree);
		const expanded = this.state.expanded.map(mapOne);
		this.commit({ tree, expanded });
	}

	/** 移除已删路径的文件 tab 与展开目录（空 leaf 折叠）。 */
	dropPath(path: string): void {
		const affected = (target: string): boolean => target === path || target.startsWith(`${path}/`);
		const stripLeaf = (node: SplitNode): SplitNode => {
			if (node.kind === "leaf") {
				return { ...node, tabs: node.tabs.filter((tab) => tab.path === undefined || !affected(tab.path)) };
			}
			return { ...node, a: stripLeaf(node.a), b: stripLeaf(node.b) };
		};
		const dirty = { ...this.state.dirty };
		for (const tab of this.state.tabs) {
			if (tab.path !== undefined && affected(tab.path)) delete dirty[tab.id];
		}
		const pruned = prune(stripLeaf(this.state.tree));
		const tree = pruned ?? makeLeaf();
		const activePane = findLeaf(tree, this.state.activePane) ? this.state.activePane : firstLeaf(tree).id;
		const expanded = this.state.expanded.filter((dir) => !affected(dir));
		this.commit({ tree, activePane, dirty, expanded });
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
