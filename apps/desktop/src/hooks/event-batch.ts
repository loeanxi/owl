/**
 * 按动画帧合并事件：把同一帧内多个 text_delta 合成一次 setState。
 * 嵌入 WebView 里 rAF 可能不触发，所以用 setTimeout 兜底。
 */

import type { ServerEventMessage } from "../bridge/protocol.ts";

/** 正文/思考增量：可按帧合并；其余事件应立即 flush 保序。 */
export function isStreamingDeltaEvent(message: ServerEventMessage): boolean {
	const event = message.event as { type?: string; assistantMessageEvent?: { type?: string } } | undefined;
	if (event?.type !== "message_update") return false;
	const kind = event.assistantMessageEvent?.type;
	return kind === "text_delta" || kind === "thinking_delta";
}

export type FrameBatcher<T> = {
	push(item: T): void;
	flush(): void;
	clear(): void;
};

export function createFrameBatcher<T>(flush: (items: T[]) => void, fallbackMs = 32): FrameBatcher<T> {
	let buffer: T[] = [];
	let raf = 0;
	let timer: ReturnType<typeof setTimeout> | 0 = 0;

	const drain = (): void => {
		if (buffer.length === 0) return;
		const items = buffer;
		buffer = [];
		flush(items);
	};

	const cancel = (): void => {
		if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
		if (timer) clearTimeout(timer);
		raf = 0;
		timer = 0;
	};

	const schedule = (): void => {
		if (raf || timer) return;
		if (typeof requestAnimationFrame === "function") {
			raf = requestAnimationFrame(() => {
				raf = 0;
				if (timer) {
					clearTimeout(timer);
					timer = 0;
				}
				drain();
			});
		}
		timer = setTimeout(() => {
			timer = 0;
			if (raf && typeof cancelAnimationFrame === "function") {
				cancelAnimationFrame(raf);
				raf = 0;
			}
			drain();
		}, fallbackMs);
	};

	return {
		push(item) {
			buffer.push(item);
			schedule();
		},
		flush() {
			cancel();
			drain();
		},
		clear() {
			cancel();
			buffer = [];
		},
	};
}
