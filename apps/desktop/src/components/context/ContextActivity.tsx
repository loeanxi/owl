/** 上下文事件与文件活动两张卡片（对齐 dsh-context 的 Context Events / File Activity）。 */
import { useMemo, useState } from "react";
import type { ContextEventKind, ContextEventRow, ContextFileOp } from "../../bridge/protocol.ts";
import { type FileEntry, type FileKind, fileBadgeOf, fileEntriesOf, fmtSigned, fmtTime, stamp } from "./context-model.ts";

const EVENT_KINDS: ContextEventKind[] = ["inject", "compact", "prune", "model", "mode"];
const KIND_LABEL: Record<ContextEventKind, string> = {
	inject: "注入",
	compact: "压缩",
	prune: "剪枝",
	model: "切换",
	mode: "模式",
};
const KIND_ICON: Record<ContextEventKind, string> = { inject: "+", compact: "✂", prune: "✂", model: "⇄", mode: "◐" };

export function EventsCard({
	events,
	onFocusEvent,
}: {
	events: ContextEventRow[];
	onFocusEvent: (event: ContextEventRow) => void;
}): React.JSX.Element {
	const [picked, setPicked] = useState<ContextEventKind[]>(EVENT_KINDS);
	const counts = useMemo(() => {
		const out: Record<ContextEventKind, number> = { inject: 0, compact: 0, prune: 0, model: 0, mode: 0 };
		for (const event of events) out[event.kind] += 1;
		return out;
	}, [events]);
	const toggleKind = (kind: ContextEventKind): void => {
		setPicked((current) => {
			if (current.length === EVENT_KINDS.length) return [kind];
			if (!current.includes(kind)) return [...current, kind];
			return current.length === 1 ? EVENT_KINDS : current.filter((value) => value !== kind);
		});
	};
	const shown = picked.length === EVENT_KINDS.length ? events : events.filter((event) => picked.includes(event.kind));
	return (
		<div className="ctx-card ctx-col">
			<div className="ctx-card-title">
				<span className="ctx-card-title-text">上下文事件</span>
				<div className="ctx-kinds">
					{EVENT_KINDS.map((kind) => (
						<button
							key={kind}
							type="button"
							className={`ctx-gran-btn${picked.includes(kind) ? " ctx-gran-on" : ""}`}
							onClick={() => toggleKind(kind)}
						>
							{KIND_LABEL[kind]}
							<span className="ctx-kind-n">{counts[kind]}</span>
						</button>
					))}
				</div>
			</div>
			{shown.length === 0 ? (
				<div className="ctx-lane ctx-lane-tall">
					<span className="ctx-empty">暂无上下文事件（注入、压缩、模型切换会出现在这里）</span>
				</div>
			) : (
				<div className="ctx-events">
					{shown.map((event, index) => {
						const jumpable = event.kind === "inject" && event.seq !== undefined;
						return (
							<div key={`${event.ts}-${index}`} className="ctx-event">
								<span className={`ctx-event-icon ctx-event-${event.kind}`}>{KIND_ICON[event.kind]}</span>
								<span className={`ctx-kind ctx-kind-${event.kind}`}>{KIND_LABEL[event.kind]}</span>
								{jumpable ? (
									<button type="button" className="ctx-event-label ctx-event-jump" title={event.label} onClick={() => onFocusEvent(event)}>
										{event.label}
									</button>
								) : (
									<span className="ctx-event-label" title={event.label}>
										{event.label}
									</span>
								)}
								{event.turn !== undefined && event.step !== undefined && (
									<span className="ctx-event-at">{stamp(event.turn, event.step)}</span>
								)}
								{event.delta !== undefined && event.delta !== 0 && (
									<span className={`ctx-event-tokens${event.delta > 0 ? " ctx-up" : ""}`}>{fmtSigned(event.delta)}</span>
								)}
								<span className="ctx-event-time">{fmtTime(event.ts)}</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

const FILE_KINDS: Array<{ key: FileKind | "all"; label: string }> = [
	{ key: "all", label: "全部" },
	{ key: "read", label: "读取" },
	{ key: "write", label: "写入" },
	{ key: "search", label: "搜索" },
	{ key: "image", label: "图片" },
];

type FileSort = "count" | "latest" | "path";

function opDetail(op: ContextFileOp): string {
	const parts: string[] = [];
	if (op.lines) parts.push(`第 ${op.lines[0]}–${op.lines[1]} 行`);
	if (op.pattern) parts.push(op.pattern);
	if (op.added || op.removed) parts.push(`+${op.added ?? 0} −${op.removed ?? 0}`);
	return parts.join(" · ");
}

export function FilesCard({
	files,
	cwd,
	upTo,
	scope,
	onLocate,
}: {
	files: ContextFileOp[];
	cwd: string;
	/** 只统计 seq ≤ upTo 的操作（跟随趋势图的选择）；缺省为全部。 */
	upTo?: number;
	scope: string;
	onLocate: (op: ContextFileOp) => void;
}): React.JSX.Element {
	const [kind, setKind] = useState<FileKind | "all">("all");
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<FileSort>("count");
	const [open, setOpen] = useState<Set<string>>(() => new Set());
	const entries = useMemo(() => fileEntriesOf(files, cwd, upTo), [files, cwd, upTo]);
	const kindFiles = useMemo(() => {
		const out: Record<FileKind | "all", number> = { all: entries.length, read: 0, write: 0, search: 0, image: 0 };
		for (const entry of entries) for (const key of ["read", "write", "search", "image"] as FileKind[]) if (entry.counts[key] > 0) out[key] += 1;
		return out;
	}, [entries]);
	const shown = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const opsOf = (entry: FileEntry): number => (kind === "all" ? entry.ops.length : entry.counts[kind]);
		return entries
			.filter((entry) => kind === "all" || entry.counts[kind] > 0)
			.filter((entry) => !needle || entry.path.toLowerCase().includes(needle))
			.sort((a, b) =>
				sort === "path"
					? a.path.localeCompare(b.path)
					: sort === "latest"
						? b.latest - a.latest
						: opsOf(b) - opsOf(a) || b.latest - a.latest,
			);
	}, [entries, kind, query, sort]);
	const added = shown.reduce((sum, entry) => sum + entry.added, 0);
	const removed = shown.reduce((sum, entry) => sum + entry.removed, 0);

	return (
		<div className="ctx-card ctx-col">
			<div className="ctx-card-title">
				<span className="ctx-card-title-text">文件活动</span>
				<span className="ctx-card-sub">{scope}</span>
			</div>
			<div className="ctx-fa-ctl">
				<div className="ctx-gran">
					{FILE_KINDS.map((option) => (
						<button
							key={option.key}
							type="button"
							className={`ctx-gran-btn ctx-fa-chip-${option.key}${kind === option.key ? " ctx-gran-on" : ""}`}
							onClick={() => setKind(option.key)}
						>
							{option.label}
							<span className="ctx-fa-n">{kindFiles[option.key]}</span>
						</button>
					))}
				</div>
				<input className="ctx-search" value={query} placeholder="按路径过滤…" onChange={(event) => setQuery(event.target.value)} />
			</div>
			<div className="ctx-fa-meta">
				<span>{shown.length} 个文件</span>
				{(added > 0 || removed > 0) && (
					<span className="ctx-fa-delta" title="按 edit/write 调用参数估算的累计行数变化：+ 新增 / − 删除">
						<span className="ctx-fa-up">+{added}</span>
						<span className="ctx-fa-down">−{removed}</span>
					</span>
				)}
				<div className="ctx-gran" title="文件排序：按操作次数、最近操作时间或路径">
					{(
						[
							["count", "按次数"],
							["latest", "按最新"],
							["path", "按路径"],
						] as const
					).map(([key, label]) => (
						<button key={key} type="button" className={`ctx-gran-btn${sort === key ? " ctx-gran-on" : ""}`} onClick={() => setSort(key)}>
							{label}
						</button>
					))}
				</div>
			</div>
			{shown.length === 0 ? (
				<div className="ctx-lane ctx-lane-tall">
					<span className="ctx-empty">{entries.length === 0 ? "该范围内没有文件读取、写入或搜索操作" : "没有匹配当前过滤条件的文件"}</span>
				</div>
			) : (
				<div className="ctx-fa-list">
					{shown.map((entry) => {
						const isOpen = open.has(entry.path);
						const badge = fileBadgeOf(entry);
						return (
							<div key={entry.path} className={`ctx-fa-item${isOpen ? " ctx-fa-item-on" : ""}`}>
								<button
									type="button"
									className="ctx-fa-row"
									onClick={() =>
										setOpen((current) => {
											const next = new Set(current);
											if (next.has(entry.path)) next.delete(entry.path);
											else next.add(entry.path);
											return next;
										})
									}
								>
									<span className={`ctx-br-chev${isOpen ? " ctx-br-chev-on" : ""}`} />
									<span className="ctx-fa-form">
										{badge.glyph ?? (
											<span className="ctx-fa-lang" style={{ background: badge.color, color: "#fff" }}>
												{badge.text}
											</span>
										)}
									</span>
									<span className="ctx-fa-path" title={entry.path}>
										<em>{entry.display.dir}</em>
										<b>{entry.display.base}</b>
									</span>
									<span className="ctx-fa-badges">
										{entry.counts.read > 0 && (
											<span className="ctx-fa-badge ctx-fa-b-read" title="读取">
												<i />
												{entry.counts.read}
											</span>
										)}
										{entry.counts.write > 0 && (
											<span className="ctx-fa-badge ctx-fa-b-write" title="写入">
												<i />
												{entry.counts.write}
											</span>
										)}
										{entry.counts.search > 0 && (
											<span className="ctx-fa-badge ctx-fa-b-search" title="搜索">
												<i />
												{entry.counts.search}
											</span>
										)}
										{entry.counts.image > 0 && (
											<span className="ctx-fa-badge ctx-fa-b-image" title="图片">
												<i />
												{entry.counts.image}
											</span>
										)}
										{entry.errors > 0 && <i className="ctx-err-dot" title={`${entry.errors} 次失败`} />}
									</span>
									{(entry.added > 0 || entry.removed > 0) && (
										<span className="ctx-fa-delta">
											{entry.added > 0 && <span className="ctx-fa-up">+{entry.added}</span>}
											{entry.removed > 0 && <span className="ctx-fa-down">−{entry.removed}</span>}
										</span>
									)}
									<span className="ctx-fa-time">{fmtTime(entry.latest)}</span>
								</button>
								{isOpen && (
									<div className="ctx-fa-ops">
										{[...entry.ops]
											.sort((a, b) => b.ts - a.ts)
											.map((op, index) => (
												<button
													key={`${op.callId ?? op.ts}-${index}`}
													type="button"
													className="ctx-fa-op ctx-fa-op-link"
													title="在上下文浏览器中查看此次操作"
													onClick={() => onLocate(op)}
												>
													{!op.ok && <i className="ctx-err-dot" />}
													<span className="ctx-fa-op-tool">{op.tool}</span>
													<span className="ctx-fa-op-detail">{opDetail(op)}</span>
													<span className="ctx-fa-op-time">{fmtTime(op.ts)}</span>
												</button>
											))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}