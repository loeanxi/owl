/**
 * 工作台外壳 —— 移植 dsh-better-sidebar 的双工作台布局：同一套外壳按 role
 * 装两份实例。tools = 右列工具侧栏（width 拖拽），terminal = 底栏终端专用
 * （height 拖拽，顶缘拉伸手柄）；两份实例各挂各的 store，可在界面上共存。
 * 内容区是 split tree（store.ts）：每个 leaf 一条 tab 条，tab 按住拖到另一个
 * leaf 的边缘 25% 区域切开 50/50、拖到中心合并（split-pane.tsx 的 zoneAt 同规则，
 * 用指针事件自绘拖拽而非 HTML5 DnD，WebView2 下更稳也更好测）；分隔条可拖
 * 调比例。所有 tab 保持挂载、非激活的隐藏（编辑器草稿不丢）；fs_changed 在
 * 这里统一接桥分发 + 防抖刷新 Git 快照。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { GitStatusResult } from "../bridge/protocol.ts";
import { FileIcon } from "../file-icons/FileIcon.tsx";
import { useT } from "../i18n/index.ts";
import { createSidebarApi } from "./api.ts";
import { registerBuiltins } from "./builtins.tsx";
import { IconFile, IconGitBranch, IconLoader, IconPanelRight, IconPlus, IconX } from "./icons.tsx";
import { normProjectKey, type DropZone, type SidebarStore, type SidebarTab, type SplitNode, useSidebarState } from "./store.ts";
import { SplitDivider } from "./SplitDivider.tsx";
import { useTabRegistry, type TabComponentProps } from "./registry.ts";
import { isTabKindEnabled, useSidebarConfig, viewerKindForPath } from "./config.ts";
import { QUICK_ACTIONS, IconDrama, IconTerminal, openQuickAction } from "./quick.tsx";
import { fileUrlOf } from "./api.ts";
import { attachPluginViewers } from "./plugin-viewers.ts";
import { PluginViewerTab } from "./tabs/PluginViewerTab.tsx";
import { startPointerDrag, type PointerDragHandlers } from "./pointer-drag.ts";
import { CONVERSATION_MIN_HEIGHT, CONVERSATION_MIN_WIDTH, fitPaneSize, WORKBENCH_MIN_HEIGHT, WORKBENCH_MIN_WIDTH, workbenchDock } from "./pane-sizing.ts";
import { usePaneContainer } from "./use-pane-container.ts";
import { WorkbenchTools } from "./WorkbenchTools.tsx";
import { EditorCloseDialog } from "./EditorCloseDialog.tsx";
import { EditorDraftRecovery } from "./EditorDraftRecovery.tsx";
import { clearSidebarNotice, useSidebarNotice } from "./notice.ts";
import "./workbench-design.css";
import "./responsive-panes.css";

const WIDTH_KEY = "owl.workbench.width";
const HEIGHT_KEY = "owl.workbench.height";
const COMPACT_HEIGHT_KEY = "owl.workbench.compactHeight";

export type WorkbenchDock = "right" | "bottom";

/** 面板角色：tools = 右侧工具侧栏；terminal = 底栏终端；mirror = 短剧（机器级全局面板）。 */
export type WorkbenchRole = "tools" | "terminal" | "mirror";

/** 每个面板实例能装的 tab kind：工具侧栏装除终端/短剧外的工具；终端底栏只装终端；短剧面板只装短剧。 */
const ROLE_KINDS: Record<WorkbenchRole, (kind: string) => boolean> = {
	tools: (kind) => kind !== "terminal" && kind !== "mirror",
	terminal: (kind) => kind === "terminal",
	mirror: (kind) => kind === "mirror",
};

/** 每个面板的尺寸持久化键：短剧面板用自己的，不与终端底栏抢高度。 */
const ROLE_SIZE_KEYS: Record<WorkbenchRole, { width: string; height: string; compactHeight: string }> = {
	tools: { width: WIDTH_KEY, height: HEIGHT_KEY, compactHeight: COMPACT_HEIGHT_KEY },
	terminal: { width: WIDTH_KEY, height: HEIGHT_KEY, compactHeight: COMPACT_HEIGHT_KEY },
	mirror: { width: "owl.mirror.width", height: "owl.mirror.height", compactHeight: "owl.mirror.compactHeight" },
};

export interface WorkbenchProps {
	client: BridgeClient;
	/** 项目目录（App 显式跟踪的工作区）。 */
	cwd: string;
	profile?: string;
	connected?: boolean;
	/** App 持有的 store（与开始页快捷入口共用同一实例）。 */
	store: SidebarStore;
	open: boolean;
	onSetOpen: (open: boolean) => void;
	dock: WorkbenchDock;
	/** 角色：底栏实例只装终端，短剧面板只装短剧，侧栏实例装其余工具（App 保证 store 内容匹配）。 */
	role?: WorkbenchRole;
	/** 独立面板入口（短剧）：点菜单里的短剧时开机器级面板，而不是往本面板塞页签。 */
	onOpenPanel?: (kind: string) => void;
	/** Presentation preference only; the conversation and tool permissions stay in App. */
	developerLayout?: boolean;
	/** tab 内「让 Owl …」类操作：把文字填进对话输入框。 */
	onToChat?: (text: string) => void;
	/** Reuse the workspace snapshot for conversation controls without another Git query. */
	onGitStatusChange?: (cwd: string, profile: string | undefined, status: GitStatusResult | undefined) => void;
}

const DESIGNED_TAB_KINDS = new Set(["files", "changes", "review", "editor", "terminal", "browser", "tasks", "impression", "image", "document"]);

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

export function Workbench({ client, cwd, profile, connected = true, store, open, onSetOpen, dock, role = "tools", onOpenPanel, developerLayout = false, onToChat, onGitStatusChange }: WorkbenchProps): React.JSX.Element {
	const t = useT();
	// 模型甩过来的说明（sidebar_show 的 note）：显示几秒后自动收掉。
	const notice = useSidebarNotice();
	useEffect(() => {
		if (notice === undefined) return;
		const timer = setTimeout(() => clearSidebarNotice(notice.id), 6000);
		return () => clearTimeout(timer);
	}, [notice]);
	const api = useMemo(() => createSidebarApi(client), [client]);
	const registry = useTabRegistry();
	const state = useSidebarState(store);
	const terminalOnly = role === "terminal";
	const mirrorOnly = role === "mirror";
	/** 独立面板（终端底栏 / 短剧面板）只服务自己那一种内容。 */
	const panelOnly = terminalOnly || mirrorOnly;
	const sizeKeys = ROLE_SIZE_KEYS[role];
	const activeTab = state.tabs.find((tab) => tab.id === state.activeId);
	// 侧边卡片配置（设置页「侧边卡片」）：工具行/空态卡片的可见性与文件预览回退
	const cfg = useSidebarConfig();
	// 本实例可装的 tab kind：按角色划分（终端归底栏、短剧归机器级面板）。
	const kindAllowed = useCallback(
		(kind: string): boolean => ROLE_KINDS[role](kind) && isTabKindEnabled(kind, cfg),
		[cfg, role],
	);
	const [gitSnapshot, setGitSnapshot] = useState<{ cwd: string; profile?: string; result: GitStatusResult }>();
	const gitStatus = gitSnapshot?.cwd === cwd && gitSnapshot.profile === profile ? gitSnapshot.result : undefined;
	useEffect(() => { if (!panelOnly) onGitStatusChange?.(cwd, profile, connected ? gitStatus : undefined); }, [cwd, profile, connected, gitStatus, panelOnly, onGitStatusChange]);
	const [width, setWidth] = useState(() => {
		const saved = Number(localStorage.getItem(sizeKeys.width));
		return Number.isFinite(saved) && saved >= WORKBENCH_MIN_WIDTH ? saved : 380;
	});
	const [height, setHeight] = useState(() => {
		const saved = Number(localStorage.getItem(sizeKeys.height));
		return Number.isFinite(saved) && saved >= WORKBENCH_MIN_HEIGHT ? saved : 260;
	});
	const [compactHeight, setCompactHeight] = useState<number | null>(() => {
		const saved = Number(localStorage.getItem(sizeKeys.compactHeight));
		return Number.isFinite(saved) && saved >= WORKBENCH_MIN_HEIGHT ? saved : null;
	});
	const shellRef = useRef<HTMLElement>(null);
	const containerSize = usePaneContainer(shellRef);
	const effectiveDock = containerSize === null ? dock : workbenchDock(dock, containerSize.width);
	const compact = dock === "right" && effectiveDock === "bottom";
	// Only an open terminal needs a second vertical reserve in a stacked workspace.
	const heightReserve = CONVERSATION_MIN_HEIGHT + (compact && containerSize?.terminalVisible ? WORKBENCH_MIN_HEIGHT : 0);
	const displayWidth = containerSize === null ? width : fitPaneSize(width, WORKBENCH_MIN_WIDTH, containerSize.width, CONVERSATION_MIN_WIDTH);
	// Short drama needs room for its 843:472 picture plus both tab bars, toolbar and status.
	const defaultCompactHeight = activeTab?.kind === "mirror" && containerSize ? containerSize.width * 472 / 843 + 140 : 260;
	const preferredHeight = compact ? compactHeight ?? defaultCompactHeight : height;
	const displayHeight = containerSize === null ? preferredHeight : fitPaneSize(preferredHeight, WORKBENCH_MIN_HEIGHT, containerSize.height, heightReserve);
	const gitTimer = useRef<number | undefined>(undefined);

	registerBuiltins();

	// 插件文件预览注册是全局注册表，两个面板实例只在工具侧栏这一份接线（终端底栏跳过）
	useEffect(() => {
		if (panelOnly) return;
		return attachPluginViewers(client, store, PluginViewerTab, (size) => <IconFile size={size ?? 14} />);
	}, [client, store, panelOnly]);

	// -- 拖拽分屏：指针自绘（leaf rect 命中 → 25% 边缘分区） -------------------
	const [dragTab, setDragTab] = useState<DragState | null>(null);
	const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
	const dropTargetRef = useRef<DropTarget | null>(null);
	const leafRefs = useRef(new Map<string, HTMLElement>());
	// 拖完的 click 抑制：mouseup 后 click 才派发，setTimeout(0) 复位来得及
	const justDraggedRef = useRef(false);
	const activeDrag = useRef<(() => void) | undefined>(undefined);
	const beginPointerDrag = useCallback((event: React.PointerEvent<HTMLElement>, handlers: PointerDragHandlers): void => {
		if (event.button !== 0 || !event.isPrimary) return;
		activeDrag.current?.();
		event.preventDefault();
		activeDrag.current = startPointerDrag(event.currentTarget, event.nativeEvent, {
			...handlers,
			onFinish: (cancelled) => {
				activeDrag.current = undefined;
				handlers.onFinish(cancelled);
			},
		});
	}, []);
	useEffect(() => () => {
		activeDrag.current?.();
		activeDrag.current = undefined;
	}, [cwd, store, open, effectiveDock]);

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
		(tab: SidebarTab, e: React.PointerEvent<HTMLElement>): void => {
			if (e.button !== 0) return;
			e.preventDefault();
			const startX = e.clientX;
			const startY = e.clientY;
			let started = false;
			const onMove = (m: PointerEvent): void => {
				if (!started) {
					if (Math.abs(m.clientX - startX) + Math.abs(m.clientY - startY) < 5) return;
					started = true;
					justDraggedRef.current = true;
				}
				// 同步更新：pointermove 本身与浏览器帧对齐（原生节流），
				// 不排 rAF——后台/节流窗口里 rAF 会停摆，拖拽会整个卡死。
				setDragTab({ id: tab.id, title: tab.title, x: m.clientX, y: m.clientY });
				hitTest(m.clientX, m.clientY);
			};
			const onUp = (cancelled: boolean): void => {
				const target = dropTargetRef.current;
				if (!cancelled && started && target) store.moveTab(tab.id, target.leafId, target.zone);
				if (!cancelled && !started) {
					// Capture can fail during a window transition; the shield's click is not a tab click.
					justDraggedRef.current = true;
					store.activate(tab.id);
				}
				setDragTab(null);
				setDropTarget(null);
				dropTargetRef.current = null;
				window.setTimeout(() => {
					justDraggedRef.current = false;
				}, 0);
			};
			beginPointerDrag(e, { cursor: "grabbing", onMove, onFinish: onUp });
		},
		[beginPointerDrag, hitTest, store],
	);

	// -- 分隔条拖拽在 SplitDivider 里（拖动比例 + 百分比提示 + 双击复位） --------

	// -- Git 状态快照：项目切换 / fs_changed / git_changed（防抖）/ 主动刷新（终端底栏用不到） -
	// 同一项目同时只跑一个 status：在途期间再来的刷新只记一笔，跑完补一次，变更风暴里不会排队堆请求。
	const gitRun = useRef<{ cwd: string; profile?: string; dirty: boolean } | undefined>(undefined);
	const refreshGit = useCallback(
		function run(): void {
			if (panelOnly) return;
			const current = gitRun.current;
			if (current !== undefined && current.cwd === cwd && current.profile === profile) {
				current.dirty = true;
				return;
			}
			const flight = { cwd, profile, dirty: false };
			gitRun.current = flight;
			const settle = (result: GitStatusResult): void => {
				if (gitRun.current !== flight) return;
				gitRun.current = undefined;
				setGitSnapshot({ cwd, profile, result });
				if (flight.dirty) run();
			};
			void api.gitStatus(cwd).then(settle, () => settle({ repo: false, entries: [] }));
		},
		[api, cwd, profile, panelOnly],
	);
	const scheduleGitRefresh = useCallback(
		(delay: number) => {
			if (gitTimer.current !== undefined) window.clearTimeout(gitTimer.current);
			gitTimer.current = window.setTimeout(refreshGit, delay);
		},
		[refreshGit],
	);

	useEffect(() => {
		const offStatus = client.onStatus((connected) => {
			if (connected) refreshGit();
		});
		refreshGit();
		return () => { offStatus(); gitRun.current = undefined; window.clearTimeout(gitTimer.current); };
	}, [client, refreshGit]);

	useEffect(() => {
		return store.onFsChanged(() => scheduleGitRefresh(400));
	}, [store, scheduleGitRefresh]);

	// -- 桥事件 → store 总线（终端底栏的 tab 不订阅 fs 变更，跳过） ------------
	useEffect(() => {
		if (panelOnly) return;
		return client.onSessionEvent((message) => {
			const event = message.event as { type?: string; cwd?: string; dirs?: unknown };
			if (event.type !== "fs_changed" && event.type !== "git_changed") return;
			if (event.cwd !== undefined && normProjectKey(String(event.cwd)) !== normProjectKey(cwd)) return;
			// git_changed 在宿主侧已防抖，这里只合并与 fs_changed 同时到达的那一下。
			if (event.type === "git_changed") {
				scheduleGitRefresh(100);
				return;
			}
			const dirs = Array.isArray(event.dirs) ? event.dirs.map(String) : [];
			store.fsChanged(dirs);
		});
	}, [client, store, cwd, panelOnly, scheduleGitRefresh]);

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

	// -- 停用卡片即时收尾：关掉已打开的同类 tab（与 DSH 停用插件关 tab 同语义）；
	//    顺手清掉装错面板的 tab（旧布局遗留在侧栏里的终端等）
	useEffect(() => {
		for (const tab of state.tabs) {
			if (!kindAllowed(tab.kind)) store.closeTab(tab.id);
		}
	}, [kindAllowed, state.tabs, store]);

	const tabPropsOf = useCallback(
		(tabId: string): TabComponentProps => ({
			api,
			store,
			cwd,
			profile,
			client,
			tab: state.tabs.find((tab) => tab.id === tabId)!,
			onOpenFile: openFile,
			gitStatus,
			onGitRefresh: refreshGit,
			...(onToChat !== undefined ? { onToChat } : {}),
		}),
		[api, store, cwd, profile, client, state.tabs, openFile, gitStatus, refreshGit, onToChat],
	);

	// -- 拖拽调宽 / 调高（工作台外壳；每次手势持有独立尺寸，结束时持久化） ----
	const startResize = (e: React.PointerEvent<HTMLElement>): void => {
		e.preventDefault();
		const shell = e.currentTarget.parentElement;
		if (!shell) return;
		const rect = shell.getBoundingClientRect();
		const origin = effectiveDock === "right" ? rect.width : rect.height;
		let currentSize = origin;
		const startX = e.clientX;
		const startY = e.clientY;
		const parent = shell.parentElement;
		if (!parent) return;
		const onMove =
			effectiveDock === "right"
				? (move: PointerEvent): void => {
						const next = fitPaneSize(origin + startX - move.clientX, WORKBENCH_MIN_WIDTH, parent.clientWidth, CONVERSATION_MIN_WIDTH);
						currentSize = next;
						setWidth(next);
					}
				: (move: PointerEvent): void => {
						// 顶缘向上拖 = 变高（与 DSH 的 bottomResize 同方向语义）
						const next = fitPaneSize(origin + startY - move.clientY, WORKBENCH_MIN_HEIGHT, parent.clientHeight, heightReserve);
						currentSize = next;
						if (compact) setCompactHeight(next);
						else setHeight(next);
					};
		const onUp = (): void => {
			localStorage.setItem(compact ? sizeKeys.compactHeight : dock === "right" ? sizeKeys.width : sizeKeys.height, String(currentSize));
		};
		beginPointerDrag(e, { cursor: effectiveDock === "right" ? "col-resize" : "row-resize", onMove, onFinish: onUp });
	};

	// -- split tree 渲染 -------------------------------------------------------
	const renderNode = (node: SplitNode, style: React.CSSProperties): React.JSX.Element => {
		if (node.kind === "split") {
			return (
				<div key={node.id} style={style} className={`flex min-h-0 min-w-0 ${node.dir === "row" ? "flex-row" : "flex-col"}`}>
					{renderNode(node.a, { flex: `${node.ratio * 100} 1 0%` })}
					{/* 分隔条：7px 命中区 + 居中 1px 细线（DSH divider 同款） */}
					<SplitDivider store={store} splitId={node.id} dir={node.dir} ratio={node.ratio} />
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
					<div className="owl-workbench-tabs flex shrink-0 select-none items-stretch overflow-x-auto" aria-label={t("wb.tabsAria")}>
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
									data-tauri-drag-region="false"
									style={{ touchAction: "none" }}
									onPointerDown={(e) => beginTabDrag(tab, e)}
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
									{tab.path === undefined ? def?.icon(14) : <FileIcon name={tab.path.split(/[\\/]/).pop() ?? tab.path} size={14} minimal={def?.icon(14)} />}
									<span className="min-w-0 truncate">{tab.title}</span>
									{state.dirty[tab.id] === true && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-owl-accent" title={t("wb.unsaved")} />}
									<button
										type="button"
										className="owl-workbench-tab-close"
										title={t("wb.closeTab", { name: tab.title })}
										aria-label={t("wb.closeTab", { name: tab.title })}
										onMouseDown={(e) => e.stopPropagation()}
										onPointerDown={(e) => e.stopPropagation()}
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
								<strong>{t(terminalOnly ? "wb.terminalEmptyTitle" : mirrorOnly ? "wb.mirrorEmptyTitle" : "wb.emptyTitle")}</strong>
								<p>{t(terminalOnly ? "wb.terminalEmptyDesc" : mirrorOnly ? "wb.mirrorEmptyDesc" : "wb.emptyDesc")}</p>
							</div>
							{QUICK_ACTIONS.filter((action) => !action.disabled && (kindAllowed(action.kind) || (action.panel === true && onOpenPanel !== undefined))).map((action) => (
								<button
									key={action.kind}
									type="button"
									className="owl-workbench-empty-card flex min-h-12 items-center gap-3 px-3.5 text-left"
									onClick={() => {
										store.activateLeaf(leaf.id);
										if (action.panel === true && onOpenPanel !== undefined) {
											onOpenPanel(action.kind);
											return;
										}
										openQuickAction(store, action.kind);
									}}
								>
									<span className="shrink-0" style={{ color: action.color }}>
										{action.icon(16)}
									</span>
									<span className="min-w-0">
										<span className="block truncate text-[13px] font-medium">{action.label}</span>
										<span className="block truncate text-[11px]" style={{ color: "var(--workbench-muted)" }}>{action.desc}</span>
									</span>
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
									className={`owl-workbench-pane ${DESIGNED_TAB_KINDS.has(tab.kind) ? "owl-workbench-designed-pane" : ""} absolute inset-0 ${isActive ? "" : "hidden"}`}
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

	return (
		<aside
			ref={shellRef}
			className={`owl-workbench-shell ${open ? "" : "hidden"} relative flex flex-col ${
				effectiveDock === "right" ? "shrink-0 border-l" : "w-full shrink-0 border-t"
			}`}
			aria-label={terminalOnly ? t("start.terminal") : mirrorOnly ? t("wb.drama") : developerLayout ? t("app.developerTrigger") : t("wb.workbench")}
			data-layout={terminalOnly ? "terminal" : mirrorOnly ? "mirror" : developerLayout ? "developer" : "tools"}
			data-dock={effectiveDock}
			data-responsive-dock={compact ? "bottom" : undefined}
			style={effectiveDock === "right" ? { width: displayWidth } : { height: displayHeight }}
		>
			<EditorCloseDialog store={store} />
			{/* 拖拽条：右停靠在左缘调宽，底停靠在顶缘调高 */}
			{effectiveDock === "right" ? (
				<div role="separator" aria-label={t("wb.workbench")} aria-orientation="vertical" data-workbench-size-handle="right" data-tauri-drag-region="false" style={{ touchAction: "none" }} className="absolute top-0 left-0 z-20 h-full w-2 cursor-col-resize transition-colors hover:bg-owl-accent/40" onPointerDown={startResize} />
			) : (
				<div role="separator" aria-label={t("wb.workbench")} aria-orientation="horizontal" data-workbench-size-handle="bottom" data-tauri-drag-region="false" style={{ touchAction: "none" }} className="absolute top-0 right-0 left-0 z-20 h-2 cursor-row-resize transition-colors hover:bg-owl-accent/40" onPointerDown={startResize} />
			)}

			{/* 工作台标题、工具入口与固定停靠操作 */}
			<div className="owl-workbench-bar" data-tauri-drag-region="deep">
				<div className="owl-workbench-heading" title={terminalOnly ? t("start.terminal") : mirrorOnly ? t("wb.drama") : t("wb.workbench")}>
					{terminalOnly ? <IconTerminal size={14} /> : mirrorOnly ? <IconDrama size={14} /> : <IconPanelRight size={14} />}
					<span>{terminalOnly ? t("start.terminal") : mirrorOnly ? t("wb.drama") : t("wb.workbench")}</span>
				</div>
				{role === "tools" && notice !== undefined && (
					<span className="owl-workbench-notice" role="status" title={notice.text}>✦ {notice.text}</span>
				)}
				{terminalOnly ? (
					/* 终端底栏：唯一入口是「新建终端」（多实例，可拖拽分屏） */
					<div className="owl-workbench-shortcuts" aria-label={t("wb.newTerminal")}>
						<button type="button" title={t("wb.newTerminal")} aria-label={t("wb.newTerminal")} className="owl-workbench-icon-button" onClick={() => openQuickAction(store, "terminal")}>
							<IconPlus size={15} />
						</button>
					</div>
				) : mirrorOnly ? null : (
					<WorkbenchTools store={store} activeKind={activeTab?.kind} width={effectiveDock === "right" ? displayWidth : containerSize?.width ?? width} kindAllowed={kindAllowed} onOpenPanel={onOpenPanel} />
				)}
				<div className="owl-workbench-dock-actions">
					<button type="button" title={terminalOnly ? t("wb.closeTerminal") : mirrorOnly ? t("wb.closeMirror") : t("wb.closeWorkbench")} aria-label={terminalOnly ? t("wb.closeTerminal") : mirrorOnly ? t("wb.closeMirror") : t("wb.closeWorkbench")} className="owl-workbench-icon-button" onClick={() => onSetOpen(false)}>
						<IconX size={14} />
					</button>
				</div>
			</div>

			{!panelOnly && <EditorDraftRecovery client={client} cwd={cwd} profile={profile} connected={connected} store={store} enabled={kindAllowed("editor") && !cfg.disabledViewers.includes("editor")} onOpen={() => onSetOpen(true)} />}
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

			{/* 状态条：git 分支/仓库 + 桥状态占位（点击打开文件变动页切换仓库）；独立面板不显示 */}
			{!panelOnly && (
				<div className="owl-workbench-status">
					{gitStatus === undefined ? (
						<IconLoader size={10} className="animate-spin" />
					) : gitStatus.repo ? (
						<button
							type="button"
							title={t("wb.openChanges")}
							className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
							onClick={() => openQuickAction(store, "changes")}
						>
							<IconGitBranch size={10} />
							{/* 变更数是主信息：agent 跑批时用户最先看它；有改动时用强调色点出来。 */}
							<span
								className={`shrink-0 ${gitStatus.entries.length > 0 ? "font-medium" : ""}`}
								style={gitStatus.entries.length > 0 ? { color: "var(--color-owl-accent)" } : undefined}
							>
								{gitStatus.entries.length > 0 ? t("wb.gitChanges", { n: gitStatus.entries.length }) : t("wb.noChanges")}
							</span>
							{/* 分支/仓库只是上下文，排在后面，不跟变更数抢主位。 */}
							<span className="shrink-0 opacity-50">·</span>
							<span className="truncate opacity-70">
								{gitStatus.repos !== undefined && gitStatus.repos.length > 1
									? t("wb.gitRepos", { n: gitStatus.repos.length })
									: gitStatus.branch ?? "HEAD"}
							</span>
						</button>
					) : (
						<span>{t("wb.notGitRepo")}</span>
					)}
				</div>
			)}
		</aside>
	);
}
