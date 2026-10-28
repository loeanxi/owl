/**
 * Claude 的思考行（折叠）。
 *
 * 形态（对齐 Claude Desktop 的 thinking cell + c73 的 Step 行）：
 *
 *   Thought for 12s ⌄          ← 折叠行：label（13px muted）+ 箭头
 *   （点开后才出现面板）
 *   12s                        ← 面板头：时长（caption、极弱）
 *   确认 billing 领域的实体边界  ← 摘要列表（body、次级色）
 *
 * 规则（逆向自 c05 的 thinking 分支 + cc1 渲染）：
 *  - 折叠行 label：摘要优先（provider 的推理摘要），无摘要用原文首行；
 *    纯思考条目的 label 是时长（`Th()` 的 "Thought for 12s" 家族），
 *    跑动中是 "Thinking"（bundle 的 AHQWDTo4+e）。
 *  - 面板内容：有摘要渲染摘要；无摘要渲染原文（trimFirstRawLine：标题是
 *    首行时面板从第二行开始）。
 *  - 与工具行同构：一行安静的文字 + 箭头，悬停转主文。
 */

import { useState } from "react";
import { IconChevron } from "./icons.tsx";

type ClaudeThinkingRowProps = {
	/** 折叠行标题。 */
	label: string;
	/** 已格式化的时长（"Thought for 12s"），显示在面板头。 */
	duration?: string;
	/** provider 摘要；有它面板就渲染摘要，没有才落到原文。 */
	summaries?: readonly string[];
	/** 无摘要时的原文（trimFirstRawLine 后）。 */
	raw?: string;
	/** 默认展开（搜索命中等场景）。 */
	defaultOpen?: boolean;
};

export function ClaudeThinkingRow({
	label,
	duration,
	summaries,
	raw,
	defaultOpen = false,
}: ClaudeThinkingRowProps): React.JSX.Element {
	const [open, setOpen] = useState(defaultOpen);
	const body =
		summaries !== undefined && summaries.length > 0 ? (
			summaries.map((summary, index) => (
				<p key={index} className="owl-claude-thinking-summary">
					{summary}
				</p>
			))
		) : raw !== undefined ? (
			<p className="owl-claude-thinking-summary">{raw}</p>
		) : null;
	return (
		<div className="owl-claude-thinking" data-open={open || undefined}>
			<button type="button" className="owl-claude-thinking-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="owl-claude-thinking-label">{label}</span>
				<IconChevron className="owl-claude-thinking-chevron h-3 w-3 shrink-0 transition-transform" />
			</button>
			{open && body !== null && (
				<div className="owl-claude-thinking-panel">
					{duration !== undefined && <span className="owl-claude-thinking-duration">{duration}</span>}
					{body}
				</div>
			)}
		</div>
	);
}
