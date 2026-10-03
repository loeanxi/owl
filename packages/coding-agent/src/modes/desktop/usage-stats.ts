/**
 * owl 使用统计：扫描 <agentDir>/Owl-history 下全部会话 JSONL，聚合 Token 用量与费用。
 *
 * 与 core/usage-totals.ts 的口径一致（assistant 消息 / usage 条目 / 工具摘要与压缩），
 * 但不通过 SessionManager 挂载会话——直接流式读文件，只解析带 usage 的行，因此
 * 大历史也能秒级聚合，且正在进行的会话落盘即计入（设置页 5s 轮询 = 实时监测）。
 */
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getSessionsDir } from "../../config.ts";
import type {
	UsageGetResult,
	UsageStatsDay,
	UsageStatsModel,
	UsageStatsProject,
	UsageStatsSession,
	UsageStatsTotals,
} from "./protocol.ts";

/** 按天聚合的窗口：趋势图画最近 30 天。 */
const DAY_WINDOW = 30;
/** topSessions 截断数：设置页列表再长就看不清重点了。 */
const TOP_SESSIONS = 12;
/** 单条会话首条用户消息的截断长度（展示用）。 */
const FIRST_MESSAGE_MAX = 120;

/** 本机时区的 YYYY-MM-DD（按天聚合与「今日」判定都用它）。 */
function localDateKey(iso: string): string {
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) return "";
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function emptyTotals(): UsageStatsTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, requests: 0 };
}

function addUsage(target: UsageStatsTotals, usage: Record<string, unknown>): void {
	const input = typeof usage.input === "number" ? usage.input : 0;
	const output = typeof usage.output === "number" ? usage.output : 0;
	const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
	const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
	const cost = usage.cost && typeof usage.cost === "object" ? (usage.cost as { total?: unknown }).total : 0;
	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.reasoning += typeof usage.reasoning === "number" ? usage.reasoning : 0;
	target.totalTokens += input + output + cacheRead + cacheWrite;
	target.cost += typeof cost === "number" ? cost : 0;
	target.requests += 1;
}

interface SessionScan {
	sessionId: string;
	cwd: string;
	name?: string;
	firstMessage?: string;
	startedAt: string;
	totals: UsageStatsTotals;
	/** model key → 该模型在这场会话里的用量增量（再并入全局 byModel）。 */
	models: Map<string, UsageStatsTotals>;
	/** 本机日期 → 当日用量增量（跨天长会话也能按天归账）。 */
	days: Map<string, UsageStatsDay>;
}

/** 会话 JSONL 的条目形状（只声明本文件关心的字段，其余忽略）。 */
interface ScanEntry {
	type?: string;
	id?: string;
	timestamp?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	usage?: Record<string, unknown>;
	name?: string;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		responseModel?: string;
		usage?: Record<string, unknown>;
		content?: unknown;
	};
}

/** 从消息 content 里提取首段文本（firstMessage 展示用；结构与 AgentMessage 对齐）。 */
function firstText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
				return (block as { text: string }).text;
			}
		}
	}
	return "";
}

/** 记一条 usage 到会话的总量、模型分布与按天分布。 */
function recordUsage(scan: SessionScan, modelKey: string, usage: Record<string, unknown>, timestamp: string): void {
	addUsage(scan.totals, usage);

	let bucket = scan.models.get(modelKey);
	if (!bucket) {
		bucket = emptyTotals();
		scan.models.set(modelKey, bucket);
	}
	addUsage(bucket, usage);

	const date = localDateKey(timestamp);
	if (date) {
		let day = scan.days.get(date);
		if (!day) {
			day = { date, totalTokens: 0, cost: 0, requests: 0 };
			scan.days.set(date, day);
		}
		day.totalTokens += usageTokenTotal(usage);
		day.cost +=
			typeof usage.cost === "object" && usage.cost !== null
				? Number((usage.cost as { total?: unknown }).total ?? 0) || 0
				: 0;
		day.requests += 1;
	}
}

function usageTokenTotal(usage: Record<string, unknown>): number {
	const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
	return n("input") + n("output") + n("cacheRead") + n("cacheWrite");
}

/**
 * 流式扫描一场会话的 JSONL。首行总是解析（session 头 + 首条用户消息都可能在那里），
 * 之后的行只有包含 "usage" 或还没抓到首条用户消息才 JSON.parse——把大文件的解析成本压到最低。
 */
async function scanSessionFile(path: string): Promise<SessionScan | null> {
	const stream = createReadStream(path, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const scan: SessionScan = {
		sessionId: "",
		cwd: "",
		startedAt: "",
		totals: emptyTotals(),
		models: new Map(),
		days: new Map(),
	};
	let sawFirstUser = false;
	// 时间戳：条目自带优先，缺了退回上一条的时间（session 头之后必然有值）
	let lastTimestamp = "";

	try {
		for await (const line of lines) {
			if (!line || line.length < 2) continue;
			const isHead = scan.sessionId === "";
			const isUserMiss = !sawFirstUser && line.includes('"role":"user"');
			// session_info（会话命名）也不含 "usage"，单独放行，否则自定义名永远抓不到
			const isInfo = line.includes('"session_info"');
			if (!isHead && !isUserMiss && !isInfo && !line.includes('"usage"')) continue;

			let entry: ScanEntry;
			try {
				entry = JSON.parse(line) as ScanEntry;
			} catch {
				continue;
			}

			if (isHead && entry.type === "session") {
				scan.sessionId = typeof entry.id === "string" ? entry.id : "";
				scan.cwd = typeof entry.cwd === "string" ? entry.cwd : "";
				scan.startedAt = typeof entry.timestamp === "string" ? entry.timestamp : "";
				lastTimestamp = scan.startedAt;
				continue;
			}
			if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
				scan.name = entry.name.trim();
				continue;
			}
			if (isUserMiss && entry.type === "message" && entry.message?.role === "user") {
				sawFirstUser = true;
				const text = firstText(entry.message.content).replace(/\s+/g, " ").trim();
				if (text)
					scan.firstMessage = text.length > FIRST_MESSAGE_MAX ? `${text.slice(0, FIRST_MESSAGE_MAX)}…` : text;
				continue;
			}
			if (typeof entry.timestamp === "string" && entry.timestamp) lastTimestamp = entry.timestamp;

			let found: { usage: Record<string, unknown>; modelKey: string } | undefined;
			if (entry.type === "usage") {
				found = entry.usage
					? { usage: entry.usage, modelKey: `${entry.provider ?? "?"}/${entry.model ?? "?"}` }
					: undefined;
			} else if (entry.type === "message" && entry.message?.usage && typeof entry.message.usage === "object") {
				found = {
					usage: entry.message.usage,
					modelKey:
						entry.message.role === "assistant"
							? `${entry.message.provider ?? "?"}/${entry.message.responseModel ?? entry.message.model ?? "?"}`
							: "Tools/summaries",
				};
			} else if (
				(entry.type === "compaction" || entry.type === "branch_summary") &&
				entry.usage &&
				typeof entry.usage === "object"
			) {
				found = { usage: entry.usage, modelKey: "Tools/summaries" };
			}
			if (!found) continue;

			recordUsage(scan, found.modelKey, found.usage, entry.timestamp ?? lastTimestamp);
		}
	} catch {
		// 单个文件读失败（正在被写入/权限）不影响整体统计
	} finally {
		lines.close();
		stream.close();
	}

	return scan.sessionId ? scan : null;
}

/** 聚合全部会话（供 serve.ts 的 usage.get 调用）。 */
export async function collectUsageStats(): Promise<UsageGetResult> {
	const sessionsDir = getSessionsDir();
	const totals = emptyTotals();
	const byDay = new Map<string, UsageStatsDay>();
	const byModel = new Map<string, UsageStatsModel>();
	const byProject = new Map<string, UsageStatsProject>();
	const sessions: UsageStatsSession[] = [];
	let firstRecordedAt: string | undefined;

	// 与 SessionManager.listAll 同样的枚举：Owl-history/<项目子目录>/*.jsonl
	const files: string[] = [];
	if (existsSync(sessionsDir)) {
		try {
			for (const dir of await readdir(sessionsDir, { withFileTypes: true })) {
				if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
				const sub = join(sessionsDir, dir.name);
				try {
					for (const file of await readdir(sub)) {
						if (file.endsWith(".jsonl")) files.push(join(sub, file));
					}
				} catch {
					// 子目录读不了就跳过
				}
			}
		} catch {
			// 目录枚举失败按空统计处理
		}
	}

	for (const path of files) {
		const scan = await scanSessionFile(path);
		if (!scan || scan.totals.requests === 0) continue;

		let lastActiveAt = scan.startedAt;
		try {
			lastActiveAt = (await stat(path)).mtime.toISOString();
		} catch {
			// stat 失败就用会话开始时间
		}

		let projectBucket = byProject.get(scan.cwd || "(unknown)");
		if (!projectBucket) {
			projectBucket = { cwd: scan.cwd || "(unknown)", totalTokens: 0, cost: 0, requests: 0, sessions: 0 };
			byProject.set(projectBucket.cwd, projectBucket);
		}
		projectBucket.totalTokens += scan.totals.totalTokens;
		projectBucket.cost += scan.totals.cost;
		projectBucket.requests += scan.totals.requests;
		projectBucket.sessions += 1;

		for (const [modelKey, modelTotals] of scan.models) {
			let bucket = byModel.get(modelKey);
			if (!bucket) {
				bucket = { key: modelKey, totalTokens: 0, cost: 0, requests: 0 };
				byModel.set(modelKey, bucket);
			}
			bucket.totalTokens += modelTotals.totalTokens;
			bucket.cost += modelTotals.cost;
			bucket.requests += modelTotals.requests;
		}

		for (const day of scan.days.values()) {
			const bucket = byDay.get(day.date) ?? { date: day.date, totalTokens: 0, cost: 0, requests: 0 };
			bucket.totalTokens += day.totalTokens;
			bucket.cost += day.cost;
			bucket.requests += day.requests;
			byDay.set(day.date, bucket);
		}

		totals.input += scan.totals.input;
		totals.output += scan.totals.output;
		totals.cacheRead += scan.totals.cacheRead;
		totals.cacheWrite += scan.totals.cacheWrite;
		totals.reasoning += scan.totals.reasoning;
		totals.totalTokens += scan.totals.totalTokens;
		totals.cost += scan.totals.cost;
		totals.requests += scan.totals.requests;

		const firstTs = Date.parse(scan.startedAt);
		if (Number.isFinite(firstTs) && (firstRecordedAt === undefined || firstTs < Date.parse(firstRecordedAt))) {
			firstRecordedAt = scan.startedAt;
		}

		sessions.push({
			sessionId: scan.sessionId,
			cwd: scan.cwd,
			...(scan.name ? { name: scan.name } : {}),
			...(scan.firstMessage ? { firstMessage: scan.firstMessage } : {}),
			startedAt: scan.startedAt || lastActiveAt,
			lastActiveAt,
			totalTokens: scan.totals.totalTokens,
			cost: scan.totals.cost,
			requests: scan.totals.requests,
		});
	}

	// 最近 30 天升序补零占位（没记录的日子也画一根 0 高度的柱）
	const byDayOut: UsageStatsDay[] = [];
	for (let offset = DAY_WINDOW - 1; offset >= 0; offset--) {
		const date = localDateKey(new Date(Date.now() - offset * 86_400_000).toISOString());
		const recorded = byDay.get(date);
		byDayOut.push(recorded ? { ...recorded } : { date, totalTokens: 0, cost: 0, requests: 0 });
	}
	const todayKey = byDayOut[byDayOut.length - 1].date;
	const todayBucket = byDay.get(todayKey);

	return {
		totals,
		today: {
			totalTokens: todayBucket?.totalTokens ?? 0,
			cost: todayBucket?.cost ?? 0,
			requests: todayBucket?.requests ?? 0,
		},
		byDay: byDayOut,
		byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens),
		byProject: [...byProject.values()].sort((a, b) => b.totalTokens - a.totalTokens),
		topSessions: sessions.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, TOP_SESSIONS),
		sessionCount: sessions.length,
		...(firstRecordedAt ? { firstRecordedAt } : {}),
		generatedAt: new Date().toISOString(),
	};
}
