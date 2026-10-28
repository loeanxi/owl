/**
 * 对话流里的「改动审批」卡（ZCode/Codex 同款交互）：一轮里 AI 的每次
 * write/edit 落成一行（文件名 + /− 统计），行内可展开 diff（审查）、打开文件、
 * 一键撤销；数据经桥协议 diffApproval.* 与工作区待审清单实时联动
 * （diffApproval.changed 推送即刷新，撤销后行内状态同步变「已回滚」）。
 *
 * TurnArtifacts 是对话流的按轮包装：write/edit 产物走改动卡，其余（打开的
 * 文档等）保留原「成果文件」卡；没拿到桥客户端时整体回退旧卡。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { DiffApprovalFileSummary } from "../bridge/protocol.ts";
import { FileIcon } from "../file-icons/FileIcon.tsx";
import type { FileArtifact } from "../hooks/artifacts.ts";
import { useT } from "../i18n/index.ts";
import { createSidebarApi, samePath } from "../sidebar/api.ts";
import { DiffView } from "../sidebar/DiffView.tsx";
import { focusEditorDiff } from "../sidebar/editor-diff-focus.ts";
import {
	IconChevronDown,
	IconChevronRight,
	IconEye,
	IconFile,
	IconFolder,
	IconLoader,
	IconUndo,
} from "../sidebar/icons.tsx";
import { UndoReviewPanel } from "../sidebar/UndoReviewPanel.tsx";
import { useUndoCopy } from "../sidebar/undo-copy.ts";
import { useUndoReview } from "../sidebar/use-undo-review.ts";
import { ArtifactActions } from "./ArtifactActions.tsx";
import { Artifacts } from "./Artifacts.tsx";
import { useArtifactActionText } from "./artifact-actions-copy.ts";
import { IconMore } from "./icons.tsx";
import { useReviewChangesMotion } from "./use-review-changes-motion.ts";

export interface ReviewChangesCardProps {
	/** 本轮 write/edit 产物（工作区相对 POSIX 路径）。 */
	files: readonly FileArtifact[];
	cwd: string;
	client: BridgeClient;
	sessionId?: string;
	disabled?: boolean;
	onOpenFile: (path: string) => void;
	/** 跳转工作台「改动审批」卡片并选中该文件。 */
	onOpenReview: (focusPath: string) => void;
}

function statsOf(entry: DiffApprovalFileSummary): { added: number; removed: number } {
	return { added: entry.added ?? 0, removed: entry.removed ?? 0 };
}

/** 加减行数。Claude 差异工具栏只留等宽数字，不加比例条。全 0 时不渲染。 */
function DiffStat({
	added,
	removed,
	mini = false,
}: {
	added: number;
	removed: number;
	mini?: boolean;
}): React.JSX.Element | null {
	if (added <= 0 && removed <= 0) return null;
	return (
		<span className={`owl-changes-sum${mini ? " is-mini" : ""}`}>
			<span className="owl-changes-num">
				{(added > 0 || mini) && (
					<span className="add" aria-hidden={added <= 0 || undefined}>
						{added > 0 ? `+${added}` : ""}
					</span>
				)}
				{(removed > 0 || mini) && (
					<span className="del" aria-hidden={removed <= 0 || undefined}>
						{removed > 0 ? `−${removed}` : ""}
					</span>
				)}
			</span>
		</span>
	);
}

export function ReviewChangesCard({
	files,
	cwd,
	client,
	sessionId,
	disabled = false,
	onOpenFile,
	onOpenReview,
}: ReviewChangesCardProps): React.JSX.Element {
	const t = useT();
	const copy = useUndoCopy();
	const artifactText = useArtifactActionText();
	const cardId = useId();
	const api = useMemo(() => createSidebarApi(client), [client]);
	const [list, setList] = useState<DiffApprovalFileSummary[] | undefined>(undefined);
	const [loadError, setLoadError] = useState<string | undefined>();
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [diffText, setDiffText] = useState<ReadonlyMap<string, string[]>>(new Map());
	const [diffLoading, setDiffLoading] = useState<ReadonlySet<string>>(new Set());
	// 整卡默认收起。对话里只留一行「改了 N 个文件」，点开才看清单，避免摊在回答下面。
	const [collapsed, setCollapsed] = useState(true);
	const [menuPath, setMenuPath] = useState<string | null>(null);
	const menuTrigger = useRef<HTMLButtonElement | null>(null);
	// 展开集合的 ref 镜像：推送回调里免 stale closure
	const expandedRef = useRef<ReadonlySet<string>>(new Set());
	expandedRef.current = expanded;
	const toolCallIds = [...new Set(files.flatMap((file) => file.toolIds ?? [file.toolId]))];
	const contextKey = JSON.stringify([cwd, sessionId, toolCallIds]);
	const cardRef = useReviewChangesMotion(collapsed, contextKey);
	const context = useRef(contextKey);
	context.current = contextKey;
	const listSequence = useRef(0);
	const diffSequence = useRef(new Map<string, number>());
	const readDiff = (entryIds: string[], key: string): void => {
		const identity = contextKey;
		const sequence = (diffSequence.current.get(key) ?? 0) + 1;
		diffSequence.current.set(key, sequence);
		setDiffLoading((previous) => new Set(previous).add(key));
		// 一次往返取回整组 diff：每个条目一个请求会在打开会话时并发几十次，
		// 把桥的单线程事件循环堵到十几秒，切换会话全被排在后面。
		void api
			.diffApprovalDiffs(cwd, entryIds)
			.then((results) => {
				if (context.current !== identity || diffSequence.current.get(key) !== sequence) return;
				const failed = results.filter((result) => result.error);
				if (failed.length > 0) setLoadError(failed[0]!.error);
				setDiffText((previous) =>
					new Map(previous).set(
						key,
						results.filter((result) => !result.error).map((result) => result.diff),
					),
				);
			})
			.catch((error: unknown) => {
				if (context.current !== identity || diffSequence.current.get(key) !== sequence) return;
				setLoadError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (context.current !== identity || diffSequence.current.get(key) !== sequence) return;
				setDiffLoading((previous) => {
					const next = new Set(previous);
					next.delete(key);
					return next;
				});
			});
	};

	const refresh = (): void => {
		const identity = contextKey;
		const sequence = ++listSequence.current;
		void api
			.diffApprovalList(cwd, { toolCallIds, ...(sessionId !== undefined ? { sessionId } : {}) })
			.then((next) => {
				if (context.current !== identity || listSequence.current !== sequence) return;
				setList(next);
				setLoadError(undefined);
				for (const file of files) {
					if (expandedRef.current.has(file.path)) {
						const ids = matchingEntries(file, next)
							.filter((entry) => entry.status === "pending")
							.map((entry) => entry.id);
						if (ids.length > 0) readDiff(ids, file.path);
						else
							setExpanded((previous) => {
								const remaining = new Set(previous);
								remaining.delete(file.path);
								return remaining;
							});
					}
				}
			})
			.catch((error: unknown) => {
				if (context.current !== identity || listSequence.current !== sequence) return;
				setLoadError(error instanceof Error ? error.message : String(error));
			});
	};
	const undo = useUndoReview(api, cwd, contextKey, refresh);
	const busy = undo.busy || disabled;

	useEffect(() => {
		context.current = contextKey;
		setList(undefined);
		setLoadError(undefined);
		setExpanded(new Set());
		setDiffText(new Map());
		setDiffLoading(new Set());
		setMenuPath(null);
		refresh();
		const offChanged = client.onDiffApprovalChanged((message) => {
			if (samePath(message.cwd, cwd)) refresh();
		});
		const offStatus = client.onStatus((connected) => {
			if (connected) refresh();
		});
		return () => {
			++listSequence.current;
			if (context.current === contextKey) context.current = "";
			offChanged();
			offStatus();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [contextKey, client]);

	useEffect(() => {
		if (menuPath === null) return;
		const popup = cardRef.current?.querySelector<HTMLElement>(".owl-changes-menu");
		popup?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
		const closeOutside = (event: PointerEvent): void => {
			if (!popup?.contains(event.target as Node) && !menuTrigger.current?.contains(event.target as Node))
				setMenuPath(null);
		};
		document.addEventListener("pointerdown", closeOutside);
		return () => document.removeEventListener("pointerdown", closeOutside);
	}, [menuPath, cardRef]);

	/** Tool provenance, never the path, determines which operations belong to this turn. */
	const matchingEntries = (artifact: FileArtifact, candidates = list ?? []): DiffApprovalFileSummary[] => {
		const ids = new Set(artifact.toolIds ?? [artifact.toolId]);
		return candidates
			.filter(
				(entry) =>
					entry.scope === "operation" &&
					entry.toolCallId !== undefined &&
					[...ids].some((id) => entry.toolCallId === id || entry.toolCallId?.startsWith(`${id}/`)) &&
					(sessionId === undefined || entry.sessionId === sessionId) &&
					(samePath(entry.displayPath, artifact.path) || samePath(entry.path, `${cwd}/${artifact.path}`)),
			)
			.sort((a, b) => a.baselineAt.localeCompare(b.baselineAt));
	};
	const entryFor = (artifact: FileArtifact): DiffApprovalFileSummary | undefined => {
		const entries = matchingEntries(artifact);
		const entry = entries[0];
		if (!entry) return undefined;
		return {
			...entry,
			status: entries.some((item) => item.status === "pending")
				? "pending"
				: entries.every((item) => item.status === "reverted")
					? "reverted"
					: "kept",
			added: entries.reduce((n, item) => n + (item.added ?? 0), 0),
			removed: entries.reduce((n, item) => n + (item.removed ?? 0), 0),
		};
	};

	const tracked = files
		.map((file) => ({ file, entry: entryFor(file) }))
		.filter((row) => row.entry !== undefined) as Array<{ file: FileArtifact; entry: DiffApprovalFileSummary }>;
	const totals = tracked.reduce(
		(acc, { entry }) => {
			const stats = statsOf(entry);
			acc.added += stats.added;
			acc.removed += stats.removed;
			return acc;
		},
		{ added: 0, removed: 0 },
	);

	const toggleDiff = (file: FileArtifact): void => {
		const key = file.path;
		if (expanded.has(key)) {
			const next = new Set(expanded);
			next.delete(key);
			setExpanded(next);
			return;
		}
		setExpanded(new Set(expanded).add(key));
		readDiff(
			matchingEntries(file)
				.filter((entry) => entry.status === "pending")
				.map((entry) => entry.id),
			key,
		);
	};

	/** 头部批量撤销：只收本轮待审的条目（工作台里的「全部回滚」是全工作区口径）。 */
	const revertAll = (): void => {
		const ids = [
			...new Set(
				files.flatMap((file) =>
					matchingEntries(file)
						.filter((entry) => entry.status === "pending")
						.map((entry) => entry.id),
				),
			),
		];
		if (ids.length === 0) return;
		setCollapsed(false);
		void undo.requestPreview(ids);
	};

	/** 点文件名：照旧打开整文件（可编辑）；pending 条目顺带经聚焦总线给
	 * 编辑器带上 diff 语境（装饰新增行/删除块 + 滚到第一处改动）。 */
	const openFileWithDiffContext = (file: FileArtifact, entry: DiffApprovalFileSummary | undefined): void => {
		if (entry !== undefined && entry.status === "pending") focusEditorDiff(file.path);
		onOpenFile(file.path);
	};
	const parents = files.map((file) => {
		const path = file.path.replace(/\\/g, "/");
		return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	});
	const sharedParent = parents.length > 0 && parents.every((parent) => parent === parents[0]) ? parents[0] : undefined;
	const directory = sharedParent || cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || cwd;
	const batchActions = (
		<>
			{tracked.some((row) => row.entry.status === "pending") && (
				<button
					type="button"
					className="owl-changes-revert-all"
					disabled={busy}
					title={copy.turn}
					onClick={revertAll}
				>
					<IconUndo size={13} />
					{copy.turn}
				</button>
			)}
			{tracked.length > 0 && (
				<button
					type="button"
					className="owl-changes-workbench"
					onClick={() => onOpenReview(tracked[0]!.entry.displayPath)}
				>
					{t("chat.reviewInWorkbench")}
					<IconChevronRight size={12} />
				</button>
			)}
		</>
	);

	return (
		<section
			ref={cardRef}
			className={`owl-artifacts owl-changes-card${collapsed ? " is-collapsed" : ""}`}
			aria-label={t("chat.changesCount", { n: files.length })}
		>
			<span className="owl-changes-trace" aria-hidden="true" />
			<header className="owl-changes-head">
				<button
					type="button"
					className="owl-changes-toggle"
					title={collapsed ? t("common.expand") : t("common.collapse")}
					aria-expanded={!collapsed}
					onClick={() => {
						setMenuPath(null);
						setCollapsed((value) => !value);
					}}
				>
					<IconChevronDown size={12} className="owl-changes-caret" />
					<span className="owl-changes-head-text">
						<strong className="owl-changes-title">{t("chat.changesCount", { n: files.length })}</strong>
					</span>
				</button>
				<DiffStat added={totals.added} removed={totals.removed} />
				{collapsed && <span className="owl-changes-head-actions">{batchActions}</span>}
			</header>
			{loadError && (
				<div className="owl-undo-panel" role="alert">
					{copy.refreshing}: {loadError}{" "}
					<button type="button" onClick={refresh}>
						{t("common.retry")}
					</button>
				</div>
			)}
			<UndoReviewPanel review={undo} disabled={disabled} />
			{!collapsed && (
				<div className="owl-changes-body">
					<ul className="owl-changes-list">
						{files.map((file, index) => {
							const entry = entryFor(file);
							const name = file.path.replace(/\\/g, "/").split("/").at(-1) ?? file.path;
							const dir = parents[index];
							const stats = entry ? statsOf(entry) : undefined;
							const isExpanded = entry !== undefined && expanded.has(file.path);
							const status = entry?.status;
							return (
								<li
									key={file.path}
									className={`owl-changes-item is-${status ?? "untracked"}${isExpanded ? " is-open" : ""}${menuPath === file.path ? " is-menu-open" : ""}`}
								>
									<div className="owl-changes-row">
										<span className="owl-changes-type" aria-hidden="true">
											<FileIcon name={name} size={18} minimal={<IconFile size={18} />} />
										</span>
										<button
											type="button"
											className="owl-changes-file"
											title={entry?.path ?? file.path}
											onClick={() => openFileWithDiffContext(file, entry)}
										>
											<span className="owl-changes-name-line">
												<span className="owl-changes-name">{name}</span>
												{entry !== undefined && status === "pending" && entry.originalExisted === false && (
													<span className="owl-changes-badge-new">{t("review.created")}</span>
												)}
											</span>
											{sharedParent === undefined && dir !== "" && (
												<span className="owl-changes-dir" title={dir}>
													{dir}
												</span>
											)}
										</button>
										<span className="owl-changes-result">
											{stats !== undefined && <DiffStat added={stats.added} removed={stats.removed} mini />}
											{status === "kept" && (
												<span className="owl-changes-state">{t("review.keptBadge")}</span>
											)}
											{status === "reverted" && (
												<span className="owl-changes-state">{t("review.revertedBadge")}</span>
											)}
										</span>
										<span className="owl-changes-actions">
											{entry !== undefined && status === "pending" && (
												<button
													type="button"
													className="owl-changes-act is-review"
													title={isExpanded ? t("common.collapse") : t("chat.reviewCta")}
													aria-label={isExpanded ? t("common.collapse") : t("chat.reviewCta")}
													aria-expanded={isExpanded}
													aria-controls={`${cardId}-diff-${index}`}
													onClick={() => toggleDiff(file)}
												>
													<IconEye size={14} />
													<span className="sr-only">
														{isExpanded ? t("common.collapse") : t("chat.reviewCta")}
													</span>
												</button>
											)}
											<button
												type="button"
												className="owl-changes-act is-more"
												id={`${cardId}-actions-${index}`}
												title={`${name} · ${artifactText("group")}`}
												aria-label={`${name} · ${artifactText("group")}`}
												aria-haspopup="menu"
												aria-expanded={menuPath === file.path}
												aria-controls={menuPath === file.path ? `${cardId}-menu` : undefined}
												onClick={(event) => {
													menuTrigger.current = event.currentTarget;
													setMenuPath((current) => (current === file.path ? null : file.path));
												}}
											>
												<IconMore />
											</button>
										</span>
									</div>
									{menuPath === file.path && (
										<div
											className="owl-changes-menu"
											id={`${cardId}-menu`}
											role="menu"
											aria-labelledby={`${cardId}-actions-${index}`}
											onBlur={(event) => {
												if (
													event.relatedTarget &&
													event.relatedTarget !== menuTrigger.current &&
													!event.currentTarget.contains(event.relatedTarget as Node)
												)
													setMenuPath(null);
											}}
											onKeyDown={(event) => {
												if (event.key === "Escape") {
													event.preventDefault();
													event.stopPropagation();
													setMenuPath(null);
													menuTrigger.current?.focus();
													return;
												}
												if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
												const items = [
													...event.currentTarget.querySelectorAll<HTMLButtonElement>(
														"button:not(:disabled)",
													),
												];
												if (items.length === 0) return;
												event.preventDefault();
												const current = items.indexOf(document.activeElement as HTMLButtonElement);
												const next =
													event.key === "Home"
														? 0
														: event.key === "End"
															? items.length - 1
															: (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
																items.length;
												items[next]?.focus();
											}}
										>
											<ArtifactActions menu path={file.path} title={file.title} cwd={cwd} client={client} />
											{entry !== undefined && status === "pending" && (
												<button
													type="button"
													role="menuitem"
													className="owl-changes-act is-revert"
													disabled={busy}
													title={copy.preview}
													onClick={() => {
														setMenuPath(null);
														menuTrigger.current?.focus();
														void undo.requestPreview(
															matchingEntries(file)
																.filter((item) => item.status === "pending")
																.map((item) => item.id),
														);
													}}
												>
													<IconUndo size={10} />
													{copy.preview}
												</button>
											)}
										</div>
									)}
									{entry === undefined && (
										<p className="px-3 py-1 text-[11px] text-owl-faint">{copy.unavailable}</p>
									)}
									{isExpanded && entry !== undefined && (
										<div className="owl-changes-diff" id={`${cardId}-diff-${index}`}>
											{diffLoading.has(file.path) && (
												<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
													<IconLoader size={12} className="animate-spin" /> {t("changes.readingDiff")}
												</div>
											)}
											{!diffLoading.has(file.path) &&
												diffText
													.get(file.path)
													?.map((text, index) => <DiffView key={`${file.path}:${index}`} text={text} />)}
										</div>
									)}
								</li>
							);
						})}
					</ul>
					<footer className="owl-changes-footer">
						<span className="owl-changes-directory" title={sharedParent || cwd}>
							<IconFolder size={13} />
							<span>{directory}</span>
						</span>
						<span className="owl-changes-footer-actions">{batchActions}</span>
					</footer>
				</div>
			)}
		</section>
	);
}

/** 对话流按轮包装：write/edit → 改动卡，其余 → 旧「成果文件」卡；无桥客户端回退旧卡。 */
export function TurnArtifacts({
	artifacts,
	cwd,
	client,
	sessionId,
	disabled,
	onOpenFile,
	onOpenReview,
}: {
	artifacts: readonly FileArtifact[];
	cwd?: string;
	client?: BridgeClient;
	sessionId?: string;
	disabled?: boolean;
	onOpenFile: (path: string) => void;
	onOpenReview?: (focusPath: string) => void;
}): React.JSX.Element | null {
	const changes = artifacts.filter((artifact) => artifact.action === "written" || artifact.action === "edited");
	const others = artifacts.filter((artifact) => artifact.action !== "written" && artifact.action !== "edited");
	if (changes.length === 0 || cwd === undefined || client === undefined || onOpenReview === undefined) {
		return <Artifacts artifacts={artifacts} onOpenFile={onOpenFile} cwd={cwd} client={client} />;
	}
	return (
		<>
			<ReviewChangesCard
				files={changes}
				cwd={cwd}
				client={client}
				sessionId={sessionId}
				disabled={disabled}
				onOpenFile={onOpenFile}
				onOpenReview={onOpenReview}
			/>
			{others.length > 0 && <Artifacts artifacts={others} onOpenFile={onOpenFile} cwd={cwd} client={client} />}
		</>
	);
}
