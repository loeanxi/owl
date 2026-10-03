/**
 * 请求时 reasoning 丢弃 — 移植自 billion-context-pi src/reasoning-drop.ts（MIT）。
 *
 * compress 调用被内核硬保护、不可再压缩，其 thinking 随每轮请求往返成为
 * 不可回收的底线。本 pass 在请求视图里剥掉「已闭合 round」的 compress
 * thinking（持久化历史不动，只改本轮发送视图）。默认开启，DeepSeek 等
 * 严格回显上游自动关闭（[#361]）。
 */
import type { SessionMessageEntry } from "@owl/owl-coding-agent";

type AgentMessage = SessionMessageEntry["message"];

export interface CompressReasoningConfig {
	/** 总开关，默认 true。 */
	drop?: boolean;
	/** thinking 字符量超过该阈值才剥。 */
	threshold?: number;
}

export const DEFAULT_COMPRESS_REASONING: Required<CompressReasoningConfig> = { drop: true, threshold: 2048 };

export function resolveReasoningDrop(cfg?: CompressReasoningConfig): Required<CompressReasoningConfig> {
	let threshold = DEFAULT_COMPRESS_REASONING.threshold;
	if (cfg?.threshold !== undefined) {
		const t = cfg.threshold;
		if (typeof t === "number" && Number.isFinite(t) && t >= 0) threshold = Math.floor(t);
	}
	return { drop: cfg?.drop !== false, threshold };
}

/** 严格回显 thinking 的上游（DeepSeek thinking 模式）要求 reasoning_content
 *  逐字往返；重建后的请求丢了闭合 round 的 reasoning 会被 400。按
 *  provider/baseUrl 静态探测，命中时强制关闭 drop。 */
export function isStrictReasoningEcho(provider?: string, baseUrl?: string): boolean {
	return /deepseek/i.test(baseUrl ?? "") || /deepseek/i.test(provider ?? "");
}

export function applyStrictReasoningGate(
	cfg: Required<CompressReasoningConfig>,
	provider?: string,
	baseUrl?: string,
): Required<CompressReasoningConfig> {
	if (!cfg.drop || !isStrictReasoningEcho(provider, baseUrl)) return cfg;
	return { ...cfg, drop: false };
}

function isThinking(part: unknown): part is { type: "thinking"; thinking: string } {
	const p = part as { type?: string; thinking?: unknown };
	return p?.type === "thinking" && typeof p.thinking === "string";
}

function compressCallIds(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((p) => {
			const b = p as { type?: string; name?: string };
			return b?.type === "toolCall" && b.name === "compress";
		})
		.map((p) => (p as { id?: unknown }).id)
		.filter((id): id is string => typeof id === "string");
}

function resultIndexByCallId(messages: AgentMessage[]): Map<string, number> {
	const map = new Map<string, number>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as { role?: string; toolCallId?: unknown };
		if (msg?.role !== "toolResult" || typeof msg.toolCallId !== "string") continue;
		if (!map.has(msg.toolCallId)) map.set(msg.toolCallId, i);
	}
	return map;
}

function reasoningLength(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.reduce((n, p) => (isThinking(p) ? n + p.thinking.length : n), 0);
}

export function countThinkingChars(messages: AgentMessage[]): number {
	return messages.reduce((n, m) => n + reasoningLength((m as { content?: unknown }).content), 0);
}

/**
 * 剥 thinking 的三个门（全部满足才动一条消息）：
 *  1. round 已闭合：消息里每个 compress toolCall 的 toolResult 都在更晚的
 *     下标上，且 result 之后至少还有一条消息（round 已实质前进）；
 *  2. 选择器：消息携带 name==="compress" 的 toolCall；
 *  3. 体量：该消息 thinking 总长严格超过 threshold 字符。
 * 纯函数：不改输入；幂等；失败安全（异常时原样返回）。
 */
export function dropCompressReasoning(messages: AgentMessage[], cfg?: CompressReasoningConfig): AgentMessage[] {
	const { drop, threshold } = resolveReasoningDrop(cfg);
	if (!drop || messages.length === 0) return messages;
	try {
		const last = messages.length - 1;
		const resultAt = resultIndexByCallId(messages);
		let changed = false;
		const out = messages.slice();
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i] as { role?: string; content?: unknown } | undefined;
			if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			const calls = compressCallIds(msg.content);
			if (calls.length === 0) continue;
			// 门 1：全部闭合（有 result 且 result 不是最后一条消息）。
			const closed = calls.every((id) => {
				const ri = resultAt.get(id);
				return ri !== undefined && ri > i && ri < last;
			});
			if (!closed) continue;
			// 门 3：体量。
			if (reasoningLength(msg.content) <= threshold) continue;
			const filtered = (msg.content as unknown[]).filter((p) => !isThinking(p));
			if (filtered.length === (msg.content as unknown[]).length) continue;
			out[i] = { ...(msg as object), content: filtered } as AgentMessage;
			changed = true;
		}
		return changed ? out : messages;
	} catch {
		return messages;
	}
}
