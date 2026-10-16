/**
 * 对话流里的「改动审批」卡（ZCode/Codex 同款交互）：一轮里 AI 的每次
 * write/edit 落成一行（文件名 + /− 统计），行内可展开 diff（审查）、打开文件、
 * 一键撤销；数据经桥协议 diffApproval.* 与工作区待审清单实时联动
 * （diffApproval.changed 推送即刷新，撤销后行内状态同步变「已回滚」）。
 *
 * TurnArtifacts 是对话流的按轮包装：write/edit 产物走改动卡，其余（打开的
 * 文档等）保留原「成果文件」卡；没拿到桥客户端时整体回退旧卡。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { DiffApprovalFileSummary } from "../bridge/protocol.ts";
import { createSidebarApi, samePath } from "../sidebar/api.ts";
import { focusEditorDiff } from "../sidebar/editor-diff-focus.ts";
import { DiffView } from "../sidebar/DiffView.tsx";
import type { FileArtifact } from "../hooks/artifacts.ts";
import { useT } from "../i18n/index.ts";
import { Artifacts } from "./Artifacts.tsx";
import { FileLanguageIcon, fileLanguageTitle } from "./file-language-icon.tsx";
import { IconChevronDown, IconChevronRight, IconFile, IconLoader, IconPencil, IconUndo } from "../sidebar/icons.tsx";
import { UndoReviewPanel } from "../sidebar/UndoReviewPanel.tsx";
import { useUndoReview } from "../sidebar/use-undo-review.ts";
import { useUndoCopy } from "../sidebar/undo-copy.ts";
import { ArtifactActions } from "./ArtifactActions.tsx";

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

/** 扩展名 → 类型色系（.t-* 类，取中饱和度色相，深浅主题都落在 13% 底上）。 */
const TYPE_FAMILIES: Record<string, string> = {
	ts: "blue", tsx: "blue", mts: "blue", cts: "blue", ps1: "blue",
	js: "amber", jsx: "amber", mjs: "amber", cjs: "amber", json: "amber",
	vue: "green", xml: "green",
	html: "orange", htm: "orange", rs: "orange",
	css: "purple", scss: "purple", less: "purple", kt: "purple",
	java: "red", c: "red", h: "red", cpp: "red", hpp: "red", cs: "red",
	py: "cyan", go: "cyan", swift: "cyan", sql: "cyan",
	md: "grey", txt: "grey", sh: "grey", yml: "grey", yaml: "grey", toml: "grey",
};

function fileTypeOf(path: string): { label: string; family: string; ext: string } {
	const name = path.split("/").at(-1) ?? path;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	if (ext === "" || ext.length > 5) return { label: "", family: "grey", ext };
	return { label: ext.slice(0, 4).toUpperCase(), family: TYPE_FAMILIES[ext] ?? "grey", ext };
}

/** 双色 diff 比例条（GitHub 式）+ 加减行数；added/removed 全 0 时不渲染。 */
function DiffStat({ added, removed, mini = false }: { added: number; removed: number; mini?: boolean }): React.JSX.Element | null {
	if (added <= 0 && removed <= 0) return null;
	return (
		<span className={`owl-changes-sum${mini ? " is-mini" : ""}`}>
			<span className="owl-changes-bar" aria-hidden="true">
				{added > 0 && <span className="owl-changes-bar-add" style={{ flexGrow: added }} />}
				{removed > 0 && <span className="owl-changes-bar-del" style={{ flexGrow: removed }} />}
			</span>
			<span className="owl-changes-num">
				{added > 0 && <span className="add">+{added}</span>}
				{removed > 0 && <span className="del">−{removed}</span>}
			</span>
		</span>
	);
}

export function ReviewChangesCard({ files, cwd, client, sessionId, disabled = false, onOpenFile, onOpenReview }: ReviewChangesCardProps): React.JSX.Element {
	const t = useT();
	const copy = useUndoCopy();
	const api = useMemo(() => createSidebarApi(client), [client]);
	const [list, setList] = useState<DiffApprovalFileSummary[] | undefined>(undefined);
	const [loadError, setLoadError] = useState<string | undefined>();
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [diffText, setDiffText] = useState<ReadonlyMap<string, string[]>>(new Map());
	const [diffLoading, setDiffLoading] = useState<ReadonlySet<string>>(new Set());
	// 整卡默认收起。对话里只留一行「改了 N 个文件」，点开才看清单，避免摊在回答下面。
	const [collapsed, setCollapsed] = useState(true);
	// 展开集合的 ref 镜像：推送回调里免 stale closure
	const expandedRef = useRef<ReadonlySet<string>>(new Set());
	expandedRef.current = expanded;
	const toolCallIds = [...new Set(files.flatMap((file) => file.toolIds ?? [file.toolId]))];
	const contextKey = JSON.stringify([cwd, sessionId, toolCallIds]);
	const context = useRef(contextKey);
	context.current = contextKey;
	const listSequence = useRef(0);
	const diffSequence = useRef(new Map<string, number>());
	const readDiff = (entryIds: string[], key: string): void => {
		const identity = contextKey;
		const sequence = (diffSequence.current.get(key) ?? 0) + 1;
		diffSequence.current.set(key, sequence);
		setDiffLoading((previous) => new Set(previous).add(key));
		void Promise.all(entryIds.map((id) => api.diffApprovalDiff(cwd, id)))
			.then((results) => {
				if (context.current !== identity || diffSequence.current.get(key) !== sequence) return;
				setDiffText((previous) => new Map(previous).set(key, results.map((result) => result.diff)));
			})
			.catch((error: unknown) => {
				if (context.current !== identity || diffSequence.current.get(key) !== sequence) return;
				setLoadError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (context.current !== identity || diffSequence.current.get(key) !== sequence) return;
				setDiffLoading((previous) => { const next = new Set(previous); next.delete(key); return next; });
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
						const ids = matchingEntries(file, next).filter((entry) => entry.status === "pending").map((entry) => entry.id);
						if (ids.length > 0) readDiff(ids, file.path);
						else setExpanded((previous) => { const remaining = new Set(previous); remaining.delete(file.path); return remaining; });
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
		refresh();
		const offChanged = client.onDiffApprovalChanged((message) => {
			if (samePath(message.cwd, cwd)) refresh();
		});
		const offStatus = client.onStatus((connected) => { if (connected) refresh(); });
		return () => { ++listSequence.current; if (context.current === contextKey) context.current = ""; offChanged(); offStatus(); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [contextKey, client]);

	/** Tool provenance, never the path, determines which operations belong to this turn. */
	const matchingEntries = (artifact: FileArtifact, candidates = list ?? []): DiffApprovalFileSummary[] => {
		const ids = new Set(artifact.toolIds ?? [artifact.toolId]);
		return candidates.filter((entry) => entry.scope === "operation" && entry.toolCallId !== undefined && [...ids].some((id) => entry.toolCallId === id || entry.toolCallId?.startsWith(`${id}/`)) && (sessionId === undefined || entry.sessionId === sessionId) && (samePath(entry.displayPath, artifact.path) || samePath(entry.path, `${cwd}/${artifact.path}`))).sort((a, b) => a.baselineAt.localeCompare(b.baselineAt));
	};
	const entryFor = (artifact: FileArtifact): DiffApprovalFileSummary | undefined => {
		const entries = matchingEntries(artifact);
		const entry = entries[0];
		if (!entry) return undefined;
		return { ...entry, status: entries.some((item) => item.status === "pending") ? "pending" : entries.every((item) => item.status === "reverted") ? "reverted" : "kept", added: entries.reduce((n, item) => n + (item.added ?? 0), 0), removed: entries.reduce((n, item) => n + (item.removed ?? 0), 0) };
	};

	const tracked = files.map((file) => ({ file, entry: entryFor(file) })).filter((row) => row.entry !== undefined) as Array<{ file: FileArtifact; entry: DiffApprovalFileSummary }>;
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
		readDiff(matchingEntries(file).filter((entry) => entry.status === "pending").map((entry) => entry.id), key);
	};

	/** 头部批量撤销：只收本轮待审的条目（工作台里的「全部回滚」是全工作区口径）。 */
	const revertAll = (): void => {
		const ids = [...new Set(files.flatMap((file) => matchingEntries(file).filter((entry) => entry.status === "pending").map((entry) => entry.id)))];
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

	return (
		<section className={`owl-artifacts owl-changes-card${collapsed ? " is-collapsed" : ""}`} aria-label={t("chat.changesCount", { n: files.length })}>
			<header className="owl-changes-head">
				<button
					type="button"
					className="owl-changes-toggle"
					title={collapsed ? t("common.expand") : t("common.collapse")}
					aria-expanded={!collapsed}
					onClick={() => setCollapsed((value) => !value)}
				>
					<IconChevronDown size={12} className="owl-changes-caret" />
					<span className="owl-changes-head-icon" aria-hidden="true">
						<IconPencil size={13} />
					</span>
					<span className="owl-changes-head-text">
						<strong className="owl-changes-title">{t("chat.changesCount", { n: files.length })}</strong>
						<DiffStat added={totals.added} removed={totals.removed} />
					</span>
				</button>
				{tracked.some((row) => row.entry.status === "pending") && (
					<button type="button" className="owl-changes-revert-all" disabled={busy} title={copy.turn} onClick={revertAll}>
						{copy.turn}
						<IconUndo size={11} />
					</button>
				)}
				{tracked.length > 0 && (
					<button type="button" className="owl-changes-workbench" onClick={() => onOpenReview(tracked[0]!.entry.displayPath)}>
						{t("chat.reviewInWorkbench")}
						<IconChevronRight size={11} />
					</button>
				)}
			</header>
			{loadError && <div className="owl-undo-panel" role="alert">{copy.refreshing}: {loadError} <button type="button" onClick={refresh}>{t("common.retry")}</button></div>}
			<UndoReviewPanel review={undo} disabled={disabled} />
			{!collapsed && (
				<ul className="owl-changes-list">
					{files.map((file) => {
						const entry = entryFor(file);
						const name = file.path.split("/").at(-1) ?? file.path;
						const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
						const stats = entry ? statsOf(entry) : undefined;
						const isExpanded = entry !== undefined && expanded.has(file.path);
						const status = entry?.status;
						return (
							<li key={file.path} className={`owl-changes-item is-${status ?? "untracked"}${isExpanded ? " is-open" : ""}`}>
								<div className="owl-changes-row">
									{(() => {
										const type = fileTypeOf(file.path);
										const language = fileLanguageTitle(type.ext);
										if (language !== undefined) {
											return (
												<span className="owl-changes-lang" title={language} aria-hidden="true">
													<FileLanguageIcon ext={type.ext} />
												</span>
											);
										}
										return (
											<span className={`owl-changes-type t-${type.family}`} aria-hidden="true">
												{type.label === "" ? <IconFile size={10} /> : type.label}
											</span>
										);
									})()}
									<button type="button" className="owl-changes-file" title={entry?.path ?? file.path} onClick={() => openFileWithDiffContext(file, entry)}>
										<span className="owl-changes-name">{name}</span>
										{entry !== undefined && status === "pending" && entry.originalExisted === false && (
											<span className="owl-changes-badge-new">{t("review.created")}</span>
										)}
										{dir !== "" && <span className="owl-changes-dir">{dir}</span>}
									</button>
									{stats !== undefined && <DiffStat added={stats.added} removed={stats.removed} mini />}
									{status === "kept" && <span className="owl-changes-state">{t("review.keptBadge")}</span>}
									{status === "reverted" && <span className="owl-changes-state">{t("review.revertedBadge")}</span>}
									{entry !== undefined && status === "pending" && (
										<span className="owl-changes-actions">
											<button type="button" className="owl-changes-act is-review" onClick={() => toggleDiff(file)}>
												{isExpanded ? t("common.collapse") : t("chat.reviewCta")}
											</button>
											<button
												type="button"
												className="owl-changes-act is-revert"
												disabled={busy}
												title={copy.preview}
												onClick={() => void undo.requestPreview(matchingEntries(file).filter((item) => item.status === "pending").map((item) => item.id))}
											>
												<IconUndo size={10} />
												{copy.preview}
											</button>
										</span>
									)}
								</div>
								{entry === undefined && <p className="px-3 py-1 text-[11px] text-owl-faint">{copy.unavailable}</p>}
								<ArtifactActions path={file.path} title={file.title} cwd={cwd} client={client} />
								{isExpanded && entry !== undefined && (
									<div className="owl-changes-diff">
										{diffLoading.has(file.path) && (
											<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
												<IconLoader size={12} className="animate-spin" /> {t("changes.readingDiff")}
											</div>
										)}
										{!diffLoading.has(file.path) && diffText.get(file.path)?.map((text, index) => <DiffView key={`${file.path}:${index}`} text={text} />)}
									</div>
								)}
							</li>
						);
					})}
				</ul>
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
			<ReviewChangesCard files={changes} cwd={cwd} client={client} sessionId={sessionId} disabled={disabled} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />
			{others.length > 0 && <Artifacts artifacts={others} onOpenFile={onOpenFile} cwd={cwd} client={client} />}
		</>
	);
}
