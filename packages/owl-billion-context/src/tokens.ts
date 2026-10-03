/**
 * token 计量 — 移植自 billion-context-pi src/tokens.ts（MIT，有删减）。
 * 去掉了 #561 的跨轮 sent-view 记账（稳态每轮做一次探针重测，正确性优先，
 * 该插件为实验定位、性能优化留待后续）。
 */

import type { SessionMessageEntry } from "@owl/owl-coding-agent";
import {
	type CompressionCore,
	type CompressionState,
	type Config,
	type CoreMessage,
	defaultCountTokens,
} from "./kernel.js";
import { countImageBlocks } from "./messages.js";

type AgentMessage = SessionMessageEntry["message"];

export function collectCoveredMessageIds(state: {
	blocks: { active: boolean; effectiveMessageIds: string[] }[];
}): Set<string> {
	const ids = new Set<string>();
	for (const b of state.blocks) {
		if (!b.active) continue;
		for (const id of b.effectiveMessageIds) ids.add(id);
	}
	return ids;
}

// ~Anthropic 截图量级；真实按模型 85..2.8K 浮动 —— 平价近似。
export const IMAGE_TOKEN_COST = 1600;

// pi-ai 对非视觉模型直接丢 image 块，所以那类模型上图片计零成本。
export function modelSupportsImages(model: unknown): boolean {
	const input = (model as { input?: string[] } | null | undefined)?.input;
	return Array.isArray(input) && input.includes("image");
}

export function collectImageTokens(
	entries: { id: string; type?: string; message?: AgentMessage }[],
	visionCapable: boolean,
): Map<string, number> {
	const out = new Map<string, number>();
	if (!visionCapable) return out;
	for (const e of entries) {
		if (e.type !== "message") continue;
		const n = countImageBlocks((e.message as { content?: unknown } | undefined)?.content);
		if (n > 0) out.set(e.id, n * IMAGE_TOKEN_COST);
	}
	return out;
}

export function estimateTokens(
	messages: CoreMessage[],
	coveredIds?: Set<string>,
	imageTokensById?: Map<string, number>,
): number {
	let tokens = 0;
	for (const m of messages) {
		if (m.toolName === "compress") continue;
		if (coveredIds?.has(m.id)) continue;
		tokens += defaultCountTokens(m.text ?? "");
		tokens += m.thinkingTokens ?? 0;
		const img = imageTokensById?.get(m.id);
		if (img) tokens += img;
	}
	return tokens;
}

// 在真实发送视图上重测：跑一次 processTurn（一次性 state 克隆，processTurn
// 会改 state —— 存活计数、nudge 时间戳），对剪枝后的结果计数。有块覆盖时
// 原始视图计数会显著高于发送视图（每轮被剪却仍被计数的消息把占用钉死在
// 紧急区，驱动低产出的压缩循环 —— 上游 issue #289）。
export function sentViewTokenCount(
	core: CompressionCore,
	messages: CoreMessage[],
	state: CompressionState,
	config: Config,
	prelim: number,
	imageTokensById?: Map<string, number>,
	systemPromptTokens = 0,
): { viewTokens: number; drifted: boolean } {
	// 探针钳在紧急截断阈值之下：把 prelim 原样传入会让 emergencyTruncateNode
	// 在探针里触发，量到的是截断后的视图（低报）。
	const cap =
		config.modelContextLimit > 0
			? Math.max(0, Math.floor(config.truncate.threshold * config.modelContextLimit) - 1)
			: Number.MAX_SAFE_INTEGER;
	const probe = core.processTurn({
		messages,
		state: structuredClone(state),
		config,
		tokenCount: Math.min(prelim, cap),
	});
	const viewTokens =
		estimateTokens(probe.messages, collectCoveredMessageIds(probe.state), imageTokensById) + systemPromptTokens;
	return { viewTokens, drifted: Math.abs(viewTokens - prelim) > Math.max(1000, 0.1 * prelim) };
}

// 只需要最终计数的调用点：没有活跃块覆盖时不可能有分歧，直接跳过探针。
export function adjustedTokenCount(
	core: CompressionCore,
	messages: CoreMessage[],
	state: CompressionState,
	config: Config,
	prelim: number,
	imageTokensById?: Map<string, number>,
	systemPromptTokens = 0,
): number {
	if (!state.blocks.some((b) => b.active && b.effectiveMessageIds.length > 0)) return prelim;
	const view = sentViewTokenCount(core, messages, state, config, prelim, imageTokensById, systemPromptTokens);
	return view.drifted ? view.viewTokens : prelim;
}
