/**
 * Claude 模式的轮末总结行。
 *
 * Claude Desktop 的形态（实机截图）：
 *
 *   Searched code, read and edited style.css, ran a command  +90 −7  >
 *
 * 前半句是「本轮做过什么」（动词 + 对象，去重后列举），后半句是本轮的代码增删，
 * 绿色 +N 是新增、红色 −N 是删除。整行灰字、可点开。
 */

import { useState } from "react";
import type { ToolCard } from "../hooks/transcript.ts";
import { claudeTurnSummaryText } from "./claude-answer-spec.ts";
import { IconChevron } from "./icons.tsx";

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

function formatElapsed(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

export function ClaudeTurnSummaryRow({ summary }: { summary: ClaudeTurnSummary }): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	if (summary.steps === 0 && summary.failed === 0) return null;

	const actions = summary.cards === undefined ? "" : claudeTurnSummaryText(summary.cards);
	const elapsed = summary.elapsedMs !== undefined && summary.elapsedMs >= 1000 ? formatElapsed(summary.elapsedMs) : "";
	const failures = summary.failed > 0 ? `${summary.failed} 条失败` : "";
	// Claude 的这行以「做过什么」为主语；没有可归纳的动作时退回步数。
	const text = actions !== "" ? actions : summary.steps > 0 ? `${summary.steps} 项操作` : "";
	const tail = [failures, elapsed].filter((part) => part !== "");
	if (text === "" && tail.length === 0) return null;

	return (
		<div className="owl-claude-summary">
			<button type="button" className="owl-claude-summary-head" data-message-action-ui="" aria-expanded={open} onClick={() => setOpen(!open)}>
				{text !== "" && <span className="owl-claude-summary-text">{text}</span>}
				{summary.added !== undefined && summary.added > 0 && <span className="owl-claude-summary-added">+{summary.added}</span>}
				{summary.removed !== undefined && summary.removed > 0 && <span className="owl-claude-summary-removed">−{summary.removed}</span>}
				{tail.length > 0 && <span className="owl-claude-summary-tail">{tail.join(" · ")}</span>}
				{/* Claude 这行末尾也有一个箭头：同样可点开。 */}
				<IconChevron className="owl-claude-summary-chevron h-3 w-3 shrink-0 transition-transform" />
			</button>
			{open && (
				<div className="owl-claude-summary-body">
					{summary.failed > 0 && <div className="owl-claude-summary-failed">有 {summary.failed} 条失败记录需要核对。</div>}
				</div>
			)}
		</div>
	);
}
