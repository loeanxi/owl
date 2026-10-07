/**
 * 轨迹视图 —— 当前会话的「事件台账 + 时间轴」，占据主对话区
 * （顶栏「对话/上下文/轨迹」tab 切换，见 App.tsx 的 conversationView）。
 *
 * 架构移植自 DeepSeek Harness 的 packages/client/ui-trajectory：
 * 视图是纯投影 —— trajectory-layout 把会话转录折叠成 轮次/分组/单元格，
 * trajectory-timeline 把单元格投影成「输入/模型/工具」三车道时间轴；
 * 这里只负责呈现：顶栏统计（时长/轮次/调用）、搜索、时间轴（节奏/时序
 * 两种投影，点击 span 定位台账行）、按轮次分组的事件台账（点行展开
 * 参数/输出/思考详情）。数据全部来自已挂在 App 上的 entries，不另行取数。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEntry } from "../../hooks/transcript.ts";
import { useT } from "../../i18n/index.ts";
import { IconSearch } from "../../sidebar/icons.tsx";
import type { TrajectoryCell, TrajectoryCellKind, TrajectoryGroupModel, TrajectorySnapshot, TrajectoryTurnModel, TrajectoryUsage } from "./trajectory-contract.ts";
import { deriveTrajectoryLayout, formatSpanSeconds } from "./trajectory-layout.ts";
import { deriveTrajectoryTimeline, type TrajectoryTimelineMode, type TrajectoryTimelineModel } from "./trajectory-timeline.ts";
import "./trajectory.css";

const KIND_COLORS: Record<TrajectoryCellKind, string> = {
	user: "#e0a33e",
	message: "#41c463",
	tool: "#f0883e",
	subtool: "#c77dff",
};

const LANE_KEYS = ["trajectory.laneInput", "trajectory.laneModel", "trajectory.laneTool"] as const;

const MODE_KEY = "owl.trajectory.mode";

function fmtClock(ts: number): string {
	const date = new Date(ts);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

/** 单元格在当前搜索词下是否命中（空词全命中）。 */
function cellMatches(cell: TrajectoryCell, query: string): boolean {
	if (query === "") return true;
	return [cell.title, cell.summary, cell.preview, cell.resultPreview, cell.outputDetail, cell.thinkingDetail, cell.inputDetail]
		.filter((part) => typeof part === "string")
		.join("\n")
		.toLowerCase()
		.includes(query);
}

export function TrajectoryView({ entries, active }: {
	entries: readonly ChatEntry[];
	/** 视图是否可见（隐藏时跳过滚动跟随）。 */
	active: boolean;
}): React.JSX.Element {
	const t = useT();
	const snapshot = useMemo(() => deriveTrajectoryLayout(entries), [entries]);
	const [mode, setMode] = useState<TrajectoryTimelineMode>(() =>
		localStorage.getItem(MODE_KEY) === "actual" ? "actual" : "sequence",
	);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [highlight, setHighlight] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	const timeline = useMemo(() => deriveTrajectoryTimeline(snapshot.turns, mode), [snapshot, mode]);
	const queryLower = query.trim().toLowerCase();
	const matchCount = useMemo(() => countMatches(snapshot, queryLower), [snapshot, queryLower]);

	const toggleRow = (recordId: string): void => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(recordId)) next.delete(recordId);
			else next.add(recordId);
			return next;
		});
	};

	const locateRecord = (recordId: string): void => {
		const root = scrollRef.current;
		if (root === null) return;
		const row = root.querySelector<HTMLElement>(`[data-record-id="${CSS.escape(recordId)}"]`);
		if (row === null) return;
		row.scrollIntoView({ block: "center", behavior: "smooth" });
		setHighlight(recordId);
	};

	// 流式跟随尾部：entries 追加时若用户本就贴着底部，则跟着滚到底（向上翻阅时打扰）。
	const tail = entries.at(-1);
	useEffect(() => {
		const root = scrollRef.current;
		if (!active || root === null || tail === undefined) return;
		const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 120;
		if (nearBottom) root.scrollTop = root.scrollHeight;
	}, [active, tail]);

	const switchMode = (next: TrajectoryTimelineMode): void => {
		setMode(next);
		localStorage.setItem(MODE_KEY, next);
	};

	const { stats } = snapshot;

	return (
		<div className="owl-trajectory" data-active={active ? "true" : "false"}>
			<div className="owl-trajectory-toolbar">
				<span
					className="owl-trajectory-stat"
					title={t("trajectory.usageTitle", {
						input: fmtTokens(stats.tokens.input),
						output: fmtTokens(stats.tokens.output),
						cacheRead: fmtTokens(stats.tokens.cacheRead),
						cacheWrite: fmtTokens(stats.tokens.cacheWrite),
					})}
				>
					{t("trajectory.statsDuration")}
					<b>{stats.durationMs !== null ? formatSpanSeconds(stats.durationMs / 1000) : "—"}</b>
				</span>
				<span className="owl-trajectory-stat">{t("trajectory.statsTurns")}<b>{stats.turns}</b></span>
				<span className="owl-trajectory-stat">{t("trajectory.statsCalls")}<b>{stats.calls}</b></span>
				{matchCount >= 0 && <span className="owl-trajectory-matchcount">{t("trajectory.matchCount", { count: matchCount })}</span>}
				<label className="owl-trajectory-search">
					<IconSearch size={12} />
					<input
						type="text"
						value={query}
						placeholder={t("trajectory.searchPlaceholder")}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>
			</div>
			{timeline === null ? (
				<div className="owl-trajectory-empty">
					<p>{t("trajectory.empty")}</p>
					<p className="owl-trajectory-empty-hint">{t("trajectory.emptyHint")}</p>
				</div>
			) : (
				<>
					<div className="owl-trajectory-overview">
						<button
							type="button"
							className="owl-trajectory-mode"
							title={t("trajectory.modeToggle")}
							onClick={() => switchMode(mode === "sequence" ? "actual" : "sequence")}
						>
							{mode === "sequence" ? t("trajectory.modeSequence") : t("trajectory.modeActual")}
						</button>
						<TrajectoryTimelineChart timeline={timeline} query={queryLower} onPick={locateRecord} />
					</div>
					<div className="owl-trajectory-ledger" ref={scrollRef}>
						{snapshot.turns.map((turn) => (
							<TrajectoryTurnSection
								key={turn.turn}
								turn={turn}
								query={queryLower}
								expanded={expanded}
								highlight={highlight}
								onToggle={toggleRow}
							/>
						))}
					</div>
				</>
			)}
		</div>
	);
}

function countMatches(snapshot: TrajectorySnapshot, query: string): number {
	if (query === "") return -1;
	let count = 0;
	for (const turn of snapshot.turns) {
		for (const group of turn.groups) {
			for (const cell of group.cells) {
				if (cellMatches(cell, query)) count += 1;
			}
		}
	}
	return count;
}

/** 三车道时间轴：输入 / 模型 / 工具。hover 出时钟与耗时，点击定位台账行；搜索命中外的 span 减淡。 */
function TrajectoryTimelineChart({ timeline, query, onPick }: {
	timeline: TrajectoryTimelineModel;
	query: string;
	onPick: (recordId: string) => void;
}): React.JSX.Element {
	const t = useT();
	const lanes = [0, 1, 2];
	const span = Math.max(timeline.end - timeline.start, 1);
	const matchSet = useMemo(() => {
		if (query === "") return null;
		return new Set(timeline.spans.filter((s) => cellMatches(s.cell, query)).map((s) => s.index));
	}, [timeline, query]);
	const boundaries = useMemo(
		() => timeline.turnBoundaries.map((boundary) => ((boundary.position - timeline.start) / span) * 100),
		[timeline, span],
	);

	return (
		<div className="owl-trajectory-chart" role="img" aria-label={t("app.viewTrajectory")}>
			<div className="owl-trajectory-lanes" aria-hidden="true">
				{lanes.map((lane) => (
					<span key={lane} className="owl-trajectory-lane-label">{t(LANE_KEYS[lane]!)}</span>
				))}
			</div>
			<svg
				className="owl-trajectory-chart-svg"
				viewBox="0 0 100 46"
				preserveAspectRatio="none"
			>
				{boundaries.map((x, index) => (
					<line
						key={index}
						x1={x}
						x2={x}
						y1={0}
						y2={46}
						className="owl-trajectory-boundary"
					/>
				))}
				{lanes.map((lane) => (
					<g key={lane}>
						{timeline.spans.filter((s) => s.lane === lane).map((s) => {
							const dimmed = matchSet !== null && !matchSet.has(s.index);
							const x = ((s.start - timeline.start) / span) * 100;
							const width = Math.max(((s.end - s.start) / span) * 100, 0.4);
							return (
								<rect
									key={s.recordId}
									className="owl-trajectory-span"
									x={x}
									y={2 + lane * 15}
									width={width}
									height={10}
									rx={1.5}
									fill={KIND_COLORS[s.kind]}
									opacity={dimmed ? 0.14 : s.isActive ? 0.7 : 0.92}
									onClick={() => onPick(s.recordId)}
								>
									<title>{spanTooltip(s)}</title>
								</rect>
							);
						})}
					</g>
				))}
			</svg>
		</div>
	);

	/** hover 提示：名称 + 时钟 + 自身耗时（节奏图给不出时钟就只给名称与耗时）。 */
	function spanTooltip(s: (typeof timeline)["spans"][number]): string {
		const parts = [s.label];
		const startedAt = s.cell.startedAt;
		if (startedAt !== null) parts.push(fmtClock(startedAt));
		if (s.cell.timeSeconds !== null) parts.push(formatSpanSeconds(s.cell.timeSeconds));
		else if (s.isActive) parts.push(t("trajectory.running"));
		return parts.join(" · ");
	}
}

/** 一轮：sticky 轮头 + 分组台账。 */
function TrajectoryTurnSection({ turn, query, expanded, highlight, onToggle }: {
	turn: TrajectoryTurnModel;
	query: string;
	expanded: ReadonlySet<string>;
	highlight: string | null;
	onToggle: (recordId: string) => void;
}): React.JSX.Element | null {
	const t = useT();
	const visibleGroups = turn.groups.map((group) => ({
		group,
		cells: group.cells.filter((cell) => cellMatches(cell, query)),
	})).filter(({ cells }) => cells.length > 0);
	if (visibleGroups.length === 0) return null;
	const times: string[] = [];
	if (turn.startedAt !== null) times.push(fmtClock(turn.startedAt));
	if (turn.endedAt !== null && turn.endedAt !== turn.startedAt) times.push(fmtClock(turn.endedAt));
	return (
		<section className="owl-trajectory-turn">
			<header className="owl-trajectory-turn-head">
				<span className="owl-trajectory-turn-label">{t("trajectory.turnLabel", { turn: turn.turn })}</span>
				{times.length > 0 && <span className="owl-trajectory-turn-time">{times.join(" → ")}</span>}
			</header>
			{visibleGroups.map(({ group, cells }) => (
				<TrajectoryGroupSection
					key={group.title}
					group={group}
					cells={cells}
					expanded={expanded}
					highlight={highlight}
					onToggle={onToggle}
				/>
			))}
		</section>
	);
}

/** 一组：组头（消息 / 步骤 N + 墙钟与工具直方图）+ 单元格行。 */
function TrajectoryGroupSection({ group, cells, expanded, highlight, onToggle }: {
	group: TrajectoryGroupModel;
	cells: readonly TrajectoryCell[];
	expanded: ReadonlySet<string>;
	highlight: string | null;
	onToggle: (recordId: string) => void;
}): React.JSX.Element {
	return (
		<div className="owl-trajectory-group">
			{group.description !== undefined && (
				<div className="owl-trajectory-group-head">
					<span>{group.title}</span>
					<span className="owl-trajectory-group-desc">{group.description}</span>
				</div>
			)}
			{cells.map((cell) => (
				<TrajectoryCellRow
					key={cell.recordId}
					cell={cell}
					expanded={expanded.has(cell.recordId)}
					highlighted={highlight === cell.recordId}
					onToggle={onToggle}
				/>
			))}
		</div>
	);
}

/** 台账一行：kind 徽标 + 预览 + 耗时/状态；点行展开参数/输出/思考详情。 */
function TrajectoryCellRow({ cell, expanded, highlighted, onToggle }: {
	cell: TrajectoryCell;
	expanded: boolean;
	highlighted: boolean;
	onToggle: (recordId: string) => void;
}): React.JSX.Element {
	const t = useT();
	const hasDetail = cell.inputDetail !== undefined || cell.outputDetail !== undefined || cell.thinkingDetail !== undefined;
	const kindLabel = cell.kind === "user"
		? t("trajectory.cellUser")
		: cell.kind === "message"
			? t("trajectory.cellAssistant")
			: t("trajectory.cellTool");
	return (
		<div
			className={
				"owl-trajectory-row" +
				(cell.isError === true ? " is-error" : "") +
				(cell.cancelled === true ? " is-cancelled" : "") +
				(highlighted ? " is-highlight" : "")
			}
			data-record-id={cell.recordId}
			data-kind={cell.kind}
			onClick={hasDetail ? () => onToggle(cell.recordId) : undefined}
			role={hasDetail ? "button" : undefined}
			tabIndex={hasDetail ? 0 : undefined}
			onKeyDown={hasDetail ? (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onToggle(cell.recordId);
				}
			} : undefined}
		>
			<span className="owl-trajectory-row-kind" style={{ color: KIND_COLORS[cell.kind] }}>
				{cell.kind === "tool" || cell.kind === "subtool" ? cell.title : kindLabel}
			</span>
			<span className="owl-trajectory-row-main">
				{cell.kind === "tool" || cell.kind === "subtool" ? (
					<>
						{cell.summary !== undefined && <span className="owl-trajectory-row-summary">{cell.summary}</span>}
						{cell.preview !== undefined && <code className="owl-trajectory-row-args">{truncate(cell.preview, 160)}</code>}
						{cell.resultPreview !== undefined && <span className="owl-trajectory-row-result">→ {truncate(cell.resultPreview, 120)}</span>}
					</>
				) : (
					<span className="owl-trajectory-row-text">{truncate(cell.preview ?? "", 240)}</span>
				)}
				{expanded && (
					<div className="owl-trajectory-detail" onClick={(event) => event.stopPropagation()}>
						{cell.thinkingDetail !== undefined && <DetailBlock label={t("trajectory.detailThinking")} text={cell.thinkingDetail} className="is-thinking" />}
						{cell.inputDetail !== undefined && <DetailBlock label={t("trajectory.detailArgs")} text={cell.inputDetail} />}
						{cell.outputDetail !== undefined && <DetailBlock label={t("trajectory.detailOutput")} text={cell.outputDetail} />}
						{cell.usage !== undefined && <TrajectoryCellUsage usage={cell.usage} />}
					</div>
				)}
			</span>
			<span className="owl-trajectory-row-meta">
				{cell.isError === true && <em className="owl-trajectory-badge is-error">{t("trajectory.failed")}</em>}
				{cell.cancelled === true && <em className="owl-trajectory-badge">{t("trajectory.cancelled")}</em>}
				{cell.streaming === true && <em className="owl-trajectory-badge is-running">{t("trajectory.running")}</em>}
				{cell.timeSeconds !== null && <span className="owl-trajectory-row-duration">{formatSpanSeconds(cell.timeSeconds)}</span>}
			</span>
		</div>
	);
}

function DetailBlock({ label, text, className }: {
	label: string;
	text: string;
	className?: string;
}): React.JSX.Element {
	return (
		<div className={"owl-trajectory-detail-block" + (className !== undefined ? ` ${className}` : "")}>
			<span className="owl-trajectory-detail-label">{label}</span>
			<pre>{text}</pre>
		</div>
	);
}

function TrajectoryCellUsage({ usage }: { usage: TrajectoryUsage }): React.JSX.Element {
	const t = useT();
	return (
		<p className="owl-trajectory-usage">
			{t("trajectory.usageTitle", {
				input: fmtTokens(usage.input),
				output: fmtTokens(usage.output),
				cacheRead: fmtTokens(usage.cacheRead),
				cacheWrite: fmtTokens(usage.cacheWrite),
			})}
		</p>
	);
}

function truncate(text: string, max: number): string {
	const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}
