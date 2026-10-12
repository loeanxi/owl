import { describe, expect, it } from "vitest";
import {
	filterResearchPromptPresets,
	inferResearchPromptModelFamilies,
	researchPromptModelLabel,
} from "../src/core/research/prompt-models.ts";

describe("research prompt model classification", () => {
	it("honors explicit multi-model or general metadata before old names and source hints", () => {
		const preset = { id: "deepseek-old-name", name: "DeepSeek 旧名称", modelFamilies: ["claude", "gemini"] };
		expect(inferResearchPromptModelFamilies(preset)).toEqual(["claude", "gemini"]);
		expect(inferResearchPromptModelFamilies({ ...preset, modelFamilies: [] })).toEqual(["general"]);
		expect(
			inferResearchPromptModelFamilies({
				id: "deepseek-langgpt-method-1",
				name: "DeepSeek 样本",
				sourceUrl: "https://github.com/langgptai/awesome-deepseek-prompts",
			}),
		).toEqual(["deepseek"]);
		expect(inferResearchPromptModelFamilies({ id: "custom", name: "我的方法" })).toEqual(["general"]);
		expect(
			inferResearchPromptModelFamilies({
				id: "deepseek-template",
				name: "DeepSeek 源模板",
				sourceUrl: "https://github.com/author/gpt6-Astra/blob/main/packs/deepseek.md",
			}),
		).toEqual(["deepseek"]);
		expect(inferResearchPromptModelFamilies({ id: "cursor-preset", name: "Cursor 源模板" })).toEqual(["other"]);
	});

	it("filters multi-model samples and source/name keywords without changing the library", () => {
		const presets = [
			{
				id: "source-a",
				name: "Claude 与 Gemini",
				modelFamilies: ["claude", "gemini"],
				sourceUrl: "https://github.com/example/catalog",
				content: "正文保持原样",
			},
			{ id: "source-b", name: "GPT", modelFamilies: ["gpt"], content: "第二份正文" },
			{ id: "source-c", name: "通用资料", content: "第三份正文" },
		];
		const snapshot = structuredClone(presets);
		expect(
			filterResearchPromptPresets(presets, { modelFamily: "claude", search: "" }).map((preset) => preset.id),
		).toEqual(["source-a"]);
		expect(
			filterResearchPromptPresets(presets, { modelFamily: "gemini", search: "CATALOG" }).map((preset) => preset.id),
		).toEqual(["source-a"]);
		expect(
			filterResearchPromptPresets(presets, { modelFamily: "general", search: "" }).map((preset) => preset.id),
		).toEqual(["source-c"]);
		expect(filterResearchPromptPresets(presets, { modelFamily: "all", search: "不存在" })).toEqual([]);
		expect(filterResearchPromptPresets(presets, { modelFamily: "all", search: "" })).toEqual(presets);
		expect(presets).toEqual(snapshot);
	});

	it("keeps unrecognized valid tags readable and searchable", () => {
		const preset = { id: "future", name: "未来模型样本", modelFamilies: ["future-model"] };
		expect(researchPromptModelLabel("future-model", "zh")).toBe("future-model");
		expect(filterResearchPromptPresets([preset], { modelFamily: "future-model", search: "future-model" })).toEqual([
			preset,
		]);
	});
});
