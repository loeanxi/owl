import type { ResearchResult, ServerEventMessage } from "../bridge/protocol.ts";
import { publishedResults, researchResultOf } from "../features/research/research-results.ts";
import { t } from "../i18n/index.ts";
import { formatProviderError } from "./provider-error.ts";
import { userSourceText } from "./skill-invocation.ts";
import { summarizeToolCall } from "./summarize.ts";
import { parseUserMessage } from "./user-message.ts";

export { formatProviderError } from "./provider-error.ts";

export type ToolStatus = "pending" | "running" | "ok" | "error" | "cancelled";

/**
 * 一条引用。
 *
 * 协议层的形状见 `packages/ai/src/types.ts` 的 `Citation`（各 provider 的
 * 引用变体在这里拍平成同一个最小形状）。桌面端不直接依赖 pi-ai 的类型，
 * 这里保留一份等价定义。
 */
export type Citation = {
	/** 来源标题（网页标题 / 文档名）。 */
	title?: string;
	/** 来源地址；纯文档引用没有地址。 */
	url?: string;
	/** 被引用的原文片段。 */
	snippet?: string;
	/** 在本条正文里的起始字符（0 基，含）。 */
	startIndex?: number;
	/** 在本条正文里的结束字符（0 基，不含）。 */
	endIndex?: number;
	/** provider 原始类型（`char_location` / `url_citation` / …）。 */
	source?: string;
};

/** 原始消息内容的时间顺序；不从文字猜测进度或最终回答的模型通道。 */
export type AssistantSegment =
	| { kind: "text"; text: string; phase?: "commentary" | "final_answer"; citations?: Citation[] }
	| {
			kind: "thinking";
			text: string;
			startedAt?: number;
			endedAt?: number;
			/** Provider 给的思考摘要（Claude 用它替代原始思考文字）。 */
			summaries?: string[];
	  }
	| { kind: "tool"; toolId: string };

/** 工具结果里的图片内容块（base64；如 browser_screenshot 的返回）。 */
export type ToolResultImage = { data: string; mimeType: string };
export type ToolResultArtifact = { path: string; action: "written" | "edited" | "opened" };

/** 任务清单的一项（todo 工具回传的快照）。 */
export type TaskListItem = {
	content: string;
	status: "pending" | "in_progress" | "completed";
	priority?: "high" | "medium" | "low";
};

/** 一条下一步建议（模型提议，渲染成芯片）。 */
export type NextStep = {
	/** 芯片上的字。 */
	label: string;
	/** 点芯片后发出去的那句话。 */
	prompt: string;
};

/** 工具输出：已从 content 解码成纯文本，不再是 JSON 字符串。 */
export type ToolOutput = {
	text: string;
	totalLines: number;
	images?: ToolResultImage[];
	/** 模型自己写的动作短语（Claude Desktop 的工具行标题就是它写的）。 */
	title?: string;
	/** Plugin-produced files, taken from the successful tool result rather than assistant prose. */
	artifacts?: ToolResultArtifact[];
	/** bash 等超限截断时，服务端把全文写入的临时文件路径（details.fullOutputPath）。 */
	fullPath?: string;
	/** owl-genui：render_ui 工具修复后的 GenUI spec（details.genuiSpec），ChatStream 渲染为交互卡片。 */
	genuiSpec?: unknown;
	/** todo 工具回传的清单快照（details.todos）：渲染成行内清单卡，原始输出不再上屏。 */
	todos?: TaskListItem[];
	/** 模型提议的下一步（details.steps）：渲染成回答下方的一排芯片。 */
	nextSteps?: NextStep[];
	/** 子代理的实时活动（owl-subagents 的 partial details.activity）：组内行下的动态一行。 */
	activity?: string;
	/** 提问的答案（owl-ask-user 的 details.answers）：渲染成 Claude 的响应列表。 */
	questionAnswers?: { question: string; response: string }[];
	/** Research tool's persisted result; prose is never treated as structured evidence. */
	researchResult?: ResearchResult;
};

export type ToolCard = {
	id: string;
	name: string;
	/** 原始参数 JSON（todo 清单解析等仍需要）。 */
	args: string;
	/** 人话摘要（动词 + 关键参数），替代裸 JSON 上屏。 */
	summary: string;
	/** 展开后的参数细节（完整命令/完整路径）。 */
	detail?: string;
	status: ToolStatus;
	/** 执行事件中的实时输出，结束后由权威结果替换。 */
	output?: ToolOutput;
	startedAt?: number;
	finishedAt?: number;
	/** codemode 等工具的子调用，归属同一条 assistant。 */
	parentToolCallId?: string;
	/**
	 * 整组工具的标题 —— 模型自己写的那句（Claude 的 `tool_use_summary`）。
	 *
	 * Claude Desktop 的工具组组头（"Searched code"）是模型写的，不是前端拼的：
	 * 一批工具跑完后，服务端另起一次无工具的模型请求要一句 Label。
	 * 同一批里的每张卡都带上它，渲染时取组内任意一张即可。
	 */
	batchLabel?: string;
	/**
	 * 内部工具：不进回答流（Claude 的 `hidden_in_chat`）。
	 *
	 * Claude 把这类调用从聊天里藏掉，只在统计里留着；对应的结果也不显示。
	 * 网关（`pi-messages`）可以给这类调用打标记。
	 */
	hiddenInChat?: boolean;
};

/** 单条 LLM 回复的 token 用量（消息操作栏的「用量」展示）。 */
export type MessageUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** 流式增量统计：首/末个增量的到达时刻（ms）与按字符估算的输出 tokens。 */
export type StreamStats = { firstAt: number; lastAt: number; estTokens: number };

/**
 * 粗估一段文本的 token 数：中日韩字符按 1 个 token，其余按 4 字符 1 个 token。
 * 用量要等 message_end 才回传，流式中的实时速度只能靠它。
 */
export function estimateTokens(text: string): number {
	let wide = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		if (
			(code >= 0x3000 && code <= 0x9fff) ||
			(code >= 0xac00 && code <= 0xd7af) ||
			(code >= 0xff00 && code <= 0xffef)
		)
			wide++;
	}
	return wide + (text.length - wide) / 4;
}

/**
 * 单条回复每秒输出 tokens。流式中按首个增量到当前增量估算。
 * 结束后的平均速度用真实输出数 ÷（结束时刻 − 响应开始时刻）：末尾一次性吐出的增量
 * 窗口常常不足 1 秒，不能拿它把整段生成时间算没。不足 1 秒不算。
 */
export function outputRate(entry: AssistantEntry): { tps: number; estimated: boolean } | undefined {
	const output = entry.endedAt !== undefined && (entry.usage?.output ?? 0) > 0 ? entry.usage!.output : undefined;
	if (output !== undefined && entry.timestamp !== undefined) {
		const seconds = (entry.endedAt! - entry.timestamp) / 1000;
		if (seconds >= 1) return { tps: output / seconds, estimated: false };
	}
	const stream = entry.stream;
	if (!stream || stream.estTokens <= 0) return undefined;
	const seconds = (stream.lastAt - stream.firstAt) / 1000;
	if (seconds < 1) return undefined;
	return { tps: stream.estTokens / seconds, estimated: true };
}

export type ChatEntry =
	| {
			kind: "user";
			/** 用户输入的正文；核心附加的附件清单与图片提示已拆到下面的字段。 */
			text: string;
			images?: ToolResultImage[];
			/** `@` 文件芯片随本轮附带的路径。 */
			attachedPaths?: string[];
			/** 没能送达模型的附图张数。 */
			omittedImages?: number;
			/** 所属会话日志条目 id（会话回退按钮用；乐观追加的行等 entry_appended 事件补上） */
			entryId?: string;
			/** 消息时间戳（ms；乐观追加行取本地时钟，快照重建取会话文件里的值） */
			timestamp?: number;
			/** 运行中追加的跟进：先显示，但不切断当前这轮的流式更新。 */
			queued?: boolean;
	  }
	| {
			kind: "assistant";
			text: string;
			thinking: string;
			tools: ToolCard[];
			error?: string;
			/** 用户主动暂停导致的 aborted 收尾：不渲染红色报错，只留一行置灰「已暂停」。 */
			aborted?: boolean;
			segments?: AssistantSegment[];
			/** 所属会话日志条目 id（「在新对话中分支」用；快照重建/agent_end 对齐时带上） */
			entryId?: string;
			/** 消息时间戳（ms，操作栏展示用；wire 上是响应「开始」时刻） */
			timestamp?: number;
			/** 回复真实结束时刻（message_end 到达的本地时钟；快照重建时按开始时间戳找回） */
			endedAt?: number;
			/** 本条回复的 token 用量（message_end / 快照重建时带上） */
			usage?: MessageUsage;
			/** 产生本条回复的模型 id */
			model?: string;
			/** 流式输出统计（本地时钟，TPS 用）：按开始时间戳穿越本次进程内的权威重建。 */
			stream?: StreamStats;
	  }
	/** 仅防御性保留：结果找不到所属工具卡时的兜底行（如会话恢复失败）。 */
	| { kind: "toolResult"; toolName: string; ok: boolean; brief: string; researchResult?: ResearchResult };

type AnyEvent = Record<string, any>; // wire events are forward-compat; render defensively

/** Run boundaries belong to UI snapshots, never to messages or model-visible text. */
const runBoundaries = new WeakMap<ChatEntry[], number>();

/** Resumed snapshots identify an assistant range for cancellation, not agent_end replacement. */
const restoredRunBoundaries = new WeakMap<ChatEntry[], number>();

/** UI-only run ownership, including continuation without a new user message. */
export function currentRunStartIndex(entries: ChatEntry[]): number | undefined {
	return runBoundaries.get(entries) ?? restoredRunBoundaries.get(entries);
}

/**
 * assistant 消息的真实结束时刻（message_end 到达的本地时钟）。wire 上的
 * message.timestamp 是响应「开始」时刻（pi-ai 构造消息时取 Date.now()），
 * 不含生成耗时——轮耗时标注靠这张表找回结束点。键 = 消息开始时间戳
 * （快照重建时消息仍带着同一个值，agent_end 权威重建因此不丢）；应用重启后
 * 的历史会话找不到回退为开始时刻。键冲突概率可忽略（单会话同时只有一条流）。
 */
const assistantEndedAt = new Map<number, number>();
/** 与结束时刻同一把键：回答结束后的权威重建不再自带流式统计，靠它找回平均速度。 */
const assistantStream = new Map<number, StreamStats>();
const ASSISTANT_ENDED_AT_MAX = 1000;

function rememberCapped<T>(map: Map<number, T>, startedAt: number, value: T): void {
	while (map.size >= ASSISTANT_ENDED_AT_MAX && !map.has(startedAt)) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
	map.set(startedAt, value);
}

function rememberAssistantEndedAt(startedAt: number, endedAt: number): void {
	rememberCapped(assistantEndedAt, startedAt, Math.max(endedAt, assistantEndedAt.get(startedAt) ?? 0));
}

function rememberAssistantStream(startedAt: number, stream: StreamStats): void {
	rememberCapped(assistantStream, startedAt, stream);
}

/** 已落盘的用户消息才切开当前轮。排队中的跟进还没轮到，不能挡住正在写的回答。 */
function sealsActiveTurn(entry: ChatEntry): boolean {
	return entry.kind === "user" && entry.queued !== true;
}

/** 快照里第一条用户消息是本轮开场白。其后的用户消息才是已经送达的跟进。 */
function retainUndeliveredFollowUps(before: ChatEntry[], next: ChatEntry[], messages: AnyEvent[]): ChatEntry[] {
	const pending = before.filter(
		(entry): entry is Extract<ChatEntry, { kind: "user" }> => entry.kind === "user" && entry.queued === true,
	);
	if (pending.length === 0) return next;
	const delivered = new Map<string, number>();
	let skippedOpeningUser = false;
	for (const message of messages) {
		if (message.role !== "user") continue;
		if (!skippedOpeningUser) {
			skippedOpeningUser = true;
			continue;
		}
		const text = userSourceText(textOf(message.content));
		delivered.set(text, (delivered.get(text) ?? 0) + 1);
	}
	const kept: ChatEntry[] = [];
	for (const entry of pending) {
		const key = userSourceText(entry.text);
		const count = delivered.get(key) ?? 0;
		if (count > 0) delivered.set(key, count - 1);
		else kept.push(entry);
	}
	if (kept.length === 0) return next;
	const merged = [...next.filter((entry) => !(entry.kind === "user" && entry.queued)), ...kept];
	const boundary = runBoundaries.get(next);
	if (boundary !== undefined) runBoundaries.set(merged, boundary);
	return merged;
}

function lastAssistant(entries: ChatEntry[]): (ChatEntry & { kind: "assistant" }) | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind === "assistant") return entry;
		if (sealsActiveTurn(entry)) return undefined;
	}
	return undefined;
}

type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;

function cloneAssistant(entry: AssistantEntry): AssistantEntry {
	return {
		...entry,
		tools: entry.tools.map((tool) => ({ ...tool })),
		segments: entry.segments?.map((segment) => ({ ...segment })) ?? [],
	};
}

function upsertTool(entry: AssistantEntry, id: string, name: string, args?: unknown, hiddenInChat?: boolean): ToolCard {
	let card = entry.tools.find((tool) => tool.id === id);
	if (!card) {
		card = { id, name, args: "", summary: name, status: "pending" };
		entry.tools.push(card);
		(entry.segments ??= []).push({ kind: "tool", toolId: id });
	}
	card.name = name;
	if (hiddenInChat === true) card.hiddenInChat = true;
	if (args !== undefined) {
		card.args = JSON.stringify(args);
		Object.assign(card, summarizeToolCall(name, args));
	}
	return card;
}

function resultStatus(result: AnyEvent, isError: boolean): ToolStatus {
	// 普通失败不当作取消；这里仅识别工具明确标志及 agent-core 的标准中止结果。
	if (result.details?.cancelled === true || (isError && textOf(result.content).trim() === "Operation aborted"))
		return "cancelled";
	return isError ? "error" : "ok";
}

function assistantTextPhase(signature: unknown): "commentary" | "final_answer" | undefined {
	if (typeof signature !== "string" || !signature.startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(signature);
		if (
			value === null ||
			typeof value !== "object" ||
			!("v" in value) ||
			value.v !== 1 ||
			!("id" in value) ||
			typeof value.id !== "string" ||
			!("phase" in value)
		)
			return undefined;
		return value.phase === "commentary" || value.phase === "final_answer" ? value.phase : undefined;
	} catch {
		return undefined;
	}
}

/** provider 给的思考摘要：只取字符串项，忽略其它形态。 */
function thinkingSummariesOf(summary: unknown): string[] {
	if (!Array.isArray(summary)) return [];
	const out: string[] = [];
	for (const item of summary) {
		if (typeof item === "string") {
			if (item.trim() !== "") out.push(item);
			continue;
		}
		if (item !== null && typeof item === "object" && "text" in item) {
			const text = (item as { text?: unknown }).text;
			if (typeof text === "string" && text.trim() !== "") out.push(text);
		}
	}
	return out;
}

/** provider 给的引用：只保留有标题或地址的条目。 */
export function citationsOf(raw: unknown): Citation[] {
	if (!Array.isArray(raw)) return [];
	const out: Citation[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const citation = item as Citation;
		const title = typeof citation.title === "string" && citation.title.trim() !== "" ? citation.title : undefined;
		const url = typeof citation.url === "string" && citation.url.trim() !== "" ? citation.url : undefined;
		const snippet =
			typeof citation.snippet === "string" && citation.snippet.trim() !== "" ? citation.snippet : undefined;
		if (title === undefined && url === undefined && snippet === undefined) continue;
		out.push({
			...(title !== undefined ? { title } : {}),
			...(url !== undefined ? { url } : {}),
			...(snippet !== undefined ? { snippet } : {}),
			...(typeof citation.startIndex === "number" ? { startIndex: citation.startIndex } : {}),
			...(typeof citation.endIndex === "number" ? { endIndex: citation.endIndex } : {}),
			...(typeof citation.source === "string" ? { source: citation.source } : {}),
		});
	}
	return out;
}

/**
 * 从 wire 的 content 重建 segments。
 * 流式阶段已经为思考块记了起止时刻，重建时按顺序把它们接回去，
 * 否则 message_end 会把思考时长冲掉。
 */ function segmentsOf(content: unknown, previous?: AssistantSegment[]): AssistantSegment[] {
	if (!Array.isArray(content)) return typeof content === "string" ? [{ kind: "text", text: content }] : [];
	let thinkingIndex = 0;
	return content.flatMap((part): AssistantSegment[] => {
		if (part.type === "text") {
			const phase = assistantTextPhase(part.textSignature);
			const citations = citationsOf(part.citations);
			return [
				{
					kind: "text",
					text: part.text ?? "",
					...(phase ? { phase } : {}),
					...(citations.length > 0 ? { citations } : {}),
				},
			];
		}
		if (part.type === "thinking") {
			const timed = previous?.filter((segment) => segment.kind === "thinking")[thinkingIndex++];
			const summaries = thinkingSummariesOf(part.summaries);
			return [
				{
					kind: "thinking",
					text: part.thinking ?? "",
					...(timed?.startedAt !== undefined ? { startedAt: timed.startedAt } : {}),
					...(timed?.endedAt !== undefined ? { endedAt: timed.endedAt } : {}),
					...(summaries.length > 0 ? { summaries } : {}),
				},
			];
		}
		if (part.type === "toolCall") return [{ kind: "tool", toolId: part.id }];
		return [];
	});
}

/**
 * 把引用并进最后一段正文。
 *
 * 引用事件可能晚于正文段到达（流式尾巴），所以只往已有的正文段上挂，
 * 绝不新开一段空正文。
 */
function appendCitations(entry: AssistantEntry, citations: Citation[]): void {
	if (citations.length === 0) return;
	const last = entry.segments?.at(-1);
	if (last?.kind !== "text") return;
	last.citations = [...(last.citations ?? []), ...citations];
}

function appendSegment(
	entry: AssistantEntry,
	kind: "text" | "thinking",
	text: string,
	phase?: "commentary" | "final_answer",
	at?: number,
	summaries?: string[],
	citations?: Citation[],
): void {
	const segments = (entry.segments ??= []);
	const last = segments.at(-1);
	if (last?.kind === kind && (last.kind !== "text" || last.phase === phase)) {
		last.text += text;
		// 思考块的计时从第一段增量开始，到下一段内容到达时结算。
		if (last.kind === "thinking" && at !== undefined) {
			last.startedAt ??= at;
			last.endedAt = at;
		}
		// provider 给的思考摘要随 thinking_start 一起到，补进已建的思考段。
		if (last.kind === "thinking" && summaries !== undefined && summaries.length > 0) {
			last.summaries = [...(last.summaries ?? []), ...summaries];
		}
		// 引用随引用事件逐条到，补进已建的正文段。
		if (last.kind === "text" && citations !== undefined && citations.length > 0) {
			last.citations = [...(last.citations ?? []), ...citations];
		}
		return;
	}
	// 新的一段开始：上一段思考到此结束，计时在这里结算。
	if (last?.kind === "thinking" && at !== undefined) last.endedAt = at;
	if (kind === "text")
		segments.push({
			kind,
			text,
			...(phase ? { phase } : {}),
			...(citations !== undefined && citations.length > 0 ? { citations } : {}),
		});
	else
		segments.push({
			kind,
			text,
			...(at !== undefined ? { startedAt: at } : {}),
			...(summaries !== undefined && summaries.length > 0 ? { summaries } : {}),
		});
}

/**
 * 把模型写的组标题贴到这批工具卡上。
 *
 * 事件带的是一批工具调用 id（Claude 的 `precedingToolUseIds`），标题写进
 * 组内每一张卡，渲染时取任意一张即可 —— 这样即使前端的分组边界和
 * 服务端的批次边界不完全一致，也不会丢标题。
 */
function applyBatchLabel(entries: ChatEntry[], toolCallIds: string[], label: string): ChatEntry[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.kind !== "assistant") continue;
		if (!entry.tools.some((tool) => toolCallIds.includes(tool.id))) continue;
		const updated = cloneAssistant(entry);
		for (const card of updated.tools) {
			if (toolCallIds.includes(card.id)) card.batchLabel = label;
		}
		return [...entries.slice(0, index), updated, ...entries.slice(index + 1)];
	}
	return entries;
}

function applyToolResult(
	entries: ChatEntry[],
	toolCallId: unknown,
	result: AnyEvent,
	isError: boolean,
	toolName?: string,
): ChatEntry[] {
	if (typeof toolCallId === "string") {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (sealsActiveTurn(entry)) break;
			if (entry.kind !== "assistant" || !entry.tools.some((tool) => tool.id === toolCallId)) continue;
			const updated = cloneAssistant(entry);
			const card = updated.tools.find((tool) => tool.id === toolCallId)!;
			card.status = resultStatus(result, isError);
			card.output = toolOutputOf(result);
			card.finishedAt = typeof result.timestamp === "number" ? result.timestamp : (card.finishedAt ?? Date.now());
			applyNestedCallRecords(updated, toolCallId, result);
			return [...entries.slice(0, index), updated, ...entries.slice(index + 1)];
		}
		// A result from a sealed turn cannot become an artifact of the current question.
		if (entries.some((entry) => entry.kind === "assistant" && entry.tools.some((tool) => tool.id === toolCallId)))
			return entries;
	}
	if (resultStatus(result, isError) !== "ok") return entries;
	const sourceName = toolName ?? result.toolName ?? "tool";
	if (publishedResults([{ ...result, role: "toolResult", toolName: sourceName, isError }]).length === 0)
		return entries;
	const output = toolOutputOf(result);
	if (!output.researchResult) return entries;
	const orphan: Extract<ChatEntry, { kind: "toolResult" }> = {
		kind: "toolResult",
		toolName: sourceName,
		ok: true,
		brief: firstTextLine(output.text) || t("err.briefNoOutput", { status: t("err.completed") }),
		researchResult: output.researchResult,
	};
	// Execution and persisted-message events describe the same successful publication.
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (sealsActiveTurn(entry)) break;
		if (
			entry.kind === "toolResult" &&
			entry.toolName === orphan.toolName &&
			entry.researchResult?.id === orphan.researchResult?.id
		) {
			return [...entries.slice(0, index), orphan, ...entries.slice(index + 1)];
		}
	}
	return [...entries, orphan];
}

function applyNestedCallRecords(entry: AssistantEntry, parentToolCallId: string, result: AnyEvent): void {
	for (const call of result.nestedCalls?.calls ?? []) {
		if (typeof call.id !== "string" || typeof call.name !== "string") continue;
		const card = upsertTool(entry, call.id, call.name, call.arguments);
		card.parentToolCallId = parentToolCallId;
		card.status =
			call.status === "unfinished"
				? "cancelled"
				: call.status === "error"
					? resultStatus(
							{ content: [{ type: "text", text: typeof call.error === "string" ? call.error : "" }] },
							true,
						)
					: call.status === "ok"
						? "ok"
						: "pending";
		// Nested snapshots persist errors/arguments, but do not contain successful result bodies.
		if (typeof call.error === "string" && !card.output)
			card.output = { text: call.error, totalLines: call.error.split("\n").length };
	}
}

/** Apply one bridge event to the transcript. Returns a new array (immutably). */
export function applyEvent(entries: ChatEntry[], message: ServerEventMessage): ChatEntry[] {
	const next = applyTranscriptEvent(entries, message);
	if ((message.event as AnyEvent).type === "agent_settled") {
		// A later synthetic idle-stop event must not relabel the completed run as paused.
		runBoundaries.delete(next);
		restoredRunBoundaries.delete(next);
		return next;
	}
	const boundary = runBoundaries.get(entries);
	if (boundary !== undefined && next !== entries && !runBoundaries.has(next)) runBoundaries.set(next, boundary);
	const restoredBoundary = restoredRunBoundaries.get(entries);
	if (restoredBoundary !== undefined && next !== entries && !restoredRunBoundaries.has(next))
		restoredRunBoundaries.set(next, restoredBoundary);
	return next;
}

/**
 * 为 agent_end 权威重建构造 entryIds 对齐数组：本轮 run 的消息对应原转录末尾的
 * 那几条同角色消息行（普通轮各 1 条；steering 多条也按序尾部对齐），把它们的
 * entryId 带回重建结果——否则回答一结束，回退按钮（用户行）和「在新对话中分支」
 * （assistant 行）都会因为拿不到条目 id 而消失。
 */
function alignMessageEntryIds(previous: ChatEntry[], messages: AnyEvent[]): (string | undefined)[] | undefined {
	const queues: { user: string[]; assistant: string[] } = { user: [], assistant: [] };
	for (const entry of previous) {
		if ((entry.kind === "user" || entry.kind === "assistant") && entry.entryId)
			queues[entry.kind].push(entry.entryId);
	}
	const counts: { user: number; assistant: number } = { user: 0, assistant: 0 };
	for (const message of messages) {
		if (message.role === "user" || message.role === "assistant") counts[message.role as "user" | "assistant"] += 1;
	}
	if (counts.user === 0 && counts.assistant === 0) return undefined;
	// 尾部对齐：某角色原转录里没有足够的带 id 行（老桥/异常流）时，该角色拿不到 id 不硬凑
	// （暂停后继续的 run 快照没有 user 消息，user 角色自然落空，assistant 照常对齐）。
	const cursors: { user: number; assistant: number } = {
		user: queues.user.length - counts.user,
		assistant: queues.assistant.length - counts.assistant,
	};
	return messages.map((message) => {
		if (message.role !== "user" && message.role !== "assistant") return undefined;
		const queue = queues[message.role as "user" | "assistant"];
		const index = cursors[message.role as "user" | "assistant"]++;
		return index >= 0 ? queue[index] : undefined;
	});
}

/** 自动重试横幅状态：由 auto_retry_start / auto_retry_end 事件驱动，独立于转录条目——
 * 每次重试轮的 agent_end 权威重建会重排条目，横幅状态不能寄存在 entries 里。 */
export type RetryBannerState =
	| { phase: "retrying"; attempt: number; maxAttempts: number; delayMs: number; startedAt: number; reason?: string }
	| { phase: "failed"; attempt: number; reason?: string; requestFailed?: boolean };

/** 从桥事件流提取自动重试横幅状态；无关事件返回原引用（React 可跳过重渲染）。 */
export function applyRetryEvent(state: RetryBannerState | null, message: ServerEventMessage): RetryBannerState | null {
	const event = (message.event ?? {}) as AnyEvent;
	if (event.type === "agent_start" || (event.type === "agent_settled" && event.aborted === true)) return null;
	if (event.type === "auto_retry_start") {
		return {
			phase: "retrying",
			attempt: typeof event.attempt === "number" ? event.attempt : 1,
			maxAttempts: typeof event.maxAttempts === "number" ? event.maxAttempts : 0,
			delayMs: typeof event.delayMs === "number" ? event.delayMs : 0,
			startedAt: Date.now(),
			reason: formatProviderError(typeof event.errorMessage === "string" ? event.errorMessage : undefined),
		};
	}
	if (event.type === "auto_retry_end") {
		if (event.success === true) return null;
		// 用户手动停止触发 _finishCancelledRetry（agent-session.ts 的固定文案）：
		// 主动取消不算"重试失败"，清掉横幅即可（转录里已有 cancelled 状态）。
		if (event.finalError === "Retry cancelled") return null;
		return {
			phase: "failed",
			attempt: typeof event.attempt === "number" ? event.attempt : 0,
			reason: formatProviderError(typeof event.finalError === "string" ? event.finalError : undefined),
			...(event.requestFailed === true ? { requestFailed: true } : {}),
		};
	}
	return state;
}

function applyTranscriptEvent(entries: ChatEntry[], message: ServerEventMessage): ChatEntry[] {
	const event = message.event as AnyEvent;
	switch (event.type) {
		case "agent_start": {
			const next = [...entries];
			// App already appended a newly submitted user message; continuation runs have no new user.
			const boundary = entries.at(-1)?.kind === "user" ? entries.length - 1 : entries.length;
			runBoundaries.set(next, boundary);
			return next;
		}
		case "agent_settled": {
			const boundary = runBoundaries.get(entries) ?? restoredRunBoundaries.get(entries);
			if (event.aborted !== true || boundary === undefined) return entries;
			const index = entries.findLastIndex((entry, index) => index >= boundary && entry.kind === "assistant");
			const previous = entries[index];
			if (previous?.kind !== "assistant" || previous.error) return entries;
			const current = cloneAssistant(previous);
			current.aborted = true;
			for (const tool of current.tools) {
				if (tool.status === "pending" || tool.status === "running") tool.status = "cancelled";
			}
			return [...entries.slice(0, index), current, ...entries.slice(index + 1)];
		}
		case "entry_appended": {
			// 会话日志条目落盘事件：给乐观追加、还没有 entryId 的用户消息行补上条目 id
			// （owl-rewind 的回退按钮靠它定位目标）；assistant 行同理补 id——
			// 「在新对话中分支」按钮要求回答行带条目 id。其余条目类型与转录无关。
			const entry = (event as { entry?: { type?: string; message?: { role?: string } } }).entry;
			if (entry?.type !== "message") return entries;
			const role = entry.message?.role;
			const appendedId = (entry as { id?: string }).id;
			if (role === "user") {
				for (let index = entries.length - 1; index >= 0; index--) {
					const candidate = entries[index]!;
					if (candidate.kind !== "user") break;
					if (candidate.entryId) break; // 已有 id 的更早用户消息：本轮的乐观行还没到
					return [...entries.slice(0, index), { ...candidate, entryId: appendedId }, ...entries.slice(index + 1)];
				}
				return entries;
			}
			if (role !== "assistant" || typeof appendedId !== "string") return entries;
			// 回答行按落盘顺序逐条对号（一轮多次 LLM 调用各有一次落盘事件）：
			// 从尾部找最近一条还没拿到 id 的 assistant 行；已有 id 说明事件过期/乱序，不动。
			for (let index = entries.length - 1; index >= 0; index--) {
				const candidate = entries[index]!;
				if (candidate.kind !== "assistant") continue;
				if (candidate.entryId) break;
				return [...entries.slice(0, index), { ...candidate, entryId: appendedId }, ...entries.slice(index + 1)];
			}
			return entries;
		}
		case "message_start": {
			const message = event.message as AnyEvent | undefined;
			// 用户消息送达：先摘掉发送时乐观追加的同文 queued 占位行（FIFO 取最早一条，
			// 正式行按到达顺序追加在尾部——此后 entry_appended 才能从尾部给它补条目 id）；
			// 没有占位行时走空闲乐观行合并/直接追加的老路。
			if (message?.role === "user") {
				const delivered = userEntryOf(message);
				const queuedRow = entries.find(
					(entry): entry is Extract<ChatEntry, { kind: "user" }> =>
						entry.kind === "user" &&
						entry.queued === true &&
						userSourceText(entry.text) === userSourceText(delivered.text),
				);
				if (queuedRow) {
					const queuedIndex = entries.indexOf(queuedRow);
					const replacement =
						delivered.omittedImages && !queuedRow.omittedImages
							? { ...queuedRow, queued: undefined, omittedImages: delivered.omittedImages }
							: { ...delivered };
					return [...entries.slice(0, queuedIndex), ...entries.slice(queuedIndex + 1), replacement];
				}
				const last = entries.at(-1);
				if (last?.kind === "user" && userSourceText(last.text) === userSourceText(delivered.text)) {
					if (!delivered.omittedImages || last.omittedImages) return entries;
					return [...entries.slice(0, -1), { ...last, omittedImages: delivered.omittedImages }];
				}
				return [...entries, delivered];
			}
			// 只给 assistant 建流式气泡，否则每轮会多出带空"思考过程"的空气泡。
			if (!message || message.role !== "assistant") return entries;
			return [
				...entries,
				{
					kind: "assistant",
					text: "",
					thinking: "",
					tools: [],
					segments: [],
					timestamp: timestampOf(message) ?? Date.now(),
				},
			];
		}
		case "message_update": {
			const ae = event.assistantMessageEvent as AnyEvent | undefined;
			if (!ae) return entries;
			const previous = lastAssistant(entries);
			if (!previous) return entries;
			const current = cloneAssistant(previous);
			const index = entries.indexOf(previous);
			switch (ae.type) {
				case "text_delta":
					current.text += ae.delta ?? "";
					appendSegment(
						current,
						"text",
						ae.delta ?? "",
						assistantTextPhase(ae.partial?.content?.[ae.contentIndex]?.textSignature),
						Date.now(),
					);
					break;
				case "text_citation": {
					// 引用逐条到达（Claude Desktop 用它做行内角标 + 来源面板）。
					const citations = citationsOf(ae.citation ? [ae.citation] : []);
					if (citations.length > 0) appendCitations(current, citations);
					break;
				}
				case "thinking_delta":
					current.thinking += ae.delta ?? "";
					appendSegment(
						current,
						"thinking",
						ae.delta ?? "",
						undefined,
						Date.now(),
						thinkingSummariesOf(ae.partial?.content?.[ae.contentIndex]?.summaries),
					);
					break;
				case "toolcall_start": {
					const toolCall = ae.partial?.content?.[ae.contentIndex];
					upsertTool(
						current,
						ae.id ?? ae.toolCall?.id ?? toolCall?.id ?? `tool-${ae.contentIndex}`,
						ae.toolName ?? ae.toolCall?.name ?? toolCall?.name ?? "tool",
					);
					break;
				}
				case "toolcall_end": {
					if (ae.toolCall?.id)
						upsertTool(
							current,
							ae.toolCall.id,
							ae.toolCall.name ?? "tool",
							ae.toolCall.arguments ?? {},
							ae.toolCall.hiddenInChat,
						);
					break;
				}
				default:
					break;
			}
			if (
				(ae.type === "text_delta" || ae.type === "thinking_delta" || ae.type === "toolcall_delta") &&
				typeof ae.delta === "string" &&
				ae.delta !== ""
			) {
				const now = Date.now();
				const estTokens = (current.stream?.estTokens ?? 0) + estimateTokens(ae.delta);
				current.stream = { firstAt: current.stream?.firstAt ?? now, lastAt: now, estTokens };
			}
			return [...entries.slice(0, index), { ...current }, ...entries.slice(index + 1)];
		}
		case "tool_execution_start":
		case "tool_execution_update": {
			const previous = lastAssistant(entries);
			if (!previous || typeof event.toolCallId !== "string") return entries;
			// Nested tool calls belong to their parent's assistant, not a later streamed answer.
			const owner = entries.findLast(
				(entry) =>
					entry.kind === "assistant" &&
					entry.tools.some((tool) => tool.id === event.toolCallId || tool.id === event.parentToolCallId),
			);
			const target =
				owner?.kind === "assistant" &&
				entries.indexOf(owner) > entries.findLastIndex((entry) => entry.kind === "user")
					? owner
					: previous;
			const current = cloneAssistant(target);
			const card = upsertTool(current, event.toolCallId, event.toolName ?? "tool", event.args);
			if (typeof event.parentToolCallId === "string") card.parentToolCallId = event.parentToolCallId;
			if (card.status === "pending" || card.status === "running") {
				card.status = "running";
				card.startedAt ??= Date.now();
				if (event.type === "tool_execution_update" && event.partialResult)
					card.output = toolOutputOf(event.partialResult);
			}
			const index = entries.indexOf(target);
			return [...entries.slice(0, index), current, ...entries.slice(index + 1)];
		}
		case "tool_execution_end":
			return applyToolResult(entries, event.toolCallId, event.result ?? {}, event.isError === true, event.toolName);
		case "tool_use_summary": {
			// 模型为这批工具写的组标题（Claude 的 tool_use_summary）。
			const summary = typeof event.summary === "string" ? event.summary.trim() : "";
			const ids = Array.isArray(event.toolCallIds)
				? event.toolCallIds.filter((id): id is string => typeof id === "string")
				: [];
			if (summary === "" || ids.length === 0) return entries;
			return applyBatchLabel(entries, ids, summary);
		}
		case "message_end": {
			const message = event.message as AnyEvent | undefined;
			if (!message) return entries;
			if (message.role === "toolResult")
				return applyToolResult(entries, message.toolCallId, message, message.isError === true, message.toolName);
			if (message.role !== "assistant") return entries;
			const previous = lastAssistant(entries);
			if (!previous) return entries;
			const current = cloneAssistant(previous);
			const index = entries.indexOf(previous);
			const text = (message.content ?? [])
				.filter((part: AnyEvent) => part.type === "text")
				.map((part: AnyEvent) => part.text)
				.join("\n");
			for (const part of message.content ?? []) {
				if (part.type !== "toolCall") continue;
				const call = part as AnyEvent & { hiddenInChat?: unknown };
				const card = upsertTool(current, part.id, part.name, part.arguments ?? {}, call.hiddenInChat === true);
				if (card.status === "pending" && (message.stopReason === "error" || message.stopReason === "aborted"))
					card.status = message.stopReason === "aborted" ? "cancelled" : "error";
			}
			// A flooded tool-call batch is removed from the assistant message before this
			// event. Drop the cards that were streamed and then discarded.
			const keptToolIds = new Set(
				(message.content ?? [])
					.filter((part: AnyEvent) => part.type === "toolCall")
					.map((part: AnyEvent) => part.id),
			);
			current.tools = current.tools.filter((tool) => keptToolIds.has(tool.id));
			current.segments = segmentsOf(message.content, current.segments);
			current.thinking =
				(message.content ?? [])
					.filter((part: AnyEvent) => part.type === "thinking")
					.map((part: AnyEvent) => part.thinking ?? "")
					.join("\n") || current.thinking;
			// 用户暂停（stopReason=aborted）不算错误：红色报错换成一个 aborted 标记，
			// 由 ChatStream 渲染成置灰小字；只有真正的 error 才保留报错文案。
			current.error = message.stopReason === "error" ? formatProviderError(message.errorMessage) : undefined;
			current.aborted = message.stopReason === "aborted" ? true : undefined;
			// wire 时间戳是响应开始时刻；此刻（本地）才是真实结束点，记下来供轮耗时用
			const endedAt = Date.now();
			// 消息结束时结算最后一段思考：它后面没有新内容，计时在这里收口。
			const lastSegment = current.segments.at(-1);
			if (lastSegment?.kind === "thinking" && lastSegment.endedAt === undefined) lastSegment.endedAt = endedAt;
			const startedAt = timestampOf(message);
			if (startedAt !== undefined) {
				rememberAssistantEndedAt(startedAt, endedAt);
				if (current.stream) rememberAssistantStream(startedAt, current.stream);
			}
			return [
				...entries.slice(0, index),
				{
					...current,
					text: text || current.text,
					timestamp: startedAt ?? current.timestamp,
					...(startedAt !== undefined ? { endedAt } : {}),
					usage: usageOf(message) ?? current.usage,
					model: modelOf(message) ?? current.model,
				},
				...entries.slice(index + 1),
			];
		}
		case "agent_end": {
			// Authoritative rebuild: messages include tool results the stream didn't show.
			// 注意 event.messages 只含"本轮" agent run（从本次 user 消息起），不含更早轮次——
			// 整表替换会把历史覆盖掉（表现为"一回答完，前面的对话全没了"）。
			// 因此只重建最后一条用户消息之后的部分，之前的转录原样保留。
			const messages = (event.messages ?? []) as AnyEvent[];
			// 重建出的消息行不带 entryId（回退按钮与分支按钮都靠它）：按尾部对齐从现有
			// 转录的同角色消息行取回（本轮 run 的消息 = 原转录末尾的那 N 条，steering 也对齐）。
			const rebuilt = rebuild(messages, alignMessageEntryIds(entries, messages));
			const runBoundary = runBoundaries.get(entries);
			const finish = (next: ChatEntry[]): ChatEntry[] => retainUndeliveredFollowUps(entries, next, messages);
			if (runBoundary !== undefined) {
				const prefix = entries.slice(0, runBoundary);
				// Some hosts omit the already-displayed user from the run snapshot.
				if (!messages.some((message) => message.role === "user") && entries[runBoundary]?.kind === "user")
					prefix.push(entries[runBoundary]);
				const next = [...prefix, ...rebuilt];
				runBoundaries.set(next, runBoundary);
				return finish(next);
			}
			// Snapshot replay can begin without agent_start; retain the legacy user-turn fallback.
			let lastUser = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (sealsActiveTurn(entries[i]!)) {
					lastUser = i;
					break;
				}
			}
			if (lastUser === -1) return finish(entries.length > 0 ? entries : rebuilt);
			// Continue/retry runs may omit the already-displayed user message.
			const keepUser = !messages.some((message) => message.role === "user");
			return finish([...entries.slice(0, lastUser + (keepUser ? 1 : 0)), ...rebuilt]);
		}
		default:
			return entries;
	}
}

/** Rebuild the transcript from a full AgentMessage[] snapshot.
 *  entryIds（可选）与 messages 按下标对齐：会话快照带条目 id 时，用户消息行
 *  与 assistant 消息行都能带上 entryId（回退/分支按钮用）。 */
export function rebuild(
	messages: AnyEvent[],
	entryIds?: ReadonlyArray<string | undefined>,
	run?: { running: boolean; runStartMessageIndex?: number },
): ChatEntry[] {
	const entries: ChatEntry[] = [];
	const rawBoundary =
		run?.running && Number.isInteger(run.runStartMessageIndex) ? run.runStartMessageIndex : undefined;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		// Wire indices include hidden/system/tool messages that produce no separate UI row.
		if (messageIndex === rawBoundary) restoredRunBoundaries.set(entries, entries.length);
		const message = messages[messageIndex]!;
		const entryId = entryIds?.[messageIndex];
		if (message.role === "user") {
			entries.push(userEntryOf(message, entryId));
		} else if (message.role === "assistant") {
			const tools: ToolCard[] = (message.content ?? [])
				.filter((part: AnyEvent) => part.type === "toolCall")
				.map((part: AnyEvent) => ({
					id: part.id,
					name: part.name,
					args: JSON.stringify(part.arguments ?? {}),
					...summarizeToolCall(part.name, part.arguments),
					status:
						message.stopReason === "aborted"
							? ("cancelled" as const)
							: message.stopReason === "error"
								? ("error" as const)
								: ("pending" as const),
				}));
			const startedAt = timestampOf(message);
			const persistedAt =
				typeof message.persistedAt === "number" && Number.isFinite(message.persistedAt)
					? message.persistedAt
					: undefined;
			const endedAt =
				(startedAt !== undefined ? assistantEndedAt.get(startedAt) : undefined) ??
				(persistedAt !== undefined && (startedAt === undefined || persistedAt > startedAt)
					? persistedAt
					: undefined);
			const stream = startedAt !== undefined ? assistantStream.get(startedAt) : undefined;
			entries.push({
				kind: "assistant",
				text: textOf(message.content),
				thinking: (message.content ?? [])
					.filter((part: AnyEvent) => part.type === "thinking")
					.map((part: AnyEvent) => part.thinking ?? "")
					.join("\n"),
				tools,
				segments: segmentsOf(message.content),
				error: message.stopReason === "error" ? formatProviderError(message.errorMessage) : undefined,
				...(message.stopReason === "aborted" ? { aborted: true as const } : {}),
				...(typeof entryId === "string" ? { entryId } : {}),
				...(startedAt !== undefined ? { timestamp: startedAt } : {}),
				...(endedAt !== undefined ? { endedAt } : {}),
				...(stream !== undefined ? { stream } : {}),
				...(usageOf(message) !== undefined ? { usage: usageOf(message) } : {}),
				...(modelOf(message) !== undefined ? { model: modelOf(message) } : {}),
			});
		} else if (message.role === "toolResult") {
			// 结果不再单独成行：挂回对应工具卡（时间轴按「工具」组织，成败随之）
			const output = toolOutputOf(message);
			const card = findToolCard(entries, message.toolCallId);
			if (card) {
				card.status = resultStatus(message, message.isError === true);
				card.output = output;
				// 结果消息自带时间戳：历史轮工具卡的「完成时间」从这里来
				if (timestampOf(message) !== undefined) card.finishedAt ??= timestampOf(message);
				const owner = entries.findLast((entry) => entry.kind === "assistant" && entry.tools.includes(card));
				if (owner?.kind === "assistant") applyNestedCallRecords(owner, card.id, message);
			} else {
				// 找不到所属调用（防御）：退回独立的兜底行
				entries.push({
					kind: "toolResult",
					toolName: message.toolName ?? "tool",
					ok: !message.isError,
					brief:
						firstTextLine(output.text) ||
						t("err.briefNoOutput", { status: message.isError ? t("err.failed") : t("err.completed") }),
					...(resultStatus(message, message.isError === true) === "ok" && output.researchResult
						? { researchResult: output.researchResult }
						: {}),
				});
			}
		}
	}
	if (rawBoundary === messages.length) restoredRunBoundaries.set(entries, entries.length);
	return entries;
}

/** 线上的用户消息带着核心拼的附件清单与图片提示，拆开后才是用户看到的那一行。 */
function userEntryOf(message: AnyEvent, entryId?: string): Extract<ChatEntry, { kind: "user" }> {
	const parsed = parseUserMessage(textOf(message.content));
	const images = contentImagesOf(message.content);
	const timestamp = timestampOf(message);
	return {
		kind: "user",
		text: parsed.body,
		...(message.queued === true ? { queued: true as const } : {}),
		...(typeof entryId === "string" ? { entryId } : {}),
		...(images.length > 0 ? { images } : {}),
		...(parsed.attachedPaths.length > 0 ? { attachedPaths: parsed.attachedPaths } : {}),
		...(parsed.omittedImages > 0 ? { omittedImages: parsed.omittedImages } : {}),
		...(timestamp !== undefined ? { timestamp } : {}),
	};
}

/** 按 toolCallId 向前找所属工具卡（结果总在调用之后）。 */
function findToolCard(entries: ChatEntry[], toolCallId: unknown): ToolCard | undefined {
	if (typeof toolCallId !== "string") return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (sealsActiveTurn(entry)) return undefined;
		if (entry.kind !== "assistant") continue;
		const card = entry.tools.find((tool) => tool.id === toolCallId);
		if (card) return card;
	}
	return undefined;
}

/** 把 toolResult 消息解码成结构化输出：纯文本拼接（不再 stringify 数组）、图片、全文路径。 */
function toolOutputOf(message: AnyEvent): ToolOutput {
	const content = (message.content ?? []) as AnyEvent[];
	const text = content
		.filter((part: AnyEvent) => part.type === "text")
		.map((part: AnyEvent) => part.text ?? "")
		.join("\n");
	const images = content
		.filter((part: AnyEvent) => part.type === "image" && part.data)
		.map((part: AnyEvent) => ({ data: part.data, mimeType: part.mimeType ?? "image/png" }));
	const details = (message.details ?? {}) as AnyEvent;
	const researchResult = message.isError === true ? undefined : researchResultOf(details.researchResult);
	const artifacts: ToolResultArtifact[] = [];
	if (Array.isArray(details.artifacts)) {
		for (const item of details.artifacts) {
			if (item && typeof item.path === "string" && ["written", "edited", "opened"].includes(item.action)) {
				artifacts.push({ path: item.path, action: item.action });
			}
		}
	}
	// 任务清单快照：只有结构完整的项才进清单（渲染成行内清单卡）。
	const todos: TaskListItem[] = [];
	if (Array.isArray(details.todos)) {
		for (const item of details.todos) {
			if (item === null || typeof item !== "object") continue;
			const entry = item as { content?: unknown; status?: unknown; priority?: unknown };
			if (typeof entry.content !== "string" || entry.content.trim() === "") continue;
			const status = entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending";
			const priority =
				entry.priority === "high" || entry.priority === "low"
					? entry.priority
					: entry.priority === "medium"
						? "medium"
						: undefined;
			todos.push({ content: entry.content.trim(), status, ...(priority !== undefined ? { priority } : {}) });
		}
	}
	// 下一步建议（details.steps）：只有结构完整的项才上屏。
	const nextSteps: NextStep[] = [];
	if (Array.isArray(details.steps)) {
		for (const item of details.steps) {
			if (item === null || typeof item !== "object") continue;
			const step = item as { label?: unknown; prompt?: unknown };
			if (typeof step.label !== "string" || step.label.trim() === "") continue;
			const label = step.label.trim();
			const prompt = typeof step.prompt === "string" && step.prompt.trim() !== "" ? step.prompt.trim() : label;
			nextSteps.push({ label, prompt });
		}
	}
	// 提问的答案（owl-ask-user 的 details.answers）：投影成「问题 → 用户回答」
	// 对，渲染成 Claude 的响应列表（Yc）；未作答按它的占位写法。
	const questionAnswers: { question: string; response: string }[] = [];
	if (Array.isArray(details.answers)) {
		for (const item of details.answers) {
			if (item === null || typeof item !== "object") continue;
			const entry = item as { question?: unknown; kind?: unknown; answer?: unknown; selected?: unknown };
			if (typeof entry.question !== "string" || entry.question.trim() === "") continue;
			const placeholder = "（未作答）";
			let response = placeholder;
			if (entry.kind === "multi" && Array.isArray(entry.selected) && entry.selected.length > 0)
				response =
					entry.selected.filter((part): part is string => typeof part === "string").join("、") || placeholder;
			else if (typeof entry.answer === "string" && entry.answer.trim() !== "") response = entry.answer;
			questionAnswers.push({ question: entry.question, response });
		}
	}
	return {
		text,
		totalLines: text === "" ? 0 : text.split("\n").length,
		...(images.length > 0 ? { images } : {}),
		...(typeof details.title === "string" && details.title.trim() !== "" ? { title: details.title.trim() } : {}),
		...(artifacts.length > 0 ? { artifacts } : {}),
		...(todos.length > 0 ? { todos } : {}),
		...(nextSteps.length > 0 ? { nextSteps } : {}),
		...(questionAnswers.length > 0 ? { questionAnswers } : {}),
		// 子代理的实时活动（owl-subagents partial details.activity）：组内行下的动态一行。
		...(typeof details.activity === "string" && details.activity.trim() !== ""
			? { activity: details.activity.trim().slice(0, 200) }
			: {}),
		...(typeof details.fullOutputPath === "string" ? { fullPath: details.fullOutputPath } : {}),
		...(details.genuiSpec !== undefined ? { genuiSpec: details.genuiSpec } : {}),
		...(researchResult ? { researchResult } : {}),
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** 从 assistant 消息上取 token 用量；没有或全 0 视为无（旧会话/异常流不上屏用量）。 */
function usageOf(message: AnyEvent): MessageUsage | undefined {
	const usage = message.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const num = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
	const parsed: MessageUsage = {
		input: num(usage.input),
		output: num(usage.output),
		cacheRead: num(usage.cacheRead),
		cacheWrite: num(usage.cacheWrite),
	};
	const total = parsed.input + parsed.output + parsed.cacheRead + parsed.cacheWrite;
	return total > 0 ? parsed : undefined;
}

/** 消息时间戳（wire 上 AgentMessage 自带；旧桥/异常流可能缺）。 */
function timestampOf(message: AnyEvent): number | undefined {
	return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) && message.timestamp > 0
		? message.timestamp
		: undefined;
}

/** 消息上的模型 id（仅 assistant）。 */
function modelOf(message: AnyEvent): string | undefined {
	return typeof message.model === "string" && message.model !== "" ? message.model : undefined;
}

/** 消息 content 里的图片块（用户随 prompt 附图、会话恢复后重建转录都要带出来）。 */
function contentImagesOf(content: unknown): ToolResultImage[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part: AnyEvent) => part.type === "image" && typeof part.data === "string" && part.data !== "")
		.map((part: AnyEvent) => ({
			data: part.data,
			mimeType: typeof part.mimeType === "string" && part.mimeType !== "" ? part.mimeType : "image/png",
		}));
}

function firstTextLine(text: string): string {
	return text.split("\n").find((part) => part.trim() !== "") ?? "";
}
