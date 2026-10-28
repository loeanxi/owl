/**
 * Claude 的子代理组。
 *
 * 形态（对齐 Claude Desktop 的 `bB()` / `ie()` 子代理组单元）：
 *
 *   Ran 3 agents ⌄                       ← 组头：Claude 的 ICU 复数写法
 *   （点开后才出现整组一个圆角盒）
 *   ┌──────────────────────────────────┐
 *   │ Searched auth paths ⌄              │ ← 盒内一条一行，和普通工具组同形
 *   └──────────────────────────────────┘
 *
 * 与普通工具组的差别只有两点：组头说的是「派出几个代理」，
 * 而不是这批工具在干什么 —— Claude 的子代理组标题固定是
 * `Ran {count, plural, one {# agent} other {# agents}}`。
 *
 * 折叠模型与状态词与普通工具组完全一致（同一个 store、同一套壳）：
 * 默认收起、单开手风琴、行尾状态词。
 */

import { useState, useSyncExternalStore } from "react";
import type { ToolCard } from "../hooks/transcript.ts";
import { claudeCellStateOf, claudeStateWord } from "./claude-state-words.ts";
import { claudeSubagentGroupLabel } from "./claude-subagent.ts";
import { claudeToolLabelFor } from "./claude-tool-labels.ts";
import { claudeGroupOpen, claudeGroupToggle, subscribeClaudeGroups } from "./claude-turn-status-open.ts";
import { IconChevron } from "./icons.tsx";

function SubagentRow({
	card,
	open,
	onToggle,
}: {
	card: ToolCard;
	open: boolean;
	onToggle: () => void;
}): React.JSX.Element {
	const label = claudeToolLabelFor(card);
	const output = card.output;
	const hasOutput = output !== undefined && output.text.trim() !== "";
	const word = claudeStateWord(claudeCellStateOf(card));
	// 跑动中的实时活动（owl-subagents 的 partial details.activity）。
	const activity = card.status === "running" || card.status === "pending" ? output?.activity : undefined;
	return (
		<div className="owl-claude-group-row" data-open={open || undefined} data-status={card.status}>
			<button
				type="button"
				className="owl-claude-group-row-head"
				aria-expanded={open}
				onClick={onToggle}
				title={label.detail ?? label.text}
			>
				<div className="owl-claude-subagent-row-body">
					<span className="owl-claude-group-row-label">{label.text}</span>
					{activity !== undefined && <span className="owl-claude-subagent-activity">{activity}</span>}
				</div>
				{word && (
					<span className="owl-claude-state-word" data-tone={word.tone}>
						{word.word}
					</span>
				)}
				<IconChevron className="owl-claude-group-row-chevron h-3 w-3 shrink-0 transition-transform" />
			</button>
			{open && hasOutput && <pre className="owl-claude-group-output">{output.text}</pre>}
		</div>
	);
}

/**
 * 子代理组。
 *
 * 折叠态只留组头；展开后是整组一个圆角盒，盒内每个子代理一行。
 */
export function ClaudeSubagentGroup({
	cards,
	scope,
	groupKey,
}: {
	cards: ToolCard[];
	scope: string;
	groupKey: string;
}): React.JSX.Element | null {
	const open = useSyncExternalStore(subscribeClaudeGroups, () => claudeGroupOpen(scope, groupKey));
	const [openRowId, setOpenRowId] = useState<string | undefined>(undefined);
	if (cards.length === 0) return null;
	const word = claudeStateWord(claudeCellStateOf(cards[0]!));
	return (
		<div
			className="owl-claude-group owl-claude-subagent-group"
			data-claude-subagent="on"
			data-open={open || undefined}
		>
			<button
				type="button"
				className="owl-claude-group-head"
				aria-expanded={open}
				onClick={() => claudeGroupToggle(scope, groupKey, !open)}
			>
				<span className="owl-claude-group-title">{claudeSubagentGroupLabel(cards.length)}</span>
				{word && (
					<span className="owl-claude-state-word" data-tone={word.tone}>
						{word.word}
					</span>
				)}
				<IconChevron className="owl-claude-group-chevron h-3 w-3 shrink-0 transition-transform" />
			</button>
			{open && (
				<div className="owl-claude-group-box">
					{cards.map((card) => (
						<SubagentRow
							key={card.id}
							card={card}
							open={openRowId === card.id}
							onToggle={() => setOpenRowId((current) => (current === card.id ? undefined : card.id))}
						/>
					))}
				</div>
			)}
		</div>
	);
}
