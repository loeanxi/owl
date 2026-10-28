import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionSearchHit } from "../bridge/protocol.ts";
import { getUiLanguage, t, useT } from "../i18n/index.ts";
import {
	getProjectSidebarPreferences,
	hideProject,
	initializeReadMarkers,
	isSessionUnread,
	markSessionsRead,
	moveProjectToSection,
	type ProjectSidebarPreferences,
	getProjectDisplayName as projectLabel,
	removeProjectSection,
	restoreProject,
	saveProjectSidebarPreferences,
	useProjectSidebarRevision,
} from "../project-sidebar-model.ts";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, sidebarWidthLimit } from "../sidebar/pane-sizing.ts";
import { startPointerDrag } from "../sidebar/pointer-drag.ts";
import { usePaneContainer } from "../sidebar/use-pane-container.ts";
import { isReservedDir, isValidationDir, loadAndScrubProjects, normPath, samePath } from "../utils/paths.ts";
import type { RailView } from "./ActivityRail.tsx";
import {
	IconChat,
	IconCheck,
	IconChevron,
	IconCompose,
	IconFolder,
	IconFolderOpen,
	IconGrip,
	IconMore,
	IconPanelLeft,
	IconPlus,
	IconSearch,
} from "./icons.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { ProjectActionsMenu, ProjectsSectionMenu, SectionActionsMenu } from "./ProjectActionsMenu.tsx";
import { ProjectSidebarDialog } from "./ProjectSidebarDialog.tsx";
import { useProjectSidebarText } from "./project-sidebar-copy.ts";
import { SessionActionsMenu } from "./SessionActionsMenu.tsx";
import { SessionSearchDialog } from "./SessionSearchDialog.tsx";
import { groupSessionsByPeriod, sessionDisplayTitle } from "./session-list-presentation.ts";
import { useSessionSearchText } from "./session-search-copy.ts";
import {
	initializeResearchSidebar,
	loadSidebarStrings,
	matchesSessionScope,
	type SessionScope,
	sidebarStorageKeys,
} from "./sidebar-scope.ts";
import "./navigation-design.css";
import "./session-sidebar-responsive.css";

type SessionRow = {
	id?: string;
	name?: string;
	cwd?: string;
	/** 最近活动时间（ISO）。旧代码误读 timestamp（wire 上不存在），一直是空串。 */
	modified?: string;
	timestamp?: string;
	created?: string;
	firstMessage?: string;
	/** 父会话文件路径。存在 = 由别的会话分支而来，标题要加「· 分支」后缀区分。 */
	parentSessionPath?: string;
	/** 会话记录 JSONL 文件的绝对路径（session.list 随行下发）；右键「复制任务路径」用。 */
	path?: string;
	/** 归档时间（ISO）。存在 = 已归档；由桥端 archive.json 下发。 */
	archivedAt?: string;
	/** 会话绑定的 Agent 预设 id（owl-agent-preset entry；桥端随 session.list 下发）。 */
	preset?: string;
	scope?: SessionScope;
	[key: string]: unknown;
};

const PINNED_KEY = "owl.pinnedSessions";
const COLLAPSED_KEY = "owl.sidebar.collapsed";
/** 侧栏宽度（localStorage）：右缘拖拽调整，双击手柄复位为 CSS 默认值。 */
const WIDTH_KEY = "owl.sidebar.width";
/** 未存储或非法值使用自适应默认宽度，合法手动偏好只在当前窗口内限宽。 */
function loadSidebarWidth(): number | null {
	try {
		const raw = localStorage.getItem(WIDTH_KEY);
		const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
		if (!Number.isFinite(parsed)) return null;
		return Math.min(Math.max(parsed, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);
	} catch {
		return null;
	}
}
/** 分组排序偏好（Codex 式分组菜单）：置顶 manual=置顶顺序；最近 name=按名称。 */
/** 各会话列表默认及每次展开的数量；只限制可见行，不截断真实数据。 */
const SESSION_PAGE_SIZE = 5;
/** 项目行操作菜单的 id 前缀（openMenu 状态，按项目路径区分）。 */
const PROJECT_ROW_MENU_PREFIX = "project-row:";
const SESSION_ROW_MENU_PREFIX = "session-row:";

type PinnedSort = "recent" | "manual";
type ListSort = "recent" | "name" | "oldest";

function loadChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	try {
		const value = localStorage.getItem(key);
		return allowed.includes(value as T) ? (value as T) : fallback;
	} catch {
		return fallback;
	}
}

function saveChoice(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// localStorage 不可用时排序偏好退化为会话内状态
	}
}

function sessionTime(row: SessionRow): string {
	return String(row.modified ?? row.timestamp ?? row.created ?? "");
}

/** 手动名称原样优先，自动标题仅清理显示层的内部封装。 */
function sessionTitle(row: SessionRow): string {
	return sessionDisplayTitle(row, t("sidebar.sessionUnnamed"), t("app.branchSuffix"));
}

/** 改名框使用清理过的首条消息，保留更长草稿且不自动带分支后缀。 */
function sessionRenameDraft(row: SessionRow): string {
	const named = row.name?.trim();
	if (named) return named;
	return sessionDisplayTitle(
		{ ...row, parentSessionPath: undefined },
		t("sidebar.sessionUnnamed"),
		t("app.branchSuffix"),
		80,
	).slice(0, 80);
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / n 天前 / MM-DD。 */
function relativeTime(iso: string): string {
	const time = new Date(iso).getTime();
	if (!time) return "";
	const now = Date.now();
	const diff = now - time;
	const minute = 60_000;
	const hour = 3_600_000;
	const day = 86_400_000;
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	if (diff < minute) return t("sidebar.relativeNow");
	if (diff < hour) return t("sidebar.relativeMinutes", { n: Math.floor(diff / minute) });
	if (time >= today.getTime()) return t("sidebar.relativeHours", { n: Math.max(1, Math.floor(diff / hour)) });
	if (time >= yesterday.getTime()) return t("sidebar.yesterday");
	if (diff < 7 * day) return t("sidebar.relativeDays", { n: Math.max(1, Math.floor(diff / day)) });
	return new Date(time).toLocaleDateString(getUiLanguage() === "en" ? "en-US" : "zh-CN", {
		month: "2-digit",
		day: "2-digit",
	});
}

function loadPinned(key: string = PINNED_KEY): string[] {
	try {
		const raw = localStorage.getItem(key);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function loadCollapsed(key: string = COLLAPSED_KEY): Set<string> {
	try {
		const raw = localStorage.getItem(key);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
	} catch {
		return new Set();
	}
}

/** 项目会话的手动排序（拖拽产生）：项目路径 → 会话 id 全序；未收录的（新建）会话渲染在手动段之前。 */
type SessionOrderMap = Record<string, string[]>;

function loadSessionOrder(key: string): SessionOrderMap {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const map: SessionOrderMap = {};
		for (const [path, ids] of Object.entries(parsed as Record<string, unknown>)) {
			if (!normPath(path) || !Array.isArray(ids)) continue;
			const valid = ids.filter((id): id is string => typeof id === "string" && id !== "");
			if (valid.length > 0) map[normPath(path)] = valid;
		}
		return map;
	} catch {
		return {};
	}
}

/** 拖拽悬停位置 → 插入下标（按行中点划分上下半）。 */
function sessionDropIndex(container: HTMLElement, clientY: number): number {
	const rows = [
		...container.querySelectorAll<HTMLElement>(".owl-sidebar-session-row:not([data-sidebar-window-overflow])"),
	];
	for (const [index, row] of rows.entries()) {
		const rect = row.getBoundingClientRect();
		if (clientY < rect.top + rect.height / 2) return index;
	}
	return rows.length;
}

/** 可折叠分组：标题与尾随箭头，悬停或键盘聚焦时露出快捷操作。 */
function Section({
	id,
	label,
	open,
	onToggle,
	actions,
	menu,
	showMenu,
	children,
}: {
	id: string;
	label: string;
	open: boolean;
	onToggle: () => void;
	/** 悬停/菜单打开时显示在头部的快捷按钮（⋯、＋ 等）。 */
	actions?: React.ReactNode;
	/** 点击 ⋯ 展开的下拉菜单内容（Codex 式）。 */
	menu?: React.ReactNode;
	showMenu?: boolean;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<div id={id} data-section={id} className="owl-sidebar-section">
			<div className={`owl-sidebar-section-header ${showMenu ? "is-open" : ""}`}>
				<button
					type="button"
					className="owl-sidebar-section-toggle"
					onClick={onToggle}
					aria-label={t("sidebar.sectionToggleAria", {
						action: open ? t("common.collapse") : t("common.expand"),
						label,
					})}
					aria-expanded={open}
				>
					<span className="owl-sidebar-section-label">{label}</span>
					<IconChevron
						className={`h-3 w-3 shrink-0 text-owl-sidebar-faint transition-transform ${open ? "rotate-90" : ""}`}
					/>
				</button>
				{actions && (
					<div data-menu-root className="owl-sidebar-section-actions">
						{actions}
					</div>
				)}
				{menu && showMenu && (
					<div
						data-menu-root
						className="owl-sidebar-section-menu absolute right-2 top-full z-30 mt-1 w-56 rounded-xl border border-owl-sidebar-border bg-owl-sidebar-surface py-1 shadow-xl shadow-black/30"
					>
						{menu}
					</div>
				)}
			</div>
			{open && <div className="owl-sidebar-section-content">{children}</div>}
		</div>
	);
}

/** 分组菜单里的普通条目：label 左、勾选 ✓ 右（Codex 式）。 */
function MenuRow({
	label,
	checked,
	disabled,
	hint,
	onClick,
}: {
	label: string;
	checked?: boolean;
	disabled?: boolean;
	hint?: string;
	onClick?: () => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			disabled={disabled}
			title={disabled ? t("sidebar.menuDisabledTitle") : undefined}
			className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors ${
				disabled
					? "cursor-default text-owl-sidebar-faint/50"
					: "text-owl-sidebar-muted hover:bg-owl-sidebar-hover hover:text-owl-sidebar-text"
			}`}
			onClick={onClick}
		>
			<span className="flex items-center gap-2">
				{label}
				{hint && <span className="text-[10px] font-normal text-owl-sidebar-faint/70">{hint}</span>}
			</span>
			{checked && <IconCheck className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-text" />}
		</button>
	);
}

export function SessionSidebar({
	client,
	sessionScope,
	connected,
	activeId,
	activeProject,
	runningSessions,
	draftSessions,
	refreshKey,
	revision,
	focus,
	conversationVisible = true,
	minimized,
	onToggleMinimized,
	onNewChat,
	onNewChatInProject,
	onSelectProject,
	onOpenSession,
	onOpenSearchHit,
	onSessionRenamed,
}: {
	client: BridgeClient;
	/** Ordinary chat and research own independent history and sidebar preferences. */
	sessionScope: SessionScope;
	/** 桥连接状态：挂载时 WS 往往尚未 open，未连接的请求会被直接拒绝。 */
	connected: boolean;
	activeId: string | undefined;
	/** 当前项目（工作目录）绝对路径。 */
	activeProject: string;
	/** agent run 活跃的会话 id 集合：行首状态点绿色展示。 */
	runningSessions: ReadonlySet<string>;
	/** 有未发送输入草稿的会话 id 集合：状态点变空心铅笔提示（R15）。 */
	draftSessions?: ReadonlySet<string>;
	/** 变化时重新拉取会话列表（如新会话创建后）。 */
	refreshKey: string;
	/** 递增时重拉会话列表（设置页恢复/删除归档会话后由 App 递增）。 */
	revision: number;
	/** rail 当前视图；变化时把会话列表滚回顶部。 */
	focus: RailView;
	/** Background answers remain unread until their conversation is visible. */
	conversationVisible?: boolean;
	/** 收起时完全隐藏侧栏，展开入口由 App 顶栏提供。 */
	minimized: boolean;
	onToggleMinimized: () => void;
	onNewChat: () => void;
	onNewChatInProject: (path: string) => void;
	onSelectProject: (path: string) => void;
	/** 点击历史会话：恢复回放并续聊。 */
	onOpenSession: (sessionId: string) => void;
	/** A search hit may belong to either conversation view; an empty entry id opens only the chat. */
	onOpenSearchHit?: (hit: SessionSearchHit, query: string) => void;
	/** 改名成功后通知顶栏；侧栏列表会自己重拉。 */
	onSessionRenamed?: (sessionId: string, name: string) => void;
}): React.JSX.Element {
	const t = useT();
	const pt = useProjectSidebarText();
	const searchText = useSessionSearchText();
	const projectRevision = useProjectSidebarRevision();
	const projectPreferences = useMemo(
		() => getProjectSidebarPreferences(sessionScope),
		[sessionScope, projectRevision],
	);
	const researchText =
		getUiLanguage() === "en"
			? {
					title: "Research chats",
					search: "Search research chats or projects",
					newChat: "New research chat",
					recent: "Recent research",
				}
			: { title: "研究会话", search: "搜索研究会话或项目", newChat: "新研究会话", recent: "最近研究" };
	const keys = sidebarStorageKeys(sessionScope);
	const [allSessions, setAllSessions] = useState<SessionRow[]>([]);
	const sessions = useMemo(
		() => allSessions.filter((row) => matchesSessionScope(row, sessionScope)),
		[allSessions, sessionScope],
	);
	const [showNewProject, setShowNewProject] = useState(false);
	const [editingProject, setEditingProject] = useState<string | null>(null);
	const [sectionDialog, setSectionDialog] = useState<{ id?: string; path?: string } | null>(null);
	const [sectionError, setSectionError] = useState("");
	const [projectNotice, setProjectNotice] = useState("");
	const [projectConfirm, setProjectConfirm] = useState<{
		type: "archive" | "remove" | "section-remove";
		path?: string;
		sectionId?: string;
	} | null>(null);
	const [projectBusy, setProjectBusy] = useState(false);
	const projectBusyRef = useRef(false);
	// 桌面壳里可打开系统文件夹选择框（浏览器模式隐藏入口）
	const [pinned, setPinned] = useState<string[]>(() => loadPinned(keys.pinned));
	const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(keys.collapsed));
	const [query, setQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const closeSearch = useCallback((): void => {
		setSearchOpen(false);
		setQuery("");
	}, []);
	useEffect(() => {
		closeSearch();
	}, [sessionScope, focus, minimized, closeSearch]);
	/** 当前展开的分组菜单（Codex 式 ⋯ 菜单）；值为菜单 id（含各项目行自己的菜单）。 */
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const projectMenuId = useId();
	const [projectPopup, setProjectPopup] = useState<{
		key: string;
		kind: "project" | "projects" | "recent" | "section";
		path?: string;
		sectionId?: string;
		anchor: HTMLButtonElement;
	} | null>(null);
	const closeProjectPopup = useCallback(
		(restoreFocus = true): void => {
			if (restoreFocus && projectPopup?.anchor.isConnected) projectPopup.anchor.focus({ preventScroll: true });
			setProjectPopup(null);
			setOpenMenu((current) => (current === projectPopup?.key ? null : current));
		},
		[projectPopup],
	);
	const sessionMenuId = useId();
	const [sessionMenu, setSessionMenu] = useState<{
		key: string;
		row: SessionRow;
		anchor: HTMLButtonElement;
		point?: { x: number; y: number };
	} | null>(null);
	const closeSessionMenu = useCallback(
		(restoreFocus = true): void => {
			if (restoreFocus && sessionMenu?.anchor.isConnected) sessionMenu.anchor.focus({ preventScroll: true });
			setSessionMenu(null);
			setOpenMenu((current) => (current === sessionMenu?.key ? null : current));
		},
		[sessionMenu],
	);
	const [pinnedSort, setPinnedSort] = useState<PinnedSort>(() =>
		loadChoice(keys.pinnedSort, ["recent", "manual"] as const, "manual"),
	);
	const [recentSort, setRecentSort] = useState<ListSort>(() =>
		loadChoice(keys.recentSort, ["recent", "name", "oldest"] as const, "recent"),
	);
	/** 待确认删除的会话（非 null 时显示确认弹窗）。 */
	const [confirmDelete, setConfirmDelete] = useState<SessionRow | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [renaming, setRenaming] = useState<SessionRow | null>(null);
	const [renameError, setRenameError] = useState("");
	const [renameBusy, setRenameBusy] = useState(false);
	const [deleteError, setDeleteError] = useState("");
	/** 到访过的项目（含没有会话的）：保证新建/切换项目后旧项目仍留在「项目」分组。启动时清掉评测 workspace。 */
	const [knownProjects, setKnownProjects] = useState<string[]>(() =>
		loadAndScrubProjects(localStorage, keys.projects),
	);
	/** 手动展开过会话列表的项目（normalized path）。null = 未交互，默认只展开当前项目。 */
	const [openProjects, setOpenProjects] = useState<Set<string> | null>(null);
	const [listWindows, setListWindows] = useState<{ scope: SessionScope; counts: Record<string, number> }>(() => ({
		scope: sessionScope,
		counts: {},
	}));
	const visibleCount = (key: string): number =>
		listWindows.scope === sessionScope ? (listWindows.counts[key] ?? SESSION_PAGE_SIZE) : SESSION_PAGE_SIZE;
	/** 当前会话排在本页窗口外时仍留在列表末尾，且不计入「再显示 N 条」。 */
	const sessionWindow = (rows: SessionRow[], windowKey: string): { rows: SessionRow[]; total: number } => {
		const limit = visibleCount(windowKey);
		const activeIndex = activeId ? rows.findIndex((row) => row.id === activeId) : -1;
		const activeOutside = activeIndex >= limit;
		return {
			rows: activeOutside ? [...rows.slice(0, limit), rows[activeIndex]!] : rows.slice(0, limit),
			total: rows.length - (activeOutside ? 1 : 0),
		};
	};
	const setVisibleCount = (key: string, count: number): void =>
		setListWindows((current) => ({
			scope: sessionScope,
			counts: { ...(current.scope === sessionScope ? current.counts : {}), [key]: count },
		}));
	const listControls = (
		key: string,
		total: number,
		label: string,
		moreKey: "showMoreSessions" | "showMoreProjects" = "showMoreSessions",
	): React.ReactNode => {
		if (total <= SESSION_PAGE_SIZE) return null;
		const count = Math.min(visibleCount(key), total);
		const more = Math.min(SESSION_PAGE_SIZE, total - count);
		const moreLabel = pt(moreKey).replace("{n}", String(more));
		return (
			<div className="owl-sidebar-list-controls" data-sidebar-list={key} role="group" aria-label={label}>
				{more > 0 && (
					<button
						type="button"
						className="owl-sidebar-list-more"
						aria-label={label + "：" + moreLabel}
						onClick={() => setVisibleCount(key, count + SESSION_PAGE_SIZE)}
					>
						{moreLabel}
					</button>
				)}
				{count > SESSION_PAGE_SIZE && (
					<button
						type="button"
						className="owl-sidebar-list-collapse"
						aria-label={label + "：" + pt("collapseSessions")}
						onClick={() => setVisibleCount(key, SESSION_PAGE_SIZE)}
					>
						{pt("collapseSessions")}
					</button>
				)}
			</div>
		);
	};
	/** 项目会话手动顺序（拖拽产生并持久化）。 */
	const [sessionOrder, setSessionOrder] = useState<SessionOrderMap>(() => loadSessionOrder(keys.sessionOrder));
	/** 拖拽排序进行中的会话（来源项目）；拖拽只允许发生在同一项目的会话列表内。 */
	const [draggingSession, setDraggingSession] = useState<{ id: string; fromPath: string } | null>(null);
	/** 落点提示：目标项目 + 插入下标（渲染序，0..行数）。 */
	const [dropHint, setDropHint] = useState<{ path: string; index: number } | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const asideRef = useRef<HTMLElement>(null);
	const drawerTriggerRef = useRef<HTMLButtonElement>(null);
	const containerSize = usePaneContainer(asideRef, true);
	const drawerMode = containerSize !== null && containerSize.width <= 680;
	const [drawerOpen, setDrawerOpen] = useState(false);
	const previousMinimized = useRef(minimized);
	const sidebarHidden = minimized || (drawerMode && !drawerOpen);
	const paneWidthLimit =
		containerSize === null ? SIDEBAR_MAX_WIDTH : sidebarWidthLimit(containerSize.width, containerSize.toolsVisible);
	const maxSidebarWidth = drawerMode
		? Math.min(360, Math.max(0, containerSize.width - 40))
		: containerSize !== null
			? Math.min(
					paneWidthLimit,
					Math.max(216, Math.round(containerSize.width * 0.28 + Math.max(0, containerSize.width - 1000) * 0.52)),
				)
			: paneWidthLimit;
	const defaultSidebarWidth = drawerMode
		? 288
		: containerSize === null
			? 252
			: Math.min(260, Math.max(216, Math.round(containerSize.width * 0.12 + 100)));
	/** 右缘拖拽调宽：null = 未拖过，使用自适应默认宽度。 */
	const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => loadSidebarWidth());
	const renderedSidebarWidth = Math.min(sidebarWidth ?? defaultSidebarWidth, maxSidebarWidth);
	const [visibleSidebarWidth, setVisibleSidebarWidth] = useState<number | undefined>(undefined);
	const [resizing, setResizing] = useState(false);
	const activeDrag = useRef<(() => void) | undefined>(undefined);
	const resizeAria =
		getUiLanguage() === "en"
			? "Drag or use Left/Right arrows to resize sidebar, double-click to reset"
			: "拖拽或按左右方向键调整侧栏宽度，双击复位";
	const closeDrawer = useCallback((): void => {
		closeSearch();
		setDrawerOpen(false);
		setOpenMenu(null);
		setProjectPopup(null);
		setSessionMenu(null);
		requestAnimationFrame(() => drawerTriggerRef.current?.focus({ preventScroll: true }));
	}, [closeSearch]);
	useEffect(() => {
		if (drawerMode && previousMinimized.current && !minimized) setDrawerOpen(true);
		if (!drawerMode || minimized) setDrawerOpen(false);
		previousMinimized.current = minimized;
	}, [drawerMode, minimized]);
	// A narrow-window drawer is transient UI; resizing never replaces the saved collapse preference.
	useEffect(() => {
		const toggleDrawer = (event: Event): void => {
			if (!drawerMode || minimized) return;
			event.preventDefault();
			if (drawerOpen) closeDrawer();
			else setDrawerOpen(true);
		};
		window.addEventListener("owl:toggle-session-drawer", toggleDrawer);
		return () => window.removeEventListener("owl:toggle-session-drawer", toggleDrawer);
	}, [drawerMode, minimized, drawerOpen, closeDrawer]);
	useEffect(() => {
		window.dispatchEvent(
			new CustomEvent("owl:session-drawer-state", {
				detail: { enabled: drawerMode && !minimized, open: drawerMode && !sidebarHidden },
			}),
		);
		return () => {
			window.dispatchEvent(new CustomEvent("owl:session-drawer-state", { detail: { enabled: false, open: false } }));
		};
	}, [drawerMode, minimized, sidebarHidden]);
	useEffect(() => {
		if (!drawerMode || sidebarHidden) return;
		const frame = requestAnimationFrame(() =>
			asideRef.current
				?.querySelector<HTMLButtonElement>(".owl-sidebar-search-trigger")
				?.focus({ preventScroll: true }),
		);
		return () => cancelAnimationFrame(frame);
	}, [drawerMode, sidebarHidden]);
	useEffect(() => {
		if (
			!drawerMode ||
			sidebarHidden ||
			searchOpen ||
			openMenu ||
			showNewProject ||
			editingProject ||
			sectionDialog ||
			projectConfirm ||
			renaming ||
			confirmDelete ||
			resizing
		)
			return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.defaultPrevented) return;
			if (event.key === "Escape") {
				event.preventDefault();
				closeDrawer();
				return;
			}
			if (event.key !== "Tab") return;
			const aside = asideRef.current;
			const controls = aside
				? [
						...aside.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'),
					].filter((control) => control.getClientRects().length > 0)
				: [];
			const first = controls[0];
			const last = controls.at(-1);
			if (!first || !last) return;
			if (
				!aside?.contains(document.activeElement) ||
				(event.shiftKey ? document.activeElement === first : document.activeElement === last)
			) {
				event.preventDefault();
				(event.shiftKey ? last : first).focus({ preventScroll: true });
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [
		drawerMode,
		sidebarHidden,
		closeDrawer,
		searchOpen,
		openMenu,
		showNewProject,
		editingProject,
		sectionDialog,
		projectConfirm,
		renaming,
		confirmDelete,
		resizing,
	]);
	useEffect(() => {
		const aside = asideRef.current;
		if (!aside) return;
		const measure = (): void => setVisibleSidebarWidth(Math.round(aside.getBoundingClientRect().width));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(aside);
		return () => observer.disconnect();
	}, []);
	const beginSidebarResize = useCallback(
		(event: React.PointerEvent<HTMLDivElement>): void => {
			if (event.button !== 0 || !event.isPrimary) return;
			const aside = asideRef.current;
			if (!aside) return;
			activeDrag.current?.();
			const previousWidth = sidebarWidth;
			const startWidth = aside.getBoundingClientRect().width;
			const startX = event.clientX;
			let latest = startWidth;
			event.preventDefault();
			setResizing(true);
			activeDrag.current = startPointerDrag(event.currentTarget, event.nativeEvent, {
				cursor: "col-resize",
				onMove: (moveEvent) => {
					latest = Math.min(
						Math.max(Math.round(startWidth + moveEvent.clientX - startX), SIDEBAR_MIN_WIDTH),
						Math.floor(maxSidebarWidth),
					);
					setSidebarWidth(latest);
				},
				onFinish: (cancelled) => {
					activeDrag.current = undefined;
					setResizing(false);
					// 取消时恢复手势开始前的偏好；窄窗口临时限宽不会覆盖原偏好。
					if (cancelled) {
						setSidebarWidth(previousWidth);
						return;
					}
					saveChoice(WIDTH_KEY, String(latest));
				},
			});
		},
		[maxSidebarWidth, sidebarWidth],
	);
	const resizeSidebarWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		if (resizing || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		const aside = asideRef.current;
		if (!aside) return;
		event.preventDefault();
		const step = event.shiftKey ? 50 : 10;
		const currentWidth = aside.getBoundingClientRect().width;
		const requestedWidth =
			event.key === "Home"
				? SIDEBAR_MIN_WIDTH
				: event.key === "End"
					? maxSidebarWidth
					: currentWidth + (event.key === "ArrowLeft" ? -step : step);
		const nextWidth = Math.min(Math.max(Math.round(requestedWidth), SIDEBAR_MIN_WIDTH), Math.floor(maxSidebarWidth));
		setSidebarWidth(nextWidth);
		saveChoice(WIDTH_KEY, String(nextWidth));
	};
	useEffect(() => {
		if (sidebarHidden || drawerMode) activeDrag.current?.();
	}, [sidebarHidden, drawerMode]);
	useEffect(() => {
		if (!resizing) return;
		const document = asideRef.current?.ownerDocument;
		if (!document) return;
		const cancelWithEscape = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			activeDrag.current?.();
		};
		document.addEventListener("keydown", cancelWithEscape);
		return () => document.removeEventListener("keydown", cancelWithEscape);
	}, [resizing]);
	useEffect(
		() => () => {
			activeDrag.current?.();
			activeDrag.current = undefined;
		},
		[],
	);
	const mounted = useRef(true);
	const refreshVersion = useRef(0);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			refreshVersion.current++;
		};
	}, []);

	// 菜单打开时：点击菜单外或按 Esc 关闭
	useEffect(() => {
		if (!openMenu || openMenu.startsWith(SESSION_ROW_MENU_PREFIX) || openMenu === projectPopup?.key) return;
		const onDown = (event: MouseEvent): void => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("[data-menu-root]")) return;
			setOpenMenu(null);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpenMenu(null);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [openMenu, projectPopup]);
	useEffect(() => {
		if (projectPopup !== null && (openMenu !== projectPopup.key || !projectPopup.anchor.isConnected))
			closeProjectPopup(false);
	}, [openMenu, projectPopup, closeProjectPopup, allSessions, projectRevision]);
	useEffect(() => {
		setProjectPopup(null);
		setOpenMenu((current) =>
			current === "projects" ||
			current === "recent" ||
			current?.startsWith(PROJECT_ROW_MENU_PREFIX) ||
			current?.startsWith("partition:")
				? null
				: current,
		);
	}, [
		minimized,
		activeId,
		activeProject,
		sessionScope,
		focus,
		allSessions,
		query,
		collapsed,
		openProjects,
		projectRevision,
		recentSort,
	]);

	// A menu belongs to a specific rendered row, not every copy of that session.
	useEffect(() => {
		if (sessionMenu === null) return;
		if (openMenu !== sessionMenu.key || !sessionMenu.anchor.isConnected) closeSessionMenu(false);
	}, [openMenu, sessionMenu, closeSessionMenu, allSessions, query, collapsed, openProjects, pinned]);
	useEffect(() => {
		setSessionMenu(null);
		setOpenMenu((current) => (current?.startsWith(SESSION_ROW_MENU_PREFIX) ? null : current));
	}, [minimized, activeId, activeProject, sessionScope, focus, allSessions, query, collapsed, openProjects]);

	// 当前项目变化时登记进项目列表：新建项目、切项目、恢复历史会话都会走到这里。
	// 不登记的话，没有会话的项目会在切走后从「项目」分组消失。
	useEffect(() => {
		if (!activeProject || isValidationDir(activeProject)) return;
		setKnownProjects((current) => {
			if (current.some((p) => samePath(p, activeProject))) return current;
			const next = [...current, activeProject];
			try {
				localStorage.setItem(keys.projects, JSON.stringify(next));
			} catch {
				// localStorage 不可用时项目列表退化为「有会话的项目 + 当前项目」
			}
			return next;
		});
	}, [activeProject]);

	const refresh = async (): Promise<void> => {
		const version = ++refreshVersion.current;
		try {
			const response = await client.request<SessionRow[]>({ type: "session.list" });
			if (!response.ok || !mounted.current || version !== refreshVersion.current) return;
			const rows = response.result ?? [];
			initializeResearchSidebar(localStorage, rows);
			initializeReadMarkers(
				sessionScope,
				rows.filter((row) => matchesSessionScope(row, sessionScope)),
			);
			if (sessionScope === "research") {
				setPinned(loadPinned(keys.pinned));
				setKnownProjects(loadAndScrubProjects(localStorage, keys.projects));
			}
			setAllSessions(rows);
		} catch {
			// 桥断开/重连瞬间的失败静默跳过：connected 或 refreshKey 变化会重试
		}
	};
	useEffect(() => {
		if (client && connected) void refresh();
	}, [client, connected, refreshKey, revision]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (!conversationVisible) return;
		const row = allSessions.find((entry) => entry.id === activeId && matchesSessionScope(entry, sessionScope));
		if (row) markSessionsRead(sessionScope, [row]);
	}, [activeId, allSessions, sessionScope, conversationVisible]);

	// 置顶的会话文件可能已被删除：列表里不存在的 id 顺手清掉。
	// 列表为空 = 尚未加载完成（初始 []），此时清理会把全部置顶误判为已删除、清空存储；
	// 必须等 session.list 真正返回过至少一条（或确认没有任何会话）后才允许清理。
	// 单次刷新丢行（桥端读取瞬断）也不能触发清理——置顶被清掉是持久化丢失，
	// 只有连续两次列表都缺失（会话真的删了）才动手。
	const pinMissRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (allSessions.length === 0) return;
		const alive = new Set(allSessions.map((row) => row.id).filter(Boolean));
		const miss = new Set(pinned.filter((id) => !alive.has(id)));
		const confirmed = [...miss].filter((id) => pinMissRef.current.has(id));
		pinMissRef.current = miss;
		if (confirmed.length === 0) return;
		const valid = pinned.filter((id) => alive.has(id) || !confirmed.includes(id));
		setPinned(valid);
		localStorage.setItem(keys.pinned, JSON.stringify(valid));
	}, [allSessions]); // eslint-disable-line react-hooks/exhaustive-deps

	// 手动排序里已删除的会话 id 顺手清掉。与置顶清理同理：列表为空（尚未加载）不动，
	// 单次丢行（桥端读取瞬断）也不动——顺序表被清是持久化丢失；连续两次缺失才清理。
	// 归档会话保留位置，恢复后仍在原处。
	const orderMissRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (allSessions.length === 0) return;
		const alive = new Set(allSessions.map((row) => row.id).filter(Boolean));
		let changed = false;
		const next: SessionOrderMap = {};
		const miss = new Set<string>();
		for (const [path, ids] of Object.entries(sessionOrder)) {
			const survivors: string[] = [];
			for (const id of ids) {
				if (alive.has(id)) survivors.push(id);
				else miss.add(id);
			}
			if (survivors.length !== ids.length) changed = true;
			if (survivors.length > 0) next[path] = survivors;
		}
		const confirmed = [...miss].filter((id) => orderMissRef.current.has(id));
		orderMissRef.current = miss;
		if (!changed || confirmed.length === 0) return;
		for (const path of Object.keys(next)) {
			next[path] = next[path].filter((id) => alive.has(id) || !confirmed.includes(id));
			if (next[path].length === 0) delete next[path];
		}
		setSessionOrder(next);
		try {
			localStorage.setItem(keys.sessionOrder, JSON.stringify(next));
		} catch {
			// localStorage 不可用时手动顺序退化为本次会话内存态
		}
	}, [allSessions]); // eslint-disable-line react-hooks/exhaustive-deps

	const toggleSection = (id: string): void => {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			localStorage.setItem(keys.collapsed, JSON.stringify([...next]));
			return next;
		});
	};

	/** 展开/收起某个项目的会话列表；首次交互前（openProjects 为 null）默认只展开当前项目。 */
	const toggleProjectGroup = (path: string): void => {
		const key = normPath(path);
		setOpenProjects((current) => {
			const expandedNow = (current?.has(key) ?? false) || (current === null && samePath(path, activeProject));
			const next = new Set(current ?? (activeProject ? [normPath(activeProject)] : []));
			if (expandedNow) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	/** 项目会话列表是否展开（openProjects 为 null 视作仅当前项目展开）。 */
	const projectGroupOpen = (path: string): boolean => {
		if (openProjects === null) return samePath(path, activeProject);
		return openProjects.has(normPath(path));
	};

	const isOpen = (id: string): boolean => !collapsed.has(id);

	// rail 回到聊天视图：把会话列表滚回顶部。
	useEffect(() => {
		if (focus === "chat" || focus === "research") scrollRef.current?.scrollTo({ top: 0 });
	}, [focus]);

	// 活动会话变化（分支跳转、快捷键循环）：把当前行滚进可视区，长列表里也能
	// 一眼看到跳到了哪条。点击打开的激活除外——用户刚点的行就在指针下，跟随只会
	// 把列表拉离原位（点击后列表刷新还会让行位置短暂偏移，跟随变成可见的跳动）。
	// 行不在 DOM（所在分组折叠/被过滤）时静默跳过。
	const clickFollowSuppressedAt = useRef(0);
	useEffect(() => {
		if (!activeId || minimized) return;
		if (Date.now() - clickFollowSuppressedAt.current < 2000) return;
		const frame = requestAnimationFrame(() => {
			scrollRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [activeId, minimized, allSessions]);

	const togglePin = (id: string): void => {
		setPinned((current) => {
			const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
			localStorage.setItem(keys.pinned, JSON.stringify(next));
			return next;
		});
	};

	/** 归档会话：成功后从侧栏移除，恢复和删除由设置页统一管理。 */
	const archiveSession = async (row: SessionRow): Promise<void> => {
		const id = row.id;
		if (!id) return;
		try {
			const response = await client.request({
				type: "session.archive",
				sessionId: id,
			});
			if (!response.ok) {
				setProjectNotice(response.error ?? t("sidebar.archiveFailed"));
				return;
			}
			// 当前会话归档后不再留在主界面，否则侧栏找不到它，发送仍会进这条会话。
			if (id === activeId) onNewChat();
			void refresh();
		} catch (error) {
			setProjectNotice(error instanceof Error ? error.message : t("sidebar.archiveFailed"));
		}
	};

	const renameSession = async (row: SessionRow, name: string): Promise<void> => {
		const id = row.id;
		if (!id || renameBusy) return;
		setRenameBusy(true);
		setRenameError("");
		try {
			const response = await client.request<{ name: string }>({ type: "session.rename", sessionId: id, name });
			if (!response.ok) {
				setRenameError(response.error ?? t("sidebar.renameFailed"));
				return;
			}
			setRenaming(null);
			onSessionRenamed?.(id, response.result?.name ?? name);
			void refresh();
		} catch {
			setRenameError(t("sidebar.renameFailed"));
		} finally {
			setRenameBusy(false);
		}
	};

	/** 在系统资源管理器中定位项目目录（缺省为当前项目）。 */
	const revealProject = async (path: string = activeProject): Promise<void> => {
		try {
			await client.request({ type: "open.external", action: "reveal", target: ".", cwd: path });
		} catch {
			// 桥未连接等瞬时失败：静默跳过
		}
	};

	/** 确认删除：桥上卸载运行时并删历史文件；删的是当前会话时切到新会话。 */
	const deleteSession = async (row: SessionRow): Promise<void> => {
		const id = row.id;
		if (!id) return;
		setDeleting(true);
		setDeleteError("");
		try {
			const response = await client.request({ type: "session.delete", sessionId: id });
			if (!response.ok) {
				setDeleteError(response.error ?? t("common.deleteFailed"));
				return;
			}
			setPinned((current) => {
				const next = current.filter((v) => v !== id);
				localStorage.setItem(keys.pinned, JSON.stringify(next));
				return next;
			});
			setConfirmDelete(null);
			if (id === activeId) onNewChat();
			void refresh();
		} catch (error) {
			setDeleteError(error instanceof Error ? error.message : String(error));
		} finally {
			setDeleting(false);
		}
	};

	const search = query.trim().toLowerCase();

	/** 已归档的会话在设置页管理，侧栏所有分组一律隐藏。 */
	const isArchivedRow = (row: SessionRow): boolean => typeof row.archivedAt === "string" && row.archivedAt !== "";

	// 弹窗中的标题/项目匹配；后台侧栏保留原列表和展开状态。
	const sessionMatches = (row: SessionRow): boolean =>
		!search ||
		sessionTitle(row).toLowerCase().includes(search) ||
		(row.cwd ?? "").toLowerCase().includes(search) ||
		(row.cwd ? projectLabel(row.cwd).toLowerCase().includes(search) : false);

	const byLatest = (a: SessionRow, b: SessionRow): number => {
		const left = sessionTime(a);
		const right = sessionTime(b);
		if (left !== right) return left < right ? 1 : -1;
		return String(a.id ?? "").localeCompare(String(b.id ?? ""));
	};

	/** 置顶会话只在「置顶」区出现，其余分组一律排除，避免同一会话重复两行。 */
	const isPinnedRow = (row: SessionRow): boolean => row.id !== undefined && pinned.includes(row.id);

	const pinnedSessions = useMemo(() => {
		const rows = sessions.filter((row) => row.id !== undefined && pinned.includes(row.id) && !isArchivedRow(row));
		if (pinnedSort === "manual") {
			// 手动排序 = 置顶操作发生的先后顺序（pinned 数组序）
			return rows.sort((a, b) => pinned.indexOf(a.id as string) - pinned.indexOf(b.id as string));
		}
		return rows.sort(byLatest);
	}, [sessions, pinned, pinnedSort]); // eslint-disable-line react-hooks/exhaustive-deps

	// 项目列表 = 当前项目 ∪ 有会话的项目 ∪ 到访过的项目，按路径去重。
	// 保留目录（默认目录/助理目录）不算普通项目：一律不进项目分组（即使是当前项目，
	// 当前位置由顶栏与输入框 chip 标识），其会话仍列在「最近会话」。
	// 排序：按最近会话活动时间降序（无会话的按名称垫底）；
	// 切项目不改变顺序，避免点击的项目跳到列表顶部。
	const projectPaths = useMemo(() => {
		const map = new Map<string, { path: string; latest: string }>();
		const track = (path: string | undefined, time?: string): void => {
			if (!path || isReservedDir(path) || isValidationDir(path)) return;
			const key = normPath(path);
			const existing = map.get(key);
			if (!existing) map.set(key, { path, latest: time ?? "" });
			else if ((time ?? "") > existing.latest) existing.latest = time ?? "";
		};
		track(activeProject);
		for (const row of sessions) track(row.cwd, sessionTime(row));
		for (const path of knownProjects) track(path);
		return [...map.values()]
			.sort((a, b) => {
				if (a.latest !== b.latest) return a.latest > b.latest ? -1 : 1;
				return projectLabel(a.path).localeCompare(projectLabel(b.path), "zh-CN");
			})
			.map((entry) => entry.path);
	}, [sessions, knownProjects, projectRevision]);

	const visibleProjects = useMemo(
		() => projectPaths.filter((path) => !projectPreferences.hidden.includes(normPath(path))),
		[projectPaths, projectPreferences],
	);

	const recentSessions = useMemo(() => {
		const rows = sessions.filter((row) => !isArchivedRow(row) && !isPinnedRow(row));
		if (recentSort === "name") {
			rows.sort((a, b) => sessionTitle(a).localeCompare(sessionTitle(b), "zh-CN"));
		} else if (recentSort === "oldest")
			rows.sort((a, b) => String(a.created ?? sessionTime(a)).localeCompare(String(b.created ?? sessionTime(b))));
		else rows.sort(byLatest);
		return rows;
	}, [sessions, recentSort, projectRevision, pinned]); // eslint-disable-line react-hooks/exhaustive-deps

	/** 行内操作保留键盘入口，样式统一在侧边栏内控制。 */
	const rowBtn = "owl-sidebar-action";

	/** 会话行悬停 tooltip：标题 + 时间 · 项目（单行化后元信息收进这里）。 */
	const sessionRowTip = (row: SessionRow): string => {
		const time = relativeTime(sessionTime(row));
		return [
			...new Set(
				[
					sessionTitle(row),
					row.name?.trim(),
					row.firstMessage?.trim(),
					`${time}${row.cwd ? ` · ${row.cwd}` : ""}`,
					row.id,
					row.path,
				].filter((part): part is string => Boolean(part)),
			),
		].join("\n");
	};

	/**
	 * 会话行（单行紧凑式）：标题在左，状态点靠右。运行中绿点闪烁，跑完未看为实心绿点，看过后变浅灰。
	 * 悬停露出会话操作菜单，避免多个操作图标挤占标题空间。
	 */
	const sessionRow = (
		row: SessionRow,
		index: number,
		pinnedRow: boolean,
		location: string,
		projectPath?: string,
		overflow = false,
	): React.JSX.Element => {
		const id = row.id;
		const isRunning = id !== undefined && runningSessions.has(id);
		const unread = isSessionUnread(projectPreferences, row);
		const time = relativeTime(sessionTime(row));
		const menuKey = `${SESSION_ROW_MENU_PREFIX}${location}:${id ?? index}`;
		const menuOpen = openMenu === menuKey && sessionMenu?.key === menuKey;
		// 仅项目分组内的完整会话列表可拖拽排序。
		const draggable = projectPath !== undefined && id !== undefined;
		const dropBefore =
			!overflow && projectPath !== undefined && dropHint?.path === normPath(projectPath) && dropHint.index === index;
		const dropAfter =
			!overflow &&
			projectPath !== undefined &&
			dropHint?.path === normPath(projectPath) &&
			dropHint.index === index + 1;
		return (
			<div
				key={id ?? index}
				data-sidebar-window-overflow={overflow ? "true" : undefined}
				className={`owl-sidebar-row owl-sidebar-session-row ${id === activeId ? "is-active" : ""} ${
					id ? "owl-sidebar-row--has-marker" : ""
				} ${menuOpen ? "is-open" : ""} ${draggingSession && draggingSession.id === id ? "is-dragging" : ""} ${
					dropBefore ? "is-drop-before" : ""
				} ${dropAfter ? "is-drop-after" : ""}`}
				draggable={draggable || undefined}
				onContextMenu={
					id
						? (event) => {
								// 右键弹出会话操作菜单（与 ⋯ 按钮同一张）；定位到指针处
								event.preventDefault();
								const anchor = event.currentTarget.querySelector<HTMLButtonElement>(".owl-sidebar-row-main");
								if (!anchor) return;
								setSessionMenu({ key: menuKey, row, anchor, point: { x: event.clientX, y: event.clientY } });
								setOpenMenu(menuKey);
							}
						: undefined
				}
				onDragStart={
					draggable
						? (event) => {
								// 从行尾操作按钮（⋯）起拖视为误操作：不进入拖拽。
								if ((event.target as HTMLElement).closest(".owl-sidebar-row-actions")) {
									event.preventDefault();
									return;
								}
								event.dataTransfer.effectAllowed = "move";
								event.dataTransfer.setData("text/plain", id!);
								setDraggingSession({ id: id!, fromPath: normPath(projectPath!) });
							}
						: undefined
				}
				onDragEnd={
					draggable
						? () => {
								setDraggingSession(null);
								setDropHint(null);
							}
						: undefined
				}
			>
				<button
					type="button"
					className="owl-sidebar-row-main"
					title={sessionRowTip(row)}
					aria-current={id === activeId ? "page" : undefined}
					onClick={() => {
						if (id) {
							clickFollowSuppressedAt.current = Date.now();
							markSessionsRead(sessionScope, [row]);
							onOpenSession(id);
							if (drawerMode) setDrawerOpen(false);
						}
					}}
				>
					<span className="owl-sidebar-row-label">{sessionTitle(row)}</span>
					{time && <span className="owl-sidebar-row-time">{time}</span>}
					<span
						className={`owl-sidebar-session-dot${isRunning ? " is-running" : unread ? " is-unread" : id !== undefined && (draftSessions?.has(id) ?? false) ? " is-draft" : ""}`}
						data-draft={(id !== undefined && (draftSessions?.has(id) ?? false)) || undefined}
						title={
							isRunning
								? t("sidebar.runningTip")
								: unread
									? t("sidebar.unreadTip")
									: (draftSessions?.has(id ?? "") ?? false)
										? t("sidebar.draftTip")
										: t("sidebar.readTip")
						}
					/>
					{isRunning && <span className="sr-only">{t("sidebar.runningSr")}</span>}
				</button>
				{id && (
					<div data-menu-root className="owl-sidebar-row-actions" data-persistent={pinnedRow}>
						<button
							type="button"
							className={`${rowBtn} ${pinnedRow ? "owl-sidebar-action--persistent" : ""}`}
							title={t("sidebar.sessionActions")}
							aria-label={t("sidebar.sessionActionsAria", { name: sessionTitle(row) })}
							aria-haspopup="menu"
							aria-expanded={menuOpen}
							aria-controls={menuOpen ? sessionMenuId : undefined}
							onClick={(event) => {
								event.stopPropagation();
								if (menuOpen) closeSessionMenu();
								else {
									setSessionMenu({ key: menuKey, row, anchor: event.currentTarget });
									setOpenMenu(menuKey);
								}
							}}
						>
							<IconMore className="h-3.5 w-3.5 rotate-90" />
						</button>
					</div>
				)}
			</div>
		);
	};

	/**
	 * 项目下的未归档会话（置顶会话只在「置顶」分组出现）。排序规则：
	 * 有手动顺序（拖拽过）的项目按手动序渲染，未收录的（新建）会话按最近活动排在最前；
	 * 没有手动顺序时，最新创建的会话固定第一位（新对话默认置顶），其余按当前排序偏好。
	 */
	const projectSessionRows = (path: string): SessionRow[] => {
		const sorted = sessions
			.filter((row) => !isArchivedRow(row) && !isPinnedRow(row) && samePath(row.cwd, path))
			.sort((a, b) =>
				recentSort === "name"
					? sessionTitle(a).localeCompare(sessionTitle(b), getUiLanguage())
					: recentSort === "oldest"
						? String(a.created ?? sessionTime(a)).localeCompare(String(b.created ?? sessionTime(b)))
						: byLatest(a, b),
			);
		const manual = sessionOrder[normPath(path)];
		if (manual && manual.length > 0) {
			const rank = new Map(manual.map((id, index) => [id, index]));
			const listed = sorted
				.filter((row) => row.id !== undefined && rank.has(row.id))
				.sort((a, b) => (rank.get(a.id!) ?? 0) - (rank.get(b.id!) ?? 0));
			const unlisted = sorted.filter((row) => row.id === undefined || !rank.has(row.id)).sort(byLatest);
			return [...unlisted, ...listed];
		}
		// 最新创建的会话置顶：按名称/从旧到新排序时新对话也不会被插到中间。
		const newest = sorted.reduce<SessionRow | null>(
			(top, row) => (!top || String(row.created ?? "") > String(top.created ?? "") ? row : top),
			null,
		);
		return newest ? [newest, ...sorted.filter((row) => row !== newest)] : sorted;
	};

	/** A single project row implementation serves default and partitioned project sections. */
	const projectRow = (path: string): React.JSX.Element => {
		const isCurrent = samePath(path, activeProject);
		const menuId = `${PROJECT_ROW_MENU_PREFIX}${normPath(path)}`;
		const expanded = projectGroupOpen(path);
		const rows = projectSessionRows(path);
		const name = projectLabel(path);
		const windowKey = "project:" + normPath(path);
		const windowed = sessionWindow(rows, windowKey);
		return (
			<div key={menuId} className="owl-sidebar-project-group" data-project-path={normPath(path)}>
				<div
					className={`owl-sidebar-row owl-sidebar-project-row owl-sidebar-row--has-marker ${isCurrent ? "is-current" : ""} ${openMenu === menuId ? "is-open" : ""}`}
				>
					<button
						type="button"
						className="owl-sidebar-project-toggle"
						data-icon={expanded ? "folder-open" : "folder"}
						aria-expanded={expanded}
						aria-label={t("sidebar.projectToggleAria", { project: name })}
						title={expanded ? t("sidebar.collapseList") : t("sidebar.expandList")}
						onClick={() => toggleProjectGroup(path)}
					>
						{expanded ? (
							<IconFolderOpen className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" />
						) : (
							<IconFolder className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" />
						)}
					</button>
					<button
						type="button"
						className="owl-sidebar-row-main"
						title={path}
						aria-expanded={expanded}
						aria-label={
							isCurrent
								? t("sidebar.currentProjectAria", { project: name })
								: t("sidebar.switchToProjectAria", { project: name })
						}
						onClick={() => {
							toggleProjectGroup(path);
							onSelectProject(path);
							if (drawerMode) setDrawerOpen(false);
						}}
					>
						<span className="owl-sidebar-row-label">{name}</span>
					</button>
					<div data-menu-root className="owl-sidebar-row-actions">
						<button
							type="button"
							className="owl-sidebar-action"
							title={t("sidebar.projectActions")}
							aria-label={t("sidebar.projectActionsAria", { project: name })}
							aria-haspopup="menu"
							aria-expanded={openMenu === menuId}
							aria-controls={openMenu === menuId ? projectMenuId : undefined}
							onClick={(event) => {
								if (openMenu === menuId) closeProjectPopup();
								else {
									setProjectPopup({ key: menuId, kind: "project", path, anchor: event.currentTarget });
									setOpenMenu(menuId);
								}
							}}
						>
							<IconMore className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							className="owl-sidebar-action"
							title={t("sidebar.newChatInProject")}
							aria-label={t("sidebar.newChatInProjectAria", { project: name })}
							onClick={() => {
								setOpenMenu(null);
								onNewChatInProject(path);
								if (drawerMode) setDrawerOpen(false);
							}}
						>
							<IconCompose className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				{expanded && (
					<div
						className="owl-sidebar-project-sessions"
						onDragOver={(event) => {
							const target = normPath(path);
							if (!draggingSession || draggingSession.fromPath !== target) return;
							event.preventDefault();
							event.dataTransfer.dropEffect = "move";
							const index = sessionDropIndex(event.currentTarget, event.clientY);
							setDropHint((current) =>
								current?.path === target && current.index === index ? current : { path: target, index },
							);
						}}
						onDrop={(event) => {
							const drag = draggingSession;
							const target = normPath(path);
							if (!drag || drag.fromPath !== target) return;
							event.preventDefault();
							const ids = rows.map((row) => row.id).filter((value): value is string => value !== undefined);
							const oldIndex = ids.indexOf(drag.id);
							if (oldIndex === -1) return;
							const without = ids.filter((value) => value !== drag.id);
							const hintIndex = dropHint?.path === target ? dropHint.index : oldIndex;
							// 落点按含拖拽行的渲染序计；先摘掉拖拽行，之后的落点前移一位。
							const insert = Math.min(
								Math.max(hintIndex > oldIndex ? hintIndex - 1 : hintIndex, 0),
								without.length,
							);
							without.splice(insert, 0, drag.id);
							const next = { ...sessionOrder, [target]: without };
							setSessionOrder(next);
							try {
								localStorage.setItem(keys.sessionOrder, JSON.stringify(next));
							} catch {
								// localStorage 不可用时手动顺序退化为本次会话内存态
							}
							setDraggingSession(null);
							setDropHint(null);
						}}
					>
						{windowed.rows.map((row, index) =>
							sessionRow(row, index, false, menuId, path, index >= visibleCount(windowKey)),
						)}
						{listControls(windowKey, windowed.total, name)}
						{rows.length === 0 && <p className="owl-sidebar-empty">{t("sidebar.none")}</p>}
					</div>
				)}
			</div>
		);
	};
	const renderProjectContents = (paths: string[], location: string): React.ReactNode => {
		if (projectPreferences.view === "projects") {
			// 当前项目即使排在窗口外也常驻显示，且不计入「再显示 N 个」。
			const windowKey = "projects:" + location;
			const limit = visibleCount(windowKey);
			const activeIndex = paths.findIndex((path) => samePath(path, activeProject));
			const activeOutside = activeIndex >= limit;
			const shown = activeOutside ? [...paths.slice(0, limit), paths[activeIndex]!] : paths.slice(0, limit);
			return (
				<>
					{shown.map(projectRow)}
					{listControls(
						windowKey,
						paths.length - (activeOutside ? 1 : 0),
						pt("defaultSection"),
						"showMoreProjects",
					)}
				</>
			);
		}
		const pathsSet = new Set(paths.map(normPath));
		const rows = sessions
			.filter((row) => !isArchivedRow(row) && !isPinnedRow(row) && pathsSet.has(normPath(row.cwd)))
			.sort((a, b) =>
				recentSort === "name"
					? sessionTitle(a).localeCompare(sessionTitle(b), getUiLanguage())
					: recentSort === "oldest"
						? String(a.created ?? sessionTime(a)).localeCompare(String(b.created ?? sessionTime(b)))
						: byLatest(a, b),
			);
		const windowKey = "merged:" + location;
		const windowed = sessionWindow(rows, windowKey);
		return rows.length ? (
			<>
				{windowed.rows.map((row, index) =>
					sessionRow(row, index, false, location, undefined, index >= visibleCount(windowKey)),
				)}
				{listControls(windowKey, windowed.total, pt("defaultSection"))}
			</>
		) : (
			<p className="owl-sidebar-empty">{t("sidebar.none")}</p>
		);
	};
	const defaultProjects = visibleProjects.filter(
		(path) => projectPreferences.assignments[normPath(path)] === undefined,
	);
	const renderRecentRows = (rows: SessionRow[], location: string, overflowId?: string): React.ReactNode => {
		const groups = groupSessionsByPeriod(rows);
		if (recentSort === "oldest") groups.reverse();
		return groups.map(({ period, rows: periodRows }) => (
			<div key={period} className="owl-sidebar-date-group" data-session-period={period}>
				<h3 className="owl-sidebar-date-label">
					{t(
						period === "today"
							? "history.today"
							: period === "yesterday"
								? "sidebar.yesterday"
								: "myself.groupEarlier",
					)}
				</h3>
				{periodRows.map((row, index) => sessionRow(row, index, false, location, undefined, row.id === overflowId))}
			</div>
		));
	};
	const renderRecentContents = (): React.ReactNode => {
		const recentWindow = sessionWindow(recentSessions, "recent");
		const rows = recentWindow.rows;
		const overflowId = rows.length > visibleCount("recent") ? rows.at(-1)?.id : undefined;
		const controls = listControls(
			"recent",
			recentWindow.total,
			sessionScope === "research" ? researchText.recent : t("sidebar.sectionRecent"),
		);
		if (projectPreferences.recentView === "merged")
			return (
				<>
					{renderRecentRows(rows, "recent", overflowId)}
					{controls}
				</>
			);
		const groups = new Map<string, { path?: string; rows: SessionRow[] }>();
		for (const row of rows) {
			const key = normPath(row.cwd);
			const group = groups.get(key);
			if (group) group.rows.push(row);
			else groups.set(key, { path: row.cwd, rows: [row] });
		}
		return (
			<>
				{[...groups].map(([pathKey, group]) => {
					const key = `recent-project:${pathKey || "standalone"}`;
					const expanded = isOpen(key);
					const name = group.path ? projectLabel(group.path) : pt("standalone");
					return (
						<div key={key} className="owl-sidebar-project-group" data-recent-project={pathKey || "standalone"}>
							<div className="owl-sidebar-row">
								<button
									type="button"
									className="owl-sidebar-row-main"
									title={group.path ?? name}
									aria-expanded={expanded}
									data-icon={group.path ? (expanded ? "folder-open" : "folder") : undefined}
									aria-label={t("sidebar.projectToggleAria", { project: name })}
									onClick={() => toggleSection(key)}
								>
									{group.path ? (
										expanded ? (
											<IconFolderOpen className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" />
										) : (
											<IconFolder className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" />
										)
									) : (
										<>
											<IconChevron
												className={`h-3 w-3 shrink-0 text-owl-sidebar-faint transition-transform ${expanded ? "rotate-90" : ""}`}
											/>
											<IconChat className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" />
										</>
									)}
									<span className="owl-sidebar-row-label">{name}</span>
								</button>
							</div>
							{expanded && (
								<div className="owl-sidebar-project-sessions">
									{renderRecentRows(group.rows, key, overflowId)}
								</div>
							)}
						</div>
					);
				})}
				{controls}
			</>
		);
	};
	const savePreferences = (next: ProjectSidebarPreferences): void => saveProjectSidebarPreferences(sessionScope, next);
	const confirmProjectAction = async (): Promise<void> => {
		if (!projectConfirm || projectBusyRef.current) return;
		if (projectConfirm.type === "section-remove") {
			if (projectConfirm.sectionId)
				savePreferences(removeProjectSection(projectPreferences, projectConfirm.sectionId));
			setProjectConfirm(null);
			return;
		}
		const path = projectConfirm.path;
		if (!path) return;
		if (projectConfirm.type === "remove") {
			savePreferences(hideProject(projectPreferences, path));
			const nextKnown = knownProjects.filter((entry) => !samePath(entry, path));
			setKnownProjects(nextKnown);
			localStorage.setItem(keys.projects, JSON.stringify(nextKnown));
			setProjectConfirm(null);
			return;
		}
		const targets = sessions.filter((row) => row.id && !isArchivedRow(row) && samePath(row.cwd, path));
		let done = 0;
		let failed = 0;
		let running = 0;
		projectBusyRef.current = true;
		setProjectBusy(true);
		try {
			for (const row of targets) {
				if (row.id && runningSessions.has(row.id)) {
					running++;
					continue;
				}
				try {
					const result = await client.request({ type: "session.archive", sessionId: row.id! });
					if (result.ok) done++;
					else failed++;
				} catch {
					failed++;
				}
			}
			await refresh();
			setProjectNotice(
				pt("archiveResult")
					.replace("{done}", String(done))
					.replace("{failed}", String(failed))
					.replace("{running}", String(running)),
			);
			setProjectConfirm(null);
		} finally {
			projectBusyRef.current = false;
			setProjectBusy(false);
		}
	};

	const metadataSessions: SessionSearchHit[] = search
		? allSessions
				.filter(sessionMatches)
				.filter((row) => row.id)
				.map((row) => ({
					sessionId: row.id!,
					cwd: row.cwd ?? "",
					title: sessionTitle(row),
					scope: matchesSessionScope(row, "research") ? "research" : "chat",
					archived: isArchivedRow(row),
					modified: sessionTime(row),
					entryId: "",
					role: "user",
					excerpt: "",
					matchRanges: [],
				}))
		: [];
	const searchProjects = search
		? [
				...new Map(
					[...projectPaths, ...allSessions.map((row) => row.cwd).filter((path): path is string => Boolean(path))]
						.filter(
							(path) =>
								!isReservedDir(path) &&
								!isValidationDir(path) &&
								(projectLabel(path).toLowerCase().includes(search) || path.toLowerCase().includes(search)),
						)
						.map((path) => [normPath(path), path]),
				).values(),
			]
		: [];

	/** 分组头部快捷按钮的统一样式。 */
	const actionBtn = "owl-sidebar-action";
	const switchPinnedSort = (value: PinnedSort): void => {
		setPinnedSort(value);
		saveChoice(keys.pinnedSort, value);
		setOpenMenu(null);
	};
	const switchRecentSort = (value: ListSort): void => {
		setRecentSort(value);
		saveChoice(keys.recentSort, value);
		setOpenMenu(null);
	};
	const openNewProject = (): void => {
		setShowNewProject(true);
		setOpenMenu(null);
	};

	return (
		<>
			{drawerMode && !minimized && !drawerOpen && (
				<button
					ref={drawerTriggerRef}
					type="button"
					className="owl-sidebar-drawer-trigger"
					aria-label={t("sidebar.aria")}
					aria-controls="owl-session-sidebar"
					aria-expanded={false}
					title={t("sidebar.aria")}
					onClick={() => setDrawerOpen(true)}
				>
					<IconPanelLeft className="h-4 w-4" />
				</button>
			)}
			{drawerMode && !sidebarHidden && (
				<button
					type="button"
					className="owl-sidebar-backdrop"
					tabIndex={-1}
					aria-label={t("sidebar.collapseSidebar")}
					onClick={closeDrawer}
				/>
			)}
			<aside
				ref={asideRef}
				id="owl-session-sidebar"
				className={`owl-sidebar${drawerMode ? " owl-sidebar--drawer" : ""}${renderedSidebarWidth <= 232 ? " owl-sidebar--compact" : ""}`}
				role={drawerMode ? "dialog" : undefined}
				aria-modal={drawerMode && !sidebarHidden && !searchOpen ? true : undefined}
				aria-label={t("sidebar.aria")}
				hidden={sidebarHidden}
				style={{ width: renderedSidebarWidth, flexBasis: renderedSidebarWidth, maxWidth: maxSidebarWidth }}
			>
				<div className="owl-sidebar-header" data-tauri-drag-region="deep">
					<button
						type="button"
						className="owl-sidebar-brand"
						title={t("sidebar.collapseSidebar")}
						aria-label={t("sidebar.collapseSidebar")}
						aria-expanded={!minimized}
						onClick={onToggleMinimized}
					>
						<span className={sessionScope === "research" ? undefined : "owl-wordmark"}>
							{sessionScope === "research" ? researchText.title : "owl"}
						</span>
					</button>
					<div className="flex-1" data-tauri-drag-region="deep" />
					<span className="owl-sidebar-local-badge" title={t("sidebar.localBadgeTitle")}>
						LOCAL
					</span>
					{drawerMode && (
						<button
							type="button"
							className="owl-sidebar-drawer-close"
							aria-label={t("sidebar.collapseSidebar")}
							title={t("sidebar.collapseSidebar")}
							onClick={closeDrawer}
						>
							<IconPanelLeft className="h-4 w-4" />
						</button>
					)}
				</div>

				<div className="owl-sidebar-shortcuts">
					<button
						type="button"
						className="owl-sidebar-search-trigger"
						aria-label={searchText("title")}
						aria-haspopup="dialog"
						aria-expanded={searchOpen}
						title={t("sidebar.searchPlaceholder")}
						onClick={() => {
							setOpenMenu(null);
							setSessionMenu(null);
							setProjectPopup(null);
							setSearchOpen(true);
						}}
					>
						<IconSearch className="h-3.5 w-3.5 shrink-0" />
						<span>{searchText("title")}</span>
					</button>
					<button
						type="button"
						className="owl-sidebar-new-chat"
						aria-label={sessionScope === "research" ? researchText.newChat : t("sidebar.newChat")}
						onClick={() => {
							onNewChat();
							if (drawerMode) setDrawerOpen(false);
						}}
					>
						<IconCompose className="h-3.5 w-3.5 shrink-0" />
						<span>{sessionScope === "research" ? researchText.newChat : t("sidebar.newChat")}</span>
					</button>
				</div>

				<div ref={scrollRef} className="owl-sidebar-list">
					{pinnedSessions.length > 0 && (
						<Section
							id="pinned"
							label={t("sidebar.sectionPinned")}
							open={isOpen("pinned")}
							onToggle={() => toggleSection("pinned")}
							showMenu={openMenu === "pinned"}
							actions={
								<button
									type="button"
									className={actionBtn}
									title={t("sidebar.pinnedOptions")}
									aria-label={t("sidebar.pinnedOptions")}
									aria-expanded={openMenu === "pinned"}
									onClick={() => setOpenMenu(openMenu === "pinned" ? null : "pinned")}
								>
									<IconMore className="h-3.5 w-3.5" />
								</button>
							}
							menu={
								<>
									<MenuRow
										label={t("sidebar.sortByUpdated")}
										checked={pinnedSort === "recent"}
										onClick={() => switchPinnedSort("recent")}
									/>
									<MenuRow
										label={t("sidebar.sortManual")}
										checked={pinnedSort === "manual"}
										hint={t("sidebar.sortManualHint")}
										onClick={() => switchPinnedSort("manual")}
									/>
								</>
							}
						>
							{sessionWindow(pinnedSessions, "pinned").rows.map((row, index) =>
								sessionRow(row, index, true, "pinned", undefined, index >= visibleCount("pinned")),
							)}
							{listControls("pinned", sessionWindow(pinnedSessions, "pinned").total, t("sidebar.sectionPinned"))}
						</Section>
					)}

					<Section
						id="projects"
						label={t("sidebar.sectionProjects")}
						open={isOpen("projects")}
						onToggle={() => toggleSection("projects")}
						showMenu={openMenu === "projects"}
						actions={
							<>
								<button
									type="button"
									className={actionBtn}
									title={t("sidebar.projectOptions")}
									aria-label={t("sidebar.projectOptions")}
									aria-expanded={openMenu === "projects"}
									onClick={(event) => {
										if (openMenu === "projects") closeProjectPopup();
										else {
											setProjectPopup({ key: "projects", kind: "projects", anchor: event.currentTarget });
											setOpenMenu("projects");
										}
									}}
									aria-haspopup="menu"
									aria-controls={openMenu === "projects" ? projectMenuId : undefined}
								>
									<IconMore className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									className={actionBtn}
									title={t("sidebar.newProject")}
									aria-label={t("sidebar.newProject")}
									onClick={openNewProject}
								>
									<IconPlus className="h-3.5 w-3.5" />
								</button>
							</>
						}
					>
						{/* 项目列表：按最近活动排序（切项目不重排）；点击项目名切换，chevron 展开会话 */}
						{renderProjectContents(defaultProjects, "merged-default")}
					</Section>
					{projectPreferences.sections.map((section) => (
						<Section
							key={section.id}
							id={`partition-${section.id}`}
							label={section.name}
							open={isOpen(`partition-${section.id}`)}
							onToggle={() => toggleSection(`partition-${section.id}`)}
							showMenu={openMenu === `partition:${section.id}`}
							actions={
								<button
									type="button"
									className={actionBtn}
									aria-label={`${pt("section")}：${section.name}`}
									aria-haspopup="menu"
									aria-expanded={openMenu === `partition:${section.id}`}
									onClick={(event) => {
										const key = `partition:${section.id}`;
										if (openMenu === key) closeProjectPopup();
										else {
											setProjectPopup({
												key,
												kind: "section",
												sectionId: section.id,
												anchor: event.currentTarget,
											});
											setOpenMenu(key);
										}
									}}
								>
									<IconMore className="h-3.5 w-3.5" />
								</button>
							}
						>
							{renderProjectContents(
								visibleProjects.filter((path) => projectPreferences.assignments[normPath(path)] === section.id),
								`merged-${section.id}`,
							)}
						</Section>
					))}

					<Section
						id="recent"
						label={sessionScope === "research" ? researchText.recent : t("sidebar.sectionRecent")}
						open={isOpen("recent")}
						onToggle={() => toggleSection("recent")}
						showMenu={openMenu === "recent"}
						actions={
							<>
								<button
									type="button"
									className={actionBtn}
									title={t("sidebar.recentOptions")}
									aria-label={t("sidebar.recentOptions")}
									aria-expanded={openMenu === "recent"}
									aria-haspopup="menu"
									aria-controls={openMenu === "recent" ? projectMenuId : undefined}
									onClick={(event) => {
										if (openMenu === "recent") closeProjectPopup();
										else {
											setProjectPopup({ key: "recent", kind: "recent", anchor: event.currentTarget });
											setOpenMenu("recent");
										}
									}}
								>
									<IconMore className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									className={actionBtn}
									title={t("sidebar.newChatBtn")}
									aria-label={t("sidebar.newChatBtn")}
									onClick={() => {
										onNewChat();
										if (drawerMode) setDrawerOpen(false);
									}}
								>
									<IconCompose className="h-3.5 w-3.5" />
								</button>
							</>
						}
					>
						{renderRecentContents()}
						{recentSessions.length === 0 && <p className="owl-sidebar-empty">{t("sidebar.none")}</p>}
					</Section>

					{projectNotice && (
						<p className="owl-sidebar-notice" role="status">
							{projectNotice}
						</p>
					)}
				</div>
				{!sidebarHidden &&
					projectPopup !== null &&
					openMenu === projectPopup.key &&
					(projectPopup.kind === "project" && projectPopup.path ? (
						<ProjectActionsMenu
							anchor={projectPopup.anchor}
							menuId={projectMenuId}
							label={t("sidebar.projectActionsAria", { project: projectLabel(projectPopup.path) })}
							sections={projectPreferences.sections}
							sectionId={projectPreferences.assignments[normPath(projectPopup.path)] ?? null}
							onClose={closeProjectPopup}
							onEdit={() => setEditingProject(projectPopup.path ?? null)}
							onSection={(id) => {
								if (projectPopup.path)
									savePreferences(moveProjectToSection(projectPreferences, projectPopup.path, id));
							}}
							onNewSection={() => {
								setSectionError("");
								setSectionDialog({ path: projectPopup.path });
							}}
							onReveal={() => {
								if (projectPopup.path) void revealProject(projectPopup.path);
							}}
							onMarkRead={() => {
								markSessionsRead(
									sessionScope,
									sessions.filter((row) => samePath(row.cwd, projectPopup.path)),
								);
								setProjectNotice(pt("allRead"));
							}}
							onArchive={() => setProjectConfirm({ type: "archive", path: projectPopup.path })}
							onRemove={() => setProjectConfirm({ type: "remove", path: projectPopup.path })}
						/>
					) : projectPopup.kind === "projects" || projectPopup.kind === "recent" ? (
						<ProjectsSectionMenu
							anchor={projectPopup.anchor}
							menuId={projectMenuId}
							label={t(projectPopup.kind === "recent" ? "sidebar.recentOptions" : "sidebar.projectOptions")}
							organize={projectPopup.kind === "recent" ? projectPreferences.recentView : projectPreferences.view}
							sort={recentSort}
							onClose={closeProjectPopup}
							onOrganize={(view) =>
								savePreferences(
									projectPopup.kind === "recent"
										? { ...projectPreferences, recentView: view }
										: { ...projectPreferences, view },
								)
							}
							onSort={switchRecentSort}
						/>
					) : (
						<SectionActionsMenu
							anchor={projectPopup.anchor}
							menuId={projectMenuId}
							label={pt("section")}
							onClose={closeProjectPopup}
							onEdit={() => {
								setSectionError("");
								setSectionDialog({ id: projectPopup.sectionId });
							}}
							onRemove={() => setProjectConfirm({ type: "section-remove", sectionId: projectPopup.sectionId })}
						/>
					))}
				{!sidebarHidden && sessionMenu !== null && openMenu === sessionMenu.key && (
					<SessionActionsMenu
						key={sessionMenu.key}
						anchor={sessionMenu.anchor}
						point={sessionMenu.point}
						menuId={sessionMenuId}
						label={t("sidebar.sessionActionsAria", { name: sessionTitle(sessionMenu.row) })}
						pinned={sessionMenu.row.id !== undefined && pinned.includes(sessionMenu.row.id)}
						session={{
							id: sessionMenu.row.id,
							cwd: sessionMenu.row.cwd || undefined,
							file: sessionMenu.row.path || undefined,
						}}
						onClose={closeSessionMenu}
						onPin={() => {
							if (sessionMenu.row.id) togglePin(sessionMenu.row.id);
						}}
						onRename={
							sessionMenu.row.id
								? () => {
										setRenameError("");
										setRenaming(sessionMenu.row);
									}
								: undefined
						}
						onArchive={() => void archiveSession(sessionMenu.row)}
						onDelete={() => {
							setConfirmDelete(sessionMenu.row);
							setDeleteError("");
						}}
						onReveal={sessionMenu.row.cwd ? () => void revealProject(sessionMenu.row.cwd!) : undefined}
					/>
				)}

				{showNewProject && (
					<NewProjectDialog
						client={client}
						onClose={() => setShowNewProject(false)}
						onCreated={(path) => {
							setShowNewProject(false);
							restoreProject(path, sessionScope);
							setKnownProjects((current) => {
								const next = current.some((entry) => samePath(entry, path)) ? current : [...current, path];
								localStorage.setItem(keys.projects, JSON.stringify(next));
								return next;
							});
							onSelectProject(path);
							if (drawerMode) setDrawerOpen(false);
						}}
					/>
				)}
				{editingProject !== null && (
					<NewProjectDialog
						client={client}
						initialProject={{ path: editingProject, name: projectLabel(editingProject) }}
						onClose={() => setEditingProject(null)}
						onCreated={() => setEditingProject(null)}
					/>
				)}
				{sectionDialog !== null && (
					<ProjectSidebarDialog
						key={sectionDialog.id ?? `new:${sectionDialog.path}`}
						title={pt(sectionDialog.id ? "renameSection" : "createSection")}
						fieldLabel={pt("sectionName")}
						initialValue={
							projectPreferences.sections.find((section) => section.id === sectionDialog.id)?.name ?? ""
						}
						error={sectionError}
						confirmLabel={pt("save")}
						onClose={() => setSectionDialog(null)}
						onSubmit={(name) => {
							if (
								projectPreferences.sections.some(
									(section) =>
										section.id !== sectionDialog.id && section.name.toLowerCase() === name.toLowerCase(),
								)
							) {
								setSectionError(pt("sectionDuplicate"));
								return;
							}
							const id = sectionDialog.id ?? crypto.randomUUID();
							let next = {
								...projectPreferences,
								sections: sectionDialog.id
									? projectPreferences.sections.map((section) =>
											section.id === id ? { ...section, name } : section,
										)
									: [...projectPreferences.sections, { id, name }],
							};
							if (sectionDialog.path) next = moveProjectToSection(next, sectionDialog.path, id);
							savePreferences(next);
							setSectionDialog(null);
						}}
					/>
				)}
				{projectConfirm !== null && (
					<ProjectSidebarDialog
						title={pt(
							projectConfirm.type === "archive"
								? "archiveTitle"
								: projectConfirm.type === "remove"
									? "removeTitle"
									: "removeSection",
						)}
						description={
							(projectConfirm.path ? `${projectLabel(projectConfirm.path)}\n` : "") +
							pt(
								projectConfirm.type === "archive"
									? "archiveHint"
									: projectConfirm.type === "remove"
										? "removeHint"
										: "removeSectionHint",
							)
						}
						busy={projectBusy}
						confirmLabel={pt("confirm")}
						onClose={() => {
							if (!projectBusyRef.current) setProjectConfirm(null);
						}}
						onSubmit={() => void confirmProjectAction()}
					/>
				)}

				{renaming !== null && (
					<ProjectSidebarDialog
						key={renaming.id ?? sessionRenameDraft(renaming)}
						title={t("sidebar.renameTitle")}
						fieldLabel={t("sidebar.renameField")}
						initialValue={sessionRenameDraft(renaming)}
						error={renameError}
						busy={renameBusy}
						confirmLabel={t("sidebar.renameSave")}
						onClose={() => {
							if (!renameBusy) setRenaming(null);
						}}
						onSubmit={(name) => void renameSession(renaming, name)}
					/>
				)}
				{confirmDelete && (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog">
						<div className="w-80 rounded-xl border border-owl-border bg-owl-panel p-4 shadow-2xl shadow-black/40">
							<h2 className="mb-1 text-sm font-semibold text-owl-text">{t("sidebar.deleteSessionTitle")}</h2>
							<p className="mb-3 break-all text-xs text-owl-muted">
								{t("sidebar.deleteDialogBody", { name: sessionTitle(confirmDelete) })}
							</p>
							{deleteError && <p className="mt-2 text-xs text-owl-danger">{deleteError}</p>}
							<div className="mt-4 flex justify-end gap-2">
								<button
									type="button"
									className="rounded-lg border border-owl-border px-3 py-1.5 text-xs text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
									onClick={() => setConfirmDelete(null)}
									disabled={deleting}
								>
									{t("common.cancel")}
								</button>
								<button
									type="button"
									className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-400 disabled:opacity-50"
									onClick={() => void deleteSession(confirmDelete)}
									disabled={deleting}
								>
									{deleting ? t("sidebar.deleting") : t("common.delete")}
								</button>
							</div>
						</div>
					</div>
				)}

				<div
					className={`owl-sidebar-resizer${resizing ? " is-active" : ""}`}
					hidden={drawerMode}
					data-tauri-drag-region="false"
					role="separator"
					tabIndex={0}
					aria-orientation="vertical"
					aria-label={resizeAria}
					aria-controls="owl-session-sidebar"
					aria-valuemin={Math.min(SIDEBAR_MIN_WIDTH, maxSidebarWidth)}
					aria-valuemax={maxSidebarWidth}
					aria-valuenow={visibleSidebarWidth}
					title={resizeAria}
					onPointerDown={beginSidebarResize}
					onKeyDown={resizeSidebarWithKeyboard}
					onDoubleClick={() => {
						try {
							localStorage.removeItem(WIDTH_KEY);
						} catch {
							/* 会话内仍可复位。 */
						}
						setSidebarWidth(null);
					}}
				/>
			</aside>
			{searchOpen && (
				<SessionSearchDialog
					client={client}
					connected={connected}
					query={query}
					activeProject={activeProject}
					refreshKey={refreshKey}
					revision={revision}
					metadataSessions={metadataSessions}
					projects={searchProjects}
					placeholder={sessionScope === "research" ? researchText.search : t("sidebar.searchPlaceholder")}
					onQueryChange={setQuery}
					onClose={closeSearch}
					onOpenHit={(hit, searchQuery) => {
						closeSearch();
						if (onOpenSearchHit) onOpenSearchHit(hit, searchQuery);
						else onOpenSession(hit.sessionId);
						if (drawerMode) setDrawerOpen(false);
					}}
					onSelectProject={(path) => {
						closeSearch();
						onSelectProject(path);
						if (drawerMode) setDrawerOpen(false);
					}}
				/>
			)}
		</>
	);
}
