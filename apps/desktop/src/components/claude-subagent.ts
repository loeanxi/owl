/**
 * Claude 的子代理组。
 *
 * 规格来源：Claude Desktop 打包渲染层
 * （`ion-dist/assets/v1/cc1aae219-DjR8LnUv.js` 与 `c05b96c7f-DklIyA-P.js`）：
 *
 *   function bB(e, t) {                     // 这条消息是不是子代理组
 *     return !!(t.metadata?.render_hint === "subagent"
 *             || e.find(e => e.type === "tool_use" && e.name === "Task"));
 *   }
 *   function xB(e, t) {                     // 把子代理自己的内联块从父流里剔掉
 *     return bB(e, t)
 *       ? e.filter(e => !("_isSubagentBlock" in e && e._isSubagentBlock)
 *                   && (e.type === "text" || e.type === "thinking" || e.type === "tool_use" || e.type !== "tool_result"))
 *       : e;
 *   }
 *
 * 组头的复数形式是 Claude 的 ICU 复数（分组器 `ie()` 里的子代理组单元）：
 *
 *   label = "Ran {count, plural, one {# agent} other {# agents}}"
 *
 * owl 的子代理工具叫 `subagent`（旧的 Claude Code 叫 `Task`），两者都算。
 */

/** owl 与 Claude 里代表「派出一个子代理」的工具名。 */
const SUBAGENT_TOOL_NAMES = new Set(["subagent", "Task", "task"]);

/** 这个工具是不是一次子代理调用。 */
export function isSubagentTool(name: string): boolean {
	return SUBAGENT_TOOL_NAMES.has(name);
}

/**
 * 子代理组的组头。
 *
 * Claude 的复数规则：`one` → `1 agent`，`other` → `N agents`。
 * 英文没有别的复数形式，中文界面也沿用同一句英文（Claude Desktop 本身如此）。
 */
export function claudeSubagentGroupLabel(count: number): string {
	if (count <= 0) return "";
	return count === 1 ? "Ran 1 agent" : `Ran ${count} agents`;
}

/** 一批工具里哪些是子代理、哪些是普通工具。 */
export function splitSubagentCards<T extends { name: string }>(cards: readonly T[]): { subagents: T[]; rest: T[] } {
	const subagents: T[] = [];
	const rest: T[] = [];
	for (const card of cards) {
		if (isSubagentTool(card.name)) subagents.push(card);
		else rest.push(card);
	}
	return { subagents, rest };
}
