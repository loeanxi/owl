import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	getSupportedThinkingLevels,
	hasApi,
	type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "../model-runtime.ts";
import { isVirtualModel } from "../virtual-models.ts";
import type {
	EvaluationActualModel,
	EvaluationModel,
	EvaluationProfile,
	EvaluationTask,
	EvaluationThinkingLevel,
	EvaluationUsage,
} from "./types.ts";

export interface EvaluationInvocation {
	profile: EvaluationProfile;
	task: EvaluationTask;
	signal: AbortSignal;
	onPartial: (text: string, thinking: string) => void;
	conversation?: EvaluationConversation;
}
export interface EvaluationConversation {
	originalAnswer: string;
	turns: { prompt: string; output: string }[];
	prompt: string;
}
export interface EvaluationInvocationResult {
	text: string;
	thinking: string;
	usage: EvaluationUsage | null;
	costUsd: number | null;
	stopReason: string;
	error: string | null;
	actualModel?: EvaluationActualModel;
}
export type EvaluationInvoker = (request: EvaluationInvocation) => Promise<EvaluationInvocationResult>;

/** Byte bounds intentionally reserve output space without silently truncating prior answers. */
export function validateEvaluationConversation(
	profile: EvaluationProfile,
	task: EvaluationTask,
	conversation: EvaluationConversation,
): void {
	const text = [task.prompt, task.input ?? "", conversation.originalAnswer, conversation.prompt];
	for (const turn of conversation.turns) text.push(turn.prompt, turn.output);
	const bytes = text.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
	const available = Math.min(200_000, Math.max(0, profile.model.contextWindow - profile.maxTokens - 1024));
	if (bytes > available) throw new Error("这段会话已达到上下文长度上限，请新建测评继续");
}

/** Replays text only; provider reasoning signatures and global chat state are never synthesized. */
export function buildEvaluationContext(request: EvaluationInvocation, model: Model<Api>): Context {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: request.task.input ? `${request.task.prompt}\n\n${request.task.input}` : request.task.prompt,
				timestamp: Date.now(),
			},
		],
	};
	const conversation = request.conversation;
	if (!conversation) return context;
	validateEvaluationConversation(request.profile, request.task, conversation);
	const appendAnswer = (text: string) => {
		context.messages.push({
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
	};
	appendAnswer(conversation.originalAnswer);
	for (const turn of conversation.turns) {
		context.messages.push({ role: "user", content: turn.prompt, timestamp: Date.now() });
		appendAnswer(turn.output);
	}
	context.messages.push({ role: "user", content: conversation.prompt, timestamp: Date.now() });
	return context;
}

/** Only expose off when the existing adapter sends an explicit disable switch or mapped effort. */
export function evaluationThinkingLevels(model: Model<Api>): EvaluationThinkingLevel[] {
	const supported = getSupportedThinkingLevels(model);
	const format = hasApi(model, "openai-completions") ? model.compat?.thinkingFormat : undefined;
	const offValue = model.thinkingLevelMap?.off;
	const offMapping = typeof offValue === "string" && ["none", "off", "disabled"].includes(offValue);
	const explicitOff =
		!model.reasoning ||
		model.api === "anthropic-messages" ||
		((model.api === "openai-responses" || model.api === "azure-openai-responses") &&
			model.provider !== "github-copilot" &&
			(offValue === undefined || offMapping)) ||
		(model.api === "openai-completions" &&
			(offMapping ||
				["zai", "qwen", "qwen-chat-template", "deepseek", "together"].includes(format ?? "") ||
				(["openrouter", "string-thinking"].includes(format ?? "") && offValue === undefined)));
	return ["default", ...supported.filter((level) => level !== "off" || explicitOff)];
}

/** Creates only the configured model runtime: no resource loader, project instructions, tools, or session. */
export function createEvaluationModelAccess(agentDir: string): {
	listModels: () => Promise<EvaluationModel[]>;
	invoke: EvaluationInvoker;
} {
	let runtimePromise: Promise<ModelRuntime> | undefined;
	const runtime = () => {
		runtimePromise ??= ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		return runtimePromise;
	};
	return {
		async listModels() {
			const models = await runtime();
			await models.refresh({ allowNetwork: false });
			return models
				.getAvailableSnapshot()
				.filter((model) => !isVirtualModel(model))
				.map((model) => ({
					provider: String(model.provider),
					modelId: model.id,
					name: model.name,
					sourceName: models.getProvider(model.provider)?.name ?? String(model.provider),
					supportedThinkingLevels: evaluationThinkingLevels(model),
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					pricing: Object.values(model.cost).some((value) => typeof value === "number" && value > 0)
						? {
								input: model.cost.input,
								output: model.cost.output,
								cacheRead: model.cost.cacheRead,
								cacheWrite: model.cost.cacheWrite,
							}
						: null,
				}));
		},
		async invoke(request) {
			const models = await runtime();
			request.signal.throwIfAborted();
			const model = models.getModel(request.profile.provider, request.profile.modelId);
			if (!model) throw new Error("测评模型已不存在，请重新选择模型");
			if (isVirtualModel(model)) throw new Error("第一版测评请使用实体模型，不能使用自动路由模型");
			const level = request.profile.thinkingLevel;
			if (!evaluationThinkingLevels(model).includes(level)) {
				throw new Error("该模型不支持选定思考档位");
			}
			const context = buildEvaluationContext(request, model);
			const stream = models.streamSimple(model, context, {
				signal: request.signal,
				maxRetries: 0,
				timeoutMs: request.profile.timeoutMs,
				maxTokens: request.profile.maxTokens,
				...(level !== "default" && level !== "off" ? { reasoning: level } : {}),
			});
			let final: AssistantMessage | undefined;
			for await (const event of stream) {
				const message =
					event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
				request.onPartial(
					message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
					message.content
						.filter((part) => part.type === "thinking")
						.map((part) => part.thinking)
						.join("\n"),
				);
				if (event.type === "done" || event.type === "error") final = message;
			}
			if (!final) throw new Error("模型流未返回最终结果");
			const usage = final.usage;
			const reported =
				usage.totalTokens > 0 || usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
			return {
				text: final.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
				thinking: final.content
					.filter((part) => part.type === "thinking")
					.map((part) => part.thinking)
					.join("\n"),
				usage: reported
					? {
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							total: usage.totalTokens,
						}
					: null,
				costUsd: reported && request.profile.model.pricing !== null ? usage.cost.total : null,
				stopReason: final.stopReason,
				error: final.errorMessage ?? null,
				actualModel: {
					provider: String(final.provider),
					modelId: final.model,
					responseModel: final.responseModel ?? null,
					forwardedThinkingLevel: level === "default" ? null : level,
					providerThinkingLevel: final.providerThinkingLevel ?? null,
				},
			};
		},
	};
}
