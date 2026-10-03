/**
 * 宿主兼容小件 — 移植自 billion-context-pi src/compat.ts（MIT）。
 * owl 的 systemPrompt 是 string；保留 normalize 以防上游运行时形态变化。
 */
import type { ExtensionContext } from "@owl/owl-coding-agent";

export function normalizeSystemPrompt(input: string | string[] | undefined): string {
	if (input === undefined) return "";
	if (Array.isArray(input)) return input.join("\n");
	return input;
}

export function formatSystemPromptForEvent(base: string | string[], append: string): string {
	return `${normalizeSystemPrompt(base)}\n\n${append}`;
}

export function getSystemPromptText(ctx: ExtensionContext): string {
	return normalizeSystemPrompt(ctx.getSystemPrompt?.());
}
