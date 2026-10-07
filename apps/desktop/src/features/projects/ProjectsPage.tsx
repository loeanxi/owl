import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import { isReservedDir, normPath, samePath } from "../../utils/paths.ts";
import {
	getProjectDisplayName as projectLabel,
	getProjectSidebarPreferences,
	hideProject,
	isSessionUnread,
	markSessionsRead,
	moveProjectToSection,
	saveProjectSidebarPreferences,
	useProjectSidebarRevision,
	type ProjectSidebarPreferences,
} from "../../project-sidebar-model.ts";
import { loadSidebarStrings, matchesSessionScope } from "../../components/sidebar-scope.ts";
import { getUiLanguage, t, useT } from "../../i18n/index.ts";
import { islandSessionTitle } from "../../components/dynamic-island-model.ts";
import { NewProjectDialog } from "../../components/NewProjectDialog.tsx";
import { ProjectActionsMenu } from "../../components/ProjectActionsMenu.tsx";
import { ProjectSidebarDialog } from "../../components/ProjectSidebarDialog.tsx";
import { useProjectSidebarText } from "../../components/project-sidebar-copy.ts";
import { IconChevron, IconCompose, IconFolder, IconMore, IconPin, IconPlus, IconSearch } from "../../components/icons.tsx";

/**
 * 「项目」页（rail 一等视图，Codex 式一览表）：
 * 全部项目按最近更新排成两列表格（名称 / 已更新），行悬停露出置顶 / 新会话 / ⋯ 菜单，
 * 点击行内展开该项目的会话列表，点会话即回到对话视图续聊。
 * 数据与侧边栏同源（session.list + localStorage 项目偏好），置顶 / 隐藏 / 别名互相可见。
 */
type SessionRow = {
	id?: string;
	name?: string;
	cwd?: string;
	modified?: string;
	timestamp?: string;
	created?: string;
	firstMessage?: string;
	parentSessionPath?: string;
	archivedAt?: string;
	scope?: unknown;
	[key: string]: unknown;
};

type ProjectSort = "recent" | "oldest" | "name";

/** 排序偏好（localStorage）；键值独立于侧栏，仅本页使用。 */
const SORT_KEY = "owl.projectsPage.sort";
/** 与侧栏共用的项目偏好键（sidebarStorageKeys("chat") 的值，这里字面量固定避免循环依赖）。 */
const PINNED_PROJECTS_KEY = "owl.pinnedProjects";
const KNOWN_PROJECTS_KEY = "owl.projects";

function loadSort(): ProjectSort {
	try {
		const value = localStorage.getItem(SORT_KEY);
		return value === "oldest" || value === "name" ? value : "recent";
	} catch {
		return "recent";
	}
}

function sessionTime(row: SessionRow): string {
	return String(row.modified ?? row.timestamp ?? row.created ?? "");
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / n 天前 / MM-DD（与侧栏同一套文案）。 */
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

function sessionTitle(row: SessionRow): string {
	return islandSessionTitle(row, {
		unnamed: t("sidebar.sessionUnnamed"),
		branch: t("app.branchSuffix"),
		fallback: t("sidebar.sessionFallback", { id: row.id?.slice(0, 8) ?? "" }),
	});
}

type ProjectAgg = { path: string; rows: SessionRow[]; latest: string };

export function ProjectsPage({
	client,
	connected,
	active,
	runningSessions,
	revision,
	activeProject,
	onOpenSession,
	onNewChatInProject,
	onCreateProject,
}: {
	client: BridgeClient;
	/** 桥连接状态：未连接时不拉列表，连上后自动重试。 */
	connected: boolean;
	/** 页面是否可见；重新可见时重拉一次（离开期间的新会话/归档能出现）。 */
	active: boolean;
	/** agent run 活跃的会话 id 集合：展开区里的绿点依据。 */
	runningSessions: ReadonlySet<string>;
	/** 递增时重拉（App 的 sidebarRev：新会话落盘、设置页变更等）。 */
	revision: number;
	/** 当前项目（工作目录）；保留目录只在作为当前项目时出现在列表。 */
	activeProject: string;
	/** 点击会话：回到对话视图并恢复该会话。 */
	onOpenSession: (sessionId: string) => void;
	/** 项目行「新会话」：切到该项目并开新会话。 */
	onNewChatInProject: (path: string) => void;
	/** 「创建」按钮：App 侧弹 NewProjectDialog（创建后留在本页）。 */
	onCreateProject: () => void;
}): React.JSX.Element {
	const t = useT();
	const pt = useProjectSidebarText();
	const prefsRevision = useProjectSidebarRevision();
	const preferences = useMemo(() => getProjectSidebarPreferences("chat"), [prefsRevision]);
	const [allRows, setAllRows] = useState<SessionRow[]>([]);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<ProjectSort>(loadSort);
	/** 手动展开的项目（normalized path）；搜索时全部按展开处理。 */
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const [pinnedProjects, setPinnedProjects] = useState<string[]>(() => loadSidebarStrings(localStorage, PINNED_PROJECTS_KEY));
	const [knownProjects, setKnownProjects] = useState<string[]>(() => loadSidebarStrings(localStorage, KNOWN_PROJECTS_KEY));
	/** ⋯ 菜单目标（ProjectActionsMenu 需要锚点按钮定位）。 */
	const [menu, setMenu] = useState<{ path: string; anchor: HTMLButtonElement } | null>(null);
	const menuId = useId();
	const [editing, setEditing] = useState<string | null>(null);
	const [sectionDialog, setSectionDialog] = useState<{ id?: string; path?: string } | null>(null);
	const [sectionError, setSectionError] = useState("");
	const [confirm, setConfirm] = useState<{ type: "archive" | "remove"; path: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [notice, setNotice] = useState("");

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const response = await client.request<SessionRow[]>({ type: "session.list" });
			if (response.ok) setAllRows(response.result ?? []);
		} catch {
			// 桥断开/重连瞬间静默跳过：connected / revision / active 变化会重试
		}
	}, [client]);
	useEffect(() => {
		if (connected) void refresh();
	}, [connected, refresh, revision, active]);

	// 置顶 / 已知项目与侧栏共用同一份 localStorage：侧栏或本页任一侧变更都会
	// publish（model 的 CHANGE_EVENT），这里随之重读保持双向同步。
	useEffect(() => {
		setPinnedProjects(loadSidebarStrings(localStorage, PINNED_PROJECTS_KEY));
		setKnownProjects(loadSidebarStrings(localStorage, KNOWN_PROJECTS_KEY));
	}, [prefsRevision, revision]);

	// 本页固为 chat 作用域：研究会话有自己的侧栏与归档管理，不进这张表。
	const sessions = useMemo(
		() => allRows.filter((row) => matchesSessionScope(row, "chat") && typeof row.archivedAt !== "string"),
		[allRows],
	);

	// 项目 = 当前项目 ∪ 有会话的项目 ∪ 到访过的项目；保留目录（默认目录/助理目录）一律不进项目列表。
	const projects = useMemo<ProjectAgg[]>(() => {
		const map = new Map<string, ProjectAgg>();
		const track = (path: string | undefined, row?: SessionRow): void => {
			if (!path || isReservedDir(path)) return;
			const key = normPath(path);
			let agg = map.get(key);
			if (!agg) {
				agg = { path, rows: [], latest: "" };
				map.set(key, agg);
			}
			if (row) {
				agg.rows.push(row);
				const time = sessionTime(row);
				if (time > agg.latest) agg.latest = time;
			}
		};
		track(activeProject || undefined);
		for (const row of sessions) track(row.cwd, row);
		for (const path of knownProjects) track(path);
		return [...map.values()];
	}, [sessions, activeProject, knownProjects]);

	const search = query.trim().toLowerCase();
	const isPinned = useCallback(
		(path: string) => pinnedProjects.some((entry) => samePath(entry, path)),
		[pinnedProjects],
	);
	const titleMatches = (row: SessionRow): boolean =>
		sessionTitle(row).toLowerCase().includes(search) || (row.cwd ?? "").toLowerCase().includes(search);

	/** 排序：置顶（按置顶先后）永远在前，其余按 最近更新 / 最早创建 / 名称。 */
	const sortedProjects = useMemo(() => {
		const visible = projects.filter((agg) => {
			if (preferences.hidden.includes(normPath(agg.path))) return false;
			if (!search) return true;
			return projectLabel(agg.path).toLowerCase().includes(search)
				|| agg.path.toLowerCase().includes(search)
				|| agg.rows.some(titleMatches);
		});
		const byLatest = (a: ProjectAgg, b: ProjectAgg): number => (a.latest !== b.latest ? (a.latest > b.latest ? -1 : 1) : 0);
		const sorted = [...visible].sort((a, b) => {
			const pa = pinnedProjects.findIndex((p) => samePath(p, a.path));
			const pb = pinnedProjects.findIndex((p) => samePath(p, b.path));
			if (pa !== -1 || pb !== -1) {
				if (pa === -1) return 1;
				if (pb === -1) return -1;
				return pa - pb;
			}
			if (sort === "name") return projectLabel(a.path).localeCompare(projectLabel(b.path), getUiLanguage());
			if (sort === "oldest") return byLatest(b, a);
			return byLatest(a, b);
		});
		return sorted;
	}, [projects, preferences, search, sort, pinnedProjects]); // eslint-disable-line react-hooks/exhaustive-deps

	const toggleExpand = (path: string): void => {
		const key = normPath(path);
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const togglePin = (path: string): void => {
		setPinnedProjects((current) => {
			const key = normPath(path);
			const next = current.some((p) => samePath(p, path))
				? current.filter((p) => !samePath(p, path))
				: [...current, path];
			try {
				localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(next));
			} catch {
				// localStorage 不可用时置顶退化为本次会话内存态
			}
			return next;
		});
	};

	const revealProject = async (path: string): Promise<void> => {
		try {
			await client.request({ type: "open.external", action: "reveal", target: ".", cwd: path });
		} catch {
			// 桥未连接等瞬时失败：静默跳过
		}
	};

	/** 确认弹窗动作：remove = 从列表隐藏（侧栏同步）；archive = 归档该项目已结束的会话。 */
	const runConfirm = async (target: { type: "archive" | "remove"; path: string }): Promise<void> => {
		if (busyRef.current) return;
		if (target.type === "remove") {
			saveProjectSidebarPreferences("chat", hideProject(preferences, target.path));
			setPinnedProjects((current) => {
				const next = current.filter((p) => !samePath(p, target.path));
				try {
					localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(next));
				} catch { /* 同上：存储不可用退化为内存态 */ }
				return next;
			});
			setKnownProjects((current) => {
				const next = current.filter((p) => !samePath(p, target.path));
				try {
					localStorage.setItem(KNOWN_PROJECTS_KEY, JSON.stringify(next));
				} catch { /* 同上 */ }
				return next;
			});
			setConfirm(null);
			return;
		}
		const targets = sessions.filter((row) => row.id && samePath(row.cwd, target.path));
		let done = 0;
		let failed = 0;
		let kept = 0;
		busyRef.current = true;
		setBusy(true);
		try {
			for (const row of targets) {
				if (row.id && runningSessions.has(row.id)) {
					kept++;
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
			setNotice(pt("archiveResult").replace("{done}", String(done)).replace("{failed}", String(failed)).replace("{running}", String(kept)));
			setConfirm(null);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const expandedRows = (agg: ProjectAgg): SessionRow[] => {
		const rows = search ? agg.rows.filter(titleMatches) : agg.rows;
		return [...rows].sort((a, b) => sessionTime(b).localeCompare(sessionTime(a)));
	};
	const isExpanded = (agg: ProjectAgg): boolean => search !== "" || expanded.has(normPath(agg.path));

	const switchSort = (next: ProjectSort): void => {
		setSort(next);
		try {
			localStorage.setItem(SORT_KEY, next);
		} catch {
			// localStorage 不可用时排序偏好退化为会话内状态
		}
	};

	const gridCols = "grid grid-cols-[minmax(0,1fr)_72px_110px_96px] items-center gap-2";
	const projectRow = (agg: ProjectAgg): React.JSX.Element => {
		const key = normPath(agg.path);
		const name = projectLabel(agg.path);
		const open = isExpanded(agg);
		const pinned = isPinned(agg.path);
		const isCurrent = samePath(agg.path, activeProject);
		const rows = open ? expandedRows(agg) : [];
		return (
			<div key={key} data-project-path={key}>
				<div className={`${gridCols} group h-[52px] border-b border-owl-border/70 px-3 transition-colors hover:bg-owl-hover/40`}>
					<button
						type="button"
						className="flex min-w-0 items-center gap-2.5 text-left"
						aria-expanded={open}
						aria-label={t(open ? "projects.collapseAria" : "projects.expandAria", { name })}
						onClick={() => toggleExpand(agg.path)}
					>
						<IconChevron className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${open ? "rotate-90" : ""}`} />
						<IconFolder className="h-4 w-4 shrink-0 text-owl-faint" />
						<span className="truncate text-[13px] font-medium text-owl-text">{name}</span>
						{isCurrent && <span className="shrink-0 rounded border border-owl-border px-1.5 py-px text-[9.5px] text-owl-faint">{t("projects.current")}</span>}
						{pinned && <IconPin filled className="h-3.5 w-3.5 shrink-0 text-owl-accent" />}
					</button>
					<span className="text-right text-xs text-owl-muted">{agg.rows.length}</span>
					<span className="text-right text-xs text-owl-muted">{agg.latest ? relativeTime(agg.latest) : "—"}</span>
					<div className="flex items-center justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
						<button
							type="button"
							className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text"
							title={t("projects.projectActions")}
							aria-label={t("projects.projectActions")}
							aria-haspopup="menu"
							aria-expanded={menu?.path === agg.path}
							onClick={(event) => setMenu(menu?.path === agg.path ? null : { path: agg.path, anchor: event.currentTarget })}
						>
							<IconMore className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							className={`rounded-md p-1.5 hover:bg-owl-hover ${pinned ? "text-owl-accent" : "text-owl-muted hover:text-owl-text"}`}
							title={pt(pinned ? "unpin" : "pin")}
							aria-label={pt(pinned ? "unpin" : "pin")}
							onClick={() => togglePin(agg.path)}
						>
							<IconPin filled={pinned} className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text"
							title={t("projects.newChat")}
							aria-label={t("projects.newChat")}
							onClick={() => onNewChatInProject(agg.path)}
						>
							<IconCompose className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				{open && (
					<div className="border-b border-owl-border/70 bg-owl-bubble/40 px-3 py-2">
						<div className="flex items-center gap-3 pb-1 pl-8 pr-1">
							<span className="truncate font-mono text-[10.5px] text-owl-faint" title={agg.path}>{agg.path}</span>
							<button
								type="button"
								className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-owl-accent hover:bg-owl-hover"
								onClick={() => onNewChatInProject(agg.path)}
							>
								<IconPlus className="h-3 w-3" />
								{t("projects.newChat")}
							</button>
						</div>
						{rows.map((row) => {
							const id = row.id;
							const isRunning = id !== undefined && runningSessions.has(id);
							const unread = isSessionUnread(preferences, row);
							return (
								<button
									key={id ?? sessionTime(row) + sessionTitle(row)}
									type="button"
									className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 pl-8 text-left hover:bg-owl-hover/60"
									onClick={() => {
										if (!id) return;
										markSessionsRead("chat", [row]);
										onOpenSession(id);
									}}
								>
									<span
										className={`h-1.5 w-1.5 shrink-0 rounded-full ${isRunning ? "bg-emerald-500" : unread ? "bg-owl-accent" : "bg-owl-faint/50"}`}
										title={isRunning ? t("sidebar.runningTip") : undefined}
									/>
									<span className="truncate text-xs text-owl-text">{sessionTitle(row)}</span>
									<span className="ml-auto shrink-0 text-[10.5px] text-owl-faint">{relativeTime(sessionTime(row))}</span>
								</button>
							);
						})}
						{rows.length === 0 && <p className="py-1.5 pl-8 text-xs text-owl-faint">{search ? t("projects.noMatch") : t("projects.noSessions")}</p>}
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex items-end gap-3 px-7 pb-4 pt-7">
				<div>
					<h1 className="text-xl font-semibold tracking-tight text-owl-text">{t("projects.title")}</h1>
					<p className="mt-0.5 text-[11.5px] text-owl-faint">{t("projects.count", { n: sortedProjects.length })}</p>
				</div>
				<div className="ml-auto flex items-center gap-2.5">
					<label className="flex h-8 w-56 items-center gap-2 rounded-full border border-owl-border bg-owl-panel px-3">
						<IconSearch className="h-3.5 w-3.5 shrink-0 text-owl-faint" />
						<input
							type="text"
							className="w-full bg-transparent text-xs text-owl-text outline-none placeholder:text-owl-faint"
							placeholder={t("projects.search")}
							aria-label={t("projects.search")}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") setQuery("");
							}}
						/>
						{query && (
							<button type="button" className="shrink-0 text-owl-faint hover:text-owl-text" aria-label={t("sidebar.clearSearch")} onClick={() => setQuery("")}>
								<span aria-hidden="true">×</span>
							</button>
						)}
					</label>
					<button
						type="button"
						className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-owl-text px-3.5 text-xs font-medium text-owl-bg transition-opacity hover:opacity-90"
						onClick={onCreateProject}
					>
						<IconPlus className="h-3.5 w-3.5" />
						{t("projects.create")}
					</button>
				</div>
			</header>

			<div className={`${gridCols} border-b border-owl-border px-3 pb-2 text-[11px] text-owl-faint mx-7`} role="row">
				<button
					type="button"
					className={`justify-self-start rounded px-1 py-0.5 hover:text-owl-text ${sort === "name" ? "text-owl-text" : ""}`}
					title={pt("name")}
					onClick={() => switchSort("name")}
				>
					{t("projects.colName")}
					{sort === "name" ? " ↓" : ""}
				</button>
				<span className="text-right">{t("projects.colSessions")}</span>
				<button
					type="button"
					className="flex items-center justify-end gap-0.5 rounded px-1 py-0.5 hover:text-owl-text justify-self-end"
					title={sort === "oldest" ? pt("recent") : pt("oldest")}
					onClick={() => switchSort(sort === "oldest" ? "recent" : "oldest")}
				>
					{t("projects.colUpdated")}
					{sort !== "name" ? (sort === "oldest" ? " ↑" : " ↓") : ""}
				</button>
				<span />
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-7 pb-10 pt-1">
				{sortedProjects.length > 0 && sortedProjects.map(projectRow)}
				{sortedProjects.length === 0 && search !== "" && (
					<p className="py-10 text-center text-xs text-owl-faint">{t("projects.noMatch")}</p>
				)}
				{sortedProjects.length === 0 && search === "" && (
					<div className="flex flex-col items-center gap-3 py-20 text-center">
						<IconFolder className="h-8 w-8 text-owl-faint/60" />
						<p className="text-sm font-medium text-owl-text">{t("projects.emptyTitle")}</p>
						<p className="max-w-xs text-xs text-owl-faint">{t("projects.emptyHint")}</p>
						<button
							type="button"
							className="flex h-8 items-center gap-1.5 rounded-full bg-owl-text px-3.5 text-xs font-medium text-owl-bg transition-opacity hover:opacity-90"
							onClick={onCreateProject}
						>
							<IconPlus className="h-3.5 w-3.5" />
							{t("projects.createFirst")}
						</button>
					</div>
				)}
				{notice && <p className="px-3 pt-3 text-xs text-owl-faint" role="status">{notice}</p>}
			</div>

			{menu !== null && (
				<ProjectActionsMenu
					anchor={menu.anchor}
					menuId={menuId}
					label={t("projects.projectActions")}
					pinned={isPinned(menu.path)}
					sections={preferences.sections}
					sectionId={preferences.assignments[normPath(menu.path)] ?? null}
					onClose={() => setMenu(null)}
					onPin={() => togglePin(menu.path)}
					onEdit={() => setEditing(menu.path)}
					onSection={(id) => saveProjectSidebarPreferences("chat", moveProjectToSection(preferences, menu.path, id))}
					onNewSection={() => {
						setSectionError("");
						setSectionDialog({ path: menu.path });
					}}
					onReveal={() => void revealProject(menu.path)}
					onMarkRead={() => {
						markSessionsRead("chat", sessions.filter((row) => samePath(row.cwd, menu.path)));
						setNotice(pt("allRead"));
					}}
					onArchive={() => setConfirm({ type: "archive", path: menu.path })}
					onRemove={() => setConfirm({ type: "remove", path: menu.path })}
				/>
			)}
			{editing !== null && (
				<NewProjectDialog
					client={client}
					initialProject={{ path: editing, name: projectLabel(editing) }}
					onClose={() => setEditing(null)}
					onCreated={() => setEditing(null)}
				/>
			)}
			{sectionDialog !== null && (
				<ProjectSidebarDialog
					key={sectionDialog.id ?? `new:${sectionDialog.path}`}
					title={pt(sectionDialog.id ? "renameSection" : "createSection")}
					fieldLabel={pt("sectionName")}
					initialValue={preferences.sections.find((section) => section.id === sectionDialog.id)?.name ?? ""}
					error={sectionError}
					confirmLabel={pt("save")}
					onClose={() => setSectionDialog(null)}
					onSubmit={(name) => {
						if (preferences.sections.some((section) => section.id !== sectionDialog.id && section.name.toLowerCase() === name.toLowerCase())) {
							setSectionError(pt("sectionDuplicate"));
							return;
						}
						const id = sectionDialog.id ?? crypto.randomUUID();
						let next: ProjectSidebarPreferences = {
							...preferences,
							sections: sectionDialog.id
								? preferences.sections.map((section) => (section.id === sectionDialog.id ? { ...section, name } : section))
								: [...preferences.sections, { id, name }],
						};
						if (sectionDialog.path) next = moveProjectToSection(next, sectionDialog.path, id);
						saveProjectSidebarPreferences("chat", next);
						setSectionDialog(null);
					}}
				/>
			)}
			{confirm !== null && (
				<ProjectSidebarDialog
					title={pt(confirm.type === "archive" ? "archiveTitle" : "removeTitle")}
					description={`${projectLabel(confirm.path)}\n${pt(confirm.type === "archive" ? "archiveHint" : "removeHint")}`}
					busy={busy}
					confirmLabel={pt("confirm")}
					onClose={() => {
						if (!busyRef.current) setConfirm(null);
					}}
					onSubmit={() => void runConfirm(confirm)}
				/>
			)}
		</div>
	);
}
