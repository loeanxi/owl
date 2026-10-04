import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvaluationModelAccess, evaluationThinkingLevels } from "../src/core/evaluation/model.ts";
import type { EvaluationProfile, EvaluationTask } from "../src/core/evaluation/types.ts";

const fixtures = vi.hoisted(() => ({
	create: vi.fn(),
	stream: vi.fn(),
	refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
	getModels: vi.fn(),
	getModel: vi.fn(),
}));
vi.mock("../src/core/model-runtime.ts", () => ({
	ModelRuntime: { create: fixtures.create },
}));

const model: Model<Api> = {
	id: "isolated-model",
	name: "Isolated model",
	provider: "isolated-provider",
	api: "openai-completions",
	baseUrl: "https://offline.invalid/v1",
	input: ["text"],
	reasoning: true,
	thinkingLevelMap: { max: null, xhigh: "xhigh" },
	contextWindow: 100_000,
	maxTokens: 10_000,
	cost: { input: 2, output: 3, cacheRead: 0.1, cacheWrite: 2 },
};
const task: EvaluationTask = {
	id: "test-model",
	title: "测试",
	version: 1,
	category: "code",
	outputType: "code",
	builtin: false,
	prompt: "Repair exactly this code",
	input: "const result = 1;",
	rubric: [],
	checks: [],
};
function response(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		stopReason: "stop",
		content: [
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		],
		usage: {
			input: 12,
			output: 30,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 45,
			cost: { input: 0.000024, output: 0.00009, cacheRead: 0.0000002, cacheWrite: 0.000002, total: 0.0001162 },
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	fixtures.getModels.mockReturnValue([model]);
	fixtures.getModel.mockReturnValue(model);
	fixtures.create.mockResolvedValue({
		refresh: fixtures.refresh,
		getAvailableSnapshot: fixtures.getModels,
		getModel: fixtures.getModel,
		streamSimple: fixtures.stream,
		getProvider: () => ({ name: "Fixture provider" }),
	});
	fixtures.stream.mockImplementation(() => {
		const stream = createAssistantMessageEventStream();
		const message = response();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	});
});

describe("direct evaluation model adapter", () => {
	it("forwards only this result's text conversation with the same frozen model effort and no provider reasoning replay", async () => {
		const access = createEvaluationModelAccess("D:\\offline-fixture");
		const available = await access.listModels();
		await access.invoke({
			task,
			profile: {
				id: "profile",
				provider: model.provider,
				modelId: model.id,
				thinkingLevel: "high",
				model: available[0],
				timeoutMs: 1234,
				maxTokens: 500,
			},
			signal: new AbortController().signal,
			onPartial: () => {},
			conversation: {
				originalAnswer: "fixed first answer",
				turns: [{ prompt: "previous question", output: "previous successful answer" }],
				prompt: "next question",
			},
		});
		const [forwardedModel, context, options] = fixtures.stream.mock.calls[0] as [
			Model<Api>,
			Context,
			ModelsSimpleStreamOptions,
		];
		expect(forwardedModel).toBe(model);
		expect(context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
		]);
		expect(context.messages[0]).toMatchObject({
			role: "user",
			content: "Repair exactly this code\n\nconst result = 1;",
		});
		expect(context.messages[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "fixed first answer" }],
		});
		expect(context.messages[3]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "previous successful answer" }],
		});
		expect(context.messages[4]).toMatchObject({ role: "user", content: "next question" });
		expect(JSON.stringify(context)).not.toMatch(/thinking|signature|responseId|tool/);
		expect(options).toMatchObject({ maxRetries: 0, maxTokens: 500, reasoning: "high" });
		expect(options).not.toHaveProperty("timeoutMs");
	});

	it("sends only the fixed user input, no system/skills/tools/history, with retries disabled and the requested supported effort", async () => {
		const access = createEvaluationModelAccess("D:\\offline-fixture");
		const available = await access.listModels();
		expect(available[0].supportedThinkingLevels).toContain("xhigh");
		expect(available[0].supportedThinkingLevels).not.toContain("max");
		const profile: EvaluationProfile = {
			id: "profile",
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: "high",
			model: available[0],
			timeoutMs: 1234,
			maxTokens: 500,
		};
		const controller = new AbortController();
		const partial = vi.fn();
		const actual = await access.invoke({ profile, task, signal: controller.signal, onPartial: partial });
		const [_model, context, options] = fixtures.stream.mock.calls[0] as [
			Model<Api>,
			Context,
			ModelsSimpleStreamOptions,
		];
		expect(context).not.toHaveProperty("systemPrompt");
		expect(context).not.toHaveProperty("tools");
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]).toMatchObject({
			role: "user",
			content: "Repair exactly this code\n\nconst result = 1;",
		});
		expect(options).not.toHaveProperty("timeoutMs");
		expect(options).toMatchObject({
			maxRetries: 0,
			maxTokens: 500,
			reasoning: "high",
			signal: controller.signal,
		});
		expect(partial).toHaveBeenCalledWith("answer", "reasoning");
		expect(actual.usage).toEqual({ input: 12, output: 30, cacheRead: 2, cacheWrite: 1, total: 45 });
		expect(actual.costUsd).toBe(0.0001162);
		expect(actual.actualModel).toEqual({
			provider: model.provider,
			modelId: model.id,
			responseModel: null,
			forwardedThinkingLevel: "high",
			providerThinkingLevel: null,
		});
		expect(fixtures.create).toHaveBeenCalledWith(expect.objectContaining({ allowModelNetwork: false }));
	});

	it("keeps zero placeholder prices and unreported usage unknown", async () => {
		fixtures.getModels.mockReturnValue([{ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
		const access = createEvaluationModelAccess("D:\\offline-fixture");
		const available = await access.listModels();
		expect(available[0].pricing).toBeNull();
		fixtures.stream.mockImplementation(() => {
			const stream = createAssistantMessageEventStream();
			const message = response();
			message.usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		});
		const result = await access.invoke({
			task,
			profile: {
				id: "profile",
				provider: model.provider,
				modelId: model.id,
				thinkingLevel: "default",
				model: available[0],
				maxTokens: 500,
				timeoutMs: 1000,
			},
			signal: new AbortController().signal,
			onPartial: () => {},
		});
		expect(result.usage).toBeNull();
		expect(result.costUsd).toBeNull();
	});

	it("does not offer off when omitting reasoning leaves unknown upstream defaults, and excludes virtual routing models", async () => {
		expect(evaluationThinkingLevels(model)).not.toContain("off");
		expect(evaluationThinkingLevels({ ...model, thinkingLevelMap: { off: "none" } })).toContain("off");
		expect(evaluationThinkingLevels({ ...model, thinkingLevelMap: { off: "minimal" } })).not.toContain("off");
		expect(evaluationThinkingLevels({ ...model, compat: { thinkingFormat: "qwen" } })).toContain("off");
		fixtures.getModels.mockReturnValue([{ ...model, api: "pi-virtual" }, model]);
		const access = createEvaluationModelAccess("D:\\offline-fixture");
		expect(await access.listModels()).toHaveLength(1);
		fixtures.getModel.mockReturnValue({ ...model, api: "pi-virtual" });
		const available = await access.listModels();
		await expect(
			access.invoke({
				task,
				profile: {
					id: "virtual",
					provider: model.provider,
					modelId: model.id,
					model: available[0],
					thinkingLevel: "default",
					timeoutMs: 1000,
					maxTokens: 500,
				},
				signal: new AbortController().signal,
				onPartial: () => {},
			}),
		).rejects.toThrow("实体模型");
	});
});
