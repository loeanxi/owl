import { join } from "node:path";
import { type AssistantMessage, type Context, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "../model-runtime.ts";
import type { EvaluationModel, EvaluationProfile, EvaluationTask, EvaluationUsage } from "./types.ts";

export interface EvaluationInvocation {
	profile: EvaluationProfile;
	task: EvaluationTask;
	signal: AbortSignal;
	onPartial: (text: string, thinking: string) => void;
}
export interface EvaluationInvocationResult {
	text: string;
	thinking: string;
	usage: EvaluationUsage | null;
	costUsd: number | null;
	stopReason: string;
	error: string | null;
}
export type EvaluationInvoker = (request: EvaluationInvocation) => Promise<EvaluationInvocationResult>;

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
			return models.getAvailableSnapshot().map((model) => ({
				provider: String(model.provider),
				modelId: model.id,
				name: model.name,
				sourceName: models.getProvider(model.provider)?.name ?? String(model.provider),
				supportedThinkingLevels: ["default", ...getSupportedThinkingLevels(model)],
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
			const level = request.profile.thinkingLevel;
			if (level !== "default" && !getSupportedThinkingLevels(model).includes(level)) {
				throw new Error("该模型不支持选定思考档位");
			}
			const context: Context = {
				messages: [
					{
						role: "user",
						content: request.task.input ? `${request.task.prompt}\n\n${request.task.input}` : request.task.prompt,
						timestamp: Date.now(),
					},
				],
			};
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
			};
		},
	};
}
