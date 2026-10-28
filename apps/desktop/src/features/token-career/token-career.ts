/**
 * 「我的 Token 生涯」数据层：career.get 桥调用 + 卡片墙的派生模型。
 *
 * 后端（packages/owl-career/src/career-stats.ts）按数据源分桶返回各自 totals/byDay/byModel；
 * 这里负责把 scope（全部或单个 Agent）折叠成看板要的形状：补零的趋势窗、活跃/连续
 * 天数、单日峰值、生涯里程碑。全部纯函数，方便测试与重算（切 Agent 过滤不重拉桥）。
 */
import type { BridgeClient } from "../../bridge/client.ts";
import type { CareerAgentUsage, CareerGetResult } from "../../bridge/protocol.ts";

export type { CareerAgentUsage, CareerGetResult };

/** 拉一次全量生涯汇总。首扫可能较慢（Codex 本地可到 GB 级），由后端 mtime 缓存兜底。 */
export async function fetchCareer(client: BridgeClient): Promise<CareerGetResult> {
	const response = await client.request<CareerGetResult>({ type: "career.get" });
	if (!response.ok || !response.result) throw new Error(response.error ?? "career.get failed");
	return response.result;
}

/** 读上一次完整结果（不扫描，秒回）；从未统计过时为 null。旧桥不认 cached，会退化成一次全量统计。 */
export async function fetchCareerSnapshot(client: BridgeClient): Promise<CareerGetResult | null> {
	const response = await client.request<CareerGetResult | null>({ type: "career.get", cached: true });
	if (!response.ok) throw new Error(response.error ?? "career.get failed");
	return response.result ?? null;
}

// ---------------------------------------------------------------------------
// 派生模型
// ---------------------------------------------------------------------------

export interface BoardDay {
	date: string;
	tokens: number;
}

export interface BoardModelRow {
	key: string;
	/** 展示名：owl 的 key 是 provider/model，只留 model 段。 */
	name: string;
	tokens: number;
	agentId: string;
}

export interface BoardMilestone {
	date: string;
	key: "start" | "t10m" | "t100m" | "t1b" | "t10b" | "peak" | "streak" | "launch";
	/** 里程碑的量值（峰值 tokens / 连续天数），展示时随 key 取用。 */
	value?: number;
}

export interface Board {
	totals: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
	/** 有用量的天，升序。 */
	byDay: BoardDay[];
	/** 补零的最近 30 天（趋势卡）。 */
	trend30: BoardDay[];
	spark14: BoardDay[];
	careerDays: number;
	activeDays: number;
	currentStreak: number;
	longestStreak: number;
	/** 最长连续那一段的最后一天。 */
	longestStreakEnd?: string;
	avgPerDay: number;
	peak: BoardDay | null;
	sessions: number;
	models: BoardModelRow[];
	milestones: BoardMilestone[];
	firstDate?: string;
}

function dateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function localToday(): string {
	return dateKey(new Date());
}

function diffDays(from: string, to: string): number {
	const a = Date.parse(`${from}T12:00:00`);
	const b = Date.parse(`${to}T12:00:00`);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
	return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** 趋势/构成里「其余 Agent」合并成的一组。 */
export const OTHER_GROUP = "__other";

/** Agent 卡片上的标识色（owl 用主题强调色，不写死；Cursor/其他走 CSS 变量随深浅色提亮）。 */
export const AGENT_COLORS: Record<string, string | null> = {
	owl: null,
	[OTHER_GROUP]: "var(--owl-career-other)",
	zcode: "#2F8F6B",
	pi: "#8B5CF6",
	claude: "#D97757",
	codex: "#10A37F",
	gemini: "#4E8DF5",
	cursor: "var(--owl-career-cursor)",
	kimi: "#9B7EF5",
	opencode: "#E0A33E",
	kilo: "#14B8A6",
	qoder: "#4D9FD8",
	copilot: "#6E7B8B",
	roo: "#E05D3D",
	cline: "#5B9BD5",
	workbuddy: "#3B82C4",
	dsh: "#7C3AED",
	mavis: "#E0642A",
	reasonix: "#9333EA",
	mimo: "#0EA5E9",
};

export function agentColor(id: CareerAgentUsage["id"]): string {
	return AGENT_COLORS[id] ?? "var(--color-owl-accent)";
}

/** 把 scope（全部或单个 Agent）折叠成看板模型。today 不传则取本机今天。 */
export function buildBoard(agents: CareerAgentUsage[], filterId: string, today = localToday()): Board {
	const scope = filterId ? agents.filter((agent) => agent.id === filterId) : agents;

	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	const dayMap = new Map<string, number>();
	const modelMap = new Map<string, BoardModelRow>();
	let sessions = 0;
	for (const agent of scope) {
		totals.input += agent.totals.input;
		totals.output += agent.totals.output;
		totals.cacheRead += agent.totals.cacheRead;
		totals.cacheWrite += agent.totals.cacheWrite;
		totals.totalTokens += agent.totals.totalTokens;
		totals.cost += agent.totals.cost;
		sessions += agent.sessions;
		for (const day of agent.byDay) dayMap.set(day.date, (dayMap.get(day.date) ?? 0) + day.totalTokens);
		for (const model of agent.byModel) {
			const at = model.key.lastIndexOf("/");
			const name = at >= 0 ? model.key.slice(at + 1) : model.key;
			const existing = modelMap.get(model.key);
			if (existing) existing.tokens += model.totalTokens;
			else modelMap.set(model.key, { key: model.key, name, tokens: model.totalTokens, agentId: agent.id });
		}
	}

	const byDay = [...dayMap.entries()]
		.map(([date, tokens]) => ({ date, tokens }))
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const firstDate = byDay[0]?.date;
	const careerDays = firstDate ? diffDays(firstDate, today) + 1 : 0;

	// 连续天数：从今天往回走（今天还没用量则从昨天起算），再正着找最长一段
	const used = new Set(byDay.map((day) => day.date));
	let currentStreak = 0;
	const cursor = new Date(`${today}T12:00:00`);
	if (!used.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
	while (used.has(dateKey(cursor))) {
		currentStreak += 1;
		cursor.setDate(cursor.getDate() - 1);
	}
	let longestStreak = 0;
	let streakEnd = "";
	let run = 0;
	let runEnd = "";
	let prev = "";
	for (const day of byDay) {
		run = prev && diffDays(prev, day.date) === 1 ? run + 1 : 1;
		runEnd = day.date;
		if (run > longestStreak) {
			longestStreak = run;
			streakEnd = runEnd;
		}
		prev = day.date;
	}

	// 补零的最近 30 天
	const trend30: BoardDay[] = [];
	for (let offset = 29; offset >= 0; offset--) {
		const date = new Date(`${today}T12:00:00`);
		date.setDate(date.getDate() - offset);
		const key = dateKey(date);
		trend30.push({ date: key, tokens: dayMap.get(key) ?? 0 });
	}

	const peak = byDay.reduce<BoardDay | null>((best, day) => (!best || day.tokens > best.tokens ? day : best), null);
	const models = [...modelMap.entries()].map(([, row]) => row).sort((a, b) => b.tokens - a.tokens);

	// 里程碑：生涯开始 → 累计阈值 → 单日峰值 → 最长连续 → 上线日
	const milestones: BoardMilestone[] = [];
	if (firstDate) milestones.push({ date: firstDate, key: "start" });
	const thresholds: { key: BoardMilestone["key"]; limit: number }[] = [
		{ key: "t10m", limit: 10_000_000 },
		{ key: "t100m", limit: 100_000_000 },
		{ key: "t1b", limit: 1_000_000_000 },
		{ key: "t10b", limit: 10_000_000_000 },
	];
	let cumulative = 0;
	let crossed = 0;
	for (const day of byDay) {
		cumulative += day.tokens;
		while (crossed < thresholds.length && cumulative >= thresholds[crossed]!.limit) {
			milestones.push({ date: day.date, key: thresholds[crossed]!.key });
			crossed += 1;
		}
	}
	if (peak) milestones.push({ date: peak.date, key: "peak", value: peak.tokens });
	if (longestStreak > 1 && streakEnd) milestones.push({ date: streakEnd, key: "streak", value: longestStreak });
	milestones.push({ date: today, key: "launch" });

	return {
		totals,
		byDay,
		trend30,
		spark14: trend30.slice(-14),
		careerDays,
		activeDays: byDay.length,
		currentStreak,
		longestStreak,
		...(streakEnd ? { longestStreakEnd: streakEnd } : {}),
		avgPerDay: careerDays > 0 ? totals.totalTokens / careerDays : 0,
		peak,
		sessions,
		models,
		milestones,
		firstDate,
	};
}

// ---------------------------------------------------------------------------
// 使用趋势：可切范围，按 Agent 堆叠（前 5 名 + 其他），长范围按周聚合
// ---------------------------------------------------------------------------

export type TrendRange = "30" | "90" | "year" | "all";

export interface TrendBucket {
	/** 日粒度时 start === end；周粒度为周一 ~ 周日。 */
	start: string;
	end: string;
	total: number;
	/** 分组 id（Agent id 或 OTHER_GROUP）→ tokens。 */
	parts: Record<string, number>;
}

export interface Trend {
	buckets: TrendBucket[];
	/** 堆叠顺序（底 → 顶），按范围内用量降序。 */
	groups: string[];
	weekly: boolean;
	total: number;
	/** 有用量的桶数（天或周）。 */
	activeBuckets: number;
}

/** 超过这个天数就按周聚合，避免柱子细成线。 */
const TREND_WEEKLY_AFTER_DAYS = 120;
const TREND_TOP_GROUPS = 5;

function mondayKey(key: string): string {
	const date = new Date(`${key}T12:00:00`);
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return dateKey(date);
}

function shiftDays(key: string, days: number): string {
	const date = new Date(`${key}T12:00:00`);
	date.setDate(date.getDate() + days);
	return dateKey(date);
}

export function buildTrend(
	agents: CareerAgentUsage[],
	filterId: string,
	range: TrendRange,
	today = localToday(),
): Trend {
	const scope = (filterId ? agents.filter((agent) => agent.id === filterId) : agents).filter(
		(agent) => agent.byDay.length > 0,
	);
	let firstDate: string | undefined;
	for (const agent of scope) {
		for (const day of agent.byDay)
			if (day.totalTokens > 0 && (!firstDate || day.date < firstDate)) firstDate = day.date;
	}
	const start =
		range === "30"
			? shiftDays(today, -29)
			: range === "90"
				? shiftDays(today, -89)
				: range === "year"
					? `${today.slice(0, 4)}-01-01`
					: (firstDate ?? shiftDays(today, -29));
	const weekly = diffDays(start, today) + 1 > TREND_WEEKLY_AFTER_DAYS;

	const buckets: TrendBucket[] = [];
	const indexOf = new Map<string, number>();
	if (weekly) {
		for (let monday = mondayKey(start); monday <= today; monday = shiftDays(monday, 7)) {
			const end = shiftDays(monday, 6);
			for (let day = monday; day <= end; day = shiftDays(day, 1)) indexOf.set(day, buckets.length);
			buckets.push({ start: monday, end, total: 0, parts: {} });
		}
	} else {
		for (let day = start; day <= today; day = shiftDays(day, 1)) {
			indexOf.set(day, buckets.length);
			buckets.push({ start: day, end: day, total: 0, parts: {} });
		}
	}

	const sums = new Map<string, number>();
	for (const agent of scope) {
		let sum = 0;
		for (const day of agent.byDay) if (day.date >= start && day.date <= today) sum += day.totalTokens;
		if (sum > 0) sums.set(agent.id, sum);
	}
	const ranked = [...sums.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
	const top = new Set(ranked.slice(0, TREND_TOP_GROUPS));
	const groups = [...top, ...(ranked.length > TREND_TOP_GROUPS ? [OTHER_GROUP] : [])];

	for (const agent of scope) {
		const group = top.has(agent.id) ? agent.id : OTHER_GROUP;
		for (const day of agent.byDay) {
			if (day.date < start || day.date > today) continue;
			const index = indexOf.get(day.date);
			if (index === undefined) continue;
			const bucket = buckets[index]!;
			bucket.parts[group] = (bucket.parts[group] ?? 0) + day.totalTokens;
			bucket.total += day.totalTokens;
		}
	}
	return {
		buckets,
		groups,
		weekly,
		total: buckets.reduce((sum, bucket) => sum + bucket.total, 0),
		activeBuckets: buckets.filter((bucket) => bucket.total > 0).length,
	};
}

// ---------------------------------------------------------------------------
// 近一年热力：53 周、周一起排，按自己用量的分位分档；附带本月/最猛月份/星期分布
// ---------------------------------------------------------------------------

export interface YearHeatCell {
	date: string;
	tokens: number;
	/** -1 = 今天之后的占位格；0 = 无用量；1-4 = 分位档。 */
	level: number;
}

export interface YearHeat {
	/** 按列（周）展开：weeks[w][0..6] = 周一 .. 周日。 */
	weeks: YearHeatCell[][];
	/** 月份刻度：该月第一次出现的周序号。 */
	months: { week: number; month: number }[];
	activeDays: number;
	total: number;
	monthToDate: number;
	/** 上月同期（1 号到今天同一日）。 */
	lastMonthToDate: number;
	bestMonth: { month: string; tokens: number } | null;
	/** 周一 .. 周日的累计用量。 */
	weekday: number[];
}

export const YEAR_HEAT_WEEKS = 53;

export function buildYearHeat(byDay: BoardDay[], today = localToday()): YearHeat {
	const tokensByDate = new Map(byDay.map((day) => [day.date, day.tokens]));
	const start = shiftDays(mondayKey(today), -(YEAR_HEAT_WEEKS - 1) * 7);
	const values: number[] = [];
	for (let day = start; day <= today; day = shiftDays(day, 1)) {
		const tokens = tokensByDate.get(day) ?? 0;
		if (tokens > 0) values.push(tokens);
	}
	values.sort((a, b) => a - b);
	const quantile = (p: number): number => values[Math.floor((values.length - 1) * p)] ?? 0;
	const cuts = [quantile(0.25), quantile(0.5), quantile(0.8)];
	const level = (tokens: number): number =>
		tokens <= 0 ? 0 : tokens <= cuts[0]! ? 1 : tokens <= cuts[1]! ? 2 : tokens <= cuts[2]! ? 3 : 4;

	const thisMonth = today.slice(0, 7);
	const lastMonthDate = new Date(`${thisMonth}-01T12:00:00`);
	lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
	const lastMonth = dateKey(lastMonthDate).slice(0, 7);
	const dayOfMonth = today.slice(8);

	const weeks: YearHeatCell[][] = [];
	const months: YearHeat["months"] = [];
	const monthSums = new Map<string, number>();
	const weekday = [0, 0, 0, 0, 0, 0, 0];
	let total = 0;
	let monthToDate = 0;
	let lastMonthToDate = 0;
	let lastSeenMonth = "";
	for (let week = 0; week < YEAR_HEAT_WEEKS; week++) {
		const monday = shiftDays(start, week * 7);
		if (monday.slice(0, 7) !== lastSeenMonth) {
			if (week > 0) months.push({ week, month: Number(monday.slice(5, 7)) });
			lastSeenMonth = monday.slice(0, 7);
		}
		const column: YearHeatCell[] = [];
		for (let offset = 0; offset < 7; offset++) {
			const date = shiftDays(monday, offset);
			if (date > today) {
				column.push({ date, tokens: 0, level: -1 });
				continue;
			}
			const tokens = tokensByDate.get(date) ?? 0;
			column.push({ date, tokens, level: level(tokens) });
			total += tokens;
			weekday[offset]! += tokens;
			monthSums.set(date.slice(0, 7), (monthSums.get(date.slice(0, 7)) ?? 0) + tokens);
			if (date.startsWith(thisMonth)) monthToDate += tokens;
			if (date.startsWith(lastMonth) && date.slice(8) <= dayOfMonth) lastMonthToDate += tokens;
		}
		weeks.push(column);
	}
	const best = [...monthSums.entries()].sort((a, b) => b[1] - a[1])[0];
	return {
		weeks,
		months,
		activeDays: values.length,
		total,
		monthToDate,
		lastMonthToDate,
		bestMonth: best && best[1] > 0 ? { month: best[0], tokens: best[1] } : null,
		weekday,
	};
}

// ---------------------------------------------------------------------------
// 展示格式化
// ---------------------------------------------------------------------------

/** 中文习惯 亿/万，英文 M/k（与开始页使用概览的 M/k 口径一致）。 */
export function formatTokens(value: number, lang: "zh" | "en"): string {
	if (lang === "zh") {
		if (value >= 1e8) return `${trimZeros((value / 1e8).toFixed(2))} 亿`;
		if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e6 ? 0 : 1)} 万`;
		return value.toLocaleString("zh-CN");
	}
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function trimZeros(text: string): string {
	return text.replace(/\.?0+$/, "");
}

/** 趋势/热力图日期标签：本年内只显示 MM-DD。 */
export function shortDate(date: string): string {
	const year = String(new Date().getFullYear());
	return date.startsWith(`${year}-`) ? date.slice(5) : date;
}

/** 快照时间：ISO → 本机 YYYY-MM-DD HH:mm。 */
export function snapshotTime(iso: string): string {
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) return iso;
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${dateKey(date)} ${hh}:${mm}`;
}
