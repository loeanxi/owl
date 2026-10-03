/**
 * 「上下文洞察」注册表 —— owl-context 插件与桌面桥的共享接缝。
 *
 * owl-context 以普通插件形式加载（settings plugins），在每次 LLM 请求组装点
 * （context_with_system 事件）把六类构成（系统提示/注入/用户/回复/工具结果/
 * 工具 schema）的 token 估算写入这里；桌面桥收到 context.get 时从这里取数。
 * 非桌面模式（print/-p）里数据照记不误，只是没人读，封顶后自然淘汰。
 *
 * 单例语义与 question-channel 相同：桥与插件运行在同一进程，插件经
 * @owl/owl-coding-agent 别名拿到的是同一份模块实例，这里就是两边共享的接缝。
 *
 * 估算口径与 core/compaction 的 estimateTokens 一致：chars/4 启发式、图片按
 * 4800 字符折算。usage（provider 计费数字）在下一轮请求时补填到上一行——
 * 请求 N 的 transcript 里躺着的正是请求 N-1 的响应。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

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

export interface ContextUsageInfo {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** 单个工具的声明来源（UI 来源芯片用）。 */
export interface ContextToolRef {
	name: string;
	/** namespace 名（如 mcp_playwright）或 sourceInfo.source（builtin / 包名）。 */
	source: string;
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
}

/** 上下文生命周期事件（压缩 / 工具集变化等）。 */
export interface ContextEventRow {
	ts: number;
	kind: "compact" | "tools";
	/** 人类可读描述。 */
	label: string;
	/** 压缩触发原因（manual / threshold / overflow）。 */
	reason?: string;
}

export interface ContextInsightState {
	sessionId: string;
	cwd: string;
	requests: ContextRequestRow[];
	events: ContextEventRow[];
	tools: ContextToolRef[];
	/** 最近一次活动时间（LRU 淘汰与 cwd 匹配排序用）。 */
	lastTs: number;
}

export const EMPTY_CONTEXT_INSIGHT: Pick<ContextInsightState, "requests" | "events" | "tools"> = {
	requests: [],
	events: [],
	tools: [],
};

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

type ContentBlock = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

function contentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as ContentBlock[];
	return [];
}

function blocksToChars(blocks: ContentBlock[]): number {
	let chars = 0;
	for (const block of blocks) {
		if (block.type === "text" && block.text) chars += block.text.length;
		else if (block.type === "image") chars += IMAGE_CHARS;
		else if (block.type === "thinking" && block.thinking) chars += block.thinking.length;
		else if (block.type === "toolCall") {
			chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
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
			if (typeof value === "string") sections += value.length;
		}
	}
	return { base, sections };
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
	for (const message of messages as ReadonlyArray<Record<string, any>>) {
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
				composition.assistant += toTokens(blocksToChars(message.content));
				break;
			case "toolResult":
				composition.toolResult += toTokens(blocksToChars(contentBlocks(message.content)));
				break;
			default: {
				// bashExecution / branchSummary / compactionSummary 等自定义角色
				const chars =
					(typeof message?.command === "string" ? message.command.length : 0) +
					(typeof message?.output === "string" ? message.output.length : 0) +
					(typeof message?.summary === "string" ? message.summary.length : 0) +
					blocksToChars(contentBlocks(message?.content));
				composition.other += toTokens(chars);
			}
		}
	}
	return composition;
}

export interface ToolDeclarationEstimate {
	/** 全部声明工具的 schema token 之和。 */
	total: number;
	refs: ContextToolRef[];
}

/**
 * 估算声明给模型的工具 schema 占用。ToolInfo 从插件侧传入
 * （pi.getAllTools() + pi.getActiveTools() 过滤出 direct 且激活的集合）。
 */
export function estimateToolDeclarations(
	tools: ReadonlyArray<{
		name: string;
		description: string;
		parameters: unknown;
		namespace?: { name?: string };
		sourceInfo?: { source?: string };
	}>,
): ToolDeclarationEstimate {
	let chars = 0;
	const refs: ContextToolRef[] = [];
	for (const tool of tools) {
		chars += tool.name.length + tool.description.length + JSON.stringify(tool.parameters ?? {}).length;
		refs.push({ name: tool.name, source: tool.namespace?.name ?? tool.sourceInfo?.source ?? "builtin" });
	}
	return { total: toTokens(chars), refs };
}

// ---------------------------------------------------------------------------
// 会话注册表（进程级单例）
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 50;
const MAX_REQUESTS = 400;
const MAX_EVENTS = 100;

const states = new Map<string, ContextInsightState>();

function stateOf(sessionId: string, cwd: string): ContextInsightState {
	let state = states.get(sessionId);
	if (!state) {
		state = { sessionId, cwd, requests: [], events: [], tools: [], lastTs: Date.now() };
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
			if (oldestKey !== undefined) states.delete(oldestKey);
		}
	}
	state.lastTs = Date.now();
	return state;
}

/** 记录一次请求。responseUsage 是本轮 transcript 里上一条响应的计费数字，补填到上一行。 */
export function recordContextRequest(
	sessionId: string,
	cwd: string,
	row: Omit<ContextRequestRow, "seq" | "totalTokens"> & { seq?: number },
	responseUsage?: ContextUsageInfo,
): void {
	const state = stateOf(sessionId, cwd);
	const previous = state.requests[state.requests.length - 1];
	const seq = (previous?.seq ?? 0) + 1;
	if (previous && responseUsage && !previous.usage) previous.usage = responseUsage;
	const totalTokens = Object.values(row.composition).reduce((sum, value) => sum + value, 0);
	state.requests.push({ ...row, seq, totalTokens });
	if (state.requests.length > MAX_REQUESTS) state.requests.splice(0, state.requests.length - MAX_REQUESTS);
}

/** 记录一条上下文事件（压缩 / 工具集变化）。 */
export function recordContextEvent(sessionId: string, cwd: string, event: Omit<ContextEventRow, "ts">): void {
	const state = stateOf(sessionId, cwd);
	state.events.push({ ...event, ts: Date.now() });
	if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
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
}
