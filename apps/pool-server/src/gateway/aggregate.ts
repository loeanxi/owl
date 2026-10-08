/**
 * 流式 → 非流式聚合 —— 移植自 WorkBuddy/Trae 客户端的非流式路径：
 * 逐 chunk 聚 content/reasoning_content/tool_calls(按 index)/usage/finish_reason。
 */
import { type UpstreamChatClient, UpstreamToolCallAggregator } from "owl-pool";

export interface AggregatedCompletion {
	body: Record<string, unknown>;
}

/** 上游客户端的流式接口；非流式经此聚合（上游只回 SSE 时）。 */
export function aggregateStreamToCompletion(
	client: Pick<UpstreamChatClient, "chatCompletionStream">,
	account: Parameters<UpstreamChatClient["chatCompletionStream"]>[0],
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<AggregatedCompletion> {
	let content = "";
	let reasoning = "";
	const toolCalls = new UpstreamToolCallAggregator();
	const usage: Record<string, unknown> = {};
	let finishReason = "stop";
	const model = String(payload.model ?? "unknown");

	return client
		.chatCompletionStream(
			account,
			payload,
			(chunkJson) => {
				let node: Record<string, unknown>;
				try {
					node = JSON.parse(chunkJson) as Record<string, unknown>;
				} catch {
					return; // 聚合阶段容忍坏 chunk
				}
				const choices = node.choices;
				if (Array.isArray(choices) && choices.length > 0) {
					const choice = choices[0] as Record<string, unknown>;
					const delta = (choice.delta ?? {}) as Record<string, unknown>;
					if (typeof delta.content === "string") {
						content += delta.content;
					}
					if (typeof delta.reasoning_content === "string") {
						reasoning += delta.reasoning_content;
					}
					if (Array.isArray(delta.tool_calls)) {
						for (const call of delta.tool_calls) {
							toolCalls.merge(call);
						}
					}
					if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
						finishReason = choice.finish_reason;
					}
				}
				if (node.usage !== null && typeof node.usage === "object" && !Array.isArray(node.usage)) {
					Object.assign(usage, node.usage);
				}
			},
			signal,
		)
		.then(() => {
			const flattened = toolCalls.flatten();
			const message: Record<string, unknown> = { role: "assistant", content };
			if (reasoning.length > 0) {
				message.reasoning_content = reasoning;
			}
			let effectiveFinish = finishReason;
			if (flattened.length > 0) {
				message.tool_calls = flattened;
				if (effectiveFinish === "stop") {
					effectiveFinish = "tool_calls";
				}
			}
			return {
				body: {
					id: `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model,
					choices: [{ index: 0, message, finish_reason: effectiveFinish }],
					usage,
				},
			};
		});
}
