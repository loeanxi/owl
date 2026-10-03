/**
 * system 消息回带 — 移植自 billion-context-pi src/system-passthrough.ts（MIT）。
 * [#477] owl 把活跃工具集挂在会话 system 消息上（toolsAdded），provider 适配层
 * 从 transcript 的 system 消息推导请求 tools。ACP 从持久化条目重建发送视图，
 * 条目里从不含 system 消息，重建会把它丢掉 —— 把输入里的 system 消息回带：
 *   - 重建结果没有 system → 原样前置输入的（content/sections/toolsAdded 全保留）；
 *   - 有 → 只补缺失字段，不覆盖已有值。
 * 输入没有 system 时严格 no-op（返回同一引用）。
 */
import type { SessionMessageEntry } from "@owl/owl-coding-agent";

type AgentMessage = SessionMessageEntry["message"];

function isSystem(message: unknown): boolean {
	return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "system";
}

export function carryHostSystemMessages(rebuilt: AgentMessage[], input: AgentMessage[]): AgentMessage[] {
	const inputSystems = input.filter(isSystem);
	if (inputSystems.length === 0) return rebuilt;

	const rebuiltSystems = rebuilt.filter(isSystem);
	if (rebuiltSystems.length === 0) return [...inputSystems, ...rebuilt];

	let changed = false;
	let sysIdx = 0;
	const patched = rebuilt.map((message) => {
		if (!isSystem(message)) return message;
		const source = inputSystems[sysIdx++];
		if (!source) return message;
		const out = message as unknown as Record<string, unknown>;
		const src = source as unknown as Record<string, unknown>;
		let next: Record<string, unknown> | null = null;
		for (const key of Object.keys(src)) {
			if (out[key] === undefined && src[key] !== undefined) {
				next ??= { ...out };
				next[key] = src[key];
			}
		}
		if (next !== null) {
			changed = true;
			return next as unknown as AgentMessage;
		}
		return message;
	});
	return changed ? patched : rebuilt;
}
