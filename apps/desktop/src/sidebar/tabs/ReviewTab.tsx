/**
 * 改动审批 tab：AI 编辑的逐文件「保留 / 回滚」审查。
 *
 * 数据面走 owl-diff-approval 插件（宿主侧捕获 write/edit 基线，桥协议
 * diffApproval.*）；diff 渲染复用 ChangesTab 抽出的 DiffView。清单按工作区
 * 持久化（跨会话存续），插件落库后经 diffApproval.changed 推送自动刷新。
 * 移植自 9087/dsh-diff-approval 的文件级审批子集。
 */
import { useContext, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import type { DiffApprovalFileSummary } from "../../bridge/protocol.ts";
import type { TabComponentProps } from "../registry.ts";
import { samePath } from "../api.ts";
import { ExecutionContext } from "../execution-context.tsx";
import { consumeReviewFocus, REVIEW_FOCUS_EVENT } from "../review-focus.ts";
import { DiffView } from "../DiffView.tsx";
import { IconLoader, IconPencil, IconRefresh, IconTrash, IconUndo, IconX } from "../icons.tsx";
import { UndoReviewPanel } from "../UndoReviewPanel.tsx";
import { useUndoReview } from "../use-undo-review.ts";
import { useUndoCopy } from "../undo-copy.ts";

function statLine(entry: DiffApprovalFileSummary): string {
	if (entry.added === null && entry.removed === null) return "";
	const parts: string[] = [];
	if ((entry.added ?? 0) > 0) parts.push(`+${entry.added}`);
	if ((entry.removed ?? 0) > 0) parts.push(`−${entry.removed}`);
	return parts.join(" ");
}

/** diff 预览面板高度（占 tab 容器百分比）：拖拽条自由拉伸，▴ 按钮在默认/放大两档间切换。 */
const DEFAULT_PREVIEW_PERCENT = 45;
const EXPANDED_PREVIEW_PERCENT = 78;
const MIN_PREVIEW_PERCENT = 15;
const MAX_PREVIEW_PERCENT = 85;

export function ReviewTab({ api, cwd, client }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const copy = useUndoCopy();
	const execution = useContext(ExecutionContext);
	// 跨会话隔离：默认只列本次对话的待审改动——别把别的会话的改动混进来批准/回滚。
	// 「显示全部」是逃生口：老记录没有会话号，或用户就是想清理工作区里的残留。
	const [showAllSessions, setShowAllSessions] = useState(false);
	const sessionId = execution.sessionId;
	const [files, setFiles] = useState<DiffApprovalFileSummary[] | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [connected, setConnected] = useState(true);
	const [clearing, setClearing] = useState(false);
	const [selected, setSelected] = useState<string | undefined>(undefined);
	const [diff, setDiff] = useState<string | undefined>(undefined);
	const [diffTruncated, setDiffTruncated] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState<string | undefined>(undefined);
	const [previewHeight, setPreviewHeight] = useState(DEFAULT_PREVIEW_PERCENT);
	const rootRef = useRef<HTMLDivElement | null>(null);
	// diff 请求序号：慢响应晚到时不得覆盖后点的文件（ChangesTab diffSeq 同款守卫）
	const diffSeq = useRef(0);
	const listSeq = useRef(0);
	const context = useRef({ cwd, client });
	if (context.current.cwd !== cwd || context.current.client !== client) context.current = { cwd, client };
	const clearLock = useRef(false);

	const refresh = (): void => {
		const identity = context.current;
		const sequence = ++listSeq.current;
		setLoading(true);
		void api
			.diffApprovalList(cwd)
			.then((list) => {
				if (context.current !== identity || listSeq.current !== sequence) return;
				setFiles(list);
				setError(undefined);
				setConnected(true);
			})
			.catch((err: unknown) => {
				if (context.current !== identity || listSeq.current !== sequence) return;
				const message = err instanceof Error ? err.message : String(err);
				setError(message);
				// 桥没连上：立刻给出未连接态（区别于无限转圈），重连后由 onStatus 自动重试
				if (/bridge (not connected|disconnected)/i.test(message)) setConnected(false);
			})
			.finally(() => { if (context.current === identity && listSeq.current === sequence) setLoading(false); });
	};
	const undo = useUndoReview(api, cwd, cwd, refresh);
	const busy = clearing || undo.busy;

	useEffect(() => {
		const identity = { cwd, client };
		context.current = identity;
		setFiles(undefined);
		setError(undefined);
		setSelected(undefined);
		setDiff(undefined);
		setDiffLoading(false);
		setClearing(false);
		clearLock.current = false;
		++diffSeq.current;
		refresh();
		// 桥重连成功：自动补一次清单（未连接期间用户不用手动刷新）
		const offStatus = client.onStatus((up) => {
			setConnected(up);
			if (up) refresh();
		});
		// 插件落库/处理后的推送：只认当前工作区的广播
		const offChanged = client.onDiffApprovalChanged((message) => {
			if (samePath(message.cwd, cwd)) refresh();
		});
		return () => {
			if (context.current === identity) context.current = { cwd: "", client };
			++listSeq.current;
			++diffSeq.current;
			offStatus();
			offChanged();
		};
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
		if (clearLock.current || undo.busy) return;
		const identity = context.current;
		clearLock.current = true;
		setClearing(true);
		setError(undefined);
		try {
			await action();
		} catch (err) {
			if (context.current !== identity) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (context.current === identity) { clearLock.current = false; setClearing(false); }
		}
	};

	const openDiff = (entryId: string): void => {
		const identity = context.current;
		const seq = ++diffSeq.current;
		setSelected(entryId);
		setDiffLoading(true);
		setDiffError(undefined);
		setDiff(undefined);
		void api
			.diffApprovalDiff(cwd, entryId)
			.then((result) => {
				if (context.current !== identity || diffSeq.current !== seq) return;
				setDiff(result.diff);
				setDiffTruncated(result.truncated);
			})
			.catch((err: unknown) => {
				if (context.current !== identity || diffSeq.current !== seq) return;
				setDiffError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (context.current === identity && diffSeq.current === seq) setDiffLoading(false);
			});
	};

	/** 顶部拖拽条：按指针 Y 相对容器底边的距离实时改预览面板高度（拖动期间禁选中）。 */
	const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0) return;
		event.preventDefault();
		const root = rootRef.current;
		if (root === null) return;
		const onMove = (move: PointerEvent): void => {
			const rect = root.getBoundingClientRect();
			const percent = ((rect.bottom - move.clientY) / rect.height) * 100;
			setPreviewHeight(Math.min(MAX_PREVIEW_PERCENT, Math.max(MIN_PREVIEW_PERCENT, percent)));
		};
		const onUp = (): void => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
		};
		document.body.style.userSelect = "none";
		document.body.style.cursor = "row-resize";
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	const resolve = (entryIds: string[], action: "keep" | "revert"): Promise<void> =>
		action === "keep" ? undo.keep(entryIds) : undo.requestPreview(entryIds);

	const scoped = (files ?? []).filter(
		(entry) => showAllSessions || sessionId === undefined || entry.sessionId === sessionId,
	);
	const foreignCount = (files ?? []).filter(
		(entry) => !showAllSessions && sessionId !== undefined && entry.sessionId !== sessionId,
	).length;
	const pending = scoped.filter((entry) => entry.status === "pending");
	const resolved = scoped.filter((entry) => entry.status !== "pending");
	const selectedEntry = scoped.find((entry) => entry.id === selected);
	const expandedDiff = previewHeight > (DEFAULT_PREVIEW_PERCENT + EXPANDED_PREVIEW_PERCENT) / 2;

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
							disabled={busy}
							title={t("review.keepAll")}
							className="rounded px-1 hover:text-emerald-300"
							onClick={() => void resolve(rows.map((row) => row.id), "keep")}
						>
							✓
						</button>
						<button
							type="button"
							title={copy.preview}
							disabled={busy || rows.every((row) => row.scope === "legacy")}
							className="rounded px-1 hover:text-red-300"
							onClick={() => void resolve(rows.filter((row) => row.scope !== "legacy").map((row) => row.id), "revert")}
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
							<span className="ml-1.5 font-sans text-[10px] text-owl-faint" title={entry.sessionId}>{new Date(entry.baselineAt).toLocaleString()} {entry.sessionId?.slice(0, 8)}</span>
							{entry.scope === "legacy" && <span className="ml-1.5 font-sans text-[10px] text-owl-faint" title={copy.legacy}>{copy.legacy}</span>}
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
									disabled={busy}
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
									title={entry.scope === "legacy" ? copy.legacy : copy.preview}
									disabled={busy || entry.scope === "legacy"}
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
		<div ref={rootRef} className="flex h-full flex-col overflow-hidden">
			<div className="flex items-center gap-1 border-b border-owl-border/40 px-2 py-1.5">
				<span className="min-w-0 flex-1 truncate text-[11px] text-owl-faint" title={copy.scope}>{copy.workspace} · {pending.length}</span>
				{foreignCount > 0 && (
					<button
						type="button"
						title={t("review.otherSessionsHint")}
						className="shrink-0 rounded border border-owl-border/60 px-1.5 py-0.5 text-[10px] text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
						onClick={() => setShowAllSessions(true)}
					>
						{t("review.otherSessions", { n: foreignCount })}
					</button>
				)}
				{showAllSessions && sessionId !== undefined && (
					<button
						type="button"
						title={t("review.thisSessionOnlyHint")}
						className="shrink-0 rounded border border-owl-border/60 px-1.5 py-0.5 text-[10px] text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
						onClick={() => setShowAllSessions(false)}
					>
						{t("review.thisSessionOnly")}
					</button>
				)}
				{resolved.length > 0 && (
					<button
						type="button"
						title={t("review.clearResolved")}
						disabled={busy}
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
				<UndoReviewPanel review={undo} />
				{files === undefined && loading && (
					<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
						<IconLoader size={13} className="animate-spin" /> {t("review.loading")}
					</div>
				)}
				{files === undefined && !loading && (
					<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
						<IconPencil size={22} className={connected ? "text-owl-faint" : "text-red-300/70"} />
						<div className="text-xs text-owl-muted">{connected ? t("review.loadFailed") : t("review.disconnected")}</div>
						<button
							type="button"
							className="flex items-center gap-1 rounded-md border border-owl-border px-2 py-1 text-[11px] text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
							onClick={refresh}
						>
							<IconRefresh size={12} /> {t("common.retry")}
						</button>
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

			{/* diff 预览面板：顶部拖拽条自由调高（往上拉大/往下缩小，双击复位） */}
			{selectedEntry !== undefined && (
				<div className="flex shrink-0 flex-col" style={{ height: `${previewHeight}%` }}>
					<div
						role="separator"
						aria-orientation="horizontal"
						title={t("review.resizeHint")}
						className="group flex h-1.5 shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-owl-border/60 transition-colors hover:bg-owl-hover/60"
						onPointerDown={startResize}
						onDoubleClick={() => setPreviewHeight(DEFAULT_PREVIEW_PERCENT)}
					>
						<span className="h-0.5 w-10 rounded-full bg-owl-border/70 transition-colors group-hover:bg-owl-muted" />
					</div>
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
									disabled={busy || selectedEntry.scope === "legacy"}
									title={selectedEntry.scope === "legacy" ? copy.legacy : copy.preview}
									className="rounded px-1.5 py-0.5 text-[11px] text-owl-muted hover:bg-owl-hover hover:text-red-300 disabled:opacity-40"
									onClick={() => void resolve([selectedEntry.id], "revert")}
								>
									<IconUndo size={11} className="inline align-[-1px]" /> {copy.preview}
								</button>
							</>
						)}
						<button
							type="button"
							title={expandedDiff ? t("common.collapse") : t("common.expand")}
							className="rounded p-1 text-owl-muted hover:text-owl-text"
							onClick={() => setPreviewHeight(expandedDiff ? DEFAULT_PREVIEW_PERCENT : EXPANDED_PREVIEW_PERCENT)}
						>
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
