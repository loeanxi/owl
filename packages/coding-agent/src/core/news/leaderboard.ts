import { fetchArenaLeaderboard } from "./arena-leaderboard.ts";
import { ARTIFICIAL_ANALYSIS_URL, parseArtificialAnalysisLeaderboard } from "./artificial-analysis.ts";
import { fetchCurrentLiveBench } from "./livebench-current.ts";
import { fetchNewsText, type NewsFetchOptions, NewsHttpRejectedError } from "./sources.ts";
import type { NewsStore } from "./store.ts";
import type { NewsLeaderboardBoard, NewsLeaderboardEntry, NewsLeaderboardResponse } from "./types.ts";

export type { NewsLeaderboardBoard, NewsLeaderboardEntry, NewsLeaderboardResponse } from "./types.ts";

const REFRESH_MINUTES = 30;
const RETRY_MS = 2 * 60_000;
const SWE_DATA_URL = "https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json";

const BOARDS: Omit<NewsLeaderboardBoard, "updatedAt" | "checkedAt" | "stale" | "error" | "entries">[] = [
	{
		id: "livebench-overall",
		title: "LiveBench 2.0 综合能力",
		tabLabel: "LiveBench",
		category: "general",
		description: "读取 LiveBench 当前网站部署中的最新结果，按官方各任务领域等权计算综合分，保留推理版本。",
		sourceName: "LiveBench",
		sourceUrl: "https://livebench.ai/",
		dataUrl: "https://livebench.ai/",
		metric: "综合得分",
		scoreUnit: "分",
	},
	{
		id: "arena-code",
		title: "Arena 网页开发",
		tabLabel: "Arena 编程",
		category: "coding",
		description: "来自 Arena 当前网页开发榜的用户对战评价，按官方偏好评分排名；评分不是代码问题解决率。",
		sourceName: "Arena",
		sourceUrl: "https://arena.ai/leaderboard/code/webdev",
		dataUrl: "https://arena.ai/leaderboard/code/webdev",
		metric: "对战偏好评分",
		scoreUnit: "Elo",
	},
	{
		id: "artificial-analysis",
		title: "Artificial Analysis 综合智能",
		tabLabel: "Artificial Analysis",
		category: "general",
		description:
			"直接读取官方公开模型表的 Intelligence Index，保留模型与推理版本；同时展示官方每任务费用及输出速度。",
		sourceName: "Artificial Analysis",
		sourceUrl: ARTIFICIAL_ANALYSIS_URL,
		dataUrl: ARTIFICIAL_ANALYSIS_URL,
		metric: "Intelligence Index",
		scoreUnit: "分",
	},
	{
		id: "swe-bench-verified",
		title: "SWE-bench 代码修复",
		tabLabel: "SWE-bench 历史参考",
		reference: true,
		category: "coding",
		description: "Verified 的 mini-SWE-agent 评测结果，按真实代码问题解决率排序；保留推理强度与评测日期。",
		sourceName: "SWE-bench",
		sourceUrl: "https://www.swebench.com/#verified",
		dataUrl: SWE_DATA_URL,
		metric: "问题解决率",
		scoreUnit: "%",
	},
];

/** Assess the source's data date separately from transport success, including cached responses. */
export function leaderboardFreshness(updatedAt: string | null): NonNullable<NewsLeaderboardBoard["freshness"]> {
	const published = updatedAt ? Date.parse(updatedAt) : Number.NaN;
	if (!Number.isFinite(published) || published > Date.now() + 86400000)
		return { state: "unknown", ageDays: null, reason: "来源未提供可核验的榜单更新时间，同步时间不代表测评时间。" };
	const ageDays = Math.max(0, Math.floor((Date.now() - published) / 86400000));
	return {
		state: ageDays > 30 ? "outdated" : "current",
		ageDays,
		reason: ageDays > 30 ? "来源超过 30 天未更新数据，可能未覆盖近期发布的模型。" : null,
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scoreValue(value: unknown): number | undefined {
	if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 && number <= 100 ? number : undefined;
}

function publicUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function rankEntries(entries: NewsLeaderboardEntry[]): NewsLeaderboardEntry[] {
	const sorted = entries.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	let rank = 0;
	return sorted.map((entry, index) => {
		if (!index || sorted[index - 1]?.score !== entry.score) rank = index + 1;
		return { ...entry, rank };
	});
}

/** Keep the same agent environment and omit submissions the source itself warns against. */
export function parseSweBenchLeaderboard(data: unknown): {
	entries: NewsLeaderboardEntry[];
	updatedAt: string | null;
} {
	const boards = record(data)?.leaderboards;
	if (!Array.isArray(boards)) throw new Error("SWE-bench 榜单格式已变化");
	const board = boards.map(record).find((candidate) => candidate?.name === "Verified");
	if (!Array.isArray(board?.results)) throw new Error("SWE-bench 未提供 Verified 榜单");
	const entries: NewsLeaderboardEntry[] = [];
	const dates: string[] = [];
	const seen = new Set<string>();
	for (const value of board.results) {
		const item = record(value);
		if (!item || item.warning || item.agent !== "mini-SWE-agent") continue;
		const score = scoreValue(item.resolved);
		const model = stringValue(item.model_display) ?? stringValue(item.name);
		const id = stringValue(item.folder);
		if (score === undefined || !model || !id || seen.has(id)) continue;
		seen.add(id);
		const date = typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : undefined;
		if (date) dates.push(date);
		const effort = stringValue(item.reasoning_effort);
		const version = stringValue(item["mini-swe-agent_version"]);
		entries.push({
			id,
			rank: 0,
			model: effort ? `${model} (${effort})` : model,
			organization: stringValue(item.model_org),
			score,
			url: publicUrl(item.site),
			detail: [version ? `mini-SWE-agent ${version}` : "mini-SWE-agent", date].filter(Boolean).join(" · "),
		});
	}
	if (!entries.length) throw new Error("SWE-bench 暂无可核验的同环境评测结果");
	return { entries: rankEntries(entries), updatedAt: dates.sort().at(-1) ?? null };
}

/** CSV parser supporting quoted commas/newlines and escaped double quotes without executing upstream code. */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const input = text.replace(/^\uFEFF/, "");
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (char === '"') {
			if (quoted && input[index + 1] === '"') {
				field += '"';
				index++;
			} else if (quoted || !field) quoted = !quoted;
			else throw new Error("LiveBench CSV 引号格式异常");
		} else if (!quoted && (char === "," || char === "\n" || char === "\r")) {
			row.push(field);
			field = "";
			if (char !== ",") {
				if (row.some((cell) => cell.trim())) rows.push(row);
				row = [];
				if (char === "\r" && input[index + 1] === "\n") index++;
			}
		} else field += char;
	}
	if (quoted) throw new Error("LiveBench CSV 内容不完整");
	row.push(field);
	if (row.some((cell) => cell.trim())) rows.push(row);
	return rows;
}

interface LiveBenchModel {
	name: string;
	organization?: string;
	url?: string;
	finetune: boolean;
}

/** Read only literal metadata in the official model map. Never import/eval remote JavaScript. */
function liveBenchModels(text: string): Map<string, LiveBenchModel> {
	const source = text.match(/export\s+const\s+modelLinks\s*=\s*\{([\s\S]*?)\n\s*\};/)?.[1];
	if (!source) throw new Error("LiveBench 模型目录格式已变化");
	const starts = [...source.matchAll(/^\s{4}["']([^"']+)["']\s*:\s*\{/gm)];
	const models = new Map<string, LiveBenchModel>();
	for (const [index, match] of starts.entries()) {
		const body = source.slice((match.index ?? 0) + match[0].length, starts[index + 1]?.index ?? source.length);
		const base = body.split(/\b(?:variants|finetune)\s*:/)[0] ?? body;
		const readString = (fields: string, key: string) => {
			const value = fields.match(new RegExp(`\\b${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`))?.[1];
			if (!value) return undefined;
			if (value.startsWith('"')) return stringValue(JSON.parse(value));
			return (
				value
					.slice(1, -1)
					.replace(/\\(['\\])/g, "$1")
					.trim() || undefined
			);
		};
		const model: LiveBenchModel = {
			name: readString(base, "displayName") ?? match[1]!,
			organization: readString(base, "organization"),
			url: publicUrl(readString(base, "url")),
			finetune: /\bfinetune\s*:\s*\{/.test(body),
		};
		models.set(match[1]!, model);
		const variants = body.match(/\bvariants\s*:\s*\[([\s\S]*?)\]/)?.[1];
		for (const variant of variants?.matchAll(/\{([^{}]*)\}/g) ?? []) {
			const id = readString(variant[1]!, "rawName");
			if (id)
				models.set(id, {
					...model,
					name: readString(variant[1]!, "displayName") ?? model.name,
					url: publicUrl(readString(variant[1]!, "url")) ?? model.url,
				});
		}
	}
	if (!models.size) throw new Error("LiveBench 未返回可识别的模型目录");
	return models;
}

/** Match LiveBench's category-weighted Global Average; missing categories are never treated as zero. */
export function parseLiveBenchLeaderboard(
	csv: string,
	categoryData: unknown,
	metadata: string,
): NewsLeaderboardEntry[] {
	const categories = record(categoryData);
	if (!categories || !Object.keys(categories).length) throw new Error("LiveBench 评测领域格式已变化");
	const rows = parseCsv(csv);
	const headers = rows.shift();
	if (!headers || !headers.includes("model") || new Set(headers).size !== headers.length)
		throw new Error("LiveBench CSV 缺少有效表头");
	const categoryIndexes: number[][] = [];
	for (const columns of Object.values(categories)) {
		if (!Array.isArray(columns) || !columns.length || columns.some((column) => typeof column !== "string"))
			throw new Error("LiveBench 评测领域缺少子任务");
		const indexes = columns.map((column) => headers.indexOf(column));
		if (indexes.some((index) => index < 0)) throw new Error("LiveBench CSV 缺少评测子任务");
		categoryIndexes.push(indexes);
	}
	const models = liveBenchModels(metadata);
	const entries: NewsLeaderboardEntry[] = [];
	const seen = new Set<string>();
	const modelIndex = headers.indexOf("model");
	for (const row of rows) {
		if (row.length !== headers.length) throw new Error("LiveBench CSV 列数不一致");
		const id = row[modelIndex]?.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const model = models.get(id);
		if (!model || model.finetune) continue;
		const averages = categoryIndexes.map((indexes) => {
			const values = indexes.map((index) => scoreValue(row[index])).filter((value) => value !== undefined);
			return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
		});
		if (averages.some((value) => value === undefined)) continue;
		const score = Number(
			(averages.reduce<number>((sum, value) => sum + (value ?? 0), 0) / averages.length).toFixed(2),
		);
		entries.push({
			id,
			rank: 0,
			model: model.name,
			organization: model.organization,
			score,
			url: model.url,
			detail: id,
		});
	}
	if (!entries.length) throw new Error("LiveBench 暂无完整的综合评测结果");
	return rankEntries(entries);
}

interface CachedBoard {
	board: NewsLeaderboardBoard;
	attemptedAt: string;
}

export class NewsLeaderboardService {
	private readonly store: Pick<NewsStore, "cachedResponse" | "saveResponseCache">;
	private readonly options: NewsFetchOptions;
	private flight: Promise<NewsLeaderboardResponse> | null = null;

	constructor(store: Pick<NewsStore, "cachedResponse" | "saveResponseCache">, options: NewsFetchOptions = {}) {
		this.store = store;
		this.options = options;
	}

	async get(forceRefresh = false): Promise<NewsLeaderboardResponse> {
		if (this.flight) return this.flight;
		const operation = Promise.all(BOARDS.map((board) => this.loadBoard(board, forceRefresh))).then((boards) => ({
			boards: boards.map((board) => ({ ...board, freshness: leaderboardFreshness(board.updatedAt) })),
			refreshIntervalMinutes: REFRESH_MINUTES,
		}));
		this.flight = operation;
		try {
			return await operation;
		} finally {
			if (this.flight === operation) this.flight = null;
		}
	}

	private async loadBoard(definition: (typeof BOARDS)[number], force: boolean): Promise<NewsLeaderboardBoard> {
		// A source change must not make the old v1 GitHub snapshot look like a result from the current site.
		const key = `news-leaderboard:v2:${definition.id}`;
		const saved = record(this.store.cachedResponse(key));
		const previous = record(saved?.board);
		const cached =
			previous?.id === definition.id &&
			Array.isArray(previous.entries) &&
			previous.entries.every((entry) => {
				const value = record(entry);
				return (
					typeof value?.id === "string" &&
					typeof value.model === "string" &&
					typeof value.score === "number" &&
					Number.isFinite(value.score) &&
					value.score >= 0 &&
					value.score <= 100000
				);
			}) &&
			typeof saved?.attemptedAt === "string"
				? (saved as unknown as CachedBoard)
				: undefined;
		const now = Date.now();
		if (cached && !force) {
			const lifetime = cached.board.error ? RETRY_MS : REFRESH_MINUTES * 60_000;
			const elapsed = now - Date.parse(cached.attemptedAt);
			if (elapsed >= 0 && elapsed < lifetime)
				return { ...cached.board, ...definition, dataUrl: cached.board.dataUrl };
		}
		const base: NewsLeaderboardBoard = {
			...definition,
			updatedAt: cached?.board.updatedAt ?? null,
			checkedAt: cached?.board.checkedAt ?? null,
			dataUrl: cached?.board.dataUrl ?? definition.dataUrl,
			entries: cached?.board.entries ?? [],
			stale: true,
			error: null,
		};
		const deadline = AbortSignal.timeout(45_000);
		const signal = this.options.signal ? AbortSignal.any([this.options.signal, deadline]) : deadline;
		const getText = async (url: string, headers: Record<string, string> = {}): Promise<string> => {
			const response = await fetchNewsText(
				url,
				{
					headers: {
						accept: "application/json,text/csv,text/plain,text/html",
						"user-agent": "Owl-News/1.0",
						...headers,
					},
				},
				{ ...this.options, timeoutMs: 20_000, maxBytes: 12 * 1024 * 1024, signal },
			);
			if (response.status < 200 || response.status >= 300) throw new NewsHttpRejectedError(response.status);
			return response.text;
		};
		let board: NewsLeaderboardBoard;
		try {
			if (definition.id === "swe-bench-verified") {
				const parsed = parseSweBenchLeaderboard(JSON.parse(await getText(SWE_DATA_URL)) as unknown);
				board = { ...base, ...parsed, checkedAt: new Date().toISOString(), stale: false };
			} else if (definition.id === "livebench-overall") {
				const current = await fetchCurrentLiveBench(getText);
				board = {
					...base,
					dataUrl: current.dataUrl,
					updatedAt: current.updatedAt,
					checkedAt: new Date().toISOString(),
					stale: false,
					entries: current.entries,
				};
			} else if (definition.id === "arena-code") {
				const current = await fetchArenaLeaderboard(getText);
				board = {
					...base,
					entries: current.entries,
					updatedAt: current.updatedAt,
					dataUrl: current.dataUrl,
					checkedAt: new Date().toISOString(),
					stale: false,
				};
			} else {
				const current = parseArtificialAnalysisLeaderboard(await getText(ARTIFICIAL_ANALYSIS_URL));
				board = { ...base, ...current, checkedAt: new Date().toISOString(), stale: false };
			}
		} catch (error) {
			board = { ...base, error: error instanceof Error ? error.message : "榜单暂时无法同步" };
		}
		this.store.saveResponseCache(key, { board, attemptedAt: new Date().toISOString() } satisfies CachedBoard);
		return board;
	}
}
