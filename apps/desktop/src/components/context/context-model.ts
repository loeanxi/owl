/**
 * 上下文页的纯计算：分类配色、格式化、按轮聚合、会话统计、耗时拆分。
 * 分类与配色对齐 dsh-context 的 Context 标签页（模型读取顺序）。
 */
import type {
	ContextCategory,
	ContextEventRow,
	ContextFileOp,
	ContextRequestRow,
	ContextTimingTotals,
	ContextToolRef,
} from "../../bridge/protocol.ts";

export interface InsightData {
	sessionId?: string;
	requests: ContextRequestRow[];
	events: ContextEventRow[];
	tools: ContextToolRef[];
	files: ContextFileOp[];
	timing: ContextTimingTotals;
	liveVersion: string;
	/** 本数据是按会话转录重建的（历史会话兜底），不是插件现采。 */
	reconstructed?: boolean;
}

export const EMPTY_INSIGHT: InsightData = {
	requests: [],
	events: [],
	tools: [],
	files: [],
	timing: { activeMs: 0, toolRuns: 0, toolMs: 0 },
	liveVersion: "",
};

export const CATS: ReadonlyArray<{ key: ContextCategory; label: string; color: string }> = [
	{ key: "system", label: "系统提示词", color: "#6366f1" },
	{ key: "toolSchemas", label: "工具定义", color: "#f59e0b" },
	{ key: "user", label: "用户消息", color: "#22c55e" },
	{ key: "inject", label: "注入内容", color: "#a855f7" },
	{ key: "assistant", label: "助手消息", color: "#3b82f6" },
	{ key: "toolResult", label: "工具结果", color: "#14b8a6" },
	{ key: "other", label: "其他", color: "#94a3b8" },
];

export const CAT_LABEL = Object.fromEntries(CATS.map((cat) => [cat.key, cat.label])) as Record<ContextCategory, string>;
export const CAT_COLOR = Object.fromEntries(CATS.map((cat) => [cat.key, cat.color])) as Record<ContextCategory, string>;
export const OUTPUT_COLOR = "#ec4899";

export interface Part {
	key: string;
	label: string;
	color: string;
	/** 条宽 / 占比所用的数值（可能已按实测锚定）。 */
	value: number;
	/** 估算原值（图例的 ≈ 数字）。 */
	raw?: number;
	sub?: string;
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

export function fmtTokens(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "—";
	const abs = Math.abs(n);
	if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(Math.round(n));
}

export function fmtSigned(n: number): string {
	if (n === 0) return "±0";
	return `${n > 0 ? "+" : "−"}${fmtTokens(Math.abs(n))}`;
}

export function fmtPct(share: number): string {
	if (!Number.isFinite(share) || share <= 0) return "0%";
	const pct = share * 100;
	if (pct < 0.1) return "<0.1%";
	return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

export function fmtPct1(share: number): string {
	if (!Number.isFinite(share) || share <= 0) return "0.0%";
	const pct = share * 100;
	return pct < 0.1 ? "<0.1%" : `${pct.toFixed(1)}%`;
}

export function fmtTime(ts: number | undefined): string {
	if (ts === undefined) return "";
	const date = new Date(ts);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fmtDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes - hours * 60).padStart(2, "0")}m`;
}

export function fmtCost(usd: number | undefined): string {
	if (usd === undefined) return "—";
	if (usd >= 1) return `$${usd.toFixed(2)}`;
	if (usd >= 0.01) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(5)}`;
}

export function stepTitle(row: Pick<ContextRequestRow, "turn" | "step">, stepsInTurn: number): string {
	return `第 ${row.turn} 轮 · 第 ${row.step} 步 (共 ${stepsInTurn} 步)`;
}

export function stamp(turn: number, step: number): string {
	return `T${turn} S${step}`;
}

// ---------------------------------------------------------------------------
// 口径
// ---------------------------------------------------------------------------

type Usage = NonNullable<ContextRequestRow["usage"]>;

/** 本次请求的计费输入（未缓存 + 缓存读 + 缓存写）。 */
export function promptTokensOf(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** 实测上下文占用：优先 totalTokens，否则四项之和。 */
export function measuredOf(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function cacheHitOf(usage: Usage): number | undefined {
	const prompt = promptTokensOf(usage);
	return prompt > 0 ? usage.cacheRead / prompt : undefined;
}

export function compositionParts(row: ContextRequestRow): Part[] {
	return CATS.map((cat) => ({ key: cat.key, label: cat.label, color: cat.color, value: row.composition[cat.key] ?? 0 }));
}

/** 估算构成按实测总量重新配比：估算给比例，provider 给总量；raw 保留估算原值。 */
export function anchorParts(parts: Part[], target: number | undefined): Part[] {
	const sourced = parts.map((part) => ({ ...part, raw: part.raw ?? part.value }));
	const total = sourced.reduce((sum, part) => sum + part.raw, 0);
	if (!target || target <= 0 || total <= 0) return sourced;
	const scale = target / total;
	return sourced.map((part) => ({ ...part, value: Math.round(part.raw * scale) }));
}

// ---------------------------------------------------------------------------
// 趋势：按步 / 按轮
// ---------------------------------------------------------------------------

export interface TrendBar {
	/** 步粒度为该步；轮粒度为该轮最后一步。 */
	row: ContextRequestRow;
	/** 轮粒度下该轮的步数（步粒度为 1）。 */
	stepCount: number;
	/** 步：模型耗时；轮：各步之和。 */
	duration?: number;
}

export function stepsByTurn(requests: readonly ContextRequestRow[]): Map<number, number> {
	const counts = new Map<number, number>();
	for (const row of requests) counts.set(row.turn, Math.max(counts.get(row.turn) ?? 0, row.step));
	return counts;
}

export function barsOf(requests: readonly ContextRequestRow[], granularity: "step" | "turn"): TrendBar[] {
	if (granularity === "step") {
		return requests.map((row) => ({ row, stepCount: 1, duration: row.timing?.model }));
	}
	const bars: TrendBar[] = [];
	for (const row of requests) {
		const last = bars[bars.length - 1];
		if (last && last.row.turn === row.turn) {
			last.row = row;
			last.stepCount += 1;
			if (row.timing?.model !== undefined) last.duration = (last.duration ?? 0) + row.timing.model;
		} else {
			bars.push({ row, stepCount: 1, duration: row.timing?.model });
		}
	}
	return bars;
}

// ---------------------------------------------------------------------------
// 会话统计
// ---------------------------------------------------------------------------

export interface SessionStats {
	turns: number;
	steps: number;
	toolCalls: number;
	answers: number;
	cacheHit?: number;
	cost?: number;
	billed: Part[];
	billedTotal: number;
	output: number;
}

/**
 * Token 统计按「花在什么上」拆计费合计：每步的计费输入按该步估算构成配比，
 * 输出单列；各部分之和即会话的计费总量。
 */
export function sessionStatsOf(requests: readonly ContextRequestRow[]): SessionStats {
	const billed: Record<string, number> = {};
	let output = 0;
	let prompt = 0;
	let cacheRead = 0;
	let cost = 0;
	let priced = false;
	let toolCalls = 0;
	let answers = 0;
	const turns = new Set<number>();
	for (const row of requests) {
		turns.add(row.turn);
		toolCalls += row.toolCalls ?? 0;
		if (row.brief?.response.some((item) => !item.chip)) answers += 1;
		const usage = row.usage;
		if (!usage) continue;
		const rowPrompt = promptTokensOf(usage);
		prompt += rowPrompt;
		cacheRead += usage.cacheRead;
		output += usage.output;
		if (typeof usage.cost === "number") {
			cost += usage.cost;
			priced = true;
		}
		const total = row.totalTokens;
		if (total <= 0) continue;
		for (const cat of CATS) billed[cat.key] = (billed[cat.key] ?? 0) + (rowPrompt * (row.composition[cat.key] ?? 0)) / total;
	}
	const parts: Part[] = [
		...CATS.map((cat) => ({ key: cat.key, label: cat.label, color: cat.color, value: Math.round(billed[cat.key] ?? 0) })),
		{ key: "output", label: "输出", color: OUTPUT_COLOR, value: output, sub: "含思考" },
	];
	return {
		turns: turns.size,
		steps: requests.length,
		toolCalls,
		answers,
		...(prompt > 0 ? { cacheHit: cacheRead / prompt } : {}),
		...(priced ? { cost } : {}),
		billed: parts,
		billedTotal: prompt + output,
		output,
	};
}

// ---------------------------------------------------------------------------
// 耗时统计
// ---------------------------------------------------------------------------

export interface TimingStats {
	parts: Part[];
	active: number;
	/** 输出速度 tok/s（输出 token ÷ 生成耗时）。 */
	tps?: number;
}

export function timingStatsOf(requests: readonly ContextRequestRow[], totals: ContextTimingTotals, now: number): TimingStats | undefined {
	let ttft = 0;
	let calls = 0;
	let thinking = 0;
	let answer = 0;
	let toolArgs = 0;
	let output = 0;
	for (const row of requests) {
		const timing = row.timing;
		if (!timing) continue;
		if (timing.ttft !== undefined) {
			ttft += timing.ttft;
			calls += 1;
		}
		thinking += timing.thinking;
		answer += timing.answer;
		toolArgs += timing.toolArgs;
		if (timing.model !== undefined) output += row.usage?.output ?? 0;
	}
	const measured = ttft + thinking + answer + toolArgs + totals.toolMs;
	const active = Math.max(totals.activeMs + (totals.activeSince !== undefined ? Math.max(0, now - totals.activeSince) : 0), measured);
	if (active <= 0) return undefined;
	const generation = thinking + answer + toolArgs;
	return {
		active,
		...(generation > 0 && output > 0 ? { tps: output / (generation / 1000) } : {}),
		parts: [
			{ key: "ttft", label: "模型等待", color: "#3b82f6", value: ttft, sub: `${fmtDuration(ttft)} · ${calls} 次` },
			{ key: "thinking", label: "模型思考", color: "#a855f7", value: thinking, sub: fmtDuration(thinking) },
			{ key: "answer", label: "模型回复", color: "#ec4899", value: answer, sub: fmtDuration(answer) },
			{ key: "toolArgs", label: "工具参数", color: "#f59e0b", value: toolArgs, sub: fmtDuration(toolArgs) },
			{
				key: "tools",
				label: "工具执行",
				color: "#14b8a6",
				value: totals.toolMs,
				sub: `${fmtDuration(totals.toolMs)} · ${totals.toolRuns} 次`,
			},
			{ key: "other", label: "其他开销", color: "#94a3b8", value: active - measured, sub: fmtDuration(active - measured) },
		],
	};
}

// ---------------------------------------------------------------------------
// 文件活动
// ---------------------------------------------------------------------------

export type FileKind = ContextFileOp["kind"];

export interface FileEntry {
	path: string;
	display: { dir: string; base: string };
	ops: ContextFileOp[];
	counts: Record<FileKind, number>;
	added: number;
	removed: number;
	errors: number;
	latest: number;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 工作区内的路径显示为 ./相对路径，目录部分弱化、文件名加粗。 */
export function displayPath(path: string, cwd: string): { dir: string; base: string } {
	let shown = normalizePath(path);
	const root = normalizePath(cwd);
	if (root && shown.toLowerCase().startsWith(`${root.toLowerCase()}/`)) shown = `./${shown.slice(root.length + 1)}`;
	else if (shown === "." || shown.toLowerCase() === root.toLowerCase()) return { dir: "", base: "./" };
	else if (!/^([a-z]:)?\//i.test(shown) && !shown.startsWith(".")) shown = `./${shown}`;
	const cut = shown.lastIndexOf("/");
	return cut >= 0 ? { dir: shown.slice(0, cut + 1), base: shown.slice(cut + 1) } : { dir: "", base: shown };
}

export function fileEntriesOf(ops: readonly ContextFileOp[], cwd: string, upTo?: number): FileEntry[] {
	const entries = new Map<string, FileEntry>();
	for (const op of ops) {
		if (upTo !== undefined && op.seq > upTo) continue;
		const key = normalizePath(op.path).toLowerCase();
		let entry = entries.get(key);
		if (!entry) {
			entry = {
				path: op.path,
				display: displayPath(op.path, cwd),
				ops: [],
				counts: { read: 0, write: 0, search: 0, image: 0 },
				added: 0,
				removed: 0,
				errors: 0,
				latest: 0,
			};
			entries.set(key, entry);
		}
		entry.ops.push(op);
		entry.counts[op.kind] += 1;
		entry.added += op.added ?? 0;
		entry.removed += op.removed ?? 0;
		if (!op.ok) entry.errors += 1;
		entry.latest = Math.max(entry.latest, op.ts);
	}
	return [...entries.values()];
}

const EXT_BADGES: Record<string, { text: string; color: string }> = {
	ts: { text: "TS", color: "#3178c6" },
	tsx: { text: "TSX", color: "#3178c6" },
	js: { text: "JS", color: "#d4a72c" },
	mjs: { text: "JS", color: "#d4a72c" },
	cjs: { text: "JS", color: "#d4a72c" },
	jsx: { text: "JSX", color: "#d4a72c" },
	css: { text: "CSS", color: "#7c3aed" },
	html: { text: "HT", color: "#e34c26" },
	json: { text: "{}", color: "#6b7280" },
	md: { text: "MD", color: "#6b7280" },
	py: { text: "PY", color: "#3572a5" },
	rs: { text: "RS", color: "#b7410e" },
	go: { text: "GO", color: "#00add8" },
	java: { text: "JV", color: "#b07219" },
	vue: { text: "VUE", color: "#41b883" },
	yml: { text: "YML", color: "#cb171e" },
	yaml: { text: "YML", color: "#cb171e" },
	sh: { text: "SH", color: "#4eaa25" },
	ps1: { text: "PS", color: "#012456" },
	sql: { text: "SQL", color: "#e38c00" },
	xml: { text: "XML", color: "#0060ac" },
};

export function fileBadgeOf(entry: FileEntry): { text: string; color?: string; glyph?: string } {
	if (entry.counts.image > 0) return { text: "", glyph: "🖼" };
	if (entry.display.base === "./" || (entry.counts.search > 0 && !/\.[a-z0-9]+$/i.test(entry.display.base))) return { text: "", glyph: "📁" };
	const ext = /\.([a-z0-9]+)$/i.exec(entry.display.base)?.[1]?.toLowerCase();
	const badge = ext ? EXT_BADGES[ext] : undefined;
	return badge ?? { text: "", glyph: "📄" };
}
