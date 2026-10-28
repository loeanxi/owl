/**
 * 引用的行内角标与来源面板。
 *
 * Claude Desktop 把引用做成锚点级 UI：正文里是上标角标，答案末尾是来源面板
 * （bundle 里的 `All sources` / `Browse Anthropic sources`）。
 * 它的判定还影响折叠：`Ym()` 判「有引用就不折叠」——
 * 被引用的段落是内容，不能折起来。
 *
 * 角标位置：
 *  - `url_citation`（OpenAI Responses）的 `end_index` 是**正文里的字符偏移**，
 *    角标插在被引片段之后。
 *  - Anthropic 的 `char_location` / `page_location` / `content_block_location`
 *    的偏移是**源文档里的位置**，不是正文位置 —— 拿它当正文偏移会把角标插错地方。
 *    这类引用没有正文锚点，角标落在段落末尾。
 */

import type { Citation } from "../hooks/transcript.ts";
import { replyReadingText } from "./reply-reading-copy.ts";

/** 来源面板里的一项。 */
export type CitationSource = {
	/** 面板里的序号（1 起）。 */
	index: number;
	citation: Citation;
};

/**
 * 把引用整理成来源列表。
 *
 * 同一个来源可能被引用多次，面板里只列一条，正文里共用同一个序号。
 */
export function buildCitationSources(citations: readonly Citation[] | undefined): CitationSource[] {
	if (!citations || citations.length === 0) return [];
	const sources: CitationSource[] = [];
	const seen = new Map<string, number>();
	for (const citation of citations) {
		const key = `${citation.url ?? ""}|${citation.title ?? ""}|${citation.source ?? ""}`;
		if (seen.has(key)) continue;
		seen.set(key, sources.length + 1);
		sources.push({ index: sources.length + 1, citation });
	}
	return sources;
}

/** 角标占位符：私有区字符，不会被 markdown 或 HTML 吃掉。 */
const MARKER_OPEN = "\uE000";
const MARKER_CLOSE = "\uE001";

function markerPlaceholder(index: number): string {
	return `${MARKER_OPEN}cite${index}${MARKER_CLOSE}`;
}

/** 只有 OpenAI 的 `url_citation` 的偏移是正文偏移。 */
function hasTextAnchor(citation: Citation): boolean {
	return citation.source === "url_citation" && typeof citation.endIndex === "number";
}

/**
 * 在正文里插入角标占位符。
 *
 * 插入点按偏移从大到小排，避免前面的插入把后面的偏移顶掉。
 */
export function insertCitationMarkers(text: string, sources: readonly CitationSource[]): string {
	if (sources.length === 0) return text;
	const insertions: { at: number; marker: string }[] = [];
	const anchored = new Set<number>();
	for (const source of sources) {
		if (!hasTextAnchor(source.citation)) continue;
		const end = source.citation.endIndex!;
		if (end < 0 || end > text.length) continue;
		insertions.push({ at: end, marker: markerPlaceholder(source.index) });
		anchored.add(source.index);
	}
	// 没有正文锚点的引用，角标落在末尾。
	const tail = sources
		.filter((source) => !anchored.has(source.index))
		.map((source) => markerPlaceholder(source.index));
	insertions.sort((a, b) => b.at - a.at);
	let out = text;
	for (const insertion of insertions) {
		out = out.slice(0, insertion.at) + insertion.marker + out.slice(insertion.at);
	}
	return tail.length === 0 ? out : out + tail.join("");
}

/** 一个来源的角标 HTML：上标数字，有地址就链到来源。 */
function citationMarkerHtml(source: CitationSource): string {
	const escape = (value: string): string =>
		value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const url = source.citation.url;
	const label = escape(String(source.index));
	const body =
		url === undefined
			? label
			: `<a href="${escape(url)}" target="_blank" rel="noreferrer noopener" data-answer-cite="${source.index}">${label}</a>`;
	return `<sup class="owl-answer-cite" data-answer-cite-marker="${source.index}">${body}</sup>`;
}

/**
 * 把渲染后的 HTML 里的角标占位符换成角标本体。
 *
 * 占位符用私有区字符，markdown-it 不会改它，HTML 解析也不会丢它。
 */
export function replaceCitationMarkers(html: string, sources: readonly CitationSource[]): string {
	if (sources.length === 0) return html;
	const byIndex = new Map(sources.map((source) => [source.index, source]));
	return html.replace(new RegExp(`${MARKER_OPEN}cite(\\d+)${MARKER_CLOSE}`, "g"), (_match, raw: string) => {
		const source = byIndex.get(Number(raw));
		return source === undefined ? "" : citationMarkerHtml(source);
	});
}

/** 来源面板的 HTML —— 一张卡一个来源（Claude 的 `tool_cell_source_card`）。 */
export function renderSourcesPanel(sources: readonly CitationSource[]): string {
	if (sources.length === 0) return "";
	const escape = (value: string): string =>
		value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const items = sources
		.map((source) => {
			const title = source.citation.title?.trim() || source.citation.url || replyReadingText("sourcesUntitled");
			const url = source.citation.url;
			const label = escape(title);
			const body =
				url === undefined
					? label
					: `<a href="${escape(url)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
			const host = url === undefined ? "" : hostOf(url);
			const badge = escape((host || title).slice(0, 1).toUpperCase());
			const hostLine = host === "" ? "" : `<span class="owl-answer-source-host">${escape(host)}</span>`;
			const snippet = source.citation.snippet?.trim();
			const snippetLine =
				snippet === undefined || snippet === ""
					? ""
					: `<p class="owl-answer-source-snippet">${escape(snippet)}</p>`;
			return (
				`<li class="owl-answer-source" data-answer-source="${source.index}">` +
				`<span class="owl-answer-source-badge" aria-hidden="true">${badge}</span>` +
				`<span class="owl-answer-source-body">${body}${hostLine}</span>` +
				snippetLine +
				"</li>"
			);
		})
		.join("");
	return `<div class="owl-answer-sources" data-answer-sources=""><div class="owl-answer-sources-title">${escape(replyReadingText("sources"))}</div><ul class="owl-answer-sources-list">${items}</ul></div>`;
}

/** 取地址的主机名（面板里显示一行来源域名）。 */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}
