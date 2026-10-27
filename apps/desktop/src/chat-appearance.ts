/** Reading preferences apply to chat content, without changing the app or composer font. */
import { applyWorkEffects, DEFAULT_WORK_EFFECTS, parseWorkEffects, type WorkEffects } from "./components/work-process-effects.ts";

export interface ChatAppearance {
	fontSize: number;
	codeFontSize: number;
	lineHeight: number;
	width: number;
	toolRecords: "compact" | "expanded";
	motion: boolean;
	/**
	 * Claude 观感的回答流：工具组、公开说明与思考块平铺在正文之间，
	 * 不收进「工作过程」总折叠（Claude Desktop 就没有这一层）。
	 */
	claudeFlow: boolean;
	/**
	 * 思考的呈现方式。
	 *  - "claude"：对齐 Claude Desktop —— 只显示 provider 的推理摘要，
	 *    原始思考文字永不显示（没有摘要时这段思考就不出现）。
	 *  - "expandable"：owl 原本的做法 —— 折叠成一行，点开看思考原文。
	 */
	thinkingStyle: "claude" | "expandable";
	/** 工作过程动效逐条开关。 */
	workEffects: WorkEffects;
}

export const DEFAULT_CHAT_APPEARANCE: Readonly<ChatAppearance> = Object.freeze({
	fontSize: 16,
	codeFontSize: 13,
	lineHeight: 1.65,
	width: 880,
	toolRecords: "compact",
	motion: true,
	// Claude 式回答流是默认观感：工具调用平铺在正文之间，读起来像对话而不是日志。
	claudeFlow: true,
	// 思考默认按 Claude 的方式呈现（只显示摘要）。
	thinkingStyle: "claude",
	workEffects: DEFAULT_WORK_EFFECTS,
});

function boundedNumber(value: unknown, fallback: number, min: number, max: number, step: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const clamped = Math.max(min, Math.min(max, value));
	return Number((Math.round(clamped / step) * step).toFixed(2));
}

/** Older or malformed settings fall back per field; finite numeric values stay within the UI range. */
export function parseChatAppearance(raw: unknown): ChatAppearance {
	const value = typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? raw as Record<string, unknown>
		: {};
	return {
		fontSize: boundedNumber(value.fontSize, DEFAULT_CHAT_APPEARANCE.fontSize, 14, 22, 1),
		codeFontSize: boundedNumber(value.codeFontSize, DEFAULT_CHAT_APPEARANCE.codeFontSize, 11, 18, 1),
		lineHeight: boundedNumber(value.lineHeight, DEFAULT_CHAT_APPEARANCE.lineHeight, 1.5, 2, 0.05),
		width: boundedNumber(value.width, DEFAULT_CHAT_APPEARANCE.width, 640, 960, 1),
		toolRecords: value.toolRecords === "expanded" ? "expanded" : "compact",
		motion: typeof value.motion === "boolean" ? value.motion : DEFAULT_CHAT_APPEARANCE.motion,
		claudeFlow: typeof value.claudeFlow === "boolean" ? value.claudeFlow : DEFAULT_CHAT_APPEARANCE.claudeFlow,
		thinkingStyle: value.thinkingStyle === "expandable" ? "expandable" : "claude",
		workEffects: parseWorkEffects(value.workEffects),
	};
}

/** Set chat-only CSS variables and presentation flags after preferences have been loaded or saved. */
export function applyChatAppearance(value: ChatAppearance): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.style.setProperty("--owl-chat-font-size", `${value.fontSize}px`);
	root.style.setProperty("--owl-chat-code-font-size", `${value.codeFontSize}px`);
	root.style.setProperty("--owl-chat-line-height", String(value.lineHeight));
	root.style.setProperty("--owl-chat-width", `${value.width}px`);
	root.dataset.owlToolRecords = value.toolRecords;
	root.dataset.owlChatMotion = value.motion ? "on" : "off";
	// Claude 观感的回答流：工具组平铺在正文之间。
	root.dataset.owlClaudeFlow = value.claudeFlow ? "on" : "off";
	// 思考呈现：claude = 只显示摘要（Claude 的做法）；expandable = 可展开看原文。
	root.dataset.owlThinkingStyle = value.thinkingStyle;
	// 工作过程动效逐条开关：落 dataset，组件订阅同一份值。
	applyWorkEffects(value.workEffects);
	window.dispatchEvent(new Event("owl-chat-appearance-change"));
}
