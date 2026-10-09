import { describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import {
	DEFAULT_LOEAN_BASE_URL,
	healLoeanStoredModel,
	loeanCompatFromCatalog,
	loeanModelsFromCatalog,
	loeanProvider,
	normalizeLoeanBaseUrl,
	resolveLoeanInputModalities,
	thinkingLevelMapFromEfforts,
} from "../src/providers/loean.ts";

describe("loean gateway url", () => {
	it("normalizes bare host, missing path, and trailing slashes to the /v1 base", () => {
		expect(normalizeLoeanBaseUrl("127.0.0.1:8790")).toBe("http://127.0.0.1:8790/v1");
		expect(normalizeLoeanBaseUrl("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790/v1");
		expect(normalizeLoeanBaseUrl("http://127.0.0.1:8790/")).toBe("http://127.0.0.1:8790/v1");
		expect(normalizeLoeanBaseUrl("https://gw.example.com/v1/")).toBe("https://gw.example.com/v1");
		expect(normalizeLoeanBaseUrl("  https://gw.example.com/v1  ")).toBe("https://gw.example.com/v1");
	});

	it("falls back to the default gateway on blank or malformed input", () => {
		expect(normalizeLoeanBaseUrl("")).toBe(DEFAULT_LOEAN_BASE_URL);
		expect(normalizeLoeanBaseUrl("http://[::bad")).toBe(DEFAULT_LOEAN_BASE_URL);
	});
});

describe("loean thinking level mapping", () => {
	it("rounds a missing effort up before rounding down (manager 方针：只多不少)", () => {
		// qfmodel 实测案例：架上 ["xhigh","low","medium","none"]，请求 high 应取 xhigh
		const map = thinkingLevelMapFromEfforts(["xhigh", "low", "medium", "none"]);
		expect(map.high).toBe("xhigh");
		expect(map.max).toBe("xhigh");
		expect(map.low).toBe("low");
		expect(map.medium).toBe("medium");
		expect(map.minimal).toBe("low");
	});

	it("maps every level to the only published effort and passes exact matches through", () => {
		const single = thinkingLevelMapFromEfforts(["high"]);
		expect(single).toEqual({ minimal: "high", low: "high", medium: "high", high: "high", max: "high" });
		const exact = thinkingLevelMapFromEfforts(["none", "minimal", "low", "medium", "high"]);
		expect(exact.high).toBe("high");
		expect(exact.minimal).toBe("minimal");
	});

	it("marks levels unsupported when nothing publishes", () => {
		expect(thinkingLevelMapFromEfforts([])).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: null,
			max: null,
		});
	});
});

describe("loean catalog mapping", () => {
	it("maps published capability values into openai-completions models", () => {
		const models = loeanModelsFromCatalog("loean", DEFAULT_LOEAN_BASE_URL, {
			data: [
				{
					id: "qfmodel",
					context_window: 1_000_000,
					max_output_tokens: 32_000,
					reasoning_efforts: ["xhigh", "low", "medium", "none"],
				},
				{ id: "step-5-preview", context_window: 200_000 },
			],
		});
		expect(models.map((model) => model.id)).toEqual(["qfmodel", "step-5-preview"]);
		const qf = models[0]!;
		expect(qf).toMatchObject({
			provider: "loean",
			api: "openai-completions",
			baseUrl: DEFAULT_LOEAN_BASE_URL,
			contextWindow: 1_000_000,
			maxTokens: 32_000,
			reasoning: true,
			input: ["text"],
			type: "chat",
		});
		expect(qf.thinkingLevelMap?.high).toBe("xhigh");
		expect(qf.contextWindowConfirmed).toBe(true);
		// 未公布方言时仍是最朴素的 OpenAI 请求：网关按 max_tokens 收顶，不发 store/developer 扩展
		expect(qf.compat).toMatchObject({
			maxTokensField: "max_tokens",
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
		});
		expect(qf.compat?.thinkingFormat).toBeUndefined();

		// 未公布思考档位的模型按非推理处理，pi 不会发 reasoning_effort
		const step = models[1]!;
		expect(step.reasoning).toBe(false);
		expect(step.thinkingLevelMap).toBeUndefined();
		expect(step.contextWindow).toBe(200_000);
		expect(step.contextWindowConfirmed).toBe(true);
		expect(step.maxTokens).toBe(32_768);
		expect(step.compat?.supportsReasoningEffort).toBeUndefined();
	});

	it("keeps an unpublished context window marked unconfirmed and applies a published dialect", () => {
		const models = loeanModelsFromCatalog("loean", DEFAULT_LOEAN_BASE_URL, {
			data: [
				{
					id: "deepseek-v4",
					reasoning_efforts: ["high", "low"],
					compat: {
						thinking_format: "deepseek",
						requires_reasoning_content: true,
						max_tokens_field: "max_tokens",
					},
				},
				{ id: "hy3-window" },
			],
		});
		const deepseek = models.find((model) => model.id === "deepseek-v4")!;
		expect(deepseek.contextWindowConfirmed).toBe(false);
		expect(deepseek.compat).toMatchObject({
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
			maxTokensField: "max_tokens",
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
		});
		expect(models.find((model) => model.id === "hy3-window")?.contextWindowConfirmed).toBe(false);
		expect(loeanCompatFromCatalog({ thinkingFormat: "not-a-format" }, false).thinkingFormat).toBeUndefined();
	});

	it("accepts a bare array payload and drops rows without ids", () => {
		const models = loeanModelsFromCatalog("loean", DEFAULT_LOEAN_BASE_URL, [{ context_window: 1 }, { id: "hy3" }]);
		expect(models.map((model) => model.id)).toEqual(["hy3"]);
	});

	it("throws on an unexpected payload shape", () => {
		expect(() => loeanModelsFromCatalog("loean", DEFAULT_LOEAN_BASE_URL, { data: "nope" })).toThrow();
	});

	it("treats deepseek-v4.1-flash as vision from id heuristic or explicit supports_images", () => {
		expect(resolveLoeanInputModalities({ id: "deepseek-v4.1-flash" })).toEqual(["text", "image"]);
		expect(resolveLoeanInputModalities({ id: "hy3", supports_images: true })).toEqual(["text", "image"]);
		expect(resolveLoeanInputModalities({ id: "deepseek-v4.1-flash", supports_images: false })).toEqual(["text"]);
		const fromCatalog = loeanModelsFromCatalog("loean", DEFAULT_LOEAN_BASE_URL, [
			{ id: "deepseek-v4.1-flash" },
			{ id: "hy3", supports_images: 1 },
			{ id: "qwen-text", supports_images: false },
		]);
		expect(fromCatalog.find((model) => model.id === "deepseek-v4.1-flash")?.input).toEqual(["text", "image"]);
		expect(fromCatalog.find((model) => model.id === "hy3")?.input).toEqual(["text", "image"]);
		expect(fromCatalog.find((model) => model.id === "qwen-text")?.input).toEqual(["text"]);
	});

	it("heals stale cached catalogs that omitted image from flash models", () => {
		const healed = healLoeanStoredModel({
			id: "deepseek-v4.1-flash",
			input: ["text"] as const,
			provider: "loean",
		});
		expect(healed.input).toEqual(["text", "image"]);
		expect(healLoeanStoredModel({ id: "hy3", input: ["text"] as const }).input).toEqual(["text"]);
	});
});

describe("loean provider", () => {
	it("registers as a dynamic openai-completions provider with env-key auth", () => {
		const provider = loeanProvider();
		expect(provider.id).toBe("loean");
		expect(provider.name).toBe("Loean");
		expect(provider.baseUrl).toBe(DEFAULT_LOEAN_BASE_URL);
		expect(provider.auth.apiKey).toBeDefined();
		expect(provider.auth.oauth).toBeUndefined();
		expect(provider.getModels()).toEqual([]);
		expect(provider.refreshModels).toBeDefined();
	});

	it("discovers LOEAN_API_KEY from the environment", () => {
		process.env.LOEAN_API_KEY = "sk-test";
		try {
			expect(findEnvKeys("loean")).toEqual(["LOEAN_API_KEY"]);
			expect(getEnvApiKey("loean")).toBe("sk-test");
		} finally {
			delete process.env.LOEAN_API_KEY;
		}
	});
});
