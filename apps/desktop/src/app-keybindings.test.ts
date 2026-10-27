import { describe, expect, it } from "vitest";
import { APP_KEYBINDINGS_KEY, appKeybindingFromEvent, DEFAULT_APP_KEYBINDINGS, formatAppKeybinding, loadAppKeybindings, matchingAppAction, normalizeAppKeybinding } from "./app-keybindings.ts";

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return { key: "o", code: "KeyO", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...overrides } as KeyboardEvent;
}

describe("desktop keybinding registry", () => {
	it("keeps Ctrl+O free and open project on Ctrl+Shift+O", () => {
		expect(matchingAppAction(key(), DEFAULT_APP_KEYBINDINGS)).toBeUndefined();
		expect(matchingAppAction(key({ shiftKey: true }), DEFAULT_APP_KEYBINDINGS)).toBe("openProject");
		expect(matchingAppAction(key({ key: "+", code: "Equal", shiftKey: true }), DEFAULT_APP_KEYBINDINGS)).toBe("zoomIn");
		expect(matchingAppAction(key({ key: "{", code: "BracketLeft", shiftKey: true }), DEFAULT_APP_KEYBINDINGS)).toBe("prevSession");
	});
	it("loads only validated overrides and ignores removed or invalid actions", () => {
		const bindings = loadAppKeybindings({ getItem: (name) => name === APP_KEYBINDINGS_KEY ? JSON.stringify({ cycleExecutionView: ["ALT+CTRL+V"], newChat: ["a"], openProject: [] }) : null });
		expect("cycleExecutionView" in bindings).toBe(false);
		expect(bindings.newChat).toEqual(DEFAULT_APP_KEYBINDINGS.newChat);
		expect(bindings.openProject).toEqual([]);
		expect(matchingAppAction(key(), bindings)).toBeUndefined();
	});
	it("leaves text, composition, handled events, repeats and unrelated modifiers untouched", () => {
		expect(normalizeAppKeybinding("shift+o")).toBeUndefined();
		expect(normalizeAppKeybinding("ctrl+ctrl+o")).toBeUndefined();
		for (const override of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true }, { metaKey: true }, { altKey: true }]) expect(matchingAppAction(key(override), DEFAULT_APP_KEYBINDINGS)).toBeUndefined();
		expect(appKeybindingFromEvent(key({ ctrlKey: false }))).toBeUndefined();
		expect(formatAppKeybinding("ctrl+shift+o")).toBe("Ctrl+Shift+O");
	});
	it("falls back to defaults after invalid or unavailable storage", () => {
		expect(loadAppKeybindings({ getItem: () => "{" })).toEqual(DEFAULT_APP_KEYBINDINGS);
		expect(loadAppKeybindings({ getItem: () => { throw new Error("storage blocked"); } })).toEqual(DEFAULT_APP_KEYBINDINGS);
	});
});
