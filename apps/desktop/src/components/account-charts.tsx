/**
 * 个人主页 Token 活动的「每周 / 累计总量」两种视图（纯 SVG，无依赖）。
 * 数据同为 usage.get 的 byDay（全史口径，封顶一年）。
 */

import { useMemo } from "react";
import type { UsageStatsDay } from "../bridge/protocol.ts";

/** 每周视图窗口：与热力图同为最近 26 周，右端对齐本周。 */
const WEEKS = 26;

export function formatChartTokens(value: number): string {
	if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
	if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function localKey(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function mondayOf(date: Date): Date {
	const monday = new Date(date);
	monday.setHours(12, 0, 0, 0);
	monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return monday;
}

interface WeekBucket {
	/** 周一（本地时区）。 */
	start: Date;
	/** 周日。 */
	end: Date;
	tokens: number;
}

/** 按周（周一起）聚合 byDay，输出最近 WEEKS 周（含本周，无数据周为 0）。 */
export function weeklyBuckets(byDay: UsageStatsDay[]): WeekBucket[] {
	const tokensByMonday = new Map<string, number>();
	for (const day of byDay) {
		if (!day.date) continue;
		const date = new Date(`${day.date}T12:00:00`);
		const monday = mondayOf(date);
		const key = localKey(monday);
		tokensByMonday.set(key, (tokensByMonday.get(key) ?? 0) + day.totalTokens);
	}
	const endMonday = mondayOf(new Date());
	const buckets: WeekBucket[] = [];
	for (let index = WEEKS - 1; index >= 0; index -= 1) {
		const start = new Date(endMonday);
		start.setDate(endMonday.getDate() - index * 7);
		const end = new Date(start);
		end.setDate(start.getDate() + 6);
		buckets.push({ start, end, tokens: tokensByMonday.get(localKey(start)) ?? 0 });
	}
	return buckets;
}

/** 累计总量：按天累积曲线（输入按 byDay 原序，可能跨表头，这里自行排序）。 */
export function cumulativePoints(byDay: UsageStatsDay[]): Array<{ date: string; total: number }> {
	const sorted = byDay
		.filter((day) => day.date)
		.map((day) => ({ date: day.date, tokens: day.totalTokens }))
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	let sum = 0;
	return sorted.map((day) => {
		sum += day.tokens;
		return { date: day.date, total: sum };
	});
}

const WIDTH = 860;
const HEIGHT = 170;
const CHART_TOP = 14;
const CHART_BOTTOM = HEIGHT - 22;

export function WeeklyBars({ byDay, ariaLabel }: { byDay: UsageStatsDay[]; ariaLabel: string }): React.JSX.Element {
	const weeks = useMemo(() => weeklyBuckets(byDay), [byDay]);
	const max = Math.max(1, ...weeks.map((week) => week.tokens));
	const slot = WIDTH / weeks.length;
	const barWidth = Math.max(6, slot - 6);
	const label = (date: Date): string => `${date.getMonth() + 1}/${date.getDate()}`;
	return (
		<svg
			className="owl-profile-chart"
			viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
			preserveAspectRatio="none"
			role="img"
			aria-label={ariaLabel}
		>
			{weeks.map((week, index) => {
				const height = week.tokens > 0 ? Math.max(2, ((CHART_BOTTOM - CHART_TOP) * week.tokens) / max) : 0;
				const x = index * slot + (slot - barWidth) / 2;
				return (
					<rect
						key={index}
						className={week.tokens > 0 ? "owl-profile-chart-bar" : "owl-profile-chart-bar is-empty"}
						x={x}
						y={CHART_BOTTOM - height}
						width={barWidth}
						height={Math.max(height, 2)}
						rx={3}
					>
						<title>{`${label(week.start)} - ${label(week.end)} · ${formatChartTokens(week.tokens)}`}</title>
					</rect>
				);
			})}
			<text className="owl-profile-chart-axis" x={2} y={HEIGHT - 4}>
				{label(weeks[0]!.start)}
			</text>
			<text className="owl-profile-chart-axis" x={WIDTH - 2} y={HEIGHT - 4} textAnchor="end">
				{label(weeks[weeks.length - 1]!.end)}
			</text>
			<text className="owl-profile-chart-axis" x={WIDTH - 2} y={CHART_TOP} textAnchor="end">
				{formatChartTokens(max)}
			</text>
		</svg>
	);
}

export function CumulativeArea({ byDay, ariaLabel }: { byDay: UsageStatsDay[]; ariaLabel: string }): React.JSX.Element {
	const points = useMemo(() => cumulativePoints(byDay), [byDay]);
	if (points.length < 2) {
		return (
			<svg
				className="owl-profile-chart"
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				preserveAspectRatio="none"
				role="img"
				aria-label={ariaLabel}
			/>
		);
	}
	const max = points[points.length - 1]!.total || 1;
	const x = (index: number): number => (index / (points.length - 1)) * WIDTH;
	const y = (total: number): number => CHART_BOTTOM - ((CHART_BOTTOM - CHART_TOP) * total) / max;
	const line = points.map((point, index) => `${x(index).toFixed(1)},${y(point.total).toFixed(1)}`).join(" ");
	const area = `${line} ${WIDTH},${CHART_BOTTOM} 0,${CHART_BOTTOM}`;
	const label = (key: string): string => {
		const [, month, day] = key.split("-");
		return `${Number(month)}/${Number(day)}`;
	};
	return (
		<svg
			className="owl-profile-chart"
			viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
			preserveAspectRatio="none"
			role="img"
			aria-label={ariaLabel}
		>
			<defs>
				<linearGradient id="owl-profile-cum-gradient" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor="var(--color-owl-accent, #e56ba0)" stopOpacity="0.28" />
					<stop offset="100%" stopColor="var(--color-owl-accent, #e56ba0)" stopOpacity="0.02" />
				</linearGradient>
			</defs>
			<polygon className="owl-profile-chart-area" points={area} fill="url(#owl-profile-cum-gradient)" />
			<polyline className="owl-profile-chart-line" points={line} fill="none" />
			<circle className="owl-profile-chart-dot" cx={WIDTH} cy={y(max)} r={4}>
				<title>{`${points[points.length - 1]!.date} · ${formatChartTokens(max)}`}</title>
			</circle>
			<text className="owl-profile-chart-axis" x={2} y={HEIGHT - 4}>
				{label(points[0]!.date)}
			</text>
			<text className="owl-profile-chart-axis" x={WIDTH - 2} y={HEIGHT - 4} textAnchor="end">
				{label(points[points.length - 1]!.date)}
			</text>
			<text className="owl-profile-chart-axis" x={WIDTH - 2} y={CHART_TOP} textAnchor="end">
				{formatChartTokens(max)}
			</text>
		</svg>
	);
}
