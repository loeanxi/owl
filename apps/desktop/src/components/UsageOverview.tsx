import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { UsageGetResult } from "../bridge/protocol.ts";
import { useT } from "../i18n/index.ts";
import { projectLabel } from "../utils/paths.ts";
import "./usage-overview.css";

// 开始页「使用概览」面板（Claude Desktop 同款）：新会话还没开始时展示全局用量。
// 数据面是桥的 usage.get（modes/desktop/usage-stats.ts）：mtime+size 增量缓存、
// 会话删除不回吐的累积口径；这里只负责过滤参数与渲染。

type RangeKey = "all" | "30d" | "7d";
type TabKey = "overview" | "models";

const MODEL_COLORS = ["#4d9fd8", "#c77dff", "#e0a33e", "#41c463", "#e06c75", "#56b6c2", "#d19a66", "#7aa2f7"];
/** 热力图最多渲染的周数（Claude 同款半年量级）。 */
const HEATMAP_WEEKS = 26;
/** 一本《霍比特人》的近似 token 量（趣味对比的分母）。 */
const HOBBIT_TOKENS = 120_000;

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function modelShortName(key: string): string {
	const at = key.lastIndexOf("/");
	return at >= 0 ? key.slice(at + 1) : key;
}

interface HeatCell {
	date: string;
	tokens: number;
	level: number;
}

/** byDay 尾部 → 按周对齐的热力格（列=周，行=周一..周日），level 0-4 相对于窗口最大值。 */
function heatmapCells(byDay: UsageGetResult["byDay"]): { cells: HeatCell[][]; weeks: number } {
	const window = byDay.slice(-HEATMAP_WEEKS * 7);
	if (window.length === 0) return { cells: [], weeks: 0 };
	const max = Math.max(...window.map((day) => day.totalTokens), 1);
	const leading = (new Date(`${window[0]!.date}T00:00:00`).getDay() + 6) % 7; // 周一=0
	const flat: HeatCell[] = Array.from({ length: leading }, () => ({ date: "", tokens: 0, level: -1 }));
	for (const day of window) {
		const level = day.totalTokens <= 0 ? 0 : Math.min(4, 1 + Math.floor((day.totalTokens / max) * 4));
		flat.push({ date: day.date, tokens: day.totalTokens, level });
	}
	while (flat.length % 7 !== 0) flat.push({ date: "", tokens: 0, level: -1 });
	const cells: HeatCell[][] = [];
	for (let i = 0; i < flat.length; i += 7) cells.push(flat.slice(i, i + 7) as HeatCell[]);
	return { cells, weeks: cells.length };
}

export function UsageOverview({ client }: { client: BridgeClient }): React.JSX.Element {
	const t = useT();
	const [tab, setTab] = useState<TabKey>("overview");
	const [range, setRange] = useState<RangeKey>("all");
	const [project, setProject] = useState("");
	const [data, setData] = useState<UsageGetResult | undefined>();

	useEffect(() => {
		let cancelled = false;
		void client
			.request<UsageGetResult>({ type: "usage.get", days: range, ...(project ? { cwd: project } : {}) })
			.then((response) => {
				if (!cancelled && response.ok && response.result) setData(response.result);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [client, range, project]);

	const heat = useMemo(() => heatmapCells(data?.byDay ?? []), [data]);
	const models = useMemo(() => (data ? [...data.byModel].sort((a, b) => b.totalTokens - a.totalTokens) : []), [data]);
	const modelTotal = useMemo(() => models.reduce((sum, model) => sum + model.totalTokens, 0), [models]);
	// Models 页柱状图：趋势窗的最近 30 天
	const chartDays = useMemo(() => (data ? data.byDayModel.slice(-30) : []), [data]);
	const chartMax = useMemo(() => Math.max(1, ...chartDays.flatMap((day) => Object.values(day.models))), [chartDays]);
	const chartPalette = useMemo(() => {
		const palette = new Map<string, string>();
		models.slice(0, MODEL_COLORS.length).forEach((model, index) => palette.set(model.key, MODEL_COLORS[index]!));
		return palette;
	}, [models]);
	// 堆叠顺序全局固定（图例顺序），每天的色块层级才一致
	const chartOrder = useMemo(() => models.slice(0, MODEL_COLORS.length).map((model) => model.key), [models]);

	const totalTokens = data?.totals.totalTokens ?? 0;
	const cost = data?.totals.cost ?? 0;
	const hobbitRatio = totalTokens / HOBBIT_TOKENS;
	const fact = (() => {
		if (totalTokens <= 0) return undefined;
		const parts = [t("usage.factTokens", { tokens: formatTokens(totalTokens) })];
		if (cost > 0) parts.push(t("usage.factCost", { cost: cost.toFixed(2) }));
		if (hobbitRatio >= 2) parts.push(t("usage.factHobbit", { ratio: Math.round(hobbitRatio) }));
		return parts.join(t("usage.factJoin"));
	})();

	return (
		<section className="owl-usage" aria-label={t("usage.aria")}>
			<header className="owl-usage-bar">
				<div className="owl-usage-tabs" role="tablist" aria-label={t("usage.viewsAria")}>
					<button type="button" role="tab" aria-selected={tab === "overview"} className={"owl-usage-tab" + (tab === "overview" ? " is-active" : "")} onClick={() => setTab("overview")}>
						{t("usage.tabOverview")}
					</button>
					<button type="button" role="tab" aria-selected={tab === "models"} className={"owl-usage-tab" + (tab === "models" ? " is-active" : "")} onClick={() => setTab("models")}>
						{t("usage.tabModels")}
					</button>
				</div>
				<div className="owl-usage-controls">
					<select className="owl-usage-project" aria-label={t("usage.projectAria")} value={project} onChange={(event) => setProject(event.target.value)}>
						<option value="">{t("usage.projectAll")}</option>
						{(data?.allProjects ?? []).map((entry) => (
							<option key={entry.cwd} value={entry.cwd}>
								{projectLabel(entry.cwd)}
							</option>
						))}
					</select>
					<div className="owl-usage-ranges" role="radiogroup" aria-label={t("usage.rangeAria")}>
						{(["all", "30d", "7d"] as const).map((key) => (
							<button key={key} type="button" role="radio" aria-checked={range === key} className={"owl-usage-range" + (range === key ? " is-active" : "")} onClick={() => setRange(key)}>
								{key === "all" ? t("usage.rangeAll") : key === "30d" ? t("usage.range30d") : t("usage.range7d")}
							</button>
						))}
					</div>
				</div>
			</header>

			{!data ? (
				<p className="owl-usage-empty">{t("usage.loading")}</p>
			) : tab === "overview" ? (
				<>
					<div className="owl-usage-tiles">
						<div className="owl-usage-tile">
							<span className="owl-usage-tile-label">{t("usage.tilesSessions")}</span>
							<span className="owl-usage-tile-value">{data.sessionCount}</span>
						</div>
						<div className="owl-usage-tile">
							<span className="owl-usage-tile-label">{t("usage.tilesMessages")}</span>
							<span className="owl-usage-tile-value">{data.messages}</span>
						</div>
						<div className="owl-usage-tile">
							<span className="owl-usage-tile-label">{t("usage.tilesTokens")}</span>
							<span className="owl-usage-tile-value">{formatTokens(totalTokens)}</span>
						</div>
						<div className="owl-usage-tile">
							<span className="owl-usage-tile-label">{t("usage.tilesActiveDays")}</span>
							<span className="owl-usage-tile-value">{data.activeDays}</span>
						</div>
						<div className="owl-usage-tile">
							<span className="owl-usage-tile-label">{t("usage.tilesPeakHour")}</span>
							<span className="owl-usage-tile-value">{data.peakHour !== undefined ? `${data.peakHour}:00` : "—"}</span>
						</div>
						<div className="owl-usage-tile">
							<span className="owl-usage-tile-label">{t("usage.tilesFavoriteModel")}</span>
							<span className="owl-usage-tile-value owl-usage-tile-model" title={data.favoriteModel ?? undefined}>
								{data.favoriteModel ? modelShortName(data.favoriteModel) : "—"}
							</span>
						</div>
					</div>
					<div className="owl-usage-heatmap" role="img" aria-label={t("usage.heatmapAria")}>
						{heat.cells.map((week, weekIndex) => (
							<div key={weekIndex} className="owl-usage-heatmap-col">
								{week.map((cell, dayIndex) => (
									<span
										key={dayIndex}
										className={`owl-usage-heat-cell${cell.level < 0 ? " is-pad" : cell.level === 0 ? " is-empty" : ` is-l${cell.level}`}`}
										title={cell.date ? `${cell.date} · ${formatTokens(cell.tokens)}` : undefined}
									/>
								))}
							</div>
						))}
					</div>
					{fact && <p className="owl-usage-fact">{fact}</p>}
				</>
			) : (
				<div className="owl-usage-models">
					<svg className="owl-usage-chart" viewBox={`0 0 ${Math.max(chartDays.length, 1) * 14} 100`} preserveAspectRatio="none" role="img" aria-label={t("usage.chartAria")}>
						{chartDays.map((day, dayIndex) => {
							let offset = 0;
							const bars = chartOrder
								.map((modelKey) => [modelKey, day.models[modelKey] ?? 0] as const)
								.filter(([, tokens]) => tokens > 0)
								.map(([modelKey, tokens]) => {
									const height = (tokens / chartMax) * 100;
									const bar = (
										<rect
											key={`${day.date}-${modelKey}`}
											x={dayIndex * 14 + 2}
											y={100 - offset - height}
											width={10}
											height={height}
											fill={chartPalette.get(modelKey) ?? "#5a5a5a"}
											rx={1.5}
										>
											<title>{`${day.date} · ${modelShortName(modelKey)} · ${formatTokens(tokens)}`}</title>
										</rect>
									);
									offset += height;
									return bar;
								});
							return <g key={day.date}>{bars}</g>;
						})}
					</svg>
					<ul className="owl-usage-model-list">
						{models.slice(0, 6).map((model) => (
							<li key={model.key} className="owl-usage-model-row" title={model.key}>
								<span className="owl-usage-model-dot" style={{ background: chartPalette.get(model.key) ?? "#5a5a5a" }} />
								<span className="owl-usage-model-name">{modelShortName(model.key)}</span>
								<span className="owl-usage-model-io">
									{t("usage.modelIo", { input: formatTokens(model.input ?? 0), output: formatTokens(model.output ?? 0) })}
								</span>
								<span className="owl-usage-model-pct">
									{modelTotal > 0 ? `${Math.round((model.totalTokens / modelTotal) * 100)}%` : "0%"}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
