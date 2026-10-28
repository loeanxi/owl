/**
 * Claude 的状态词系统。
 *
 * 规格来源：Claude Desktop 打包渲染层 `shared-frame-BfjMqbuN.js` 的
 * `Vj()` / `Bj()`（owl 侧叫 `Se()`）：
 *
 *   case "failed":  return { word: t.failed,   tone: "text-danger" };
 *   case "stopped": return { word: t.stopped,  tone: "text-secondary" };
 *   case "denied":  return { word: t.denied,   tone: "text-secondary" };
 *   case "blocked": return { word: t.blocked,  tone: "text-warning" };
 *   case "busy": case "done": return null;
 *
 * 默认词表（`Lj`）：failed → "Failed"，stopped → "Stopped"，
 * denied → "Denied"，blocked → "Needs approval"。
 * **done 与 running 没有状态词** —— 完成与进行靠别的机制表达
 * （进行是组头的 shimmer live 标签，完成什么都不加）。
 *
 * 行的落位：状态词在标签与对象之后、箭头之前，行尾一个词
 * （`kt` outcome span），不另占图标位。
 */

import type { ToolCard } from "../hooks/transcript.ts";
import { claudeToolLabelFor } from "./claude-tool-labels.ts";

/** 一个 cell 的状态（Claude 的五态；done 是常态）。 */
export type ClaudeCellState = "done" | "running" | "failed" | "stopped" | "denied" | "blocked";

/** 状态词：词 + 色调。 */
export type ClaudeStateWord = { word: string; tone: "danger" | "secondary" | "warning" };

/** Claude 的默认词表（`Lj`，逐字）。 */
export const CLAUDE_STATE_WORDS: Readonly<Record<"failed" | "stopped" | "denied" | "blocked", ClaudeStateWord>> =
	Object.freeze({
		failed: { word: "Failed", tone: "danger" },
		stopped: { word: "Stopped", tone: "secondary" },
		denied: { word: "Denied", tone: "secondary" },
		blocked: { word: "Needs approval", tone: "warning" },
	});

/**
 * 状态 → 状态词；done 与 running 返回 undefined（`Vj()` 的 null 分支）。
 */
export function claudeStateWord(state: ClaudeCellState): ClaudeStateWord | undefined {
	if (state === "done" || state === "running") return undefined;
	return CLAUDE_STATE_WORDS[state];
}

/**
 * 一次工具调用的 cell 状态（对齐 Claude 的 `te()`）：
 * running/pending → running；cancelled → stopped（用户停的，不是失败）；
 * error → failed；其余 done。
 */
export function claudeCellStateOf(card: Pick<ToolCard, "status">): ClaudeCellState {
	if (card.status === "running" || card.status === "pending") return "running";
	if (card.status === "cancelled") return "stopped";
	if (card.status === "error") return "failed";
	return "done";
}

/**
 * 一组工具的组状态（组头用的那态）：
 * 有在跑的 → running；否则有失败的 → failed；否则有被停的 → stopped；否则 done。
 */
export function claudeGroupState(cards: readonly Pick<ToolCard, "status">[]): ClaudeCellState {
	const states = cards.map((card) => claudeCellStateOf(card));
	if (states.includes("running")) return "running";
	if (states.includes("failed")) return "failed";
	if (states.includes("stopped")) return "stopped";
	return "done";
}

/**
 * 跑动中组头的 live 标签。
 *
 * Claude 跑动时的组头不是批次总结，而是**最后一个在跑的工具**的进行时标签
 * （`RJ` 的 `ye = N.findLast(e => e.state === "running")` → `liveLabel ?? label`），
 * 带 shimmer。全部收口后返回 undefined，组头才落回总结文案。
 */
export function claudeLiveLabel(cards: readonly ToolCard[]): string | undefined {
	for (let index = cards.length - 1; index >= 0; index -= 1) {
		const card = cards[index]!;
		if (card.status === "running" || card.status === "pending") return claudeToolLabelFor(card).text;
	}
	return undefined;
}
