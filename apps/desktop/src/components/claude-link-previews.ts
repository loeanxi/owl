/**
 * Claude 的链接预览（web 工具结果 → favicon+标题卡）。
 *
 * Claude 的 web_search 展开面板是 rich_content：来源渲染成可点的
 * 标题卡（favicon + 标题），不是裸文本。
 *
 * owl 的 web_search 输出文本有固定格式（owl-web-access 的
 * formatSearchSummary）：`**Sources:**` 段之后每条是
 *
 *     1. 标题
 *        https://example.com/page
 *
 * 这里把这段解析出来渲染预览卡；没有该段（或解析不出）就保持原始文本。
 * favicon 用域名字母瓦片（离线安全，不外联）。
 */

import type { ToolCard } from "../hooks/transcript.ts";

/** 一条链接预览。 */
export type ClaudeLinkPreview = {
	/** 来源标题（Sources 段的标题行）。 */
	title: string;
	/** 来源地址。 */
	url: string;
	/** 域名（显示用）。 */
	domain: string;
};

function parseSourcesSection(text: string): ClaudeLinkPreview[] {
	const marker = text.indexOf("**Sources:**");
	if (marker === -1) return [];
	const section = text.slice(marker + "**Sources:**".length);
	const out: ClaudeLinkPreview[] = [];
	const pattern = /(\d+)\.\s+([^\n]+)\n\s+(https?:\/\/\S+)/g;
	for (const match of section.matchAll(pattern)) {
		const title = match[2]!.trim();
		const url = match[3]!.trim();
		let domain = "";
		try {
			domain = new URL(url).hostname.replace(/^www\./, "");
		} catch {
			continue;
		}
		if (title === "" || domain === "") continue;
		out.push({ title, url, domain });
	}
	return out;
}

/**
 * 从工具卡输出解析链接预览；不是 web_search（或没有 Sources 段）返回空数组。
 */
export function claudeLinkPreviews(card: ToolCard): ClaudeLinkPreview[] {
	if (card.name !== "web_search") return [];
	const output = card.output;
	if (output === undefined || output.text.trim() === "") return [];
	return parseSourcesSection(output.text);
}
