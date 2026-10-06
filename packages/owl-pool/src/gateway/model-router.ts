/**
 * 模型名路由工具 —— 移植自 manager `gateway/ModelRouter.stripPrefix`。
 */

/** 剥掉 wb/ trae/ 等路由前缀，得到上游真实模型名。 */
export function stripModelPrefix(model: string | null | undefined): string {
	if (model === null || model === undefined) {
		return "";
	}
	const lower = model.toLowerCase();
	if (
		lower.startsWith("wb/") ||
		lower.startsWith("workbuddy/") ||
		lower.startsWith("codebuddy/") ||
		lower.startsWith("trae/") ||
		lower.startsWith("t/") ||
		lower.startsWith("codex/") ||
		lower.startsWith("zcode/") ||
		lower.startsWith("glm/") ||
		lower.startsWith("mimo/") ||
		lower.startsWith("xiaomi/") ||
		lower.startsWith("claude/") ||
		lower.startsWith("anthropic/") ||
		lower.startsWith("gemini/") ||
		lower.startsWith("grok/")
	) {
		const idx = model.indexOf("/");
		return idx >= 0 ? model.slice(idx + 1) : model;
	}
	return model;
}
