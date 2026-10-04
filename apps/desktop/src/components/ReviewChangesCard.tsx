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
import { DiffView } from "../sidebar/DiffView.tsx";
import type { FileArtifact } from "../hooks/artifacts.ts";
import { t, useT } from "../i18n/index.ts";
import { Artifacts } from "./Artifacts.tsx";
import { IconChevronDown, IconChevronRight, IconFile, IconLoader, IconPencil, IconUndo } from "../sidebar/icons.tsx";

export interface ReviewChangesCardProps {
	/** 本轮 write/edit 产物（工作区相对 POSIX 路径）。 */
	files: readonly FileArtifact[];
	cwd: string;
	client: BridgeClient;
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

function fileTypeOf(path: string): { label: string; family: string } {
	const name = path.split("/").at(-1) ?? path;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	if (ext === "" || ext.length > 5) return { label: "", family: "grey" };
	return { label: ext.slice(0, 4).toUpperCase(), family: TYPE_FAMILIES[ext] ?? "grey" };
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

export function ReviewChangesCard({ files, cwd, client, onOpenFile, onOpenReview }: ReviewChangesCardProps): React.JSX.Element {
	const t = useT();
	const api = useMemo(() => createSidebarApi(client), [client]);
	const [list, setList] = useState<DiffApprovalFileSummary[] | undefined>(undefined);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [diffText, setDiffText] = useState<ReadonlyMap<string, string>>(new Map());
	const [diffLoading, setDiffLoading] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	// 整卡折叠：只收文件清单，头部（计数 + 统计 + 工作台入口）保持可见
	const [collapsed, setCollapsed] = useState(false);
	// 展开集合的 ref 镜像：推送回调里免 stale closure
	const expandedRef = useRef<ReadonlySet<string>>(new Set());
	expandedRef.current = expanded;

	const refresh = (): void => {
		void api
			.diffApprovalList(cwd)
			.then((next) => {
				setList(next);
				// 已展开的 diff 随推送刷新（外部改动/二次编辑后的活口径）
				for (const id of expandedRef.current) {
					void api
						.diffApprovalDiff(cwd, id)
						.then((result) => setDiffText((prev) => new Map(prev).set(id, result.diff)))
						.catch(() => undefined);
				}
			})
			.catch(() => setList(undefined));
	};

	useEffect(() => {
		refresh();
		return client.onDiffApprovalChanged((message) => {
			if (samePath(message.cwd, cwd)) refresh();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd, client]);

	/** 产物路径（工作区相对）→ 待审条目；匹配不上（shell 写的/已清记录）就没有行内操作。 */
	const entryFor = (artifact: FileArtifact): DiffApprovalFileSummary | undefined =>
		list?.find((entry) => samePath(entry.displayPath, artifact.path) || samePath(entry.path, `${cwd}/${artifact.path}`));

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

	const toggleDiff = (entryId: string): void => {
		if (expanded.has(entryId)) {
			const next = new Set(expanded);
			next.delete(entryId);
			setExpanded(next);
			return;
		}
		setExpanded(new Set(expanded).add(entryId));
		if (diffText.has(entryId)) return;
		setDiffLoading(new Set(diffLoading).add(entryId));
		void api
			.diffApprovalDiff(cwd, entryId)
			.then((result) => setDiffText(new Map(diffText).set(entryId, result.diff)))
			.catch((error: unknown) => setDiffText(new Map(diffText).set(entryId, `${error instanceof Error ? error.message : String(error)}`)))
			.finally(() => {
				const next = new Set(diffLoading);
				next.delete(entryId);
				setDiffLoading(next);
			});
	};

	const revert = (entryId: string): void => {
		setBusy(true);
		const next = new Set(expanded);
		next.delete(entryId);
		setExpanded(next);
		void api
			.diffApprovalResolve(cwd, [entryId], "revert")
			.catch(() => undefined)
			.finally(() => {
				setBusy(false);
				refresh();
			});
	};

	/** 头部批量撤销：只收本轮待审的条目（工作台里的「全部回滚」是全工作区口径）。 */
	const revertAll = (): void => {
		const ids = tracked.filter((row) => row.entry.status === "pending").map((row) => row.entry.id);
		if (ids.length === 0) return;
		if (!window.confirm(t("review.revertAllConfirm", { n: ids.length }))) return;
		setBusy(true);
		const next = new Set(expanded);
		for (const id of ids) next.delete(id);
		setExpanded(next);
		void api
			.diffApprovalResolve(cwd, ids, "revert")
			.catch(() => undefined)
			.finally(() => {
				setBusy(false);
				refresh();
			});
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
					<button type="button" className="owl-changes-revert-all" disabled={busy} title={t("review.revertAll")} onClick={revertAll}>
						{t("review.revertAll")}
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
			{!collapsed && (
				<ul className="owl-changes-list">
					{files.map((file) => {
						const entry = entryFor(file);
						const name = file.path.split("/").at(-1) ?? file.path;
						const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
						const stats = entry ? statsOf(entry) : undefined;
						const isExpanded = entry !== undefined && expanded.has(entry.id);
						const status = entry?.status;
						return (
							<li key={file.path} className={`owl-changes-item is-${status ?? "untracked"}${isExpanded ? " is-open" : ""}`}>
								<div className="owl-changes-row">
									{(() => {
										const type = fileTypeOf(file.path);
										return (
											<span className={`owl-changes-type t-${type.family}`} aria-hidden="true">
												{type.label === "" ? <IconFile size={10} /> : type.label}
											</span>
										);
									})()}
									<button type="button" className="owl-changes-file" title={entry?.path ?? file.path} onClick={() => onOpenFile(file.path)}>
										<span className="owl-changes-name">{name}</span>
										{entry !== undefined && status === "pending" && entry.originalExisted === false && (
											<span className="owl-changes-badge-new">{t("review.created")}</span>
										)}
										{dir !== "" && <span className="owl-changes-dir">{dir}</span>}
									</button>
									{status === "kept" && <span className="owl-changes-state">{t("review.keptBadge")}</span>}
									{status === "reverted" && <span className="owl-changes-state">{t("review.revertedBadge")}</span>}
									{entry !== undefined && status === "pending" && (
										<span className="owl-changes-actions">
											<button type="button" className="owl-changes-act is-review" onClick={() => toggleDiff(entry.id)}>
												{isExpanded ? t("common.collapse") : t("chat.reviewCta")}
											</button>
											<button
												type="button"
												className="owl-changes-act is-revert"
												disabled={busy}
												title={t("review.revert")}
												onClick={() => revert(entry.id)}
											>
												<IconUndo size={10} />
												{t("chat.revertEdit")}
											</button>
										</span>
									)}
									{stats !== undefined && <DiffStat added={stats.added} removed={stats.removed} mini />}
								</div>
								{isExpanded && entry !== undefined && (
									<div className="owl-changes-diff">
										{diffLoading.has(entry.id) && (
											<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
												<IconLoader size={12} className="animate-spin" /> {t("changes.readingDiff")}
											</div>
										)}
										{!diffLoading.has(entry.id) && diffText.get(entry.id) !== undefined && <DiffView text={diffText.get(entry.id)!} />}
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
	onOpenFile,
	onOpenReview,
}: {
	artifacts: readonly FileArtifact[];
	cwd?: string;
	client?: BridgeClient;
	onOpenFile: (path: string) => void;
	onOpenReview?: (focusPath: string) => void;
}): React.JSX.Element | null {
	const changes = artifacts.filter((artifact) => artifact.action === "written" || artifact.action === "edited");
	const others = artifacts.filter((artifact) => artifact.action !== "written" && artifact.action !== "edited");
	if (changes.length === 0 || cwd === undefined || client === undefined || onOpenReview === undefined) {
		return <Artifacts artifacts={artifacts} onOpenFile={onOpenFile} />;
	}
	return (
		<>
			<ReviewChangesCard files={changes} cwd={cwd} client={client} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />
			{others.length > 0 && <Artifacts artifacts={others} onOpenFile={onOpenFile} />}
		</>
	);
}
