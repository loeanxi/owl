/**
 * 文件变动 tab：Git 视角（暂存 / 提交 / 丢弃）+ 统一 diff 查看。
 *
 * 移植自 dsh-better-sidebar ChangesTab 的 Git 视角子集：porcelain 状态分组、
 * 行级 stage/unstage/discard、吸底提交条（Ctrl+Enter）；点击文件在下半面板
 * 看 diff（parseUnifiedDiff + annotateCharDiff 字符级高亮，VS Code 同款视觉）。
 * "本轮 AI 改动"视角（会话事件折叠）依赖 owl 会话事件索引，后续接入。
 */
import { useEffect, useState } from "react";
import { t, useT } from "../../i18n/index.ts";
import type { GitStatusEntry } from "../../bridge/protocol.ts";
import type { TabComponentProps } from "../registry.ts";
import { DiffView } from "../DiffView.tsx";
import { IconGitBranch, IconLoader, IconPencil, IconRefresh, IconTrash, IconUndo, IconX } from "../icons.tsx";

/** porcelain 字母 → 行色。 */
function statusColor(entry: GitStatusEntry): string {
	const letter = entry.x !== " " && entry.x !== "?" ? entry.x : entry.y;
	if (entry.y === "?") return "text-emerald-300/80";
	if (letter === "A") return "text-emerald-300";
	if (letter === "D") return "text-red-400";
	if (letter === "R" || letter === "C") return "text-sky-300";
	return "text-amber-300";
}

function statusLetter(entry: GitStatusEntry): string {
	if (entry.y === "?") return "U";
	const letter = entry.x !== " " && entry.x !== "?" ? entry.x : entry.y;
	return letter === " " ? "M" : letter;
}

export function ChangesTab({ api, cwd, gitStatus, onGitRefresh }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const [selected, setSelected] = useState<{ path: string; staged: boolean } | undefined>(undefined);
	const [diff, setDiff] = useState<string | undefined>(undefined);
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState<string | undefined>(undefined);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [expandedDiff, setExpandedDiff] = useState(false);

	const entries = gitStatus?.entries ?? [];
	const staged = entries.filter((entry) => entry.x !== " " && entry.x !== "?");
	const worktree = entries.filter((entry) => entry.x === " " && entry.y !== " " && entry.y !== "?");
	const untracked = entries.filter((entry) => entry.y === "?");

	useEffect(() => {
		// 项目切换后清掉已不存在的选中
		if (selected !== undefined && !entries.some((entry) => entry.path === selected.path)) {
			setSelected(undefined);
			setDiff(undefined);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [gitStatus]);

	const openDiff = (path: string, stagedView: boolean): void => {
		setSelected({ path, staged: stagedView });
		setDiffLoading(true);
		setDiffError(undefined);
		void api
			.gitDiff(cwd, path, stagedView)
			.then((text) => setDiff(text))
			.catch((err: unknown) => setDiffError(err instanceof Error ? err.message : String(err)))
			.finally(() => setDiffLoading(false));
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
			await api.gitCommit(cwd, message.trim());
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
			<div className="flex items-center gap-1 border-b border-owl-border/40 px-2 py-1.5">
				<span className="min-w-0 flex-1 truncate text-[11px] text-owl-faint">
					{gitStatus?.repos !== undefined && gitStatus.repos.length > 1 ? (
						<>
							<IconGitBranch size={11} className="mr-1 inline align-[-1px]" />
							{t("wb.gitRepos", { n: gitStatus.repos.length })}
						</>
					) : gitStatus?.branch !== undefined && (
						<>
							<IconGitBranch size={11} className="mr-1 inline align-[-1px]" />
							{gitStatus.branch}
							{gitStatus.upstream !== undefined && <span className="text-owl-faint/70"> ⟂ {gitStatus.upstream}</span>}
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

			{/* diff 预览面板（可展开为独占视图） */}
			{selected !== undefined && (
				<div className={`${expandedDiff ? "h-[78%]" : "h-[45%]"} flex shrink-0 flex-col border-t border-owl-border/60`}>
					<div className="flex items-center gap-1 border-b border-owl-border/40 px-2 py-1">
						<IconPencil size={11} className="shrink-0 text-owl-faint" />
						<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-owl-muted" title={selected.path}>
							{selected.path}
							{selected.staged && <span className="ml-1.5 text-emerald-300/80">{t("changes.stagedBadge")}</span>}
						</span>
						<button type="button" title={expandedDiff ? t("common.collapse") : t("common.expand")} className="rounded p-1 text-owl-muted hover:text-owl-text" onClick={() => setExpandedDiff(!expandedDiff)}>
							{expandedDiff ? "▾" : "▴"}
						</button>
						<button
							type="button"
							title={t("window.close")}
							className="rounded p-1 text-owl-muted hover:text-owl-text"
							onClick={() => {
								setSelected(undefined);
								setDiff(undefined);
							}}
						>
							<IconX size={12} />
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-auto">
						{diffLoading && (
							<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
								<IconLoader size={13} className="animate-spin" /> {t("changes.readingDiff")}
							</div>
						)}
						{diffError !== undefined && <div className="px-3 py-2 text-xs text-red-300">{diffError}</div>}
						{!diffLoading && diffError === undefined && diff !== undefined && <DiffView text={diff} />}
					</div>
				</div>
			)}

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
