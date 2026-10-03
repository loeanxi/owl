// 移植自 billion-context-pi src/tag-tokens.ts（MIT）
import { defaultCountTokens } from "./kernel.js";

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`;
	return `${Math.round(tokens / 1000)}K`;
}

export function stableTagTokens(text: string): string {
	return formatTokens(defaultCountTokens(text));
}

// 重写 <acp tokens="..."> 标签里的 token 计数，使其与当前消息体一致。
// 标签一旦写入就不再变（tokenSnapshot 固化），避免前缀缓存失效。
export function rewriteTagTokens(tag: string, body: string): string {
	return tag.replace(/tokens="[^"]*"/, `tokens="${stableTagTokens(body)}"`);
}
