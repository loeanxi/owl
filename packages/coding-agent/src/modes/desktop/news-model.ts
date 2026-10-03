import type { ModelRegistry } from "../../core/model-registry.ts";
import type { NewsModelCall, NewsModelRef, NewsModelResponse } from "../../core/news/types.ts";

export interface NewsModelAccess {
	registry: ModelRegistry;
	defaultModel?: NewsModelRef;
}

/** A direct model operation, independent of the user's conversation and tool loop. */
export async function callNewsModel(access: NewsModelAccess, request: NewsModelCall): Promise<NewsModelResponse> {
	const choice = request.model ?? access.defaultModel;
	const model = choice
		? access.registry.find(choice.provider, choice.id)
		: access.registry.getAvailable()[0];
	if (!model) throw new Error("资讯模型未配置，请在模型设置或资讯设置中选择可用模型。");
	const response = await access.registry.streamSimple(model, {
		systemPrompt: request.system,
		messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
	}, {
		maxTokens: Math.min(request.maxTokens ?? 4096, model.maxTokens || 4096),
		temperature: request.temperature ?? 0.2,
		reasoning: "off",
		maxRetries: 0,
		timeoutMs: 180_000,
		signal: request.signal,
	}).result();
	if (response.stopReason !== "stop") {
		throw new Error(`资讯模型未完成有效回答：${response.stopReason}（${model.provider}/${model.id}）`);
	}
	const text = response.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
	if (!text) throw new Error("资讯模型返回了空文本。");
	const rates = model.cost;
	const priceKnown = rates && [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some(rate => rate > 0);
	return {
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
}
