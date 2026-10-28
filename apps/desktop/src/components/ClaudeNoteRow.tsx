/**
 * Claude 的「说明行」（中间叙述折叠）。
 *
 * 规格见 `claude-narration.ts`：label = 首行正文（截断到 200 字符）。
 * 形态对齐 Claude 的 Step 行：一行次级色文字，点开展开完整内容。
 *
 * 与 Claude 的一处有意偏离（2026-10-28）：
 * Claude 在 `cellSuppressed` 里把单行说明整行不渲染。抄过来之后，模型的中间叙述
 * 绝大多数就是一句话（"我先看一下工作区，然后启用子代理能力。"），于是整轮只剩
 * 工具组头和思考行，用户看到的是「一大片内容凭空消失」。这里改为：单行说明照样
 * 显示那一行，只是不提供展开（本来也没有可展开的内容）。
 */

import { useState } from "react";
import { claudeNoteIsSingleLine, claudeNoteLabel } from "./claude-narration.ts";

export function ClaudeNoteRow({
	text,
	children,
}: {
	text: string;
	children: React.ReactNode;
}): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	const label = claudeNoteLabel(text);
	// 空说明（纯空白）仍然不占行：没有任何可读内容。
	if (label === "") return null;
	// 单行说明：直接显示这一行，不做折叠（没有第二行可展开）。
	if (claudeNoteIsSingleLine(text)) {
		return (
			<div className="owl-claude-note" data-single-line="true">
				<p className="owl-claude-note-label" title={text.trim()}>
					{label}
				</p>
			</div>
		);
	}
	return (
		<div className="owl-claude-note" data-open={open || undefined}>
			<button type="button" className="owl-claude-note-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="owl-claude-note-label">{label}</span>
			</button>
			{open && <div className="owl-claude-note-body">{children}</div>}
		</div>
	);
}
