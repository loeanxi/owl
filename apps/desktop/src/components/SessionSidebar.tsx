import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import { KNOWN_PROJECTS_KEY, loadKnownProjects, normPath, projectLabel, samePath } from "../utils/paths.ts";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import {
	IconArchive,
	IconChat,
	IconCheck,
	IconChevron,
	IconCompose,
	IconFolder,
	IconMore,
	IconPanelLeft,
	IconPin,
	IconPlus,
	IconSearch,
	IconTrash,
	IconUnarchive,
} from "./icons.tsx";
import type { RailView } from "./ActivityRail.tsx";

type SessionRow = {
	id?: string;
	name?: string;
	cwd?: string;
	/** 最近活动时间（ISO）。旧代码误读 timestamp（wire 上不存在），一直是空串。 */
	modified?: string;
	timestamp?: string;
	created?: string;
	firstMessage?: string;
	/** 归档时间（ISO）。存在 = 已归档；由桥端 archive.json 下发。 */
	archivedAt?: string;
	[key: string]: unknown;
};

const PINNED_KEY = "owl.pinnedSessions";
/** 置顶项目（localStorage）：置顶栏里的项目快捷入口，项目本身仍留在「项目」分组。 */
const PINNED_PROJECTS_KEY = "owl.pinnedProjects";
const COLLAPSED_KEY = "owl.sidebar.collapsed";
/** 整条侧边栏收起（localStorage）：收起后原位只留 owl 图标窄条，点击图标展开。 */
const MINIMIZED_KEY = "owl.sidebar.minimized";
/** 分组排序偏好（Codex 式分组菜单）：置顶 manual=置顶顺序；最近 name=按名称。 */
const PINNED_SORT_KEY = "owl.sidebar.pinnedSort";
const RECENT_SORT_KEY = "owl.sidebar.recentSort";
/** 「最近」分组最多展示的会话数，避免长列表把项目挤出视口。 */
const RECENT_LIMIT = 30;
/** 项目行操作菜单的 id 前缀（openMenu 状态，按项目路径区分）。 */
const PROJECT_ROW_MENU_PREFIX = "project-row:";
/** 置顶栏项目行操作菜单的 id 前缀：与「项目」分组的行菜单互不干扰。 */
const PINNED_PROJECT_ROW_MENU_PREFIX = "pinned-project-row:";

type PinnedSort = "recent" | "manual";
type ListSort = "recent" | "name";

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

/** 会话显示名：自定义名 > 首条用户消息 > id 前缀。 */
function sessionTitle(row: SessionRow): string {
	const named = row.name?.trim();
	if (named) return named;
	const first = row.firstMessage?.trim();
	if (first) {
		const flat = flatText(first);
		return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
	}
	return row.id ? `会话 ${row.id.slice(0, 8)}` : "未命名会话";
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
	if (diff < minute) return "刚刚";
	if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
	if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
	if (diff < 2 * day) return "昨天";
	if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
	return new Date(time).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function loadPinned(): string[] {
	try {
		const raw = localStorage.getItem(PINNED_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function loadPinnedProjects(): string[] {
	try {
		const raw = localStorage.getItem(PINNED_PROJECTS_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function loadCollapsed(): Set<string> {
	try {
		const raw = localStorage.getItem(COLLAPSED_KEY);
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
					aria-label={`${open ? "收起" : "展开"}${label}`}
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
						className="absolute right-2 top-full z-30 mt-1 w-56 rounded-xl border border-owl-sidebar-border bg-owl-sidebar-surface py-1 shadow-xl shadow-black/30"
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
			title={disabled ? "该功能开发中" : undefined}
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

/** 分组菜单里的小节标题（如「排序方式」）。 */
function MenuLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
	return <p className="px-3 pb-1 pt-2 text-[10px] text-owl-sidebar-faint/80">{children}</p>;
}

/** 分组菜单分隔线。 */
function MenuDivider(): React.JSX.Element {
	return <div className="my-1 border-t border-owl-sidebar-border/70" />;
}

export function SessionSidebar({
	client,
	connected,
	activeId,
	activeProject,
	runningSessions,
	refreshKey,
	revision,
	focus,
	onNewChat,
	onSelectProject,
	onOpenSession,
}: {
	client: BridgeClient;
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
	onNewChat: () => void;
	onSelectProject: (path: string) => void;
	/** 点击历史会话：恢复回放并续聊。 */
	onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	const [showNewProject, setShowNewProject] = useState(false);
	// 桌面壳里可打开系统文件夹选择框（浏览器模式隐藏入口）
	const [pinned, setPinned] = useState<string[]>(loadPinned);
	const [pinnedProjects, setPinnedProjects] = useState<string[]>(loadPinnedProjects);
	const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
	/** 整条侧边栏收起：owl 图标点击触发，收起后只剩窄条。 */
	const [minimized, setMinimized] = useState(() => localStorage.getItem(MINIMIZED_KEY) === "1");
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	/** 当前展开的分组菜单（Codex 式 ⋯ 菜单）；值为菜单 id（含各项目行自己的菜单）。 */
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const [pinnedSort, setPinnedSort] = useState<PinnedSort>(() =>
		loadChoice(PINNED_SORT_KEY, ["recent", "manual"] as const, "manual"),
	);
	const [recentSort, setRecentSort] = useState<ListSort>(() =>
		loadChoice(RECENT_SORT_KEY, ["recent", "name"] as const, "recent"),
	);
	/** 待确认删除的会话（非 null 时显示确认弹窗）。 */
	const [confirmDelete, setConfirmDelete] = useState<SessionRow | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState("");
	/** 到访过的项目（含没有会话的）：保证新建/切换项目后旧项目仍留在「项目」分组。 */
	const [knownProjects, setKnownProjects] = useState<string[]>(loadKnownProjects);
	/** 手动展开过会话列表的项目（normalized path）。null = 未交互，默认只展开当前项目。 */
	const [openProjects, setOpenProjects] = useState<Set<string> | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	// 菜单打开时：点击菜单外或按 Esc 关闭
	useEffect(() => {
		if (!openMenu) return;
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
	}, [openMenu]);

	// 当前项目变化时登记进项目列表：新建项目、切项目、恢复历史会话都会走到这里。
	// 不登记的话，没有会话的项目会在切走后从「项目」分组消失。
	useEffect(() => {
		if (!activeProject) return;
		setKnownProjects((current) => {
			if (current.some((p) => samePath(p, activeProject))) return current;
			const next = [...current, activeProject];
			try {
				localStorage.setItem(KNOWN_PROJECTS_KEY, JSON.stringify(next));
			} catch {
				// localStorage 不可用时项目列表退化为「有会话的项目 + 当前项目」
			}
			return next;
		});
	}, [activeProject]);

	const refresh = async (): Promise<void> => {
		try {
			const response = await client.request<SessionRow[]>({ type: "session.list" });
			if (response.ok) setSessions(response.result ?? []);
		} catch {
			// 桥断开/重连瞬间的失败静默跳过：connected 或 refreshKey 变化会重试
		}
	};
	useEffect(() => {
		if (client && connected) void refresh();
	}, [client, connected, refreshKey, revision]); // eslint-disable-line react-hooks/exhaustive-deps

	// 置顶的会话文件可能已被删除：列表里不存在的 id 顺手清掉。
	// 列表为空 = 尚未加载完成（初始 []），此时清理会把全部置顶误判为已删除、清空存储；
	// 必须等 session.list 真正返回过至少一条（或确认没有任何会话）后才允许清理。
	// （归档记录由桥端 archive.json 管理，不在这里清理。）
	useEffect(() => {
		if (sessions.length === 0) return;
		const alive = new Set(sessions.map((row) => row.id).filter(Boolean));
		const valid = pinned.filter((id) => alive.has(id));
		if (valid.length !== pinned.length) {
			setPinned(valid);
			localStorage.setItem(PINNED_KEY, JSON.stringify(valid));
		}
	}, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

	const toggleSection = (id: string): void => {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
			return next;
		});
	};

	/** 收起/展开整条侧边栏（头部 owl 图标触发），状态持久化到 localStorage。 */
	const toggleMinimized = (): void => {
		setMinimized((current) => {
			const next = !current;
			localStorage.setItem(MINIMIZED_KEY, next ? "1" : "0");
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
		if (focus === "chat") scrollRef.current?.scrollTo({ top: 0 });
	}, [focus]);

	const togglePin = (id: string): void => {
		setPinned((current) => {
			const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
			localStorage.setItem(PINNED_KEY, JSON.stringify(next));
			return next;
		});
	};

	/** 项目置顶/取消置顶：按置顶先后排序（与置顶会话的手动排序同习惯）。 */
	const toggleProjectPin = (path: string): void => {
		setPinnedProjects((current) => {
			const next = current.some((p) => samePath(p, path))
				? current.filter((p) => !samePath(p, path))
				: [...current, path];
			localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(next));
			return next;
		});
	};

	const isProjectPinned = (path: string): boolean => pinnedProjects.some((p) => samePath(p, path));

	/** 归档/取消归档：写服务端 archive.json，成功后重拉列表（archivedAt 随 session.list 下发）。 */
	const toggleArchive = async (row: SessionRow): Promise<void> => {
		const id = row.id;
		if (!id) return;
		try {
			const unarchiving = Boolean(row.archivedAt);
			const response = await client.request({
				type: unarchiving ? "session.unarchive" : "session.archive",
				sessionId: id,
			});
			if (!response.ok) return;
			if (unarchiving) {
				// 恢复后行会回到原位置（置顶/项目分组/最近）：
				// 把可能的落点分组顺手展开，避免会话“回去了”却被折叠藏住、看起来像消失。
				if (row.cwd) {
					setOpenProjects((current) => new Set(current ?? []).add(`project:${normPath(row.cwd as string)}`));
				}
				setCollapsed((current) => {
					const next = new Set(current);
					next.delete("recent");
					localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
					return next;
				});
			}
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
				setDeleteError(response.error ?? "删除失败");
				return;
			}
			setPinned((current) => {
				const next = current.filter((v) => v !== id);
				localStorage.setItem(PINNED_KEY, JSON.stringify(next));
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

	/** 已归档的会话只出现在「归档」分组，其余分组一律隐藏。 */
	const isArchivedRow = (row: SessionRow): boolean => typeof row.archivedAt === "string" && row.archivedAt !== "";

	// 会话行：标题/项目名匹配搜索词。列表本身已按 modified 降序。
	const sessionMatches = (row: SessionRow): boolean =>
		!search || sessionTitle(row).toLowerCase().includes(search) || (row.cwd ?? "").toLowerCase().includes(search);

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
	// 排序：当前项目置顶，其余按最近会话活动时间降序（无会话的按名称垫底）。
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
				const aCurrent = samePath(a.path, activeProject);
				const bCurrent = samePath(b.path, activeProject);
				if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
				if (a.latest !== b.latest) return a.latest > b.latest ? -1 : 1;
				return projectLabel(a.path).localeCompare(projectLabel(b.path), "zh-CN");
			})
			.map((entry) => entry.path);
	}, [sessions, activeProject, knownProjects]);

	// 搜索时项目行按名称/路径/自身会话过滤，避免搜会话时冒出一堆不相干项目。
	const projectMatchesSearch = (path: string): boolean =>
		!search ||
		projectLabel(path).toLowerCase().includes(search) ||
		path.toLowerCase().includes(search) ||
		sessions.some((row) => samePath(row.cwd, path) && !isArchivedRow(row) && sessionMatches(row));

	const visibleProjects = useMemo(
		() => projectPaths.filter(projectMatchesSearch),
		[projectPaths, sessions, search], // eslint-disable-line react-hooks/exhaustive-deps
	);

	// 置顶项目行（按置顶先后），搜索时同样按项目过滤。
	const pinnedProjectRows = useMemo(
		() => (search ? pinnedProjects.filter(projectMatchesSearch) : pinnedProjects),
		[pinnedProjects, search, sessions], // eslint-disable-line react-hooks/exhaustive-deps
	);

	const recentSessions = useMemo(() => {
		const rows = sessions.filter((row) => !isArchivedRow(row) && sessionMatches(row));
		if (recentSort === "name") {
			rows.sort((a, b) => sessionTitle(a).localeCompare(sessionTitle(b), "zh-CN"));
		}
		return rows.slice(0, RECENT_LIMIT);
	}, [sessions, search, recentSort]); // eslint-disable-line react-hooks/exhaustive-deps

	const archivedSessions = useMemo(() => sessions.filter((row) => isArchivedRow(row)).sort(byLatest), [sessions]);

	/** 行内操作保留键盘入口，样式统一在侧边栏内控制。 */
	const rowBtn = "owl-sidebar-action";

	/** 会话行悬停 tooltip：标题 + 时间 · 项目（单行化后元信息收进这里）。 */
	const sessionRowTip = (row: SessionRow, archivedRow: boolean): string => {
		const time =
			archivedRow && row.archivedAt ? `归档于 ${relativeTime(row.archivedAt)}` : relativeTime(sessionTime(row));
		return `${sessionTitle(row)}\n${time}${row.cwd ? ` · ${row.cwd}` : ""}`;
	};

	/**
	 * 会话行（单行紧凑式）：聊天图标 + 标题，运行中的会话显示绿色状态，
	 * 悬停露出置顶/归档/删除按钮；归档行常显「恢复」按钮。
	 */
	const sessionRow = (row: SessionRow, index: number, pinnedRow: boolean, archivedRow = false): React.JSX.Element => {
		const id = row.id;
		const isPinned = id !== undefined && pinned.includes(id);
		const isRunning = id !== undefined && runningSessions.has(id);
		return (
			<div
				key={id ?? index}
				className={`owl-sidebar-row owl-sidebar-session-row ${id === activeId ? "is-active" : ""} ${
					pinnedRow || archivedRow ? "owl-sidebar-row--has-marker" : ""
				}`}
			>
				<button
					type="button"
					className="owl-sidebar-row-main"
					title={sessionRowTip(row, archivedRow)}
					aria-current={id === activeId ? "page" : undefined}
					onClick={() => id && onOpenSession(id)}
				>
					<span
						className={`owl-sidebar-session-icon ${isRunning ? "is-running animate-pulse text-emerald-500" : ""}`}
						title={isRunning ? "Agent 运行中" : undefined}
					>
						<IconChat className="h-3.5 w-3.5" />
					</span>
					<span className="owl-sidebar-row-label">{sessionTitle(row)}</span>
					{isRunning && <span className="sr-only">，Agent 运行中</span>}
				</button>
				{id && (
					<div className="owl-sidebar-row-actions" data-persistent={pinnedRow || archivedRow}>
						{!archivedRow && (
							<button
								type="button"
								className={`${rowBtn} ${pinnedRow ? "owl-sidebar-action--persistent order-last" : ""}`}
								title={isPinned ? "取消置顶" : "置顶"}
								aria-label={isPinned ? "取消置顶会话" : "置顶会话"}
								aria-pressed={isPinned}
								onClick={() => togglePin(id)}
							>
								<IconPin className="h-3.5 w-3.5" filled={isPinned} />
							</button>
						)}
						{archivedRow ? (
							<button
								type="button"
								className={`${rowBtn} owl-sidebar-action--persistent order-last`}
								title="恢复到原位置"
								aria-label="恢复会话到原位置"
								onClick={() => void toggleArchive(row)}
							>
								<IconUnarchive className="h-3.5 w-3.5" />
							</button>
						) : (
							<button
								type="button"
								className={rowBtn}
								title="归档"
								aria-label="归档会话"
								onClick={() => void toggleArchive(row)}
							>
								<IconArchive className="h-3.5 w-3.5" />
							</button>
						)}
						<button
							type="button"
							className={`${rowBtn} owl-sidebar-action--danger`}
							title="删除会话"
							aria-label="删除会话"
							onClick={() => {
								setConfirmDelete(row);
								setDeleteError("");
							}}
						>
							<IconTrash className="h-3.5 w-3.5" />
						</button>
					</div>
				)}
			</div>
		);
	};

	/** 项目下的未归档会话（按最近活动排序，搜索时同步过滤）。「项目」/「置顶」两组行共用。 */
	const projectSessionRows = (path: string): SessionRow[] =>
		sessions.filter((row) => !isArchivedRow(row) && samePath(row.cwd, path) && sessionMatches(row)).sort(byLatest);

	/**
	 * 置顶栏里的项目行：chevron 展开该项目的会话列表，名称点击切换项目（当前项目点击仅展开/收起）；
	 * 右侧操作与「项目」分组的项目行一致（置顶 / 新建会话 / ⋯ 菜单）。
	 * 非当前项目的「新建会话」= 切换过去（switchProject 本身就以全新会话开场）。
	 */
	const pinnedProjectRow = (path: string): React.JSX.Element => {
		const isCurrent = samePath(path, activeProject);
		const menuId = `${PINNED_PROJECT_ROW_MENU_PREFIX}${normPath(path)}`;
		const expanded = search !== "" || projectGroupOpen(path, "pinned");
		const rows = projectSessionRows(path);
		const startChat = (): void => {
			if (isCurrent) onNewChat();
			else onSelectProject(path);
			setOpenMenu(null);
		};
		return (
			<div key={menuId} className="owl-sidebar-project-group">
				<div
					className={`owl-sidebar-row owl-sidebar-project-row owl-sidebar-row--has-marker ${
						isCurrent ? "is-current" : ""
					} ${openMenu === menuId ? "is-open" : ""}`}
				>
					<button
						type="button"
						className="owl-sidebar-project-toggle"
						aria-expanded={expanded}
						aria-label={`${expanded ? "收起" : "展开"}${projectLabel(path)}的会话列表`}
						title={expanded ? "收起会话列表" : "展开会话列表"}
						onClick={() => toggleProjectGroup(path, "pinned")}
					>
						<IconChevron
							className={`h-3 w-3 shrink-0 text-owl-sidebar-faint transition-transform ${expanded ? "rotate-90" : ""}`}
						/>
					</button>
					<button
						type="button"
						className="owl-sidebar-row-main"
						title={path}
						aria-label={isCurrent ? `${projectLabel(path)}，当前项目` : `切换到项目 ${projectLabel(path)}`}
						onClick={() => (isCurrent ? toggleProjectGroup(path, "pinned") : onSelectProject(path))}
					>
						<IconFolder className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" />
						<span className="owl-sidebar-row-label">{projectLabel(path)}</span>
					</button>
					<div data-menu-root className="owl-sidebar-row-actions" data-persistent>
						<button
							type="button"
							className="owl-sidebar-action owl-sidebar-action--persistent order-last"
							title="取消置顶"
							aria-label="取消置顶项目"
							aria-pressed
							onClick={() => toggleProjectPin(path)}
						>
							<IconPin className="h-3.5 w-3.5" filled />
						</button>
						<button
							type="button"
							className="owl-sidebar-action"
							title={isCurrent ? "在本项目新建会话" : "切换到此项目并新建会话"}
							aria-label={`在项目 ${projectLabel(path)} 新建会话`}
							onClick={startChat}
						>
							<IconPlus className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							className="owl-sidebar-action"
							title="项目操作"
							aria-label={`${projectLabel(path)} 项目操作`}
							aria-expanded={openMenu === menuId}
							onClick={() => setOpenMenu(openMenu === menuId ? null : menuId)}
						>
							<IconMore className="h-3.5 w-3.5" />
						</button>
					</div>
					{openMenu === menuId && (
						<div
							data-menu-root
							className="absolute right-2 top-full z-30 mt-1 w-44 rounded-xl border border-owl-sidebar-border bg-owl-sidebar-surface py-1 shadow-xl shadow-black/30"
						>
							{isCurrent ? (
								<MenuRow
									label="新建会话"
									onClick={() => {
										setOpenMenu(null);
										onNewChat();
									}}
								/>
							) : (
								<MenuRow
									label="切换到此项目"
									onClick={() => {
										setOpenMenu(null);
										onSelectProject(path);
									}}
								/>
							)}
							<MenuRow
								label="在资源管理器中打开"
								onClick={() => {
									setOpenMenu(null);
									void revealProject(path);
								}}
							/>
						</div>
					)}
				</div>
				{expanded && (
					<div className="owl-sidebar-project-sessions">
						{rows.map((row, index) => sessionRow(row, index, false))}
						{rows.length === 0 && <p className="owl-sidebar-empty">{search ? "无匹配会话" : "暂无会话"}</p>}
					</div>
				)}
			</div>
		);
	};

	/** 项目行：chevron 展开/收起会话列表；名称点击切换项目（当前项目点击仅展开/收起）；悬停露出操作菜单。 */
	const projectRow = (path: string): React.JSX.Element => {
		const isCurrent = samePath(path, activeProject);
		const projectPinned = isProjectPinned(path);
		const menuId = `${PROJECT_ROW_MENU_PREFIX}${normPath(path)}`;
		const expanded = search !== "" || projectGroupOpen(path, "project");
		const rows = projectSessionRows(path);
		return (
			<div key={menuId} className="owl-sidebar-project-group">
				<div
					className={`owl-sidebar-row owl-sidebar-project-row ${isCurrent ? "is-current" : ""} ${
						projectPinned ? "owl-sidebar-row--has-marker" : ""
					} ${openMenu === menuId ? "is-open" : ""}`}
				>
					<button
						type="button"
						className="owl-sidebar-project-toggle"
						aria-expanded={expanded}
						aria-label={`${expanded ? "收起" : "展开"}${projectLabel(path)}的会话列表`}
						title={expanded ? "收起会话列表" : "展开会话列表"}
						onClick={() => toggleProjectGroup(path, "project")}
					>
						<IconChevron
							className={`h-3 w-3 shrink-0 text-owl-sidebar-faint transition-transform ${expanded ? "rotate-90" : ""}`}
						/>
					</button>
					<button
						type="button"
						className="owl-sidebar-row-main"
						title={path}
						aria-label={isCurrent ? `${projectLabel(path)}，当前项目` : `切换到项目 ${projectLabel(path)}`}
						onClick={() => (isCurrent ? toggleProjectGroup(path, "project") : onSelectProject(path))}
					>
						<IconFolder className="h-3.5 w-3.5 shrink-0 text-owl-sidebar-faint" />
						<span className="owl-sidebar-row-label">{projectLabel(path)}</span>
					</button>
					<div data-menu-root className="owl-sidebar-row-actions" data-persistent={projectPinned}>
						<button
							type="button"
							className={`owl-sidebar-action ${projectPinned ? "owl-sidebar-action--persistent order-last" : ""}`}
							title={projectPinned ? "取消置顶" : "置顶项目"}
							aria-label={projectPinned ? "取消置顶项目" : "置顶项目"}
							aria-pressed={projectPinned}
							onClick={() => toggleProjectPin(path)}
						>
							<IconPin className="h-3.5 w-3.5" filled={projectPinned} />
						</button>
						{isCurrent && (
							<button
								type="button"
								className="owl-sidebar-action"
								title="在本项目新建会话"
								aria-label={`在项目 ${projectLabel(path)} 新建会话`}
								onClick={onNewChat}
							>
								<IconPlus className="h-3.5 w-3.5" />
							</button>
						)}
						<button
							type="button"
							className="owl-sidebar-action"
							title="项目操作"
							aria-label={`${projectLabel(path)} 项目操作`}
							aria-expanded={openMenu === menuId}
							onClick={() => setOpenMenu(openMenu === menuId ? null : menuId)}
						>
							<IconMore className="h-3.5 w-3.5" />
						</button>
					</div>
					{openMenu === menuId && (
						<div
							data-menu-root
							className="absolute right-2 top-full z-30 mt-1 w-44 rounded-xl border border-owl-sidebar-border bg-owl-sidebar-surface py-1 shadow-xl shadow-black/30"
						>
							{isCurrent ? (
								<MenuRow
									label="新建会话"
									onClick={() => {
										setOpenMenu(null);
										onNewChat();
									}}
								/>
							) : (
								<MenuRow
									label="切换到此项目"
									onClick={() => {
										setOpenMenu(null);
										onSelectProject(path);
									}}
								/>
							)}
							<MenuRow
								label="在资源管理器中打开"
								onClick={() => {
									setOpenMenu(null);
									void revealProject(path);
								}}
							/>
						</div>
					)}
				</div>
				{expanded && (
					<div className="owl-sidebar-project-sessions">
						{rows.map((row, index) => sessionRow(row, index, false))}
						{rows.length === 0 && <p className="owl-sidebar-empty">{search ? "无匹配会话" : "暂无会话"}</p>}
					</div>
				)}
			</div>
		);
	};

	const noMatch =
		search !== "" &&
		visibleProjects.length === 0 &&
		pinnedProjectRows.length === 0 &&
		recentSessions.length === 0 &&
		archivedSessions.filter(sessionMatches).length === 0 &&
		pinnedSessions.filter(sessionMatches).length === 0;

	/** 分组头部快捷按钮的统一样式。 */
	const actionBtn = "owl-sidebar-action";
	const switchPinnedSort = (value: PinnedSort): void => {
		setPinnedSort(value);
		saveChoice(PINNED_SORT_KEY, value);
		setOpenMenu(null);
	};
	const switchRecentSort = (value: ListSort): void => {
		setRecentSort(value);
		saveChoice(RECENT_SORT_KEY, value);
		setOpenMenu(null);
	};
	const openNewProject = (): void => {
		setShowNewProject(true);
		setOpenMenu(null);
	};

	// 收起态：原位留一条窄栏，在顶部恢复侧边栏。
	if (minimized) {
		return (
			<aside
				className="owl-sidebar owl-sidebar--minimized"
				data-tauri-drag-region="deep"
				aria-label="会话侧边栏（已收起）"
			>
				<div className="owl-sidebar-header" data-tauri-drag-region="deep">
					<button
						type="button"
						className="owl-sidebar-icon-button"
						title="展开侧边栏"
						aria-label="展开侧边栏"
						aria-expanded={false}
						onClick={toggleMinimized}
					>
						<IconPanelLeft className="h-4 w-4" />
					</button>
				</div>
			</aside>
		);
	}

	return (
		<aside className="owl-sidebar" aria-label="会话侧边栏">
			<div className="owl-sidebar-header" data-tauri-drag-region="deep">
				<button
					type="button"
					className="owl-sidebar-brand"
					title="收起侧边栏"
					aria-label="收起侧边栏"
					aria-expanded={!minimized}
					onClick={toggleMinimized}
				>
					<img src="/owl.svg" alt="" className="h-5 w-5" draggable={false} />
					<span>owl</span>
				</button>
				<div className="flex-1" data-tauri-drag-region="deep" />
				<div className="owl-sidebar-header-actions">
					<button
						type="button"
						className={`owl-sidebar-icon-button ${searchOpen ? "is-active" : ""}`}
						title="搜索会话与项目"
						aria-label="搜索会话与项目"
						aria-expanded={searchOpen}
						onClick={() => {
							setSearchOpen((open) => !open);
							if (searchOpen) setQuery("");
						}}
					>
						<IconSearch className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="owl-sidebar-icon-button"
						title="收起侧边栏"
						aria-label="收起侧边栏"
						aria-expanded
						onClick={toggleMinimized}
					>
						<IconPanelLeft className="h-4 w-4" />
					</button>
				</div>
			</div>

			{searchOpen && (
				<div className="owl-sidebar-search">
					<input
						type="text"
						className="owl-sidebar-search-input"
						placeholder="搜索会话或项目…"
						aria-label="搜索会话或项目"
						value={query}
						autoFocus
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								setQuery("");
								setSearchOpen(false);
							}
						}}
					/>
				</div>
			)}

			<div className="owl-sidebar-shortcuts">
				<button type="button" className="owl-sidebar-new-chat" aria-label="新会话" onClick={onNewChat}>
					<IconCompose className="h-4 w-4 shrink-0" />
					<span>新会话</span>
				</button>
			</div>

			<div ref={scrollRef} className="owl-sidebar-list">
				{(pinnedProjectRows.length > 0 || pinnedSessions.length > 0) && (
					<Section
						id="pinned"
						label="置顶"
						open={isOpen("pinned")}
						onToggle={() => toggleSection("pinned")}
						showMenu={openMenu === "pinned"}
						actions={
							<button
								type="button"
								className={actionBtn}
								title="置顶选项"
								aria-label="置顶选项"
								aria-expanded={openMenu === "pinned"}
								onClick={() => setOpenMenu(openMenu === "pinned" ? null : "pinned")}
							>
								<IconMore className="h-3.5 w-3.5" />
							</button>
						}
						menu={
							<>
								<MenuRow
									label="最近更新"
									checked={pinnedSort === "recent"}
									onClick={() => switchPinnedSort("recent")}
								/>
								<MenuRow
									label="手动排序"
									checked={pinnedSort === "manual"}
									hint="按置顶先后"
									onClick={() => switchPinnedSort("manual")}
								/>
							</>
						}
					>
						{pinnedProjectRows.map((path) => pinnedProjectRow(path))}
						{pinnedSessions.filter(sessionMatches).map((row, index) => sessionRow(row, index, true))}
					</Section>
				)}

				<Section
					id="projects"
					label="项目"
					open={isOpen("projects")}
					onToggle={() => toggleSection("projects")}
					showMenu={openMenu === "projects"}
					actions={
						<>
							<button
								type="button"
								className={actionBtn}
								title="项目选项"
								aria-label="项目选项"
								aria-expanded={openMenu === "projects"}
								onClick={() => setOpenMenu(openMenu === "projects" ? null : "projects")}
							>
								<IconMore className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								className={actionBtn}
								title="新建项目"
								aria-label="新建项目"
								onClick={openNewProject}
							>
								<IconPlus className="h-3.5 w-3.5" />
							</button>
						</>
					}
					menu={<MenuRow label="新建项目" onClick={openNewProject} />}
				>
					{/* 项目列表：当前项目置顶，其余按最近活动排序；点击项目名切换，chevron 展开会话 */}
					{visibleProjects.map((path) => projectRow(path))}
					<button type="button" className="owl-sidebar-add-project" aria-label="新建项目" onClick={openNewProject}>
						<IconPlus className="h-3.5 w-3.5 shrink-0" />
						新建项目
					</button>
				</Section>

				<Section
					id="recent"
					label="最近"
					open={isOpen("recent")}
					onToggle={() => toggleSection("recent")}
					showMenu={openMenu === "recent"}
					actions={
						<>
							<button
								type="button"
								className={actionBtn}
								title="最近选项"
								aria-label="最近选项"
								aria-expanded={openMenu === "recent"}
								onClick={() => setOpenMenu(openMenu === "recent" ? null : "recent")}
							>
								<IconMore className="h-3.5 w-3.5" />
							</button>
							<button type="button" className={actionBtn} title="新建聊天" aria-label="新建聊天" onClick={onNewChat}>
								<IconCompose className="h-3.5 w-3.5" />
							</button>
						</>
					}
					menu={
						<>
							<MenuRow label="整理侧边栏" disabled hint="开发中" />
							<MenuDivider />
							<MenuLabel>排序方式</MenuLabel>
							<MenuRow
								label="按最近更新"
								checked={recentSort === "recent"}
								onClick={() => switchRecentSort("recent")}
							/>
							<MenuRow label="按名称" checked={recentSort === "name"} onClick={() => switchRecentSort("name")} />
						</>
					}
				>
					{recentSessions.map((row, index) => sessionRow(row, index, false))}
					{recentSessions.length === 0 && <p className="owl-sidebar-empty">{search ? "无匹配会话" : "暂无会话"}</p>}
				</Section>

				{archivedSessions.length > 0 && (
					<Section id="archived" label="归档" open={isOpen("archived")} onToggle={() => toggleSection("archived")}>
						{archivedSessions.filter(sessionMatches).map((row, index) => sessionRow(row, index, false, true))}
					</Section>
				)}

				{noMatch && <p className="owl-sidebar-empty">无匹配结果</p>}
			</div>

			{showNewProject && (
				<NewProjectDialog
					client={client}
					onClose={() => setShowNewProject(false)}
					onCreated={(path) => {
						setShowNewProject(false);
						onSelectProject(path);
					}}
				/>
			)}

			{confirmDelete && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog">
					<div className="w-80 rounded-xl border border-owl-border bg-owl-panel p-4 shadow-2xl shadow-black/40">
						<h2 className="mb-1 text-sm font-semibold text-owl-text">删除会话</h2>
						<p className="mb-3 break-all text-xs text-owl-muted">
							「{sessionTitle(confirmDelete)}」的聊天记录将被永久删除，此操作不可恢复。
						</p>
						{deleteError && <p className="mt-2 text-xs text-red-400">{deleteError}</p>}
						<div className="mt-4 flex justify-end gap-2">
							<button
								type="button"
								className="rounded-lg border border-owl-border px-3 py-1.5 text-xs text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
								onClick={() => setConfirmDelete(null)}
								disabled={deleting}
							>
								取消
							</button>
							<button
								type="button"
								className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-400 disabled:opacity-50"
								onClick={() => void deleteSession(confirmDelete)}
								disabled={deleting}
							>
								{deleting ? "删除中…" : "删除"}
							</button>
						</div>
					</div>
				</div>
			)}
		</aside>
	);
}
