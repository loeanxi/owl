import type { ModelRegistry } from "../../core/model-registry.ts";
import { NewsOutputError } from "../../core/news/editorial.ts";
import type { NewsModelCall, NewsModelRef, NewsModelResponse } from "../../core/news/types.ts";

export interface NewsModelAccess {
	registry: Pick<ModelRegistry, "find" | "getAvailable" | "streamSimple">;
	defaultModel?: NewsModelRef;
}

/** A direct model operation, independent of the user's conversation and tool loop. */
export async function callNewsModel(access: NewsModelAccess, request: NewsModelCall): Promise<NewsModelResponse> {
	const choice = request.model ?? access.defaultModel;
	const model = choice ? access.registry.find(choice.provider, choice.id) : access.registry.getAvailable()[0];
	if (!model) throw new Error("资讯模型未配置，请在模型设置或资讯设置中选择可用模型。");
	const response = await access.registry
		.streamSimple(
			model,
			{
				systemPrompt: request.system,
				messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
			},
			{
				maxTokens: Math.min(request.maxTokens ?? 4096, model.maxTokens || 4096),
				temperature: request.temperature ?? 0.2,
				maxRetries: 0,
				timeoutMs: 180_000,
				signal: request.signal,
			},
		)
		.result();
	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	const rates = model.cost;
	const priceKnown = rates && [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some((rate) => rate > 0);
	const received: NewsModelResponse = {
		text,
		provider: String(model.provider),
		model: model.id,
		usage: {
			input: response.usage.input,
			output: response.usage.output,
			cacheRead: response.usage.cacheRead,
			cacheWrite: response.usage.cacheWrite,
			cost: priceKnown && Number.isFinite(response.usage.cost.total) ? response.usage.cost.total : null,
		},
	};
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`资讯模型调用结果不明：${response.stopReason}（${model.provider}/${model.id}）`);
	}
	if (response.stopReason !== "stop" || !text) {
		throw new NewsOutputError(
			request.purpose ?? request.capability,
			`模型未完成有效回答：${response.stopReason}`,
			received,
		);
	}
	return received;
}
