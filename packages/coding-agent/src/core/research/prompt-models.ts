/** Shared catalog metadata and limits; this module has no host or filesystem dependencies. */
export const RESEARCH_PROMPT_LIMITS = {
	presets: 500,
	fileBytes: 2_000_000,
	contentChars: 48_000,
	nameChars: 120,
	descriptionChars: 2_000,
	sourceUrlChars: 2_048,
	modelFamilies: 20,
} as const;

export const RESEARCH_PROMPT_MODEL_FAMILY_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";

export const RESEARCH_PROMPT_MODEL_FAMILIES = [
	{ id: "general", label: "通用", labelEn: "General" },
	{ id: "deepseek", label: "DeepSeek", labelEn: "DeepSeek" },
	{ id: "gpt", label: "GPT / ChatGPT", labelEn: "GPT / ChatGPT" },
	{ id: "claude", label: "Claude", labelEn: "Claude" },
	{ id: "gemini", label: "Gemini", labelEn: "Gemini" },
	{ id: "grok", label: "Grok", labelEn: "Grok" },
	{ id: "qwen", label: "Qwen / 通义千问", labelEn: "Qwen" },
	{ id: "glm", label: "GLM / 智谱", labelEn: "GLM" },
	{ id: "llama", label: "Llama", labelEn: "Llama" },
	{ id: "mistral", label: "Mistral", labelEn: "Mistral" },
	{ id: "kimi", label: "Kimi", labelEn: "Kimi" },
	{ id: "mimo", label: "MiMo", labelEn: "MiMo" },
	{ id: "doubao", label: "豆包", labelEn: "Doubao" },
	{ id: "gemma", label: "Gemma", labelEn: "Gemma" },
	{ id: "cohere", label: "Cohere", labelEn: "Cohere" },
	{ id: "nova", label: "Amazon Nova", labelEn: "Amazon Nova" },
	{ id: "hermes", label: "Nous Hermes", labelEn: "Nous Hermes" },
	{ id: "other", label: "其他 / 客户端模板", labelEn: "Other / client templates" },
] as const;

export interface ResearchPromptModelMetadata {
	id: string;
	name: string;
	description?: string;
	sourceUrl?: string;
	modelFamilies?: readonly string[];
}

export function researchPromptModelLabel(id: string, language: "zh" | "en"): string {
	const family = RESEARCH_PROMPT_MODEL_FAMILIES.find((item) => item.id === id);
	return family ? (language === "en" ? family.labelEn : family.label) : id;
}

/** Metadata describes intended targets, never a claim that a prompt works with the current model. */
export function inferResearchPromptModelFamilies(preset: ResearchPromptModelMetadata): string[] {
	if (preset.modelFamilies !== undefined) {
		return preset.modelFamilies.length ? [...new Set(preset.modelFamilies)] : ["general"];
	}
	const sourceFile = preset.sourceUrl?.split("/").at(-1)?.split(/[?#]/)[0] ?? "";
	const hint = `${preset.id}\n${preset.name}\n${sourceFile}`.toLowerCase();
	const aliases: Array<[string, RegExp]> = [
		["deepseek", /deepseek/],
		["gpt", /(^|[^a-z])(?:chatgpt|gpt)([^a-z]|$)|openai\.mkd|codex/],
		["claude", /claude|anthropic/],
		["gemini", /gemini|google\.mkd/],
		["grok", /grok|xai\.mkd/],
		["qwen", /qwen|qwq|通义|alibaba\.mkd/],
		["glm", /glm|智谱|zai\.mkd/],
		["llama", /llama|meta\.mkd/],
		["mistral", /mistral/],
		["kimi", /kimi|moonshot/],
		["mimo", /mimo/],
		["doubao", /doubao|豆包/],
		["gemma", /gemma/],
		["cohere", /cohere/],
		["nova", /amazon[ -]?nova/],
		["hermes", /hermes|nous\.mkd/],
	];
	const families = aliases.filter(([, pattern]) => pattern.test(hint)).map(([id]) => id);
	if (families.length) return families;
	return /cursor|workbuddy|copilot|perplexity|brave/.test(hint) ? ["other"] : ["general"];
}

/** Filtering returns a view of the library; neither preset data nor the active override is changed. */
export function filterResearchPromptPresets<T extends ResearchPromptModelMetadata>(
	presets: readonly T[],
	filter: { modelFamily: string; search: string },
): T[] {
	const search = filter.search.trim().toLowerCase();
	return presets.filter((preset) => {
		const families = inferResearchPromptModelFamilies(preset);
		if (filter.modelFamily !== "all" && !families.includes(filter.modelFamily)) return false;
		if (!search) return true;
		return [
			preset.name,
			preset.id,
			preset.description ?? "",
			preset.sourceUrl ?? "",
			...families,
			...families.map((id) => researchPromptModelLabel(id, "zh")),
			...families.map((id) => researchPromptModelLabel(id, "en")),
		]
			.join("\n")
			.toLowerCase()
			.includes(search);
	});
}
