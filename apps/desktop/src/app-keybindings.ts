/** Desktop actions share one configurable registry. Values are saved per device. */
export const DEFAULT_APP_KEYBINDINGS = {
	newChat: ["ctrl+n"],
	openProject: ["ctrl+shift+o"],
	cycleExecutionView: ["ctrl+o"],
	closeWindow: ["ctrl+w"],
	quit: ["ctrl+q"],
	openSettings: ["ctrl+,"],
	showShortcuts: ["ctrl+/"],
	find: ["ctrl+f"],
	toggleSidebar: ["ctrl+shift+s"],
	toggleRightPanel: ["ctrl+shift+e"],
	debugUpdate: ["ctrl+shift+r"],
	prevSession: ["ctrl+shift+["],
	nextSession: ["ctrl+shift+]"],
	toggleChatContext: ["ctrl+alt+b"],
	toggleBottomPanel: ["ctrl+j"],
	openTerminal: ["ctrl+`", "ctrl+shift+`"],
	openBrowserTab: ["ctrl+t"],
	historyBack: ["ctrl+["],
	historyForward: ["ctrl+]"],
	zoomOut: ["ctrl+-", "ctrl+shift+-"],
	zoomIn: ["ctrl+=", "ctrl+shift+="],
	zoomReset: ["ctrl+0"],
	openIsland: ["ctrl+."],
	toggleFullscreen: ["f11"],
} as const;

export type AppKeybindingAction = keyof typeof DEFAULT_APP_KEYBINDINGS;
export type AppKeybindings = Record<AppKeybindingAction, readonly string[]>;
export const APP_KEYBINDINGS_KEY = "owl.app.keybindings";

const MODIFIERS = ["ctrl", "meta", "alt", "shift"] as const;
const CODE_KEYS: Record<string, string> = { Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Slash: "/", Comma: ",", Period: "." };
const SHIFT_KEYS: Record<string, string> = { "~": "`", "_": "-", "+": "=", "{": "[", "}": "]", "?": "/", "<": ",", ">": "." };

export function normalizeAppKeybinding(value: string): string | undefined {
	const parts = value.trim().toLowerCase().split("+");
	const key = parts.pop();
	if (!key || !/^(?:[a-z0-9`\-=\[\]/,.]|f(?:[1-9]|1[0-2]))$/.test(key) || parts.some((part) => !MODIFIERS.includes(part as typeof MODIFIERS[number])) || new Set(parts).size !== parts.length) return undefined;
	// Plain text must keep reaching the composer and embedded editors.
	if (!parts.includes("ctrl") && !parts.includes("meta") && !parts.includes("alt") && !/^f\d+$/.test(key)) return undefined;
	return [...MODIFIERS.filter((modifier) => parts.includes(modifier)), key].join("+");
}

export function appKeybindingFromEvent(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | undefined {
	const key = CODE_KEYS[event.code] ?? (/^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : /^Digit\d$/.test(event.code) ? event.code.slice(5) : SHIFT_KEYS[event.key] ?? event.key.toLowerCase());
	return normalizeAppKeybinding([...MODIFIERS.filter((modifier) => event[`${modifier}Key`]), key].join("+"));
}

export function loadAppKeybindings(storage: Pick<Storage, "getItem">): AppKeybindings {
	const bindings: AppKeybindings = { ...DEFAULT_APP_KEYBINDINGS };
	try {
		const overrides: unknown = JSON.parse(storage.getItem(APP_KEYBINDINGS_KEY) ?? "null");
		if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return bindings;
		for (const action of Object.keys(DEFAULT_APP_KEYBINDINGS) as AppKeybindingAction[]) {
			const values = (overrides as Record<string, unknown>)[action];
			if (!Array.isArray(values) || !values.every((value): value is string => typeof value === "string" && normalizeAppKeybinding(value) !== undefined)) continue;
			bindings[action] = values.map((value) => normalizeAppKeybinding(value)!);
		}
	} catch { /* Invalid or unavailable storage retains usable defaults. */ }
	return bindings;
}

export function matchingAppAction(event: KeyboardEvent, bindings: AppKeybindings): AppKeybindingAction | undefined {
	if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return undefined;
	const key = appKeybindingFromEvent(event);
	return key ? (Object.keys(bindings) as AppKeybindingAction[]).find((action) => bindings[action].includes(key)) : undefined;
}

export function formatAppKeybinding(binding: string | undefined): string {
	return binding?.split("+").map((part) => part.length === 1 ? part.toUpperCase() : part === "ctrl" ? "Ctrl" : part === "meta" ? "Meta" : part === "alt" ? "Alt" : part === "shift" ? "Shift" : part.toUpperCase()).join("+") ?? "";
}
