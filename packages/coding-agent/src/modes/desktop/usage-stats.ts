/**
 * owl 使用统计：扫描 <agentDir>/Owl-history 下全部会话 JSONL，聚合 Token 用量与费用。
 *
 * 与 core/usage-totals.ts 的口径一致（assistant 消息 / usage 条目 / 工具摘要与压缩），
 * 但不通过 SessionManager 挂载会话——直接流式读文件，只解析带 usage 的行，因此
 * 大历史也能秒级聚合，且正在进行的会话落盘即计入（设置页 5s 轮询 = 实时监测）。
 *
 * 增量与留存（开始页「使用概览」面板同源）：
 * - 每个会话文件的聚合按 mtime+size 缓存在 <agentDir>/usage-stats.json，未变的文件
 *   只做一次 stat，不再重读重解析；变了的文件整文件重扫并替换其记录。
 * - 缓存是「只进不吐」的累积口径：会话文件删了，已计入的统计不回吐（面板数字稳定，
 *   不随会话清理波动）。记录按完整路径键唯一，路径含时间戳+uuid，不会互相覆盖。
 * - 统计口径从宽：smoke/调试目录的会话、零用量会话都计入；不做任何过滤。
 *
 * 用户消息计数不走 JSON.parse（正文可能极大）：在原始行上取 `"message":{` 之后
 * 片段匹配 role——role 紧跟信封处，正文里出现的同名字面量匹配不到这个位置。
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir, getSessionsDir } from "../../config.ts";
import { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../../utils/atomic-file.ts";
import type {
	UsageGetResult,
	UsageStatsDay,
	UsageStatsModel,
	UsageStatsProject,
	UsageStatsSession,
	UsageStatsTotals,
} from "./protocol.ts";

/** 按天聚合的窗口：趋势图画最近 30 天（无过滤参数时的兼容口径）。 */
const DAY_WINDOW = 30;
/** topSessions 截断数：设置页列表再长就看不清重点了。 */
const TOP_SESSIONS = 12;
/** 单条会话首条用户消息的截断长度（展示用）。 */
const FIRST_MESSAGE_MAX = 120;
/** 「全部」区间 byDay 的天数上限：热力图最多渲染一年量级，超出丢最老的并置 truncated。 */
const ALL_RANGE_CAP = 366;
/** 压缩/摘要类用量在 byModel 里的伪模型键（不计入「常用模型」）。 */
const TOOLS_MODEL_KEY = "Tools/summaries";
/** 条目时间戳完全缺失时（理论上不会发生）的兜底日期键：只入合计，不进按天视图。 */
const UNDATED = "";

// ---------------------------------------------------------------------------
// 持久累积存储（<agentDir>/usage-stats.json）
// ---------------------------------------------------------------------------

/** 单模型单日的用量增量。 */
export interface UsageStoreModelBucket {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 推理 token（output 的子集，部分供应商不上报）。 */
	reasoning: number;
	total: number;
	cost: number;
	requests: number;
}

/** 单个会话文件单天的聚合：消息计数 + 小时直方图 + 模型用量。 */
export interface UsageStoreDay {
	user: number;
	assistant: number;
	/** 本机小时 0-23 的消息数（user+assistant）。 */
	hours: number[];
	models: Record<string, UsageStoreModelBucket>;
}

/** 单个会话文件的累积记录。文件删除后记录保留（统计不回吐）。 */
export interface UsageStoreFile {
	/** 会话头里的会话 id。 */
	sessionId: string;
	mtime: number;
	size: number;
	cwd: string;
	startedAt: string;
	days: Record<string, UsageStoreDay>;
}

export interface UsageStore {
	version: 1;
	files: Record<string, UsageStoreFile>;
}

/** 过滤参数：时间范围 + 项目 cwd（缺省 = 全部，兼容 usage.get 无参调用）。 */
export interface UsageFilter {
	days?: "all" | "30d" | "7d";
	cwd?: string;
}

/** 测试注入点：默认 <agentDir>/Owl-history 与 <agentDir>/usage-stats.json。 */
export interface UsageDirs {
	sessionsDir?: string;
	storePath?: string;
}

function newStore(): UsageStore {
	return { version: 1, files: {} };
}

function usageStatsStorePath(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "usage-stats.json");
}

/** 读存储：损坏文件备份为 *.corrupt 后从空重建（盘上会话还在，重扫即恢复）。 */
function readStore(path: string): UsageStore {
	if (!existsSync(path)) return newStore();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as UsageStore;
		if (raw.version !== 1 || typeof raw.files !== "object" || raw.files === null) throw new Error("bad shape");
		return raw;
	} catch {
		backupCorruptFile(path);
		return newStore();
	}
}

/**
 * 锁内读盘合并后原子写：另一个桥进程已落盘、本进程缓存里没有或更旧的文件记录一并保留
 * （多个桥共用 agentDir 时互不覆盖，守住"只进不吐"）。
 */
function writeStore(path: string, store: UsageStore): void {
	withFileLockSync(path, () => {
		let disk: Partial<UsageStore> | undefined;
		try {
			disk = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Partial<UsageStore>) : undefined;
		} catch {
			disk = undefined;
		}
		if (disk?.version === 1 && typeof disk.files === "object" && disk.files !== null) {
			for (const [key, record] of Object.entries(disk.files)) {
				const mine = store.files[key];
				if (!mine || record.mtime > mine.mtime) store.files[key] = record;
			}
		}
		atomicWriteFileSync(path, `${JSON.stringify(store)}\n`);
	});
}

/** 模块级缓存 + 串行链：设置页 5s 轮询与开始页并发请求共享同一次扫描，不互相踩。 */
const storeCache = new Map<string, UsageStore>();
let chain: Promise<unknown> = Promise.resolve();

/** 本机时区的 YYYY-MM-DD（按天聚合与区间判定都用它）。 */
function localDateKey(iso: string): string {
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) return "";
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function emptyModelBucket(): UsageStoreModelBucket {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0, requests: 0 };
}

function addToModelBucket(target: UsageStoreModelBucket, usage: Record<string, unknown>): void {
	const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
	const cost = usage.cost && typeof usage.cost === "object" ? (usage.cost as { total?: unknown }).total : 0;
	target.input += n("input");
	target.output += n("output");
	target.cacheRead += n("cacheRead");
	target.cacheWrite += n("cacheWrite");
	target.reasoning += n("reasoning");
	target.total += usageTokenTotal(usage);
	target.cost += typeof cost === "number" ? cost : 0;
	target.requests += 1;
}

function usageTokenTotal(usage: Record<string, unknown>): number {
	const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
	return n("input") + n("output") + n("cacheRead") + n("cacheWrite");
}

/**
 * 过滤全零 usage（token 与费用全为 0）。smoke 测试的 mock 模型、部分 provider 的空响应
 * 都会落这种记录；不滤掉就会在「按模型分布」里出现 0 用量的幽灵行，与用户配置的模型列表
 * 对不上。口径与 core/usage-totals.ts 的 getUsageCostBreakdown（cost > 0 || tokens > 0）一致。
 */
function usageHasInfo(usage: Record<string, unknown>): boolean {
	const positive = (key: string) => typeof usage[key] === "number" && (usage[key] as number) > 0;
	if (positive("input") || positive("output") || positive("cacheRead") || positive("cacheWrite")) return true;
	const cost = usage.cost && typeof usage.cost === "object" ? (usage.cost as { total?: unknown }).total : 0;
	return typeof cost === "number" && cost > 0;
}

// ---------------------------------------------------------------------------
// 会话文件扫描 → 单文件累积记录
// ---------------------------------------------------------------------------

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

/**
 * 原始行上识别 user 消息（不 JSON.parse）：role 紧跟 `"message":{` 信封处，
 * 正文里的同名字面量匹配不到这个位置。返回条目时间戳（信封里）或 null。
 */
function rawUserMessage(line: string): string | null {
	const at = line.indexOf('"message":');
	if (at < 0) return null;
	if (!/^"message":\s*\{\s*"role":\s*"user"/.test(line.slice(at, at + 80))) return null;
	const envelope = line.slice(0, at > 400 ? 400 : at);
	const ts = /"timestamp":"([^"]+)"/.exec(envelope);
	return ts ? ts[1] : null;
}

/** 扫描产物：单文件的按天聚合（不含 mtime/size，落库时补）。 */
interface SessionScan {
	sessionId: string;
	cwd: string;
	startedAt: string;
	days: Record<string, UsageStoreDay>;
}

/**
 * 流式扫描一场会话的 JSONL。首行总是解析（session 头），之后的行只有
 * assistant/带 usage/session_info 的行才 JSON.parse；user 消息在原始行上
 * 直接计数（正文可能极大，解析成本不值得）。
 */
async function scanSessionFile(path: string): Promise<SessionScan | null> {
	const stream = createReadStream(path, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const scan: SessionScan = { sessionId: "", cwd: "", startedAt: "", days: {} };
	let sawFirstUser = false;
	let firstMessage: string | undefined;
	let name: string | undefined;
	// 时间戳：条目自带优先，缺了退回上一条的时间（session 头之后必然有值）
	let lastTimestamp = "";

	function dayBucket(iso: string): UsageStoreDay {
		const date = localDateKey(iso) || UNDATED;
		let day = scan.days[date];
		if (!day) {
			day = { user: 0, assistant: 0, hours: new Array<number>(24).fill(0), models: {} };
			scan.days[date] = day;
		}
		return day;
	}

	function countUser(iso: string): void {
		const day = dayBucket(iso);
		day.user++;
		const hour = new Date(iso).getHours();
		if (Number.isFinite(hour)) day.hours[hour] = (day.hours[hour] ?? 0) + 1;
	}

	function countAssistant(iso: string): void {
		const day = dayBucket(iso);
		day.assistant++;
		const hour = new Date(iso).getHours();
		if (Number.isFinite(hour)) day.hours[hour] = (day.hours[hour] ?? 0) + 1;
	}

	try {
		for await (const line of lines) {
			if (!line || line.length < 2) continue;
			const isHead = scan.startedAt === "";
			const wantsUser = !sawFirstUser && line.includes('"role":"user"');
			// session_info（会话命名）也不含 "usage"，单独放行，否则自定义名永远抓不到
			const isInfo = line.includes('"session_info"');
			const isAssistant = line.includes('"role":"assistant"');
			if (!isHead && !wantsUser && !isInfo && !isAssistant && !line.includes('"usage"')) {
				// 不解析的行也可能是 user 消息：原始行上直接计数
				if (line.includes('"message":')) {
					const ts = rawUserMessage(line);
					if (ts) countUser(ts);
				}
				continue;
			}

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
				name = entry.name.trim();
				continue;
			}
			if (wantsUser && entry.type === "message" && entry.message?.role === "user") {
				sawFirstUser = true;
				const ts = entry.timestamp ?? lastTimestamp;
				countUser(ts);
				const text = firstText(entry.message.content).replace(/\s+/g, " ").trim();
				if (text) firstMessage = text.length > FIRST_MESSAGE_MAX ? `${text.slice(0, FIRST_MESSAGE_MAX)}…` : text;
				continue;
			}
			if (typeof entry.timestamp === "string" && entry.timestamp) lastTimestamp = entry.timestamp;

			// 解析路径的 user 消息（罕见：上面原始路径没接住但行里带 usage/session_info 等）
			if (entry.type === "message" && entry.message?.role === "user") {
				countUser(entry.timestamp ?? lastTimestamp);
				continue;
			}
			// assistant 消息：计数（无 usage 的中止轮也计），有 usage 且非全零才入用量
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const ts = entry.timestamp ?? lastTimestamp;
				countAssistant(ts);
				const usage = entry.message.usage;
				if (usage && typeof usage === "object" && usageHasInfo(usage)) {
					const modelKey = `${entry.message.provider ?? "?"}/${entry.message.responseModel ?? entry.message.model ?? "?"}`;
					const models = dayBucket(ts).models;
					if (!models[modelKey]) models[modelKey] = emptyModelBucket();
					addToModelBucket(models[modelKey], usage);
				}
				continue;
			}
			// 压缩/摘要/显式 usage 条目：只入用量（伪模型键），不计消息
			let found: { usage: Record<string, unknown>; modelKey: string } | undefined;
			if (entry.type === "usage") {
				found = entry.usage
					? { usage: entry.usage, modelKey: `${entry.provider ?? "?"}/${entry.model ?? "?"}` }
					: undefined;
			} else if (
				(entry.type === "compaction" || entry.type === "branch_summary") &&
				entry.usage &&
				typeof entry.usage === "object"
			) {
				found = { usage: entry.usage, modelKey: TOOLS_MODEL_KEY };
			}
			if (!found || !usageHasInfo(found.usage)) continue;
			const models = dayBucket(entry.timestamp ?? lastTimestamp).models;
			if (!models[found.modelKey]) models[found.modelKey] = emptyModelBucket();
			addToModelBucket(models[found.modelKey], found.usage);
		}
	} catch {
		// 单个文件读失败（正在被写入/权限）不影响整体统计
		return null;
	} finally {
		lines.close();
		stream.close();
	}

	if (!scan.startedAt) return null;
	void firstMessage;
	void name;
	return scan;
}

// ---------------------------------------------------------------------------
// 枚举 + 增量刷新
// ---------------------------------------------------------------------------

/** Owl-history/<项目子目录>/*.jsonl 的全量枚举（与 SessionManager.listAll 同构）。 */
async function listSessionFiles(sessionsDir: string): Promise<string[]> {
	const files: string[] = [];
	if (!existsSync(sessionsDir)) return files;
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
	return files;
}

/**
 * 增量刷新存储并返回它。mtime+size 都没变的文件直接复用记录；变了的整文件重扫替换；
 * 磁盘上已消失的文件记录原样保留（删除不回吐）。只有确实变了才落盘。
 */
async function refreshStore(dirs?: UsageDirs): Promise<UsageStore> {
	const storePath = dirs?.storePath ?? usageStatsStorePath();
	const sessionsDir = dirs?.sessionsDir ?? getSessionsDir();
	const store = storeCache.get(storePath) ?? readStore(storePath);
	storeCache.set(storePath, store);

	let dirty = false;
	for (const path of await listSessionFiles(sessionsDir)) {
		let info: { mtimeMs: number; size: number };
		try {
			const s = await stat(path);
			info = { mtimeMs: s.mtimeMs, size: s.size };
		} catch {
			continue; // 正好被删/被锁：下一轮再说
		}
		const cached = store.files[path];
		if (cached && cached.mtime === info.mtimeMs && cached.size === info.size) continue;
		const scanned = await scanSessionFile(path);
		if (!scanned) continue; // 读失败：保留旧记录，下轮重试
		store.files[path] = { ...scanned, mtime: info.mtimeMs, size: info.size };
		dirty = true;
	}
	if (dirty) writeStore(storePath, store);
	return store;
}

// ---------------------------------------------------------------------------
// 折叠：store + 过滤 → UsageGetResult
// ---------------------------------------------------------------------------

function totalsFromBucket(bucket: UsageStoreModelBucket): UsageStatsTotals {
	return {
		input: bucket.input,
		output: bucket.output,
		cacheRead: bucket.cacheRead,
		cacheWrite: bucket.cacheWrite,
		reasoning: bucket.reasoning,
		totalTokens: bucket.total,
		cost: bucket.cost,
		requests: bucket.requests,
	};
}

function emptyTotals(): UsageStatsTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, requests: 0 };
}

function addTotals(target: UsageStatsTotals, source: UsageStatsTotals): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.reasoning += source.reasoning;
	target.totalTokens += source.totalTokens;
	target.cost += source.cost;
	target.requests += source.requests;
}

/** 会话全史各模型的合计（topSessions/byProject 折叠用）。 */
function sessionModelTotals(file: UsageStoreFile): Map<string, UsageStoreModelBucket> {
	const merged = new Map<string, UsageStoreModelBucket>();
	for (const day of Object.values(file.days)) {
		for (const [modelKey, bucket] of Object.entries(day.models)) {
			const target = merged.get(modelKey) ?? emptyModelBucket();
			target.input += bucket.input;
			target.output += bucket.output;
			target.cacheRead += bucket.cacheRead;
			target.cacheWrite += bucket.cacheWrite;
			target.total += bucket.total;
			target.cost += bucket.cost;
			target.requests += bucket.requests;
			merged.set(modelKey, target);
		}
	}
	return merged;
}

/** 时间范围 → 本机日期下界（含）；undefined = 不限。 */
function rangeFloor(days: UsageFilter["days"]): string | undefined {
	if (days === "7d") return localDateKey(new Date(Date.now() - 6 * 86_400_000).toISOString());
	if (days === "30d") return localDateKey(new Date(Date.now() - 29 * 86_400_000).toISOString());
	return undefined;
}

/**
 * 聚合全部会话（供 serve.ts 的 usage.get 调用）。
 *
 * 无过滤参数时保持既有口径：totals/byModel 全量、byDay 固定最近 30 天补零占位。
 * 带 days 过滤时 totals/byModel/messages 等按区间折叠（topSessions/byProject 恒为
 * 全时间口径、只受 cwd 过滤影响）；cwd 过滤只折叠该项目，allProjects 恒为全项目
 * 口径（开始页项目下拉框的数据源）。
 */
export async function collectUsageStats(filter?: UsageFilter, dirs?: UsageDirs): Promise<UsageGetResult> {
	// 串行化：设置页轮询与开始页并发请求时共享同一次扫描结果
	const run = chain.catch(() => undefined).then(() => refreshStore(dirs));
	chain = run;
	const store = await run;

	const floor = rangeFloor(filter?.days);
	const cwdFilter = filter?.cwd;
	const totals = emptyTotals();
	const byDay = new Map<string, UsageStatsDay>();
	const byDayModel = new Map<string, Map<string, number>>();
	const byModel = new Map<string, UsageStatsModel>();
	const byProject = new Map<string, UsageStatsProject>();
	const allProjects = new Map<string, UsageStatsProject>();
	const sessions: UsageStatsSession[] = [];
	const activeDays = new Set<string>();
	const hours = new Array<number>(24).fill(0);
	let messages = 0;
	let sessionCount = 0;
	let firstRecordedAt: string | undefined;

	for (const [path, file] of Object.entries(store.files)) {
		const projectKey = file.cwd || "(unknown)";

		// allProjects：全时间全项目口径（开始页项目下拉框），不受过滤影响
		const allBucket = allProjects.get(projectKey) ?? {
			cwd: projectKey,
			totalTokens: 0,
			cost: 0,
			requests: 0,
			sessions: 0,
		};
		for (const day of Object.values(file.days)) {
			for (const bucket of Object.values(day.models)) {
				allBucket.totalTokens += bucket.total;
				allBucket.cost += bucket.cost;
				allBucket.requests += bucket.requests;
			}
		}
		allBucket.sessions += 1;
		allProjects.set(projectKey, allBucket);

		if (cwdFilter && projectKey !== cwdFilter) continue;

		// 会话数：按会话开始时间落区间；topSessions/byProject：全时间口径、随 cwd 过滤
		const startedDate = localDateKey(file.startedAt);
		if (!floor || (startedDate && startedDate >= floor)) sessionCount++;

		const sessionTotals = emptyTotals();
		for (const bucket of sessionModelTotals(file).values()) addTotals(sessionTotals, totalsFromBucket(bucket));
		const projectBucket = byProject.get(projectKey) ?? {
			cwd: projectKey,
			totalTokens: 0,
			cost: 0,
			requests: 0,
			sessions: 0,
		};
		projectBucket.totalTokens += sessionTotals.totalTokens;
		projectBucket.cost += sessionTotals.cost;
		projectBucket.requests += sessionTotals.requests;
		projectBucket.sessions += 1;
		byProject.set(projectKey, projectBucket);

		let lastActiveAt = file.startedAt;
		try {
			lastActiveAt = (await stat(path)).mtime.toISOString();
		} catch {
			// 文件已删：统计保留，mtime 退回会话开始时间
		}
		const firstTs = Date.parse(file.startedAt);
		if (Number.isFinite(firstTs) && (firstRecordedAt === undefined || firstTs < Date.parse(firstRecordedAt))) {
			firstRecordedAt = file.startedAt;
		}
		sessions.push({
			sessionId:
				file.sessionId ||
				path
					.replace(/\\/g, "/")
					.split("/")
					.pop()
					?.replace(/\.jsonl$/, "") ||
				path,
			cwd: file.cwd,
			startedAt: file.startedAt || lastActiveAt,
			lastActiveAt,
			totalTokens: sessionTotals.totalTokens,
			cost: sessionTotals.cost,
			requests: sessionTotals.requests,
		});

		// 区间内的按天折叠（消息/小时/活跃天/热力图/模型趋势/totals/byModel）。
		// UNDATED 桶只入 totals/byModel（时间不明，进不了按天视图）。
		for (const [date, day] of Object.entries(file.days)) {
			if (date !== UNDATED && floor && date < floor) continue;
			const inDayView = date !== UNDATED;
			if (inDayView) {
				activeDays.add(date);
				messages += day.user + day.assistant;
				for (let h = 0; h < 24; h++) hours[h] += day.hours[h] ?? 0;
			}
			let dayBucket: UsageStatsDay | undefined;
			let modelMap: Map<string, number> | undefined;
			if (inDayView) {
				dayBucket = byDay.get(date) ?? { date, totalTokens: 0, cost: 0, requests: 0 };
				modelMap = byDayModel.get(date) ?? new Map();
			}
			for (const [modelKey, bucket] of Object.entries(day.models)) {
				addTotals(totals, totalsFromBucket(bucket));
				const modelRow = byModel.get(modelKey) ?? { key: modelKey, totalTokens: 0, cost: 0, requests: 0 };
				modelRow.totalTokens += bucket.total;
				modelRow.cost += bucket.cost;
				modelRow.requests += bucket.requests;
				modelRow.input = (modelRow.input ?? 0) + bucket.input;
				modelRow.output = (modelRow.output ?? 0) + bucket.output;
				byModel.set(modelKey, modelRow);
				if (dayBucket && modelMap) {
					dayBucket.totalTokens += bucket.total;
					dayBucket.cost += bucket.cost;
					dayBucket.requests += bucket.requests;
					modelMap.set(modelKey, (modelMap.get(modelKey) ?? 0) + bucket.total);
				}
			}
			if (dayBucket) byDay.set(date, dayBucket);
			if (dayBucket && modelMap) byDayModel.set(date, modelMap);
		}
	}

	// byDay 输出：显式 7d/30d 补零占位；无参数 = 兼容旧口径（最近 30 天补零）；all = 全史（封顶）
	const byDayOut: UsageStatsDay[] = [];
	let byDayTruncated = false;
	if (filter?.days === "all") {
		const dates = [...byDay.keys()].filter((date) => date !== UNDATED).sort();
		const today = localDateKey(new Date().toISOString());
		const oldest = dates[0] ?? today;
		const startMs = Date.parse(`${oldest}T00:00:00`);
		let span = 1;
		if (Number.isFinite(startMs)) span = Math.max(1, Math.floor((Date.now() - startMs) / 86_400_000) + 1);
		const from = span > ALL_RANGE_CAP ? span - ALL_RANGE_CAP : 0;
		byDayTruncated = span > ALL_RANGE_CAP;
		for (let offset = span - 1 - from; offset >= 0; offset--) {
			const date = localDateKey(new Date(Date.now() - offset * 86_400_000).toISOString());
			const recorded = byDay.get(date);
			byDayOut.push(recorded ? { ...recorded } : { date, totalTokens: 0, cost: 0, requests: 0 });
		}
	} else {
		const window = filter?.days === "7d" ? 7 : DAY_WINDOW;
		for (let offset = window - 1; offset >= 0; offset--) {
			const date = localDateKey(new Date(Date.now() - offset * 86_400_000).toISOString());
			const recorded = byDay.get(date);
			byDayOut.push(recorded ? { ...recorded } : { date, totalTokens: 0, cost: 0, requests: 0 });
		}
	}
	// byDayModel 与 byDay 同序同窗
	const byDayModelOut = byDayOut.map((day) => {
		const models: Record<string, number> = {};
		const map = byDayModel.get(day.date);
		if (map) for (const [key, value] of map) models[key] = value;
		return { date: day.date, models };
	});

	// 常用模型：排除压缩/摘要伪模型，按区间用量取最大
	let favoriteModel: string | undefined;
	let favTokens = 0;
	for (const model of byModel.values()) {
		if (model.key === TOOLS_MODEL_KEY) continue;
		if (model.totalTokens > favTokens) {
			favTokens = model.totalTokens;
			favoriteModel = model.key;
		}
	}
	let peakHour: number | undefined;
	const topHour = hours.reduce((best, count, hour) => (count > (hours[best] ?? 0) ? hour : best), 0);
	if ((hours[topHour] ?? 0) > 0) peakHour = topHour;

	return {
		totals,
		today: (() => {
			const todayKey = localDateKey(new Date().toISOString());
			const bucket = byDay.get(todayKey);
			return {
				totalTokens: bucket?.totalTokens ?? 0,
				cost: bucket?.cost ?? 0,
				requests: bucket?.requests ?? 0,
			};
		})(),
		byDay: byDayOut,
		byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens),
		byProject: [...byProject.values()].sort((a, b) => b.totalTokens - a.totalTokens),
		topSessions: sessions.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, TOP_SESSIONS),
		sessionCount,
		...(firstRecordedAt ? { firstRecordedAt } : {}),
		generatedAt: new Date().toISOString(),
		// 开始页「使用概览」面板的增量字段
		messages,
		activeDays: activeDays.size,
		...(peakHour !== undefined ? { peakHour } : {}),
		...(favoriteModel ? { favoriteModel } : {}),
		allProjects: [...allProjects.values()].sort((a, b) => b.totalTokens - a.totalTokens),
		byDayModel: byDayModelOut,
		...(byDayTruncated ? { byDayTruncated } : {}),
	};
}
