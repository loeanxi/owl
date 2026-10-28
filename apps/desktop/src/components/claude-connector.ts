/**
 * Claude 的「连接器文本」（`connector_text`）。
 *
 * 规格来源：Claude Desktop 打包渲染层 `c05b96c7f-DklIyA-P.js`：
 *
 *   var Oo = { text: "indexed", connector_text: "omitted", thinking: "omitted",
 *              redacted_thinking: "omitted", tool_use: "omitted",
 *              tool_result: "omitted", token_budget: "omitted",
 *              process_group_marker: "omitted", flag: "omitted",
 *              voice_note: "omitted", bell: "omitted" };
 *
 * 也就是说：`connector_text` 是 Claude 的一等内容块类型 —— 连接器（MCP 服务器）
 * 回来的**散文**，它和模型自己的 `text` 平级，但语义不同：
 *  - 它不是模型的「叙述」，所以不参与 Claude 的叙述折叠（折叠策略里它是 transparent）；
 *  - 它也不进搜索索引（omitted）。
 *
 * 在界面上它的表现是：**连接器工具的正文直接以散文形态出现在回答流里**，
 * 而不是被塞进工具盒里当原始输出。
 *
 * owl 没有 `connector_text` 这个块类型，但有等价物：MCP 工具（`mcp__<server>__<tool>`）
 * 的文本输出。这里把它识别出来，在 Claude 模式下按连接器文本渲染。
 */

/** MCP 工具的命名：Claude 与 owl 都是 `mcp__<server>__<tool>`。 */
const MCP_TOOL_PREFIX = "mcp__";

/**
 * 这个工具是不是连接器（MCP）工具。
 */
export function isConnectorTool(name: string): boolean {
	return name.startsWith(MCP_TOOL_PREFIX);
}

/** `mcp__<server>__<tool>` 里的 server 名。 */
export function connectorServerOf(name: string): string | undefined {
	if (!isConnectorTool(name)) return undefined;
	const rest = name.slice(MCP_TOOL_PREFIX.length);
	const sep = rest.indexOf("__");
	return sep > 0 ? rest.slice(0, sep) : undefined;
}

/**
 * 连接器工具的正文。
 *
 * Claude 的连接器文本是**散文**（一段话），不是 JSON、不是路径列表。
 * 这里只取看起来像散文的部分：去掉围栏代码块和明显的 JSON 之后仍有内容，
 * 才当连接器文本渲染；否则留在工具盒里当原始输出。
 */
export function connectorTextOf(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	// 纯 JSON / 纯路径列表不是散文。
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return undefined;
	if (trimmed.startsWith("```")) return undefined;
	return trimmed;
}

/** 一段连接器文本（连同来源）。 */
export type ClaudeConnectorBlock = {
	/** 稳定键。 */
	key: string;
	/** 来源（连接器/服务器名）。 */
	source: string;
	/** 正文。 */
	text: string;
};

/**
 * 从一轮工具里收出连接器文本。
 *
 * 只有「连接器工具 + 散文输出」才算连接器文本；其余（普通工具、JSON 输出、
 * 代码块）都留在工具盒里当原始输出。
 */
export function claudeConnectorBlocks(
	cards: readonly { id: string; name: string; output?: { text: string } }[],
): ClaudeConnectorBlock[] {
	const out: ClaudeConnectorBlock[] = [];
	for (const card of cards) {
		if (!isConnectorTool(card.name)) continue;
		const text = connectorTextOf(card.output?.text);
		if (text === undefined) continue;
		out.push({ key: card.id, source: connectorServerOf(card.name) ?? "", text });
	}
	return out;
}
