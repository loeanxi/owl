/**
 * 消息转换层 — 移植自 billion-context-pi src/messages.ts（MIT）。
 *
 * owl(pi) 会话条目 ↔ acp-kernel CoreMessage 的双向投影：
 *  - entriesToCoreMessages：持久化条目 → 内核输入（稳定 id = 条目 id）；
 *  - coreOutToAgentMessages：内核折叠视图 → 发给模型的 owl 消息
 *    （还原原始消息对象、注入/搬运 <acp> 引用标签、按内核裁剪同步）。
 *
 * 引用标签形如 <acp tokens="2.1K" type="bash">m00175</acp>，是内核给每条
 * 消息铸的稳定引用号（mNNNNN），模型用它在 compress 调用里圈定压缩区间。
 */
import type { SessionEntry, SessionMessageEntry } from "@owl/owl-coding-agent";
import { defaultCountTokens, type CoreMessage } from "./kernel.js";
import { rewriteTagTokens } from "./tag-tokens.js";

type AgentMessage = SessionMessageEntry["message"];

type AnyMessage = {
	role?: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	command?: string;
	output?: unknown;
	summary?: string;
};

const REF_TAG_SOURCE = "(?:\x3cacp\\s[^>]*\x3em\\d{5}\x3c/acp\x3e|\\[m\\d{1,5}\\])";
const REF_TAG = new RegExp(`^${REF_TAG_SOURCE}\\s?\\n?`);
const TRAILING_REF_TAG = new RegExp(`\\n*${REF_TAG_SOURCE}\\s*$`);

/** nudge 持久化记录（经 pi.appendEntry 写 type:"custom" 条目）——
 *  永不投影进发送视图，重启后仍可在会话文件里看到注入历史。 */
export const ACP_NUDGE_CUSTOM_TYPE = "acp-nudge";
export interface AcpNudgeRecord {
	text: string;
}

/** 不参与 LLM 上下文的 custom_message 类型（UI 面板/文档类）。 */
const CONTEXT_EXCLUDED_CUSTOM_TYPES = new Set<string>(["acp-status", "acp-export", "acp-rule"]);

export function isCustomMessageEntry(entry: SessionEntry): entry is SessionEntry & { type: "custom_message" } {
	if (entry.type !== "custom_message") return false;
	if (entry.customType !== undefined && CONTEXT_EXCLUDED_CUSTOM_TYPES.has(entry.customType)) return false;
	return extractText(entry.content).length > 0;
}

export function entriesToCoreMessages(entries: SessionEntry[]): CoreMessage[] {
	const out: CoreMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") {
			// custom_message 按 owl 原生语义参与 LLM 上下文 —— 投影为 user 消息。
			if (isCustomMessageEntry(entry)) {
				const text = extractText(entry.content);
				if (text.length > 0) {
					out.push({ id: entry.id, role: "user", contentType: "text", text });
				}
			}
			continue;
		}
		const cores = projectMessage(entry.message, entry.id);
		out.push(...cores);
	}
	return out;
}

function projectMessage(message: AgentMessage, id: string): CoreMessage[] {
	const msg = message as AnyMessage;
	const role = msg.role;
	if (role === "user") {
		return [{ id, role: "user", contentType: "text", text: extractText(msg.content) }];
	}
	if (role === "toolResult") {
		return [
			{
				id,
				role: "tool",
				contentType: "tool-result",
				toolName: msg.toolName,
				toolCallId: msg.toolCallId,
				text: extractText(msg.content),
			},
		];
	}
	if (role === "assistant") {
		// thinking 随每轮请求往返但不进文本投影 —— 以 thinkingTokens 计量
		// （挂在本 turn 输出的第一条 core 上）。
		const thinking = thinkingTokenCount(msg.content);
		const thinkingField = thinking > 0 ? { thinkingTokens: thinking } : {};
		const calls = allToolCalls(msg.content);
		if (calls.length > 0) {
			const textParts = extractText(msg.content);
			if (calls.length === 1) {
				const call = calls[0]!;
				const argStr = stringifyArgs(call.arguments);
				const text = argStr && textParts ? `${textParts}\n${argStr}` : argStr || textParts;
				return [{ id, role: "assistant", contentType: "tool-call", toolName: call.name, toolCallId: call.id, text, ...thinkingField }];
			}
			return calls.map((call, i) => {
				const argStr = stringifyArgs(call.arguments);
				return {
					id: `${id}#${call.id}`,
					role: "assistant" as const,
					contentType: "tool-call" as const,
					toolName: call.name,
					toolCallId: call.id,
					text: argStr || textParts,
					...(i === 0 ? thinkingField : {}),
				};
			});
		}
		const text = extractText(msg.content);
		// 纯 thinking 轮次丢弃：空的 assistant 文本会让 OpenAI 兼容上游 400。
		if (!text.trim()) return [];
		return [{ id, role: "assistant", contentType: "text", text, ...thinkingField }];
	}
	const customText = extractText(msg.content) || fallbackText(msg);
	return customText.length > 0 ? [{ id, role: "user", contentType: "text", text: customText }] : [];
}

function fallbackText(msg: AnyMessage): string {
	const parts: string[] = [];
	if (msg.command) parts.push(`$ ${msg.command}`);
	const out = extractText(msg.output);
	if (out) parts.push(out);
	if (msg.summary) parts.push(msg.summary);
	return parts.join("\n").trim();
}

function stringifyArgs(args: unknown): string {
	if (!args) return "";
	if (typeof args === "string") return args;
	return safeStringify(args);
}

export function extractText(content: unknown): string {
	if (typeof content === "string") return stripRefTag(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(stripRefTag(b.text));
	}
	return parts.join("\n");
}

// thinking 块对 extractText 不可见但每轮都在请求里 —— 计量其体量让内核
// 计数看到完整载荷。
export function thinkingTokenCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	const parts: string[] = [];
	for (const block of content) {
		const b = block as { type?: string; thinking?: string };
		if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
	}
	return parts.length > 0 ? defaultCountTokens(parts.join("\n")) : 0;
}

function stripRefTag(text: string): string {
	return text.replace(REF_TAG, "").replace(TRAILING_REF_TAG, "");
}

export function countImageBlocks(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const block of content) {
		const b = block as { type?: string };
		if (b?.type === "image") n++;
	}
	return n;
}

export function messageRef(message: unknown): string | undefined {
	if (message === null || typeof message !== "object" || !("content" in message)) return undefined;
	const content = message.content;
	const texts =
		typeof content === "string"
			? [content]
			: Array.isArray(content)
				? content.flatMap((block) => {
						const value = block as { type?: string; text?: string };
						return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
					})
				: [];
	for (const text of texts) {
		const tag = text.match(REF_TAG)?.[0] ?? text.match(TRAILING_REF_TAG)?.[0];
		const ref = tag?.match(/m\d{1,5}/)?.[0];
		if (ref) return ref;
	}
	return undefined;
}

/** 内核输出 → owl AgentMessage 列表。
 *  摘要消息（acp_summary_*）由内核 prune 注入、不经此转换（prune 已生成
 *  可直接发送的 system 消息）；此处还原其余原始消息并同步引用标签。 */
export function coreOutToAgentMessages(coreOut: CoreMessage[], originalById: Map<string, AgentMessage>): AgentMessage[] {
	const out: AgentMessage[] = [];
	const emittedSplit = new Set<string>();
	const kernelTextByCallId = new Map<string, string>();
	for (const core of coreOut) {
		if (core.contentType === "tool-call" && core.toolCallId && core.text) {
			kernelTextByCallId.set(core.toolCallId, core.text);
		}
	}

	for (const core of coreOut) {
		if (core.id.startsWith("acp_summary_")) continue;

		const hashIdx = core.id.indexOf("#");
		if (hashIdx < 0) {
			const original = originalById.get(core.id);
			if (original) out.push(patchRefTag(original, core));
			continue;
		}

		const baseId = core.id.substring(0, hashIdx);
		if (emittedSplit.has(baseId)) continue;
		emittedSplit.add(baseId);

		const original = originalById.get(baseId);
		if (!original) continue;

		const survivingCallIds = new Set(
			coreOut
				.filter((c) => c.id.startsWith(`${baseId}#`) && !c.id.startsWith("acp_summary_"))
				.map((c) => c.toolCallId)
				.filter((id): id is string => !!id),
		);

		out.push(reconstructToolCallMessage(original, core, survivingCallIds, kernelTextByCallId));
	}

	return out;
}

function compactedArgsFrom(kernelText: string | undefined, originalArgs: unknown): unknown | null {
	if (!kernelText) return null;
	const start = kernelText.indexOf("{");
	if (start < 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(kernelText.slice(start));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	if (safeStringify(parsed) === safeStringify(originalArgs)) return null;
	return parsed;
}

function syncToolCallArgs(blocks: unknown[], kernelTextFor: (callId: string) => string | undefined): unknown[] {
	let changed = false;
	const out = blocks.map((block) => {
		const b = block as { type?: string; id?: string; arguments?: unknown };
		if (b.type !== "toolCall" || !b.id) return block;
		const compacted = compactedArgsFrom(kernelTextFor(b.id), b.arguments);
		if (compacted === null) return block;
		changed = true;
		return { ...b, arguments: compacted };
	});
	return changed ? out : blocks;
}

function reconstructToolCallMessage(
	original: AgentMessage,
	firstCore: CoreMessage,
	survivingCallIds: Set<string>,
	kernelTextByCallId: Map<string, string>,
): AgentMessage {
	const base = original as AnyMessage;
	const match = firstCore.text ? firstCore.text.match(REF_TAG) : null;
	const tag = match ? match[0] : null;

	if (base.role === "assistant" || !tag) {
		const rawBlocks: unknown[] = Array.isArray(base.content)
			? base.content
			: typeof base.content === "string"
				? [{ type: "text", text: base.content }]
				: [];
		const filtered = rawBlocks.filter((block) => {
			const b = block as { type?: string; id?: string };
			if (b.type === "toolCall") return survivingCallIds.has(b.id ?? "");
			return true;
		});
		const peeled = syncToolCallArgs(peelRefTagBlocks(filtered), (callId) => kernelTextByCallId.get(callId));
		return { ...(original as object), content: peeled } as AgentMessage;
	}

	const rawBlocks: unknown[] = Array.isArray(base.content)
		? base.content
		: typeof base.content === "string"
			? [{ type: "text", text: base.content }]
			: [];

	const filtered = rawBlocks.filter((block) => {
		const b = block as { type?: string; id?: string };
		if (b.type === "toolCall") return survivingCallIds.has(b.id ?? "");
		return true;
	});

	const peeled = syncToolCallArgs(peelRefTagBlocks(filtered), (callId) => kernelTextByCallId.get(callId));
	const stableTag = rewriteTagTokens(tag, coreBodyOf(firstCore.text ?? "", tag));
	const lastTextIdx = [...peeled].reverse().findIndex((b) => (b as { type?: string }).type === "text");
	if (lastTextIdx >= 0) {
		const idx = peeled.length - 1 - lastTextIdx;
		const lastBlock = peeled[idx] as { type: string; text: string };
		const baseText = lastBlock.text ?? "";
		peeled[idx] = { ...lastBlock, text: baseText.length > 0 ? `${baseText}\n\n${stableTag}` : stableTag };
		return { ...(original as object), content: peeled } as AgentMessage;
	}
	return { ...(original as object), content: [{ type: "text", text: stableTag }, ...peeled] } as AgentMessage;
}

function coreBodyOf(coreText: string, tag: string): string {
	const tagCore = tag.replace(/\s+$/, "");
	let bodyStart = tagCore.length;
	if (coreText.charAt(bodyStart) === "\n") bodyStart += 1;
	return coreText.slice(bodyStart);
}

function patchRefTag(original: AgentMessage, core: CoreMessage): AgentMessage {
	const base = original as AnyMessage;
	// assistant 消息不打标签 —— 模型看到自己历史回复上的标签会回声。
	// 它可以从相邻的带标签消息推断 assistant 消息的 ref。
	if (base.role === "assistant") {
		if (core.contentType === "tool-call" && core.toolCallId) {
			const rawBlocks = Array.isArray(base.content) ? base.content : [];
			const synced = syncToolCallArgs(rawBlocks, (callId) => (callId === core.toolCallId ? core.text : undefined));
			if (synced !== rawBlocks) {
				return { ...(original as object), content: synced } as AgentMessage;
			}
		}
		return original;
	}
	const match = core.text ? core.text.match(REF_TAG) : null;
	const tag = match ? match[0] : null;
	if (!tag) return original;
	// 尊重内核对消息体的改写（紧急截断大工具结果等）：body 变了就按内核重建。
	const coreBody = coreBodyOf(core.text ?? "", tag);
	const originalBody = extractText(base.content);
	const trimEnd = (s: string): string => s.replace(/\s+$/, "");
	if (coreBody && trimEnd(coreBody) !== trimEnd(originalBody)) {
		return rebuildBodyFromCore(original, coreBody, rewriteTagTokens(tag, coreBody));
	}
	const stableTag = rewriteTagTokens(tag, originalBody);
	const rawBlocks = Array.isArray(base.content)
		? base.content
		: typeof base.content === "string"
			? [{ type: "text" as const, text: base.content }]
			: [];
	const peeled = peelRefTagBlocks(rawBlocks);

	const newBlocks = [...peeled];
	let injected = false;
	for (let i = newBlocks.length - 1; i >= 0; i--) {
		const b = newBlocks[i] as { type?: string; text?: string };
		if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) {
			const baseText = b.text.replace(/\n*$/, "");
			newBlocks[i] = { ...b, text: `${baseText}\n\n${stableTag}` };
			injected = true;
			break;
		}
	}
	if (injected) {
		return { ...(original as object), content: newBlocks } as AgentMessage;
	}

	return {
		...(original as object),
		content: [...peeled, { type: "text" as const, text: stableTag }],
	} as AgentMessage;
}

function rebuildBodyFromCore(original: AgentMessage, coreBody: string, tag: string): AgentMessage {
	const base = original as AnyMessage;
	const text = `${coreBody.replace(/\s+$/, "")}\n\n${tag}`;
	if (typeof base.content === "string") {
		return { ...(original as object), content: text } as AgentMessage;
	}
	if (Array.isArray(base.content)) {
		const nonText = base.content.filter((b) => (b as { type?: string }).type !== "text");
		return {
			...(original as object),
			content: [...nonText, { type: "text" as const, text }],
		} as AgentMessage;
	}
	return { ...(original as object), content: [{ type: "text" as const, text }] } as AgentMessage;
}

function peelRefTagBlocks(blocks: unknown[]): unknown[] {
	const out: unknown[] = [];
	for (const block of blocks) {
		const b = block as { type?: string; text?: string };
		if (b?.type === "text" && typeof b.text === "string") {
			const stripped = stripRefTag(b.text);
			if (stripped.length > 0 || b.text.length === 0) out.push({ ...b, text: stripped });
		} else {
			out.push(block);
		}
	}
	return out;
}

function allToolCalls(content: unknown): { name: string; id: string; arguments?: unknown }[] {
	if (!Array.isArray(content)) return [];
	const calls: { name: string; id: string; arguments?: unknown }[] = [];
	for (const block of content) {
		const b = block as { type?: string; name?: string; id?: string; arguments?: unknown };
		if (b.type === "toolCall" && b.name) calls.push({ name: b.name, id: b.id ?? "", arguments: b.arguments });
	}
	return calls;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** 折叠渲染的 originals 表：条目 id → 原始 AgentMessage。
 *  custom_message 按 owl convertToLlm 的投影还原为 user 消息。 */
export function collectOriginals(entries: SessionEntry[]): Map<string, AgentMessage> {
	const map = new Map<string, AgentMessage>();
	for (const entry of entries) {
		if (entry.type === "message") {
			map.set(entry.id, entry.message);
		} else if (entry.type === "custom_message") {
			const content =
				typeof entry.content === "string" ? [{ type: "text" as const, text: entry.content }] : entry.content;
			map.set(entry.id, { role: "user", content } as AgentMessage);
		}
	}
	return map;
}
