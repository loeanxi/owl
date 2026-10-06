import type { ResearchResult, ServerEventMessage } from "../bridge/protocol.ts";
import { researchResultOf } from "../features/research/research-results.ts";
import { t } from "../i18n/index.ts";
import { summarizeToolCall } from "./summarize.ts";

export type ToolStatus = "pending" | "running" | "ok" | "error" | "cancelled";

/** 原始消息内容的时间顺序；不从文字猜测进度或最终回答的模型通道。 */
export type AssistantSegment =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool"; toolId: string };

/** 工具结果里的图片内容块（base64；如 browser_screenshot 的返回）。 */
export type ToolResultImage = { data: string; mimeType: string };
export type ToolResultArtifact = { path: string; action: "written" | "edited" | "opened" };

/** 工具输出：已从 content 解码成纯文本，不再是 JSON 字符串。 */
export type ToolOutput = {
	text: string;
	totalLines: number;
	images?: ToolResultImage[];
	/** Plugin-produced files, taken from the successful tool result rather than assistant prose. */
	artifacts?: ToolResultArtifact[];
	/** bash 等超限截断时，服务端把全文写入的临时文件路径（details.fullOutputPath）。 */
	fullPath?: string;
	/** owl-genui：render_ui 工具修复后的 GenUI spec（details.genuiSpec），ChatStream 渲染为交互卡片。 */
	genuiSpec?: unknown;
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
};

/** 单条 LLM 回复的 token 用量（消息操作栏的「用量」展示）。 */
export type MessageUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type ChatEntry =
	| {
			kind: "user";
			text: string;
			images?: ToolResultImage[];
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
	  }
	/** 仅防御性保留：结果找不到所属工具卡时的兜底行（如会话恢复失败）。 */
	| { kind: "toolResult"; toolName: string; ok: boolean; brief: string };

type AnyEvent = Record<string, any>; // wire events are forward-compat; render defensively

/** Run boundaries belong to UI snapshots, never to messages or model-visible text. */
const runBoundaries = new WeakMap<ChatEntry[], number>();

/**
 * assistant 消息的真实结束时刻（message_end 到达的本地时钟）。wire 上的
 * message.timestamp 是响应「开始」时刻（pi-ai 构造消息时取 Date.now()），
 * 不含生成耗时——轮耗时标注靠这张表找回结束点。键 = 消息开始时间戳
 * （快照重建时消息仍带着同一个值，agent_end 权威重建因此不丢）；应用重启后
 * 的历史会话找不到回退为开始时刻。键冲突概率可忽略（单会话同时只有一条流）。
 */
const assistantEndedAt = new Map<number, number>();
const ASSISTANT_ENDED_AT_MAX = 1000;

function rememberAssistantEndedAt(startedAt: number, endedAt: number): void {
	while (assistantEndedAt.size >= ASSISTANT_ENDED_AT_MAX) {
		const oldest = assistantEndedAt.keys().next().value;
		if (oldest === undefined) break;
		assistantEndedAt.delete(oldest);
	}
	assistantEndedAt.set(startedAt, Math.max(endedAt, assistantEndedAt.get(startedAt) ?? 0));
}

/**
 * 把供应商错误整理成可读中文。OpenAI 兼容 SDK 的报错形如
 * `429: {"code":"1308","message":"已达到 5 小时的使用上限。…"}`，
 * 裸上屏是一坨 JSON —— 这里解析出状态码与 message 再映射；解析不出就原样放行。
 */
export function formatProviderError(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const match = raw.match(/^\s*(\d{3})\s*[:\-]\s*(\{[\s\S]*\})\s*$/);
	if (match) {
		const status = match[1]!;
		let message = "";
		try {
			const body = JSON.parse(match[2]!) as { message?: string; error?: { message?: string } };
			message = body.message ?? body.error?.message ?? "";
		} catch {
			// body 不是 JSON：走下面的兜底文案
		}
		if (status === "429") return t("err.rateLimited", { message: message || t("err.rateLimitedFallback") });
		if (status === "401" || status === "403") return t("err.keyInvalid", { message: message || raw });
		if (status.startsWith("5")) return t("err.serverUnavailable", { status, message: message || t("err.retryLater") });
		if (message) return t("err.httpStatus", { message, status });
	}
	return raw;
}

/** 已落盘的用户消息才切开当前轮。排队中的跟进还没轮到，不能挡住正在写的回答。 */
function sealsActiveTurn(entry: ChatEntry): boolean {
	return entry.kind === "user" && entry.queued !== true;
}

/** 快照里第一条用户消息是本轮开场白。其后的用户消息才是已经送达的跟进。 */
function retainUndeliveredFollowUps(before: ChatEntry[], next: ChatEntry[], messages: AnyEvent[]): ChatEntry[] {
	const pending = before.filter((entry): entry is Extract<ChatEntry, { kind: "user" }> => entry.kind === "user" && entry.queued === true);
	if (pending.length === 0) return next;
	const delivered = new Map<string, number>();
	let skippedOpeningUser = false;
	for (const message of messages) {
		if (message.role !== "user") continue;
		if (!skippedOpeningUser) {
			skippedOpeningUser = true;
			continue;
		}
		const text = textOf(message.content);
		delivered.set(text, (delivered.get(text) ?? 0) + 1);
	}
	const kept: ChatEntry[] = [];
	for (const entry of pending) {
		const count = delivered.get(entry.text) ?? 0;
		if (count > 0) delivered.set(entry.text, count - 1);
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
	return { ...entry, tools: entry.tools.map((tool) => ({ ...tool })), segments: entry.segments?.map((segment) => ({ ...segment })) ?? [] };
}

function upsertTool(entry: AssistantEntry, id: string, name: string, args?: unknown): ToolCard {
	let card = entry.tools.find((tool) => tool.id === id);
	if (!card) {
		card = { id, name, args: "", summary: name, status: "pending" };
		entry.tools.push(card);
		(entry.segments ??= []).push({ kind: "tool", toolId: id });
	}
	card.name = name;
	if (args !== undefined) {
		card.args = JSON.stringify(args);
		Object.assign(card, summarizeToolCall(name, args));
	}
	return card;
}

function resultStatus(result: AnyEvent, isError: boolean): ToolStatus {
	// 普通失败不当作取消；这里仅识别工具明确标志及 agent-core 的标准中止结果。
	if (result.details?.cancelled === true || (isError && textOf(result.content).trim() === "Operation aborted")) return "cancelled";
	return isError ? "error" : "ok";
}

function segmentsOf(content: unknown): AssistantSegment[] {
	if (!Array.isArray(content)) return typeof content === "string" ? [{ kind: "text", text: content }] : [];
	return content.flatMap((part): AssistantSegment[] => {
		if (part.type === "text") return [{ kind: "text", text: part.text ?? "" }];
		if (part.type === "thinking") return [{ kind: "thinking", text: part.thinking ?? "" }];
		if (part.type === "toolCall") return [{ kind: "tool", toolId: part.id }];
		return [];
	});
}

function appendSegment(entry: AssistantEntry, kind: "text" | "thinking", text: string): void {
	const segments = (entry.segments ??= []);
	const last = segments.at(-1);
	if (last?.kind === kind) last.text += text;
	else segments.push({ kind, text });
}

function applyToolResult(entries: ChatEntry[], toolCallId: unknown, result: AnyEvent, isError: boolean): ChatEntry[] {
	if (typeof toolCallId !== "string") return entries;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (sealsActiveTurn(entry)) break;
		if (entry.kind !== "assistant" || !entry.tools.some((tool) => tool.id === toolCallId)) continue;
		const updated = cloneAssistant(entry);
		const card = updated.tools.find((tool) => tool.id === toolCallId)!;
		card.status = resultStatus(result, isError);
		card.output = toolOutputOf(result);
		card.finishedAt = typeof result.timestamp === "number" ? result.timestamp : card.finishedAt ?? Date.now();
		applyNestedCallRecords(updated, toolCallId, result);
		return [...entries.slice(0, index), updated, ...entries.slice(index + 1)];
	}
	return entries;
}

function applyNestedCallRecords(entry: AssistantEntry, parentToolCallId: string, result: AnyEvent): void {
	for (const call of result.nestedCalls?.calls ?? []) {
		if (typeof call.id !== "string" || typeof call.name !== "string") continue;
		const card = upsertTool(entry, call.id, call.name, call.arguments);
		card.parentToolCallId = parentToolCallId;
		card.status = call.status === "unfinished" ? "cancelled" : call.status === "error" ? "error" : call.status === "ok" ? "ok" : "pending";
		// Nested snapshots persist errors/arguments, but do not contain successful result bodies.
		if (typeof call.error === "string" && !card.output) card.output = { text: call.error, totalLines: call.error.split("\n").length };
	}
}

/** Apply one bridge event to the transcript. Returns a new array (immutably). */
export function applyEvent(entries: ChatEntry[], message: ServerEventMessage): ChatEntry[] {
	const next = applyTranscriptEvent(entries, message);
	const boundary = runBoundaries.get(entries);
	if (boundary !== undefined && next !== entries && !runBoundaries.has(next)) runBoundaries.set(next, boundary);
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
		if ((entry.kind === "user" || entry.kind === "assistant") && entry.entryId) queues[entry.kind].push(entry.entryId);
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
	| { phase: "failed"; attempt: number; reason?: string };

/** 从桥事件流提取自动重试横幅状态；无关事件返回原引用（React 可跳过重渲染）。 */
export function applyRetryEvent(state: RetryBannerState | null, message: ServerEventMessage): RetryBannerState | null {
	const event = (message.event ?? {}) as AnyEvent;
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
			// system/user 消息由 sendPrompt 或 rebuild 负责入列，这里只给 assistant 建流式气泡，
			// 否则每轮会多出带空"思考过程"的空气泡。
			const message = event.message as AnyEvent | undefined;
			if (!message || message.role !== "assistant") return entries;
			return [...entries, { kind: "assistant", text: "", thinking: "", tools: [], segments: [] }];
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
					appendSegment(current, "text", ae.delta ?? "");
					break;
				case "thinking_delta":
					current.thinking += ae.delta ?? "";
					appendSegment(current, "thinking", ae.delta ?? "");
					break;
				case "toolcall_start": {
					const toolCall = ae.partial?.content?.[ae.contentIndex];
					upsertTool(current, ae.id ?? ae.toolCall?.id ?? toolCall?.id ?? `tool-${ae.contentIndex}`, ae.toolName ?? ae.toolCall?.name ?? toolCall?.name ?? "tool");
					break;
				}
				case "toolcall_end": {
					if (ae.toolCall?.id) upsertTool(current, ae.toolCall.id, ae.toolCall.name ?? "tool", ae.toolCall.arguments ?? {});
					break;
				}
				default:
					break;
			}
			return [...entries.slice(0, index), { ...current }, ...entries.slice(index + 1)];
		}
		case "tool_execution_start":
		case "tool_execution_update": {
			const previous = lastAssistant(entries);
			if (!previous || typeof event.toolCallId !== "string") return entries;
			// Nested tool calls belong to their parent's assistant, not a later streamed answer.
			const owner = entries.findLast((entry) => entry.kind === "assistant" && entry.tools.some((tool) => tool.id === event.toolCallId || tool.id === event.parentToolCallId));
			const target = owner?.kind === "assistant" && entries.indexOf(owner) > entries.findLastIndex((entry) => entry.kind === "user") ? owner : previous;
			const current = cloneAssistant(target);
			const card = upsertTool(current, event.toolCallId, event.toolName ?? "tool", event.args);
			if (typeof event.parentToolCallId === "string") card.parentToolCallId = event.parentToolCallId;
			if (card.status === "pending" || card.status === "running") {
				card.status = "running";
				card.startedAt ??= Date.now();
				if (event.type === "tool_execution_update" && event.partialResult) card.output = toolOutputOf(event.partialResult);
			}
			const index = entries.indexOf(target);
			return [...entries.slice(0, index), current, ...entries.slice(index + 1)];
		}
		case "tool_execution_end":
			return applyToolResult(entries, event.toolCallId, event.result ?? {}, event.isError === true);
		case "message_end": {
			const message = event.message as AnyEvent | undefined;
			if (!message) return entries;
			if (message.role === "toolResult") return applyToolResult(entries, message.toolCallId, message, message.isError === true);
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
				const card = upsertTool(current, part.id, part.name, part.arguments ?? {});
				if (card.status === "pending" && (message.stopReason === "error" || message.stopReason === "aborted")) card.status = message.stopReason === "aborted" ? "cancelled" : "error";
			}
			current.segments = segmentsOf(message.content);
			current.thinking = (message.content ?? []).filter((part: AnyEvent) => part.type === "thinking").map((part: AnyEvent) => part.thinking ?? "").join("\n") || current.thinking;
			// 用户暂停（stopReason=aborted）不算错误：红色报错换成一个 aborted 标记，
			// 由 ChatStream 渲染成置灰小字；只有真正的 error 才保留报错文案。
			current.error = message.stopReason === "error" ? formatProviderError(message.errorMessage) : undefined;
			current.aborted = message.stopReason === "aborted" ? true : undefined;
			// wire 时间戳是响应开始时刻；此刻（本地）才是真实结束点，记下来供轮耗时用
			const endedAt = Date.now();
			const startedAt = timestampOf(message);
			if (startedAt !== undefined) rememberAssistantEndedAt(startedAt, endedAt);
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
				if (!messages.some((message) => message.role === "user") && entries[runBoundary]?.kind === "user") prefix.push(entries[runBoundary]);
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
export function rebuild(messages: AnyEvent[], entryIds?: ReadonlyArray<string | undefined>): ChatEntry[] {	const entries: ChatEntry[] = [];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex]!;
		const entryId = entryIds?.[messageIndex];
		if (message.role === "user") {
			const images = contentImagesOf(message.content);
			entries.push({
				kind: "user",
				text: textOf(message.content),
				...(typeof entryId === "string" ? { entryId } : {}),
				...(images.length > 0 ? { images } : {}),
				...(timestampOf(message) !== undefined ? { timestamp: timestampOf(message) } : {}),
			});
		} else if (message.role === "assistant") {
			const tools: ToolCard[] = (message.content ?? [])
				.filter((part: AnyEvent) => part.type === "toolCall")
				.map((part: AnyEvent) => ({
					id: part.id,
					name: part.name,
					args: JSON.stringify(part.arguments ?? {}),
					...summarizeToolCall(part.name, part.arguments),
					status: message.stopReason === "aborted" ? "cancelled" as const : message.stopReason === "error" ? "error" as const : "pending" as const,
				}));
			const startedAt = timestampOf(message);
			const endedAt = startedAt !== undefined ? assistantEndedAt.get(startedAt) : undefined;
			entries.push({
				kind: "assistant",
				text: textOf(message.content),
				thinking: (message.content ?? [])
					.filter((part: AnyEvent) => part.type === "thinking")
					.map((part: AnyEvent) => part.thinking ?? "")
					.join("\n"),
				tools,
				segments: segmentsOf(message.content),
				error:
					message.stopReason === "error"
						? formatProviderError(message.errorMessage)
						: undefined,
				...(message.stopReason === "aborted" ? { aborted: true as const } : {}),
				...(typeof entryId === "string" ? { entryId } : {}),
				...(startedAt !== undefined ? { timestamp: startedAt } : {}),
				...(endedAt !== undefined ? { endedAt } : {}),
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
					brief: firstTextLine(output.text) || t("err.briefNoOutput", { status: message.isError ? t("err.failed") : t("err.completed") }),
				});
			}
		}
	}
	return entries;
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
	return {
		text,
		totalLines: text === "" ? 0 : text.split("\n").length,
		...(images.length > 0 ? { images } : {}),
		...(artifacts.length > 0 ? { artifacts } : {}),
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
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
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
	return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) && message.timestamp > 0 ? message.timestamp : undefined;
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
		.map((part: AnyEvent) => ({ data: part.data, mimeType: typeof part.mimeType === "string" && part.mimeType !== "" ? part.mimeType : "image/png" }));
}

function firstTextLine(text: string): string {
	return text.split("\n").find((part) => part.trim() !== "") ?? "";
}
