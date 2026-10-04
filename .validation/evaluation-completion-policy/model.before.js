import { join } from "node:path";
import { getSupportedThinkingLevels, hasApi, normalizeContext, } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { ModelRuntime } from "../model-runtime.js";
import { isVirtualModel } from "../virtual-models.js";
/** Input bounds reserve modest headroom, rather than subtracting the entire advertised output capacity. */
export function validateEvaluationConversation(profile, task, conversation) {
    const text = [task.prompt, task.input ?? "", conversation.originalAnswer, conversation.prompt];
    for (const turn of conversation.turns)
        text.push(turn.prompt, turn.output);
    const bytes = text.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
    const available = profile.model.contextWindow > 0 ? Math.min(200_000, Math.max(0, profile.model.contextWindow - 1024)) : 200_000;
    if (bytes > available)
        throw new Error("这段会话已达到上下文长度上限，请新建测评继续");
}
/** Replays text only; provider reasoning signatures and global chat state are never synthesized. */
export function buildEvaluationContext(request, model) {
    const context = {
        messages: [
            {
                role: "user",
                content: request.task.input ? `${request.task.prompt}\n\n${request.task.input}` : request.task.prompt,
                timestamp: Date.now(),
            },
        ],
    };
    const conversation = request.conversation;
    if (!conversation)
        return context;
    validateEvaluationConversation(request.profile, request.task, conversation);
    const appendAnswer = (text) => {
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
/** Use the exact SDK context clamp when freezing the effective request, without a local output ceiling. */
export function evaluationRequestPolicy(profile, task, idleTimeoutMs, conversation) {
    if (!Number.isSafeInteger(profile.model.maxTokens) || profile.model.maxTokens < 1)
        throw new Error("模型输出额度必须是有效正整数，请检查模型配置");
    const context = buildEvaluationContext({ profile, task, conversation, signal: new AbortController().signal, onPartial: () => { } }, {
        api: profile.model.api ?? "openai-completions",
        provider: profile.provider,
        id: profile.modelId,
    });
    return {
        maxTokens: clampMaxTokensToContext(profile.model, normalizeContext(context), profile.model.maxTokens),
        idleTimeoutMs,
        timeoutMs: 0,
        contextWindow: profile.model.contextWindow,
    };
}
/** Only expose off when the existing adapter sends an explicit disable switch or mapped effort. */
export function evaluationThinkingLevels(model) {
    const supported = getSupportedThinkingLevels(model);
    const format = hasApi(model, "openai-completions") ? model.compat?.thinkingFormat : undefined;
    const offValue = model.thinkingLevelMap?.off;
    const offMapping = typeof offValue === "string" && ["none", "off", "disabled"].includes(offValue);
    const explicitOff = !model.reasoning ||
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
export function createEvaluationModelAccess(agentDir) {
    let runtimePromise;
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
                api: model.api,
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
            if (!model)
                throw new Error("测评模型已不存在，请重新选择模型");
            if (isVirtualModel(model))
                throw new Error("第一版测评请使用实体模型，不能使用自动路由模型");
            const level = request.profile.thinkingLevel;
            if (!evaluationThinkingLevels(model).includes(level)) {
                throw new Error("该模型不支持选定思考档位");
            }
            const context = buildEvaluationContext(request, model);
            const maxTokens = request.requestPolicy?.maxTokens ?? request.profile.maxTokens;
            if (!Number.isSafeInteger(maxTokens) ||
                maxTokens < 1 ||
                maxTokens > model.maxTokens ||
                clampMaxTokensToContext(model, normalizeContext(context), maxTokens) !== maxTokens)
                throw new Error("模型输出或上下文配置已改变，请重新运行以采用当前额度");
            const stream = models.streamSimple(model, context, {
                signal: request.signal,
                maxRetries: 0,
                // SDK zero means immediate abort. Its default streaming timeout only covers headers;
                // the content idle watchdog supplies connection protection, with no generation deadline.
                maxTokens,
                ...(level !== "default" && level !== "off" ? { reasoning: level } : {}),
            });
            let final;
            for await (const event of stream) {
                const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
                request.onPartial(message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n"), message.content
                    .filter((part) => part.type === "thinking")
                    .map((part) => part.thinking)
                    .join("\n"));
                if (event.type === "done" || event.type === "error")
                    final = message;
            }
            if (!final)
                throw new Error("模型流未返回最终结果");
            const usage = final.usage;
            const reported = usage.totalTokens > 0 || usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
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
//# sourceMappingURL=model.js.map