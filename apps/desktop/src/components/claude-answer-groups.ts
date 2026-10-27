/**
 * Claude 回答格式的分组语义。
 *
 * 规格来源：Claude Desktop 打包渲染层（ion-dist/assets/v1/c05b96c7f-DklIyA-P.js）
 * 的分组器 `ie(blockIndex, block)`。它把 assistant 的 content block 数组按顺序
 * 归成四类可渲染单元：
 *
 *  1. 子代理组  —— label = "Ran {count, plural, one {# agent} other {# agents}}"
 *  2. 思考区块  —— label = "Thinking" / "Thought about it"，附 duration（"Thought for 12s"）
 *  3. 说明行    —— label = 首行正文（截断到 200 字符）
 *  4. 工具行    —— 每条 tool_use 一行，标题是人类化的动作短语
 *
 * 本模块只做「顺序 → 分组」的纯计算，不碰 DOM。渲染交给 ChatStream / WorkProcessRow。
 */

import type { AssistantSegment, ToolCard } from "../hooks/transcript.ts";

/** Claude 的首行截断上限（bundle 里的 Zo=200）。 */
const LABEL_MAX_CHARS = 200;

export type GroupKind = "tools" | "thinking" | "note";

export type AnswerGroup = {
	kind: GroupKind;
	/** 组内单元的稳定键。 */
	key: string;
	/** 分组标签（工具组是 "Ran N commands"，思考组是 "Thought for 12s"）。 */
	label: string;
	/** 组内工具（仅 kind==="tools"）。 */
	tools: ToolCard[];
	/** 思考正文（仅 kind==="thinking"）。 */
	thinking: string;
	/** 说明正文（仅 kind==="note"）。 */
	text: string;
	/** 该组是否仍在运行。 */
	running: boolean;
};

/**
 * 纯思考消息：content 全是 thinking / redacted_thinking 且不含 tool_use。
 * Claude 对这种消息不渲染正文，只当作思考状态（bundle 里的 `g(e)` 判定）。
 * owl 的 segments 已经是拍平后的有序数组，等价条件是「没有正文也没有工具」。
 */
export function isThinkingOnly(segments: readonly AssistantSegment[]): boolean {
	return segments.length > 0 && segments.every((segment) => segment.kind === "thinking");
}

/** 去掉 markdown 装饰，取第一行有内容的正文，作为说明行标签。 */
export function firstContentLine(text: string): string | undefined {
	for (const raw of text.split("\n")) {
		const line = raw
			.trim()
			.replace(/^```[\w-]*\s*$/, "")
			.replace(/^#{1,6}\s+/, "")
			.replace(/^(?:[-*+]|\d{1,3}\.)\s+/, "")
			.replace(/^>\s*/, "")
			.replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1")
			.replace(/[`*]+/g, "")
			.trim();
		if (line !== "") return line;
	}
	return undefined;
}

/** 首行截断到 200 字符，末尾补省略号（对齐 Claude 的 cs()）。 */
export function truncateLabel(text: string, max = LABEL_MAX_CHARS): string {
	if (text.length <= max) return text;
	let cut = text.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	// 不切开代理对（surrogate pair）。
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return `${cut}\u2026`;
}

/**
 * 思考时长格式化：对齐 Claude 的 "Thought for {seconds}s" 家族。
 * 超过 1 小时按小时 + 分钟，其余按分钟 + 秒，秒为 0 时不显示。
 * 返回值是「单位 + 总秒数」对，文案由调用方按界面语言组装。
 */
export type ThinkingDuration = { seconds: number; unit: "s" | "m" | "h" };

export function formatThinkingDuration(ms: number): ThinkingDuration | undefined {
	const seconds = Math.round(ms / 1000);
	if (seconds <= 0) return undefined;
	if (seconds < 60) return { seconds, unit: "s" };
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return { seconds, unit: "m" };
	const hours = Math.floor(minutes / 60);
	return { seconds, unit: "h" };
}

/** 把时长对渲染成界面文案（Claude 的 "Thought for 12s" / "1m 30s" / "1h 30m"）。 */
export function thinkingDurationText(duration: ThinkingDuration, format: (value: number, unit: "s" | "m" | "h") => string): string {
	const seconds = duration.seconds;
	if (duration.unit === "s") return format(seconds, "s");
	if (duration.unit === "m") {
		const minutes = Math.floor(seconds / 60);
		const rest = seconds % 60;
		return rest > 0 ? format(minutes, "m") + " " + format(rest, "s") : format(minutes, "m");
	}
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return minutes > 0 ? format(hours, "h") + " " + format(minutes, "m") : format(hours, "h");
}

/** 工具分组标签：Claude 用 "Ran N commands"（one/other 复数）。 */
export function toolGroupLabel(count: number): string {
	return count === 1 ? "Ran 1 command" : `Ran ${count} commands`;
}

/**
 * 把一条 assistant 的 segments 按顺序归成渲染组。
 *
 * 分组规则（对齐 Claude 的 `ie()`）：
 *  - 连续的工具 segment 合并成一个 tools 组，标签是 "Ran N commands"。
 *  - thinking segment 各自成组，标签优先用首行摘要，缺失时回退 "Thought about it"。
 *  - text segment 成组，标签取首行正文（截断到 200 字符）。
 *
 * 工具与思考的先后顺序严格保留：Claude 的 cell 是按 block 顺序落的，
 * 这决定了「先说明 → 再工具 → 再说明」在界面上的真实次序。
 */
export function buildAnswerGroups(
	segments: readonly AssistantSegment[],
	tools: readonly ToolCard[],
	options: {
		/** 思考块的已格式化时长标签（如 "Thought for 12s"）。 */
		thinkingDuration?: (index: number) => string | undefined;
	} = {},): AnswerGroup[] {
	const groups: AnswerGroup[] = [];
	let pendingTools: ToolCard[] = [];
	let pendingKey = "";

	const flushTools = (): void => {
		if (pendingTools.length === 0) return;
		groups.push({
			kind: "tools",
			key: pendingKey,
			label: toolGroupLabel(pendingTools.length),
			tools: pendingTools,
			thinking: "",
			text: "",
			running: pendingTools.some((tool) => tool.status === "running" || tool.status === "pending"),
		});
		pendingTools = [];
		pendingKey = "";
	};

	segments.forEach((segment, index) => {
		if (segment.kind === "tool") {
			const card = tools.find((tool) => tool.id === segment.toolId);
			if (!card) return;
			if (pendingTools.length === 0) pendingKey = `tools-${index}`;
			pendingTools.push(card);
			return;
		}
		flushTools();
		if (segment.kind === "thinking") {
			const text = segment.text.trim();
			if (text === "") return;
			const summary = firstContentLine(text);
			const duration = options.thinkingDuration?.(index);
			const label = duration
				? duration
				: summary
					? truncateLabel(summary)
					: "Thinking";
			groups.push({
				kind: "thinking",
				key: `thinking-${index}`,
				label,
				tools: [],
				thinking: text,
				text: "",
				running: false,
			});
			return;
		}
		const text = segment.text.trim();
		if (text === "") return;
		const line = firstContentLine(text);
		if (line === undefined) return;
		groups.push({
			kind: "note",
			key: `note-${index}`,
			label: truncateLabel(line),
			tools: [],
			thinking: "",
			text,
			running: false,
		});
	});
	flushTools();
	return groups;
}
