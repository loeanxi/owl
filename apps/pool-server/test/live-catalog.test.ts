import { describe, expect, it } from "vitest";
import { mergeTraeCatalog } from "../src/catalog/trae-catalog.ts";
import { parseWorkBuddyVisibleModels } from "../src/catalog/workbuddy-catalog.ts";

describe("live model catalogs", () => {
	it("keeps Trae models that appear in both the visible roster and the callable config", () => {
		const models = mergeTraeCatalog(
			{
				code: 0,
				data: {
					list: [
						{
							function: "solo_work_remote",
							models: [
								{
									name: "deepseek-v3",
									display_name: "DeepSeek",
									status: true,
									selectable: true,
									multimodal: false,
								},
							],
						},
					],
				},
			},
			new Map([
				[
					"solo_work_remote",
					{
						config_info_list: [
							{
								config_name: "deepseek-v3",
								display_config: { display_name: "DeepSeek" },
								model_detail_list: [{ prompt_max_tokens: 128000, max_tokens: 8192 }],
							},
						],
					},
				],
			]),
		);
		expect(models).toEqual([
			expect.objectContaining({ upstreamModel: "deepseek-v3", modes: ["Work"], contextWindow: 128000 }),
		]);
	});

	it("keeps the largest Trae window across detail rows, functions, and token maps", () => {
		const models = mergeTraeCatalog(
			{
				code: 0,
				data: {
					list: [
						{
							function: "solo_work_remote",
							models: [
								{
									name: "step-5-preview",
									display_name: "Step",
									status: true,
									selectable: true,
									context_window_tokens: { dev: 200_000, max: 1_000_000 },
								},
							],
						},
						{
							function: "solo_design_remote",
							models: [{ name: "step-5-preview", display_name: "Step", status: true, selectable: true }],
						},
					],
				},
			},
			new Map([
				[
					"solo_work_remote",
					{
						config_info_list: [
							{
								config_name: "step-5-preview",
								display_config: { display_name: "Step" },
								model_detail_list: [
									{ prompt_max_tokens: 200_000, max_tokens: 8_000 },
									{ prompt_max_tokens: 1_000_000, max_tokens: 64_000 },
								],
							},
						],
					},
				],
				[
					"solo_design_remote",
					{
						config_info_list: [
							{
								config_name: "step-5-preview",
								display_config: { display_name: "Step" },
								model_detail_list: [{ prompt_max_tokens: 128_000, max_tokens: 4_096 }],
							},
						],
					},
				],
			]),
		);
		expect(models).toEqual([
			expect.objectContaining({
				upstreamModel: "step-5-preview",
				contextWindow: 1_000_000,
				maxOutputTokens: 64_000,
				functionName: "solo_work_remote",
			}),
		]);
	});

	it("keeps the free WorkBuddy row and drops the paid copy", () => {
		const models = parseWorkBuddyVisibleModels(
			JSON.stringify({
				code: 0,
				data: {
					models: [
						{ id: "hy3", name: "Hunyuan", supportsToolCall: true, maxInputTokens: 32000 },
						{ id: "hy3-x", name: "Hunyuan Pro", supportsToolCall: true },
					],
					agents: [{ name: "cli", tags: ["default"], models: ["hy3", "hy3-x"] }],
					productFeaturesConfig: { ModelRateLimitCap: { lines: [{ freeId: "hy3", paidId: "hy3-x" }] } },
				},
			}),
		);
		expect(models.map((model) => model.upstreamModel)).toEqual(["hy3"]);
		expect(models[0]?.supportsTools).toBe(true);
		expect(models[0]?.contextWindow).toBe(32_000);
	});

	it("keeps the larger WorkBuddy context window when a smaller input cap is also present", () => {
		const models = parseWorkBuddyVisibleModels(
			JSON.stringify({
				code: 0,
				data: {
					models: [
						{
							id: "step-5-preview",
							name: "Step-5-Preview",
							contextWindow: 1_000_000,
							maxInputTokens: 32_000,
							maxAllowedSize: 8_000,
							supportsToolCall: true,
						},
					],
					agents: [{ name: "cli", tags: ["default"], models: ["step-5-preview"] }],
				},
			}),
		);
		expect(models[0]?.contextWindow).toBe(1_000_000);
	});

	it("uses the account picker whitelist instead of the default agent list", () => {
		const models = parseWorkBuddyVisibleModels(
			JSON.stringify({
				code: 0,
				data: {
					models: [
						{ id: "step-5-preview", name: "Step-5-Preview", supportsToolCall: true },
						{ id: "glm-5.3", name: "GLM-5.3", supportsToolCall: true },
						{ id: "glm-5.3-x", name: "GLM-5.3 Pro", supportsToolCall: true },
						{ id: "kimi-k3-1", name: "Kimi-K3" },
					],
					agents: [{ name: "cli", tags: ["default"], models: ["glm-5.3", "kimi-k3-1"] }],
					availableModels: ["step-5-preview", "glm-5.3", "glm-5.3-x"],
					productFeaturesConfig: { ModelRateLimitCap: { lines: [{ freeId: "glm-5.3", paidId: "glm-5.3-x" }] } },
				},
			}),
		);
		expect(models.map((model) => model.upstreamModel)).toEqual(["step-5-preview", "glm-5.3"]);
	});
});
