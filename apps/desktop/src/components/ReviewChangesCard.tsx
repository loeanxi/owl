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
import { IconLoader, IconPencil, IconUndo } from "../sidebar/icons.tsx";

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

export function ReviewChangesCard({ files, cwd, client, onOpenFile, onOpenReview }: ReviewChangesCardProps): React.JSX.Element {
	const t = useT();
	const api = useMemo(() => createSidebarApi(client), [client]);
	const [list, setList] = useState<DiffApprovalFileSummary[] | undefined>(undefined);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [diffText, setDiffText] = useState<ReadonlyMap<string, string>>(new Map());
	const [diffLoading, setDiffLoading] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
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

	return (
		<section className="owl-artifacts" aria-label={t("chat.changesCount", { n: files.length })}>
			<header className="flex items-center gap-2 px-1 pb-1">
				<IconPencil size={12} className="shrink-0 text-owl-faint" />
				<strong className="text-xs font-semibold text-owl-text">{t("chat.changesCount", { n: files.length })}</strong>
				{(totals.added > 0 || totals.removed > 0) && (
					<span className="font-mono text-[11px]">
						{totals.added > 0 && <span className="text-emerald-300/90">+{totals.added}</span>}
						{totals.added > 0 && totals.removed > 0 && <span className="text-owl-faint"> </span>}
						{totals.removed > 0 && <span className="text-red-300/90">−{totals.removed}</span>}
					</span>
				)}
				<span className="flex-1" />
				{tracked.length > 0 && (
					<button
						type="button"
						className="flex items-center gap-0.5 rounded px-1 text-[11px] text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
						onClick={() => onOpenReview(tracked[0]!.entry.displayPath)}
					>
						{t("chat.reviewInWorkbench")} →
					</button>
				)}
			</header>
			<ul className="owl-artifacts-list">
				{files.map((file) => {
					const entry = entryFor(file);
					const name = file.path.split("/").at(-1) ?? file.path;
					const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
					const stats = entry ? statsOf(entry) : undefined;
					const isExpanded = entry !== undefined && expanded.has(entry.id);
					return (
						<li key={file.path}>
							<div className={`rounded-lg border ${isExpanded ? "border-owl-border/60 bg-owl-panel/70" : "border-transparent"}`}>
								<div className="flex items-center gap-1.5 rounded-lg px-1 py-0.5 hover:bg-owl-hover/60">
									{entry === undefined ? (
										<span className="w-3 shrink-0 text-center text-[10px] text-owl-faint">·</span>
									) : entry.status === "pending" ? (
										<span className="w-3 shrink-0 text-center text-[10px] text-amber-300">•</span>
									) : entry.status === "kept" ? (
										<span className="w-3 shrink-0 text-center text-[10px] text-emerald-300/80">✓</span>
									) : (
										<span className="w-3 shrink-0 text-center text-[10px] text-owl-faint">↩</span>
									)}
									<button
										type="button"
										className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded text-left"
										title={entry?.path ?? file.path}
										onClick={() => onOpenFile(file.path)}
									>
										<span className="shrink-0 text-xs text-owl-text">{name}</span>
										{dir !== "" && <span className="min-w-0 truncate text-[10px] text-owl-faint">{dir}</span>}
									</button>
									{stats !== undefined && (stats.added > 0 || stats.removed > 0) && (
										<span className="shrink-0 font-mono text-[10px]">
											{stats.added > 0 && <span className="text-emerald-300/90">+{stats.added}</span>}
											{stats.added > 0 && stats.removed > 0 && <span className="text-owl-faint"> </span>}
											{stats.removed > 0 && <span className="text-red-300/90">−{stats.removed}</span>}
										</span>
									)}
									{entry !== undefined && entry.status !== "pending" && (
										<span className="shrink-0 text-[10px] text-owl-faint">{entry.status === "kept" ? t("review.keptBadge") : t("review.revertedBadge")}</span>
									)}
									{entry !== undefined && entry.status === "pending" && (
										<span className="flex shrink-0 items-center gap-0.5">
											<button
												type="button"
												className="rounded px-1.5 py-0.5 text-[11px] text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
												onClick={() => toggleDiff(entry.id)}
											>
												{isExpanded ? t("common.collapse") : t("chat.reviewCta")}
											</button>
											<button
												type="button"
												disabled={busy}
												title={t("review.revert")}
												className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-owl-muted transition-colors hover:bg-owl-hover hover:text-red-300 disabled:opacity-40"
												onClick={() => revert(entry.id)}
											>
												<IconUndo size={11} />
												{t("chat.revertEdit")}
											</button>
										</span>
									)}
								</div>
								{isExpanded && entry !== undefined && (
									<div className="max-h-72 overflow-auto border-t border-owl-border/40 px-1 py-1">
										{diffLoading.has(entry.id) && (
											<div className="flex items-center gap-2 px-2 py-1 text-xs text-owl-faint">
												<IconLoader size={12} className="animate-spin" /> {t("changes.readingDiff")}
											</div>
										)}
										{!diffLoading.has(entry.id) && diffText.get(entry.id) !== undefined && <DiffView text={diffText.get(entry.id)!} />}
									</div>
								)}
							</div>
						</li>
					);
				})}
			</ul>
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
