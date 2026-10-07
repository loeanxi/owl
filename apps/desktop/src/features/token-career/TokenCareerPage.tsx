import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import { getUiLanguage, useT, type TextKey } from "../../i18n/index.ts";
import { heatmapCells } from "../../components/usage-heatmap.ts";
import {
	agentColor,
	buildBoard,
	fetchCareer,
	formatTokens,
	shortDate,
	snapshotTime,
	type CareerGetResult,
} from "./token-career.ts";
import "./token-career.css";

type LoadState = {
	status: "idle" | "loading" | "ready" | "error";
	data?: CareerGetResult;
};

/**
 * 「我的 Token 生涯」大屏看板（版式对齐 features/guide：页头 + 筛选 chips + 卡片墙 + 来源栏）。
 * 数据面是桥的 career.get（modes/desktop/career-stats.ts）：owl 复用 usage-stats，
 * Claude Code / Codex 扫本地会话 JSONL；Agent chips 切换 scope 时纯前端重算，不重拉桥。
 */
export function TokenCareerPage({ active, client }: { active: boolean; client: BridgeClient }): React.JSX.Element {
	const t = useT();
	const lang = getUiLanguage();
	const [state, setState] = useState<LoadState>({ status: "idle" });
	const [filter, setFilter] = useState("");
	const [query, setQuery] = useState("");

	const sync = (): void => {
		setState((current) => ({ ...current, status: "loading" }));
		fetchCareer(client)
			.then((data) => setState({ status: "ready", data }))
			.catch(() => setState((current) => ({ ...current, status: "error" })));
	};

	useEffect(() => {
		if (!active || state.status !== "idle") return;
		sync();
		// 只在首次激活时触发扫描；之后经「重新同步」手动刷新。
	}, [active]);

	const agents = state.data?.agents ?? [];
	const board = useMemo(
		() => (state.status === "ready" ? buildBoard(agents, filter) : null),
		[state.status, state.data, filter],
	);
	const fmt = (value: number): string => formatTokens(value, lang);
	const needle = query.trim().toLowerCase();
	const models = board?.models.filter((model) => !needle || model.name.toLowerCase().includes(needle) || model.key.toLowerCase().includes(needle)) ?? [];
	const sources = agents.filter((agent) => !needle || agent.name.toLowerCase().includes(needle));
	const peakRatio = board?.peak && board.avgPerDay > 0 ? Math.max(1, Math.round(board.peak.tokens / board.avgPerDay)) : 0;

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
				<label className="owl-career-search">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
						<circle cx="11" cy="11" r="7" />
						<path d="m20 20-3.5-3.5" />
					</svg>
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("career.searchPlaceholder")}
						aria-label={t("career.searchPlaceholder")}
					/>
					{query && <button type="button" aria-label="×" onClick={() => setQuery("")}>×</button>}
				</label>
				<span className="owl-career-sync" data-status={state.status}>
					{state.status === "loading" ? t("career.loading")
						: state.status === "error" ? t("career.loadFailed")
						: state.data ? t("career.snapshot", { time: snapshotTime(state.data.generatedAt) })
						: ""}
					{(state.status === "ready" || state.status === "error") && (
						<button type="button" onClick={sync}>{t("career.resync")}</button>
					)}
				</span>
			</div>
			<div className="owl-career-filters" role="group">
				<FilterChip current={filter} value="" label={t("career.filterAll")} count={agents.reduce((sum, agent) => sum + agent.sessions, 0)} color={null} onPick={setFilter} />
				{agents.map((agent) => (
					<FilterChip
						key={agent.id}
						current={filter}
						value={agent.id}
						label={agent.name}
						count={agent.sessions}
						color={agentColor(agent.id)}
						onPick={setFilter}
					/>
				))}
				<span className="owl-career-sort">{t("career.sortNote")}</span>
			</div>

			<div className="owl-career-main">
				{state.status === "loading" && (
					<div className="owl-career-state">
						<p>{t("career.loading")}</p>
						<div className="bar"><i /></div>
					</div>
				)}
				{state.status === "error" && (
					<div className="owl-career-state">
						<p className="err">{t("career.loadFailed")}</p>
						<p><button type="button" className="owl-career-linkbtn" onClick={sync}>{t("career.retry")}</button></p>
					</div>
				)}
				{state.status === "ready" && board && (
					<div className="owl-career-wall">
						<section className="owl-career-mod">
							<header className="mod-head">
								<span className="mod-title">{t("career.cardTotal")}</span>
								{board.firstDate && <span className="mod-sub">{t("career.since", { date: shortDate(board.firstDate) })} · {t("career.careerDays", { days: board.careerDays })}</span>}
								<Badge grade="A" label={t("career.badgeA")} />
							</header>
							<p className="owl-career-bignum">
								{fmt(board.totals.totalTokens)}
								<small> tokens</small>
							</p>
							<div className="owl-career-split">
								<span>{t("career.splitInput", { tokens: fmt(board.totals.input) })}</span>
								<span>{t("career.splitOutput", { tokens: fmt(board.totals.output) })}</span>
								<span>{t("career.splitCache", { tokens: fmt(board.totals.cacheRead + board.totals.cacheWrite) })}</span>
							</div>
							{board.totals.totalTokens > 0 ? (
								<Spark days={board.spark14} title={(day) => `${shortDate(day.date)} · ${fmt(day.tokens)}`} />
							) : (
								<p className="mod-empty">{t("career.empty")}</p>
							)}
							<p className="mod-foot">{t("career.dailyAvg", { tokens: fmt(Math.round(board.avgPerDay)) })}</p>
						</section>

						<section className="owl-career-mod">
							<header className="mod-head">
								<span className="mod-title">{t("career.cardAgents")}</span>
								<Badge grade="A" label={t("career.badgeA")} />
							</header>
							{(() => {
								const withTokens = agents.filter((agent) => agent.totals.totalTokens > 0);
								const total = withTokens.reduce((sum, agent) => sum + agent.totals.totalTokens, 0);
								const max = Math.max(1, ...withTokens.map((agent) => agent.totals.totalTokens));
								return (
									<>
										<div className="owl-career-stkbar">
											{withTokens.map((agent) => (
												<i key={agent.id} style={{ width: `${(agent.totals.totalTokens / total) * 100}%`, background: agentColor(agent.id) }} title={`${agent.name} · ${fmt(agent.totals.totalTokens)}`} />
											))}
										</div>
										<ul className="owl-career-legend">
											{withTokens.map((agent) => (
												<li key={agent.id} className={filter && filter !== agent.id ? "is-dim" : ""}>
													<span className="sw" style={{ background: agentColor(agent.id) }} />
													<span className="nm">{agent.name}</span>
													<span className="bar"><i style={{ width: `${(agent.totals.totalTokens / max) * 100}%`, background: agentColor(agent.id) }} /></span>
													<span className="tk">{fmt(agent.totals.totalTokens)}</span>
													<span className="pc">{total > 0 ? `${((agent.totals.totalTokens / total) * 100).toFixed(1)}%` : "0%"}</span>
												</li>
											))}
										</ul>
									</>
								);
							})()}
						</section>

						<section className="owl-career-mod">
							<header className="mod-head">
								<span className="mod-title">{t("career.cardModels")}</span>
								<Badge grade="A" label={t("career.badgeA")} />
							</header>
							<ul className="owl-career-models">
								{models.slice(0, 8).map((model) => (
									<li key={model.key} title={model.key}>
										<span className="mn">{model.name}</span>
										<span className="bar"><i style={{ width: `${(model.tokens / Math.max(1, models[0]?.tokens ?? 1)) * 100}%` }} /></span>
										<span className="tk">{fmt(model.tokens)}</span>
									</li>
								))}
								{models.length === 0 && <li className="mod-empty">{t("career.noMatch")}</li>}
							</ul>
						</section>

						<section className="owl-career-mod">
							<header className="mod-head">
								<span className="mod-title">{t("career.cardActivity")}</span>
								<Badge grade="A" label={t("career.badgeA")} />
							</header>
							<div className="owl-career-cells">
								<div className="cell"><span className="k">{t("career.activeDays")}</span><span className="v">{board.activeDays} <small>/ {t("career.careerDays", { days: board.careerDays })}</small></span></div>
								<div className="cell"><span className="k">{t("career.currentStreak")}</span><span className="v">{board.currentStreak} <small>{t("career.daysUnit")}</small></span></div>
								<div className="cell"><span className="k">{t("career.longestStreak")}</span><span className="v">{board.longestStreak} <small>{t("career.daysUnit")}</small></span></div>
								<div className="cell"><span className="k">{t("career.sessionsTile")}</span><span className="v">{board.sessions.toLocaleString()}</span></div>
							</div>
						</section>

						{board.totals.cost > 0 && (
							<section className="owl-career-mod">
								<header className="mod-head">
									<span className="mod-title">{t("career.cardCost")}</span>
									<Badge grade="C" label={t("career.badgeC")} />
								</header>
								<p className="owl-career-bignum">{`$${board.totals.cost.toFixed(2)}`}</p>
								<p className="mod-note">{t("career.costNote")}</p>
							</section>
						)}

						{board.peak && board.peak.tokens > 0 && (
							<section className="owl-career-mod">
								<header className="mod-head">
									<span className="mod-title">{t("career.cardPeak")}</span>
									<span className="mod-sub">{shortDate(board.peak.date)}</span>
									<Badge grade="A" label={t("career.badgeA")} />
								</header>
								<p className="owl-career-bignum">
									{fmt(board.peak.tokens)}
									{peakRatio > 1 && <small> · {t("career.peakVsAvg", { ratio: peakRatio })}</small>}
								</p>
							</section>
						)}

						<section className="owl-career-mod is-wide">
							<header className="mod-head">
								<span className="mod-title">{t("career.cardTrend")}</span>
								<span className="mod-sub">{t("career.trendTotal", { tokens: fmt(board.trend30.reduce((sum, day) => sum + day.tokens, 0)) })}</span>
								<Badge grade="A" label={t("career.badgeA")} />
							</header>
							<Trend days={board.trend30} fmt={fmt} />
						</section>

						<section className="owl-career-mod is-wide">
							<header className="mod-head">
								<span className="mod-title">{t("career.cardHeat")}</span>
								<span className="mod-sub">{t("career.heatNote", { days: board.activeDays })}</span>
								<Badge grade="A" label={t("career.badgeA")} />
							</header>
							<Heat byDay={board.byDay} />
						</section>

						<section className="owl-career-mod is-wide">
							<header className="mod-head">
								<span className="mod-title">{t("career.cardMilestones")}</span>
								<Badge grade="A" label={t("career.badgeA")} />
							</header>
							<ul className="owl-career-ms">
								{board.milestones.map((milestone) => (
									<li key={`${milestone.key}-${milestone.date}`}>
										<span className="d">{shortDate(milestone.date)}</span>
										<span className="t">{milestoneLabel(t, milestone.key, milestone.value, fmt)}</span>
									</li>
								))}
							</ul>
						</section>

						<section className="owl-career-mod is-wide">
							<header className="mod-head">
								<span className="mod-title">{t("career.cardSources")}</span>
								<span className="mod-sub">{t("career.sourcesCount", { ok: agents.filter((agent) => agent.status === "ok").length, total: agents.length })}</span>
							</header>
							<ul className="owl-career-src">
								{sources.map((agent) => (
									<li key={agent.id}>
										<span className="sw" style={{ background: agentColor(agent.id) }} />
										<span className="info">
											<span className="nm">{agent.name}</span>
											{agent.root && <span className="path">{agent.root}</span>}
										</span>
										<span className="tk">{agent.totals.totalTokens > 0 ? fmt(agent.totals.totalTokens) : "—"}</span>
										<span className={`pill is-${agent.status}`}>{sourceStatus(t, agent.status)}</span>
										{agent.note && <span className="note" title={agent.note}>{agent.note}</span>}
									</li>
								))}
							</ul>
						</section>
					</div>
				)}
			</div>
			<div className="owl-career-foot">
				<span>{t("career.footSource")}</span>
				<span className="right">{state.data ? t("career.footGenerated", { time: snapshotTime(state.data.generatedAt) }) : ""}</span>
			</div>
		</div>
	);
}

function FilterChip({ current, value, label, count, color, onPick }: {
	current: string;
	value: string;
	label: string;
	count: number;
	color: string | null;
	onPick: (value: string) => void;
}): React.JSX.Element {
	return (
		<button type="button" className={`owl-career-fchip${current === value ? " on" : ""}`} onClick={() => onPick(value)}>
			{color && <span className="sw" style={{ background: color }} />}
			{label}
			<span className="n">{count.toLocaleString()}</span>
		</button>
	);
}

function Badge({ grade, label }: { grade: "A" | "C"; label: string }): React.JSX.Element {
	return <span className={`owl-career-badge g${grade}`}>{label}</span>;
}

function Spark({ days, title }: { days: { date: string; tokens: number }[]; title: (day: { date: string; tokens: number }) => string }): React.JSX.Element {
	const max = Math.max(1, ...days.map((day) => day.tokens));
	return (
		<div className="owl-career-spark" role="img">
			{days.map((day) => (
				<i key={day.date} className={day.tokens === max ? "is-hot" : ""} style={{ height: `${Math.max(4, (day.tokens / max) * 100)}%` }} title={title(day)} />
			))}
		</div>
	);
}

function Trend({ days, fmt }: { days: { date: string; tokens: number }[]; fmt: (value: number) => string }): React.JSX.Element {
	const max = Math.max(1, ...days.map((day) => day.tokens));
	const peakIndex = days.reduce((best, day, index) => (day.tokens > days[best]!.tokens ? index : best), 0);
	return (
		<div className="owl-career-trend" role="img">
			{days.map((day, index) => (
				<div key={day.date} className="col" title={`${shortDate(day.date)} · ${fmt(day.tokens)}`}>
					<i className={index === peakIndex && day.tokens > 0 ? "is-hot" : ""} style={{ height: `${Math.max(1.5, (day.tokens / max) * 100)}%` }} />
					<span className="lb">{index % 5 === 4 || index === days.length - 1 ? shortDate(day.date) : ""}</span>
				</div>
			))}
		</div>
	);
}

/** 近一年热力：复用使用概览的格子计算（"all" = 铺满 26 周），渲染随看板卡片样式。 */
function Heat({ byDay }: { byDay: { date: string; tokens: number }[] }): React.JSX.Element {
	const heat = useMemo(() => heatmapCells(byDay.map((day) => ({ date: day.date, totalTokens: day.tokens })), "all"), [byDay]);
	return (
		<div className={`owl-career-heat${heat.fill ? " is-fill" : ""}`} role="img">
			{heat.cells.map((week, weekIndex) => (
				<div key={weekIndex} className="col">
					{week.map((cell, dayIndex) => (
						<span
							key={dayIndex}
							className={`cell${cell.level < 0 ? " is-pad" : cell.level === 0 ? " is-empty" : ` is-l${cell.level}`}`}
							title={cell.date ? `${cell.date} · ${cell.tokens.toLocaleString()}` : undefined}
						/>
					))}
				</div>
			))}
		</div>
	);
}

function milestoneLabel(t: (key: TextKey, vars?: Record<string, string | number>) => string, key: string, value: number | undefined, fmt: (value: number) => string): string {
	const v = value ?? 0;
	switch (key) {
		case "start": return t("career.msStart");
		case "t10m": return t("career.msT10m");
		case "t100m": return t("career.msT100m");
		case "t1b": return t("career.msT1b");
		case "peak": return t("career.msPeak", { tokens: fmt(v) });
		case "streak": return t("career.msStreak", { days: v });
		default: return t("career.msLaunch");
	}
}

function sourceStatus(t: (key: TextKey, vars?: Record<string, string | number>) => string, status: string): string {
	switch (status) {
		case "ok": return t("career.srcOk");
		case "nodata": return t("career.srcNodata");
		case "detected": return t("career.srcDetected");
		case "pending": return t("career.srcPending");
		default: return t("career.srcUnavailable");
	}
}
