/**
 * 改动审批 tab：AI 编辑的逐文件「保留 / 回滚」审查。
 *
 * 数据面走 owl-diff-approval 插件（宿主侧捕获 write/edit 基线，桥协议
 * diffApproval.*）；diff 渲染复用 ChangesTab 抽出的 DiffView。清单按工作区
 * 持久化（跨会话存续），插件落库后经 diffApproval.changed 推送自动刷新。
 * 移植自 9087/dsh-diff-approval 的文件级审批子集。
 */
import { useEffect, useState } from "react";
import { t, useT } from "../../i18n/index.ts";
import type { DiffApprovalFileSummary } from "../../bridge/protocol.ts";
import type { TabComponentProps } from "../registry.ts";
import { samePath } from "../api.ts";
import { consumeReviewFocus, REVIEW_FOCUS_EVENT } from "../review-focus.ts";
import { DiffView } from "../DiffView.tsx";
import { IconLoader, IconPencil, IconRefresh, IconTrash, IconUndo, IconX } from "../icons.tsx";

function statLine(entry: DiffApprovalFileSummary): string {
	if (entry.added === null && entry.removed === null) return "";
	const parts: string[] = [];
	if ((entry.added ?? 0) > 0) parts.push(`+${entry.added}`);
	if ((entry.removed ?? 0) > 0) parts.push(`−${entry.removed}`);
	return parts.join(" ");
}

export function ReviewTab({ api, cwd, client }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const [files, setFiles] = useState<DiffApprovalFileSummary[] | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState<string | undefined>(undefined);
	const [diff, setDiff] = useState<string | undefined>(undefined);
	const [diffTruncated, setDiffTruncated] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState<string | undefined>(undefined);
	const [expandedDiff, setExpandedDiff] = useState(false);

	const refresh = (): void => {
		void api
			.diffApprovalList(cwd)
			.then((list) => {
				setFiles(list);
				setError(undefined);
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	useEffect(() => {
		refresh();
		// 插件落库/处理后的推送：只认当前工作区的广播
		return client.onDiffApprovalChanged((message) => {
			if (samePath(message.cwd, cwd)) refresh();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd, client]);

	// 对话流改动卡「工作台审查」的跳转：清单到位后选中并展开聚焦的文件
	const applyFocus = (): void => {
		if (files === undefined) return; // 清单未就绪：留在总线上，[files] effect 兜底消费
		const focus = consumeReviewFocus();
		if (focus === undefined) return;
		const target = files.find((item) => item.displayPath.toLowerCase() === focus.toLowerCase());
		if (target !== undefined) openDiff(target.id);
	};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(applyFocus, [files]);
	useEffect(() => {
		window.addEventListener(REVIEW_FOCUS_EVENT, applyFocus);
		return () => window.removeEventListener(REVIEW_FOCUS_EVENT, applyFocus);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [files]);

	const act = async (action: () => Promise<unknown>): Promise<void> => {
		setBusy(true);
		setError(undefined);
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const openDiff = (entryId: string): void => {
		setSelected(entryId);
		setDiffLoading(true);
		setDiffError(undefined);
		setDiff(undefined);
		void api
			.diffApprovalDiff(cwd, entryId)
			.then((result) => {
				setDiff(result.diff);
				setDiffTruncated(result.truncated);
			})
			.catch((err: unknown) => setDiffError(err instanceof Error ? err.message : String(err)))
			.finally(() => setDiffLoading(false));
	};

	const resolve = (entryIds: string[], action: "keep" | "revert"): Promise<void> =>
		act(async () => {
			const result = await api.diffApprovalResolve(cwd, entryIds, action);
			refresh();
			if (selected !== undefined && entryIds.includes(selected) && action === "revert") {
				setSelected(undefined);
				setDiff(undefined);
			}
			if (result.failed.length > 0) {
				setError(result.failed.map((item) => `${item.path}: ${item.reason}`).join("; "));
			}
		});

	const pending = (files ?? []).filter((entry) => entry.status === "pending");
	const resolved = (files ?? []).filter((entry) => entry.status !== "pending");
	const selectedEntry = (files ?? []).find((entry) => entry.id === selected);

	const group = (title: string, rows: DiffApprovalFileSummary[], actionable: boolean): React.JSX.Element => (
		<div className="px-1">
			<div className="flex items-center justify-between px-2 py-1 text-[11px] text-owl-faint">
				<span>
					{title} <span className="ml-1 rounded bg-owl-panel px-1">{rows.length}</span>
				</span>
				{actionable && rows.length > 0 && (
					<span className="flex items-center gap-1">
						<button
							type="button"
							title={t("review.keepAll")}
							className="rounded px-1 hover:text-emerald-300"
							onClick={() => void resolve(rows.map((row) => row.id), "keep")}
						>
							✓
						</button>
						<button
							type="button"
							title={t("review.revertAll")}
							className="rounded px-1 hover:text-red-300"
							onClick={() => {
								if (window.confirm(t("review.revertAllConfirm", { n: rows.length }))) {
									void resolve(rows.map((row) => row.id), "revert");
								}
							}}
						>
							<IconUndo size={12} />
						</button>
					</span>
				)}
			</div>
			{rows.map((entry) => {
				const isSelected = selected === entry.id;
				const stats = statLine(entry);
				return (
					<div
						key={entry.id}
						className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-[3px] hover:bg-owl-hover ${isSelected ? "bg-owl-hover" : ""}`}
						onClick={() => openDiff(entry.id)}
					>
						<span
							className={`w-3 shrink-0 text-center text-[10px] font-semibold ${
								entry.status === "pending" ? "text-amber-300" : entry.status === "kept" ? "text-emerald-300/70" : "text-owl-faint"
							}`}
						>
							{entry.status === "pending" ? "•" : entry.status === "kept" ? "✓" : "↩"}
						</span>
						<span className="min-w-0 flex-1 truncate font-mono text-xs text-owl-text" title={entry.path}>
							{entry.displayPath}
							{!entry.originalExisted && entry.status === "pending" && (
								<span className="ml-1.5 rounded bg-emerald-500/20 px-1 font-sans text-[10px] text-emerald-300">{t("review.created")}</span>
							)}
							{!entry.currentExists && entry.status === "pending" && (
								<span className="ml-1.5 rounded bg-red-500/20 px-1 font-sans text-[10px] text-red-300">{t("review.missing")}</span>
							)}
						</span>
						{stats !== "" && (
							<span className="shrink-0 font-mono text-[10px] text-owl-faint">
								{(entry.added ?? 0) > 0 && <span className="text-emerald-300/80">+{entry.added} </span>}
								{(entry.removed ?? 0) > 0 && <span className="text-red-300/80">−{entry.removed}</span>}
							</span>
						)}
						{actionable && (
							<span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
								<button
									type="button"
									title={t("review.keep")}
									className="rounded p-0.5 text-owl-muted hover:text-emerald-300"
									onClick={(e) => {
										e.stopPropagation();
										void resolve([entry.id], "keep");
									}}
								>
									✓
								</button>
								<button
									type="button"
									title={t("review.revert")}
									className="rounded p-0.5 text-owl-muted hover:text-red-300"
									onClick={(e) => {
										e.stopPropagation();
										void resolve([entry.id], "revert");
									}}
								>
									<IconUndo size={12} />
								</button>
							</span>
						)}
					</div>
				);
			})}
		</div>
	);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex items-center gap-1 border-b border-owl-border/40 px-2 py-1.5">
				<span className="min-w-0 flex-1 truncate text-[11px] text-owl-faint">{t("review.subtitle", { n: pending.length })}</span>
				{resolved.length > 0 && (
					<button
						type="button"
						title={t("review.clearResolved")}
						className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text"
						onClick={() => void act(async () => {
							await api.diffApprovalClear(cwd);
							refresh();
						})}
					>
						<IconTrash size={14} />
					</button>
				)}
				<button type="button" title={t("common.refresh")} className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text" onClick={refresh}>
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
				{files === undefined && (
					<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
						<IconLoader size={13} className="animate-spin" /> {t("review.loading")}
					</div>
				)}
				{files !== undefined && pending.length === 0 && resolved.length === 0 && (
					<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
						<IconPencil size={22} className="text-owl-faint" />
						<div className="text-xs text-owl-muted">{t("review.empty")}</div>
						<div className="text-[11px] text-owl-faint">{t("review.emptyHint")}</div>
					</div>
				)}
				{pending.length > 0 && group(t("review.pendingGroup"), pending, true)}
				{resolved.length > 0 && group(t("review.resolvedGroup"), resolved, false)}
			</div>

			{/* diff 预览面板（可展开为独占视图） */}
			{selectedEntry !== undefined && (
				<div className={`${expandedDiff ? "h-[78%]" : "h-[45%]"} flex shrink-0 flex-col border-t border-owl-border/60`}>
					<div className="flex items-center gap-1 border-b border-owl-border/40 px-2 py-1">
						<IconPencil size={11} className="shrink-0 text-owl-faint" />
						<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-owl-muted" title={selectedEntry.path}>
							{selectedEntry.displayPath}
							{selectedEntry.status !== "pending" && (
								<span className="ml-1.5 font-sans text-owl-faint">
									{selectedEntry.status === "kept" ? t("review.keptBadge") : t("review.revertedBadge")}
								</span>
							)}
						</span>
						{selectedEntry.status === "pending" && (
							<>
								<button
									type="button"
									disabled={busy}
									title={t("review.keep")}
									className="rounded px-1.5 py-0.5 text-[11px] text-owl-muted hover:bg-owl-hover hover:text-emerald-300 disabled:opacity-40"
									onClick={() => void resolve([selectedEntry.id], "keep")}
								>
									✓ {t("review.keep")}
								</button>
								<button
									type="button"
									disabled={busy}
									title={t("review.revert")}
									className="rounded px-1.5 py-0.5 text-[11px] text-owl-muted hover:bg-owl-hover hover:text-red-300 disabled:opacity-40"
									onClick={() => void resolve([selectedEntry.id], "revert")}
								>
									<IconUndo size={11} className="inline align-[-1px]" /> {t("review.revert")}
								</button>
							</>
						)}
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
						{!diffLoading && diffError === undefined && diff !== undefined && (
							<>
								{diffTruncated && <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300">{t("review.diffTruncated")}</div>}
								<DiffView text={diff} />
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
