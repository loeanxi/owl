import { join } from "node:path";
import {
  getSupportedThinkingLevels,
  hasApi
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "../model-runtime.js";
import { isVirtualModel } from "../virtual-models.js";
function validateEvaluationConversation(profile, task, conversation) {
  const text = [task.prompt, task.input ?? "", conversation.originalAnswer, conversation.prompt];
  for (const turn of conversation.turns) text.push(turn.prompt, turn.output);
  const bytes = text.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
  const available = Math.min(2e5, Math.max(0, profile.model.contextWindow - profile.maxTokens - 1024));
  if (bytes > available) throw new Error("\u8FD9\u6BB5\u4F1A\u8BDD\u5DF2\u8FBE\u5230\u4E0A\u4E0B\u6587\u957F\u5EA6\u4E0A\u9650\uFF0C\u8BF7\u65B0\u5EFA\u6D4B\u8BC4\u7EE7\u7EED");
}
function buildEvaluationContext(request, model) {
  const context = {
    messages: [
      {
        role: "user",
        content: request.task.input ? `${request.task.prompt}

${request.task.input}` : request.task.prompt,
        timestamp: Date.now()
      }
    ]
  };
  const conversation = request.conversation;
  if (!conversation) return context;
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
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
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
function evaluationThinkingLevels(model) {
  const supported = getSupportedThinkingLevels(model);
  const format = hasApi(model, "openai-completions") ? model.compat?.thinkingFormat : void 0;
  const offValue = model.thinkingLevelMap?.off;
  const offMapping = typeof offValue === "string" && ["none", "off", "disabled"].includes(offValue);
  const explicitOff = !model.reasoning || model.api === "anthropic-messages" || (model.api === "openai-responses" || model.api === "azure-openai-responses") && model.provider !== "github-copilot" && (offValue === void 0 || offMapping) || model.api === "openai-completions" && (offMapping || ["zai", "qwen", "qwen-chat-template", "deepseek", "together"].includes(format ?? "") || ["openrouter", "string-thinking"].includes(format ?? "") && offValue === void 0);
  return ["default", ...supported.filter((level) => level !== "off" || explicitOff)];
}
function createEvaluationModelAccess(agentDir) {
  let runtimePromise;
  const runtime = () => {
    runtimePromise ??= ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false
    });
    return runtimePromise;
  };
  return {
    async listModels() {
      const models = await runtime();
      await models.refresh({ allowNetwork: false });
      return models.getAvailableSnapshot().filter((model) => !isVirtualModel(model)).map((model) => ({
        provider: String(model.provider),
        modelId: model.id,
        name: model.name,
        sourceName: models.getProvider(model.provider)?.name ?? String(model.provider),
        supportedThinkingLevels: evaluationThinkingLevels(model),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        pricing: Object.values(model.cost).some((value) => typeof value === "number" && value > 0) ? {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite
        } : null
      }));
    },
    async invoke(request) {
      const models = await runtime();
      request.signal.throwIfAborted();
      const model = models.getModel(request.profile.provider, request.profile.modelId);
      if (!model) throw new Error("\u6D4B\u8BC4\u6A21\u578B\u5DF2\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6A21\u578B");
      if (isVirtualModel(model)) throw new Error("\u7B2C\u4E00\u7248\u6D4B\u8BC4\u8BF7\u4F7F\u7528\u5B9E\u4F53\u6A21\u578B\uFF0C\u4E0D\u80FD\u4F7F\u7528\u81EA\u52A8\u8DEF\u7531\u6A21\u578B");
      const level = request.profile.thinkingLevel;
      if (!evaluationThinkingLevels(model).includes(level)) {
        throw new Error("\u8BE5\u6A21\u578B\u4E0D\u652F\u6301\u9009\u5B9A\u601D\u8003\u6863\u4F4D");
      }
      const context = buildEvaluationContext(request, model);
      const stream = models.streamSimple(model, context, {
        signal: request.signal,
        maxRetries: 0,
        timeoutMs: request.profile.timeoutMs,
        maxTokens: request.profile.maxTokens,
        ...level !== "default" && level !== "off" ? { reasoning: level } : {}
      });
      let final;
      for await (const event of stream) {
        const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
        request.onPartial(
          message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
          message.content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("\n")
        );
        if (event.type === "done" || event.type === "error") final = message;
      }
      if (!final) throw new Error("\u6A21\u578B\u6D41\u672A\u8FD4\u56DE\u6700\u7EC8\u7ED3\u679C");
      const usage = final.usage;
      const reported = usage.totalTokens > 0 || usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
      return {
        text: final.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        thinking: final.content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("\n"),
        usage: reported ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          total: usage.totalTokens
        } : null,
        costUsd: reported && request.profile.model.pricing !== null ? usage.cost.total : null,
        stopReason: final.stopReason,
        error: final.errorMessage ?? null,
        actualModel: {
          provider: String(final.provider),
          modelId: final.model,
          responseModel: final.responseModel ?? null,
          forwardedThinkingLevel: level === "default" ? null : level,
          providerThinkingLevel: final.providerThinkingLevel ?? null
        }
      };
    }
  };
}
export {
  buildEvaluationContext,
  createEvaluationModelAccess,
  evaluationThinkingLevels,
  validateEvaluationConversation
};
