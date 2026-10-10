/**
 * 「我的 Token 生涯」跨 Agent 用量聚合（桥命令 career.get）。
 *
 * 一份看板汇总本机所有 coding agent 的 token 用量。两类数据源：
 *
 * 一、可精确解析（真实计入用量）：
 * - owl：独立 agent（~/.owl/agent），复用 usage-stats.ts 的全量聚合，费用实测；
 * - ZCode：z.ai CLI（~/.zcode/cli/db/db.sqlite），turn_usage 每轮一行 + model_usage
 *   按模型聚合；input 已含缓存读，展示时扣除重叠（与 Codex/Qoder 同口径）；
 * - pi：独立 agent（~/.pi/agent/sessions），与 owl 同构的会话 JSONL，独立一行不并计；
 * - Claude（Claude Code CLI + 桌面端）：~/.claude/projects 递归全部 .jsonl。每条 assistant 消息一行、各自带
 *   一次 API 调用的 usage（不是累计值），逐行累加；cache_creation → cacheWrite。
 *   已验证：主会话文件不含 sidechain 用量行（isSidechain:true 全库为 0），subagents/
 *   边车文件与主文件互不重复，两者都扫不会双算。成本取 Claude Code 自带估算
 *   ~/.claude/metrics/costs.jsonl（每会话末条快照为该会话累计，按会话取末条求和）。
 * - Codex CLI：~/.codex/sessions 与 ~/.codex/archived_sessions 递归全部 .jsonl。
 *   token_count.info.total_token_usage 是会话内累计值（只增），只能取每文件最后一条；
 *   模型取最后一条 turn_context；整场会话的用量归属到最后一次 token_count 的本机日期。
 * - Kimi CLI：~/.kimi-code/sessions 递归 wire.jsonl。usage.record 按 turn 逐条累加
 *   （inputOther=非缓存输入，inputCacheRead/Creation=缓存读/写），模型在 record 上。
 * - OpenCode / Kilo Code：各自 SQLite 会话库（node:sqlite 只读；两家同构）。
 *   session 表自带 tokens_input/output/reasoning/cache_read/cache_write/cost 权威汇总列，
 *   按天与按模型从 message 表的 assistant 行 JSON（tokens/cost/modelID）聚合。
 * - Qoder：%APPDATA%/Qoder 的 local.db。chat_message 每条 assistant 行的 token_info
 *   （prompt/completion/cached_tokens，非累计），模型取 model_info.model_key；
 *   cached>0 时从 prompt 扣除重叠部分，保证四桶之和 = prompt + completion。
 * - GitHub Copilot CLI：~/.copilot/session-store.db 的 assistant_usage_events，
 *   每行一次请求的 input/output/cache/reasoning，时间在 created_at（ms）。
 * - Roo Code：VSCode/Cursor 扩展宿主 globalStorage 的 tasks/<uuid>/history_item.json
 *   （官方任务汇总，直接带 tokensIn/Out/cacheWrites/cacheReads）。
 * - Cline：同宿主 tasks/<ts>/ui_messages.json 里 api_req_started 的用量 JSON；
 *   模型取消息流上最近的 modelInfo。
 * - WorkBuddy：~/.workbuddy/projects（Claude Code 同构布局）。用量挂在 function_call
 *   行的 providerData.usage（camelCase，inputTokens 含缓存），模型在 providerData.model。
 * - Kimi 桌面端：%APPDATA%/kimi-desktop 的 runtime wire.jsonl（与 CLI 同构），并入 Kimi 行；
 * - DeepSeek Harness：~/.dsh/sessions 的 session.v4.jsonl.zstd（多帧 zstd）。用量在
 *   assistant/message 行的 data.usage（inputTokens 含缓存读 cacheReadTokens）。
 * - Mavis：~/.mavis/v2/sessions/…/messages.jsonl（递归 glob；MiniMax Code），message.usage 与
 *   owl 同口径分列（四桶直加），含实测费用；模型在 message.model。
 * - Reasonix：%APPDATA%/reasonix/projects 的 *.telemetry.json（每会话官方汇总：
 *   promptTokens=cacheHit+cacheMiss+completion，含 sessionCostUsd 实测费用）。
 * - MimoCode：~/.local/share/mimocode/mimocode.db（OpenCode 同构，老 schema 无官方
 *   聚合列），从 message 表 assistant 行的 tokens JSON 折叠。
 *
 * 二、只报状态（本地无用量明文或暂无法准确解析，绝不估算充数）：
 * - Gemini CLI：会话与日志记录均不含 token 用量字段（logs.json 已核验）；
 * - Cursor：官方用量只在服务端（IDE/CLI 各库已逐个核验无记录）。按 acp-sessions
 *   会话历史内容估算（每轮上下文重放），行内注明估算口径；
 * - Antigravity：会话在 ~/.gemini/antigravity/conversations/*.db（SQLite），但内容是
 *   私有 protobuf 字节流，无明文用量；
 * - Trae：会话库（ModularData/ai-agent/database.db）为加密私有格式，无法解析；
 * - CodeBuddy / MiniMax Agent / Grok / Junie / 通义灵码：检测到数据目录，但本地明文无
 *   token 用量（各自注明的具体原因）。
 *
 * 缓存与 usage-stats.ts 同构：<agentDir>/career-stats.json 按路径键存每个 JSONL 文件的
 * mtime+size 记录，未变的文件只做一次 stat；变了的整文件重扫替换；文件删除记录保留
 * （删除不回吐，看板数字不随会话清理波动）。损坏整库备份 *.corrupt 后重建。
 * OpenCode 的 SQLite 每次直接查询（行数量级小，且官方汇总列本身就是缓存口径）。
 */

import { createReadStream, type Dirent, existsSync, readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import type { BridgePluginContext, UsageDirs } from "@owl/owl-coding-agent";
import type { CareerAgentUsage, CareerBucket, CareerGetResult, CareerSourceStatus } from "./types.ts";

/** 宿主提供的能力：agentDir、owl 自身用量聚合与落盘约定。 */
export type CareerHost = Pick<BridgePluginContext, "agentDir" | "collectUsageStats" | "files">;
type CareerFiles = CareerHost["files"];

/** 测试注入点：默认 ~/.claude、~/.codex、~/.kimi-code、~/.local/share/opencode 与 <agentDir>/career-stats.json。 */
export interface CareerDirs {
	agentDir?: string;
	claudeDir?: string;
	codexDir?: string;
	kimiDir?: string;
	opencodeDir?: string;
	/** OpenCode 会话库（默认 <opencodeDir>/opencode.db）。 */
	opencodeDb?: string;
	geminiDir?: string;
	/** Qoder 会话库（默认 %APPDATA%/Qoder/SharedClientCache/cache/db/local.db）。 */
	qoderDb?: string;
	/** Kilo Code 会话库（默认 ~/.local/share/kilo/kilo.db，OpenCode 同构）。 */
	kiloDb?: string;
	/** GitHub Copilot 会话库（默认 ~/.copilot/session-store.db）。 */
	copilotDb?: string;
	/** Roo Code / Cline 扩展宿主的 globalStorage 根（默认 %APPDATA% 的 Code 与 Cursor）。 */
	extensionHosts?: string[];
	/** 检测表的根（默认 home）；AppData 行按 <root>/AppData/Roaming 解析。 */
	detectRoot?: string;
	/** Claude Code 自带成本快照文件（默认 <claudeDir>/metrics/costs.jsonl）。 */
	claudeCostsFile?: string;
	/** owl 自身统计（usage-stats.ts）的注入点，测试用；缺省扫真实 Owl-history。 */
	owl?: UsageDirs;
	/** owl 前身（pi-mono）会话目录的注入点；缺省扫 ~/.pi/agent/sessions（存在时），与 owl 合并为一行。 */
	owlLegacy?: UsageDirs;
	/** owl 前身（pi-mono）会话目录的注入点；缺省扫 ~/.pi/agent/sessions（存在时），与 owl 合并为一行。 */
	piSessions?: UsageDirs;
	/** ZCode CLI 会话库（默认 ~/.zcode/cli/db/db.sqlite）。 */
	zcodeDb?: string;
	/** WorkBuddy 会话目录（默认 ~/.workbuddy/projects）。 */
	workbuddyDir?: string;
	/** Mavis（MiniMax Code）会话目录（默认 ~/.mavis/v2/sessions）。 */
	mavisDir?: string;
	/** Reasonix 项目目录（默认 %APPDATA%/reasonix/projects）。 */
	reasonixDir?: string;
	/** Kimi 桌面端会话目录（默认 %APPDATA%/kimi-desktop/.../home/sessions）。 */
	kimiDesktopDir?: string;
	/** DeepSeek Harness 会话目录（默认 ~/.dsh/sessions）。 */
	dshDir?: string;
	/** MimoCode 会话库（默认 ~/.local/share/mimocode/mimocode.db）。 */
	mimoDb?: string;
	/** Cursor ACP 会话目录（默认 ~/.cursor/acp-sessions）。 */
	cursorSessionsDir?: string;
}

// ---------------------------------------------------------------------------
// 持久累积存储（<agentDir>/career-stats.json，JSONL 类数据源共用）
// ---------------------------------------------------------------------------

/** 单个会话文件的累积记录。文件删除后记录保留（统计不回吐）。 */
interface CareerFileRecord {
	mtime: number;
	size: number;
	sessionId: string;
	cwd: string;
	/** 文件内最后一次带时间戳事件的 ISO 时间。 */
	lastAt: string;
	/** 按天用量（key = 本机时区 YYYY-MM-DD）。 */
	days: Record<string, CareerBucket>;
	/** 按模型用量（key = 各 agent 原始模型名）。 */
	models: Record<string, CareerBucket>;
	/** 实测费用（来源自带上报时才有；USD 或来源币种原值）。 */
	cost: number;
}

/** SQLite 聚合源（OpenCode/Kilo/Qoder/Copilot/MimoCode/ZCode）的最后一次成功快照。
 *  这类源没有本地文件级增量可言（库即事实），删除应用后库随之消失——快照让历史
 *  数字在看板上永存（"只增量、永不删除"的产品承诺对它们同样成立）。 */
interface CareerAggregateCache {
	/** 快照生成时间（ISO）。 */
	capturedAt: string;
	sessions: number;
	firstMs?: number;
	lastMs?: number;
	cost: number;
	totals: CareerBucket;
	byDay: Record<string, CareerBucket>;
	byModel: Record<string, CareerBucket>;
}

interface CareerStore {
	version: 10;
	mavis: Record<string, CareerFileRecord>;
	reasonix: Record<string, CareerFileRecord>;
	claude: Record<string, CareerFileRecord>;
	codex: Record<string, CareerFileRecord>;
	kimi: Record<string, CareerFileRecord>;
	roo: Record<string, CareerFileRecord>;
	cline: Record<string, CareerFileRecord>;
	workbuddy: Record<string, CareerFileRecord>;
	dsh: Record<string, CareerFileRecord>;
	/** Cursor 会话历史估算（acp-sessions store.db），按天粒度。 */
	cursor: Record<string, CareerFileRecord>;
	/** SQLite 聚合源的最后一次成功快照（源被卸载/不可读时回退展示）。 */
	aggregates: Partial<Record<"opencode" | "kilo" | "qoder" | "copilot" | "mimo" | "zcode", CareerAggregateCache>>;
}

function newStore(): CareerStore {
	return {
		version: 10,
		claude: {},
		codex: {},
		kimi: {},
		roo: {},
		cline: {},
		workbuddy: {},
		dsh: {},
		cursor: {},
		mavis: {},
		reasonix: {},
		aggregates: {},
	};
}

function careerStorePath(agentDir: string): string {
	return join(agentDir, "career-stats.json");
}

function readStore(path: string, files: CareerFiles): CareerStore {
	if (!existsSync(path)) return newStore();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as CareerStore;
		if (
			raw.version !== 10 ||
			typeof raw.claude !== "object" ||
			raw.claude === null ||
			typeof raw.codex !== "object" ||
			raw.codex === null ||
			typeof raw.kimi !== "object" ||
			raw.kimi === null ||
			typeof raw.roo !== "object" ||
			raw.roo === null ||
			typeof raw.cline !== "object" ||
			raw.cline === null ||
			typeof raw.workbuddy !== "object" ||
			raw.workbuddy === null ||
			typeof raw.dsh !== "object" ||
			raw.dsh === null ||
			typeof raw.cursor !== "object" ||
			raw.cursor === null ||
			typeof raw.mavis !== "object" ||
			raw.mavis === null ||
			typeof raw.reasonix !== "object" ||
			raw.reasonix === null
		) {
			throw new Error("bad shape");
		}
		// aggregates 段允许缺省（旧版本库升级），存在则必须整体是对象
		if (raw.aggregates !== undefined && (typeof raw.aggregates !== "object" || raw.aggregates === null)) {
			throw new Error("bad shape");
		}
		raw.aggregates ??= {};
		return raw;
	} catch {
		// 损坏库备份为 *.corrupt 后重建；但"永不删除"承诺要求历史尽量找回——
		// 从 *.corrupt（含更早代）里把能解析的记录回填进新库（旧版本形状也接受，
		// 缺 aggregates 补空；路径键唯一，与后续重扫天然合并）。
		const fresh = newStore();
		files.backupCorruptFile(path);
		const generations = [`${path}.corrupt`, ...Array.from({ length: 20 }, (_, gen) => `${path}.corrupt.${gen}`)]
			.filter((candidate) => existsSync(candidate))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		for (const corruptPath of generations) {
			try {
				const old = JSON.parse(readFileSync(corruptPath, "utf-8")) as Partial<CareerStore>;
				const tabled = fresh as unknown as Record<string, Record<string, CareerFileRecord>>;
				for (const table of CAREER_TABLES) {
					const records = (old as Record<string, Record<string, CareerFileRecord>>)[table];
					if (typeof records !== "object" || records === null) continue;
					for (const [key, value] of Object.entries(records)) {
						if (!value || typeof value !== "object" || typeof (value as CareerFileRecord).days !== "object")
							continue;
						// 新库已有的路径以新库为准（可能已重扫、更新鲜）
						if (!tabled[table]?.[key]) {
							const row = tabled[table] ?? {};
							tabled[table] = row;
							row[key] = value;
						}
					}
				}
				if (old.aggregates && typeof old.aggregates === "object") {
					for (const [key, value] of Object.entries(old.aggregates)) {
						if (!value || typeof value !== "object") continue;
						const k = key as keyof CareerStore["aggregates"];
						if (!fresh.aggregates[k]) fresh.aggregates[k] = value as CareerAggregateCache;
					}
				}
				break; // 恢复了最近一代就够（更早代是更老的快照）
			} catch {}
		}
		return fresh;
	}
}

const CAREER_TABLES = [
	"claude",
	"codex",
	"kimi",
	"roo",
	"cline",
	"workbuddy",
	"dsh",
	"cursor",
	"mavis",
	"reasonix",
] as const;

/**
 * 锁内读盘合并后原子写：另一个桥进程已落盘、本进程缓存里没有或更旧的文件记录一并保留
 * （多个桥共用 agentDir 时互不覆盖，守住"永不删除"）。
 */
function writeStore(path: string, store: CareerStore, files: CareerFiles): void {
	files.withFileLockSync(path, () => {
		let disk: Partial<CareerStore> | undefined;
		try {
			disk = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Partial<CareerStore>) : undefined;
		} catch {
			disk = undefined;
		}
		if (disk?.version === store.version) {
			for (const table of CAREER_TABLES) {
				const records = disk[table];
				if (typeof records !== "object" || records === null) continue;
				for (const [key, record] of Object.entries(records)) {
					const mine = store[table][key];
					if (!mine || record.mtime > mine.mtime) store[table][key] = record;
				}
			}
		}
		files.atomicWriteFileSync(path, `${JSON.stringify(store)}\n`);
	});
}

/** 模块级缓存 + 串行链：看板短轮询与并发打开共享同一次扫描。 */
const storeCache = new Map<string, CareerStore>();
let chain: Promise<unknown> = Promise.resolve();

/** 本机时区的 YYYY-MM-DD（按天聚合都用它；与 usage-stats.ts 同口径）。 */
function localDateKey(iso: string): string {
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) return "";
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function emptyBucket(): CareerBucket {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
}

function addBucket(target: CareerBucket, source: CareerBucket): CareerBucket {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.reasoning += source.reasoning;
	target.totalTokens += source.totalTokens;
	return target;
}

// ---------------------------------------------------------------------------
// 通用 JSONL 扫描基建
// ---------------------------------------------------------------------------

/** 递归枚举目录下目标文件（默认 *.jsonl；Roo/Cline 要抓 .json 的任务文件）。 */
async function listJsonlFiles(
	root: string,
	wanted: (fileName: string) => boolean = (name) => name.endsWith(".jsonl"),
): Promise<string[]> {
	const files: string[] = [];
	if (!existsSync(root)) return files;
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // 目录读不了就跳过
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && wanted(entry.name)) files.push(path);
		}
	};
	await walk(root);
	return files;
}

/** 新建一条空的单文件记录。 */
function emptyRecord(): Omit<CareerFileRecord, "mtime" | "size"> {
	return { sessionId: "", cwd: "", lastAt: "", days: {}, models: {}, cost: 0 };
}

/** 向单文件记录的按天/按模型桶累加一次用量。 */
function recordUsage(
	record: Omit<CareerFileRecord, "mtime" | "size">,
	iso: string,
	model: string,
	bucket: CareerBucket,
): void {
	if (bucket.totalTokens <= 0) return;
	if (iso) record.lastAt = iso;
	const date = localDateKey(iso);
	if (date) {
		const day = record.days[date] ?? emptyBucket();
		addBucket(day, bucket);
		record.days[date] = day;
	}
	if (model) {
		const modelBucket = record.models[model] ?? emptyBucket();
		addBucket(modelBucket, bucket);
		record.models[model] = modelBucket;
	}
}

/** mtime+size 都没变的文件直接复用记录；变了的整文件重扫替换；删除的记录保留。 */
async function refreshSource(
	files: Record<string, CareerFileRecord>,
	roots: string[],
	wanted: (fileName: string) => boolean,
	scan: (path: string) => Promise<Omit<CareerFileRecord, "mtime" | "size"> | null>,
): Promise<boolean> {
	let dirty = false;
	for (const root of roots) {
		for (const path of await listJsonlFiles(root, wanted)) {
			let info: { mtimeMs: number; size: number };
			try {
				const s = await stat(path);
				info = { mtimeMs: s.mtimeMs, size: s.size };
			} catch {
				continue; // 正好被删/被锁：下一轮再说
			}
			const cached = files[path];
			if (cached && cached.mtime === info.mtimeMs && cached.size === info.size) continue;
			const scanned = await scan(path);
			if (!scanned) continue;
			files[path] = { ...scanned, mtime: info.mtimeMs, size: info.size };
			dirty = true;
		}
	}
	return dirty;
}

// ---------------------------------------------------------------------------
// Claude Code 扫描（~/.claude/projects 递归 .jsonl + metrics/costs.jsonl）
// ---------------------------------------------------------------------------

interface ClaudeEntry {
	timestamp?: string;
	cwd?: string;
	sessionId?: string;
	message?: {
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
			output_tokens_details?: { reasoning_tokens?: number };
		};
	};
}

/**
 * 流式扫描一场 Claude Code 会话：只有带 "usage" 的行才 JSON.parse（其余行可能是
 * 几 MB 的快照）。每条 assistant 行是一次独立 API 调用的用量，逐行累加而非取尾。
 */
async function scanClaudeFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const stream = createReadStream(path, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const record = emptyRecord();
	try {
		for await (const line of lines) {
			if (!line.includes('"usage"')) continue;
			let entry: ClaudeEntry;
			try {
				entry = JSON.parse(line) as ClaudeEntry;
			} catch {
				continue;
			}
			if (!record.sessionId && typeof entry.sessionId === "string") record.sessionId = entry.sessionId;
			if (!record.cwd && typeof entry.cwd === "string") record.cwd = entry.cwd;
			const usage = entry.message?.usage;
			if (!usage || typeof usage !== "object") continue;
			const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
			recordUsage(record, ts, typeof entry.message?.model === "string" ? entry.message.model : "", {
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0,
				cacheRead: usage.cache_read_input_tokens ?? 0,
				cacheWrite: usage.cache_creation_input_tokens ?? 0,
				reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
				totalTokens:
					(usage.input_tokens ?? 0) +
					(usage.output_tokens ?? 0) +
					(usage.cache_read_input_tokens ?? 0) +
					(usage.cache_creation_input_tokens ?? 0),
			});
		}
	} catch {
		return null; // 单文件读失败不影响整体，下轮重试
	} finally {
		lines.close();
		stream.close();
	}
	return Object.keys(record.days).length > 0 || record.sessionId ? record : null;
}

/**
 * Claude Code 自带的成本估算快照（~/.claude/metrics/costs.jsonl）：一行是某会话到此为止
 * 的累计（同会话多行递增），按会话取末条求和，得到该文件覆盖范围内的实测成本。
 * 未覆盖的会话（老版本或未启用 metrics）不计入——宁少不猜。
 */
function claudeMeasuredCost(costsFile: string): { cost: number; sessions: number } | null {
	if (!existsSync(costsFile)) return null;
	try {
		const lines = readFileSync(costsFile, "utf-8")
			.split(/\r?\n/)
			.filter((line) => line.trim().startsWith("{"));
		const lastPerSession = new Map<string, { estimated_cost_usd?: number }>();
		for (const line of lines) {
			try {
				const row = JSON.parse(line) as { session_id?: string; estimated_cost_usd?: number };
				if (typeof row.session_id === "string") lastPerSession.set(row.session_id, row);
			} catch {}
		}
		let cost = 0;
		for (const row of lastPerSession.values())
			cost += typeof row.estimated_cost_usd === "number" ? row.estimated_cost_usd : 0;
		return { cost, sessions: lastPerSession.size };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Codex CLI 扫描（~/.codex/sessions 与 ~/.codex/archived_sessions）
// ---------------------------------------------------------------------------

/** token_count.info.total_token_usage 的形状（会话内累计、只增）。 */
interface CodexTokenUsage {
	input_tokens?: number;
	cached_input_tokens?: number;
	cache_write_input_tokens?: number;
	output_tokens?: number;
	reasoning_output_tokens?: number;
	total_tokens?: number;
}

interface CodexEnvelope {
	timestamp?: string;
	type?: string;
	payload?: {
		session_id?: string;
		cwd?: string;
		timestamp?: string;
		model?: string;
		info?: { total_token_usage?: CodexTokenUsage; last_token_usage?: CodexTokenUsage };
	};
}

/**
 * 流式扫描一场 Codex 会话：只解析 session_meta / turn_context / token_count 三种行。
 * total_token_usage 会话内累计（只增），逐条覆盖取最终值；模型取最后一条 turn_context。
 */
async function scanCodexFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const stream = createReadStream(path, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const record = emptyRecord();
	let model = "";
	let firstAt = "";
	let sawUsage = false;
	let prevTotal = 0;
	try {
		for await (const line of lines) {
			if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"'))
				continue;
			let entry: CodexEnvelope;
			try {
				entry = JSON.parse(line) as CodexEnvelope;
			} catch {
				continue;
			}
			const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
			if (!firstAt && ts) firstAt = ts;
			if (ts) record.lastAt = ts;
			if (entry.type === "session_meta") {
				if (!record.sessionId && typeof entry.payload?.session_id === "string")
					record.sessionId = entry.payload.session_id;
				if (!record.cwd && typeof entry.payload?.cwd === "string") record.cwd = entry.payload.cwd;
				if (!firstAt && typeof entry.payload?.timestamp === "string") firstAt = entry.payload.timestamp;
				continue;
			}
			if (entry.type === "turn_context") {
				if (typeof entry.payload?.model === "string" && entry.payload.model) model = entry.payload.model;
				continue;
			}
			const info = entry.payload?.info;
			if (!info) continue; // token_count 可能只有 rate_limits，info 为空
			const last = info.last_token_usage;
			if (last) {
				// 增量口径（新版）：resume 会让 total 从头重计（实测 20 次非单调），
				// 取尾会丢重置前的量；每事件的 last_token_usage 直接累加免疫重置。
				const cached = last.cached_input_tokens ?? 0;
				const input = last.input_tokens ?? 0;
				const output = last.output_tokens ?? 0;
				const bucket: CareerBucket = {
					input: cached > 0 ? Math.max(0, input - cached) : input,
					output,
					cacheRead: cached,
					cacheWrite: last.cache_write_input_tokens ?? 0,
					reasoning: last.reasoning_output_tokens ?? 0,
					totalTokens: last.total_tokens ?? input + output,
				};
				if (bucket.totalTokens > 0) {
					sawUsage = true;
					recordUsage(record, ts, model, bucket);
				}
				prevTotal = info.total_token_usage?.total_tokens ?? prevTotal;
			} else if (info.total_token_usage) {
				// 差分口径（老版本只有 total）：与前值的正差分累加
				const total = info.total_token_usage;
				const cur = total.total_tokens ?? 0;
				const delta = cur - prevTotal;
				if (delta > 0) {
					sawUsage = true;
					const cached = total.cached_input_tokens ?? 0;
					const input = total.input_tokens ?? 0;
					const ratio = cur > 0 ? delta / cur : 0;
					recordUsage(record, ts, model, {
						input: Math.max(0, Math.round((input - cached) * ratio)),
						output: Math.round((total.output_tokens ?? 0) * ratio),
						cacheRead: Math.round(cached * ratio),
						cacheWrite: Math.round((total.cache_write_input_tokens ?? 0) * ratio),
						reasoning: Math.round((total.reasoning_output_tokens ?? 0) * ratio),
						totalTokens: delta,
					});
				}
				prevTotal = cur;
			}
		}
	} catch {
		return null;
	} finally {
		lines.close();
		stream.close();
	}

	if (!sawUsage) return null; // 整场会话没有任何 token_count（异常/极老版本），跳过
	record.lastAt = record.lastAt || firstAt;
	return record;
}

// ---------------------------------------------------------------------------
// Kimi CLI 扫描（~/.kimi-code/sessions 递归 wire.jsonl）
// ---------------------------------------------------------------------------

/** usage.record 的形状：按 turn 逐条上报（非累计），模型与毫秒时间在行上。 */
interface KimiEntry {
	type?: string;
	model?: string;
	time?: number;
	usage?: {
		inputOther?: number;
		output?: number;
		inputCacheRead?: number;
		inputCacheCreation?: number;
	};
}

async function scanKimiFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const stream = createReadStream(path, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const record = emptyRecord();
	const sessionId = /session_([0-9a-f-]{8,})/.exec(path.replace(/\\/g, "/"))?.[1] ?? "";
	try {
		for await (const line of lines) {
			if (!line.includes('"usage.record"')) continue;
			let entry: KimiEntry;
			try {
				entry = JSON.parse(line) as KimiEntry;
			} catch {
				continue;
			}
			if (entry.type !== "usage.record" || !entry.usage) continue;
			const usage = entry.usage;
			const iso = typeof entry.time === "number" ? new Date(entry.time).toISOString() : "";
			const inputOther = usage.inputOther ?? 0;
			const cacheRead = usage.inputCacheRead ?? 0;
			const cacheWrite = usage.inputCacheCreation ?? 0;
			recordUsage(record, iso, typeof entry.model === "string" ? entry.model : "", {
				input: inputOther,
				output: usage.output ?? 0,
				cacheRead,
				cacheWrite,
				reasoning: 0,
				totalTokens: inputOther + (usage.output ?? 0) + cacheRead + cacheWrite,
			});
		}
	} catch {
		return null;
	} finally {
		lines.close();
		stream.close();
	}
	record.sessionId = sessionId;
	return Object.keys(record.days).length > 0 ? record : null;
}

// ---------------------------------------------------------------------------
// Roo Code / Cline（VSCode 系扩展宿主 globalStorage 的任务目录）
//
// - Roo Code：tasks/<uuid>/history_item.json 是官方维护的任务汇总，直接带
//   tokensIn/tokensOut/cacheWrites/cacheReads/totalCost/ts/workspace，按四桶直加。
// - Cline：tasks/<ts>/ui_messages.json 里 say=api_req_started 的 text JSON 带
//   tokensIn/tokensOut/cacheWrites/cacheReads（新版）；模型取消息流上最近的 modelInfo。
// ---------------------------------------------------------------------------

/** 单个扩展宿主的 tasks 根（如 %APPDATA%/Cursor/User/globalStorage/<ext>/tasks）。 */
function extensionTasksRoots(hosts: string[], extensions: string[]): string[] {
	const roots: string[] = [];
	for (const host of hosts) {
		for (const ext of extensions) {
			const dir = join(host, ext, "tasks");
			if (existsSync(dir)) roots.push(dir);
		}
	}
	return roots;
}

interface RooHistoryItem {
	id?: string;
	ts?: number;
	tokensIn?: number;
	tokensOut?: number;
	cacheWrites?: number;
	cacheReads?: number;
	workspace?: string;
}

async function scanRooHistoryFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const record = emptyRecord();
	try {
		if (statSync(path).size > 4 * 1024 * 1024) return null; // 汇总文件不该超过几 MB
		const item = JSON.parse(readFileSync(path, "utf-8")) as RooHistoryItem;
		const tokensIn = item.tokensIn ?? 0;
		const tokensOut = item.tokensOut ?? 0;
		const cacheWrites = item.cacheWrites ?? 0;
		const cacheReads = item.cacheReads ?? 0;
		const total = tokensIn + tokensOut + cacheWrites + cacheReads;
		if (total <= 0) return null;
		record.sessionId = typeof item.id === "string" ? item.id : "";
		if (typeof item.workspace === "string") record.cwd = item.workspace;
		recordUsage(
			record,
			typeof item.ts === "number" ? new Date(item.ts).toISOString() : "",
			"", // history_item 不含模型名，模型维度留空
			{
				input: tokensIn,
				output: tokensOut,
				cacheRead: cacheReads,
				cacheWrite: cacheWrites,
				reasoning: 0,
				totalTokens: total,
			},
		);
	} catch {
		return null;
	}
	return record;
}

interface ClineUiMessage {
	ts?: number;
	say?: string;
	text?: string;
	modelInfo?: { modelId?: string };
}

/** ui_messages.json 可能到几 MB：超过 64MB 的极端任务跳过（解析成本不值得）。 */
const CLINE_UI_MAX = 64 * 1024 * 1024;

async function scanClineUiFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const record = emptyRecord();
	try {
		if (statSync(path).size > CLINE_UI_MAX) return null;
		const messages = JSON.parse(readFileSync(path, "utf-8")) as ClineUiMessage[];
		if (!Array.isArray(messages)) return null;
		let lastModel = "";
		for (const message of messages) {
			const modelId = message.modelInfo?.modelId;
			if (typeof modelId === "string" && modelId) lastModel = modelId;
			if (message.say !== "api_req_started" || typeof message.text !== "string") continue;
			let usage: { tokensIn?: number; tokensOut?: number; cacheWrites?: number; cacheReads?: number };
			try {
				usage = JSON.parse(message.text) as typeof usage;
			} catch {
				continue;
			}
			const tokensIn = usage.tokensIn ?? 0;
			const tokensOut = usage.tokensOut ?? 0;
			const cacheWrites = usage.cacheWrites ?? 0;
			const cacheReads = usage.cacheReads ?? 0;
			const total = tokensIn + tokensOut + cacheWrites + cacheReads;
			if (total <= 0) continue;
			recordUsage(record, typeof message.ts === "number" ? new Date(message.ts).toISOString() : "", lastModel, {
				input: tokensIn,
				output: tokensOut,
				cacheRead: cacheReads,
				cacheWrite: cacheWrites,
				reasoning: 0,
				totalTokens: total,
			});
		}
	} catch {
		return null;
	}
	return Object.keys(record.days).length > 0 ? record : null;
}

// ---------------------------------------------------------------------------
// WorkBuddy（~/.workbuddy/projects，Claude Code 同构布局）
// ---------------------------------------------------------------------------

/**
 * 流式扫描一场 WorkBuddy 会话：用量挂在 function_call 行的 providerData.usage
 * （camelCase，inputTokens 含缓存，缓存/推理在 *Details 数组），模型与毫秒时间戳
 * 在行上；扣掉缓存重叠保证四桶之和 = totalTokens。
 */
async function scanWorkbuddyFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const stream = createReadStream(path, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const record = emptyRecord();
	try {
		for await (const line of lines) {
			if (!line.includes('"usage"')) continue;
			let entry: {
				timestamp?: number;
				sessionId?: string;
				cwd?: string;
				providerData?: {
					model?: string;
					usage?: {
						inputTokens?: number;
						outputTokens?: number;
						totalTokens?: number;
						inputTokensDetails?: { cached_tokens?: number }[];
						outputTokensDetails?: { reasoning_tokens?: number }[];
					};
				};
			};
			try {
				entry = JSON.parse(line) as typeof entry;
			} catch {
				continue;
			}
			if (!record.sessionId && typeof entry.sessionId === "string") record.sessionId = entry.sessionId;
			if (!record.cwd && typeof entry.cwd === "string") record.cwd = entry.cwd;
			const usage = entry.providerData?.usage;
			if (!usage || typeof usage !== "object") continue;
			const input = usage.inputTokens ?? 0;
			const output = usage.outputTokens ?? 0;
			const cached = usage.inputTokensDetails?.[0]?.cached_tokens ?? 0;
			const bucket: CareerBucket = {
				input: cached > 0 ? Math.max(0, input - cached) : input,
				output,
				cacheRead: cached,
				cacheWrite: 0,
				reasoning: usage.outputTokensDetails?.[0]?.reasoning_tokens ?? 0,
				totalTokens: usage.totalTokens ?? input + output,
			};
			if (bucket.totalTokens <= 0) continue;
			recordUsage(
				record,
				typeof entry.timestamp === "number" ? new Date(entry.timestamp).toISOString() : "",
				typeof entry.providerData?.model === "string" ? entry.providerData.model : "",
				bucket,
			);
		}
	} catch {
		return null;
	} finally {
		lines.close();
		stream.close();
	}
	return Object.keys(record.days).length > 0 ? record : null;
}

// ---------------------------------------------------------------------------
// DeepSeek Harness（~/.dsh/sessions，多帧 zstd 压缩的 JSONL）
// ---------------------------------------------------------------------------

/** zstd 多帧拼接文件（session.v4.jsonl.zstd 是 100+ 帧连写）：逐帧解压后拼接。 */
function decompressMultiFrameZstd(buf: Buffer): string {
	const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	let out = "";
	let start = 0;
	let idx = buf.indexOf(MAGIC, 1);
	while (idx !== -1) {
		try {
			out += zstdDecompressSync(buf.subarray(start, idx)).toString("utf-8");
			if (!out.endsWith("\n")) out += "\n"; // 帧间无分隔符，补齐保证逐行解析
		} catch {
			// 单帧损坏就丢这段，不让整文件报废
		}
		start = idx;
		idx = buf.indexOf(MAGIC, idx + 1);
	}
	try {
		out += zstdDecompressSync(buf.subarray(start)).toString("utf-8");
	} catch {
		// 尾部非完整帧
	}
	return out;
}

interface DshEntry {
	type?: string;
	time?: number;
	sessionId?: string;
	cwd?: string;
	data?: {
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number };
		message?: { source?: { model?: string; provider?: string } };
		cwd?: string;
	};
}

/**
 * 流式扫描一场 DeepSeek Harness 会话：用量挂在 assistant/message 行的 data.usage
 * （inputTokens 已含缓存读 cacheReadTokens，展示时扣除重叠）；模型在
 * data.message.source.model；sessionId/cwd 取 session 头行。
 */
async function scanDshFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const record = emptyRecord();
	try {
		if (statSync(path).size > 256 * 1024 * 1024) return null; // 压缩包极端上限保护
		const lines = decompressMultiFrameZstd(readFileSync(path)).split(/\r?\n/);
		for (const line of lines) {
			if (!line.includes('"usage"') && !line.includes('"cwd"')) continue;
			let entry: DshEntry;
			try {
				entry = JSON.parse(line) as DshEntry;
			} catch {
				continue;
			}
			if (!record.cwd && typeof entry.data?.cwd === "string") record.cwd = entry.data.cwd;
			const usage = entry.data?.usage;
			if (!usage || typeof usage !== "object") continue;
			const cached = usage.cacheReadTokens ?? 0;
			const input = usage.inputTokens ?? 0;
			const output = usage.outputTokens ?? 0;
			const bucket: CareerBucket = {
				input: cached > 0 ? Math.max(0, input - cached) : input,
				output,
				cacheRead: cached,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: usage.totalTokens ?? input + output,
			};
			if (bucket.totalTokens <= 0) continue;
			const source = entry.data?.message?.source;
			const model = source?.model ?? "";
			recordUsage(record, typeof entry.time === "number" ? new Date(entry.time).toISOString() : "", model, bucket);
		}
	} catch {
		return null;
	}
	return Object.keys(record.days).length > 0 || record.sessionId ? record : null;
}

// ---------------------------------------------------------------------------
// Cursor 会话历史估算（~/.cursor/acp-sessions/<uuid>/store.db）
// ---------------------------------------------------------------------------

/**
 * 近似 token 数：CJK 字符按 1、其它字符按 1/4（无 tokenizer 依赖的通用启发式）。
 */
function estimateTokens(text: string): number {
	if (!text) return 0;
	let cjk = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0x3040 && code <= 0x30ff) ||
			(code >= 0xac00 && code <= 0xd7af)
		)
			cjk++;
	}
	return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 从消息 blob 的 content 数组里抽全部文本（text 与 tool-result）。 */
function textOfCursorBlob(raw: string): string {
	let text = "";
	for (const match of raw.matchAll(/"(?:text|result)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
		try {
			text += JSON.parse(`"${match[1]}"`) as string;
			text += "\n";
		} catch {
			text += `${match[1]}\n`;
		}
	}
	return text;
}

interface CursorBlobRow {
	/** blobs.data 实测为 BLOB 列（node:sqlite 返回 Uint8Array），兼容 TEXT 存量。 */
	data: string | Uint8Array | null;
}

/**
 * Cursor 本地不落官方用量（IDE/CLI 各库已逐个核验），按会话历史内容估算：
 * 逐条消息重放——assistant 的输入 ≈ 此前累计上下文（每轮 API 都重发），输出 ≈ 该消息
 * 文本本身。blobs 无时间戳，整场会话的估算量归到最后活动日（文件 mtime）。
 * 量级估算（无官方数字可比对），看板中该行注明估算口径。
 */
async function scanCursorEstimateFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const db = await openSqliteReadOnly(path);
	if (!db) return null;
	const record = emptyRecord();
	record.sessionId = path.replace(/\\/g, "/").split("/").slice(-2, -1)[0] ?? "";
	try {
		const mtimeMs = (await stat(path)).mtimeMs;
		const iso = new Date(mtimeMs).toISOString();
		const rows = db.prepare("select data from blobs order by rowid").all() as unknown as CursorBlobRow[];
		// 池的 token 估算用两个增量计数器维护，避免每条 assistant 全量重扫
		let poolCjk = 0;
		let poolOther = 0;
		let total = 0;
		const countInto = (text: string): void => {
			for (const ch of text) {
				const code = ch.codePointAt(0) ?? 0;
				if (
					(code >= 0x4e00 && code <= 0x9fff) ||
					(code >= 0x3040 && code <= 0x30ff) ||
					(code >= 0xac00 && code <= 0xd7af)
				)
					poolCjk++;
				else poolOther++;
			}
		};
		for (const row of rows) {
			const raw = typeof row.data === "string" ? row.data : row.data ? Buffer.from(row.data).toString("utf-8") : "";
			if (!raw.startsWith("{")) continue;
			let blob: { role?: string };
			try {
				blob = JSON.parse(raw) as typeof blob;
			} catch {
				continue;
			}
			const text = textOfCursorBlob(raw);
			if (blob.role === "assistant" && text.trim()) {
				const output = estimateTokens(text);
				const input = poolCjk + Math.ceil(poolOther / 4);
				const bucketTotal = input + output;
				if (bucketTotal > 0) {
					total += bucketTotal;
					recordUsage(record, iso, "cursor", {
						input,
						output,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						totalTokens: bucketTotal,
					});
				}
			}
			countInto(text);
		}
		void total;
	} catch {
		return null;
	} finally {
		try {
			db.close();
		} catch {
			// 已关/不可关就算了
		}
	}
	return Object.keys(record.days).length > 0 ? record : null;
}

// ---------------------------------------------------------------------------
// Mavis（MiniMax Code，~/.mavis/v2/sessions/**/messages.jsonl）
// ---------------------------------------------------------------------------

/** Mavis 消息行：message.usage 与 owl 同口径（input/output/cacheRead/cacheWrite 分列，四者和 = total），实测费用也在。 */
interface MavisEntry {
	message_id?: string;
	message?: {
		role?: string;
		model?: string;
		timestamp?: string | number;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
	};
}

async function scanMavisFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const stream = createReadStream(path, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const record = emptyRecord();
	record.sessionId = path.replace(/\\/g, "/").split("/").slice(-2, -1)[0] ?? "";
	try {
		for await (const line of lines) {
			if (!line.includes('"usage"')) continue;
			let entry: MavisEntry;
			try {
				entry = JSON.parse(line) as MavisEntry;
			} catch {
				continue;
			}
			const message = entry.message;
			const usage = message?.usage;
			if (!usage || typeof usage !== "object") continue;
			const ts =
				typeof message?.timestamp === "number"
					? new Date(message.timestamp).toISOString()
					: typeof message?.timestamp === "string"
						? message.timestamp
						: "";
			const bucket: CareerBucket = {
				input: usage.input ?? 0,
				output: usage.output ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				reasoning: 0,
				totalTokens:
					usage.totalTokens ??
					(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
			};
			if (bucket.totalTokens <= 0) continue;
			record.cost += usage.cost?.total ?? 0;
			recordUsage(record, ts, typeof message?.model === "string" ? message.model : "", bucket);
		}
	} catch {
		return null;
	} finally {
		lines.close();
		stream.close();
	}
	return Object.keys(record.days).length > 0 ? record : null;
}

// ---------------------------------------------------------------------------
// Reasonix（%APPDATA%/reasonix/projects/**/**.telemetry.json）
// ---------------------------------------------------------------------------

/** Reasonix 遥测：每会话一个官方汇总对象（promptTokens = cacheHit + cacheMiss，含会话费用）。 */
interface ReasonixTelemetry {
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		reasoningTokens?: number;
		cacheHitTokens?: number;
		cacheMissTokens?: number;
		sessionCostUsd?: number;
	};
}

async function scanReasonixTelemetryFile(path: string): Promise<Omit<CareerFileRecord, "mtime" | "size"> | null> {
	const record = emptyRecord();
	try {
		if (statSync(path).size > 16 * 1024 * 1024) return null;
		const telemetry = JSON.parse(readFileSync(path, "utf-8")) as ReasonixTelemetry;
		const usage = telemetry.usage;
		if (!usage || typeof usage !== "object") return null;
		const cacheHit = usage.cacheHitTokens ?? 0;
		const cacheMiss = usage.cacheMissTokens ?? 0;
		const completion = usage.completionTokens ?? 0;
		const total = usage.totalTokens ?? cacheHit + cacheMiss + completion;
		if (total <= 0) return null;
		// promptTokens = cacheHit + cacheMiss（含缓存），扣除重叠保证四桶之和 = total
		recordUsage(
			record,
			// 遥测无顶层时间：refreshSource 侧以文件 mtime 落天（scan 返回前无法拿到，交给 mtime 分支）
			new Date(statSync(path).mtimeMs).toISOString(),
			// 模型名在文件名里（<时间戳>-<model>-session.jsonl.telemetry.json）
			/-\d+\.\d+-([a-z0-9.+-]+)-session\.jsonl\.telemetry\.json$/i.exec(path.replace(/\\/g, "/"))?.[1] ?? "",
			{
				input: cacheMiss,
				output: completion,
				cacheRead: cacheHit,
				cacheWrite: 0,
				reasoning: usage.reasoningTokens ?? 0,
				totalTokens: total,
			},
		);
		record.cost += usage.sessionCostUsd ?? 0;
		record.cwd = path.replace(/\\/g, "/").split("/").slice(-3, -2)[0] ?? "";
	} catch {
		return null;
	}
	return record;
}

// ---------------------------------------------------------------------------
// OpenCode（~/.local/share/opencode/opencode.db，node:sqlite 只读）
// ---------------------------------------------------------------------------

interface OpenCodeUsage {
	totals: CareerBucket;
	cost: number;
	byDay: Map<string, CareerBucket>;
	byModel: Map<string, CareerBucket>;
	sessions: number;
	firstMs?: number;
	lastMs?: number;
	/** fromCache 时为快照生成时间。 */
	capturedAt?: string;
	/** true = 当前库不可读，本次用的是持久化快照（"来源已卸载"场景）。 */
	fromCache?: boolean;
}

/** 快照 ↔ 内存结构互转（byDay/byModel 是 Map，落盘转 Record）。 */
function usageToCache(usage: OpenCodeUsage): CareerAggregateCache {
	const toRecord = (map: Map<string, CareerBucket>): Record<string, CareerBucket> => {
		const out: Record<string, CareerBucket> = {};
		for (const [key, bucket] of map) out[key] = bucket;
		return out;
	};
	return {
		capturedAt: new Date().toISOString(),
		sessions: usage.sessions,
		...(usage.firstMs !== undefined ? { firstMs: usage.firstMs } : {}),
		...(usage.lastMs !== undefined ? { lastMs: usage.lastMs } : {}),
		cost: usage.cost,
		totals: usage.totals,
		byDay: toRecord(usage.byDay),
		byModel: toRecord(usage.byModel),
	};
}

function cacheToUsage(cache: CareerAggregateCache): OpenCodeUsage {
	const toMap = (record: Record<string, CareerBucket>): Map<string, CareerBucket> => new Map(Object.entries(record));
	return {
		totals: cache.totals,
		cost: cache.cost,
		byDay: toMap(cache.byDay),
		byModel: toMap(cache.byModel),
		sessions: cache.sessions,
		capturedAt: cache.capturedAt,
		...(cache.firstMs !== undefined ? { firstMs: cache.firstMs } : {}),
		...(cache.lastMs !== undefined ? { lastMs: cache.lastMs } : {}),
		fromCache: true,
	};
}

/**
 * "只增量、永不删除"对 SQLite 聚合源的落地：读取成功 → 刷新快照返回；
 * 库被删/损坏/不可读 → 回退到最后一次成功快照（fromCache 标记由行级 note 说明）。
 */
function withAggregateFallback(
	key: "opencode" | "kilo" | "qoder" | "copilot" | "mimo" | "zcode",
	live: OpenCodeUsage | null,
	store: CareerStore,
): OpenCodeUsage | null {
	if (live) {
		store.aggregates[key] = usageToCache(live);
		return live;
	}
	const cached = store.aggregates[key];
	if (!cached) return null;
	const restored = cacheToUsage(cached);
	return restored.totals.totalTokens > 0 || restored.sessions > 0 ? restored : null;
}

/** node:sqlite 动态加载（老运行时没有就如实降级，不拖垮整个模块）。 */
async function openSqliteReadOnly(dbPath: string): Promise<DatabaseSync | null> {
	try {
		if (!existsSync(dbPath)) return null;
		const { DatabaseSync: ctor } = await import("node:sqlite");
		return new ctor(dbPath, { readOnly: true });
	} catch {
		return null;
	}
}

/** OpenCode / Kilo Code 汇总（两家共用同一套 session/message 表结构）：官方聚合列 + 按天/按模型明细。 */
async function collectSessionAggregateDb(dbPath: string): Promise<OpenCodeUsage | null> {
	const db = await openSqliteReadOnly(dbPath);
	if (!db) return null;
	try {
		const usage: OpenCodeUsage = {
			totals: emptyBucket(),
			cost: 0,
			byDay: new Map(),
			byModel: new Map(),
			sessions: 0,
		};

		// 官方聚合列（OpenCode/Kilo 新版有）；mimocode 等老 schema 没有 tokens_* 列，
		// 查询抛错时从 message 行折叠（sessions/firstMs/lastMs 也在折叠段补齐）。
		let head: {
			n: number;
			i: number;
			o: number;
			cr: number;
			cw: number;
			r: number;
			cost: number;
			firstMs: number | null;
			lastMs: number | null;
		} | null = null;
		try {
			head = db
				.prepare(
					"select count(*) n, coalesce(sum(tokens_input),0) i, coalesce(sum(tokens_output),0) o, coalesce(sum(tokens_cache_read),0) cr, coalesce(sum(tokens_cache_write),0) cw, coalesce(sum(tokens_reasoning),0) r, coalesce(sum(cost),0) cost, min(time_created) firstMs, max(time_updated) lastMs from session",
				)
				.get() as {
				n: number;
				i: number;
				o: number;
				cr: number;
				cw: number;
				r: number;
				cost: number;
				firstMs: number | null;
				lastMs: number | null;
			};
		} catch {
			head = null;
		}
		if (head) {
			usage.sessions = Number(head.n);
			usage.cost = Number(head.cost);
			usage.totals = {
				input: Number(head.i),
				output: Number(head.o),
				cacheRead: Number(head.cr),
				cacheWrite: Number(head.cw),
				reasoning: Number(head.r),
				totalTokens: Number(head.i) + Number(head.o) + Number(head.cr) + Number(head.cw),
			};
			if (head.firstMs !== null) usage.firstMs = Number(head.firstMs);
			if (head.lastMs !== null) usage.lastMs = Number(head.lastMs);
		}

		// 按天/按模型：message 表 assistant 行的 data JSON（opencode 自身维护的口径）。
		// 数据倾斜时（超大库）也可切到 session 表粒度，但天/模型维度只能从 message 取。
		const rows = db
			.prepare(
				"select session_id, time_created, json_extract(data,'$.tokens') tokens, json_extract(data,'$.cost') cost, json_extract(data,'$.providerID') provider, json_extract(data,'$.modelID') model from message where json_extract(data,'$.role')='assistant'",
			)
			.all() as {
			session_id: string | null;
			time_created: number;
			tokens: string | null;
			cost: number | null;
			provider: string | null;
			model: string | null;
		}[];
		const seenSessions = new Set<string>();
		let rowFirstMs = Number.POSITIVE_INFINITY;
		let rowLastMs = 0;
		for (const row of rows) {
			if (row.session_id) seenSessions.add(row.session_id);
			const ms = Number(row.time_created);
			if (Number.isFinite(ms) && ms > 0) {
				rowFirstMs = Math.min(rowFirstMs, ms);
				rowLastMs = Math.max(rowLastMs, ms);
			}
			if (!row.tokens) continue;
			let tokens: {
				input?: number;
				output?: number;
				reasoning?: number;
				total?: number;
				cache?: { read?: number; write?: number };
			};
			try {
				tokens = JSON.parse(row.tokens) as typeof tokens;
			} catch {
				continue;
			}
			const bucket: CareerBucket = {
				input: tokens.input ?? 0,
				output: tokens.output ?? 0,
				cacheRead: tokens.cache?.read ?? 0,
				cacheWrite: tokens.cache?.write ?? 0,
				reasoning: tokens.reasoning ?? 0,
				totalTokens:
					tokens.total ??
					(tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0),
			};
			const iso = new Date(Number(row.time_created)).toISOString();
			const date = localDateKey(iso);
			if (date) {
				const day = usage.byDay.get(date) ?? emptyBucket();
				addBucket(day, bucket);
				usage.byDay.set(date, day);
			}
			const modelKey = `${row.provider ?? "?"}/${row.model ?? "?"}`;
			const modelBucket = usage.byModel.get(modelKey) ?? emptyBucket();
			addBucket(modelBucket, bucket);
			usage.byModel.set(modelKey, modelBucket);
			if (!head) {
				// 无官方聚合列的库：cost 只能从 message 行累加
				usage.cost += typeof row.cost === "number" ? row.cost : 0;
			}
		}
		if (!head) {
			// 无官方聚合列的库（mimocode 等）：totals/sessions/时间边界从 message 行折叠补齐
			usage.sessions = seenSessions.size;
			for (const day of usage.byDay.values()) addBucket(usage.totals, day);
			if (rowFirstMs !== Number.POSITIVE_INFINITY) usage.firstMs = rowFirstMs;
			if (rowLastMs > 0) usage.lastMs = rowLastMs;
		}
		return usage;
	} catch {
		return null; // 库被锁/版本不识别：按无数据处理，不猜
	} finally {
		// Windows 上不关连接会让文件一直被锁，测试清目录都会 EPERM
		try {
			db.close();
		} catch {
			// 已关/不可关就算了
		}
	}
}

// ---------------------------------------------------------------------------
// Qoder（%APPDATA%/Qoder/SharedClientCache/cache/db/local.db）
// ---------------------------------------------------------------------------

/** Qoder 汇总：chat_message 每条 assistant 行的 token_info（prompt/completion/cached，非累计）。 */
async function collectQoder(dbPath: string): Promise<OpenCodeUsage | null> {
	const db = await openSqliteReadOnly(dbPath);
	if (!db) return null;
	try {
		// 先确认目标表存在（版本不识别时 sqlite 会抛错 → 走降级）
		db.prepare("select count(*) n from chat_message").get();
		const usage: OpenCodeUsage = {
			totals: emptyBucket(),
			cost: 0,
			byDay: new Map(),
			byModel: new Map(),
			sessions: 0,
		};
		usage.sessions = Number((db.prepare("select count(*) n from chat_session").get() as { n: number }).n);

		const rows = db
			.prepare(
				"select token_info, model_info, gmt_create from chat_message where role='assistant' and token_info is not null and token_info != ''",
			)
			.all() as { token_info: string; model_info: string | null; gmt_create: number | null }[];
		for (const row of rows) {
			let info: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number };
			try {
				info = JSON.parse(row.token_info) as typeof info;
			} catch {
				continue;
			}
			let model = "";
			if (row.model_info) {
				try {
					model = (JSON.parse(row.model_info) as { model_key?: string }).model_key ?? "";
				} catch {
					model = "";
				}
			}
			const input = info.prompt_tokens ?? 0;
			const cached = info.cached_tokens ?? 0;
			const output = info.completion_tokens ?? 0;
			// Qoder 的 prompt_tokens 是否含 cached 无法从记录区分：cached>0 时把重叠部分
			// 从 input 里扣除，保证四桶之和恰好等于 prompt+completion（不重复计）。
			const nonCachedInput = cached > 0 ? Math.max(0, input - cached) : input;
			const bucket: CareerBucket = {
				input: nonCachedInput,
				output,
				cacheRead: cached,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: input + output,
			};
			if (bucket.totalTokens <= 0) continue;
			const iso = row.gmt_create ? new Date(Number(row.gmt_create)).toISOString() : "";
			const date = localDateKey(iso);
			if (date) {
				const day = usage.byDay.get(date) ?? emptyBucket();
				addBucket(day, bucket);
				usage.byDay.set(date, day);
			}
			const modelKey = model || "qoder";
			const modelBucket = usage.byModel.get(modelKey) ?? emptyBucket();
			addBucket(modelBucket, bucket);
			usage.byModel.set(modelKey, modelBucket);
			addBucket(usage.totals, bucket);
			if (iso) {
				const ms = Number(row.gmt_create);
				usage.firstMs = Math.min(usage.firstMs ?? Number.POSITIVE_INFINITY, ms);
				usage.lastMs = Math.max(usage.lastMs ?? 0, ms);
			}
		}
		if (usage.firstMs === Number.POSITIVE_INFINITY) usage.firstMs = undefined;
		return usage;
	} catch {
		return null; // 库被锁/版本不识别：按无数据处理，不猜
	} finally {
		try {
			db.close();
		} catch {
			// 已关/不可关就算了
		}
	}
}

// ---------------------------------------------------------------------------
// GitHub Copilot CLI（~/.copilot/session-store.db）
// ---------------------------------------------------------------------------

/** Copilot 汇总：assistant_usage_events 每行一次请求的用量（非累计）。 */
async function collectCopilot(dbPath: string): Promise<OpenCodeUsage | null> {
	const db = await openSqliteReadOnly(dbPath);
	if (!db) return null;
	try {
		const usage: OpenCodeUsage = {
			totals: emptyBucket(),
			cost: 0,
			byDay: new Map(),
			byModel: new Map(),
			sessions: 0,
		};
		usage.sessions = Number((db.prepare("select count(*) n from sessions").get() as { n: number }).n);
		const rows = db
			.prepare(
				"select model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at from assistant_usage_events",
			)
			.all() as {
			model: string | null;
			input_tokens: number | null;
			output_tokens: number | null;
			cache_read_tokens: number | null;
			cache_write_tokens: number | null;
			reasoning_tokens: number | null;
			created_at: number | string | null;
		}[];
		for (const row of rows) {
			const bucket: CareerBucket = {
				input: row.input_tokens ?? 0,
				output: row.output_tokens ?? 0,
				cacheRead: row.cache_read_tokens ?? 0,
				cacheWrite: row.cache_write_tokens ?? 0,
				reasoning: row.reasoning_tokens ?? 0,
				totalTokens:
					(row.input_tokens ?? 0) +
					(row.output_tokens ?? 0) +
					(row.cache_read_tokens ?? 0) +
					(row.cache_write_tokens ?? 0),
			};
			if (bucket.totalTokens <= 0) continue;
			// created_at 实测为 ISO 字符串（早期版本可能是 ms 整数），两种都接
			const createdMs =
				typeof row.created_at === "number" ? row.created_at : Date.parse(String(row.created_at ?? ""));
			const iso = Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : "";
			const date = localDateKey(iso);
			if (date) {
				const day = usage.byDay.get(date) ?? emptyBucket();
				addBucket(day, bucket);
				usage.byDay.set(date, day);
			}
			const modelKey = row.model || "copilot";
			const modelBucket = usage.byModel.get(modelKey) ?? emptyBucket();
			addBucket(modelBucket, bucket);
			usage.byModel.set(modelKey, modelBucket);
			addBucket(usage.totals, bucket);
			if (iso) {
				usage.firstMs = Math.min(usage.firstMs ?? Number.POSITIVE_INFINITY, createdMs);
				usage.lastMs = Math.max(usage.lastMs ?? 0, createdMs);
			}
		}
		if (usage.firstMs === Number.POSITIVE_INFINITY) usage.firstMs = undefined;
		return usage;
	} catch {
		return null;
	} finally {
		try {
			db.close();
		} catch {
			// 已关/不可关就算了
		}
	}
}

// ---------------------------------------------------------------------------
// ZCode（~/.zcode/cli/db/db.sqlite）
// ---------------------------------------------------------------------------

/**
 * ZCode 汇总：turn_usage 每轮一行（input 已含缓存读，computed_total = input + output），
 * 按天取 started_at（ms）；按模型从 model_usage（每次模型请求一行）聚合。
 * 与 Codex/Qoder 同口径处理：非缓存输入 = input - cacheRead，四桶之和 = computed_total。
 */
async function collectZcode(dbPath: string): Promise<OpenCodeUsage | null> {
	const db = await openSqliteReadOnly(dbPath);
	if (!db) return null;
	try {
		const usage: OpenCodeUsage = {
			totals: emptyBucket(),
			cost: 0,
			byDay: new Map(),
			byModel: new Map(),
			sessions: 0,
		};
		usage.sessions = Number(
			(db.prepare("select count(distinct session_id) n from turn_usage").get() as { n: number }).n,
		);

		const turns = db
			.prepare(
				"select input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens, started_at from turn_usage where computed_total_tokens > 0",
			)
			.all() as {
			input_tokens: number | null;
			output_tokens: number | null;
			reasoning_tokens: number | null;
			cache_creation_input_tokens: number | null;
			cache_read_input_tokens: number | null;
			computed_total_tokens: number | null;
			started_at: number | null;
		}[];
		for (const turn of turns) {
			const cached = turn.cache_read_input_tokens ?? 0;
			const input = turn.input_tokens ?? 0;
			const output = turn.output_tokens ?? 0;
			const bucket: CareerBucket = {
				input: cached > 0 ? Math.max(0, input - cached) : input,
				output,
				cacheRead: cached,
				cacheWrite: turn.cache_creation_input_tokens ?? 0,
				reasoning: turn.reasoning_tokens ?? 0,
				totalTokens: turn.computed_total_tokens ?? input + output,
			};
			if (bucket.totalTokens <= 0) continue;
			const iso = turn.started_at ? new Date(Number(turn.started_at)).toISOString() : "";
			const date = localDateKey(iso);
			if (date) {
				const day = usage.byDay.get(date) ?? emptyBucket();
				addBucket(day, bucket);
				usage.byDay.set(date, day);
			}
			addBucket(usage.totals, bucket);
			if (iso) {
				const ms = Number(turn.started_at);
				usage.firstMs = Math.min(usage.firstMs ?? Number.POSITIVE_INFINITY, ms);
				usage.lastMs = Math.max(usage.lastMs ?? 0, ms);
			}
		}

		const models = db
			.prepare(
				"select provider_id, model_id, sum(computed_total_tokens) tt from model_usage where computed_total_tokens > 0 group by provider_id, model_id",
			)
			.all() as { provider_id: string | null; model_id: string | null; tt: number | null }[];
		for (const row of models) {
			const tokens = Number(row.tt);
			if (tokens > 0)
				usage.byModel.set(`${row.provider_id ?? "?"}/${row.model_id ?? "?"}`, {
					...emptyBucket(),
					totalTokens: tokens,
				});
		}
		if (usage.firstMs === Number.POSITIVE_INFINITY) usage.firstMs = undefined;
		return usage;
	} catch {
		return null;
	} finally {
		try {
			db.close();
		} catch {
			// 已关/不可关就算了
		}
	}
}

// ---------------------------------------------------------------------------
// 折叠 + 状态
// ---------------------------------------------------------------------------

/** 折叠单数据源的全部文件记录。 */
function foldFiles(files: Record<string, CareerFileRecord>): {
	totals: CareerBucket;
	byDay: Map<string, CareerBucket>;
	byModel: Map<string, CareerBucket>;
	sessions: number;
	firstAt?: string;
	lastAt?: string;
	cost: number;
} {
	const totals = emptyBucket();
	const byDay = new Map<string, CareerBucket>();
	const byModel = new Map<string, CareerBucket>();
	let sessions = 0;
	let cost = 0;
	let firstAt: string | undefined;
	let lastAt: string | undefined;
	for (const file of Object.values(files)) {
		sessions += 1;
		cost += file.cost;
		for (const bucket of Object.values(file.days)) addBucket(totals, bucket);
		for (const [date, bucket] of Object.entries(file.days)) {
			const target = byDay.get(date) ?? emptyBucket();
			addBucket(target, bucket);
			byDay.set(date, target);
		}
		for (const [model, bucket] of Object.entries(file.models)) {
			const target = byModel.get(model) ?? emptyBucket();
			addBucket(target, bucket);
			byModel.set(model, target);
		}
		if (file.lastAt) {
			if (!firstAt || file.lastAt < firstAt) firstAt = file.lastAt;
			if (!lastAt || file.lastAt > lastAt) lastAt = file.lastAt;
		}
	}
	return { totals, byDay, byModel, sessions, firstAt, lastAt, cost };
}

function bucketToTokens(byDay: Map<string, CareerBucket>): { date: string; totalTokens: number }[] {
	return [...byDay.entries()]
		.filter(([, bucket]) => bucket.totalTokens > 0)
		.map(([date, bucket]) => ({ date, totalTokens: bucket.totalTokens }))
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function modelsToRows(byModel: Map<string, CareerBucket>): { key: string; totalTokens: number }[] {
	return [...byModel.entries()]
		.filter(([, bucket]) => bucket.totalTokens > 0)
		.map(([key, bucket]) => ({ key, totalTokens: bucket.totalTokens }))
		.sort((a, b) => b.totalTokens - a.totalTokens);
}

function statusOf(root: string): CareerSourceStatus {
	return existsSync(root) ? "ok" : "unavailable";
}

/** SQLite 聚合源（OpenCode/Kilo/Qoder/Copilot 共用）→ CareerAgentUsage 的公共字段。 */
function usageRow(
	usage: OpenCodeUsage | null,
	dirExists: boolean,
	root: string,
	unavailableNote: string,
): Omit<CareerAgentUsage, "id" | "name"> {
	if (!usage) {
		return {
			status: dirExists ? "nodata" : "unavailable",
			...(dirExists ? { note: unavailableNote } : {}),
			root,
			sessions: 0,
			totals: { ...emptyBucket(), cost: 0 },
			byDay: [],
			byModel: [],
		};
	}
	const hasUsage = usage.totals.totalTokens > 0;
	const snapshotNote =
		usage.fromCache && usage.capturedAt
			? `来源应用已卸载或暂不可读，显示 ${usage.capturedAt.slice(0, 10)} ${usage.capturedAt.slice(11, 16)} 的最后同步快照`
			: undefined;
	return {
		status: hasUsage ? "ok" : "nodata",
		...(snapshotNote
			? { note: snapshotNote }
			: !hasUsage
				? { note: "本地会话库存在，但其中没有 token 用量记录" }
				: {}),
		root,
		sessions: usage.sessions,
		...(usage.firstMs !== undefined ? { firstAt: new Date(usage.firstMs).toISOString() } : {}),
		...(usage.lastMs !== undefined ? { lastAt: new Date(usage.lastMs).toISOString() } : {}),
		totals: { ...usage.totals, cost: usage.cost },
		byDay: bucketToTokens(usage.byDay),
		byModel: modelsToRows(usage.byModel),
	};
}

/** Gemini：目录在也只能数出会话文件数——它的本地记录不含 token 用量字段。 */
async function geminiSessions(geminiDir: string): Promise<number> {
	let count = 0;
	let chatDirs: string[] = [];
	try {
		chatDirs = (await readdir(join(geminiDir, "tmp"), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return 0;
	}
	for (const hashDir of chatDirs) {
		try {
			for (const file of await readdir(join(geminiDir, "tmp", hashDir, "chats"))) {
				if (file.endsWith(".jsonl")) count += 1;
			}
		} catch {
			// 读不了就跳过
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// 检测表：确认存在但暂无法精确解析的 agent（只报状态，不估算）
// ---------------------------------------------------------------------------

interface DetectedSource {
	id: string;
	name: string;
	/** 相对检测根的候选路径，任一存在即视为检测到（root 展示用第一个存在的）。 */
	candidates: string[];
	status: Extract<CareerSourceStatus, "detected" | "nodata">;
	note: string;
}

const DETECTED_SOURCES: DetectedSource[] = [
	{
		// ModularData/ai-agent/database.db 是加密私有格式（非 SQLite），无法准确解析。
		id: "trae",
		name: "Trae",
		candidates: [".trae-cn", ".trae", "AppData/Roaming/TRAE SOLO CN"],
		status: "detected",
		note: "会话库为加密私有格式，暂无法准确解析",
	},
	{
		id: "lingma",
		name: "通义灵码",
		candidates: [".lingma"],
		status: "nodata",
		note: "本地仅扩展/技能，无会话记录",
	},
	{
		id: "antigravity",
		name: "Antigravity",
		candidates: ["AppData/Roaming/Antigravity", ".antigravity_tools"],
		status: "detected",
		note: "会话存于私有存储，暂无法准确解析",
	},
	{ id: "junie", name: "Junie", candidates: [".junie"], status: "nodata", note: "仅安装配置，未见本地会话记录" },
	{
		id: "codebuddy",
		name: "CodeBuddy",
		candidates: [".codebuddy"],
		status: "nodata",
		note: "会话记录（projects/*.jsonl）不含 token 用量字段",
	},
	{
		id: "minimax",
		name: "MiniMax Agent",
		candidates: [".minimax"],
		status: "nodata",
		note: "本地会话记录与后台任务日志均不含 token 用量",
	},
	{ id: "grok", name: "Grok", candidates: [".grokbot"], status: "nodata", note: "本地无会话用量记录" },
];

function detectedRows(root: string): CareerAgentUsage[] {
	const rows: CareerAgentUsage[] = [];
	for (const source of DETECTED_SOURCES) {
		let matched = "";
		for (const candidate of source.candidates) {
			if (existsSync(join(root, candidate))) {
				matched = candidate;
				break;
			}
		}
		if (!matched) continue;
		rows.push({
			id: source.id,
			name: source.name,
			status: source.status,
			note: source.note,
			root: `~/${matched}`,
			sessions: 0,
			totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 },
			byDay: [],
			byModel: [],
		});
	}
	return rows;
}

// ---------------------------------------------------------------------------
// 总装（桥插件 career.get 调用）
// ---------------------------------------------------------------------------

/**
 * 聚合全部数据源。串行化与 usage-stats 独立：career 的首扫可能较慢
 * （Codex 全量可到 GB 级），不拖累其它 usage 调用。
 */
export async function collectCareerStats(host: CareerHost, dirs?: CareerDirs): Promise<CareerGetResult> {
	const agentDir = dirs?.agentDir ?? host.agentDir;
	const claudeDir = dirs?.claudeDir ?? join(homedir(), ".claude");
	const codexDir = dirs?.codexDir ?? join(homedir(), ".codex");
	const kimiDir = dirs?.kimiDir ?? join(homedir(), ".kimi-code");
	const opencodeDir = dirs?.opencodeDir ?? join(homedir(), ".local", "share", "opencode");
	const geminiDir = dirs?.geminiDir ?? join(homedir(), ".gemini");
	const detectRoot = dirs?.detectRoot ?? homedir();

	const run = chain
		.catch(() => undefined)
		.then(async (): Promise<CareerGetResult> => {
			const storePath = careerStorePath(agentDir);
			const store = storeCache.get(storePath) ?? readStore(storePath, host.files);
			storeCache.set(storePath, store);

			const jsonl = (name: string): boolean => name.endsWith(".jsonl");
			await refreshSource(store.claude, [join(claudeDir, "projects")], jsonl, scanClaudeFile);
			// Codex 正式会话与归档会话是两棵目录树，都扫（归档里也常有大历史）
			await refreshSource(
				store.codex,
				[join(codexDir, "sessions"), join(codexDir, "archived_sessions")],
				jsonl,
				scanCodexFile,
			);
			// Kimi CLI + Kimi 桌面端（daimon runtime）同一家产品的两类本地目录，都扫。
			const kimiDesktopDir =
				dirs?.kimiDesktopDir ??
				join(
					process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
					"kimi-desktop",
					"daimon-share",
					"daimon",
					"runtime",
					"kimi-code",
					"home",
					"sessions",
				);
			await refreshSource(store.kimi, [join(kimiDir, "sessions"), kimiDesktopDir], jsonl, scanKimiFile);
			await refreshSource(
				store.mavis,
				[dirs?.mavisDir ?? join(homedir(), ".mavis", "v2", "sessions")],
				jsonl,
				scanMavisFile,
			);
			await refreshSource(
				store.reasonix,
				[
					dirs?.reasonixDir ??
						join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "reasonix", "projects"),
				],
				(name) => name.endsWith("telemetry.json"),
				scanReasonixTelemetryFile,
			);
			const extensionHosts = dirs?.extensionHosts ?? [
				join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User", "globalStorage"),
				join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "User", "globalStorage"),
			];
			await refreshSource(
				store.roo,
				extensionTasksRoots(extensionHosts, ["rooveterinaryinc.roo-cline"]),
				(name) => name === "history_item.json",
				scanRooHistoryFile,
			);
			await refreshSource(
				store.cline,
				extensionTasksRoots(extensionHosts, ["saoudrizwan.claude-dev"]),
				(name) => name === "ui_messages.json",
				scanClineUiFile,
			);
			await refreshSource(
				store.workbuddy,
				[dirs?.workbuddyDir ?? join(homedir(), ".workbuddy", "projects")],
				jsonl,
				scanWorkbuddyFile,
			);
			await refreshSource(
				store.dsh,
				[dirs?.dshDir ?? join(homedir(), ".dsh", "sessions")],
				(name) => name.endsWith(".zstd"),
				scanDshFile,
			);
			await refreshSource(
				store.cursor,
				[dirs?.cursorSessionsDir ?? join(homedir(), ".cursor", "acp-sessions")],
				(name) => name === "store.db",
				scanCursorEstimateFile,
			);
			// writeStore 统一移到 return 前：SQLite 快照（aggregates）在 collect 之后才产生

			// owl / pi 是两个独立 agent，各自一行，互不合并（目录迁移叙事不成立，避免混计）。
			const owlUsage = await host.collectUsageStats({ days: "all" }, dirs?.owl);
			const piSessionsDir = dirs?.piSessions?.sessionsDir ?? join(homedir(), ".pi", "agent", "sessions");
			const piUsage = existsSync(piSessionsDir)
				? await host.collectUsageStats(
						{ days: "all" },
						dirs?.piSessions ?? {
							sessionsDir: piSessionsDir,
							storePath: join(host.agentDir, "usage-stats-pi.json"),
						},
					)
				: undefined;
			const piByModel = (piUsage?.byModel ?? [])
				.filter((model) => model.key !== "Tools/summaries" && model.totalTokens > 0)
				.map((model) => ({ key: model.key, totalTokens: model.totalTokens }))
				.sort((a, b) => b.totalTokens - a.totalTokens);
			const piLastDay = [...(piUsage?.byDay ?? [])].reverse().find((day) => day.totalTokens > 0);

			const claudeFold = foldFiles(store.claude);
			const claudeCost = claudeMeasuredCost(dirs?.claudeCostsFile ?? join(claudeDir, "metrics", "costs.jsonl"));
			const codexFold = foldFiles(store.codex);
			const kimiFold = foldFiles(store.kimi);
			const rooFold = foldFiles(store.roo);
			const clineFold = foldFiles(store.cline);
			const workbuddyFold = foldFiles(store.workbuddy);
			const dshFold = foldFiles(store.dsh);
			const mavisFold = foldFiles(store.mavis);
			const reasonixFold = foldFiles(store.reasonix);
			const cursorFold = foldFiles(store.cursor);
			const opencode = withAggregateFallback(
				"opencode",
				await collectSessionAggregateDb(dirs?.opencodeDb ?? join(opencodeDir, "opencode.db")),
				store,
			);
			const kilo = withAggregateFallback(
				"kilo",
				await collectSessionAggregateDb(dirs?.kiloDb ?? join(homedir(), ".local", "share", "kilo", "kilo.db")),
				store,
			);
			const qoder = withAggregateFallback(
				"qoder",
				await collectQoder(
					dirs?.qoderDb ??
						join(
							process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
							"Qoder",
							"SharedClientCache",
							"cache",
							"db",
							"local.db",
						),
				),
				store,
			);
			const copilot = withAggregateFallback(
				"copilot",
				await collectCopilot(dirs?.copilotDb ?? join(homedir(), ".copilot", "session-store.db")),
				store,
			);
			const mimo = withAggregateFallback(
				"mimo",
				await collectSessionAggregateDb(
					dirs?.mimoDb ?? join(homedir(), ".local", "share", "mimocode", "mimocode.db"),
				),
				store,
			);
			const zcode = withAggregateFallback(
				"zcode",
				await collectZcode(dirs?.zcodeDb ?? join(homedir(), ".zcode", "cli", "db", "db.sqlite")),
				store,
			);
			const zcodeDir = join(homedir(), ".zcode", "cli");

			const geminiRoot = join(geminiDir, "tmp");
			const geminiCount = await geminiSessions(geminiDir);

			const agents: CareerAgentUsage[] = [
				{
					id: "owl",
					name: "owl",
					status: "ok",
					root: "~/.owl/agent/Owl-history",
					sessions: owlUsage.sessionCount,
					...(owlUsage.firstRecordedAt ? { firstAt: owlUsage.firstRecordedAt } : {}),
					...(owlUsage.byDay.filter((day) => day.totalTokens > 0).length > 0
						? {
								lastAt: [...owlUsage.byDay].reverse().find((day) => day.totalTokens > 0)!.date,
							}
						: {}),
					totals: {
						input: owlUsage.totals.input,
						output: owlUsage.totals.output,
						cacheRead: owlUsage.totals.cacheRead,
						cacheWrite: owlUsage.totals.cacheWrite,
						reasoning: owlUsage.totals.reasoning,
						totalTokens: owlUsage.totals.totalTokens,
						cost: owlUsage.totals.cost,
					},
					byDay: owlUsage.byDay
						.filter((day) => day.totalTokens > 0)
						.map((day) => ({ date: day.date, totalTokens: day.totalTokens })),
					byModel: owlUsage.byModel
						.filter((model) => model.key !== "Tools/summaries" && model.totalTokens > 0)
						.map((model) => ({ key: model.key, totalTokens: model.totalTokens }))
						.sort((a, b) => b.totalTokens - a.totalTokens),
				},
				{
					id: "zcode",
					name: "ZCode",
					...usageRow(
						zcode,
						existsSync(zcodeDir),
						"~/.zcode/cli",
						"本地 SQLite 无法读取（被占用或运行时不支持 node:sqlite）",
					),
				},
				...(piUsage
					? [
							{
								id: "pi",
								name: "pi",
								status: piUsage.sessionCount > 0 ? ("ok" as const) : ("nodata" as const),
								...(piUsage.sessionCount > 0 ? {} : { note: "本地会话目录存在，但其中没有用量记录" }),
								root: "~/.pi/agent/sessions",
								sessions: piUsage.sessionCount,
								...(piUsage.firstRecordedAt ? { firstAt: piUsage.firstRecordedAt } : {}),
								...(piLastDay ? { lastAt: piLastDay.date } : {}),
								totals: {
									input: piUsage.totals.input,
									output: piUsage.totals.output,
									cacheRead: piUsage.totals.cacheRead,
									cacheWrite: piUsage.totals.cacheWrite,
									reasoning: piUsage.totals.reasoning,
									totalTokens: piUsage.totals.totalTokens,
									cost: piUsage.totals.cost,
								},
								byDay: piUsage.byDay
									.filter((day) => day.totalTokens > 0)
									.map((day) => ({ date: day.date, totalTokens: day.totalTokens })),
								byModel: piByModel,
							},
						]
					: []),
				{
					id: "claude",
					name: "Claude",
					status: statusOf(join(claudeDir, "projects")),
					note: "桌面端与 CLI 同源（会话都在 ~/.claude）；claude.ai 聊天的用量在服务端，本地无文件",
					root: "~/.claude/projects",
					sessions: claudeFold.sessions,
					...(claudeFold.firstAt ? { firstAt: claudeFold.firstAt } : {}),
					...(claudeFold.lastAt ? { lastAt: claudeFold.lastAt } : {}),
					totals: { ...claudeFold.totals, cost: claudeCost?.cost ?? 0 },
					byDay: bucketToTokens(claudeFold.byDay),
					byModel: modelsToRows(claudeFold.byModel),
				},
				{
					id: "codex",
					name: "Codex CLI",
					status: statusOf(join(codexDir, "sessions")),
					note: "按全部 rollout 的逐请求增量统计（免疫 resume 重置）；官方账户数还含 Codex 云端任务等无本地文件的用量",
					root: "~/.codex/sessions",
					sessions: codexFold.sessions,
					...(codexFold.firstAt ? { firstAt: codexFold.firstAt } : {}),
					...(codexFold.lastAt ? { lastAt: codexFold.lastAt } : {}),
					totals: { ...codexFold.totals, cost: 0 },
					byDay: bucketToTokens(codexFold.byDay),
					byModel: modelsToRows(codexFold.byModel),
				},
				{
					id: "kimi",
					name: "Kimi CLI",
					status:
						kimiFold.sessions > 0
							? "ok"
							: statusOf(join(kimiDir, "sessions")) === "ok"
								? "nodata"
								: "unavailable",
					note: kimiFold.sessions > 0 ? undefined : "本地 sessions 目录存在，但 wire 记录里没有用量",
					root: "~/.kimi-code/sessions",
					sessions: kimiFold.sessions,
					...(kimiFold.firstAt ? { firstAt: kimiFold.firstAt } : {}),
					...(kimiFold.lastAt ? { lastAt: kimiFold.lastAt } : {}),
					totals: { ...kimiFold.totals, cost: 0 },
					byDay: bucketToTokens(kimiFold.byDay),
					byModel: modelsToRows(kimiFold.byModel),
				},
				{
					id: "opencode",
					name: "OpenCode",
					...usageRow(
						opencode,
						existsSync(opencodeDir),
						"~/.local/share/opencode",
						"本地 SQLite 无法读取（被占用或运行时不支持 node:sqlite）",
					),
				},
				{
					id: "kilo",
					name: "Kilo Code",
					...usageRow(
						kilo,
						existsSync(join(homedir(), ".local", "share", "kilo")),
						"~/.local/share/kilo",
						"本地 SQLite 无法读取（被占用或运行时不支持 node:sqlite）",
					),
				},
				{
					id: "qoder",
					name: "Qoder",
					...usageRow(
						qoder,
						existsSync(join(process.env.APPDATA ?? "", "Qoder")),
						"%APPDATA%/Qoder",
						"本地 SQLite 无法读取（被占用或运行时不支持 node:sqlite）",
					),
				},
				{
					id: "copilot",
					name: "GitHub Copilot",
					...usageRow(
						copilot,
						existsSync(join(homedir(), ".copilot")),
						"~/.copilot",
						"本地 SQLite 无法读取（被占用或运行时不支持 node:sqlite）",
					),
				},
				{
					id: "roo",
					name: "Roo Code",
					status:
						rooFold.sessions > 0
							? "ok"
							: extensionTasksRoots(extensionHosts, ["rooveterinaryinc.roo-cline"]).length > 0
								? "nodata"
								: "unavailable",
					...(rooFold.sessions > 0 ? {} : { note: "本地任务目录存在，但 history_item 里没有用量字段" }),
					root: "%APPDATA%/*/globalStorage/rooveterinaryinc.roo-cline",
					sessions: rooFold.sessions,
					...(rooFold.firstAt ? { firstAt: rooFold.firstAt } : {}),
					...(rooFold.lastAt ? { lastAt: rooFold.lastAt } : {}),
					totals: { ...rooFold.totals, cost: 0 },
					byDay: bucketToTokens(rooFold.byDay),
					byModel: modelsToRows(rooFold.byModel),
				},
				{
					id: "cline",
					name: "Cline",
					status:
						clineFold.sessions > 0
							? "ok"
							: extensionTasksRoots(extensionHosts, ["saoudrizwan.claude-dev"]).length > 0
								? "nodata"
								: "unavailable",
					...(clineFold.sessions > 0 ? {} : { note: "本地任务目录存在，但会话里没有用量记录" }),
					root: "%APPDATA%/*/globalStorage/saoudrizwan.claude-dev",
					sessions: clineFold.sessions,
					...(clineFold.firstAt ? { firstAt: clineFold.firstAt } : {}),
					...(clineFold.lastAt ? { lastAt: clineFold.lastAt } : {}),
					totals: { ...clineFold.totals, cost: 0 },
					byDay: bucketToTokens(clineFold.byDay),
					byModel: modelsToRows(clineFold.byModel),
				},
				{
					id: "workbuddy",
					name: "WorkBuddy",
					status:
						workbuddyFold.sessions > 0
							? "ok"
							: existsSync(join(homedir(), ".workbuddy", "projects"))
								? "nodata"
								: "unavailable",
					...(workbuddyFold.sessions > 0 ? {} : { note: "本地会话目录存在，但其中没有 token 用量记录" }),
					root: "~/.workbuddy/projects",
					sessions: workbuddyFold.sessions,
					...(workbuddyFold.firstAt ? { firstAt: workbuddyFold.firstAt } : {}),
					...(workbuddyFold.lastAt ? { lastAt: workbuddyFold.lastAt } : {}),
					totals: { ...workbuddyFold.totals, cost: 0 },
					byDay: bucketToTokens(workbuddyFold.byDay),
					byModel: modelsToRows(workbuddyFold.byModel),
				},
				{
					id: "mimo",
					name: "MimoCode",
					...usageRow(
						mimo,
						existsSync(join(homedir(), ".local", "share", "mimocode")),
						"~/.local/share/mimocode",
						"本地 SQLite 无法读取（被占用或运行时不支持 node:sqlite）",
					),
				},
				{
					id: "dsh",
					name: "DeepSeek Harness",
					status:
						dshFold.sessions > 0
							? "ok"
							: existsSync(join(homedir(), ".dsh", "sessions"))
								? "nodata"
								: "unavailable",
					...(dshFold.sessions > 0 ? {} : { note: "本地会话目录存在，但其中没有 token 用量记录" }),
					root: "~/.dsh/sessions",
					sessions: dshFold.sessions,
					...(dshFold.firstAt ? { firstAt: dshFold.firstAt } : {}),
					...(dshFold.lastAt ? { lastAt: dshFold.lastAt } : {}),
					totals: { ...dshFold.totals, cost: 0 },
					byDay: bucketToTokens(dshFold.byDay),
					byModel: modelsToRows(dshFold.byModel),
				},
				{
					id: "mavis",
					name: "Mavis（MiniMax Code）",
					status:
						mavisFold.sessions > 0
							? "ok"
							: existsSync(join(homedir(), ".mavis", "v2", "sessions"))
								? "nodata"
								: "unavailable",
					...(mavisFold.sessions > 0 ? {} : { note: "本地会话目录存在，但其中没有 token 用量记录" }),
					root: "~/.mavis/v2/sessions",
					sessions: mavisFold.sessions,
					...(mavisFold.firstAt ? { firstAt: mavisFold.firstAt } : {}),
					...(mavisFold.lastAt ? { lastAt: mavisFold.lastAt } : {}),
					totals: { ...mavisFold.totals, cost: mavisFold.cost },
					byDay: bucketToTokens(mavisFold.byDay),
					byModel: modelsToRows(mavisFold.byModel),
				},
				{
					id: "reasonix",
					name: "Reasonix",
					status:
						reasonixFold.sessions > 0
							? "ok"
							: existsSync(join(process.env.APPDATA ?? "", "reasonix", "projects"))
								? "nodata"
								: "unavailable",
					...(reasonixFold.sessions > 0 ? {} : { note: "本地遥测目录存在，但其中没有 token 用量记录" }),
					root: "%APPDATA%/reasonix/projects",
					sessions: reasonixFold.sessions,
					...(reasonixFold.firstAt ? { firstAt: reasonixFold.firstAt } : {}),
					...(reasonixFold.lastAt ? { lastAt: reasonixFold.lastAt } : {}),
					totals: { ...reasonixFold.totals, cost: reasonixFold.cost },
					byDay: bucketToTokens(reasonixFold.byDay),
					byModel: modelsToRows(reasonixFold.byModel),
				},
				{
					id: "gemini",
					name: "Gemini CLI",
					status: existsSync(geminiRoot) ? "nodata" : "unavailable",
					note: existsSync(geminiRoot) ? "本地记录不含 token 用量，只能统计会话数" : undefined,
					root: "~/.gemini/tmp",
					sessions: geminiCount,
					totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 },
					byDay: [],
					byModel: [],
				},
				{
					id: "cursor",
					name: "Cursor",
					status:
						cursorFold.sessions > 0
							? "ok"
							: existsSync(join(homedir(), ".cursor", "acp-sessions"))
								? "nodata"
								: "unavailable",
					note:
						cursorFold.sessions > 0
							? "官方用量只在服务端；此行按本地会话历史内容估算（每轮上下文重放，量级参考）"
							: "IDE 与 CLI 两端的本地各库已逐个核验，均不记录 token 用量（用量在服务端）",
					root: "~/.cursor/acp-sessions",
					sessions: cursorFold.sessions,
					...(cursorFold.firstAt ? { firstAt: cursorFold.firstAt } : {}),
					...(cursorFold.lastAt ? { lastAt: cursorFold.lastAt } : {}),
					totals: { ...cursorFold.totals, cost: 0 },
					byDay: bucketToTokens(cursorFold.byDay),
					byModel: modelsToRows(cursorFold.byModel),
				},
				...detectedRows(detectRoot),
			];

			// aggregates 快照与 JSONL 增量统一落盘（career.get 每次全量刷新快照）
			writeStore(storePath, store, host.files);
			return { generatedAt: new Date().toISOString(), agents };
		});
	chain = run;
	return run;
}
