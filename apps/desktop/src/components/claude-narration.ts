/**
 * Claude 的「说明行」文案规则。
 *
 * 规格来源：Claude Desktop 打包渲染层
 *   `c05b96c7f-DklIyA-P.js` 的分组器 `ie()` —— 它把 assistant 的 content block
 *   归成四类可渲染单元，其中一类是「说明行」：
 *
 *     说明行 —— label = 首行正文（截断到 200 字符）
 *
 * 也就是说：Claude 把模型的**中间叙述**（"Let me look at the sidebar first."）
 * 收成一行，只有**最终回答**才是整段正文。owl 之前把两者都当正文渲染，
 * 于是长回答里每句自言自语都是一整段，读起来像五条消息。
 *
 * 首行提取与截断复用 `claude-answer-groups.ts` 里的 `firstContentLine` /
 * `truncateLabel` —— 那两个函数就是照 Claude 的 `ss()` 与 `Zo=200` 写的。
 */

import { firstContentLine, truncateLabel } from "./claude-answer-groups.ts";

/** Claude 的说明行上限（bundle 里的 Zo=200）。 */
export const CLAUDE_NOTE_MAX_CHARS = 200;

/** 说明行的标题：首行正文，截断到 200 字符。 */
export function claudeNoteLabel(text: string): string {
	const line = firstContentLine(text);
	return line === undefined ? "" : truncateLabel(line, CLAUDE_NOTE_MAX_CHARS);
}

/**
 * 这段文字是否只有一行 —— 只有一行就没有可折叠的内容。
 */
export function claudeNoteIsSingleLine(text: string): boolean {
	const label = claudeNoteLabel(text);
	return label !== "" && label === text.trim();
}
