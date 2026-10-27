/**
 * Claude 风格的工具组。
 *
 * 形态（对着 Claude Desktop 实机截图还原）：
 *
 *   Searched code ⌄                     ← 组头：纯文字、14px、次级色、箭头在右
 *   ┌──────────────────────────────────┐
 *   │ Searched loean-{mark|word} ⌄      │ ← 组内一行：灰字短语 + 右侧箭头
 *   │ 6-  <title>loean · 账号池网关</title>  │ ← 展开后：原始输出，带行号
 *   │ 7-  <script>...</script>          │
 *   │ Searched \.({brand|...}) >        │ ← 下一条
 *   └──────────────────────────────────┘
 *
 * 整组一个圆角盒，盒内每条工具一行；点开某条在行下显示原始输出。
 * 组头是「一行一行」的工具记录，不是卡片：背景与正文一致，只有细边框。
 */

import { useState } from "react";
import type { ToolCard } from "../hooks/transcript.ts";
import { IconChevron } from "./icons.tsx";
import { claudeActionLine, claudeActionText, claudeGroupTitle } from "./claude-answer-spec.ts";

type ClaudeGroupRowProps = {
	card: ToolCard;
	/** 该行的展开状态由父级持有（整组一个 state，重渲染不丢）。 */
	open: boolean;
	onToggle: () => void;
};

function ClaudeGroupRow({ card, open, onToggle }: ClaudeGroupRowProps): React.JSX.Element {
	const line = claudeActionLine(card);
	const label = line === undefined ? card.summary : claudeActionText(line);
	const output = card.output;
	const hasOutput = output !== undefined && output.text.trim() !== "";
	// 失败行整行标红：Claude 的失败语义靠颜色表达，不另加图标占位。
	const failed = card.status === "error";
	return (
		<div className="owl-claude-group-row" data-open={open || undefined} data-status={card.status}>
			<button type="button" className="owl-claude-group-row-head" aria-expanded={open} onClick={onToggle}>
				<span className="owl-claude-group-row-label" title={label}>{label}</span>
				<IconChevron className="owl-claude-group-row-chevron h-3 w-3 shrink-0 transition-transform" />
			</button>
			{open && hasOutput && (
				<pre className="owl-claude-group-output">{output.text}</pre>
			)}
			{failed && <span className="owl-claude-group-row-failed" aria-hidden="true" />}
		</div>
	);
}

export function ClaudeToolGroupView({ cards }: { cards: ToolCard[] }): React.JSX.Element {
	const [collapsed, setCollapsed] = useState(false);
	const [openRow, setOpenRow] = useState<string | undefined>(undefined);
	const title = claudeGroupTitle(cards);
	const failedCount = cards.filter((card) => card.status === "error").length;
	return (
		<div className="owl-claude-group">
			<button type="button" className="owl-claude-group-head" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
				<span className="owl-claude-group-title">{title}</span>
				{failedCount > 0 && <span className="owl-claude-group-failed-count">{failedCount}</span>}
				<IconChevron className="owl-claude-group-chevron h-3 w-3 shrink-0 transition-transform" />
			</button>
			{!collapsed && (
				<div className="owl-claude-group-box">
					{cards.map((card) => (
						<ClaudeGroupRow
							key={card.id}
							card={card}
							open={openRow === card.id}
							onToggle={() => setOpenRow((current) => (current === card.id ? undefined : card.id))}
						/>
					))}
				</div>
			)}
		</div>
	);
}
