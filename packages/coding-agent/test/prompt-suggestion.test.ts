import {
	type Api,
	type AssistantMessage,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { streamSimple as anthropicStreamSimple } from "../../ai/src/api/anthropic-messages.ts";
import { streamSimple as openaiStreamSimple } from "../../ai/src/api/openai-completions.ts";
import { streamSimple as responsesStreamSimple } from "../../ai/src/api/openai-responses.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	completePromptSuggestion,
	PromptSuggestionService,
	type PromptSuggestionSource,
	selectPromptSuggestionBasis,
} from "../src/core/prompt-suggestion.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { computeSessionStats } from "../src/core/session-stats.ts";
import { createVirtualModel } from "../src/core/virtual-models.ts";
import { handlePromptSuggestionRequest } from "../src/modes/desktop/handlers/prompt-suggestion.ts";

const services: PromptSuggestionService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
	vi.useRealTimers();
});

function prediction(text = "把这几处改动一起验证一下") {
	const message = fauxAssistantMessage(text);
	return {
		...message,
		usage: {
			...message.usage,
			input: 10,
			output: 8,
			totalTokens: 18,
			cost: { ...message.usage.cost, input: 0.001, output: 0.002, total: 0.003 },
		},
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture(options: { timeoutMs?: number; maxEntries?: number } = {}) {
	const manager = SessionManager.inMemory(process.cwd());
	manager.appendMessage({ role: "user", content: "把窗口图标调整得紧凑些", timestamp: 1 });
	const basisEntryId = manager.appendMessage(fauxAssistantMessage("已调整图标，尚未构建。"));
	const state = {
		owner: {},
		idle: true,
		pendingMessageCount: 0,
		model: {
			id: "test-model",
			name: "Offline prediction fixture",
			provider: "fixture",
			api: "openai-completions",
			baseUrl: "https://offline.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 8192,
		} as Model<Api>,
	};
	const complete = vi.fn<PromptSuggestionSource["complete"]>().mockResolvedValue(prediction());
	const recordUsage = vi.fn((message: AssistantMessage) => {
		manager.appendUsage("prompt_suggestion", message.provider, message.model, message.usage);
	});
	const service = new PromptSuggestionService({
		...options,
		getSource: (sessionId) =>
			sessionId === "session"
				? {
						...state,
						entries: manager.getBranch(),
						complete,
						recordUsage,
					}
				: undefined,
	});
	services.push(service);
	return { state, manager, basisEntryId, complete, recordUsage, service };
}

describe("prompt suggestion context", () => {
	it("selects a persisted final answer, ignoring usage/rename and never mutating history", () => {
		const f = fixture();
		f.manager.appendUsage("cache_warm", "fixture", "test-model", prediction().usage);
		f.manager.appendSessionInfo("另一个名称");
		const before = JSON.stringify(f.manager.getEntries());
		expect(selectPromptSuggestionBasis(f.manager.getBranch())).toEqual({
			entryId: f.basisEntryId,
			conversation: "USER:\n把窗口图标调整得紧凑些\nASSISTANT:\n已调整图标，尚未构建。",
		});
		expect(JSON.stringify(f.manager.getEntries())).toBe(before);
	});

	it.each(["aborted", "error", "length", "toolUse"] as const)("skips a final %s response", (stopReason) => {
		const f = fixture();
		f.manager.appendMessage(fauxAssistantMessage("incomplete", { stopReason }));
		expect(selectPromptSuggestionBasis(f.manager.getBranch())).toBeUndefined();
	});

	it("excludes reasoning and tool data, preserving the latest user/answer under a fixed context budget", () => {
		const f = fixture();
		f.manager.appendMessage({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: "SECRET_TOOL_RESULT" }],
			isError: false,
			timestamp: 2,
		});
		f.manager.appendMessage({
			role: "user",
			content: `LATEST_USER_START${"u".repeat(10000)}LATEST_USER_END`,
			timestamp: 3,
		});
		const id = f.manager.appendMessage(
			fauxAssistantMessage([
				fauxThinking("SECRET_REASONING"),
				{ type: "text", text: `ANSWER_START${"a".repeat(10000)}ANSWER_END` },
			]),
		);
		const basis = selectPromptSuggestionBasis(f.manager.getBranch());
		expect(basis?.entryId).toBe(id);
		expect(basis?.conversation.length).toBeLessThanOrEqual(6000);
		expect(basis?.conversation).toContain("LATEST_USER_START");
		expect(basis?.conversation).toContain("LATEST_USER_END");
		expect(basis?.conversation).toContain("ANSWER_START");
		expect(basis?.conversation).toContain("ANSWER_END");
		expect(basis?.conversation).not.toContain("SECRET_");
	});

	it("ignores image-only input, unfinished tools, and empty/thinking-only answers", () => {
		const f = fixture();
		f.manager.appendMessage({
			role: "user",
			content: [{ type: "image", data: "IMAGE_DATA", mimeType: "image/png" }],
			timestamp: 2,
		});
		f.manager.appendMessage(fauxAssistantMessage("看到了图片"));
		expect(selectPromptSuggestionBasis(f.manager.getBranch())).toBeUndefined();
		f.manager.appendMessage({ role: "user", content: "读取文件", timestamp: 3 });
		f.manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {})));
		expect(selectPromptSuggestionBasis(f.manager.getBranch())).toBeUndefined();
		f.manager.appendMessage(fauxAssistantMessage(fauxThinking("thinking")));
		expect(selectPromptSuggestionBasis(f.manager.getBranch())).toBeUndefined();
	});

	it("keeps at most three recent user turns", () => {
		const f = fixture();
		for (let i = 1; i <= 5; i++) {
			f.manager.appendMessage({ role: "user", content: `question-${i}`, timestamp: i });
			f.manager.appendMessage(fauxAssistantMessage(`answer-${i}`));
		}
		const text = selectPromptSuggestionBasis(f.manager.getBranch())?.conversation;
		expect(text).toContain("question-3");
		expect(text).toContain("question-5");
		expect(text).not.toContain("question-2");
	});
});

describe("prompt suggestion lifecycle", () => {
	it("deduplicates concurrent and later requests, records usage once, and adds no chat messages", async () => {
		const f = fixture();
		const beforeMessages = f.manager.getBranch().filter((entry) => entry.type === "message");
		const expected = { basisEntryId: f.basisEntryId, suggestion: "把这几处改动一起验证一下" };
		expect(await Promise.all([f.service.request({}, "session", "a"), f.service.request({}, "session", "b")])).toEqual(
			[expected, expected],
		);
		expect(await f.service.request({}, "session", "c")).toEqual(expected);
		expect(f.complete).toHaveBeenCalledTimes(1);
		expect(f.recordUsage).toHaveBeenCalledTimes(1);
		expect(f.manager.getBranch().filter((entry) => entry.type === "message")).toEqual(beforeMessages);
		expect(
			f.manager.buildSessionProjection().messages.filter((message) => message.role === "assistant"),
		).toHaveLength(1);
		const stats = computeSessionStats({
			entries: f.manager.getBranch(),
			sessionFile: undefined,
			sessionId: "session",
		});
		expect(stats.tokens.total).toBe(18);
		expect(stats.cost).toBeCloseTo(0.003);
		const [requestModel, context, requestOptions] = f.complete.mock.calls[0];
		expect(requestModel.maxTokens).toBe(192);
		expect(context.tools).toEqual([]);
		expect(context.messages).toHaveLength(1);
		expect(context.systemPrompt).not.toContain("read,");
		expect(requestOptions).toMatchObject({ maxTokens: 192, maxRetries: 0, timeoutMs: 12000 });
		expect(requestOptions.reasoning).toBeUndefined();
	});

	it("skips busy or queued sessions without consuming the completed basis", async () => {
		const f = fixture();
		f.state.idle = false;
		expect(await f.service.request({}, "session", "a")).toEqual({});
		f.state.idle = true;
		f.state.pendingMessageCount = 1;
		expect(await f.service.request({}, "session", "b")).toEqual({});
		expect(f.complete).not.toHaveBeenCalled();
		f.state.pendingMessageCount = 0;
		expect((await f.service.request({}, "session", "c")).suggestion).toBeTruthy();
	});

	it.each(["", "first\nsecond", "x".repeat(161), '{"suggestion":"yes"}'])(
		"silently caches unusable output %j",
		async (text) => {
			const f = fixture();
			f.complete.mockResolvedValue(prediction(text));
			expect(await f.service.request({}, "session", "a")).toEqual({ basisEntryId: f.basisEntryId });
			await f.service.request({}, "session", "b");
			expect(f.complete).toHaveBeenCalledTimes(1);
		},
	);

	it("caches failures and prevents repeated charge attempts", async () => {
		const f = fixture();
		f.complete.mockRejectedValue(new Error("offline provider failed"));
		expect(await f.service.request({}, "session", "a")).toEqual({ basisEntryId: f.basisEntryId });
		await f.service.request({}, "session", "b");
		expect(f.complete).toHaveBeenCalledTimes(1);
		expect(f.recordUsage).not.toHaveBeenCalled();
	});

	it("aborts at the deadline even if the provider ignores cancellation, then observes late usage", async () => {
		vi.useFakeTimers();
		const f = fixture({ timeoutMs: 30 });
		const result = deferred<AssistantMessage>();
		f.complete.mockReturnValue(result.promise);
		const request = f.service.request({}, "session", "a");
		await vi.advanceTimersByTimeAsync(31);
		expect(await request).toEqual({ basisEntryId: f.basisEntryId });
		expect(f.complete.mock.calls[0][2].signal?.aborted).toBe(true);
		await f.service.request({}, "session", "b");
		expect(f.complete).toHaveBeenCalledTimes(1);
		result.resolve(prediction());
		await Promise.resolve();
		expect(f.recordUsage).toHaveBeenCalledTimes(1);
	});

	it("old generation cancellation cannot cancel its successor or another connection", async () => {
		const f = fixture();
		const result = deferred<AssistantMessage>();
		f.complete.mockReturnValue(result.promise);
		const connection = {};
		const first = f.service.request(connection, "session", "old");
		const next = f.service.request(connection, "session", "new");
		await Promise.resolve();
		f.service.cancel(connection, "session", "old");
		f.service.cancel({}, "session", "new");
		expect(f.complete.mock.calls[0][2].signal?.aborted).toBe(false);
		result.resolve(prediction());
		expect(await first).toEqual({});
		expect((await next).suggestion).toBeTruthy();
		expect(f.complete).toHaveBeenCalledTimes(1);
	});

	it("one connection cancelling cannot kill another connection sharing the same generation", async () => {
		const f = fixture();
		const result = deferred<AssistantMessage>();
		f.complete.mockReturnValue(result.promise);
		const connection = {};
		const first = f.service.request(connection, "session", "a");
		const second = f.service.request({}, "session", "b");
		await Promise.resolve();
		f.service.disconnect(connection);
		expect(await first).toEqual({});
		expect(f.complete.mock.calls[0][2].signal?.aborted).toBe(false);
		result.resolve(prediction());
		expect((await second).suggestion).toBeTruthy();
	});

	it("disconnect aborts the last consumer and cannot regenerate that basis", async () => {
		const f = fixture();
		f.complete.mockReturnValue(new Promise(() => {}));
		const connection = {};
		const request = f.service.request(connection, "session", "a");
		await Promise.resolve();
		f.service.disconnect(connection);
		expect(await request).toEqual({});
		expect(f.complete.mock.calls[0][2].signal?.aborted).toBe(true);
		await f.service.request({}, "session", "b");
		expect(f.complete).toHaveBeenCalledTimes(1);
	});

	it.each(["turn", "model", "same-id model", "owner"] as const)(
		"discards results after a %s change",
		async (change) => {
			const f = fixture();
			const result = deferred<AssistantMessage>();
			f.complete.mockReturnValue(result.promise);
			const request = f.service.request({}, "session", "a");
			await Promise.resolve();
			if (change === "turn") f.manager.appendMessage({ role: "user", content: "继续", timestamp: 4 });
			if (change === "model") f.state.model = { ...f.state.model, id: "other-model" };
			if (change === "same-id model")
				f.state.model = { ...f.state.model, baseUrl: "https://new.offline.invalid/v1" };
			if (change === "owner") f.state.owner = {};
			result.resolve(prediction());
			expect(await request).toEqual({});
			expect(f.recordUsage).toHaveBeenCalledTimes(change === "owner" ? 0 : 1);
		},
	);

	it("invalidates completed cache entries when the same model id is replaced by a new configuration", async () => {
		const f = fixture();
		await f.service.request({}, "session", "a");
		f.state.model = { ...f.state.model, baseUrl: "https://new.offline.invalid/v1" };
		f.complete.mockResolvedValue(prediction("检查新配置是否生效"));
		expect((await f.service.request({}, "session", "b")).suggestion).toBe("检查新配置是否生效");
		expect(f.complete).toHaveBeenCalledTimes(2);
	});

	it("bounds its completed-result cache with least-recently-used eviction", async () => {
		const f = fixture({ maxEntries: 2 });
		const original = f.state.model;
		await f.service.request({}, "session", "a");
		f.state.model = { ...original, id: "second" };
		await f.service.request({}, "session", "b");
		f.state.model = { ...original, id: "third" };
		await f.service.request({}, "session", "c");
		f.state.model = original;
		await f.service.request({}, "session", "d");
		expect(f.complete).toHaveBeenCalledTimes(4);
	});

	it("invalidates active calls promptly when a new turn or model change is announced", async () => {
		const f = fixture();
		f.complete.mockReturnValue(new Promise(() => {}));
		const request = f.service.request({}, "session", "a");
		await Promise.resolve();
		f.service.invalidateSession("session");
		expect(await request).toEqual({});
		expect(f.complete.mock.calls[0][2].signal?.aborted).toBe(true);
	});

	it("routes generation and cancellation through the desktop handler", async () => {
		const f = fixture();
		const reply = vi.fn();
		const ws = {} as WebSocket;
		await handlePromptSuggestionRequest(
			ws,
			{ type: "session.promptSuggestion", id: "r1", sessionId: "session", generationId: "g1" },
			{ service: f.service, reply },
		);
		expect(reply).toHaveBeenCalledWith(ws, "r1", {
			ok: true,
			result: { basisEntryId: f.basisEntryId, suggestion: "把这几处改动一起验证一下" },
		});
		await handlePromptSuggestionRequest(
			ws,
			{ type: "session.promptSuggestion.cancel", id: "r2", sessionId: "session", generationId: "g1" },
			{ service: f.service, reply },
		);
		expect(reply).toHaveBeenLastCalledWith(ws, "r2", { ok: true });
	});
});

describe("prediction provider payload budgets", () => {
	it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
		"preserves controlled context after routing to a %s model with input overrides",
		async (api) => {
			const f = fixture();
			const injected = `OVERRIDE_CONTEXT_${"x".repeat(15000)}`;
			const samplingParams = {
				messages: [{ role: "system", content: injected }],
				input: [{ role: "user", content: injected }],
				instructions: injected,
				max_tokens: 60000,
				max_completion_tokens: 60000,
				max_output_tokens: 60000,
				n: 5,
				tools: [{ type: "function", function: { name: "bad" } }],
			};
			const physical: Model<Api> = { ...f.state.model, api, maxTokens: 96, samplingParams };
			f.state.model = createVirtualModel({ provider: "fixture", id: "router", name: "Router with unknown limits" });
			const resolveModel = vi
				.fn<ModelRuntime["resolveModel"]>()
				.mockResolvedValue({ model: physical, thinkingLevel: "high" });
			const fetch = vi.fn<typeof globalThis.fetch>(async () => {
				throw new Error("No network allowed");
			});
			let captured: unknown;
			const completeSimple = vi
				.fn<ModelRuntime["completeSimple"]>()
				.mockImplementation(async (model, context, options = {}) => {
					const capture = {
						...options,
						apiKey: "offline-fixture",
						fetch,
						onPayload: async (payload: unknown, actual: Model<Api>) => {
							captured = (await options.onPayload?.(payload, actual)) ?? payload;
							throw new Error("OFFLINE_PAYLOAD_CAPTURE");
						},
					};
					const contextData = normalizeContext(context);
					if (api === "openai-completions")
						await openaiStreamSimple(model as Model<"openai-completions">, contextData, capture).result();
					if (api === "openai-responses")
						await responsesStreamSimple(model as Model<"openai-responses">, contextData, capture).result();
					if (api === "anthropic-messages")
						await anthropicStreamSimple(model as Model<"anthropic-messages">, contextData, capture).result();
					return prediction();
				});
			f.complete.mockImplementation((model, context, options) =>
				completePromptSuggestion({ resolveModel, completeSimple }, model, context, options),
			);
			expect((await f.service.request({}, "session", "a")).suggestion).toBeTruthy();
			expect(resolveModel).toHaveBeenCalledTimes(1);
			expect(resolveModel.mock.calls[0][2]).toMatchObject({ reason: "direct", thinkingLevel: "off" });
			expect(completeSimple).toHaveBeenCalledTimes(1);
			expect(completeSimple.mock.calls[0][0].api).toBe(api);
			expect(completeSimple.mock.calls[0][0].samplingParams).toBeUndefined();
			expect(completeSimple.mock.calls[0][2]).toMatchObject({ maxTokens: 96, maxRetries: 0 });
			const actual = JSON.stringify(captured);
			expect(actual).toContain("Predict one short, natural next message");
			expect(actual).toContain("把窗口图标调整得紧凑些");
			expect(actual).toContain("已调整图标，尚未构建。");
			expect(actual).not.toContain("OVERRIDE_CONTEXT_");
			expect(actual.length).toBeLessThan(8000);
			expect(captured).not.toHaveProperty("tools");
			expect(fetch).not.toHaveBeenCalled();
			expect(physical.samplingParams).toEqual(samplingParams);
			expect(physical.maxTokens).toBe(96);
			expect(f.state.model.maxTokens).toBe(0);
		},
	);

	it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
		"caps the actual %s payload without changing the configured model",
		async (api) => {
			const f = fixture();
			const samplingParams = { max_tokens: 64000, max_completion_tokens: 64000, max_output_tokens: 64000, n: 5 };
			f.state.model = { ...f.state.model, api, maxTokens: 96, samplingParams };
			let captured: Record<string, unknown> | undefined;
			const fetch = vi.fn<typeof globalThis.fetch>(async () => {
				throw new Error("No network allowed");
			});
			f.complete.mockImplementation(async (model, context, options) => {
				const capture = {
					...options,
					apiKey: "offline-fixture",
					fetch,
					onPayload: async (payload: unknown, routedModel: Model<Api>) => {
						captured = (await options.onPayload?.(payload, routedModel)) as Record<string, unknown>;
						throw new Error("OFFLINE_PAYLOAD_CAPTURE");
					},
				};
				const normalized = normalizeContext(context);
				if (api === "openai-completions")
					await openaiStreamSimple(model as Model<"openai-completions">, normalized, capture).result();
				if (api === "openai-responses")
					await responsesStreamSimple(model as Model<"openai-responses">, normalized, capture).result();
				if (api === "anthropic-messages")
					await anthropicStreamSimple(model as Model<"anthropic-messages">, normalized, capture).result();
				return prediction();
			});
			await f.service.request({}, "session", "a");
			const field =
				api === "openai-completions"
					? "max_completion_tokens"
					: api === "openai-responses"
						? "max_output_tokens"
						: "max_tokens";
			expect(captured?.[field]).toBe(96);
			expect(captured?.tools).toBeUndefined();
			expect(fetch).not.toHaveBeenCalled();
			expect(f.state.model.samplingParams).toEqual(samplingParams);
			expect(f.state.model.maxTokens).toBe(96);
		},
	);

	it("bounds sampling overrides reintroduced by a virtual model's physical route", async () => {
		const f = fixture();
		let captured: unknown;
		f.complete.mockImplementation(async (_model, context, options) => {
			const physical = {
				...f.state.model,
				samplingParams: {
					max_completion_tokens: 50000,
					n: 5,
					tools: [{ type: "function", function: { name: "bad" } }],
				},
			};
			await openaiStreamSimple(physical as Model<"openai-completions">, normalizeContext(context), {
				...options,
				apiKey: "offline-fixture",
				fetch: async () => {
					throw new Error("No network allowed");
				},
				onPayload: async (payload, model) => {
					captured = await options.onPayload?.(payload, model);
					throw new Error("OFFLINE_PAYLOAD_CAPTURE");
				},
			}).result();
			return prediction();
		});
		await f.service.request({}, "session", "a");
		expect(captured).toMatchObject({ max_completion_tokens: 192, n: 1 });
		expect(captured).not.toHaveProperty("tools");
	});
});
