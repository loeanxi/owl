/**
 * 工作台外壳 —— 移植 dsh-better-sidebar 的双工作台布局：同一组 tab 可以停靠
 * 在右列（width 拖拽）或聊天列底部（height 拖拽，顶缘拉伸手柄），对应 DSH 的
 * bottomPanel / 原生右栏。所有 tab 保持挂载、非激活的隐藏（编辑器草稿不丢）；
 * fs_changed 事件在这里统一接桥并分发（store.onFsChanged）+ 防抖刷新 Git 快照。
 *
 * 与上游差异：owl 自己就是宿主，不需要 portal + 中心列测量那套——底部停靠
 * 直接参与聊天列的 flex 流（ChatStream / Composer 之上、底部栏之下）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { GitStatusResult } from "../bridge/protocol.ts";
import { createSidebarApi } from "./api.ts";
import { registerBuiltins } from "./builtins.tsx";
import { IconGitBranch, IconLoader, IconPanelBottom, IconPanelRight, IconX } from "./icons.tsx";
import { normProjectKey, type SidebarStore, useSidebarState } from "./store.ts";
import { useTabRegistry, viewerKindFor, type TabComponentProps } from "./registry.ts";
import { isImagePath } from "./registry.ts";
import { QUICK_ACTIONS } from "./quick.tsx";

const WIDTH_KEY = "owl.workbench.width";
const HEIGHT_KEY = "owl.workbench.height";

/** 单例快捷 tab：固定在工具行，不进 tab 条（与 DSH 的固定入口同规则）。 */
const SINGLETON_KINDS = new Set(QUICK_ACTIONS.map((action) => action.kind));

export type WorkbenchDock = "right" | "bottom";

export interface WorkbenchProps {
	client: BridgeClient;
	/** 项目目录（App 显式跟踪的工作区）。 */
	cwd: string;
	/** App 持有的 store（底部栏 / 工作台共用同一实例）。 */
	store: SidebarStore;
	open: boolean;
	onSetOpen: (open: boolean) => void;
	dock: WorkbenchDock;
	onSetDock: (dock: WorkbenchDock) => void;
}

const HEIGHT_MIN = 140;
const WIDTH_MIN = 280;

export function Workbench({ client, cwd, store, open, onSetOpen, dock, onSetDock }: WorkbenchProps): React.JSX.Element {
	// store 由 App 按项目创建下发（底部栏共用）；这里只跟随项目 key 变化刷新。
	const projectKey = normProjectKey(cwd);
	const api = useMemo(() => createSidebarApi(client), [client]);
	const registry = useTabRegistry();
	const state = useSidebarState(store);
	const [gitStatus, setGitStatus] = useState<GitStatusResult | undefined>(undefined);
	const [width, setWidth] = useState(() => {
		const saved = Number(localStorage.getItem(WIDTH_KEY));
		return saved >= WIDTH_MIN ? saved : 380;
	});
	const [height, setHeight] = useState(() => {
		const saved = Number(localStorage.getItem(HEIGHT_KEY));
		return saved >= HEIGHT_MIN ? saved : 260;
	});
	const gitTimer = useRef<number | undefined>(undefined);

	registerBuiltins();

	// -- Git 状态快照：项目切换 / fs_changed（防抖）/ 主动刷新 ----------------
	const refreshGit = useCallback(() => {
		void api
			.gitStatus(cwd)
			.then((result) => setGitStatus(result))
			.catch(() => setGitStatus({ repo: false, entries: [] }));
	}, [api, cwd]);

	useEffect(() => {
		refreshGit();
	}, [refreshGit]);

	useEffect(() => {
		return store.onFsChanged(() => {
			if (gitTimer.current !== undefined) window.clearTimeout(gitTimer.current);
			gitTimer.current = window.setTimeout(refreshGit, 400);
		});
	}, [store, refreshGit]);

	// -- 桥事件 → store 总线 ---------------------------------------------------
	useEffect(() => {
		return client.onSessionEvent((message) => {
			const event = message.event as { type?: string; cwd?: string; dirs?: unknown };
			if (event.type !== "fs_changed") return;
			if (event.cwd !== undefined && normProjectKey(String(event.cwd)) !== projectKey) return;
			const dirs = Array.isArray(event.dirs) ? event.dirs.map(String) : [];
			store.fsChanged(dirs);
		});
	}, [client, store, projectKey]);

	// -- 打开文件（viewer 匹配） ----------------------------------------------
	const openFile = useCallback(
		(path: string) => {
			const kind = isImagePath(path) ? "image" : viewerKindFor(path);
			const title = path.split("/").pop() ?? path;
			store.openFileTab(kind, path, title);
			if (!open) onSetOpen(true);
		},
		[store, open, onSetOpen],
	);

	// -- 拖拽调宽 / 调高（拖拽期间走 ref，松手时持久化） -----------------------
	const sizeRef = useRef(dock === "right" ? width : height);
	sizeRef.current = dock === "right" ? width : height;
	const startResize = (e: React.MouseEvent): void => {
		e.preventDefault();
		const origin = sizeRef.current;
		const startX = e.clientX;
		const startY = e.clientY;
		const maxSide =
			dock === "right"
				? Math.max(window.innerWidth * 0.6, 420)
				: Math.max(window.innerHeight * 0.7, 320);
		const onMove = dock === "right"
			? (move: MouseEvent): void => {
					const next = Math.min(Math.max(window.innerWidth - move.clientX, WIDTH_MIN), maxSide);
					sizeRef.current = next;
					setWidth(next);
				}
			: (move: MouseEvent): void => {
					// 顶缘向上拖 = 变高（与 DSH 的 bottomResize 同方向语义）
					const next = Math.min(Math.max(origin + (startY - move.clientY), HEIGHT_MIN), maxSide);
					sizeRef.current = next;
					setHeight(next);
				};
		const onUp = (): void => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			localStorage.setItem(dock === "right" ? WIDTH_KEY : HEIGHT_KEY, String(sizeRef.current));
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	const activeTab = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs.at(-1);

	// 激活非最前 tab 时的内容渲染集合（全部挂载，非激活隐藏）。
	const tabPropsOf = (tabId: string): TabComponentProps => ({
		api,
		store,
		cwd,
		client,
		tab: state.tabs.find((tab) => tab.id === tabId)!,
		onOpenFile: openFile,
		gitStatus,
		onGitRefresh: refreshGit,
	});

	const dynamicTabs = state.tabs.filter((tab) => !SINGLETON_KINDS.has(tab.kind));

	const dockButtonClass = (active: boolean): string =>
		`rounded-md p-1.5 transition-colors ${active ? "bg-owl-hover text-owl-text" : "text-owl-faint hover:bg-owl-hover hover:text-owl-text"}`;

	return (
		<aside
			className={`${open ? "" : "hidden"} relative flex ${
				dock === "right" ? "shrink-0 border-l" : "w-full shrink-0 border-t"
			} border-owl-border/60 bg-owl-sidebar`}
			style={dock === "right" ? { width } : { height }}
		>
			{/* 拖拽条：右停靠在左缘调宽，底停靠在顶缘调高 */}
			{dock === "right" ? (
				<div className="absolute top-0 left-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-owl-accent/40" onMouseDown={startResize} />
			) : (
				<div className="absolute top-0 right-0 left-0 z-20 h-1 cursor-row-resize transition-colors hover:bg-owl-accent/40" onMouseDown={startResize} />
			)}

			{/* 工具行：快捷单例（彩色图标）+ 停靠切换 + 关闭 */}
			<div className="flex shrink-0 select-none items-center gap-1 border-b border-owl-border/60 px-2 py-1.5" data-tauri-drag-region="deep">
				{QUICK_ACTIONS.filter((action) => !action.disabled).map((action) => {
					const opened = state.tabs.some((tab) => tab.kind === action.kind);
					const active = opened && activeTab?.kind === action.kind;
					return (
						<button
							key={action.kind}
							type="button"
							title={action.label}
							className={`flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs transition-colors ${
								active ? "bg-owl-hover text-owl-text" : "text-owl-muted hover:bg-owl-hover hover:text-owl-text"
							}`}
							onClick={() => store.openSingleton(action.kind, registry.byKind.get(action.kind)?.title ?? action.label)}
						>
							<span style={{ color: action.color }}>{action.icon(14)}</span>
						</button>
					);
				})}
				{dynamicTabs.length > 4 && <span className="ml-1 text-[10px] text-owl-faint">{state.tabs.length} 个标签</span>}
				<div className="flex-1" data-tauri-drag-region="deep" />
				<button type="button" title="停靠到右列" aria-label="停靠到右列" className={dockButtonClass(dock === "right")} onClick={() => onSetDock("right")}>
					<IconPanelRight size={14} />
				</button>
				<button type="button" title="停靠到底部" aria-label="停靠到底部" className={dockButtonClass(dock === "bottom")} onClick={() => onSetDock("bottom")}>
					<IconPanelBottom size={14} />
				</button>
				<button type="button" title="关闭工作台" className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text" onClick={() => onSetOpen(false)}>
					<IconX size={14} />
				</button>
			</div>

			{/* TabBar（文件 tab：按路径去重的编辑器/图片页） */}
			{dynamicTabs.length > 0 && (
				<div className="flex shrink-0 select-none items-stretch overflow-x-auto border-b border-owl-border/40 bg-owl-rail/60">
					{dynamicTabs.map((tab) => {
						const def = registry.byKind.get(tab.kind);
						const isActive = tab.id === activeTab?.id;
						return (
							<div
								key={tab.id}
								role="button"
								tabIndex={0}
								title={tab.path}
								onClick={() => store.activate(tab.id)}
								onAuxClick={(e) => {
									if (e.button === 1) store.closeTab(tab.id);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") store.activate(tab.id);
								}}
								className={`group flex max-w-44 shrink-0 cursor-pointer items-center gap-1.5 border-r border-owl-border/30 px-2.5 py-1.5 text-xs ${
									isActive ? "bg-owl-sidebar text-owl-text" : "text-owl-muted hover:text-owl-text"
								}`}
							>
								{def?.icon(12)}
								<span className="min-w-0 truncate">{tab.title}</span>
								{state.dirty[tab.id] === true && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-owl-accent" title="未保存" />}
								<button
									type="button"
									className="ml-0.5 shrink-0 rounded p-0.5 text-owl-faint opacity-0 group-hover:opacity-100 hover:bg-owl-hover hover:text-owl-text"
									onClick={(e) => {
										e.stopPropagation();
										store.closeTab(tab.id);
									}}
								>
									<IconX size={10} />
								</button>
							</div>
						);
					})}
				</div>
			)}

			{/* 内容区：所有 tab 常挂载、非激活隐藏（编辑器草稿不丢） */}
			<div className="min-h-0 flex-1 overflow-hidden">
				{state.tabs.length === 0 ? (
					/* 空态卡片：DSH paneEmptyCards 同款网格（胶囊卡 + 彩色图标） */
					<div className="grid h-full content-start gap-2.5 overflow-y-auto p-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
						{QUICK_ACTIONS.filter((action) => !action.disabled).map((action) => (
							<button
								key={action.kind}
								type="button"
								className="flex min-h-12 items-center gap-3 rounded-xl border border-owl-border/60 bg-owl-panel px-3.5 text-left text-xs text-owl-text transition-colors hover:bg-owl-hover"
								onClick={() => {
									store.openSingleton(action.kind, registry.byKind.get(action.kind)?.title ?? action.label);
								}}
							>
								<span className="shrink-0" style={{ color: action.color }}>
									{action.icon(16)}
								</span>
								<span>{action.label}</span>
							</button>
						))}
					</div>
				) : (
					state.tabs.map((tab) => {
						const def = registry.byKind.get(tab.kind);
						if (def === undefined) return null;
						const Component = def.component;
						const isActive = tab.id === activeTab?.id;
						return (
							<div key={tab.id} className={`h-full ${isActive ? "" : "hidden"}`}>
								<Suspense
									fallback={
										<div className="flex h-full items-center justify-center">
											<IconLoader size={18} className="animate-spin text-owl-faint" />
										</div>
									}
								>
									<Component {...tabPropsOf(tab.id)} />
								</Suspense>
							</div>
						);
					})
				)}
			</div>

			{/* 状态条：git 分支 + 桥状态占位 */}
			<div className="flex shrink-0 items-center gap-2 border-t border-owl-border/40 px-2.5 py-1 text-[10px] text-owl-faint">
				{gitStatus === undefined ? (
					<IconLoader size={10} className="animate-spin" />
				) : gitStatus.repo ? (
					<>
						<IconGitBranch size={10} />
						<span className="truncate">{gitStatus.branch ?? "HEAD"}</span>
						<span className="ml-auto shrink-0">{gitStatus.entries.length} 个变更</span>
					</>
				) : (
					<span>非 Git 仓库</span>
				)}
			</div>
		</aside>
	);
}
