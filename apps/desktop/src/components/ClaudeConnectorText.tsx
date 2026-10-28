/**
 * Claude 的「连接器文本」单元。
 *
 * 规格来源：Claude Desktop 打包渲染层 `c05b96c7f-DklIyA-P.js` 的
 * `Oo`（`connector_text: "omitted"`）与折叠策略里对它的处理：
 * 连接器文本是**一等散文块**，但语义上不是模型的叙述 —— 它不进叙述折叠，
 * 也不进搜索索引。
 *
 * 界面上它就是一段普通的散文，直接落在回答流里（不是工具盒里的一坨原始输出）。
 * owl 的等价物是 MCP 工具的文本输出。
 */

import { connectorTextOf } from "./claude-connector.ts";

/**
 * 连接器文本块。
 *
 * 形态：脚注字号、次级色的一段散文（Claude 的 `text-footnote text-secondary`），
 * 左边留一条竖线标记它是连接器来的。
 */
export function ClaudeConnectorText({ text, source }: { text: string; source?: string }): React.JSX.Element | null {
	const body = connectorTextOf(text);
	if (body === undefined) return null;
	return (
		<div className="owl-claude-connector" data-claude-connector="on">
			{source !== undefined && source !== "" && <span className="owl-claude-connector-source">{source}</span>}
			<p className="owl-claude-connector-text">{body}</p>
		</div>
	);
}
