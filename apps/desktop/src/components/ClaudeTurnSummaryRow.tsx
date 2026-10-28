/**
 * Claude 模式的轮末总结行。
 *
 * 形态（对齐 Claude 的时间线行语言）：
 *
 *   Searched code, read index.html, read core.js  +12 -5
 *
 * 前半句是「本轮做过什么」（动词 + 对象，去重后列举，13px 次级色）；
 * 后半句是行内 diff 统计 —— mono 12px、+N 绿 / -N 红、无边框无底色
 * （Claude 的 compact Edit 行次级元素同款）。这行是**静默行**：
 * 不可展开、没有失败计数 —— 失败已经由组头的 "Failed" 状态词表达。
 */

import type { ToolCard } from "../hooks/transcript.ts";
import { claudeTurnSummaryText } from "./claude-answer-spec.ts";

export type ClaudeTurnSummary = {
	/** 本轮工具调用总步数。 */
	steps: number;
	/** 真失败数（不含已被后续成功修复的）。 */
	failed: number;
	/** 本轮累计耗时（毫秒）。 */
	elapsedMs?: number;
	/** 本轮的工具卡：用于归纳「做过什么」与改动过的文件。 */
	cards?: ToolCard[];
	/** 本轮代码增删行数。 */
	added?: number;
	removed?: number;
};

export function ClaudeTurnSummaryRow({ summary }: { summary: ClaudeTurnSummary }): React.JSX.Element | null {
	if (summary.steps === 0 && summary.failed === 0) return null;
	const actions = summary.cards === undefined ? "" : claudeTurnSummaryText(summary.cards);
	// Claude 的这行以「做过什么」为主语；没有可归纳的动作时退回步数。
	// 无动作可列举时退回 Claude 的步数措辞（bundle 的 "{count} steps"）。
	const text =
		actions !== "" ? actions : summary.steps > 0 ? (summary.steps === 1 ? "1 step" : `${summary.steps} steps`) : "";
	const hasDiff =
		(summary.added !== undefined && summary.added > 0) || (summary.removed !== undefined && summary.removed > 0);
	if (text === "" && !hasDiff) return null;
	return (
		<div className="owl-claude-summary">
			<div className="owl-claude-summary-head">
				{text !== "" && <span className="owl-claude-summary-text">{text}</span>}
				{hasDiff && (
					<span className="owl-claude-summary-diff">
						{summary.added !== undefined && summary.added > 0 && (
							<span className="owl-claude-diff-added">+{summary.added}</span>
						)}
						{summary.removed !== undefined && summary.removed > 0 && (
							<span className="owl-claude-diff-removed">-{summary.removed}</span>
						)}
					</span>
				)}
			</div>
		</div>
	);
}
