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
	});
});
