/**
 * 工作台外壳 —— 移植 dsh-better-sidebar 的双工作台布局：同一组 tab 可以停靠
 * 在右列（width 拖拽）或聊天列底部（height 拖拽，顶缘拉伸手柄）。内容区是
 * split tree（store.ts）：每个 leaf 一条 tab 条，tab 按住拖到另一个 leaf 的
 * 边缘 25% 区域切开 50/50、拖到中心合并（split-pane.tsx 的 zoneAt 同规则，
 * 用指针事件自绘拖拽而非 HTML5 DnD，WebView2 下更稳也更好测）；分隔条可拖
 * 调比例。所有 tab 保持挂载、非激活的隐藏（编辑器草稿不丢）；fs_changed 在
 * 这里统一接桥分发 + 防抖刷新 Git 快照。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { GitStatusResult } from "../bridge/protocol.ts";
import { createSidebarApi } from "./api.ts";
import { registerBuiltins } from "./builtins.tsx";
import { IconGitBranch, IconLoader, IconPanelBottom, IconPanelRight, IconX } from "./icons.tsx";
import { normProjectKey, type DropZone, type SidebarStore, type SidebarTab, type SplitNode, useSidebarState } from "./store.ts";
import { useTabRegistry, type TabComponentProps } from "./registry.ts";
import { isTabKindEnabled, useSidebarConfig, viewerKindForPath } from "./config.ts";
import { QUICK_ACTIONS, openQuickAction } from "./quick.tsx";
import { fileUrlOf } from "./api.ts";
import "./workbench-design.css";

const WIDTH_KEY = "owl.workbench.width";
const HEIGHT_KEY = "owl.workbench.height";

export type WorkbenchDock = "right" | "bottom";

export interface WorkbenchProps {
	client: BridgeClient;
	/** 项目目录（App 显式跟踪的工作区）。 */
	cwd: string;
	/** App 持有的 store（与开始页快捷入口共用同一实例）。 */
	store: SidebarStore;
	open: boolean;
	onSetOpen: (open: boolean) => void;
	dock: WorkbenchDock;
	onSetDock: (dock: WorkbenchDock) => void;
	/** Presentation preference only; the conversation and tool permissions stay in App. */
	developerLayout?: boolean;
}

const HEIGHT_MIN = 140;
const WIDTH_MIN = 280;
const DESIGNED_TAB_KINDS = new Set(["files", "changes", "editor", "terminal", "browser", "tasks", "impression", "image", "document"]);

interface DragState {
	id: string;
	title: string;
	x: number;
	y: number;
}

interface DropTarget {
	leafId: string;
	zone: DropZone;
}

/** 落点 → 遮罩样式（DSH：边缘 25% 实心高亮，中心虚线框）。 */
const ZONE_OVERLAY: Record<DropZone, string> = {
	left: "top-0 bottom-0 left-0 w-1/4 bg-owl-accent/20",
	right: "top-0 bottom-0 right-0 w-1/4 bg-owl-accent/20",
	up: "top-0 left-0 right-0 h-1/4 bg-owl-accent/20",
	down: "bottom-0 left-0 right-0 h-1/4 bg-owl-accent/20",
	center: "inset-[25%] border-2 border-dashed border-owl-accent/80",
};

export function Workbench({ client, cwd, store, open, onSetOpen, dock, onSetDock, developerLayout = false }: WorkbenchProps): React.JSX.Element {
	const api = useMemo(() => createSidebarApi(client), [client]);
	const registry = useTabRegistry();
	const state = useSidebarState(store);
	const activeTab = state.tabs.find((tab) => tab.id === state.activeId);
	const activeDefinition = activeTab === undefined ? undefined : registry.byKind.get(activeTab.kind);
	// 侧边卡片配置（设置页「侧边卡片」）：工具行/空态卡片的可见性与文件预览回退
	const cfg = useSidebarConfig();
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

	// -- 拖拽分屏：指针自绘（leaf rect 命中 → 25% 边缘分区） -------------------
	const [dragTab, setDragTab] = useState<DragState | null>(null);
	const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
	const dropTargetRef = useRef<DropTarget | null>(null);
	const leafRefs = useRef(new Map<string, HTMLElement>());
	// 拖完的 click 抑制：mouseup 后 click 才派发，setTimeout(0) 复位来得及
	const justDraggedRef = useRef(false);

	const hitTest = useCallback((x: number, y: number): void => {
		let hit: DropTarget | null = null;
		for (const [leafId, el] of leafRefs.current) {
			const rect = el.getBoundingClientRect();
			if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue;
			const rx = (x - rect.left) / rect.width;
			const ry = (y - rect.top) / rect.height;
			const zone: DropZone = rx < 0.25 ? "left" : rx > 0.75 ? "right" : ry < 0.25 ? "up" : ry > 0.75 ? "down" : "center";
			hit = { leafId, zone };
			break;
		}
		const current = dropTargetRef.current;
		if ((current?.leafId ?? null) !== (hit?.leafId ?? null) || (current !== null && hit !== null && current.zone !== hit.zone)) {
			dropTargetRef.current = hit;
			setDropTarget(hit);
		}
	}, []);

	const beginTabDrag = useCallback(
		(tab: SidebarTab, e: React.MouseEvent): void => {
			if (e.button !== 0) return;
			e.preventDefault();
			const startX = e.clientX;
			const startY = e.clientY;
			let started = false;
			const onMove = (m: MouseEvent): void => {
				if (!started) {
					if (Math.abs(m.clientX - startX) + Math.abs(m.clientY - startY) < 5) return;
					started = true;
					justDraggedRef.current = true;
				}
				// 同步更新：mousemove 本身与浏览器帧对齐（原生节流），
				// 不排 rAF——后台/节流窗口里 rAF 会停摆，拖拽会整个卡死。
				setDragTab({ id: tab.id, title: tab.title, x: m.clientX, y: m.clientY });
				hitTest(m.clientX, m.clientY);
			};
			const onUp = (): void => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				const target = dropTargetRef.current;
				if (started && target) store.moveTab(tab.id, target.leafId, target.zone);
				setDragTab(null);
				setDropTarget(null);
				dropTargetRef.current = null;
				window.setTimeout(() => {
					justDraggedRef.current = false;
				}, 0);
			};
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
		},
		[hitTest, store],
	);

	// -- 分隔条拖拽：比例写 ref 态（不落盘），松手 persist --------------------
	const startDividerDrag = useCallback(
		(node: Extract<SplitNode, { kind: "split" }>, e: React.MouseEvent): void => {
			e.preventDefault();
			const parent = (e.currentTarget as HTMLElement).parentElement;
			if (!parent) return;
			const rect = parent.getBoundingClientRect();
			const onMove = (m: MouseEvent): void => {
				const ratio =
					node.dir === "row" ? (m.clientX - rect.left) / rect.width : (m.clientY - rect.top) / rect.height;
				store.setRatio(node.id, ratio, { persist: false });
			};
			const onUp = (): void => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				store.persist();
			};
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
		},
		[store],
	);

	// -- Git 状态快照：项目切换 / fs_changed（防抖）/ 主动刷新 ----------------
	const refreshGit = useCallback(() => {
		void api
			.gitStatus(cwd)
			.then((result) => setGitStatus(result))
			.catch(() => setGitStatus({ repo: false, entries: [] }));
	}, [api, cwd]);

	useEffect(() => {
		const offStatus = client.onStatus((connected) => {
			if (connected) refreshGit();
		});
		refreshGit();
		return offStatus;
	}, [client, refreshGit]);

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
			if (event.cwd !== undefined && normProjectKey(String(event.cwd)) !== normProjectKey(cwd)) return;
			const dirs = Array.isArray(event.dirs) ? event.dirs.map(String) : [];
			store.fsChanged(dirs);
		});
	}, [client, store, cwd]);

	// -- 打开文件（viewer 匹配 + 侧边卡片停用回退） ------------------------------
	const openFile = useCallback(
		(path: string) => {
			const kind = viewerKindForPath(path, cfg);
			if (kind === undefined) {
				// 预览卡片停用（如关掉「代码」兜底）：交给系统默认程序，工作台不再接管
				void api.openExternal("url", fileUrlOf(cwd, path)).catch(() => {});
				return;
			}
			const title = path.split("/").pop() ?? path;
			store.openFileTab(kind, path, title);
			if (!open) onSetOpen(true);
		},
		[api, cfg, cwd, store, open, onSetOpen],
	);

	// -- 停用卡片即时收尾：关掉已打开的同类 tab（与 DSH 停用插件关 tab 同语义） -
	useEffect(() => {
		for (const tab of state.tabs) {
			if (!isTabKindEnabled(tab.kind, cfg)) store.closeTab(tab.id);
		}
	}, [cfg, state.tabs, store]);

	const tabPropsOf = useCallback(
		(tabId: string): TabComponentProps => ({
			api,
			store,
			cwd,
			client,
			tab: state.tabs.find((tab) => tab.id === tabId)!,
			onOpenFile: openFile,
			gitStatus,
			onGitRefresh: refreshGit,
		}),
		[api, store, cwd, client, state.tabs, openFile, gitStatus, refreshGit],
	);

	// -- 拖拽调宽 / 调高（工作台外壳；拖拽期间走 ref，松手时持久化） ----------
	const sizeRef = useRef(dock === "right" ? width : height);
	sizeRef.current = dock === "right" ? width : height;
	const startResize = (e: React.MouseEvent): void => {
		e.preventDefault();
		const origin = sizeRef.current;
		const startX = e.clientX;
		const startY = e.clientY;
		const maxSide =
			dock === "right" ? Math.max(window.innerWidth * 0.6, 420) : Math.max(window.innerHeight * 0.7, 320);
		const onMove =
			dock === "right"
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

	// -- split tree 渲染 -------------------------------------------------------
	const renderNode = (node: SplitNode, style: React.CSSProperties): React.JSX.Element => {
		if (node.kind === "split") {
			return (
				<div key={node.id} style={style} className={`flex min-h-0 min-w-0 ${node.dir === "row" ? "flex-row" : "flex-col"}`}>
					{renderNode(node.a, { flex: `${node.ratio * 100} 1 0%` })}
					{/* 分隔条：7px 命中区 + 居中 1px 细线（DSH divider 同款） */}
					<div
						role="separator"
						className={`group relative z-10 shrink-0 ${node.dir === "row" ? "-mx-1 w-2 cursor-col-resize" : "-my-1 h-2 cursor-row-resize"}`}
						onMouseDown={(e) => startDividerDrag(node, e)}
					>
						<div
							className={`absolute bg-owl-border/50 transition-colors group-hover:bg-owl-accent/60 ${
								node.dir === "row" ? "inset-y-0 left-1/2 w-px -translate-x-1/2" : "inset-x-0 top-1/2 h-px -translate-y-1/2"
							}`}
						/>
					</div>
					{renderNode(node.b, { flex: `${(1 - node.ratio) * 100} 1 0%` })}
				</div>
			);
		}

		const leaf = node;
		return (
			<section
				key={leaf.id}
				ref={(el) => {
					if (el) leafRefs.current.set(leaf.id, el);
					else leafRefs.current.delete(leaf.id);
				}}
				style={style}
				className="owl-workbench-leaf relative flex min-h-0 min-w-0 flex-col overflow-hidden"
			>
				{/* leaf 的 tab 条 */}
				{leaf.tabs.length > 0 && (
					<div className="owl-workbench-tabs flex shrink-0 select-none items-stretch overflow-x-auto" aria-label="已打开的工作台标签">
						{leaf.tabs.map((tab) => {
							const def = registry.byKind.get(tab.kind);
							const isActive = tab.id === leaf.activeTab;
							return (
								<div
									key={tab.id}
									role="button"
									tabIndex={0}
									title={tab.path ?? tab.title}
									aria-label={tab.title}
									aria-pressed={isActive}
									onMouseDown={(e) => beginTabDrag(tab, e)}
									onClick={() => {
										if (!justDraggedRef.current) store.activate(tab.id);
									}}
									onAuxClick={(e) => {
										if (e.button === 1) store.closeTab(tab.id);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											store.activate(tab.id);
										}
									}}
									className={`owl-workbench-tab group ${isActive ? "is-active" : ""}`}
								>
									{def?.icon(14)}
									<span className="min-w-0 truncate">{tab.title}</span>
									{state.dirty[tab.id] === true && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-owl-accent" title="未保存" />}
									<button
										type="button"
										className="owl-workbench-tab-close"
										title={`关闭 ${tab.title}`}
										aria-label={`关闭 ${tab.title}`}
										onMouseDown={(e) => e.stopPropagation()}
										onKeyDown={(e) => e.stopPropagation()}
										onClick={(e) => {
											e.stopPropagation();
											store.closeTab(tab.id);
										}}
									>
										<IconX size={12} />
									</button>
								</div>
							);
						})}
					</div>
				)}

				{/* 内容区：所有 tab 常挂载、非激活隐藏（编辑器草稿不丢） */}
				<div className="relative min-h-0 flex-1 overflow-hidden">
					{leaf.tabs.length === 0 ? (
						/* 空 leaf：DSH paneEmptyCards 同款卡片（放进当前 leaf） */
						<div className="owl-workbench-empty grid h-full content-start gap-2.5 overflow-y-auto [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
							<div className="owl-workbench-empty-heading">
								<strong>打开你的工作工具</strong>
								<p>文件、代码和执行结果，在同一个工作台查看。</p>
							</div>
							{QUICK_ACTIONS.filter((action) => !action.disabled && isTabKindEnabled(action.kind, cfg)).map((action) => (
								<button
									key={action.kind}
									type="button"
									className="owl-workbench-empty-card flex min-h-12 items-center gap-3 px-3.5 text-left"
									onClick={() => {
										store.activateLeaf(leaf.id);
										openQuickAction(store, action.kind);
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
						leaf.tabs.map((tab) => {
							const def = registry.byKind.get(tab.kind);
							if (def === undefined) return null;
							const Component = def.component;
							const isActive = tab.id === leaf.activeTab;
							return (
								<div
									key={tab.id}
									data-tab-kind={tab.kind}
									className={`owl-workbench-pane ${DESIGNED_TAB_KINDS.has(tab.kind) ? "owl-workbench-designed-pane" : ""} h-full ${isActive ? "" : "hidden"}`}
								>
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

				{/* 拖放落点遮罩 */}
				{dropTarget?.leafId === leaf.id && (
					<div className={`pointer-events-none absolute z-20 rounded-sm ${ZONE_OVERLAY[dropTarget.zone]}`} />
				)}
			</section>
		);
	};

	const dockButtonClass = (active: boolean): string => `owl-workbench-icon-button ${active ? "is-active" : ""}`;

	return (
		<aside
			className={`owl-workbench-shell ${open ? "" : "hidden"} relative flex flex-col ${
				dock === "right" ? "shrink-0 border-l" : "w-full shrink-0 border-t"
			}`}
			aria-label={developerLayout ? "开发工作台" : "工作台"}
			data-layout={developerLayout ? "developer" : "tools"}
			data-dock={dock}
			style={dock === "right" ? { width } : { height }}
		>
			{/* 拖拽条：右停靠在左缘调宽，底停靠在顶缘调高 */}
			{dock === "right" ? (
				<div className="absolute top-0 left-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-owl-accent/40" onMouseDown={startResize} />
			) : (
				<div className="absolute top-0 right-0 left-0 z-20 h-1 cursor-row-resize transition-colors hover:bg-owl-accent/40" onMouseDown={startResize} />
			)}

			{/* 工作台标题、工具入口与固定停靠操作 */}
			<div className="owl-workbench-bar" data-tauri-drag-region="deep">
				<div className="owl-workbench-heading" title={activeTab?.title ?? "工作台"}>
					{activeDefinition?.icon(14) ?? <IconPanelRight size={14} />}
					<span>{developerLayout ? "开发工作台" : activeTab?.title ?? "工作台"}</span>
				</div>
				<div className="owl-workbench-shortcuts" aria-label="工作台工具">
					{QUICK_ACTIONS.filter((action) => !action.disabled && isTabKindEnabled(action.kind, cfg)).map((action) => {
						const active = activeTab?.kind === action.kind;
						return (
							<button
								key={action.kind}
								type="button"
								title={action.label}
								aria-label={action.label}
								className={`owl-workbench-icon-button ${active ? "is-active" : ""}`}
								onClick={() => openQuickAction(store, action.kind)}
							>
								{action.icon(15)}
							</button>
						);
					})}
				</div>
				<div className="owl-workbench-dock-actions">
					<button type="button" title="停靠到右列" aria-label="停靠到右列" className={dockButtonClass(dock === "right")} onClick={() => onSetDock("right")}>
						<IconPanelRight size={14} />
					</button>
					<button type="button" title="停靠到底部" aria-label="停靠到底部" className={dockButtonClass(dock === "bottom")} onClick={() => onSetDock("bottom")}>
						<IconPanelBottom size={14} />
					</button>
					<button type="button" title="关闭工作台" aria-label="关闭工作台" className="owl-workbench-icon-button" onClick={() => onSetOpen(false)}>
						<IconX size={14} />
					</button>
				</div>
			</div>

			{/* 内容：split tree（空 leaf 显示入口卡片） */}
			<div className="flex min-h-0 flex-1 flex-col">{renderNode(state.tree, { flex: "1 1 0%" })}</div>

			{/* 跟随光标的拖拽浮签 */}
			{dragTab && (
				<div
					className="pointer-events-none fixed z-50 max-w-48 truncate rounded-md border border-owl-border bg-owl-panel px-2 py-1 text-xs text-owl-text shadow-xl"
					style={{ left: dragTab.x + 10, top: dragTab.y + 10 }}
				>
					{dragTab.title}
				</div>
			)}

			{/* 状态条：git 分支 + 桥状态占位 */}
			<div className="owl-workbench-status">
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
