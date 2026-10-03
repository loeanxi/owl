import assert from "node:assert/strict";
import test from "node:test";
import { applyChatAppearance, DEFAULT_CHAT_APPEARANCE, parseChatAppearance } from "./chat-appearance.ts";

test("missing and malformed saved preferences use independent defaults", () => {
	for (const raw of [undefined, null, false, "large", [22]]) {
		assert.deepEqual(parseChatAppearance(raw), DEFAULT_CHAT_APPEARANCE);
	}
	const parsed = parseChatAppearance({});
	parsed.fontSize = 22;
	assert.equal(DEFAULT_CHAT_APPEARANCE.fontSize, 14);
	assert.equal(parseChatAppearance({}).fontSize, 14);
});

test("invalid fields fall back independently without discarding valid display preferences", () => {
	assert.deepEqual(parseChatAppearance({
		fontSize: "22",
		codeFontSize: Number.NaN,
		lineHeight: Number.POSITIVE_INFINITY,
		width: null,
		toolRecords: "expanded",
		motion: false,
		unrelated: "ignored",
	}), { ...DEFAULT_CHAT_APPEARANCE, toolRecords: "expanded", motion: false });
	assert.deepEqual(parseChatAppearance({ toolRecords: "unknown", motion: "false" }), DEFAULT_CHAT_APPEARANCE);
});

test("finite saved numbers clamp at both ends of every supported reading range", () => {
	assert.deepEqual(parseChatAppearance({ fontSize: -100, codeFontSize: 0, lineHeight: 0, width: 1 }), {
		...DEFAULT_CHAT_APPEARANCE, fontSize: 14, codeFontSize: 11, lineHeight: 1.5, width: 640,
	});
	assert.deepEqual(parseChatAppearance({ fontSize: 100, codeFontSize: 100, lineHeight: 9, width: 10000 }), {
		...DEFAULT_CHAT_APPEARANCE, fontSize: 22, codeFontSize: 18, lineHeight: 2, width: 960,
	});
});

test("saved fractional values normalize to stable slider values", () => {
	assert.deepEqual(parseChatAppearance({ fontSize: 17.6, codeFontSize: 12.4, lineHeight: 1.72, width: 767.8 }), {
		...DEFAULT_CHAT_APPEARANCE, fontSize: 18, codeFontSize: 12, lineHeight: 1.7, width: 768,
	});
});

test("applying preferences changes only chat variables and publishes the completed presentation state", (context) => {
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	context.after(() => {
		if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
		if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
	});
	const properties = new Map([
		["--font-sans", "original interface font"],
		["--composer-font-size", "14px"],
		["--composer-width", "768px"],
	]);
	const dataset: Record<string, string> = { owlTheme: "dark" };
	const target = new EventTarget();
	const notifications: string[] = [];
	target.addEventListener("owl-chat-appearance-change", (event) => {
		notifications.push(`${event.type}:${dataset.owlToolRecords}:${dataset.owlChatMotion}:${properties.get("--owl-chat-font-size")}`);
	});
	Object.defineProperty(globalThis, "document", { configurable: true, value: {
		documentElement: { dataset, style: { setProperty: (name: string, value: string) => properties.set(name, value) } },
	} });
	Object.defineProperty(globalThis, "window", { configurable: true, value: target });

	applyChatAppearance(parseChatAppearance({ fontSize: 20, codeFontSize: 16, lineHeight: 1.9, width: 920, toolRecords: "expanded", motion: false }));
	assert.deepEqual(Object.fromEntries(properties), {
		"--font-sans": "original interface font",
		"--composer-font-size": "14px",
		"--composer-width": "768px",
		"--owl-chat-font-size": "20px",
		"--owl-chat-code-font-size": "16px",
		"--owl-chat-line-height": "1.9",
		"--owl-chat-width": "920px",
	});
	assert.deepEqual(dataset, { owlTheme: "dark", owlToolRecords: "expanded", owlChatMotion: "off" });
	assert.deepEqual(notifications, ["owl-chat-appearance-change:expanded:off:20px"]);

	applyChatAppearance(parseChatAppearance(undefined));
	assert.equal(dataset.owlToolRecords, "compact");
	assert.equal(dataset.owlChatMotion, "on");
	assert.deepEqual(notifications, [
		"owl-chat-appearance-change:expanded:off:20px",
		"owl-chat-appearance-change:compact:on:14px",
	]);
});

test("preferences can be loaded outside the desktop browser without accessing the DOM", () => {
	assert.doesNotThrow(() => applyChatAppearance(parseChatAppearance(undefined)));
});
