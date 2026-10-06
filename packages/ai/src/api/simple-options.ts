import type {
	Api,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
	TranscriptContext,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;

export function clampMaxTokensToContext(
	model: Pick<Model<Api>, "contextWindow">,
	context: TranscriptContext,
	maxTokens: number,
): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

export function buildBaseOptions(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	return {
		temperature: options?.temperature,
		samplingParams: options?.samplingParams,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onProviderStreamEvent: options?.onProviderStreamEvent,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}

/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;

export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};

export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export function thinkingBudgetForLevel(reasoningLevel: ThinkingLevel, customBudgets?: ThinkingBudgets): number {
	const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
	const level = clampReasoning(reasoningLevel)!;
	return budgets[level]!;
}

/** Cap a thinking budget so at least MIN_ANSWER_TOKENS remain under a shared response ceiling. */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
	return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

const OUTPUT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Tokens of reasoning a level is expected to consume before the answer. xhigh/max share the high budget. */
const OUTPUT_THINKING_BUDGET: Record<(typeof OUTPUT_THINKING_LEVELS)[number], number> = {
	off: 0,
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 16384,
};

/**
 * Lower a requested thinking level until the reasoning budget plus {@link MIN_ANSWER_TOKENS}
 * fit in `maxTokens`. Never raises the level. Unknown or non-positive budgets are left unchanged.
 */
export function capThinkingLevelForOutput(level: ModelThinkingLevel, maxTokens: number): ModelThinkingLevel {
	if (level === "off" || !Number.isFinite(maxTokens) || maxTokens <= 0) return level;
	const index = OUTPUT_THINKING_LEVELS.indexOf(level);
	if (index < 0) return level;
	for (let cursor = index; cursor >= 0; cursor--) {
		const candidate = OUTPUT_THINKING_LEVELS[cursor]!;
		const answerFloor = candidate === "off" ? 0 : MIN_ANSWER_TOKENS;
		if (OUTPUT_THINKING_BUDGET[candidate] + answerFloor <= maxTokens) return candidate;
	}
	return "off";
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	}

	return { maxTokens, thinkingBudget };
}
