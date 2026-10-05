/** 热力图最多渲染的周数（Claude 同款半年量级，铺满概览卡片）。 */
export const HEATMAP_WEEKS = 26;

export type UsageRange = "all" | "30d" | "7d";

export interface HeatDay {
	date: string;
	totalTokens: number;
}

export interface HeatCell {
	date: string;
	tokens: number;
	level: number;
}

function dateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function parseDateKey(key: string): Date {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, 12, 0, 0, 0);
}

function mondayOf(date: Date): Date {
	const monday = new Date(date);
	monday.setHours(12, 0, 0, 0);
	monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return monday;
}

function chunkWeeks(flat: HeatCell[]): HeatCell[][] {
	const cells: HeatCell[][] = [];
	for (let index = 0; index < flat.length; index += 7) cells.push(flat.slice(index, index + 7));
	return cells;
}

function heatLevel(tokens: number, max: number): number {
	return tokens <= 0 ? 0 : Math.min(4, 1 + Math.floor((tokens / max) * 4));
}

/** 「全部」：固定铺最近 26 周，右端对齐本周。没用量的日子是可见灰块；
 *  本周还没到的日子隐藏，不当成零用量。历史只有几天时也不许收成一列。 */
function fullHeatmap(byDay: HeatDay[]): HeatCell[][] {
	const tokensByDate = new Map(byDay.map((day) => [day.date, day.totalTokens]));
	const today = new Date();
	today.setHours(12, 0, 0, 0);
	const todayKey = dateKey(today);
	const endMonday = mondayOf(today);
	const start = new Date(endMonday);
	start.setDate(endMonday.getDate() - (HEATMAP_WEEKS - 1) * 7);
	const end = new Date(endMonday);
	end.setDate(endMonday.getDate() + 6);
	const dates: string[] = [];
	const cursor = new Date(start);
	while (cursor <= end) {
		dates.push(dateKey(cursor));
		cursor.setDate(cursor.getDate() + 1);
	}
	let max = 1;
	for (const date of dates) {
		if (date > todayKey) continue;
		const tokens = tokensByDate.get(date) ?? 0;
		if (tokens > 0) max = Math.max(max, tokens);
	}
	return chunkWeeks(dates.map((date) => {
		if (date > todayKey) return { date: "", tokens: 0, level: -1 };
		const tokens = tokensByDate.get(date) ?? 0;
		return { date, tokens, level: heatLevel(tokens, max) };
	}));
}

/** 7 天 / 30 天跟接口窗口走，不补半年空格。窗口外的对齐格隐藏，不当成零用量。 */
function spannedHeatmap(byDay: HeatDay[]): HeatCell[][] {
	if (byDay.length === 0) return [];
	const tokensByDate = new Map(byDay.map((day) => [day.date, day.totalTokens]));
	const sorted = [...byDay].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const first = parseDateKey(sorted[0]!.date);
	const last = parseDateKey(sorted[sorted.length - 1]!.date);
	const endMonday = mondayOf(last);
	const cap = new Date(endMonday);
	cap.setDate(endMonday.getDate() - (HEATMAP_WEEKS - 1) * 7);
	const dataMonday = mondayOf(first);
	const start = dataMonday > cap ? dataMonday : cap;
	const end = new Date(endMonday);
	end.setDate(endMonday.getDate() + 6);
	const firstKey = sorted[0]!.date;
	const lastKey = sorted[sorted.length - 1]!.date;
	const dates: string[] = [];
	const cursor = new Date(start);
	while (cursor <= end) {
		dates.push(dateKey(cursor));
		cursor.setDate(cursor.getDate() + 1);
	}
	let max = 1;
	for (const date of dates) {
		const tokens = tokensByDate.get(date);
		if (tokens !== undefined) max = Math.max(max, tokens);
	}
	return chunkWeeks(dates.map((date) => {
		const tokens = tokensByDate.get(date);
		if (tokens === undefined || date < firstKey || date > lastKey) return { date: "", tokens: 0, level: -1 };
		return { date, tokens, level: heatLevel(tokens, max) };
	}));
}

export function heatmapCells(byDay: HeatDay[], range: UsageRange): { cells: HeatCell[][]; fill: boolean } {
	if (range === "all") return { cells: fullHeatmap(byDay), fill: true };
	return { cells: spannedHeatmap(byDay), fill: false };
}
