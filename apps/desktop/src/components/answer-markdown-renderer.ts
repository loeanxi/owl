import MarkdownIt from "markdown-it";
import { highlightCodeHtml } from "../../../../packages/coding-agent/src/utils/syntax-highlight.ts";
import { pathCandidateFromCode } from "../utils/paths.ts";
import { replyReadingText } from "./reply-reading-copy.ts";
import { classifyChip, type TurnDiffSummary } from "./turn-diff.ts";

/**
 * 本轮改动的染色上下文（渲染期间有效）。
 *
 * markdown-it 的渲染器是模块级单例，没法按调用带上下文；渲染是同步的，
 * 所以在渲染前后设置这个模块变量即可，不会串味。
 */
let diffOfRender: TurnDiffSummary | undefined;

/** 芯片的 class：added 绿 / removed 红 / modified 黄，跟 Claude 的 git 三色一致。 */
const CHIP_CLASS = {
	added: "owl-chip-added",
	removed: "owl-chip-removed",
	modified: "owl-chip-modified",
} as const;

function createMarkdownRenderer(): MarkdownIt {
	const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
	// Keep inline path chips identical to the chat/document preview renderer's existing rule.
	const inlineCodeDefault = md.renderer.rules.code_inline;
	md.renderer.rules.code_inline = (tokens, idx, _options, _env, self): string => {
		const token = tokens[idx]!;
		// 本轮改动过的代码：Claude 按 git 语义染色（新增绿 / 删除红 / 修改黄）。
		// 判定在路径识别之前 —— 改动过的标识符（版本号、类名）不一定是路径。
		const tint = diffOfRender === undefined ? undefined : classifyChip(token.content, diffOfRender);
		if (tint !== undefined) {
			return `<code class="${CHIP_CLASS[tint]}"${self.renderAttrs(token)}>${md.utils.escapeHtml(token.content)}</code>`;
		}
		if (pathCandidateFromCode(token.content) === "") {
			return inlineCodeDefault
				? inlineCodeDefault(tokens, idx, _options, _env, self)
				: `<code>${md.utils.escapeHtml(token.content)}</code>`;
		}
		return `<code class="owl-path-chip"${self.renderAttrs(token)}>${md.utils.escapeHtml(token.content)}</code>`;
	};
	return md;
}

const plainMd = createMarkdownRenderer();
const md = createMarkdownRenderer();

/**
 * 代码块正文：先按围栏语言上色，解析不出语法（或体积超限）就退回转义原文。
 * 高亮库输出本身就是转义过的 HTML，payload 永远不会被当成标签渲染。
 *
 * 结果按「语言 + 原文」缓存：流式回答每来几个字就重渲染整篇，但只有正在变的那一块会 miss，
 * 已定稿的块（历史消息、同一回答里前面的块）都直接命中，不重复分词。
 */
const CODE_CACHE_LIMIT = 200;
const codeCache = new Map<string, string>();

function renderCodeBody(content: string, language: string): string {
	const cacheKey = `${language}\u0000${content}`;
	const cached = codeCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const rendered = highlightCodeHtml(content, language) ?? md.utils.escapeHtml(content);
	if (codeCache.size >= CODE_CACHE_LIMIT) {
		const oldest = codeCache.keys().next().value;
		if (oldest !== undefined) codeCache.delete(oldest);
	}
	codeCache.set(cacheKey, rendered);
	return rendered;
}

/** Wrapping never trims or reconstructs the parsed code payload; only coloring is added. */
function renderCode(content: string, language: string): string {
	const escape = md.utils.escapeHtml;
	const lineCount = Math.max(1, content.split("\n").length - Number(content.endsWith("\n")));
	return `<div class="owl-answer-code" data-answer-code="" data-answer-code-lines="${lineCount}" data-answer-language="${escape(language)}">`
		+ `<div class="owl-answer-code-toolbar" data-answer-toolbar=""><span class="owl-answer-code-language">${escape(language || replyReadingText("code"))}</span>`
		+ `<div class="owl-answer-code-actions"><button type="button" data-answer-action="copy-code">${escape(replyReadingText("copy"))}</button>`
		+ `<button type="button" data-answer-action="expand-code" aria-expanded="false" hidden>${escape(replyReadingText("expandCode"))}</button></div>`
		+ '<span data-answer-copy-status="" role="status" aria-live="polite"></span></div>'
		+ `<pre><code>${renderCodeBody(content, language)}</code></pre></div>\n`;
}

md.renderer.rules.fence = (tokens, idx): string => {
	const token = tokens[idx]!;
	// Fence info is display-only text. It never becomes a class, an attribute or executable markup.
	const language = md.utils.unescapeAll(token.info).trim().split(/\s+/)[0] ?? "";
	return renderCode(token.content, language);
};
md.renderer.rules.code_block = (tokens, idx): string => renderCode(tokens[idx]!.content, "");

// 共用预览（文档页、编辑器预览、弹窗预览）没有阅读控件，但代码块同样要上色。
plainMd.renderer.rules.fence = (tokens, idx): string => {
	const token = tokens[idx]!;
	const language = plainMd.utils.unescapeAll(token.info).trim().split(/\s+/)[0] ?? "";
	return `<pre><code>${renderCodeBody(token.content, language)}</code></pre>\n`;
};
plainMd.renderer.rules.code_block = (tokens, idx): string => `<pre><code>${renderCodeBody(tokens[idx]!.content, "")}</code></pre>\n`;

md.renderer.rules.table_open = (tokens, idx, options, _env, self): string => {
	const escape = md.utils.escapeHtml;
	return '<div class="owl-answer-table" data-answer-table=""><div class="owl-answer-table-toolbar" data-answer-toolbar="">'
		+ `<span data-answer-table-hint="" hidden>${escape(replyReadingText("tableScroll"))}</span>`
		+ `<button type="button" data-answer-action="expand-table" aria-expanded="false" hidden>${escape(replyReadingText("expandTable"))}</button></div>`
		+ `<div class="owl-answer-table-scroll" data-answer-table-scroll="" tabindex="0" role="region" aria-label="${escape(replyReadingText("tableLabel"))}">`
		+ self.renderToken(tokens, idx, options);
};
md.renderer.rules.table_close = (tokens, idx, options, _env, self): string => `${self.renderToken(tokens, idx, options)}</div></div>\n`;

/**
 * Safe answer Markdown with complete code/table content and delegated reading controls.
 *
 * @param diff 本轮改动的染色上下文：其中的行内 code 按 git 语义染色（Claude 的做法）。
 */
export function renderAnswerMarkdown(text: string, diff?: TurnDiffSummary): string {
	const previous = diffOfRender;
	diffOfRender = diff;
	try {
		return md.render(text);
	} finally {
		diffOfRender = previous;
	}
}

/** Shared previews keep their original markup without controls requiring MarkdownAnswer. */
export function renderPlainMarkdown(text: string): string {
	return plainMd.render(text);
}
