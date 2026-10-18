/**
 * 文件变动 tab：Git 视角（暂存 / 提交 / 丢弃）+ 统一 diff 查看。
 *
 * 移植自 dsh-better-sidebar ChangesTab 的 Git 视角子集：porcelain 状态分组、
 * 行级 stage/unstage/discard、吸底提交条（Ctrl+Enter）；点击文件在下半面板
 * 看 diff（parseUnifiedDiff + annotateCharDiff 字符级高亮，VS Code 同款视觉）。
 * "本轮 AI 改动"视角（会话事件折叠）依赖 owl 会话事件索引，后续接入。
 * 头部「变动 / 历史」切换到提交历史视图（HistoryView）。
 */
import { useContext, useEffect, useRef, useState } from "react";
import { t, useT } from "../../i18n/index.ts";
import type { GitStatusEntry } from "../../bridge/protocol.ts";
import type { TabComponentProps } from "../registry.ts";
import { DiffReview } from "../DiffReview.tsx";
import { ExecutionContext } from "../execution-context.tsx";
import { IconGitBranch, IconLoader, IconRefresh, IconTrash, IconUndo } from "../icons.tsx";
import { HistoryView, repoDisplayName } from "./HistoryView.tsx";

const MODE_KEY = "owl.changes.mode";
type ChangesMode = "changes" | "history";

/** porcelain 字母 → 行色。 */
function statusColor(entry: GitStatusEntry): string {
	const letter = entry.x !== " " && entry.x !== "?" ? entry.x : entry.y;
	if (entry.y === "?") return "text-emerald-300/80";
	if (letter === "A") return "text-emerald-300";
	if (letter === "D") return "text-red-400";
	if (letter === "R" || letter === "C") return "text-sky-300";
	return "text-amber-300";
}

/** 条目所属仓库：前缀匹配最深的仓库根；workspace 根自身是仓库时记作 "."，兜底其余条目。 */
export function repoOfPath(path: string, roots: readonly string[]): string | undefined {
	let owner = roots.includes(".") ? "." : undefined;
	for (const root of roots) {
		if (root === "." || (path !== root && !path.startsWith(`${root}/`))) continue;
		if (owner === undefined || owner === "." || root.length > owner.length) owner = root;
	}
	return owner;
}
function statusLetter(entry: GitStatusEntry): string {
	if (entry.y === "?") return "U";
	const letter = entry.x !== " " && entry.x !== "?" ? entry.x : entry.y;
	return letter === " " ? "M" : letter;
}

export function ChangesTab({ api, cwd, profile, gitStatus, onGitRefresh, onToChat, onOpenFile }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const execution = useContext(ExecutionContext);
	const [mode, setMode] = useState<ChangesMode>(() => (localStorage.getItem(MODE_KEY) === "history" ? "history" : "changes"));
	const [selected, setSelected] = useState<{ path: string; staged: boolean } | undefined>(undefined);
	const [diff, setDiff] = useState<string | undefined>(undefined);
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState<string | undefined>(undefined);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [expandedDiff, setExpandedDiff] = useState(false);
	// 仓库筛选器："" = 全部仓库；非空 = 所选仓库的 workspace 相对根
	const [repoFilter, setRepoFilter] = useState<string>("");
	// diff 请求序号：慢响应晚到时不得覆盖后点的文件（FilesTab searchSeq 同款守卫）
	const diffSeq = useRef(0);
	useEffect(() => {
		diffSeq.current += 1;
		setSelected(undefined);
		setDiff(undefined);
		setDiffLoading(false);
		setDiffError(undefined);
	}, [cwd, profile]);

	const repos = gitStatus?.repos ?? [];
	const multiRepo = repos.length > 1;
	const selectedRepo = multiRepo ? repos.find((repo) => repo.root === repoFilter) : undefined;
	const repoRoots = repos.map((repo) => repo.root);
	const entries = (gitStatus?.entries ?? []).filter(
		(entry) => !multiRepo || repoFilter === "" || repoOfPath(entry.path, repoRoots) === repoFilter,
	);
	const branchLabel = multiRepo ? selectedRepo?.branch : gitStatus?.branch;
	const upstreamLabel = multiRepo ? selectedRepo?.upstream : gitStatus?.upstream;
	const staged = entries.filter((entry) => entry.x !== " " && entry.x !== "?");
	const worktree = entries.filter((entry) => entry.x === " " && entry.y !== " " && entry.y !== "?");
	const untracked = entries.filter((entry) => entry.y === "?");

	useEffect(() => {
		// 项目切换或仓库筛选变化后，清掉已不在列表里的选中（连同其 diff）
		if (selected !== undefined && !entries.some((entry) => entry.path === selected.path)) {
			setSelected(undefined);
			setDiff(undefined);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [gitStatus, repoFilter]);

	useEffect(() => {
		// 项目切换：仓库筛选复位
		setRepoFilter("");
	}, [cwd]);

	useEffect(() => {
		// 所选仓库不再存在（子仓库被移除但其他仓库还在，或退化回单仓）时复位为全部仓库
		if (repoFilter !== "" && (!multiRepo || selectedRepo === undefined)) setRepoFilter("");
	}, [multiRepo, repoFilter, selectedRepo]);

	const openDiff = (path: string, stagedView: boolean): void => {
		const seq = ++diffSeq.current;
		setSelected({ path, staged: stagedView });
		setDiffLoading(true);
		setDiffError(undefined);
		void api
			.gitDiff(cwd, path, stagedView)
			.then((text) => {
				if (diffSeq.current !== seq) return;
				setDiff(text);
			})
			.catch((err: unknown) => {
				if (diffSeq.current !== seq) return;
				setDiffError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (diffSeq.current === seq) setDiffLoading(false);
			});
	};

	const act = async (action: () => Promise<unknown>): Promise<void> => {
		setBusy(true);
		setError(undefined);
		try {
			await action();
			onGitRefresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const commit = async (): Promise<void> => {
		if (message.trim() === "") return;
		setBusy(true);
		try {
			// 选定了仓库时只提交该仓库；全部仓库视图则提交所有有暂存的仓库
			await api.gitCommit(cwd, message.trim(), multiRepo && repoFilter !== "" ? repoFilter : undefined);
			setMessage("");
			onGitRefresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (gitStatus !== undefined && !gitStatus.repo) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
				<IconGitBranch size={22} className="text-owl-faint" />
				<div className="text-xs text-owl-muted">{t("changes.notGit")}</div>
				<div className="text-[11px] text-owl-faint">{t("changes.notGitHint")}</div>
			</div>
		);
	}

	const changeCount = gitStatus?.entries.length ?? 0;
	const modeSwitch = (
		<div role="tablist" className="inline-flex shrink-0 rounded-lg border border-owl-border bg-owl-panel p-[2px]">
			{(["changes", "history"] as const).map((value) => (
				<button
					key={value}
					type="button"
					role="tab"
					aria-selected={mode === value}
					className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 text-xs ${mode === value ? "bg-owl-bg text-owl-text shadow-[0_1px_0_rgba(0,0,0,0.25)]" : "text-owl-muted hover:text-owl-text"}`}
					onClick={() => {
						setMode(value);
						localStorage.setItem(MODE_KEY, value);
					}}
				>
					{value === "changes" ? t("changes.modeChanges") : t("changes.modeHistory")}
					{value === "changes" && changeCount > 0 && <span className="rounded bg-owl-hover px-1 text-[10.5px] text-owl-muted">{changeCount}</span>}
				</button>
			))}
		</div>
	);

	if (mode === "history") {
		return (
			<HistoryView
				api={api}
				cwd={cwd}
				repos={repos}
				{...(multiRepo && repoFilter !== "" ? { initialRepo: repoFilter } : {})}
				modeSwitch={modeSwitch}
				statusVersion={gitStatus}
				onGitRefresh={onGitRefresh}
				{...(onToChat !== undefined ? { onToChat } : {})}
			/>
		);
	}

	const group = (title: string, rows: GitStatusEntry[], stagedView: boolean): React.JSX.Element => (
		<div className="px-1">
			<div className="flex items-center justify-between px-2 py-1 text-[11px] text-owl-faint">
				<span>
					{title} <span className="ml-1 rounded bg-owl-panel px-1">{rows.length}</span>
				</span>
				{stagedView ? (
					rows.length > 0 && (
						<button type="button" className="hover:text-owl-text" title={t("changes.unstageAll")} onClick={() => void act(() => api.gitUnstage(cwd, rows.map((row) => row.path)))}>
							<IconUndo size={12} />
						</button>
					)
				) : (
					rows.length > 0 && (
						<button type="button" className="hover:text-owl-text" title={t("changes.stageAll")} onClick={() => void act(() => api.gitStage(cwd, rows.map((row) => row.path)))}>
							+
						</button>
					)
				)}
			</div>
			{rows.map((entry) => {
				const isSelected = selected?.path === entry.path && selected.staged === stagedView;
				return (
					<div
						key={`${entry.path}-${stagedView ? "s" : "w"}`}
						className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-[3px] hover:bg-owl-hover ${isSelected ? "bg-owl-hover" : ""}`}
						onClick={() => openDiff(entry.path, stagedView)}
					>
						<span className={`shrink-0 text-[10px] font-semibold ${statusColor(entry)}`}>{statusLetter(entry)}</span>
						<span className="min-w-0 flex-1 truncate text-xs text-owl-text" title={entry.origPath !== undefined ? `${entry.origPath} → ${entry.path}` : entry.path}>
							{entry.origPath !== undefined && <span className="text-owl-faint">{entry.origPath} → </span>}
							{entry.path}
						</span>
						<span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
							{stagedView ? (
								<button
									type="button"
									title={t("api.opGitUnstage")}
									className="rounded p-0.5 text-owl-muted hover:text-owl-text"
									onClick={(e) => {
										e.stopPropagation();
										void act(() => api.gitUnstage(cwd, [entry.path]));
									}}
								>
									<IconUndo size={12} />
								</button>
							) : (
								<button
									type="button"
									title={t("api.opGitStage")}
									className="rounded p-0.5 text-owl-muted hover:text-owl-text"
									onClick={(e) => {
										e.stopPropagation();
										void act(() => api.gitStage(cwd, [entry.path]));
									}}
								>
									+
								</button>
							)}
							{!stagedView && (
								<button
									type="button"
									title={t("changes.discard")}
									className="rounded p-0.5 text-owl-muted hover:text-red-300"
									onClick={(e) => {
										e.stopPropagation();
										void act(() => api.gitDiscard(cwd, entry.path));
									}}
								>
									<IconTrash size={12} />
								</button>
							)}
						</span>
					</div>
				);
			})}
		</div>
	);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex items-center gap-1.5 border-b border-owl-border/40 px-2 py-1.5">
				{modeSwitch}
				{multiRepo && (
					<select
						aria-label={t("changes.repoFilter")}
						className="max-w-[60%] shrink rounded-md border border-owl-border/60 bg-owl-panel px-1.5 py-0.5 text-[11px] text-owl-text outline-none focus:border-owl-accent"
						value={repoFilter}
						onChange={(event) => setRepoFilter(event.target.value)}
					>
						<option value="">{t("changes.allRepos", { n: repos.length })}</option>
						{repos.map((repo) => (
							<option key={repo.root} value={repo.root}>
								{repoDisplayName(repo.root, cwd)}
								{repo.branch !== undefined ? ` ─ ${repo.branch}` : ""}
							</option>
						))}
					</select>
				)}
				<span className="min-w-0 flex-1 truncate text-[11px] text-owl-faint">
					{branchLabel !== undefined && (
						<>
							<IconGitBranch size={11} className="mr-1 inline align-[-1px]" />
							{branchLabel}
							{upstreamLabel !== undefined && <span className="text-owl-faint/70"> ⟂ {upstreamLabel}</span>}
						</>
					)}
				</span>
				<button type="button" title={t("common.refresh")} className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text" onClick={onGitRefresh}>
					<IconRefresh size={14} />
				</button>
			</div>
			{error !== undefined && (
				<div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
					{error}
					<button type="button" className="ml-2 underline" onClick={() => setError(undefined)}>
						{t("window.close")}
					</button>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				{gitStatus === undefined && (
					<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
						<IconLoader size={13} className="animate-spin" /> {t("changes.readingStatus")}
					</div>
				)}
				{staged.length > 0 && group(t("changes.stagedGroup"), staged, true)}
				{worktree.length > 0 && group(t("changes.changesGroup"), worktree, false)}
				{untracked.length > 0 && group(t("changes.untrackedGroup"), untracked, false)}
				{gitStatus !== undefined && entries.length === 0 && (
					<div className="px-3 py-6 text-center text-xs text-owl-faint">{t("changes.cleanTree")}</div>
				)}
			</div>

			<DiffReview key={JSON.stringify([cwd, profile, execution.sessionId])} api={api} cwd={cwd} selected={selected} diff={diff} loading={diffLoading} error={diffError} expanded={expandedDiff} onExpand={() => setExpandedDiff((value) => !value)} onClose={() => { diffSeq.current += 1; setSelected(undefined); setDiff(undefined); setDiffLoading(false); }} onOpenFile={onOpenFile} />

			{/* 吸底提交条 */}
			{(staged.length > 0 || message !== "") && (
				<div className="shrink-0 border-t border-owl-border/60 p-2">
					<textarea
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								void commit();
							}
						}}
						rows={2}
						placeholder={t("changes.commitPlaceholder", { n: staged.length })}
						className="w-full resize-none rounded-lg border border-owl-border/50 bg-owl-panel px-2.5 py-1.5 text-xs text-owl-text placeholder:text-owl-faint focus:border-owl-accent/60 focus:outline-none"
					/>
					<button
						type="button"
						disabled={busy || message.trim() === "" || staged.length === 0}
						className="mt-1.5 w-full rounded-lg bg-owl-accent py-1.5 text-xs font-medium text-white transition-colors hover:bg-owl-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
						onClick={() => void commit()}
					>
						{busy ? t("changes.committing") : t("changes.commitN", { n: staged.length })}
					</button>
				</div>
			)}
		</div>
	);
}
