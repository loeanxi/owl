/**
 * owl 跨会话记忆抽取流水线（简化版 Codex memories Phase 1）。
 *
 * 会话启动时异步扫描同 cwd 的历史会话（跳过已抽取与当前会话），把最近几个未处理的
 * 会话喂给当前模型做一次低开销抽取：只保留值得跨会话记住的稳定事实——项目约定、
 * 用户偏好、环境特点、重要决策——丢弃一次性任务细节。产出写入 memory store，
 * 全程不阻塞交互。
 *
 * 无凭据/无模型时静默跳过；失败只打日志，绝不影响会话。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../model-registry.ts";
import { getDefaultSessionDirPath } from "../session-manager.ts";
import {
	appendMemoryEntries,
	applyMemoryMerges,
	markExtracted,
	readExtractedMarkers,
	readMemoryEntries,
	type MemoryMerge,
	type OwlMemoryEntry,
} from "./store.ts";

/** 每次会话启动最多抽取几个历史会话，防止冷启动风暴。 */
const MAX_SESSIONS_PER_RUN = 3;
/** 喂给抽取模型的会话内容上限（字符）。 */
const MAX_TRANSCRIPT_CHARS = 30_000;
/** 少于这么多条用户消息的会话不值得抽取。 */
const MIN_USER_MESSAGES = 2;

/** 会话级互斥：同一 agentDir 同时只跑一个抽取流水线。 */
const inFlight = new Set<string>();

export interface ExtractMemoriesOptions {
	agentDir: string;
	cwd: string;
	model: Model<any>;
	modelRegistry: Pick<ModelRegistry, "streamSimple">;
	/** 当前会话文件，跳过不抽。 */
	currentSessionFile?: string;
	log?: (message: string) => void;
}

/** 追加同 cwd 未抽取的历史会话记忆。返回本次新增条数。 */
export async function extractMemoriesFromPreviousSessions(
	options: ExtractMemoriesOptions,
): Promise<{ sessionsProcessed: number; memoriesAdded: number }> {
	const { agentDir, cwd, model, modelRegistry, currentSessionFile, log } = options;
	if (inFlight.has(agentDir)) return { sessionsProcessed: 0, memoriesAdded: 0 };
	inFlight.add(agentDir);
	try {
		const candidates = listUnextractedSessions(agentDir, cwd, currentSessionFile);
		if (candidates.length === 0) return { sessionsProcessed: 0, memoriesAdded: 0 };
		const batch = candidates.slice(0, MAX_SESSIONS_PER_RUN);
		let memoriesAdded = 0;
		for (const sessionFile of batch) {
			try {
				const added = await extractFromSessionFile(agentDir, cwd, sessionFile, model, modelRegistry, log);
				markExtracted(agentDir, [sessionFile]);
				memoriesAdded += added.length;
			} catch (error) {
				// 单个会话失败不阻断批次；标记跳过避免反复踩同一个坑
				markExtracted(agentDir, [sessionFile]);
				log?.(
					`memory extract failed for ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return { sessionsProcessed: batch.length, memoriesAdded };
	} finally {
		inFlight.delete(agentDir);
	}
}

function listUnextractedSessions(agentDir: string, cwd: string, currentSessionFile?: string): string[] {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	let files: string[];
	try {
		files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const markers = readExtractedMarkers(agentDir);
	return files
		.map((file) => join(sessionDir, file))
		.filter((path) => path !== currentSessionFile && !markers[path])
		.sort((a, b) => {
			try {
				return statSync(b).mtimeMs - statSync(a).mtimeMs;
			} catch {
				return 0;
			}
		});
}

interface SessionTranscript {
	userTexts: string[];
	transcript: string;
}

/** 解析会话 JSONL，抽出 user/assistant 文本流。 */
export function parseSessionTranscript(sessionFilePath: string, maxChars = MAX_TRANSCRIPT_CHARS): SessionTranscript {
	let raw: string;
	try {
		raw = readFileSync(sessionFilePath, "utf-8");
	} catch {
		return { userTexts: [], transcript: "" };
	}
	const userTexts: string[] = [];
	const lines: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(entry.message.content).trim();
		if (!text) continue;
		if (role === "user") userTexts.push(text);
		lines.push(`${role === "user" ? "用户" : "助手"}: ${text}`);
	}
	const currentLines: string[] = [];
	let used = 0;
	// 从头保留，超限截断（记忆更依赖开头的需求陈述，结尾的收尾价值次之）
	for (const line of lines) {
		const size = Buffer.byteLength(line, "utf-8");
		if (used + size > maxChars) {
			currentLines.push(`…（其余 ${lines.length - currentLines.length} 条消息截断）`);
			break;
		}
		currentLines.push(line);
		used += size;
	}
	return { userTexts, transcript: currentLines.join("\n\n") };
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/**
 * 脱敏模式表（借鉴 hindsight Memory Defense 的思路，本地正则版）。
 * 命中即替换为 [REDACTED:*] 占位，宁可误杀不可漏网。
 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
	{ name: "openai_key", pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g },
	{ name: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
	{ name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
	{ name: "github_fine_grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	{ name: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
	{ name: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g },
	{ name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ name: "stripe_key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
	{ name: "stripe_webhook", pattern: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
	{ name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
	{ name: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
	{
		name: "database_url",
		pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"]*:[^\s'"@/]*@[^\s'"]+/g,
	},
	{ name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
	{
		name: "key_value_pair",
		pattern:
			/\b(api[_-]?key|secret(?:[_-]?(?:key|token))?|access[_-]?token|password|passwd|token)\b\s*[:=]\s*["']?[A-Za-z0-9._+/=-]{16,}["']?/gi,
	},
	{ name: "wecom_webhook", pattern: /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[0-9a-fA-F-]+/g },
	{ name: "dingtalk_webhook", pattern: /oapi\.dingtalk\.com\/robot\/send\?access_token=[0-9a-fA-F]+/g },
	{ name: "feishu_webhook", pattern: /open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+/g },
	{ name: "telegram_bot", pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g },
	{ name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/** 入库前脱敏：常见密钥/PII 形态替换为占位符，避免会话里的 secret 进入记忆文件。 */
export function redactSecrets(text: string): string {
	let redacted = text;
	for (const { name, pattern } of SECRET_PATTERNS) {
		redacted = redacted.replace(pattern, (match) => {
			// 结构化赋值（api_key=xxx）保留键名，只抹值
			const separator = match.search(/[:=]\s*/);
			if (name === "key_value_pair" && separator !== -1) {
				return `${match.slice(0, separator)}= [REDACTED:${name}]`;
			}
			return `[REDACTED:${name}]`;
		});
	}
	return redacted;
}

const EXTRACTION_SYSTEM_PROMPT = `你是一个记忆抽取器。输入是一段编程会话记录（用户/助手对话）。
你的任务：提取值得跨会话长期记住的"稳定记忆"，输出 JSON。

只提取以下几类：
- 用户表达的持久偏好（语言、沟通风格、代码习惯、工具选择）
- 项目/环境的稳定事实（构建命令、目录结构约定、部署方式、本机特殊性）
- 重要的长期决策（选型、架构方向、命名约定）

不要提取：
- 一次性任务细节、临时调试过程、具体 bug 修复内容
- 会话里文件的具体内容或大段代码
- 任何密钥、密码、token（输入已脱敏，仍不要复述）
- 没有明确证据的推测

输出格式（仅输出 JSON，不要 markdown 代码块、不要解释）：
{"memories":[{"content":"一条独立的记忆，第三人称、具体、简短（不超过 80 字）"}]}

没有值得记的就输出：{"memories":[]}`;

/** 对单个会话文件做抽取，返回新增的记忆条目。 */
async function extractFromSessionFile(
	agentDir: string,
	cwd: string,
	sessionFilePath: string,
	model: Model<any>,
	modelRegistry: Pick<ModelRegistry, "streamSimple">,
	log?: (message: string) => void,
): Promise<OwlMemoryEntry[]> {
	const { userTexts, transcript } = parseSessionTranscript(sessionFilePath);
	if (userTexts.length < MIN_USER_MESSAGES || !transcript) return [];
	const response = await modelRegistry
		.streamSimple(
			model,
			{
				systemPrompt: EXTRACTION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: [{ type: "text", text: `会话记录（项目目录：${cwd}）：\n\n${redactSecrets(transcript)}` }],
					},
				],
			},
			{ maxTokens: 1500, maxRetries: 1 },
		)
		.result();
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		log?.(`memory extraction stream ended with ${response.stopReason}`);
		return [];
	}
	const text = messageText(response.content);
	const memories = parseMemoryPayload(text);
	if (memories.length === 0) return [];
	return appendMemoryEntries(
		agentDir,
		memories.map((content) => ({
			content,
			sourceSession: sessionFilePath,
			sourceCwd: cwd,
		})),
	);
}

/** 三级降级解析：严格 JSON → 首个 {...} 子串 → 放弃。 */
export function parseMemoryPayload(text: string): string[] {
	const attempt = (raw: string): string[] | undefined => {
		try {
			const parsed = JSON.parse(raw) as { memories?: unknown };
			if (!Array.isArray(parsed.memories)) return undefined;
			return parsed.memories
				.filter((entry) => typeof entry === "string" || (entry && typeof (entry as any).content === "string"))
				.map((entry) => (typeof entry === "string" ? entry : (entry as { content: string }).content).trim())
				.filter(Boolean)
				.slice(0, 10);
		} catch {
			return undefined;
		}
	};
	const direct = attempt(text);
	if (direct) return direct;
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start !== -1 && end > start) {
		const inner = attempt(text.slice(start, end + 1));
		if (inner) return inner;
	}
	return [];
}
