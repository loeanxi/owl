/**
 * 「上下文洞察」注册表 —— owl-context 插件与桌面桥的共享接缝。
 *
 * owl-context 以普通插件形式加载（settings plugins），在每次 LLM 请求组装点
 * （context_with_system 事件）把六类构成（系统提示/注入/用户/回复/工具结果/
 * 工具 schema）的 token 估算写入这里，同时留存该压缩纪元内最新的 transcript
 * 快照（上下文浏览器按每步的消息数取前缀还原当时的构成与原文）。流式事件、
 * 工具执行与 agent 起止补齐耗时、文件活动与上下文事件。桌面桥经 context.get /
 * context.detail / context.item 取数。非桌面模式里数据照记不误，只是没人读，
 * 封顶后自然淘汰。
 *
 * 单例语义与 question-channel 相同：桥与插件运行在同一进程，插件经
 * @owl/owl-coding-agent 别名拿到的是同一份模块实例，这里就是两边共享的接缝。
 *
 * 估算口径与 core/compaction 的 estimateTokens 一致：CJK ≈ 1 token/字、其余
 * chars/4，图片按 4800 字符折算——只做构成占比参考。实测口径（provider 计费）
 * 走 usage：下一轮请求组装时补填上一行，另外 message_end 一到就当场回填最后一行，
 * 单轮会话也能立刻看到实测值。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentTools, type TranscriptMessages } from "@earendil-works/pi-ai";

import { weightedTextChars } from "./compaction/compaction.ts";
import type { ProjectedSessionEntry } from "./session-manager.ts";

// ---------------------------------------------------------------------------
// wire 类型（桌面桥 protocol.ts 原样转发给 UI）
// ---------------------------------------------------------------------------

/** 一次 LLM 请求的上下文构成（token 估算）。 */
export interface ContextComposition {
	/** 基础系统提示（leading system message 的 content）。 */
	system: number;
	/** 注入内容：leading message 的命名 sections + 其后的追加系统消息。 */
	inject: number;
	/** 用户消息（文本 + 图片折算）。 */
	user: number;
	/** 模型回复（文本 + thinking + 工具调用参数）。 */
	assistant: number;
	/** 工具结果。 */
	toolResult: number;
	/** 声明给模型的工具 schema（name + description + parameters）。 */
	toolSchemas: number;
	/** 其余角色（bashExecution / 摘要等自定义消息）。 */
	other: number;
}

export type ContextCategory = keyof ContextComposition;

/** 模型读取上下文的次序：系统提示 → 工具定义 → 按时间排列的消息。 */
export const CONTEXT_CATEGORIES: readonly ContextCategory[] = [
	"system",
	"toolSchemas",
	"user",
	"inject",
	"assistant",
	"toolResult",
	"other",
];

export interface ContextUsageInfo {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** provider 报告的总 token（有的话优先用它，与 core 的 calculateContextTokens 同口径）。 */
	totalTokens?: number;
	/** 按模型报价折算的本次费用（美元）。 */
	cost?: number;
}

/** 实测上下文占用：优先 totalTokens，否则四项之和（对齐 core 的 calculateContextTokens）。 */
export function measuredContextTokens(usage: ContextUsageInfo): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** 单个工具的声明来源（UI 来源芯片用）。 */
export interface ContextToolRef {
	name: string;
	/** namespace 名（如 mcp_playwright）或 sourceInfo.source（builtin / 包名）。 */
	source: string;
}

/** 一步请求的耗时拆分（毫秒）。流式增量之间的间隔归给后一个增量的种类。 */
export interface ContextTiming {
	/** 请求发出 → 首个内容增量。 */
	ttft?: number;
	thinking: number;
	answer: number;
	toolArgs: number;
	/** 请求发出 → 响应结束。 */
	model?: number;
}

export interface ContextBriefItem {
	/** 工具名 / 来源标签。 */
	chip?: string;
	text: string;
	error?: boolean;
}

/** 步骤简报：本轮用户消息、上一步回复后新进入的内容、本步的回复。 */
export interface ContextBrief {
	user?: string;
	inbound: ContextBriefItem[];
	response: ContextBriefItem[];
}

/** 一次 LLM 请求的一行趋势数据。 */
export interface ContextRequestRow {
	seq: number;
	ts: number;
	model?: { provider: string; id: string };
	composition: ContextComposition;
	/** 组成之和（估算，与 provider 计费的 usage.input 未必一致）。 */
	totalTokens: number;
	/** 该请求实际发给 provider 后的计费数字（响应到达后的下一轮补填）。 */
	usage?: ContextUsageInfo;
	contextWindow?: number;
	/** 第几轮：一条用户输入开启一轮。 */
	turn: number;
	/** 轮内第几步：一次 LLM 请求一步。 */
	step: number;
	/** 请求时 transcript 的消息数（浏览器按前缀还原该步）。 */
	messageCount?: number;
	/** 压缩纪元：每次压缩 +1，不同纪元的前缀不可比。 */
	epoch?: number;
	timing?: ContextTiming;
	brief?: ContextBrief;
	/** 本步响应发起的工具调用数。 */
	toolCalls?: number;
}

export type ContextEventKind = "inject" | "compact" | "prune" | "model" | "mode";

/** 上下文生命周期事件。 */
export interface ContextEventRow {
	ts: number;
	kind: ContextEventKind;
	/** 人类可读描述。 */
	label: string;
	/** 压缩触发原因（manual / threshold / overflow）。 */
	reason?: string;
	/** 生效于哪一步请求；两次请求之间发生的事件在下一次请求组装时落定。 */
	seq?: number;
	turn?: number;
	step?: number;
	/** 本事件带来的上下文 token 变化（估算）；压缩为负。 */
	delta?: number;
	/** 注入事件在上下文浏览器中的条目 key。 */
	itemKey?: string;
}

export type ContextFileKind = "read" | "write" | "search" | "image";

/** 一次文件操作（来自 read/write/edit/grep/find/ls 工具调用）。 */
export interface ContextFileOp {
	path: string;
	kind: ContextFileKind;
	tool: string;
	/** 发起该调用的那一步请求。 */
	seq: number;
	ts: number;
	ok: boolean;
	/** edit/write 按参数估算的行数变化。 */
	added?: number;
	removed?: number;
	/** read 按 offset/limit 估算的行区间。 */
	lines?: [number, number];
	pattern?: string;
	callId?: string;
}

/** 会话累计耗时（毫秒）。 */
export interface ContextTimingTotals {
	/** agent 运行（agent_start → agent_end）累计时长。 */
	activeMs: number;
	toolRuns: number;
	toolMs: number;
	/** agent 正在运行时的起点（UI 叠加 now - activeSince）。 */
	activeSince?: number;
}

export interface ContextInsightData {
	requests: ContextRequestRow[];
	events: ContextEventRow[];
	tools: ContextToolRef[];
	files: ContextFileOp[];
	timing: ContextTimingTotals;
	/** 压缩纪元 → 该纪元内最近一次请求的 transcript（不上 wire）。 */
	snapshots: Map<number, AgentMessage[]>;
	/** 最近一次请求之后进入上下文的消息（「当前 · 下一次请求」= 快照 + 尾巴）。 */
	liveTail: AgentMessage[];
	epoch: number;
}

export interface ContextInsightState extends ContextInsightData {
	sessionId: string;
	cwd: string;
	/** 最近一次活动时间（LRU 淘汰与 cwd 匹配排序用）。 */
	lastTs: number;
}

/** context.get 的 wire 视图（不含 transcript 快照）。 */
export interface ContextInsightWire {
	requests: ContextRequestRow[];
	events: ContextEventRow[];
	tools: ContextToolRef[];
	files: ContextFileOp[];
	timing: ContextTimingTotals;
	/** 「当前」视图的版本号：变化时 UI 重新拉取浏览器明细。 */
	liveVersion: string;
}

export interface ContextDetailItem {
	/** sys / sec:<name> / tool:<name> / m<transcript 下标>。 */
	key: string;
	label: string;
	chip?: string;
	tokens: number;
	ts?: number;
	error?: boolean;
	/** 助手消息的内容种类。 */
	kinds?: Array<"think" | "tool" | "answer">;
	/** 首次随哪一步进入上下文；pending = 尚未发出的下一步。 */
	at?: { turn: number; step: number; pending?: boolean };
	/** 工具定义：当前范围内被调用并返回结果的次数。 */
	hits?: number;
	callId?: string;
	images?: number;
}

export interface ContextDetailCategory {
	key: ContextCategory;
	tokens: number;
	items: ContextDetailItem[];
}

export interface ContextDetailResult {
	/** 缺省 = 当前（下一次请求）。 */
	seq?: number;
	/** 没有 transcript 快照（如压缩前过早的步骤）时为 false。 */
	available: boolean;
	/** 快照短于该步的消息数，构成只是近似。 */
	approximate?: boolean;
	turn?: number;
	step?: number;
	categories: ContextDetailCategory[];
	/** 对比基线（上一步）每类的条目数与 token。 */
	baseline?: Partial<Record<ContextCategory, { count: number; tokens: number }>>;
}

export interface ContextItemContent {
	title: string;
	text?: string;
	thinking?: string;
	/** 助手消息发起的工具调用。 */
	calls?: Array<{ name: string; args: unknown }>;
	/** 工具结果对应的那次调用。 */
	call?: { name: string; args: unknown; ok: boolean };
	tool?: { description: string; parameters: unknown; source?: string };
	images?: number;
	truncated?: boolean;
}

// ---------------------------------------------------------------------------
// 纯函数：分类与估算（core 单测直接覆盖）
// ---------------------------------------------------------------------------

const IMAGE_CHARS = 4800;

/**
 * 系统提示的基础 sections（buildSystemPromptSections 的固定产出）。owl 的系统
 * 提示几乎整体活在命名 sections 里（content 通常为空串），这些归「系统提示」；
 * 其余命名 sections（如 owl_memory 等扩展注入）归「注入内容」。
 */
const BASE_SYSTEM_SECTIONS = new Set([
	"preamble",
	"tools",
	"rules",
	"docs",
	"addendum",
	"project_context",
	"skills",
	"cwd",
]);

type ContentBlock = {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	id?: string;
	arguments?: unknown;
};

type LooseMessage = Record<string, any>;

function contentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as ContentBlock[];
	return [];
}

function blocksToChars(blocks: ContentBlock[]): number {
	let chars = 0;
	for (const block of blocks) {
		if (block.type === "text" && block.text) chars += weightedTextChars(block.text);
		else if (block.type === "image") chars += IMAGE_CHARS;
		else if (block.type === "thinking" && block.thinking) chars += weightedTextChars(block.thinking);
		else if (block.type === "toolCall") {
			chars += weightedTextChars((block.name ?? "") + JSON.stringify(block.arguments ?? {}));
		}
	}
	return chars;
}

const toTokens = (chars: number): number => Math.ceil(chars / 4);

/** 系统消息的 content + sections 字符数。 */
function systemMessageChars(message: { content?: unknown; sections?: unknown }): { base: number; sections: number } {
	const base = blocksToChars(contentBlocks(message.content));
	let sections = 0;
	if (message.sections && typeof message.sections === "object") {
		for (const value of Object.values(message.sections as Record<string, unknown>)) {
			if (typeof value === "string") sections += weightedTextChars(value);
		}
	}
	return { base, sections };
}

function otherMessageChars(message: LooseMessage): number {
	return (
		(typeof message?.command === "string" ? message.command.length : 0) +
		(typeof message?.output === "string" ? message.output.length : 0) +
		(typeof message?.summary === "string" ? message.summary.length : 0) +
		blocksToChars(contentBlocks(message?.content))
	);
}

/** 把一次请求的 transcript 按六类 + other 分类估算。永不抛错。 */
export function classifyRequestMessages(messages: readonly AgentMessage[]): ContextComposition {
	const composition: ContextComposition = {
		system: 0,
		inject: 0,
		user: 0,
		assistant: 0,
		toolResult: 0,
		toolSchemas: 0,
		other: 0,
	};
	let leadingSeen = false;
	for (const message of messages as ReadonlyArray<LooseMessage>) {
		switch (message?.role) {
			case "system": {
				const { base, sections } = systemMessageChars(message);
				if (!leadingSeen) {
					let baseSections = 0;
					let injectedSections = 0;
					if (message.sections && typeof message.sections === "object") {
						for (const [name, value] of Object.entries(message.sections as Record<string, unknown>)) {
							if (typeof value !== "string") continue;
							if (BASE_SYSTEM_SECTIONS.has(name)) baseSections += value.length;
							else injectedSections += value.length;
						}
					}
					composition.system += toTokens(base + baseSections);
					composition.inject += toTokens(injectedSections);
					leadingSeen = true;
				} else {
					composition.inject += toTokens(base + sections);
				}
				break;
			}
			case "user":
				composition.user += toTokens(blocksToChars(contentBlocks(message.content)));
				break;
			case "assistant":
				composition.assistant += toTokens(blocksToChars(contentBlocks(message.content)));
				break;
			case "toolResult":
				composition.toolResult += toTokens(blocksToChars(contentBlocks(message.content)));
				break;
			default:
				// bashExecution / branchSummary / compactionSummary 等自定义角色
				composition.other += toTokens(otherMessageChars(message));
		}
	}
	return composition;
}

export interface ToolDeclarationEstimate {
	/** 全部声明工具的 schema token 之和。 */
	total: number;
	refs: ContextToolRef[];
}

function toolSchemaChars(tool: { name: string; description: string; parameters: unknown }): number {
	return weightedTextChars(tool.name + tool.description + JSON.stringify(tool.parameters ?? {}));
}

/**
 * 估算最终 transcript 中的工具声明。注册表仅提供来源元数据；模型专用工具、
 * codemode 和执行提示增补均以 transcript 为准，与 provider 的工具状态回放一致。
 * 未传 transcript 时直接估算提供的声明列表。
 */
export function estimateToolDeclarations(
	tools: ReadonlyArray<{
		name: string;
		description: string;
		parameters: unknown;
		namespace?: { name?: string };
		sourceInfo?: { source?: string };
	}>,
	messages?: TranscriptMessages,
): ToolDeclarationEstimate {
	let chars = 0;
	const refs: ContextToolRef[] = [];
	const sourceByName = new Map(
		tools.map((tool) => [tool.name, tool.namespace?.name ?? tool.sourceInfo?.source ?? "builtin"]),
	);
	for (const tool of messages ? getCurrentTools(messages) : tools) {
		chars += toolSchemaChars(tool);
		refs.push({ name: tool.name, source: sourceByName.get(tool.name) ?? "transcript" });
	}
	return { total: toTokens(chars), refs };
}

// ---------------------------------------------------------------------------
// 纯函数：文本摘要、简报、文件操作
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
	return contentBlocks(content)
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text)
		.join("\n");
}

function countImages(content: unknown): number {
	return contentBlocks(content).filter((block) => block.type === "image").length;
}

function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const LABEL_ARG_KEYS = ["description", "path", "file_path", "command", "pattern", "query", "url", "prompt", "name"];

/** 一次工具调用的人类可读摘要：优先 description，其次路径/命令等主参数。 */
function callLabel(args: unknown): string {
	if (typeof args === "string") return oneLine(args);
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of LABEL_ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return oneLine(value);
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim()) return oneLine(value);
	}
	return "";
}

function userLabel(message: LooseMessage): string {
	const text = oneLine(textOf(message.content));
	if (text) return text;
	const images = countImages(message.content);
	return images > 0 ? `[图片 ×${images}]` : "(空消息)";
}

function systemLabel(message: LooseMessage): string {
	const names =
		message.sections && typeof message.sections === "object"
			? Object.entries(message.sections as Record<string, unknown>)
					.filter(([, value]) => typeof value === "string")
					.map(([name]) => name)
			: [];
	if (names.length > 0) return names.join(", ");
	return oneLine(textOf(message.content), 80) || "追加系统消息";
}

function foldNames(names: string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(" · ");
}

const BRIEF_MAX = 6;

/** 一条助手消息的回复摘要：工具调用 + 文本；只有思考时给思考摘要。 */
export function responseBriefOf(message: AgentMessage): ContextBriefItem[] {
	const items: ContextBriefItem[] = [];
	let text = "";
	let thinking = "";
	for (const block of contentBlocks((message as LooseMessage).content)) {
		if (block.type === "toolCall") items.push({ chip: block.name ?? "tool", text: callLabel(block.arguments) });
		else if (block.type === "text" && block.text) text += block.text;
		else if (block.type === "thinking" && block.thinking) thinking += block.thinking;
	}
	if (text.trim()) items.unshift({ text: oneLine(text) });
	if (items.length === 0 && thinking.trim()) items.push({ chip: "思考", text: oneLine(thinking) });
	return items.slice(0, BRIEF_MAX);
}

function toolCallsOf(message: AgentMessage): ContentBlock[] {
	return contentBlocks((message as LooseMessage).content).filter((block) => block.type === "toolCall");
}

/** 本步请求的简报：本轮用户消息 + 上一步回复之后新进入的内容（每轮第一步无新增）。 */
export function requestBriefOf(messages: readonly AgentMessage[], step: number): ContextBrief {
	const list = messages as ReadonlyArray<LooseMessage>;
	let user: string | undefined;
	for (let index = list.length - 1; index >= 0; index -= 1) {
		if (list[index]?.role === "user") {
			user = userLabel(list[index]);
			break;
		}
	}
	const inbound: ContextBriefItem[] = [];
	if (step > 1) {
		let lastAssistant = -1;
		for (let index = list.length - 1; index >= 0; index -= 1) {
			if (list[index]?.role === "assistant") {
				lastAssistant = index;
				break;
			}
		}
		const calls = new Map<string, ContentBlock>();
		if (lastAssistant >= 0) for (const call of toolCallsOf(messages[lastAssistant]!)) calls.set(call.id ?? "", call);
		for (const message of list.slice(lastAssistant + 1)) {
			if (inbound.length >= BRIEF_MAX) break;
			if (message.role === "toolResult") {
				const call = calls.get(message.toolCallId);
				inbound.push({
					chip: message.toolName ?? call?.name ?? "tool",
					text: callLabel(call?.arguments) || oneLine(textOf(message.content)),
					...(message.isError === true ? { error: true } : {}),
				});
			} else if (message.role === "system") {
				const { base, sections } = systemMessageChars(message);
				if (base + sections > 0) inbound.push({ chip: "注入", text: systemLabel(message) });
			} else if (message.role !== "user") {
				inbound.push({ chip: String(message.role ?? "other"), text: oneLine(otherText(message)) });
			}
		}
	}
	return { ...(user !== undefined ? { user } : {}), inbound, response: [] };
}

function otherText(message: LooseMessage): string {
	if (typeof message.summary === "string" && message.summary) return message.summary;
	const parts = [message.command, message.output].filter((part) => typeof part === "string" && part);
	if (parts.length > 0) return parts.join("\n");
	return textOf(message.content);
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i;

function lineCount(text: unknown): number {
	return typeof text === "string" && text.length > 0 ? text.split("\n").length : 0;
}

/** 从一次工具调用推出文件操作（未知工具回空数组）。 */
export function fileOpsOf(
	toolName: string,
	args: unknown,
): Array<Pick<ContextFileOp, "path" | "kind" | "tool" | "added" | "removed" | "lines" | "pattern">> {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const path = typeof record.path === "string" && record.path ? record.path : undefined;
	const pattern = typeof record.pattern === "string" ? record.pattern : undefined;
	switch (toolName) {
		case "read": {
			if (!path) return [];
			const offset = typeof record.offset === "number" ? record.offset : undefined;
			const limit = typeof record.limit === "number" ? record.limit : undefined;
			const start = offset ?? 1;
			return [
				{
					path,
					kind: IMAGE_EXT.test(path) ? "image" : "read",
					tool: toolName,
					...(offset !== undefined || limit !== undefined
						? { lines: [start, limit !== undefined ? start + limit - 1 : start] as [number, number] }
						: {}),
				},
			];
		}
		case "write":
			return path ? [{ path, kind: "write", tool: toolName, added: lineCount(record.content) }] : [];
		case "edit": {
			if (!path) return [];
			const edits = Array.isArray(record.edits) ? (record.edits as Array<Record<string, unknown>>) : [record];
			let added = 0;
			let removed = 0;
			for (const edit of edits) {
				added += lineCount(edit.newText);
				removed += lineCount(edit.oldText);
			}
			return [{ path, kind: "write", tool: toolName, added, removed }];
		}
		case "grep":
		case "find":
		case "ls":
			return [{ path: path ?? ".", kind: "search", tool: toolName, ...(pattern ? { pattern } : {}) }];
		default:
			return [];
	}
}

// ---------------------------------------------------------------------------
// 上下文浏览器：按 transcript 拆条目、取原文
// ---------------------------------------------------------------------------

type StampOf = (index: number) => ContextDetailItem["at"];

const TEXT_CAP = 120_000;

function capText(text: string): { text: string; truncated?: boolean } {
	return text.length > TEXT_CAP ? { text: text.slice(0, TEXT_CAP), truncated: true } : { text };
}

/** 把一份 transcript 拆成七类条目。tokens 与 classifyRequestMessages 同口径。 */
export function contextItemsOf(
	messages: readonly AgentMessage[],
	sources: ReadonlyMap<string, string> = new Map(),
	stampOf?: StampOf,
): ContextDetailCategory[] {
	const buckets: Record<ContextCategory, ContextDetailItem[]> = {
		system: [],
		inject: [],
		user: [],
		assistant: [],
		toolResult: [],
		toolSchemas: [],
		other: [],
	};
	let leadingSeen = false;
	const calls = new Map<string, ContentBlock>();
	const hits = new Map<string, number>();
	(messages as ReadonlyArray<LooseMessage>).forEach((message, index) => {
		const at = stampOf?.(index);
		const meta = {
			...(typeof message?.timestamp === "number" ? { ts: message.timestamp } : {}),
			...(at ? { at } : {}),
		};
		const key = `m${index}`;
		switch (message?.role) {
			case "system": {
				if (!leadingSeen) {
					leadingSeen = true;
					let baseChars = blocksToChars(contentBlocks(message.content));
					if (message.sections && typeof message.sections === "object") {
						for (const [name, value] of Object.entries(message.sections as Record<string, unknown>)) {
							if (typeof value !== "string") continue;
							if (BASE_SYSTEM_SECTIONS.has(name)) baseChars += value.length;
							else
								buckets.inject.push({
									key: `sec:${name}`,
									label: name,
									chip: "段落",
									tokens: toTokens(weightedTextChars(value)),
									...meta,
								});
						}
					}
					buckets.system.push({ key: "sys", label: "系统提示词", tokens: toTokens(baseChars), ...meta });
					return;
				}
				const { base, sections } = systemMessageChars(message);
				if (base + sections === 0) return;
				buckets.inject.push({
					key,
					label: systemLabel(message),
					chip: "指令",
					tokens: toTokens(base + sections),
					...meta,
				});
				return;
			}
			case "user": {
				const images = countImages(message.content);
				buckets.user.push({
					key,
					label: userLabel(message),
					tokens: toTokens(blocksToChars(contentBlocks(message.content))),
					...(images > 0 ? { images } : {}),
					...meta,
				});
				return;
			}
			case "assistant": {
				const kinds = new Set<"think" | "tool" | "answer">();
				const names: string[] = [];
				let text = "";
				let thinking = "";
				for (const block of contentBlocks(message.content)) {
					if (block.type === "thinking" && block.thinking) {
						kinds.add("think");
						thinking += block.thinking;
					} else if (block.type === "text" && block.text?.trim()) {
						kinds.add("answer");
						text += block.text;
					} else if (block.type === "toolCall") {
						kinds.add("tool");
						names.push(block.name ?? "tool");
						calls.set(block.id ?? "", block);
					}
				}
				buckets.assistant.push({
					key,
					label:
						oneLine(text) || (names.length > 0 ? `调用 ${names.join(", ")}` : oneLine(thinking)) || "(空回复)",
					...(names.length > 0 ? { chip: foldNames(names) } : {}),
					tokens: toTokens(blocksToChars(contentBlocks(message.content))),
					kinds: [...kinds],
					...meta,
				});
				return;
			}
			case "toolResult": {
				const call = calls.get(message.toolCallId);
				const name: string = message.toolName ?? call?.name ?? "tool";
				hits.set(name, (hits.get(name) ?? 0) + 1);
				const images = countImages(message.content);
				buckets.toolResult.push({
					key,
					label: callLabel(call?.arguments) || oneLine(textOf(message.content)) || "工具结果",
					chip: name,
					tokens: toTokens(blocksToChars(contentBlocks(message.content))),
					...(message.isError === true ? { error: true } : {}),
					...(typeof message.toolCallId === "string" ? { callId: message.toolCallId } : {}),
					...(images > 0 ? { images } : {}),
					...meta,
				});
				return;
			}
			default:
				buckets.other.push({
					key,
					label: oneLine(otherText(message)) || String(message?.role ?? "other"),
					chip: String(message?.role ?? "other"),
					tokens: toTokens(otherMessageChars(message)),
					...meta,
				});
		}
	});
	for (const tool of getCurrentTools(messages as TranscriptMessages)) {
		buckets.toolSchemas.push({
			key: `tool:${tool.name}`,
			label: tool.name,
			chip: sources.get(tool.name) ?? "transcript",
			tokens: toTokens(toolSchemaChars(tool)),
			hits: hits.get(tool.name) ?? 0,
		});
	}
	return CONTEXT_CATEGORIES.map((category) => ({
		key: category,
		tokens: buckets[category].reduce((sum, item) => sum + item.tokens, 0),
		items: buckets[category],
	}));
}

/** 取一个条目的完整内容。key 不存在时回 undefined。 */
export function contextItemContentOf(
	messages: readonly AgentMessage[],
	key: string,
	sources: ReadonlyMap<string, string> = new Map(),
): ContextItemContent | undefined {
	const list = messages as ReadonlyArray<LooseMessage>;
	const leading = list.find((message) => message?.role === "system");
	if (key === "sys") {
		if (!leading) return undefined;
		const parts = [textOf(leading.content)];
		for (const [name, value] of Object.entries((leading.sections ?? {}) as Record<string, unknown>)) {
			if (typeof value === "string" && BASE_SYSTEM_SECTIONS.has(name)) parts.push(value);
		}
		return { title: "系统提示词", ...capText(parts.filter(Boolean).join("\n\n")) };
	}
	if (key.startsWith("sec:")) {
		const name = key.slice(4);
		const value = (leading?.sections as Record<string, unknown> | undefined)?.[name];
		return typeof value === "string" ? { title: name, ...capText(value) } : undefined;
	}
	if (key.startsWith("tool:")) {
		const name = key.slice(5);
		const tool = getCurrentTools(messages as TranscriptMessages).find((candidate) => candidate.name === name);
		if (!tool) return undefined;
		const source = sources.get(name);
		return {
			title: name,
			tool: { description: tool.description, parameters: tool.parameters, ...(source ? { source } : {}) },
		};
	}
	if (!/^m\d+$/.test(key)) return undefined;
	const index = Number(key.slice(1));
	const message = list[index];
	if (!message) return undefined;
	switch (message.role) {
		case "system": {
			const parts = [textOf(message.content)];
			for (const [name, value] of Object.entries((message.sections ?? {}) as Record<string, unknown>)) {
				if (typeof value === "string") parts.push(`[${name}]\n${value}`);
			}
			return { title: systemLabel(message), ...capText(parts.filter(Boolean).join("\n\n")) };
		}
		case "user": {
			const images = countImages(message.content);
			return { title: "用户消息", ...capText(textOf(message.content)), ...(images > 0 ? { images } : {}) };
		}
		case "assistant": {
			let text = "";
			let thinking = "";
			const calls: Array<{ name: string; args: unknown }> = [];
			for (const block of contentBlocks(message.content)) {
				if (block.type === "text" && block.text) text += block.text;
				else if (block.type === "thinking" && block.thinking) thinking += block.thinking;
				else if (block.type === "toolCall") calls.push({ name: block.name ?? "tool", args: block.arguments ?? {} });
			}
			return {
				title: "助手消息",
				...capText(text),
				...(thinking ? { thinking: thinking.slice(0, TEXT_CAP) } : {}),
				...(calls.length > 0 ? { calls } : {}),
			};
		}
		case "toolResult": {
			let call: ContentBlock | undefined;
			for (let cursor = index - 1; cursor >= 0 && !call; cursor -= 1) {
				if (list[cursor]?.role !== "assistant") continue;
				call = toolCallsOf(messages[cursor]!).find((block) => block.id === message.toolCallId);
			}
			const images = countImages(message.content);
			const name: string = message.toolName ?? call?.name ?? "tool";
			return {
				title: name,
				...capText(textOf(message.content)),
				call: { name, args: call?.arguments ?? {}, ok: message.isError !== true },
				...(images > 0 ? { images } : {}),
			};
		}
		default:
			return { title: String(message.role ?? "other"), ...capText(otherText(message)) };
	}
}

// ---------------------------------------------------------------------------
// 会话数据：前缀还原、明细、wire 视图
// ---------------------------------------------------------------------------

export function emptyContextInsightData(): ContextInsightData {
	return {
		requests: [],
		events: [],
		tools: [],
		files: [],
		timing: { activeMs: 0, toolRuns: 0, toolMs: 0 },
		snapshots: new Map(),
		liveTail: [],
		epoch: 0,
	};
}

interface TranscriptView {
	messages: AgentMessage[];
	epoch: number;
	approximate: boolean;
	row?: ContextRequestRow;
}

/** 某一步（缺省 = 当前 · 下一次请求）的 transcript：该纪元快照取前 messageCount 条。 */
function transcriptOf(data: ContextInsightData, seq?: number): TranscriptView | undefined {
	if (seq === undefined) {
		const snapshot = data.snapshots.get(data.epoch) ?? [];
		return { messages: [...snapshot, ...data.liveTail], epoch: data.epoch, approximate: false };
	}
	const row = data.requests.find((candidate) => candidate.seq === seq);
	if (!row || row.messageCount === undefined) return undefined;
	const epoch = row.epoch ?? 0;
	const snapshot = data.snapshots.get(epoch);
	if (!snapshot) return undefined;
	return {
		messages: snapshot.slice(0, row.messageCount),
		epoch,
		approximate: snapshot.length < row.messageCount,
		row,
	};
}

/** 条目的「首次进入」步骤戳：同纪元第一条 messageCount 超过该下标的请求。 */
function stampsOf(data: ContextInsightData, epoch: number, messages: readonly AgentMessage[]): StampOf {
	const rows = data.requests.filter((row) => (row.epoch ?? 0) === epoch && row.messageCount !== undefined);
	const last = rows[rows.length - 1];
	return (index) => {
		for (const row of rows) if (row.messageCount! > index) return { turn: row.turn, step: row.step };
		if (!last) return undefined;
		for (let cursor = last.messageCount!; cursor <= index; cursor += 1) {
			if ((messages[cursor] as LooseMessage | undefined)?.role === "user")
				return { turn: last.turn + 1, step: 1, pending: true };
		}
		return { turn: last.turn, step: last.step + 1, pending: true };
	};
}

function sourcesOf(data: ContextInsightData): Map<string, string> {
	return new Map(data.tools.map((ref) => [ref.name, ref.source]));
}

export function contextDetailOf(data: ContextInsightData, seq?: number): ContextDetailResult {
	const view = transcriptOf(data, seq);
	const seqField = seq !== undefined ? { seq } : {};
	if (!view) return { ...seqField, available: false, categories: [] };
	const sources = sourcesOf(data);
	const stampOf = stampsOf(data, view.epoch, view.messages);
	const categories = contextItemsOf(view.messages, sources, stampOf);
	const rowIndex = seq === undefined ? data.requests.length : data.requests.findIndex((row) => row.seq === seq);
	const previous = rowIndex > 0 ? data.requests[rowIndex - 1] : undefined;
	let baseline: ContextDetailResult["baseline"];
	if (previous && (previous.epoch ?? 0) === view.epoch) {
		const prior = transcriptOf(data, previous.seq);
		if (prior) {
			baseline = {};
			for (const category of contextItemsOf(prior.messages, sources)) {
				baseline[category.key] = { count: category.items.length, tokens: category.tokens };
			}
		}
	}
	const position = view.row
		? { turn: view.row.turn, step: view.row.step }
		: (() => {
				const stamp = stampOf(view.messages.length);
				return stamp ? { turn: stamp.turn, step: stamp.step } : {};
			})();
	return {
		...seqField,
		available: true,
		...(view.approximate ? { approximate: true } : {}),
		...position,
		categories,
		...(baseline ? { baseline } : {}),
	};
}

export function contextItemOf(data: ContextInsightData, key: string, seq?: number): ContextItemContent | undefined {
	const view = transcriptOf(data, seq);
	return view ? contextItemContentOf(view.messages, key, sourcesOf(data)) : undefined;
}

export function contextInsightWire(data: ContextInsightData): ContextInsightWire {
	const snapshot = data.snapshots.get(data.epoch);
	return {
		requests: [...data.requests],
		events: [...data.events],
		tools: [...data.tools],
		files: [...data.files],
		timing: { ...data.timing },
		liveVersion: `${data.epoch}:${snapshot?.length ?? 0}:${data.liveTail.length}:${data.requests.length}`,
	};
}

// ---------------------------------------------------------------------------
// 历史会话重建（注册表无数据时从会话转录回放）
// ---------------------------------------------------------------------------

/** 零值 usage（中止/出错响应）不回填，避免「实测 0 tok」误导。 */
export function contextUsageOf(
	usage: (Partial<Omit<ContextUsageInfo, "cost">> & { cost?: number | { total?: number } }) | undefined,
): ContextUsageInfo | undefined {
	if (!usage) return undefined;
	const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
	const filled: ContextUsageInfo = {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
		...(typeof cost === "number" && cost > 0 ? { cost } : {}),
	};
	if (filled.input + filled.output + filled.cacheRead + filled.cacheWrite === 0) return undefined;
	return filled;
}

/** 单条消息分类进累加器：保留 leading system 口径（首条拆 system/inject，后置归 inject）。 */
function classifyInto(accumulator: ContextComposition, message: AgentMessage, state: { leadingSeen: boolean }): void {
	const part = classifyRequestMessages([message]);
	const role = (message as { role?: string }).role;
	switch (role) {
		case "system":
			if (!state.leadingSeen) {
				state.leadingSeen = true;
				accumulator.system += part.system;
				accumulator.inject += part.inject;
			} else {
				accumulator.inject += part.system + part.inject;
			}
			return;
		case "user":
			accumulator.user += part.user;
			return;
		case "assistant":
			accumulator.assistant += part.assistant;
			return;
		case "toolResult":
			accumulator.toolResult += part.toolResult;
			return;
		default:
			accumulator.other += part.other;
	}
}

function sumComposition(composition: ContextComposition): number {
	return Object.values(composition).reduce((sum, value) => sum + value, 0);
}

function pushCapped<T>(list: T[], item: T, cap: number): void {
	list.push(item);
	if (list.length > cap) list.splice(0, list.length - cap);
}

/**
 * 从会话投影（compaction 感知的模型可见转录）重建每请求的上下文构成与事件。
 *
 * 桌面端恢复历史会话时，owl-context 只在本进程发起过请求后才有点位数据，
 * 「上下文」页会一直空着；这里按「一条 assistant 消息 = 一次 LLM 请求」把
 * 投影转录切行：请求 k 的构成 = 第 k 条 assistant 之前的全部可见消息（含
 * leading system），实测口径直接取该 assistant 消息自带的 usage。工具 schema
 * 从持久化的 system 工具变更回放；旧转录没有声明时无法补算。投影已按压缩边界裁剪，
 * 压缩后的前缀自动回落；compaction 条目记一条 compact 事件。整份投影作为纪元 0
 * 的快照，浏览器照常按前缀下钻。耗时无从回放。
 */
export function reconstructContextInsight(projected: ReadonlyArray<ProjectedSessionEntry>): ContextInsightData {
	const data = emptyContextInsightData();
	const flat: AgentMessage[] = [];
	const systemMessages: AgentMessage[] = [];
	const accumulator: ContextComposition = {
		system: 0,
		inject: 0,
		user: 0,
		assistant: 0,
		toolResult: 0,
		toolSchemas: 0,
		other: 0,
	};
	const leading = { leadingSeen: false };
	let lastRole: string | undefined;
	let lastUser: string | undefined;
	let inbound: ContextBriefItem[] = [];
	const calls = new Map<string, { name: string; args: unknown; seq: number }>();
	let pending: ContextEventRow[] = [];
	let previousModel: string | undefined;
	try {
		for (const entry of projected) {
			const ts = entry.sourceEntry.timestamp ? Date.parse(entry.sourceEntry.timestamp) : Date.now();
			if (entry.sourceEntry.type === "compaction") {
				pending.push({ ts, kind: "compact", label: "上下文压缩（历史）" });
			}
			for (const message of entry.messages) {
				const index = flat.length;
				flat.push(message);
				const loose = message as LooseMessage;
				const role = loose.role as string | undefined;
				const messageTs = typeof loose.timestamp === "number" && loose.timestamp > 0 ? loose.timestamp : ts;
				if (role === "system") {
					systemMessages.push(message);
					const declared = estimateToolDeclarations([], systemMessages);
					accumulator.toolSchemas = declared.total;
					data.tools = declared.refs;
					if (!leading.leadingSeen) {
						for (const [name, value] of Object.entries((loose.sections ?? {}) as Record<string, unknown>)) {
							if (typeof value === "string" && !BASE_SYSTEM_SECTIONS.has(name)) {
								pending.push({
									ts: messageTs,
									kind: "inject",
									label: `段落注入 · ${name}`,
									delta: toTokens(weightedTextChars(value)),
									itemKey: `sec:${name}`,
								});
							}
						}
					} else {
						const { base, sections } = systemMessageChars(loose);
						if (base + sections > 0) {
							const label = systemLabel(loose);
							pending.push({
								ts: messageTs,
								kind: "inject",
								label: `指令注入 · ${label}`,
								delta: toTokens(base + sections),
								itemKey: `m${index}`,
							});
							inbound.push({ chip: "注入", text: label });
						}
					}
				}
				if (role === "assistant") {
					const previous = data.requests[data.requests.length - 1];
					const newTurn = !previous || lastRole === "user";
					const turn = newTurn ? (previous?.turn ?? 0) + 1 : previous.turn;
					const step = newTurn ? 1 : previous.step + 1;
					const seq = (previous?.seq ?? 0) + 1;
					const usage = contextUsageOf(loose.usage);
					const model =
						typeof loose.provider === "string" && typeof loose.model === "string"
							? { provider: loose.provider, id: loose.model }
							: undefined;
					const toolCalls = toolCallsOf(message);
					pushCapped(
						data.requests,
						{
							seq,
							ts: messageTs,
							turn,
							step,
							composition: { ...accumulator },
							totalTokens: sumComposition(accumulator),
							messageCount: index,
							epoch: 0,
							brief: {
								...(lastUser !== undefined ? { user: lastUser } : {}),
								inbound: step > 1 ? inbound.slice(0, BRIEF_MAX) : [],
								response: responseBriefOf(message),
							},
							toolCalls: toolCalls.length,
							...(model ? { model } : {}),
							...(usage ? { usage } : {}),
						},
						MAX_REQUESTS,
					);
					for (const event of pending) {
						pushCapped(data.events, { ...event, seq, turn, step }, MAX_EVENTS);
					}
					pending = [];
					if (previousModel && model && previousModel !== model.id) {
						pushCapped(
							data.events,
							{
								ts: messageTs,
								kind: "model",
								label: `模型切换：${previousModel} → ${model.id}`,
								seq,
								turn,
								step,
							},
							MAX_EVENTS,
						);
					}
					if (model) previousModel = model.id;
					inbound = [];
					for (const call of toolCalls)
						calls.set(call.id ?? "", { name: call.name ?? "tool", args: call.arguments, seq });
				}
				if (role === "user") lastUser = userLabel(loose);
				if (role === "toolResult") {
					const call = calls.get(loose.toolCallId);
					const name: string = loose.toolName ?? call?.name ?? "tool";
					inbound.push({
						chip: name,
						text: callLabel(call?.args) || oneLine(textOf(loose.content)),
						...(loose.isError === true ? { error: true } : {}),
					});
					for (const op of fileOpsOf(name, call?.args)) {
						pushCapped(
							data.files,
							{
								...op,
								seq: call?.seq ?? 0,
								ts: messageTs,
								ok: loose.isError !== true,
								...(typeof loose.toolCallId === "string" ? { callId: loose.toolCallId } : {}),
							},
							MAX_FILES,
						);
					}
					data.timing.toolRuns += 1;
				}
				if (role !== "system") lastRole = role;
				classifyInto(accumulator, message, leading);
			}
		}
		for (const event of pending) pushCapped(data.events, event, MAX_EVENTS);
	} catch {
		// 重建是只读旁路：任何异常都回已有部分，绝不影响正常请求
	}
	data.snapshots.set(0, flat);
	return data;
}

// ---------------------------------------------------------------------------
// 会话注册表（进程级单例）
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 50;
const MAX_REQUESTS = 400;
const MAX_EVENTS = 100;
const MAX_FILES = 2000;
const MAX_LIVE_TAIL = 300;
const MAX_EPOCHS = 6;

const states = new Map<string, ContextInsightState>();

/** 跨事件的在途状态（不上 wire）。 */
interface Tracker {
	inflight?: { seq: number; start: number; last: number; first: boolean };
	toolStarts: Map<string, { ts: number; name: string; args: unknown }>;
	/** 上一次请求的注入条目（key → tokens），换纪元时静默重置。 */
	injects?: { epoch: number; entries: Map<string, number> };
	toolNames?: Set<string>;
}

const trackers = new Map<string, Tracker>();

function trackerOf(sessionId: string): Tracker {
	let tracker = trackers.get(sessionId);
	if (!tracker) {
		tracker = { toolStarts: new Map() };
		trackers.set(sessionId, tracker);
	}
	return tracker;
}

function stateOf(sessionId: string, cwd: string): ContextInsightState {
	let state = states.get(sessionId);
	if (!state) {
		state = { sessionId, cwd, ...emptyContextInsightData(), lastTs: Date.now() };
		states.set(sessionId, state);
		if (states.size > MAX_SESSIONS) {
			// 淘汰最久不活跃的会话
			let oldestKey: string | undefined;
			let oldestTs = Infinity;
			for (const [key, value] of states) {
				if (value.lastTs < oldestTs) {
					oldestTs = value.lastTs;
					oldestKey = key;
				}
			}
			if (oldestKey !== undefined) {
				states.delete(oldestKey);
				trackers.delete(oldestKey);
			}
		}
	}
	state.lastTs = Date.now();
	return state;
}

function lastRow(state: ContextInsightData): ContextRequestRow | undefined {
	return state.requests[state.requests.length - 1];
}

function nextTurnStep(
	previous: ContextRequestRow | undefined,
	messages: readonly AgentMessage[] | undefined,
): { turn: number; step: number } {
	if (!previous) {
		const users = messages ? messages.filter((message) => (message as LooseMessage).role === "user").length : 0;
		return { turn: Math.max(1, users), step: 1 };
	}
	if (messages) {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const role = (messages[index] as LooseMessage).role;
			if (role === "system") continue;
			if (role === "user") return { turn: previous.turn + 1, step: 1 };
			break;
		}
	}
	return { turn: previous.turn, step: previous.step + 1 };
}

/** 本次请求里的注入条目（leading 的扩展段落 + 追加系统消息）。 */
function injectEntriesOf(messages: readonly AgentMessage[]): Array<{ key: string; label: string; tokens: number }> {
	const entries: Array<{ key: string; label: string; tokens: number }> = [];
	let leadingSeen = false;
	(messages as ReadonlyArray<LooseMessage>).forEach((message, index) => {
		if (message?.role !== "system") return;
		if (!leadingSeen) {
			leadingSeen = true;
			for (const [name, value] of Object.entries((message.sections ?? {}) as Record<string, unknown>)) {
				if (typeof value === "string" && !BASE_SYSTEM_SECTIONS.has(name)) {
					entries.push({
						key: `sec:${name}`,
						label: `段落注入 · ${name}`,
						tokens: toTokens(weightedTextChars(value)),
					});
				}
			}
			return;
		}
		const { base, sections } = systemMessageChars(message);
		if (base + sections > 0) {
			entries.push({
				key: `m${index}`,
				label: `指令注入 · ${systemLabel(message)}`,
				tokens: toTokens(base + sections),
			});
		}
	});
	return entries;
}

function detectInjections(
	state: ContextInsightState,
	tracker: Tracker,
	messages: readonly AgentMessage[],
	row: ContextRequestRow,
	previous: ContextRequestRow | undefined,
	toolNames: string[] | undefined,
): void {
	const at = { seq: row.seq, turn: row.turn, step: row.step };
	const entries = injectEntriesOf(messages);
	const prior = tracker.injects?.epoch === state.epoch ? tracker.injects.entries : undefined;
	// 换纪元（压缩后下标整体位移）只重置基线；会话首个请求把已有注入全部记一次
	if (prior || !previous) {
		for (const entry of entries) {
			const before = prior?.get(entry.key);
			if (before === entry.tokens) continue;
			pushCapped(
				state.events,
				{
					ts: row.ts,
					kind: "inject",
					label: before === undefined ? entry.label : `${entry.label}（更新）`,
					delta: entry.tokens - (before ?? 0),
					itemKey: entry.key,
					...at,
				},
				MAX_EVENTS,
			);
		}
	}
	tracker.injects = { epoch: state.epoch, entries: new Map(entries.map((entry) => [entry.key, entry.tokens])) };

	if (toolNames) {
		const next = new Set(toolNames);
		const before = tracker.toolNames;
		if (before && previous) {
			const added = [...next].filter((name) => !before.has(name));
			const removed = [...before].filter((name) => !next.has(name));
			if (added.length + removed.length > 0) {
				const parts = [
					...(added.length > 0 ? [`+${oneLine(added.join(", "), 60)}`] : []),
					...(removed.length > 0 ? [`−${oneLine(removed.join(", "), 60)}`] : []),
				];
				pushCapped(
					state.events,
					{
						ts: row.ts,
						kind: "inject",
						label: `工具定义 · ${parts.join(" ")}`,
						delta: row.composition.toolSchemas - previous.composition.toolSchemas,
						...at,
					},
					MAX_EVENTS,
				);
			}
		}
		tracker.toolNames = next;
	}
}

/**
 * 记录一次请求。responseUsage 是本轮 transcript 里上一条响应的计费数字，补填到上一行。
 * 传入 messages 时留存快照（浏览器下钻）、推算轮次/步骤、生成简报并检测注入。
 */
export function recordContextRequest(
	sessionId: string,
	cwd: string,
	row: Omit<ContextRequestRow, "seq" | "totalTokens" | "turn" | "step"> & { seq?: number },
	responseUsage?: ContextUsageInfo,
	messages?: readonly AgentMessage[],
	toolNames?: string[],
): void {
	const state = stateOf(sessionId, cwd);
	const tracker = trackerOf(sessionId);
	const previous = lastRow(state);
	if (previous && responseUsage && !previous.usage) previous.usage = responseUsage;
	const totalTokens = sumComposition(row.composition);
	const { turn, step } = nextTurnStep(previous, messages);
	const seq = (previous?.seq ?? 0) + 1;
	const next: ContextRequestRow = { ...row, seq, totalTokens, turn, step };
	if (messages) {
		if (
			previous?.messageCount !== undefined &&
			(previous.epoch ?? 0) === state.epoch &&
			messages.length < previous.messageCount
		) {
			state.epoch += 1;
		}
		state.snapshots.set(state.epoch, [...messages]);
		for (const epoch of [...state.snapshots.keys()]) {
			if (epoch <= state.epoch - MAX_EPOCHS) state.snapshots.delete(epoch);
		}
		state.liveTail = [];
		next.messageCount = messages.length;
		next.epoch = state.epoch;
		next.brief = requestBriefOf(messages, step);
	}
	pushCapped(state.requests, next, MAX_REQUESTS);

	// 两次请求之间发生的事件（压缩 / 模式切换）落到本步
	for (const event of state.events) {
		if (event.seq !== undefined) continue;
		event.seq = seq;
		event.turn = turn;
		event.step = step;
		if (event.kind === "compact" && event.delta === undefined && previous) {
			event.delta = totalTokens - previous.totalTokens;
		}
	}
	if (previous?.model && row.model && previous.model.id !== row.model.id) {
		pushCapped(
			state.events,
			{ ts: row.ts, kind: "model", label: `模型切换：${previous.model.id} → ${row.model.id}`, seq, turn, step },
			MAX_EVENTS,
		);
	}
	if (messages) detectInjections(state, tracker, messages, next, previous, toolNames);
	tracker.inflight = { seq, start: row.ts, last: row.ts, first: false };
}

/** 记录一条上下文事件。两次请求之间的事件在下一次请求组装时落到那一步。 */
export function recordContextEvent(sessionId: string, cwd: string, event: Omit<ContextEventRow, "ts">): void {
	const state = stateOf(sessionId, cwd);
	pushCapped(state.events, { ...event, ts: Date.now() }, MAX_EVENTS);
}

/** 记录一次压缩：开启新纪元，token 变化在下一次请求时按前后两步之差回填。 */
export function recordContextCompaction(sessionId: string, cwd: string, label: string, reason?: string): void {
	const state = stateOf(sessionId, cwd);
	state.epoch += 1;
	state.liveTail = [];
	pushCapped(state.events, { ts: Date.now(), kind: "compact", label, ...(reason ? { reason } : {}) }, MAX_EVENTS);
}

/**
 * 用一条响应的真实计费回填最近一行请求（插件在 message_end 时调用）。
 * 只补空不覆盖：上一轮请求路径的补填可能已先到；陈旧响应落空也无妨
 * （agent 循环里响应总是先于下一次请求组装结束，归属始终正确）。
 */
export function recordContextUsage(sessionId: string, usage: ContextUsageInfo): void {
	const state = states.get(sessionId);
	if (!state) return;
	const last = lastRow(state);
	if (!last || last.usage) return;
	last.usage = usage;
	state.lastTs = Date.now();
}

export type ContextStreamKind = "thinking" | "answer" | "toolArgs";

/** 流式增量：首个增量记 TTFT，其后每段间隔归给该增量的种类。 */
export function recordContextStream(sessionId: string, kind: ContextStreamKind, now = Date.now()): void {
	const state = states.get(sessionId);
	const inflight = trackers.get(sessionId)?.inflight;
	if (!state || !inflight) return;
	const row = lastRow(state);
	if (!row || row.seq !== inflight.seq) return;
	row.timing ??= { thinking: 0, answer: 0, toolArgs: 0 };
	const timing = row.timing;
	if (!inflight.first) {
		inflight.first = true;
		timing.ttft = now - inflight.start;
	} else {
		timing[kind] += now - inflight.last;
	}
	inflight.last = now;
}

/** 助手消息结束：模型耗时、回复简报、工具调用数、计费回填，并计入「当前」尾巴。 */
export function recordContextResponse(sessionId: string, message: AgentMessage, now = Date.now()): void {
	const state = states.get(sessionId);
	if (!state) return;
	const tracker = trackers.get(sessionId);
	const row = lastRow(state);
	if (row) {
		if (tracker?.inflight && tracker.inflight.seq === row.seq) {
			row.timing ??= { thinking: 0, answer: 0, toolArgs: 0 };
			row.timing.model = now - tracker.inflight.start;
			tracker.inflight = undefined;
		}
		const response = responseBriefOf(message);
		if (row.brief) row.brief.response = response;
		else row.brief = { inbound: [], response };
		row.toolCalls = toolCallsOf(message).length;
		const loose = message as LooseMessage;
		if (loose.stopReason !== "aborted" && loose.stopReason !== "error") {
			const usage = contextUsageOf(loose.usage);
			if (usage) recordContextUsage(sessionId, usage);
		}
	}
	appendContextLive(sessionId, message);
}

/** 最近一次请求之后进入上下文的消息（用户输入、工具结果等）。 */
export function appendContextLive(sessionId: string, message: AgentMessage): void {
	const state = states.get(sessionId);
	if (!state) return;
	pushCapped(state.liveTail, message, MAX_LIVE_TAIL);
}

export function recordContextToolStart(
	sessionId: string,
	toolCallId: string,
	toolName: string,
	args: unknown,
	now = Date.now(),
): void {
	trackerOf(sessionId).toolStarts.set(toolCallId, { ts: now, name: toolName, args });
}

/** 工具执行结束：累计执行耗时，并把 read/write/edit/grep/find/ls 记为文件活动。 */
export function recordContextToolEnd(
	sessionId: string,
	toolCallId: string,
	toolName: string,
	isError: boolean,
	now = Date.now(),
): void {
	const state = states.get(sessionId);
	const tracker = trackers.get(sessionId);
	const start = tracker?.toolStarts.get(toolCallId);
	tracker?.toolStarts.delete(toolCallId);
	if (!state) return;
	state.timing.toolRuns += 1;
	if (start) state.timing.toolMs += now - start.ts;
	const seq = lastRow(state)?.seq ?? 0;
	for (const op of fileOpsOf(toolName, start?.args)) {
		pushCapped(state.files, { ...op, seq, ts: now, ok: !isError, callId: toolCallId }, MAX_FILES);
	}
}

/** agent 起止：累计活跃时长。 */
export function recordContextAgent(sessionId: string, cwd: string, phase: "start" | "end", now = Date.now()): void {
	const state = stateOf(sessionId, cwd);
	if (phase === "start") {
		state.timing.activeSince = now;
		return;
	}
	if (state.timing.activeSince !== undefined) state.timing.activeMs += now - state.timing.activeSince;
	delete state.timing.activeSince;
}

/** 记录最近一次声明给模型的工具集。 */
export function recordContextTools(sessionId: string, cwd: string, tools: ContextToolRef[]): void {
	const state = stateOf(sessionId, cwd);
	state.tools = tools;
}

export function getContextInsight(sessionId: string): Readonly<ContextInsightState> | undefined {
	return states.get(sessionId);
}

/** cwd 归一化：分隔符统一为 /、去尾斜杠、小写（Windows 路径两侧写法不定）。 */
function normalizeCwd(cwd: string): string {
	return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 按 cwd 找最近活跃的会话洞察（桥的 context.get 不带 sessionId 时用）。 */
export function findContextInsightByCwd(
	cwd: string,
): { sessionId: string; state: Readonly<ContextInsightState> } | undefined {
	const resolved = normalizeCwd(cwd);
	let best: { sessionId: string; state: ContextInsightState } | undefined;
	for (const state of states.values()) {
		if (normalizeCwd(state.cwd) !== resolved) continue;
		if (!best || state.lastTs > best.state.lastTs) best = { sessionId: state.sessionId, state };
	}
	return best;
}

export function dropContextInsight(sessionId: string): void {
	states.delete(sessionId);
	trackers.delete(sessionId);
}
