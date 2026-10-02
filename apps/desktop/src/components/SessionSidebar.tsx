import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ProjectCreateResult } from "../bridge/protocol.ts";

type SessionRow = { id?: string; name?: string; cwd?: string; timestamp?: string; [key: string]: unknown };

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

export function SessionSidebar({
	client,
	activeId,
	activeProject,
	refreshKey,
	onNewChat,
	onSelectProject,
	onOpenSession,
}: {
	client: BridgeClient;
	activeId: string | undefined;
	/** 当前项目（工作目录）绝对路径。 */
	activeProject: string;
	/** 变化时重新拉取会话列表（如新会话创建后）。 */
	refreshKey: string;
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

	const refresh = async (): Promise<void> => {
		const response = await client.request<SessionRow[]>({ type: "session.list" });
		if (response.ok) setSessions(response.result ?? []);
	};
	useEffect(() => {
		if (client) void refresh();
	}, [client, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

	// 有会话记录的项目（去重，按最近会话时间排序）；当前项目即使还没有会话也保持在列表里。
	const projects = useMemo(() => {
		const byCwd = new Map<string, { cwd: string; latest: string }>();
		for (const row of sessions) {
			if (!row.cwd) continue;
			const existing = byCwd.get(row.cwd.toLowerCase());
			const ts = String(row.timestamp ?? "");
			if (!existing || ts > existing.latest) byCwd.set(row.cwd.toLowerCase(), { cwd: row.cwd, latest: ts });
		}
		const list = [...byCwd.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1)).map((p) => p.cwd);
		if (!list.some((cwd) => samePath(cwd, activeProject))) list.unshift(activeProject);
		return list;
	}, [sessions, activeProject]);

	const projectSessions = useMemo(
		() => sessions.filter((row) => samePath(row.cwd, activeProject)),
		[sessions, activeProject],
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

	return (
		<aside className="flex w-64 flex-col border-r border-owl-border bg-owl-sidebar">
			<div
				className="flex select-none items-center gap-2 px-4 pb-1 pt-4"
				data-tauri-drag-region="deep"
			>
				<img src="/owl.svg" alt="owl" className="h-7 w-7" />
				<span className="font-serif text-base tracking-wide text-owl-text">owl</span>
			</div>

			<div className="px-3 pt-3">
				<button
					type="button"
					className="w-full rounded-lg bg-owl-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-owl-accent-hover"
					onClick={onNewChat}
				>
					＋ 新会话
				</button>
				<button
					type="button"
					className="mt-2 w-full rounded-lg border border-owl-border px-3 py-2 text-sm text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
					onClick={() => {
						setShowNewProject(true);
						setCreateError("");
					}}
				>
					＋ 新建项目
				</button>
			</div>

			<div className="mt-4 flex items-center justify-between px-4 pb-1">
				<p className="text-xs text-owl-faint">项目</p>
				<span className="max-w-32 truncate text-[10px] text-owl-faint/70" title={activeProject}>
					{projectLabel(activeProject)}
				</span>
			</div>
			<div className="max-h-44 overflow-y-auto px-2">
				{projects.map((cwd) => (
					<button
						key={cwd}
						type="button"
						className={`w-full truncate rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
							samePath(cwd, activeProject)
								? "bg-owl-hover text-owl-text"
								: "text-owl-muted hover:bg-owl-hover/60 hover:text-owl-text"
						}`}
						title={cwd}
						onClick={() => onSelectProject(cwd)}
					>
						📁 {projectLabel(cwd)}
					</button>
				))}
			</div>

			<div className="mt-3 px-4 pb-1">
				<p className="text-xs text-owl-faint">会话（当前项目）</p>
			</div>
			<div className="flex-1 overflow-y-auto px-2 pb-3">
				{projectSessions.map((session, index) => (
					<button
						key={session.id ?? index}
						type="button"
						className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
							session.id === activeId
								? "bg-owl-hover text-owl-text"
								: "text-owl-muted hover:bg-owl-hover/60 hover:text-owl-text"
						}`}
						title={String(session.cwd ?? "")}
						onClick={() => session.id && onOpenSession(session.id)}
					>
						<div className="truncate">{session.id ?? `session-${index}`}</div>
						<div className="truncate text-owl-faint">{String(session.timestamp ?? "").slice(0, 19)}</div>
					</button>
				))}
				{projectSessions.length === 0 && <p className="px-2 py-2 text-xs text-owl-faint/70">暂无</p>}
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
