/** Reading preferences apply to chat content, without changing the app or composer font. */
export interface ChatAppearance {
	fontSize: number;
	codeFontSize: number;
	lineHeight: number;
	width: number;
	toolRecords: "compact" | "expanded";
	motion: boolean;
}

export const DEFAULT_CHAT_APPEARANCE: Readonly<ChatAppearance> = Object.freeze({
	fontSize: 16,
	codeFontSize: 13,
	lineHeight: 1.7,
	width: 768,
	toolRecords: "compact",
	motion: true,
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
}
