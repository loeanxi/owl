import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import { normPath, samePath } from "../utils/paths.ts";
import { getProjectDisplayName as projectLabel, getProjectSidebarPreferences, saveProjectSidebarPreferences, useProjectSidebarRevision, restoreProject, moveProjectToSection, removeProjectSection, hideProject, initializeReadMarkers, markSessionsRead, isSessionUnread, type ProjectSidebarPreferences } from "../project-sidebar-model.ts";
import { initializeResearchSidebar, loadSidebarStrings, matchesSessionScope, sidebarStorageKeys, type SessionScope } from "./sidebar-scope.ts";
import { startPointerDrag } from "../sidebar/pointer-drag.ts";
import { getUiLanguage, t, useT } from "../i18n/index.ts";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { SessionActionsMenu } from "./SessionActionsMenu.tsx";
import { ProjectActionsMenu, ProjectsSectionMenu, SectionActionsMenu } from "./ProjectActionsMenu.tsx";
import { ProjectSidebarDialog } from "./ProjectSidebarDialog.tsx";
import { useProjectSidebarText } from "./project-sidebar-copy.ts";
import {
	IconChat,
	IconCheck,
	IconSessionMark,
	IconChevron,
	IconCompose,
	IconFolder,
	IconMore,
	IconPlus,
	IconSearch,
} from "./icons.tsx";
import type { RailView } from "./ActivityRail.tsx";
import "./navigation-design.css";

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
	/** 归档时间（ISO）。存在 = 已归档；由桥端 archive.json 下发。 */
	archivedAt?: string;
	scope?: SessionScope;
	[key: string]: unknown;
};

const PINNED_KEY = "owl.pinnedSessions";
/** 置顶项目（localStorage）：置顶栏里的项目快捷入口，项目本身仍留在「项目」分组。 */
const PINNED_PROJECTS_KEY = "owl.pinnedProjects";
const COLLAPSED_KEY = "owl.sidebar.collapsed";
/** 侧栏宽度（localStorage）：右缘拖拽调整，双击手柄复位为 CSS 默认值。 */
const WIDTH_KEY = "owl.sidebar.width";
/** 侧栏宽度下限；上限同时受「聊天区至少保留 320px」约束。 */
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 720;
/** 非法/越界存储值按 CSS 默认宽度渲染（返回 null = 不写内联样式）。 */
function loadSidebarWidth(): number | null {
	const raw = localStorage.getItem(WIDTH_KEY);
	const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return null;
	return Math.min(Math.max(parsed, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);
}
/** 拖拽时的实时钳制：上限不超过视口宽度减去聊天区最小保留宽度。 */
function clampSidebarWidth(width: number): number {
	return Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - 320)));
}
/** 分组排序偏好（Codex 式分组菜单）：置顶 manual=置顶顺序；最近 name=按名称。 */
/** 「最近」分组最多展示的会话数，避免长列表把项目挤出视口。 */
const RECENT_LIMIT = 30;
/** 项目行操作菜单的 id 前缀（openMenu 状态，按项目路径区分）。 */
const PROJECT_ROW_MENU_PREFIX = "project-row:";
/** 置顶栏项目行操作菜单的 id 前缀：与「项目」分组的行菜单互不干扰。 */
const PINNED_PROJECT_ROW_MENU_PREFIX = "pinned-project-row:";
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

/** 会话显示名：自定义名 > 首条用户消息 > id 前缀。无名分支会话追加「· 分支」便于区分
 * （fork 时已持久化「forkN · 来自「…」」名字的不重复加）。 */
function sessionTitle(row: SessionRow): string {
	const named = row.name?.trim();
	if (named) return named;
	const first = row.firstMessage?.trim();
	let base: string;
	if (first) {
		const flat = flatText(first);
		base = flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
	} else {
		base = row.id ? t("sidebar.sessionFallback", { id: row.id.slice(0, 8) }) : t("sidebar.sessionUnnamed");
	}
	return row.parentSessionPath ? `${base} · ${t("app.branchSuffix")}` : base;
}

function flatText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / n 天前 / MM-DD。 */
function relativeTime(iso: string): string {
	const time = new Date(iso).getTime();
	if (!time) return "";
	const diff = Date.now() - time;
	const minute = 60_000;
	const hour = 3_600_000;
	const day = 86_400_000;
	if (diff < minute) return t("sidebar.relativeNow");
	if (diff < hour) return t("sidebar.relativeMinutes", { n: Math.floor(diff / minute) });
	if (diff < day) return t("sidebar.relativeHours", { n: Math.floor(diff / hour) });
	if (diff < 2 * day) return t("sidebar.yesterday");
	if (diff < 7 * day) return t("sidebar.relativeDays", { n: Math.floor(diff / day) });
	return new Date(time).toLocaleDateString(getUiLanguage() === "en" ? "en-US" : "zh-CN", { month: "2-digit", day: "2-digit" });
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

function loadPinnedProjects(key: string = PINNED_PROJECTS_KEY): string[] {
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
					aria-label={t("sidebar.sectionToggleAria", { action: open ? t("common.collapse") : t("common.expand"), label })}
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
}): React.JSX.Element {
	const t = useT();
	const pt = useProjectSidebarText();
	const projectRevision = useProjectSidebarRevision();
	const projectPreferences = useMemo(() => getProjectSidebarPreferences(sessionScope), [sessionScope, projectRevision]);
	const researchText = getUiLanguage() === "en" ? { title: "Research chats", search: "Search research chats or projects", newChat: "New research chat", recent: "Recent research" } : { title: "研究会话", search: "搜索研究会话或项目", newChat: "新研究会话", recent: "最近研究" };
	const keys = sidebarStorageKeys(sessionScope);
	const [allSessions, setAllSessions] = useState<SessionRow[]>([]);
	const sessions = useMemo(() => allSessions.filter((row) => matchesSessionScope(row, sessionScope)), [allSessions, sessionScope]);
	const [showNewProject, setShowNewProject] = useState(false);
	const [editingProject, setEditingProject] = useState<string | null>(null);
	const [sectionDialog, setSectionDialog] = useState<{ id?: string; path?: string } | null>(null);
	const [sectionError, setSectionError] = useState("");
	const [projectNotice, setProjectNotice] = useState("");
	const [projectConfirm, setProjectConfirm] = useState<{ type: "archive" | "remove" | "section-remove"; path?: string; sectionId?: string } | null>(null);
	const [projectBusy, setProjectBusy] = useState(false);
	const projectBusyRef = useRef(false);
	// 桌面壳里可打开系统文件夹选择框（浏览器模式隐藏入口）
	const [pinned, setPinned] = useState<string[]>(() => loadPinned(keys.pinned));
	const [pinnedProjects, setPinnedProjects] = useState<string[]>(() => loadPinnedProjects(keys.pinnedProjects));
	const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(keys.collapsed));
	const [query, setQuery] = useState("");
	/** 当前展开的分组菜单（Codex 式 ⋯ 菜单）；值为菜单 id（含各项目行自己的菜单）。 */
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const projectMenuId = useId();
	const [projectPopup, setProjectPopup] = useState<{ key: string; kind: "project" | "projects" | "recent" | "section"; path?: string; sectionId?: string; anchor: HTMLButtonElement } | null>(null);
	const closeProjectPopup = useCallback((restoreFocus = true): void => {
		if (restoreFocus && projectPopup?.anchor.isConnected) projectPopup.anchor.focus({ preventScroll: true });
		setProjectPopup(null);
		setOpenMenu((current) => current === projectPopup?.key ? null : current);
	}, [projectPopup]);
	const sessionMenuId = useId();
	const [sessionMenu, setSessionMenu] = useState<{ key: string; row: SessionRow; anchor: HTMLButtonElement } | null>(null);
	const closeSessionMenu = useCallback((restoreFocus = true): void => {
		if (restoreFocus && sessionMenu?.anchor.isConnected) sessionMenu.anchor.focus({ preventScroll: true });
		setSessionMenu(null);
		setOpenMenu((current) => current === sessionMenu?.key ? null : current);
	}, [sessionMenu]);
	const [pinnedSort, setPinnedSort] = useState<PinnedSort>(() =>
		loadChoice(keys.pinnedSort, ["recent", "manual"] as const, "manual"),
	);
	const [recentSort, setRecentSort] = useState<ListSort>(() =>
		loadChoice(keys.recentSort, ["recent", "name", "oldest"] as const, "recent"),
	);
	/** 待确认删除的会话（非 null 时显示确认弹窗）。 */
	const [confirmDelete, setConfirmDelete] = useState<SessionRow | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState("");
	/** 到访过的项目（含没有会话的）：保证新建/切换项目后旧项目仍留在「项目」分组。 */
	const [knownProjects, setKnownProjects] = useState<string[]>(() => loadSidebarStrings(localStorage, keys.projects));
	/** 手动展开过会话列表的项目（normalized path）。null = 未交互，默认只展开当前项目。 */
	const [openProjects, setOpenProjects] = useState<Set<string> | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const asideRef = useRef<HTMLElement>(null);
	/** 右缘拖拽调宽：null = 未拖过，走 CSS 默认宽度。 */
	const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => loadSidebarWidth());
	const [resizing, setResizing] = useState(false);
	const activeDrag = useRef<(() => void) | undefined>(undefined);
	const resizeAria = getUiLanguage() === "en" ? "Drag to resize sidebar, double-click to reset" : "拖拽调整侧栏宽度，双击复位";
	const beginSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0 || !event.isPrimary) return;
		const aside = asideRef.current;
		if (!aside) return;
		const startWidth = aside.getBoundingClientRect().width;
		const startX = event.clientX;
		let latest = startWidth;
		event.preventDefault();
		setResizing(true);
		activeDrag.current = startPointerDrag(event.currentTarget, event.nativeEvent, {
			cursor: "col-resize",
			onMove: (moveEvent) => {
				latest = clampSidebarWidth(startWidth + (moveEvent.clientX - startX));
				setSidebarWidth(latest);
			},
			onFinish: (cancelled) => {
				activeDrag.current = undefined;
				setResizing(false);
				// 取消（失焦/pointercancel）时回到已保存宽度；正常结束才落盘。
				if (cancelled) { setSidebarWidth(loadSidebarWidth()); return; }
				localStorage.setItem(WIDTH_KEY, String(latest));
			},
		});
	}, []);
	useEffect(() => () => {
		activeDrag.current?.();
		activeDrag.current = undefined;
	}, []);
	const mounted = useRef(true);
	const refreshVersion = useRef(0);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; refreshVersion.current++; };
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
		if (projectPopup !== null && (openMenu !== projectPopup.key || !projectPopup.anchor.isConnected)) closeProjectPopup(false);
	}, [openMenu, projectPopup, closeProjectPopup, allSessions, projectRevision]);
	useEffect(() => {
		setProjectPopup(null);
		setOpenMenu((current) => current === "projects" || current === "recent" || current?.startsWith(PROJECT_ROW_MENU_PREFIX) || current?.startsWith(PINNED_PROJECT_ROW_MENU_PREFIX) || current?.startsWith("partition:") ? null : current);
	}, [minimized, activeId, activeProject, sessionScope, focus, allSessions, query, collapsed, openProjects, projectRevision, recentSort]);

	// A menu belongs to a specific rendered row, not every copy of that session.
	useEffect(() => {
		if (sessionMenu === null) return;
		if (openMenu !== sessionMenu.key || !sessionMenu.anchor.isConnected) closeSessionMenu(false);
	}, [openMenu, sessionMenu, closeSessionMenu, allSessions, query, collapsed, openProjects, pinned]);
	useEffect(() => {
		setSessionMenu(null);
		setOpenMenu((current) => current?.startsWith(SESSION_ROW_MENU_PREFIX) ? null : current);
	}, [minimized, activeId, activeProject, sessionScope, focus, allSessions, query, collapsed, openProjects]);

	// 当前项目变化时登记进项目列表：新建项目、切项目、恢复历史会话都会走到这里。
	// 不登记的话，没有会话的项目会在切走后从「项目」分组消失。
	useEffect(() => {
		if (!activeProject) return;
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
			initializeReadMarkers(sessionScope, rows.filter((row) => matchesSessionScope(row, sessionScope)));
			if (sessionScope === "research") {
				setPinned(loadPinned(keys.pinned));
				setPinnedProjects(loadPinnedProjects(keys.pinnedProjects));
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
	// （归档记录由桥端 archive.json 管理，不在这里清理。）
	useEffect(() => {
		if (allSessions.length === 0) return;
		const alive = new Set(allSessions.map((row) => row.id).filter(Boolean));
		const valid = pinned.filter((id) => alive.has(id));
		if (valid.length !== pinned.length) {
			setPinned(valid);
			localStorage.setItem(keys.pinned, JSON.stringify(valid));
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

	/**
	 * 展开/收起某个项目的会话列表。scope 区分「项目」/「置顶」两组行，展开状态互不联动；
	 * 首次交互前（openProjects 为 null）默认只展开「项目」分组里的当前项目。
	 */
	const toggleProjectGroup = (path: string, scope: "project" | "pinned"): void => {
		const key = `${scope}:${normPath(path)}`;
		setOpenProjects((current) => {
			const expandedNow =
				(current?.has(key) ?? false) || (current === null && scope === "project" && samePath(path, activeProject));
			const next = new Set(current ?? []);
			if (expandedNow) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	/** 项目会话列表是否展开（openProjects 为 null 视作「项目」分组里仅当前项目展开）。 */
	const projectGroupOpen = (path: string, scope: "project" | "pinned"): boolean => {
		if (openProjects === null) return scope === "project" && samePath(path, activeProject);
		return openProjects.has(`${scope}:${normPath(path)}`);
	};

	const isOpen = (id: string): boolean => query.trim() !== "" || !collapsed.has(id);

	// rail 回到聊天视图：把会话列表滚回顶部。
	useEffect(() => {
		if (focus === "chat" || focus === "research") scrollRef.current?.scrollTo({ top: 0 });
	}, [focus]);

	// 活动会话变化（点行、分支跳转、快捷键循环）：把当前行滚进可视区，长列表里也能
	// 一眼看到跳到了哪条。行不在 DOM（所在分组折叠/被过滤）时静默跳过。
	useEffect(() => {
		if (!activeId || minimized) return;
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

	/** 项目置顶/取消置顶：按置顶先后排序（与置顶会话的手动排序同习惯）。 */
	const toggleProjectPin = (path: string): void => {
		setPinnedProjects((current) => {
			const next = current.some((p) => samePath(p, path))
				? current.filter((p) => !samePath(p, path))
				: [...current, path];
			localStorage.setItem(keys.pinnedProjects, JSON.stringify(next));
			return next;
		});
	};

	const isProjectPinned = (path: string): boolean => pinnedProjects.some((p) => samePath(p, path));

	/** 归档会话：成功后从侧栏移除，恢复和删除由设置页统一管理。 */
	const archiveSession = async (row: SessionRow): Promise<void> => {
		const id = row.id;
		if (!id) return;
		try {
			const response = await client.request({
				type: "session.archive",
				sessionId: id,
			});
			if (!response.ok) return;
			void refresh();
		} catch {
			// 桥未连接等瞬时失败：列表不动，用户重试即可
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

	// 会话行：标题/项目名匹配搜索词。列表本身已按 modified 降序。
	const sessionMatches = (row: SessionRow): boolean =>
		!search || sessionTitle(row).toLowerCase().includes(search) || (row.cwd ?? "").toLowerCase().includes(search) || (row.cwd ? projectLabel(row.cwd).toLowerCase().includes(search) : false);

	const byLatest = (a: SessionRow, b: SessionRow): number => (sessionTime(a) < sessionTime(b) ? 1 : -1);

	const pinnedSessions = useMemo(() => {
		const rows = sessions.filter((row) => row.id !== undefined && pinned.includes(row.id) && !isArchivedRow(row));
		if (pinnedSort === "manual") {
			// 手动排序 = 置顶操作发生的先后顺序（pinned 数组序）
			return rows.sort((a, b) => pinned.indexOf(a.id as string) - pinned.indexOf(b.id as string));
		}
		return rows.sort(byLatest);
	}, [sessions, pinned, pinnedSort]); // eslint-disable-line react-hooks/exhaustive-deps

	// 项目列表 = 当前项目 ∪ 有会话的项目 ∪ 到访过的项目，按路径去重。
	// 排序：按最近会话活动时间降序（无会话的按名称垫底）；切项目不改变顺序，
	// 避免点击的项目跳到列表顶部。
	const projectPaths = useMemo(() => {
		const map = new Map<string, { path: string; latest: string }>();
		const track = (path: string | undefined, time?: string): void => {
			if (!path) return;
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
	}, [sessions, activeProject, knownProjects, projectRevision]);

	// 搜索时项目行按名称/路径/自身会话过滤，避免搜会话时冒出一堆不相干项目。
	const projectMatchesSearch = (path: string): boolean =>
		!search ||
		projectLabel(path).toLowerCase().includes(search) ||
		path.toLowerCase().includes(search) ||
		sessions.some((row) => samePath(row.cwd, path) && !isArchivedRow(row) && sessionMatches(row));

	const visibleProjects = useMemo(
		() => projectPaths.filter((path) => !projectPreferences.hidden.includes(normPath(path)) && projectMatchesSearch(path)),
		[projectPaths, sessions, search, projectPreferences], // eslint-disable-line react-hooks/exhaustive-deps
	);

	// 置顶项目行（按置顶先后），搜索时同样按项目过滤。
	const pinnedProjectRows = useMemo(
		() => pinnedProjects.filter((path) => !projectPreferences.hidden.includes(normPath(path)) && projectMatchesSearch(path)),
		[pinnedProjects, search, sessions, projectPreferences], // eslint-disable-line react-hooks/exhaustive-deps
	);

	const recentSessions = useMemo(() => {
		const rows = sessions.filter((row) => !isArchivedRow(row) && sessionMatches(row));
		if (recentSort === "name") {
			rows.sort((a, b) => sessionTitle(a).localeCompare(sessionTitle(b), "zh-CN"));
		} else if (recentSort === "oldest") rows.sort((a, b) => String(a.created ?? sessionTime(a)).localeCompare(String(b.created ?? sessionTime(b))));
		else rows.sort(byLatest);
		return rows.slice(0, RECENT_LIMIT);
	}, [sessions, search, recentSort, projectRevision]); // eslint-disable-line react-hooks/exhaustive-deps

	/** 行内操作保留键盘入口，样式统一在侧边栏内控制。 */
	const rowBtn = "owl-sidebar-action";

	/** 会话行悬停 tooltip：标题 + 时间 · 项目（单行化后元信息收进这里）。 */
	const sessionRowTip = (row: SessionRow): string => {
		const time = relativeTime(sessionTime(row));
		return `${sessionTitle(row)}\n${time}${row.cwd ? ` · ${row.cwd}` : ""}`;
	};

	/**
	 * 会话行（单行紧凑式）：空心圆 + 标题。没在跑是浅灰，运行中变绿。
	 * 悬停露出会话操作菜单，避免多个操作图标挤占标题空间。
	 */
	const sessionRow = (row: SessionRow, index: number, pinnedRow: boolean, location: string): React.JSX.Element => {
		const id = row.id;
		const isRunning = id !== undefined && runningSessions.has(id);
		const menuKey = `${SESSION_ROW_MENU_PREFIX}${location}:${id ?? index}`;
		const menuOpen = openMenu === menuKey && sessionMenu?.key === menuKey;
		return (
			<div
				key={id ?? index}
				className={`owl-sidebar-row owl-sidebar-session-row ${id === activeId ? "is-active" : ""} ${
					id ? "owl-sidebar-row--has-marker" : ""
				} ${menuOpen ? "is-open" : ""}`}
			>
				<button
					type="button"
					className="owl-sidebar-row-main"
					title={sessionRowTip(row)}
					aria-current={id === activeId ? "page" : undefined}
					onClick={() => { if (id) { markSessionsRead(sessionScope, [row]); onOpenSession(id); } }}
				>
					<span
						className={`owl-sidebar-session-icon${isRunning ? " is-running" : ""}`}
						title={isRunning ? t("sidebar.runningTip") : undefined}
					>
						<IconSessionMark className="h-3 w-3" />
					</span>
					<span className="owl-sidebar-row-label">{sessionTitle(row)}</span>
					{isSessionUnread(projectPreferences, row) && <span className="owl-sidebar-unread-dot" title={getUiLanguage() === "en" ? "Unread" : "未读"} aria-label={getUiLanguage() === "en" ? "Unread" : "未读"} />}
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

	/** 项目下的未归档会话（按最近活动排序，搜索时同步过滤）。「项目」/「置顶」两组行共用。 */
	const projectSessionRows = (path: string): SessionRow[] =>
		sessions.filter((row) => !isArchivedRow(row) && samePath(row.cwd, path) && sessionMatches(row)).sort((a, b) => recentSort === "name" ? sessionTitle(a).localeCompare(sessionTitle(b), getUiLanguage()) : recentSort === "oldest" ? String(a.created ?? sessionTime(a)).localeCompare(String(b.created ?? sessionTime(b))) : byLatest(a, b));

	/** A single project row implementation serves pinned and partitioned projects. */
	const renderProjectRow = (path: string, pinnedLocation: boolean): React.JSX.Element => {
		const isCurrent = samePath(path, activeProject);
		const projectPinned = isProjectPinned(path);
		const menuId = `${pinnedLocation ? PINNED_PROJECT_ROW_MENU_PREFIX : PROJECT_ROW_MENU_PREFIX}${normPath(path)}`;
		const location = pinnedLocation ? "pinned" : "project";
		const expanded = search !== "" || projectGroupOpen(path, location);
		const rows = projectSessionRows(path);
		const name = projectLabel(path);
		return <div key={menuId} className="owl-sidebar-project-group" data-project-path={normPath(path)}>
			<div className={`owl-sidebar-row owl-sidebar-project-row owl-sidebar-row--has-marker ${isCurrent ? "is-current" : ""} ${openMenu === menuId ? "is-open" : ""}`}>
				<button type="button" className="owl-sidebar-project-toggle" aria-expanded={expanded} aria-label={t("sidebar.projectToggleAria", { project: name })} title={expanded ? t("sidebar.collapseList") : t("sidebar.expandList")} onClick={() => toggleProjectGroup(path, location)}><IconChevron className={`h-3 w-3 shrink-0 text-owl-sidebar-faint transition-transform ${expanded ? "rotate-90" : ""}`} /></button>
				<button type="button" className="owl-sidebar-row-main" title={path} aria-label={isCurrent ? t("sidebar.currentProjectAria", { project: name }) : t("sidebar.switchToProjectAria", { project: name })} onClick={() => isCurrent ? toggleProjectGroup(path, location) : onSelectProject(path)}><IconFolder className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" /><span className="owl-sidebar-row-label">{name}</span></button>
				<div data-menu-root className="owl-sidebar-row-actions">
					<button type="button" className={`owl-sidebar-action ${pinnedLocation ? "owl-sidebar-action--persistent" : ""}`} title={t("sidebar.projectActions")} aria-label={t("sidebar.projectActionsAria", { project: name })} aria-haspopup="menu" aria-expanded={openMenu === menuId} aria-controls={openMenu === menuId ? projectMenuId : undefined} onClick={(event) => {
						if (openMenu === menuId) closeProjectPopup();
						else { setProjectPopup({ key: menuId, kind: "project", path, anchor: event.currentTarget }); setOpenMenu(menuId); }
					}}><IconMore className="h-3.5 w-3.5" /></button>
					<button type="button" className="owl-sidebar-action" title={t("sidebar.newChatInProject")} aria-label={t("sidebar.newChatInProjectAria", { project: name })} onClick={() => { setOpenMenu(null); onNewChatInProject(path); }}><IconCompose className="h-3.5 w-3.5" /></button>
				</div>
			</div>
			{expanded && <div className="owl-sidebar-project-sessions">{rows.map((row, index) => sessionRow(row, index, false, menuId))}{rows.length === 0 && <p className="owl-sidebar-empty">{search ? t("sidebar.noMatch") : t("sidebar.none")}</p>}</div>}
		</div>;
	};
	const pinnedProjectRow = (path: string): React.JSX.Element => renderProjectRow(path, true);
	const projectRow = (path: string): React.JSX.Element => renderProjectRow(path, false);
	const renderProjectContents = (paths: string[], location: string): React.ReactNode => {
		if (projectPreferences.view === "projects") return paths.map(projectRow);
		const pathsSet = new Set(paths.map(normPath));
		const rows = sessions.filter((row) => !isArchivedRow(row) && pathsSet.has(normPath(row.cwd)) && sessionMatches(row)).sort((a, b) => recentSort === "name" ? sessionTitle(a).localeCompare(sessionTitle(b), getUiLanguage()) : recentSort === "oldest" ? String(a.created ?? sessionTime(a)).localeCompare(String(b.created ?? sessionTime(b))) : byLatest(a, b));
		return rows.length ? rows.map((row, index) => sessionRow(row, index, false, location)) : <p className="owl-sidebar-empty">{t("sidebar.none")}</p>;
	};
	const defaultProjects = visibleProjects.filter((path) => projectPreferences.assignments[normPath(path)] === undefined);
	const renderRecentContents = (): React.ReactNode => {
		if (projectPreferences.recentView === "merged") return recentSessions.map((row, index) => sessionRow(row, index, false, "recent"));
		const groups = new Map<string, { path?: string; rows: SessionRow[] }>();
		for (const row of recentSessions) {
			const key = normPath(row.cwd);
			const group = groups.get(key);
			if (group) group.rows.push(row); else groups.set(key, { path: row.cwd, rows: [row] });
		}
		return [...groups].map(([pathKey, group]) => {
			const key = `recent-project:${pathKey || "standalone"}`;
			const expanded = isOpen(key);
			const name = group.path ? projectLabel(group.path) : pt("standalone");
			return <div key={key} className="owl-sidebar-project-group" data-recent-project={pathKey || "standalone"}>
				<div className="owl-sidebar-row"><button type="button" className="owl-sidebar-row-main" title={group.path ?? name} aria-expanded={expanded} aria-label={t("sidebar.projectToggleAria", { project: name })} onClick={() => toggleSection(key)}>
					<IconChevron className={`h-3 w-3 shrink-0 text-owl-sidebar-faint transition-transform ${expanded ? "rotate-90" : ""}`} />
					{group.path ? <IconFolder className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" /> : <IconChat className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" />}
					<span className="owl-sidebar-row-label">{name}</span>
				</button></div>
				{expanded && <div className="owl-sidebar-project-sessions">{group.rows.map((row, index) => sessionRow(row, index, false, key))}</div>}
			</div>;
		});
	};
	const savePreferences = (next: ProjectSidebarPreferences): void => saveProjectSidebarPreferences(sessionScope, next);
	const confirmProjectAction = async (): Promise<void> => {
		if (!projectConfirm || projectBusyRef.current) return;
		if (projectConfirm.type === "section-remove") {
			if (projectConfirm.sectionId) savePreferences(removeProjectSection(projectPreferences, projectConfirm.sectionId));
			setProjectConfirm(null); return;
		}
		const path = projectConfirm.path;
		if (!path) return;
		if (projectConfirm.type === "remove") {
			savePreferences(hideProject(projectPreferences, path));
			const nextKnown = knownProjects.filter((entry) => !samePath(entry, path));
			const nextPinned = pinnedProjects.filter((entry) => !samePath(entry, path));
			setKnownProjects(nextKnown); setPinnedProjects(nextPinned);
			localStorage.setItem(keys.projects, JSON.stringify(nextKnown)); localStorage.setItem(keys.pinnedProjects, JSON.stringify(nextPinned));
			setProjectConfirm(null); return;
		}
		const targets = sessions.filter((row) => row.id && !isArchivedRow(row) && samePath(row.cwd, path));
		let done = 0; let failed = 0; let running = 0;
		projectBusyRef.current = true; setProjectBusy(true);
		try {
			for (const row of targets) {
				if (row.id && runningSessions.has(row.id)) { running++; continue; }
				try { const result = await client.request({ type: "session.archive", sessionId: row.id! }); if (result.ok) done++; else failed++; } catch { failed++; }
			}
			await refresh();
			setProjectNotice(pt("archiveResult").replace("{done}", String(done)).replace("{failed}", String(failed)).replace("{running}", String(running)));
			setProjectConfirm(null);
		} finally { projectBusyRef.current = false; setProjectBusy(false); }
	};

	const noMatch =
		search !== "" &&
		visibleProjects.length === 0 &&
		pinnedProjectRows.length === 0 &&
		recentSessions.length === 0 &&
		pinnedSessions.filter(sessionMatches).length === 0;

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
		<aside
			ref={asideRef}
			id="owl-session-sidebar"
			className="owl-sidebar"
			aria-label={t("sidebar.aria")}
			hidden={minimized}
			style={sidebarWidth === null ? undefined : { width: sidebarWidth, flexBasis: sidebarWidth, maxWidth: "calc(100vw - 320px)" }}
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
					<span>{sessionScope === "research" ? researchText.title : "owl"}</span>
				</button>
				<div className="flex-1" data-tauri-drag-region="deep" />
				<span className="owl-sidebar-local-badge" title={t("sidebar.localBadgeTitle")}>LOCAL</span>
			</div>

			<div className="owl-sidebar-search">
				<IconSearch className="h-3.5 w-3.5 shrink-0" />
				<input
					type="text"
					className="owl-sidebar-search-input"
					placeholder={sessionScope === "research" ? researchText.search : t("sidebar.searchPlaceholder")}
					aria-label={sessionScope === "research" ? researchText.search : t("sidebar.searchPlaceholder")}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") setQuery("");
					}}
				/>
				{query && (
					<button type="button" className="owl-sidebar-search-clear" aria-label={t("sidebar.clearSearch")} onClick={() => setQuery("")}>
						<span aria-hidden="true">×</span>
					</button>
				)}
			</div>

			<div className="owl-sidebar-shortcuts">
				<button type="button" className="owl-sidebar-new-chat" aria-label={sessionScope === "research" ? researchText.newChat : t("sidebar.newChat")} onClick={onNewChat}>
					<IconPlus className="h-4 w-4 shrink-0" />
					<span>{sessionScope === "research" ? researchText.newChat : t("sidebar.newChat")}</span>
				</button>
			</div>

			<div ref={scrollRef} className="owl-sidebar-list">
				{(pinnedProjectRows.length > 0 || pinnedSessions.length > 0) && (
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
						{pinnedProjectRows.map((path) => pinnedProjectRow(path))}
						{pinnedSessions.filter(sessionMatches).map((row, index) => sessionRow(row, index, true, "pinned"))}
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
							onClick={(event) => { if (openMenu === "projects") closeProjectPopup(); else { setProjectPopup({ key: "projects", kind: "projects", anchor: event.currentTarget }); setOpenMenu("projects"); } }}
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
				{projectPreferences.sections.map((section) => <Section key={section.id} id={`partition-${section.id}`} label={section.name} open={isOpen(`partition-${section.id}`)} onToggle={() => toggleSection(`partition-${section.id}`)} showMenu={openMenu === `partition:${section.id}`} actions={<button type="button" className={actionBtn} aria-label={`${pt("section")}：${section.name}`} aria-haspopup="menu" aria-expanded={openMenu === `partition:${section.id}`} onClick={(event) => { const key = `partition:${section.id}`; if (openMenu === key) closeProjectPopup(); else { setProjectPopup({ key, kind: "section", sectionId: section.id, anchor: event.currentTarget }); setOpenMenu(key); } }}><IconMore className="h-3.5 w-3.5" /></button>}>
					{renderProjectContents(visibleProjects.filter((path) => projectPreferences.assignments[normPath(path)] === section.id), `merged-${section.id}`)}
				</Section>)}

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
								onClick={(event) => { if (openMenu === "recent") closeProjectPopup(); else { setProjectPopup({ key: "recent", kind: "recent", anchor: event.currentTarget }); setOpenMenu("recent"); } }}
							>
								<IconMore className="h-3.5 w-3.5" />
							</button>
							<button type="button" className={actionBtn} title={t("sidebar.newChatBtn")} aria-label={t("sidebar.newChatBtn")} onClick={onNewChat}>
								<IconCompose className="h-3.5 w-3.5" />
							</button>
						</>
					}
				>
					{renderRecentContents()}
					{recentSessions.length === 0 && <p className="owl-sidebar-empty">{search ? t("sidebar.noMatch") : t("sidebar.none")}</p>}
				</Section>

				{noMatch && <p className="owl-sidebar-empty">{t("sidebar.emptyResults")}</p>}
				{projectNotice && <p className="owl-sidebar-notice" role="status">{projectNotice}</p>}
			</div>
			{!minimized && projectPopup !== null && openMenu === projectPopup.key && (projectPopup.kind === "project" && projectPopup.path ? <ProjectActionsMenu
				anchor={projectPopup.anchor} menuId={projectMenuId} label={t("sidebar.projectActionsAria", { project: projectLabel(projectPopup.path) })} pinned={isProjectPinned(projectPopup.path)} sections={projectPreferences.sections} sectionId={projectPreferences.assignments[normPath(projectPopup.path)] ?? null} onClose={closeProjectPopup}
				onPin={() => { if (projectPopup.path) toggleProjectPin(projectPopup.path); }}
				onEdit={() => setEditingProject(projectPopup.path ?? null)}
				onSection={(id) => { if (projectPopup.path) savePreferences(moveProjectToSection(projectPreferences, projectPopup.path, id)); }}
				onNewSection={() => { setSectionError(""); setSectionDialog({ path: projectPopup.path }); }}
				onReveal={() => { if (projectPopup.path) void revealProject(projectPopup.path); }}
				onMarkRead={() => { markSessionsRead(sessionScope, sessions.filter((row) => samePath(row.cwd, projectPopup.path))); setProjectNotice(pt("allRead")); }}
				onArchive={() => setProjectConfirm({ type: "archive", path: projectPopup.path })}
				onRemove={() => setProjectConfirm({ type: "remove", path: projectPopup.path })}
			/> : projectPopup.kind === "projects" || projectPopup.kind === "recent" ? <ProjectsSectionMenu anchor={projectPopup.anchor} menuId={projectMenuId} label={t(projectPopup.kind === "recent" ? "sidebar.recentOptions" : "sidebar.projectOptions")} organize={projectPopup.kind === "recent" ? projectPreferences.recentView : projectPreferences.view} sort={recentSort} onClose={closeProjectPopup} onOrganize={(view) => savePreferences(projectPopup.kind === "recent" ? { ...projectPreferences, recentView: view } : { ...projectPreferences, view })} onSort={switchRecentSort} /> : <SectionActionsMenu anchor={projectPopup.anchor} menuId={projectMenuId} label={pt("section")} onClose={closeProjectPopup} onEdit={() => { setSectionError(""); setSectionDialog({ id: projectPopup.sectionId }); }} onRemove={() => setProjectConfirm({ type: "section-remove", sectionId: projectPopup.sectionId })} />)}
			{!minimized && sessionMenu !== null && openMenu === sessionMenu.key && (
				<SessionActionsMenu
					key={sessionMenu.key}
					anchor={sessionMenu.anchor}
					menuId={sessionMenuId}
					label={t("sidebar.sessionActionsAria", { name: sessionTitle(sessionMenu.row) })}
					pinned={sessionMenu.row.id !== undefined && pinned.includes(sessionMenu.row.id)}
					onClose={closeSessionMenu}
					onPin={() => { if (sessionMenu.row.id) togglePin(sessionMenu.row.id); }}
					onArchive={() => void archiveSession(sessionMenu.row)}
					onDelete={() => { setConfirmDelete(sessionMenu.row); setDeleteError(""); }}
				/>
			)}

			{showNewProject && (
				<NewProjectDialog
					client={client}
					onClose={() => setShowNewProject(false)}
					onCreated={(path) => {
						setShowNewProject(false);
						restoreProject(path, sessionScope);
						setKnownProjects((current) => { const next = current.some((entry) => samePath(entry, path)) ? current : [...current, path]; localStorage.setItem(keys.projects, JSON.stringify(next)); return next; });
						onSelectProject(path);
					}}
				/>
			)}
			{editingProject !== null && <NewProjectDialog client={client} initialProject={{ path: editingProject, name: projectLabel(editingProject) }} onClose={() => setEditingProject(null)} onCreated={() => setEditingProject(null)} />}
			{sectionDialog !== null && <ProjectSidebarDialog key={sectionDialog.id ?? `new:${sectionDialog.path}`} title={pt(sectionDialog.id ? "renameSection" : "createSection")} fieldLabel={pt("sectionName")} initialValue={projectPreferences.sections.find((section) => section.id === sectionDialog.id)?.name ?? ""} error={sectionError} confirmLabel={pt("save")} onClose={() => setSectionDialog(null)} onSubmit={(name) => {
				if (projectPreferences.sections.some((section) => section.id !== sectionDialog.id && section.name.toLowerCase() === name.toLowerCase())) { setSectionError(pt("sectionDuplicate")); return; }
				const id = sectionDialog.id ?? crypto.randomUUID();
				let next = { ...projectPreferences, sections: sectionDialog.id ? projectPreferences.sections.map((section) => section.id === id ? { ...section, name } : section) : [...projectPreferences.sections, { id, name }] };
				if (sectionDialog.path) next = moveProjectToSection(next, sectionDialog.path, id);
				savePreferences(next); setSectionDialog(null);
			}} />}
			{projectConfirm !== null && <ProjectSidebarDialog title={pt(projectConfirm.type === "archive" ? "archiveTitle" : projectConfirm.type === "remove" ? "removeTitle" : "removeSection")} description={(projectConfirm.path ? `${projectLabel(projectConfirm.path)}\n` : "") + pt(projectConfirm.type === "archive" ? "archiveHint" : projectConfirm.type === "remove" ? "removeHint" : "removeSectionHint")} busy={projectBusy} confirmLabel={pt("confirm")} onClose={() => { if (!projectBusyRef.current) setProjectConfirm(null); }} onSubmit={() => void confirmProjectAction()} />}

			{confirmDelete && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog">
					<div className="w-80 rounded-xl border border-owl-border bg-owl-panel p-4 shadow-2xl shadow-black/40">
						<h2 className="mb-1 text-sm font-semibold text-owl-text">{t("sidebar.deleteSessionTitle")}</h2>
						<p className="mb-3 break-all text-xs text-owl-muted">
							{t("sidebar.deleteDialogBody", { name: sessionTitle(confirmDelete) })}
						</p>
						{deleteError && <p className="mt-2 text-xs text-red-400">{deleteError}</p>}
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
				data-tauri-drag-region="false"
				role="separator"
				aria-orientation="vertical"
				aria-label={resizeAria}
				title={resizeAria}
				onPointerDown={beginSidebarResize}
				onDoubleClick={() => { localStorage.removeItem(WIDTH_KEY); setSidebarWidth(null); }}
			/>
		</aside>
	);
}
