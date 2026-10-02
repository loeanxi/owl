import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ProjectCreateResult } from "../bridge/protocol.ts";
import { hasTauri, pickFolder } from "../bridge/native.ts";
import {
	IconArchive,
	IconChat,
	IconCheck,
	IconChevron,
	IconCompose,
	IconFolder,
	IconMore,
	IconPin,
	IconPlus,
	IconSearch,
	IconTrash,
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
const COLLAPSED_KEY = "owl.sidebar.collapsed";
/** 分组排序偏好（Codex 式分组菜单）：置顶 manual=置顶顺序；最近 name=按名称。 */
const PINNED_SORT_KEY = "owl.sidebar.pinnedSort";
const RECENT_SORT_KEY = "owl.sidebar.recentSort";
/** 「最近」分组最多展示的会话数，避免长列表把项目挤出视口。 */
const RECENT_LIMIT = 30;
/** 项目行内嵌会话列表的折叠标记（存进 collapsed 集合）。 */
const PROJECT_SESSIONS_ID = "project-sessions";

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

/** Windows 大小写不敏感 + 分隔符统一后比较两个路径是否同一项目。 */
function samePath(a: string | undefined, b: string | undefined): boolean {
	const norm = (p: string | undefined): string =>
		(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return norm(a) === norm(b) && norm(a) !== "";
}

function projectLabel(cwd: string): string {
	const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || cwd;
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

function loadCollapsed(): Set<string> {
	try {
		const raw = localStorage.getItem(COLLAPSED_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
	} catch {
		return new Set();
	}
}

/** 可折叠分组：头部（箭头 + 标题，悬停露出操作按钮）+ 展开内容 + 可选下拉菜单。 */
function Section({
	id,
	label,
	open,
	onToggle,
	actions,
	menu,
	showMenu,
	children,
	headerRef,
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
	headerRef?: React.Ref<HTMLDivElement>;
}): React.JSX.Element {
	return (
		<div id={id} data-section={id} className="mt-3 first:mt-0">
			<div
				ref={headerRef}
				className="group/header relative flex items-center rounded-md px-3 py-1 transition-colors hover:bg-owl-hover/40"
			>
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-1 text-left"
					onClick={onToggle}
					aria-expanded={open}
				>
					<IconChevron
						className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${open ? "rotate-90" : ""}`}
					/>
					<span className="text-xs font-medium text-owl-muted">{label}</span>
				</button>
				{actions && (
					<div
						data-menu-root
						className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
							showMenu ? "opacity-100" : "opacity-0 group-hover/header:opacity-100"
						}`}
					>
						{actions}
					</div>
				)}
				{menu && showMenu && (
					<div
						data-menu-root
						className="absolute right-2 top-full z-30 mt-1 w-56 rounded-xl border border-owl-border bg-owl-panel py-1 shadow-xl shadow-black/30"
					>
						{menu}
					</div>
				)}
			</div>
			{open && <div className="mt-0.5 px-2">{children}</div>}
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
					? "cursor-default text-owl-faint/50"
					: "text-owl-muted hover:bg-owl-hover hover:text-owl-text"
			}`}
			onClick={onClick}
		>
			<span className="flex items-center gap-2">
				{label}
				{hint && <span className="text-[10px] font-normal text-owl-faint/70">{hint}</span>}
			</span>
			{checked && <IconCheck className="h-3.5 w-3.5 shrink-0 text-owl-text" />}
		</button>
	);
}

/** 分组菜单里的小节标题（如「排序方式」）。 */
function MenuLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
	return <p className="px-3 pb-1 pt-2 text-[10px] text-owl-faint/80">{children}</p>;
}

/** 分组菜单分隔线。 */
function MenuDivider(): React.JSX.Element {
	return <div className="my-1 border-t border-owl-border/70" />;
}

export function SessionSidebar({
	client,
	connected,
	activeId,
	activeProject,
	refreshKey,
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
	/** 变化时重新拉取会话列表（如新会话创建后）。 */
	refreshKey: string;
	/** rail 点击项目/最近时定位到对应分组。 */
	focus: RailView;
	onNewChat: () => void;
	onSelectProject: (path: string) => void;
	/** 点击历史会话：恢复回放并续聊。 */
	onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	const [showNewProject, setShowNewProject] = useState(false);
	const [newPath, setNewPath] = useState("");
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState("");
	// 桌面壳里可打开系统文件夹选择框（浏览器模式隐藏入口）
	const [browsing, setBrowsing] = useState(false);
	const [pinned, setPinned] = useState<string[]>(loadPinned);
	const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	/** 当前展开的分组菜单（Codex 式 ⋯ 菜单）；值为分组 id。 */
	const [openMenu, setOpenMenu] = useState<"pinned" | "projects" | "recent" | null>(null);
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
	const scrollRef = useRef<HTMLDivElement>(null);
	const projectHeaderRef = useRef<HTMLDivElement>(null);
	const recentHeaderRef = useRef<HTMLDivElement>(null);

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
	}, [client, connected, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

	const isOpen = (id: string): boolean => query.trim() !== "" || !collapsed.has(id);

	// rail 定位：展开目标分组并滚动到可视区。
	useEffect(() => {
		if (focus === "chat") {
			scrollRef.current?.scrollTo({ top: 0 });
			return;
		}
		setCollapsed((current) => {
			if (!current.has(focus)) return current;
			const next = new Set(current);
			next.delete(focus);
			localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
			return next;
		});
		requestAnimationFrame(() => {
			const target = focus === "projects" ? projectHeaderRef.current : recentHeaderRef.current;
			target?.scrollIntoView({ behavior: "smooth", block: "start" });
		});
	}, [focus]);

	const togglePin = (id: string): void => {
		setPinned((current) => {
			const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
			localStorage.setItem(PINNED_KEY, JSON.stringify(next));
			return next;
		});
	};

	/** 归档/取消归档：写服务端 archive.json，成功后重拉列表（archivedAt 随 session.list 下发）。 */
	const toggleArchive = async (row: SessionRow): Promise<void> => {
		const id = row.id;
		if (!id) return;
		try {
			const response = await client.request({
				type: row.archivedAt ? "session.unarchive" : "session.archive",
				sessionId: id,
			});
			if (response.ok) void refresh();
		} catch {
			// 桥未连接等瞬时失败：列表不动，用户重试即可
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
		!search ||
		sessionTitle(row).toLowerCase().includes(search) ||
		(row.cwd ?? "").toLowerCase().includes(search);

	const byLatest = (a: SessionRow, b: SessionRow): number => (sessionTime(a) < sessionTime(b) ? 1 : -1);

	const pinnedSessions = useMemo(() => {
		const rows = sessions.filter(
			(row) => row.id !== undefined && pinned.includes(row.id) && !isArchivedRow(row),
		);
		if (pinnedSort === "manual") {
			// 手动排序 = 置顶操作发生的先后顺序（pinned 数组序）
			return rows.sort((a, b) => pinned.indexOf(a.id as string) - pinned.indexOf(b.id as string));
		}
		return rows.sort(byLatest);
	}, [sessions, pinned, pinnedSort]); // eslint-disable-line react-hooks/exhaustive-deps

	// 当前项目的会话：项目分组下嵌套展示（其余项目的会话只在「最近」出现）。
	const projectSessions = useMemo(
		() => sessions.filter((row) => !isArchivedRow(row) && samePath(row.cwd, activeProject)).sort(byLatest),
		[sessions, activeProject], // eslint-disable-line react-hooks/exhaustive-deps
	);

	const recentSessions = useMemo(() => {
		const rows = sessions.filter((row) => !isArchivedRow(row) && sessionMatches(row));
		if (recentSort === "name") {
			rows.sort((a, b) => sessionTitle(a).localeCompare(sessionTitle(b), "zh-CN"));
		}
		return rows.slice(0, RECENT_LIMIT);
	}, [sessions, search, recentSort]); // eslint-disable-line react-hooks/exhaustive-deps

	const archivedSessions = useMemo(() => sessions.filter((row) => isArchivedRow(row)).sort(byLatest), [sessions]);

	const submitNewProject = async (): Promise<void> => {
		const path = newPath.trim();
		if (!path) return;
		setCreating(true);
		setCreateError("");
		try {
			const response = await client.request<ProjectCreateResult>({ type: "project.create", path });
			if (!response.ok || !response.result) {
				setCreateError(response.error ?? "创建失败");
				return;
			}
			onSelectProject(response.result.path);
			setShowNewProject(false);
			setNewPath("");
		} catch (error) {
			setCreateError(error instanceof Error ? error.message : String(error));
		} finally {
			setCreating(false);
		}
	};

	/** 系统资源管理器选择项目目录（仅桌面壳有此入口）。 */
	const browseProject = async (): Promise<void> => {
		setBrowsing(true);
		setCreateError("");
		try {
			const selected = await pickFolder("选择项目目录");
			if (selected) setNewPath(selected);
		} catch (error) {
			setCreateError(error instanceof Error ? error.message : String(error));
		} finally {
			setBrowsing(false);
		}
	};

	/** 会话行悬停操作按钮的统一样式。 */
	const rowBtn =
		"shrink-0 rounded p-1 text-owl-faint opacity-0 transition-colors group-hover/row:opacity-100 hover:bg-owl-border/60";

	/** 会话行：图标 + 标题 + 次行（时间 · 项目），悬停露出置顶/归档/删除按钮。 */
	const sessionRow = (row: SessionRow, index: number, pinnedRow: boolean, archivedRow = false): React.JSX.Element => {
		const id = row.id;
		const isPinned = id !== undefined && pinned.includes(id);
		return (
			<div
				key={id ?? index}
				className={`group/row flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
					id === activeId ? "bg-owl-hover text-owl-text" : "text-owl-muted hover:bg-owl-hover/60 hover:text-owl-text"
				}`}
			>
				<button
					type="button"
					className="flex min-w-0 flex-1 flex-col items-start text-left"
					title={`${sessionTitle(row)}\n${row.cwd ?? ""}`}
					onClick={() => id && onOpenSession(id)}
				>
					<span className="flex w-full items-center gap-1.5">
						<IconChat className="h-3 w-3 shrink-0 text-owl-faint/70" />
						<span className="truncate text-xs leading-5">{sessionTitle(row)}</span>
					</span>
					<span className="mt-0.5 flex w-full items-center gap-1 pl-[18px] text-[10px] leading-4 text-owl-faint/80">
						<span className="shrink-0">
							{archivedRow && row.archivedAt
								? `归档于 ${relativeTime(row.archivedAt)}`
								: relativeTime(sessionTime(row))}
						</span>
						{row.cwd && (
							<>
								<span className="shrink-0">·</span>
								<span className="truncate" title={row.cwd}>
									{projectLabel(row.cwd)}
								</span>
							</>
						)}
					</span>
				</button>
				{id && (
					<div className="flex shrink-0 items-center gap-0.5">
						{!archivedRow && (
							<button
								type="button"
								className={`rounded p-1 transition-colors hover:bg-owl-border/60 ${
									pinnedRow
										? "text-owl-accent"
										: `text-owl-faint opacity-0 group-hover/row:opacity-100 ${isPinned ? "text-owl-accent" : ""}`
								}`}
								title={isPinned ? "取消置顶" : "置顶"}
								onClick={() => togglePin(id)}
							>
								<IconPin className="h-3.5 w-3.5" filled={isPinned} />
							</button>
						)}
						<button
							type="button"
							className={`${rowBtn} ${archivedRow ? "text-owl-accent" : "hover:text-owl-text"}`}
							title={archivedRow ? "取消归档" : "归档"}
							onClick={() => void toggleArchive(row)}
						>
							<IconArchive className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							className={`${rowBtn} hover:text-red-400`}
							title="删除会话"
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

	const noMatch =
		search !== "" &&
		projectSessions.filter(sessionMatches).length === 0 &&
		recentSessions.length === 0 &&
		archivedSessions.filter(sessionMatches).length === 0 &&
		pinnedSessions.filter(sessionMatches).length === 0;

		/** 分组头部快捷按钮的统一样式。 */
		const actionBtn =
			"rounded p-1 text-owl-faint transition-colors hover:bg-owl-border/60 hover:text-owl-text";
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
			setCreateError("");
			setOpenMenu(null);
		};

		return (
			<aside className="flex w-64 shrink-0 flex-col border-r border-owl-border bg-owl-sidebar">
			<div
				className="flex select-none items-center gap-2 px-3 pb-1 pt-3"
				data-tauri-drag-region="deep"
			>
				<img src="/owl.svg" alt="owl" className="h-6 w-6" draggable={false} />
				<span className="font-serif text-base tracking-wide text-owl-text">owl</span>
				<div className="flex-1" data-tauri-drag-region="deep" />
				<button
					type="button"
					className={`rounded-md p-1.5 transition-colors hover:bg-owl-hover/60 ${
						searchOpen ? "text-owl-text" : "text-owl-faint hover:text-owl-text"
					}`}
					title="搜索会话与项目"
					onClick={() => {
						setSearchOpen((open) => !open);
						if (searchOpen) setQuery("");
					}}
				>
					<IconSearch className="h-4 w-4" />
				</button>
			</div>

			{searchOpen && (
				<div className="px-3 pb-1 pt-1">
					<input
						type="text"
						className="w-full rounded-lg border border-owl-border bg-owl-bg px-2.5 py-1.5 text-xs text-owl-text outline-none transition-colors placeholder:text-owl-faint focus:border-owl-accent"
						placeholder="搜索会话或项目…"
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

			<div className="px-3 pt-2">
				<button
					type="button"
					className="w-full rounded-lg bg-owl-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-owl-accent-hover"
					onClick={onNewChat}
				>
					＋ 新会话
				</button>
			</div>

			<div ref={scrollRef} className="mt-2 flex-1 overflow-y-auto pb-3">
				{pinnedSessions.length > 0 && (
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
						{pinnedSessions.filter(sessionMatches).map((row, index) => sessionRow(row, index, true))}
					</Section>
				)}

				<Section
					id="projects"
					label="项目"
					open={isOpen("projects")}
					onToggle={() => toggleSection("projects")}
					headerRef={projectHeaderRef}
					showMenu={openMenu === "projects"}
					actions={
						<>
							<button
								type="button"
								className={actionBtn}
								title="项目选项"
								onClick={() => setOpenMenu(openMenu === "projects" ? null : "projects")}
							>
								<IconMore className="h-3.5 w-3.5" />
							</button>
							<button type="button" className={actionBtn} title="新建项目" onClick={openNewProject}>
								<IconPlus className="h-3.5 w-3.5" />
							</button>
						</>
					}
					menu={<MenuRow label="新建项目" onClick={openNewProject} />}
				>
					{/* 当前项目行：点击展开/收起会话列表；悬停右侧露出新会话/项目选项按钮 */}
					<div className="group/project flex items-center rounded-md px-2 py-1 transition-colors hover:bg-owl-hover/40">
						<button
							type="button"
							className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
							onClick={() => toggleSection(PROJECT_SESSIONS_ID)}
							aria-expanded={isOpen(PROJECT_SESSIONS_ID)}
						>
							<IconChevron
								className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${
									isOpen(PROJECT_SESSIONS_ID) ? "rotate-90" : ""
								}`}
							/>
							<IconFolder className="h-3.5 w-3.5 shrink-0 text-owl-faint/70" />
							<span className="truncate text-xs text-owl-text">{projectLabel(activeProject)}</span>
						</button>
						<div className="flex shrink-0 items-center gap-0.5">
							<button
								type="button"
								className="rounded p-1 text-owl-faint opacity-0 transition-colors group-hover/project:opacity-100 hover:bg-owl-border/60 hover:text-owl-text"
								title="在本项目新建会话"
								onClick={onNewChat}
							>
								<IconPlus className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								className="rounded p-1 text-owl-faint opacity-0 transition-colors group-hover/project:opacity-100 hover:bg-owl-border/60 hover:text-owl-text"
								title="项目选项"
								onClick={() => setOpenMenu(openMenu === "projects" ? null : "projects")}
							>
								<IconMore className="h-3.5 w-3.5" />
							</button>
							<span className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-owl-accent" title="当前项目" />
						</div>
					</div>
					{isOpen(PROJECT_SESSIONS_ID) && (
						<div className="mt-0.5 pl-4">
							{projectSessions.filter(sessionMatches).map((row, index) => sessionRow(row, index, false))}
							{projectSessions.filter(sessionMatches).length === 0 && (
								<p className="px-2 py-2 text-xs text-owl-faint/70">{search ? "无匹配会话" : "暂无会话"}</p>
							)}
						</div>
					)}
					<button
						type="button"
						className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-owl-faint transition-colors hover:bg-owl-hover/60 hover:text-owl-text"
						onClick={() => {
							setShowNewProject(true);
							setCreateError("");
						}}
					>
						<span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-sm leading-none">＋</span>
						新建项目
					</button>
				</Section>

				<Section
					id="recent"
					label="最近"
					open={isOpen("recent")}
					onToggle={() => toggleSection("recent")}
					headerRef={recentHeaderRef}
					showMenu={openMenu === "recent"}
					actions={
						<>
							<button
								type="button"
								className={actionBtn}
								title="最近选项"
								onClick={() => setOpenMenu(openMenu === "recent" ? null : "recent")}
							>
								<IconMore className="h-3.5 w-3.5" />
							</button>
							<button type="button" className={actionBtn} title="新建聊天" onClick={onNewChat}>
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
							<MenuRow
								label="按名称"
								checked={recentSort === "name"}
								onClick={() => switchRecentSort("name")}
							/>
						</>
					}
				>
					{recentSessions.map((row, index) => sessionRow(row, index, false))}
					{recentSessions.length === 0 && (
						<p className="px-2 py-2 text-xs text-owl-faint/70">
							{search ? "无匹配会话" : "暂无会话"}
						</p>
					)}
				</Section>

				{archivedSessions.length > 0 && (
					<Section
						id="archived"
						label="归档"
						open={isOpen("archived")}
						onToggle={() => toggleSection("archived")}
					>
						{archivedSessions.filter(sessionMatches).map((row, index) => sessionRow(row, index, false, true))}
					</Section>
				)}

				{noMatch && <p className="px-3 py-3 text-xs text-owl-faint/70">无匹配结果</p>}
			</div>

			{showNewProject && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog">
					<div className="w-96 rounded-xl border border-owl-border bg-owl-panel p-4 shadow-2xl shadow-black/40">
						<h2 className="mb-1 text-sm font-semibold text-owl-text">新建项目</h2>
						<p className="mb-3 text-xs text-owl-muted">
							选择或输入项目目录（不存在会自动创建）：
						</p>
						<div className="flex gap-2">
							<input
								type="text"
								className="min-w-0 flex-1 rounded-lg border border-owl-border bg-owl-sidebar px-3 py-2 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
								placeholder="D:\mycode\new-project"
								value={newPath}
								autoFocus
								disabled={creating}
								onChange={(event) => setNewPath(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") void submitNewProject();
									if (event.key === "Escape") setShowNewProject(false);
								}}
							/>
							{hasTauri() && (
								<button
									type="button"
									className="shrink-0 rounded-lg border border-owl-border px-3 py-2 text-xs text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text disabled:opacity-50"
									title="打开系统资源管理器选择文件夹"
									onClick={() => void browseProject()}
									disabled={browsing || creating}
								>
									{browsing ? "打开中…" : "浏览…"}
								</button>
							)}
						</div>
						{createError && <p className="mt-2 text-xs text-red-400">{createError}</p>}
						<div className="mt-4 flex justify-end gap-2">
							<button
								type="button"
								className="rounded-lg border border-owl-border px-3 py-1.5 text-xs text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
								onClick={() => setShowNewProject(false)}
								disabled={creating}
							>
								取消
							</button>
							<button
								type="button"
								className="rounded-lg bg-owl-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-owl-accent-hover disabled:opacity-50"
								onClick={() => void submitNewProject()}
								disabled={creating || !newPath.trim()}
							>
								{creating ? "创建中…" : "创建并切换"}
							</button>
						</div>
					</div>
				</div>
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
