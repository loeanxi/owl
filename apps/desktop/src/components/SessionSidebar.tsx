import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ProjectCreateResult } from "../bridge/protocol.ts";
import { IconChat, IconChevron, IconFolder, IconPin, IconSearch } from "./icons.tsx";
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
	[key: string]: unknown;
};

const PINNED_KEY = "owl.pinnedSessions";
const COLLAPSED_KEY = "owl.sidebar.collapsed";
/** 「最近」分组最多展示的会话数，避免长列表把项目挤出视口。 */
const RECENT_LIMIT = 30;

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

/** 可折叠分组：头部（箭头 + 标题 + 数量）+ 展开内容。 */
function Section({
	id,
	label,
	count,
	open,
	onToggle,
	children,
	headerRef,
}: {
	id: string;
	label: string;
	count?: number;
	open: boolean;
	onToggle: () => void;
	children: React.ReactNode;
	headerRef?: React.Ref<HTMLDivElement>;
}): React.JSX.Element {
	return (
		<div id={id} data-section={id} className="mt-3 first:mt-0">
			<div ref={headerRef}>
				<button
					type="button"
					className="flex w-full items-center gap-1 rounded-md px-3 py-1 text-left transition-colors hover:bg-owl-hover/40"
					onClick={onToggle}
					aria-expanded={open}
				>
					<IconChevron
						className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${open ? "rotate-90" : ""}`}
					/>
					<span className="text-xs font-medium text-owl-muted">{label}</span>
					{typeof count === "number" && count > 0 && (
						<span className="ml-auto pr-1 text-[10px] tabular-nums text-owl-faint/80">{count}</span>
					)}
				</button>
			</div>
			{open && <div className="mt-0.5 px-2">{children}</div>}
		</div>
	);
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
	const [pinned, setPinned] = useState<string[]>(loadPinned);
	const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const projectHeaderRef = useRef<HTMLDivElement>(null);
	const recentHeaderRef = useRef<HTMLDivElement>(null);

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
	useEffect(() => {
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

	const search = query.trim().toLowerCase();

	// 有会话记录的项目（去重，按最近活动排序）；当前项目即使还没有会话也保持在列表里。
	const projects = useMemo(() => {
		const byCwd = new Map<string, { cwd: string; latest: string }>();
		for (const row of sessions) {
			if (!row.cwd) continue;
			const existing = byCwd.get(row.cwd.toLowerCase());
			const ts = sessionTime(row);
			if (!existing || ts > existing.latest) byCwd.set(row.cwd.toLowerCase(), { cwd: row.cwd, latest: ts });
		}
		const list = [...byCwd.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1)).map((p) => p.cwd);
		if (!list.some((cwd) => samePath(cwd, activeProject))) list.unshift(activeProject);
		return list;
	}, [sessions, activeProject]);

	const visibleProjects = useMemo(
		() =>
			search
				? projects.filter(
						(cwd) =>
							projectLabel(cwd).toLowerCase().includes(search) || cwd.toLowerCase().includes(search),
					)
				: projects,
		[projects, search],
	);

	// 会话行：标题/项目名匹配搜索词。列表本身已按 modified 降序。
	const sessionMatches = (row: SessionRow): boolean =>
		!search ||
		sessionTitle(row).toLowerCase().includes(search) ||
		(row.cwd ?? "").toLowerCase().includes(search);

	const pinnedSessions = useMemo(
		() =>
			sessions
				.filter((row) => row.id !== undefined && pinned.includes(row.id))
				.sort((a, b) => (sessionTime(a) < sessionTime(b) ? 1 : -1)),
		[sessions, pinned],
	);

	const recentSessions = useMemo(
		() => sessions.filter(sessionMatches).slice(0, RECENT_LIMIT),
		[sessions, search], // eslint-disable-line react-hooks/exhaustive-deps
	);

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

	/** 会话行：图标 + 标题 + 次行（时间 · 项目），悬停露出置顶按钮。 */
	const sessionRow = (row: SessionRow, index: number, pinnedRow: boolean): React.JSX.Element => {
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
						<span className="shrink-0">{relativeTime(sessionTime(row))}</span>
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
					<button
						type="button"
						className={`shrink-0 rounded p-1 transition-colors hover:bg-owl-border/60 ${
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
			</div>
		);
	};

	const noMatch =
		search !== "" &&
		visibleProjects.length === 0 &&
		recentSessions.length === 0 &&
		pinnedSessions.filter(sessionMatches).length === 0;

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
						count={pinnedSessions.length}
						open={isOpen("pinned")}
						onToggle={() => toggleSection("pinned")}
					>
						{pinnedSessions.filter(sessionMatches).map((row, index) => sessionRow(row, index, true))}
					</Section>
				)}

				<Section
					id="projects"
					label="项目"
					count={visibleProjects.length}
					open={isOpen("projects")}
					onToggle={() => toggleSection("projects")}
					headerRef={projectHeaderRef}
				>
					{visibleProjects.map((cwd) => (
						<button
							key={cwd}
							type="button"
							className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
								samePath(cwd, activeProject)
									? "bg-owl-hover text-owl-text"
									: "text-owl-muted hover:bg-owl-hover/60 hover:text-owl-text"
							}`}
							title={cwd}
							onClick={() => onSelectProject(cwd)}
						>
							<IconFolder className="h-3.5 w-3.5 shrink-0 text-owl-faint/70" />
							<span className="truncate">{projectLabel(cwd)}</span>
							{samePath(cwd, activeProject) && (
								<span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-owl-accent" title="当前项目" />
							)}
						</button>
					))}
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
					count={recentSessions.length}
					open={isOpen("recent")}
					onToggle={() => toggleSection("recent")}
					headerRef={recentHeaderRef}
				>
					{recentSessions.map((row, index) => sessionRow(row, index, false))}
					{recentSessions.length === 0 && (
						<p className="px-2 py-2 text-xs text-owl-faint/70">
							{search ? "无匹配会话" : "暂无会话"}
						</p>
					)}
				</Section>

				{noMatch && <p className="px-3 py-3 text-xs text-owl-faint/70">无匹配结果</p>}
			</div>

			{showNewProject && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog">
					<div className="w-96 rounded-xl border border-owl-border bg-owl-panel p-4 shadow-2xl shadow-black/40">
						<h2 className="mb-1 text-sm font-semibold text-owl-text">新建项目</h2>
						<p className="mb-3 text-xs text-owl-muted">
							输入项目目录的绝对路径（不存在会自动创建）：
						</p>
						<input
							type="text"
							className="w-full rounded-lg border border-owl-border bg-owl-sidebar px-3 py-2 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
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
		</aside>
	);
}
