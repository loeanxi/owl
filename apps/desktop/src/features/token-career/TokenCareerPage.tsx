import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import { getUiLanguage, type TextKey, useT } from "../../i18n/index.ts";
import {
	agentColor,
	type Board,
	buildBoard,
	buildTrend,
	buildYearHeat,
	type CareerAgentUsage,
	type CareerGetResult,
	fetchCareer,
	fetchCareerSnapshot,
	formatTokens,
	OTHER_GROUP,
	shortDate,
	snapshotTime,
	type Trend,
	type TrendRange,
	type YearHeat,
} from "./token-career.ts";
import "./token-career.css";

/** 页面激活期间的后台增量刷新间隔（后端 mtime+size 缓存，增量一轮通常秒级）。 */
const CAREER_REFRESH_MS = 2 * 60_000;
/** Agent 构成默认展示的名次，其余折叠成「其他」。 */
const AGENTS_TOP = 6;
const MODELS_TOP = 8;
const MODELS_MAX = 30;

type Translate = (key: TextKey, vars?: Record<string, string | number>) => string;
type Fmt = (value: number) => string;
interface TipState {
	x: number;
	y: number;
	title: string;
	rows: { label: string; value: string; color?: string }[];
}
type ShowTip = (tip: TipState | null) => void;

const SOURCE_ORDER: CareerAgentUsage["status"][] = ["ok", "detected", "pending", "nodata", "unavailable"];

/**
 * 「我的 Token 生涯」看板：页头（Agent 筛选下拉 + 同步状态）+ 12 栅格卡片墙（同行等高）+ 底栏；
 * 数据源明细收在右侧抽屉。数据面是 owl-career 桥插件的 career.get
 * （packages/owl-career/src/career-stats.ts）；切 Agent / 趋势范围都是纯前端重算，不重拉桥。
 * 进入时先秒开上一次的结果快照，同时后台增量统计，回来后原地替换；激活期间定时再增量刷新。
 */
export function TokenCareerPage({ active, client }: { active: boolean; client: BridgeClient }): React.JSX.Element {
	const t = useT();
	const lang = getUiLanguage();
	const [data, setData] = useState<CareerGetResult>();
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const [filter, setFilter] = useState("");
	const [range, setRange] = useState<TrendRange>("90");
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [tip, setTip] = useState<TipState | null>(null);
	const snapshotRequested = useRef(false);
	const inflight = useRef(false);

	const sync = useCallback((): void => {
		if (inflight.current) return;
		inflight.current = true;
		setBusy(true);
		setFailed(false);
		fetchCareer(client)
			.then(setData)
			.catch(() => setFailed(true))
			.finally(() => {
				inflight.current = false;
				setBusy(false);
			});
	}, [client]);

	useEffect(() => {
		if (!active) return;
		if (!snapshotRequested.current) {
			snapshotRequested.current = true;
			fetchCareerSnapshot(client)
				.then((snapshot) => {
					if (snapshot) setData((current) => current ?? snapshot);
				})
				.catch(() => undefined);
		}
		sync();
		const timer = setInterval(sync, CAREER_REFRESH_MS);
		return () => clearInterval(timer);
	}, [active, client, sync]);

	useEffect(() => {
		if (!drawerOpen) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setDrawerOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [drawerOpen]);

	const agents = data?.agents ?? [];
	const board = useMemo(() => (data ? buildBoard(agents, filter) : null), [data, filter]);
	const trend = useMemo(() => (data ? buildTrend(agents, filter, range) : null), [data, filter, range]);
	const heat = useMemo(() => (board ? buildYearHeat(board.byDay) : null), [board]);
	const fmt: Fmt = (value) => formatTokens(value, lang);
	const nameOf = (id: string): string =>
		id === OTHER_GROUP ? t("career.other") : (agents.find((agent) => agent.id === id)?.name ?? id);
	const okCount = agents.filter((agent) => agent.status === "ok").length;

	return (
		<div className={`owl-career${active ? " is-active" : ""}`}>
			<div className="owl-career-head">
				<span className="owl-career-avatar" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
						<circle cx="12" cy="12" r="8" opacity="0.35" />
						<path d="M12 4a8 8 0 0 1 7.6 5.5" />
						<path d="M12 12V4" opacity="0.6" />
					</svg>
				</span>
				<h1>{t("titlebar.tokenCareer")}</h1>
				<span className="owl-career-spacer" />
				{data && <AgentPicker agents={agents} filter={filter} onPick={setFilter} fmt={fmt} t={t} />}
				<span
					className="owl-career-sync"
					data-status={busy ? "loading" : failed ? "error" : data ? "ready" : "idle"}
				>
					{busy && data
						? t("career.refreshing", { time: snapshotTime(data.generatedAt) })
						: busy
							? t("career.loading")
							: failed
								? t("career.loadFailed")
								: data
									? t("career.snapshot", { time: snapshotTime(data.generatedAt) })
									: ""}
					{!busy && (data || failed) && (
						<button type="button" onClick={sync} title={t("career.resync")} aria-label={t("career.resync")}>
							↻
						</button>
					)}
				</span>
			</div>

			<div className="owl-career-main">
				{!data && !failed && (
					<div className="owl-career-state">
						<p>{t("career.loading")}</p>
						<div className="bar">
							<i />
						</div>
					</div>
				)}
				{!data && failed && (
					<div className="owl-career-state">
						<p className="err">{t("career.loadFailed")}</p>
						<p>
							<button type="button" className="owl-career-linkbtn" onClick={sync}>
								{t("career.retry")}
							</button>
						</p>
					</div>
				)}
				{board && trend && heat && (
					<div className="owl-career-grid">
						<HeroCard
							board={board}
							scopeName={filter ? nameOf(filter) : t("career.agentAllOption")}
							fmt={fmt}
							t={t}
						/>
						<TrendCard
							trend={trend}
							range={range}
							onRange={setRange}
							nameOf={nameOf}
							fmt={fmt}
							t={t}
							onTip={setTip}
						/>
						<AgentsCard
							agents={agents}
							filter={filter}
							onPick={setFilter}
							onSources={() => setDrawerOpen(true)}
							fmt={fmt}
							t={t}
						/>
						<ModelsCard board={board} agents={agents} filter={filter} fmt={fmt} t={t} />
						<HeatCard heat={heat} lang={lang} fmt={fmt} t={t} onTip={setTip} />
						<MilestonesCard board={board} fmt={fmt} t={t} />
					</div>
				)}
			</div>

			<div className="owl-career-foot">
				<span className="owl-career-foot-src">{t("career.footSource")}</span>
				{data && (
					<span className="owl-career-foot-time">
						{t("career.footGenerated", { time: snapshotTime(data.generatedAt) })}
					</span>
				)}
				{data && (
					<button type="button" className="owl-career-foot-btn" onClick={() => setDrawerOpen(true)}>
						{t("career.sourcesButton", { ok: okCount, total: agents.length })}
					</button>
				)}
			</div>

			<div className={`owl-career-scrim${drawerOpen ? " is-open" : ""}`} onClick={() => setDrawerOpen(false)} />
			<SourcesDrawer
				open={drawerOpen}
				agents={agents}
				okCount={okCount}
				onClose={() => setDrawerOpen(false)}
				fmt={fmt}
				t={t}
			/>
			{tip && <HoverTip tip={tip} />}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 页头：Agent 筛选
// ---------------------------------------------------------------------------

function AgentPicker({
	agents,
	filter,
	onPick,
	fmt,
	t,
}: {
	agents: CareerAgentUsage[];
	filter: string;
	onPick: (id: string) => void;
	fmt: Fmt;
	t: Translate;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const root = useRef<HTMLDivElement>(null);
	const current = agents.find((agent) => agent.id === filter);
	const withUsage = [...agents]
		.filter((agent) => agent.totals.totalTokens > 0)
		.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);
	const without = agents.filter((agent) => agent.totals.totalTokens <= 0);
	const needle = query.trim().toLowerCase();
	const match = (agent: CareerAgentUsage): boolean => !needle || agent.name.toLowerCase().includes(needle);
	const total = withUsage.reduce((sum, agent) => sum + agent.totals.totalTokens, 0);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent): void => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const pick = (id: string): void => {
		onPick(id);
		setOpen(false);
		setQuery("");
	};
	const option = (agent: CareerAgentUsage): React.JSX.Element => (
		<button
			key={agent.id}
			type="button"
			className={filter === agent.id ? "is-on" : ""}
			onClick={() => pick(agent.id)}
		>
			<span className="sw" style={{ background: agentColor(agent.id) }} />
			<span className="nm">{agent.name}</span>
			<span className="meta">
				{agent.totals.totalTokens > 0 ? fmt(agent.totals.totalTokens) : "—"} ·{" "}
				{t("career.sessionsCount", { count: agent.sessions.toLocaleString() })}
			</span>
		</button>
	);

	return (
		<div className="owl-career-picker" ref={root}>
			<button
				type="button"
				className="owl-career-picker-btn"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
			>
				<span className="k">{t("career.agentLabel")}</span>
				{current && <span className="sw" style={{ background: agentColor(current.id) }} />}
				<span className="v">{current ? current.name : t("career.agentAll", { count: withUsage.length })}</span>
				{!current && <span className="caret">▾</span>}
			</button>
			{current && (
				<button
					type="button"
					className="owl-career-picker-clear"
					onClick={() => pick("")}
					title={t("career.clearFilter")}
					aria-label={t("career.clearFilter")}
				>
					✕
				</button>
			)}
			{open && (
				<div className="owl-career-menu">
					<input
						autoFocus
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("career.agentSearch")}
					/>
					<button type="button" className={!filter ? "is-on" : ""} onClick={() => pick("")}>
						<span className="nm">{t("career.agentAllOption")}</span>
						<span className="meta">{fmt(total)}</span>
					</button>
					{withUsage.some(match) && <div className="grp">{t("career.groupWithUsage")}</div>}
					{withUsage.filter(match).map(option)}
					{without.some(match) && <div className="grp">{t("career.groupNoUsage")}</div>}
					{without.filter(match).map(option)}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 总览：总量 + 构成条 + 六格指标
// ---------------------------------------------------------------------------

function pct(part: number, whole: number): string {
	if (whole <= 0) return "0%";
	const ratio = part / whole;
	return `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}%`;
}

function HeroCard({
	board,
	scopeName,
	fmt,
	t,
}: {
	board: Board;
	scopeName: string;
	fmt: Fmt;
	t: Translate;
}): React.JSX.Element {
	const totals = board.totals;
	const parts = [
		{ key: "in", label: t("career.mixInput"), value: totals.input, color: "var(--color-owl-accent)" },
		{ key: "out", label: t("career.mixOutput"), value: totals.output, color: "var(--owl-career-ink)" },
		{
			key: "cr",
			label: t("career.mixCacheRead"),
			value: totals.cacheRead,
			color: "color-mix(in srgb, var(--color-owl-accent) 38%, var(--color-owl-panel))",
		},
		{ key: "cw", label: t("career.mixCacheWrite"), value: totals.cacheWrite, color: "var(--owl-career-other)" },
	].filter((part) => part.value > 0);
	const peakRatio =
		board.peak && board.avgPerDay > 0 ? Math.max(1, Math.round(board.peak.tokens / board.avgPerDay)) : 0;
	const topModel = board.models[0];
	return (
		<section className="owl-career-card is-s12">
			<div className="owl-career-hero">
				<div>
					<div className="owl-career-eyebrow">
						{scopeName} · {t("career.cardTotal")}
						{board.firstDate && (
							<>
								{" "}
								· {t("career.since", { date: board.firstDate })} ·{" "}
								{t("career.careerDays", { days: board.careerDays })}
							</>
						)}
					</div>
					<p className="owl-career-bignum">
						{fmt(totals.totalTokens)}
						<small> tokens</small>
					</p>
					{totals.totalTokens > 0 ? (
						<div className="owl-career-mix">
							<div className="bar">
								{parts.map((part) => (
									<i
										key={part.key}
										style={{ flexGrow: part.value, background: part.color }}
										title={`${part.label} ${fmt(part.value)}`}
									/>
								))}
							</div>
							<div className="leg">
								{parts.map((part) => (
									<span key={part.key} style={{ "--c": part.color } as React.CSSProperties}>
										{part.label} {fmt(part.value)} · {pct(part.value, totals.totalTokens)}
									</span>
								))}
							</div>
						</div>
					) : (
						<p className="owl-career-empty">{t("career.empty")}</p>
					)}
				</div>
				<div className="owl-career-kpis">
					<Kpi
						label={t("career.activeDays")}
						value={
							<>
								{board.activeDays}
								<small>
									{" "}
									/ {board.careerDays} {t("career.daysUnit")}
								</small>
							</>
						}
						detail={t("career.activeRate", { rate: pct(board.activeDays, board.careerDays) })}
					/>
					<Kpi
						label={t("career.currentStreak")}
						value={
							<>
								{board.currentStreak}
								<small> {t("career.daysUnit")}</small>
							</>
						}
						detail={
							board.longestStreakEnd
								? t("career.longestStreak", {
										days: board.longestStreak,
										date: shortDate(board.longestStreakEnd),
									})
								: "—"
						}
					/>
					<Kpi
						label={t("career.sessionsTile")}
						value={board.sessions.toLocaleString()}
						detail={t("career.dailyAvg", { tokens: fmt(Math.round(board.avgPerDay)) })}
					/>
					<Kpi
						label={t("career.cardPeak")}
						value={board.peak && board.peak.tokens > 0 ? fmt(board.peak.tokens) : "—"}
						detail={
							board.peak && board.peak.tokens > 0
								? `${shortDate(board.peak.date)}${peakRatio > 1 ? ` · ${t("career.peakVsAvg", { ratio: peakRatio })}` : ""}`
								: t("career.none")
						}
					/>
					<Kpi
						label={
							<>
								{t("career.cardCost")}{" "}
								<span className="owl-career-tag" title={t("career.costNote")}>
									{t("career.costTag")}
								</span>
							</>
						}
						value={
							totals.cost > 0
								? `$${totals.cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
								: "—"
						}
						detail={
							totals.cost > 0 && totals.totalTokens > 0
								? t("career.costPerMillion", { price: ((totals.cost / totals.totalTokens) * 1e6).toFixed(2) })
								: t("career.costNone")
						}
						title={t("career.costNote")}
					/>
					<Kpi
						label={t("career.topModel")}
						value={
							<span className="mono" title={topModel?.key}>
								{topModel ? topModel.name : "—"}
							</span>
						}
						detail={
							topModel
								? t("career.shareOf", { pct: pct(topModel.tokens, totals.totalTokens) })
								: t("career.none")
						}
					/>
				</div>
			</div>
		</section>
	);
}

function Kpi({
	label,
	value,
	detail,
	title,
}: {
	label: React.ReactNode;
	value: React.ReactNode;
	detail: string;
	title?: string;
}): React.JSX.Element {
	return (
		<div className="owl-career-kpi" title={title}>
			<div className="k">{label}</div>
			<div className="v">{value}</div>
			<div className="d">{detail}</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 使用趋势
// ---------------------------------------------------------------------------

const RANGES: { value: TrendRange; key: TextKey }[] = [
	{ value: "30", key: "career.range30" },
	{ value: "90", key: "career.range90" },
	{ value: "year", key: "career.rangeYear" },
	{ value: "all", key: "career.rangeAll" },
];

function TrendCard({
	trend,
	range,
	onRange,
	nameOf,
	fmt,
	t,
	onTip,
}: {
	trend: Trend;
	range: TrendRange;
	onRange: (range: TrendRange) => void;
	nameOf: (id: string) => string;
	fmt: Fmt;
	t: Translate;
	onTip: ShowTip;
}): React.JSX.Element {
	const max = Math.max(1, ...trend.buckets.map((bucket) => bucket.total));
	const count = trend.buckets.length;
	const labelEvery = Math.max(1, Math.ceil(count / 8));
	const gap = count > 60 ? 1 : count > 35 ? 2 : 3;
	const tipFor = (index: number, event: React.MouseEvent): void => {
		const bucket = trend.buckets[index]!;
		onTip({
			x: event.clientX,
			y: event.clientY,
			title: trend.weekly ? `${shortDate(bucket.start)} ~ ${shortDate(bucket.end)}` : bucket.start,
			rows: [
				{ label: t("career.tipTotal"), value: bucket.total > 0 ? fmt(bucket.total) : t("career.tipNone") },
				...trend.groups
					.filter((group) => (bucket.parts[group] ?? 0) > 0)
					.sort((a, b) => (bucket.parts[b] ?? 0) - (bucket.parts[a] ?? 0))
					.map((group) => ({
						label: nameOf(group),
						value: fmt(bucket.parts[group] ?? 0),
						color: agentColor(group),
					})),
			],
		});
	};
	return (
		<section className="owl-career-card is-s8">
			<header className="owl-career-card-head">
				<span className="title">{t("career.cardTrend")}</span>
				<span className="sub">
					{t(trend.weekly ? "career.trendWeekly" : "career.trendDaily", {
						tokens: fmt(trend.total),
						count: trend.activeBuckets,
					})}
				</span>
				<span className="right">
					<span className="owl-career-seg">
						{RANGES.map((item) => (
							<button
								key={item.value}
								type="button"
								className={range === item.value ? "is-on" : ""}
								onClick={() => onRange(item.value)}
							>
								{t(item.key)}
							</button>
						))}
					</span>
				</span>
			</header>
			<div className="owl-career-trend" style={{ "--bar-gap": `${gap}px` } as React.CSSProperties}>
				<div className="plot" onMouseLeave={() => onTip(null)}>
					{[1, 0.5, 0].map((ratio) => (
						<div key={ratio} className="gl" style={{ bottom: `${ratio * 100}%` }}>
							<span>{ratio ? fmt(max * ratio) : "0"}</span>
						</div>
					))}
					{trend.buckets.map((bucket, index) => (
						<div key={bucket.start} className="col" onMouseMove={(event) => tipFor(index, event)}>
							{trend.groups.map((group) =>
								bucket.parts[group] ? (
									<i
										key={group}
										style={{
											height: `${((bucket.parts[group] ?? 0) / max) * 100}%`,
											background: agentColor(group),
										}}
									/>
								) : null,
							)}
						</div>
					))}
				</div>
				<div className="xlab">
					{trend.buckets.map((bucket, index) => (
						<span key={bucket.start}>{index % labelEvery === 0 ? shortDate(bucket.start) : ""}</span>
					))}
				</div>
				{trend.groups.length > 1 && (
					<div className="series">
						{trend.groups.map((group) => (
							<span key={group} style={{ "--c": agentColor(group) } as React.CSSProperties}>
								{nameOf(group)}
							</span>
						))}
					</div>
				)}
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Agent 构成（点行筛选）
// ---------------------------------------------------------------------------

function Donut({ rows, total }: { rows: { id: string; value: number }[]; total: number }): React.JSX.Element {
	const radius = 46;
	const circumference = 2 * Math.PI * radius;
	let offset = 0;
	return (
		<svg width="112" height="112" viewBox="0 0 112 112" aria-hidden="true">
			<circle cx="56" cy="56" r={radius} fill="none" className="track" strokeWidth="14" />
			{rows.map((row) => {
				const length = total > 0 ? (row.value / total) * circumference : 0;
				const element = (
					<circle
						key={row.id}
						cx="56"
						cy="56"
						r={radius}
						fill="none"
						strokeWidth="14"
						style={{ stroke: agentColor(row.id) }}
						strokeDasharray={`${Math.max(0, length - 1.2)} ${circumference}`}
						strokeDashoffset={-offset}
					/>
				);
				offset += length;
				return element;
			})}
		</svg>
	);
}

function AgentsCard({
	agents,
	filter,
	onPick,
	onSources,
	fmt,
	t,
}: {
	agents: CareerAgentUsage[];
	filter: string;
	onPick: (id: string) => void;
	onSources: () => void;
	fmt: Fmt;
	t: Translate;
}): React.JSX.Element {
	const [expanded, setExpanded] = useState(false);
	const list = agents
		.filter((agent) => agent.totals.totalTokens > 0)
		.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);
	const total = list.reduce((sum, agent) => sum + agent.totals.totalTokens, 0);
	const rest = list.slice(AGENTS_TOP);
	const restSum = rest.reduce((sum, agent) => sum + agent.totals.totalTokens, 0);
	const shown = expanded ? list : list.slice(0, AGENTS_TOP);
	const ring = [
		...list.slice(0, AGENTS_TOP).map((agent) => ({ id: agent.id, value: agent.totals.totalTokens })),
		...(restSum > 0 ? [{ id: OTHER_GROUP, value: restSum }] : []),
	];
	const topTwo = list.slice(0, 2);
	return (
		<section className="owl-career-card is-s4">
			<header className="owl-career-card-head">
				<span className="title">{t("career.cardAgents")}</span>
				<span className="sub">{t("career.agentsHint")}</span>
			</header>
			<div className="owl-career-mixbox">
				<div className="owl-career-donut">
					<Donut rows={ring} total={total} />
					<div className="c">
						<b>{list.length}</b>
						<span>{t("career.agentsUnit")}</span>
					</div>
				</div>
				<div className="lead">
					{topTwo.map((agent) => (
						<div key={agent.id}>
							<b>{agent.name}</b> {pct(agent.totals.totalTokens, total)}
						</div>
					))}
					{topTwo.length > 1 && (
						<div>
							{t("career.agentsTopTwo", {
								pct: pct(
									topTwo.reduce((sum, agent) => sum + agent.totals.totalTokens, 0),
									total,
								),
							})}
						</div>
					)}
				</div>
			</div>
			<ul className="owl-career-alist">
				{shown.map((agent) => (
					<li
						key={agent.id}
						className={filter === agent.id ? "is-on" : filter ? "is-dim" : ""}
						onClick={() => onPick(filter === agent.id ? "" : agent.id)}
						title={`${agent.name} · ${t("career.sessionsCount", { count: agent.sessions.toLocaleString() })}`}
					>
						<span className="sw" style={{ background: agentColor(agent.id) }} />
						<span className="nm">{agent.name}</span>
						<span className="tk">{fmt(agent.totals.totalTokens)}</span>
						<span className="pc">{pct(agent.totals.totalTokens, total)}</span>
					</li>
				))}
				{!expanded && rest.length > 0 && (
					<li
						className={filter && !rest.some((agent) => agent.id === filter) ? "is-more is-dim" : "is-more"}
						onClick={() => setExpanded(true)}
					>
						<span className="sw" style={{ background: agentColor(OTHER_GROUP) }} />
						<span className="nm">{t("career.agentsMore", { count: rest.length })}</span>
						<span className="tk">{fmt(restSum)}</span>
						<span className="pc">{pct(restSum, total)}</span>
					</li>
				)}
			</ul>
			<div className="owl-career-card-foot">
				{expanded && (
					<button type="button" className="owl-career-link" onClick={() => setExpanded(false)}>
						{t("career.collapse")}
					</button>
				)}
				<span>{t("career.silentSources", { count: agents.length - list.length })}</span>
				<button type="button" className="owl-career-link is-end" onClick={onSources}>
					{t("career.viewSources")}
				</button>
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// 模型排行
// ---------------------------------------------------------------------------

function ModelsCard({
	board,
	agents,
	filter,
	fmt,
	t,
}: {
	board: Board;
	agents: CareerAgentUsage[];
	filter: string;
	fmt: Fmt;
	t: Translate;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState(false);
	// 同一模型可能由多个 Agent 产生：按模型 key 汇总出用到它的 Agent（构成圆点），只算当前 scope
	const users = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const agent of agents) {
			if (filter && agent.id !== filter) continue;
			for (const model of agent.byModel) {
				if (model.totalTokens <= 0) continue;
				const list = map.get(model.key) ?? [];
				if (!list.includes(agent.id)) list.push(agent.id);
				map.set(model.key, list);
			}
		}
		return map;
	}, [agents, filter]);
	const needle = query.trim().toLowerCase();
	const all = board.models.filter(
		(model) => !needle || model.name.toLowerCase().includes(needle) || model.key.toLowerCase().includes(needle),
	);
	const shown = all.slice(0, expanded ? MODELS_MAX : MODELS_TOP);
	const max = Math.max(1, all[0]?.tokens ?? 1);
	return (
		<section className="owl-career-card is-s12">
			<header className="owl-career-card-head">
				<span className="title">{t("career.cardModels")}</span>
				<span className="sub">{t("career.modelsCount", { count: board.models.length })}</span>
				<span className="right">
					<label className="owl-career-search">
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<circle cx="11" cy="11" r="7" />
							<path d="m20 20-3.5-3.5" />
						</svg>
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("career.searchPlaceholder")}
							aria-label={t("career.searchPlaceholder")}
						/>
						{query && (
							<button type="button" aria-label="×" onClick={() => setQuery("")}>
								×
							</button>
						)}
					</label>
				</span>
			</header>
			{shown.length > 0 ? (
				<ul className="owl-career-mlist">
					{shown.map((model, index) => {
						const ids = users.get(model.key) ?? [model.agentId];
						return (
							<li
								key={model.key}
								title={`${model.key} · ${ids.map((id) => agents.find((agent) => agent.id === id)?.name ?? id).join(" / ")}`}
							>
								<span className="rk">{index + 1}</span>
								<span className="mn">
									{ids.slice(0, 3).map((id) => (
										<i key={id} style={{ background: agentColor(id) }} />
									))}
									<span>{model.name}</span>
								</span>
								<span className="bar">
									<i
										style={{
											width: `${(model.tokens / max) * 100}%`,
											background: agentColor(ids[0] ?? model.agentId),
										}}
									/>
								</span>
								<span className="tk">{fmt(model.tokens)}</span>
								<span className="pc">{pct(model.tokens, board.totals.totalTokens)}</span>
							</li>
						);
					})}
				</ul>
			) : (
				<p className="owl-career-empty is-center">{t("career.noMatch")}</p>
			)}
			{all.length > MODELS_TOP && (
				<div className="owl-career-card-foot">
					<span>{t("career.modelsDotNote")}</span>
					<button type="button" className="owl-career-link is-end" onClick={() => setExpanded((value) => !value)}>
						{expanded
							? t("career.collapse")
							: t("career.modelsShowAll", { count: Math.min(all.length, MODELS_MAX) })}
					</button>
				</div>
			)}
		</section>
	);
}

// ---------------------------------------------------------------------------
// 里程碑（竖排时间线）
// ---------------------------------------------------------------------------

function MilestonesCard({ board, fmt, t }: { board: Board; fmt: Fmt; t: Translate }): React.JSX.Element {
	const major = new Set(["t1b", "t10b", "peak"]);
	return (
		<section className="owl-career-card is-s12">
			<header className="owl-career-card-head">
				<span className="title">{t("career.cardMilestones")}</span>
				<span className="sub">{t("career.msBigNote")}</span>
			</header>
			<ul className="owl-career-ms">
				{[...board.milestones]
					.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
					.map((milestone) => (
						<li key={`${milestone.key}-${milestone.date}`} className={major.has(milestone.key) ? "is-major" : ""}>
							<span className="d">{milestone.date}</span>
							<span className="tt">{milestoneLabel(t, milestone.key, milestone.value)}</span>
							<span className="x">{milestoneNote(t, milestone, board.firstDate, fmt)}</span>
						</li>
					))}
			</ul>
		</section>
	);
}

function daysBetween(from: string, to: string): number {
	return Math.max(0, Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86_400_000));
}

// ---------------------------------------------------------------------------
// 近一年热力 + 侧栏统计
// ---------------------------------------------------------------------------

function monthName(month: number, lang: "zh" | "en"): string {
	return lang === "zh" ? `${month}月` : new Date(2000, month - 1, 1).toLocaleString("en", { month: "short" });
}

function HeatCard({
	heat,
	lang,
	fmt,
	t,
	onTip,
}: {
	heat: YearHeat;
	lang: "zh" | "en";
	fmt: Fmt;
	t: Translate;
	onTip: ShowTip;
}): React.JSX.Element {
	const weekdays = lang === "zh" ? ["一", "二", "三", "四", "五", "六", "日"] : ["M", "T", "W", "T", "F", "S", "S"];
	const weekMax = Math.max(1, ...heat.weekday);
	const weekTop = heat.weekday.indexOf(Math.max(...heat.weekday));
	const delta = heat.lastMonthToDate > 0 ? (heat.monthToDate / heat.lastMonthToDate - 1) * 100 : 0;
	return (
		<section className="owl-career-card is-s12">
			<header className="owl-career-card-head">
				<span className="title">{t("career.cardHeat")}</span>
				<span className="sub">{t("career.heatSummary", { days: heat.activeDays, tokens: fmt(heat.total) })}</span>
			</header>
			<div className="owl-career-heatrow">
				<div className="owl-career-heatscroll">
					<div className="owl-career-heatwrap">
						<div className="days">
							<span />
							{weekdays.map((day, index) => (
								<span key={index}>{index % 2 === 0 ? day : ""}</span>
							))}
						</div>
						<div>
							<div className="months">
								{heat.months
									.filter((month) => month.week < heat.weeks.length - 1)
									.map((month) => (
										<span
											key={`${month.week}-${month.month}`}
											style={{ left: `calc(${month.week} * (var(--cell) + 3px))` }}
										>
											{monthName(month.month, lang)}
										</span>
									))}
							</div>
							<div className="owl-career-heat" onMouseLeave={() => onTip(null)}>
								{heat.weeks.flatMap((week) =>
									week.map((cell) => (
										<i
											key={cell.date}
											className={cell.level < 0 ? "is-pad" : cell.level > 0 ? `is-l${cell.level}` : ""}
											onMouseMove={
												cell.level < 0
													? undefined
													: (event) =>
															onTip({
																x: event.clientX,
																y: event.clientY,
																title: cell.date,
																rows: [
																	{
																		label: t("career.tipTotal"),
																		value: cell.tokens > 0 ? fmt(cell.tokens) : t("career.tipNone"),
																	},
																],
															})
											}
										/>
									)),
								)}
							</div>
						</div>
					</div>
					<div className="owl-career-heatlegend">
						<span className="note">{t("career.heatLegendNote")}</span>
						{t("career.heatLess")}
						<i />
						<i className="is-l1" />
						<i className="is-l2" />
						<i className="is-l3" />
						<i className="is-l4" />
						{t("career.heatMore")}
					</div>
				</div>
				<div className="owl-career-heatside">
					<div className="st">
						<div className="k">{t("career.monthToDate")}</div>
						<div className="v">{fmt(heat.monthToDate)}</div>
						<div className="d">
							{heat.lastMonthToDate > 0
								? t("career.vsLastMonth", { arrow: delta >= 0 ? "↑" : "↓", pct: Math.abs(delta).toFixed(0) })
								: t("career.lastMonthNone")}
						</div>
					</div>
					<div className="st">
						<div className="k">{t("career.bestMonth")}</div>
						<div className="v">
							{heat.bestMonth
								? lang === "zh"
									? `${heat.bestMonth.month.slice(0, 4)}年${Number(heat.bestMonth.month.slice(5))}月`
									: `${monthName(Number(heat.bestMonth.month.slice(5)), lang)} ${heat.bestMonth.month.slice(0, 4)}`
								: "—"}
						</div>
						<div className="d">{heat.bestMonth ? `${fmt(heat.bestMonth.tokens)} tokens` : t("career.none")}</div>
					</div>
					<div className="wk">
						{heat.weekday.map((value, index) => (
							<div key={index} title={`${weekdays[index]} · ${fmt(value)}`}>
								<b>
									<i
										className={index === weekTop && value > 0 ? "is-top" : ""}
										style={{ height: `${Math.max(3, (value / weekMax) * 100)}%` }}
									/>
								</b>
								<span>{weekdays[index]}</span>
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// 数据源抽屉
// ---------------------------------------------------------------------------

function SourcesDrawer({
	open,
	agents,
	okCount,
	onClose,
	fmt,
	t,
}: {
	open: boolean;
	agents: CareerAgentUsage[];
	okCount: number;
	onClose: () => void;
	fmt: Fmt;
	t: Translate;
}): React.JSX.Element {
	const groups = SOURCE_ORDER.map((status) => ({
		status,
		items: agents
			.filter((agent) => agent.status === status)
			.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
	})).filter((group) => group.items.length > 0);
	return (
		<aside className={`owl-career-drawer${open ? " is-open" : ""}`} aria-hidden={!open}>
			<header>
				<h2>{t("career.cardSources")}</h2>
				<span className="sub">{t("career.sourcesCount", { ok: okCount, total: agents.length })}</span>
				<button type="button" onClick={onClose} title={t("career.close")} aria-label={t("career.close")}>
					✕
				</button>
			</header>
			<div className="body">
				{groups.map((group) => (
					<div key={group.status}>
						<div className="gh">
							{sourceStatus(t, group.status)}
							<span className="owl-career-tag">{group.items.length}</span>
						</div>
						{group.items.map((agent) => (
							<div key={agent.id} className="row">
								<span
									className="sw"
									style={{
										background:
											agent.totals.totalTokens > 0 ? agentColor(agent.id) : "var(--owl-career-other)",
									}}
								/>
								<span className="nm">
									{agent.name}
									<span className="meta">
										{" · "}
										{t("career.sessionsCount", { count: agent.sessions.toLocaleString() })}
										{agent.lastAt && (
											<>
												{" · "}
												{t("career.lastActive", { date: shortDate(agent.lastAt.slice(0, 10)) })}
											</>
										)}
									</span>
								</span>
								<span className="tk">{agent.totals.totalTokens > 0 ? fmt(agent.totals.totalTokens) : "—"}</span>
								{agent.root && <span className="path">{agent.root}</span>}
								{agent.note && <span className="note">{agent.note}</span>}
							</div>
						))}
					</div>
				))}
				<div className="caliber">
					<b>{t("career.caliberTitle")}</b>
					<p>{t("career.caliberBody")}</p>
					<p>{t("career.costNote")}</p>
				</div>
			</div>
		</aside>
	);
}

function HoverTip({ tip }: { tip: TipState }): React.JSX.Element {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ left: tip.x + 14, top: tip.y + 14 });
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const { offsetWidth: width, offsetHeight: height } = element;
		setPos({
			left: tip.x + 14 + width > window.innerWidth - 8 ? tip.x - width - 14 : tip.x + 14,
			top: tip.y + 14 + height > window.innerHeight - 8 ? tip.y - height - 14 : tip.y + 14,
		});
	}, [tip]);
	return (
		<div ref={ref} className="owl-career-tip" style={pos}>
			<div className="h">{tip.title}</div>
			{tip.rows.map((row, index) => (
				<div key={index} className="r">
					<span
						style={row.color ? ({ "--c": row.color } as React.CSSProperties) : undefined}
						className={row.color ? "has-sw" : ""}
					>
						{row.label}
					</span>
					<b>{row.value}</b>
				</div>
			))}
		</div>
	);
}

function milestoneLabel(t: Translate, key: string, value: number | undefined): string {
	switch (key) {
		case "start":
			return t("career.msStart");
		case "t10m":
			return t("career.msT10m");
		case "t100m":
			return t("career.msT100m");
		case "t1b":
			return t("career.msT1b");
		case "t10b":
			return t("career.msT10b");
		case "peak":
			return t("career.msPeak");
		case "streak":
			return t("career.msStreak", { days: value ?? 0 });
		default:
			return t("career.msLaunch");
	}
}

function milestoneNote(
	t: Translate,
	milestone: Board["milestones"][number],
	firstDate: string | undefined,
	fmt: Fmt,
): string {
	switch (milestone.key) {
		case "start":
			return t("career.msStartNote");
		case "peak":
			return t("career.msPeakNote", { tokens: fmt(milestone.value ?? 0) });
		case "streak":
			return t("career.msStreakNote");
		case "launch":
			return t("career.msLaunchNote");
		default:
			return firstDate ? t("career.msDayN", { days: daysBetween(firstDate, milestone.date) + 1 }) : "";
	}
}

function sourceStatus(t: Translate, status: string): string {
	switch (status) {
		case "ok":
			return t("career.srcOk");
		case "nodata":
			return t("career.srcNodata");
		case "detected":
			return t("career.srcDetected");
		case "pending":
			return t("career.srcPending");
		default:
			return t("career.srcUnavailable");
	}
}
