/**
 * 工具对完整性兜底 — 移植自 billion-context-pi src/tool-pair-sanitizer.ts（MIT）。
 * [#505] 压缩/剪枝本身是 pair 感知的，但万一有孤儿 toolResult 漏网
 * （其配对的 assistant toolCall 已不可见），发到上游会被 400 拒掉整个请求。
 * 有向单向：没有 result 的 toolCall 是「在途」，不动。纯函数、幂等、失败安全。
 */
import type { SessionMessageEntry } from "@owl/owl-coding-agent";

type AgentMessage = SessionMessageEntry["message"];
type AnyBlock = { type?: string; id?: string };

export interface ToolPairSanitizeResult {
	// 无丢弃时返回同一引用（字节级不变，前缀缓存稳定）。
	messages: AgentMessage[];
	// 被丢弃的孤儿 toolResult 的 toolCallId；无 id 的记 "(missing toolCallId)"。
	droppedResults: string[];
}

type RoleMsg = { role?: string; content?: unknown; toolCallId?: unknown };

export function sanitizeToolPairing(messages: AgentMessage[]): ToolPairSanitizeResult {
	const empty: ToolPairSanitizeResult = { messages, droppedResults: [] };
	if (!Array.isArray(messages) || messages.length === 0) return empty;
	try {
		const callIds = new Set<string>();
		for (const raw of messages) {
			const msg = raw as RoleMsg | null | undefined;
			if (!msg || typeof msg !== "object" || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const b of msg.content as AnyBlock[]) {
				if (b && b.type === "toolCall" && typeof b.id === "string" && b.id.length > 0) callIds.add(b.id);
			}
		}

		let changed = false;
		const out: AgentMessage[] = [];
		const droppedResults: string[] = [];
		for (const raw of messages) {
			const msg = raw as RoleMsg | null | undefined;
			if (msg && typeof msg === "object" && msg.role === "toolResult") {
				const tcid = msg.toolCallId;
				const label = typeof tcid === "string" && tcid.length > 0 ? tcid : "(missing toolCallId)";
				if (typeof tcid !== "string" || tcid.length === 0 || !callIds.has(tcid)) {
					droppedResults.push(label);
					changed = true;
					continue;
				}
			}
			out.push(raw);
		}

		return changed ? { messages: out, droppedResults } : empty;
	} catch {
		return empty;
	}
}
