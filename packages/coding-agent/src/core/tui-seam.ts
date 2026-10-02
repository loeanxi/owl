/**
 * pire seam: minimal stand-ins for symbols that outlived the packages they came
 * from (@earendil-works/pi-tui, the TUI theme module, core/keybindings).
 *
 * TODO(pire): excise this file together with core/extensions in Phase 1b/2 —
 * the extension runner still types against the retired TUI surface.
 */

// ---- types -----------------------------------------------------------------

export type KeyId = string;
export type Component = unknown;
export type TUI = unknown;
export type EditorComponent = unknown;
export type EditorTheme = unknown;
export type OverlayHandle = unknown;
export type OverlayOptions = Record<string, unknown>;
export type RgbColor = [number, number, number];
export type TerminalColors = unknown;
export type TerminalColorMode = "truecolor" | "256" | "16";
export type ScrollViewScrollbar = unknown;
export type TerminalCapabilities = Record<string, unknown>;
export type WheelScrollLines = number;
export type TuiMode = string;
export type Theme = Record<string, unknown>;

export interface KeybindingsManager {
	getResolvedBindings?: () => unknown;
	setUserBindings?: (bindings: unknown) => void;
	[member: string]: unknown;
}
export type KeybindingsConfig = Record<string, string>;
export type AppKeybinding = string;

// ---- values ----------------------------------------------------------------

export const theme: Theme = {};

export function detectCapabilities(): TerminalCapabilities {
	return {};
}

export function getTerminalColorMode(): TerminalColorMode {
	return "truecolor";
}

export function setCapabilityOverrides(_overrides: unknown): void {}

/** Headless clipboard: the desktop UI owns clipboard access. */
export function getNativeClipboard(): string | null {
	return null;
}

/** Startup prompts are headless until the desktop settings page lands. */
export async function showStartupInput(_options: unknown): Promise<string | undefined> {
	return undefined;
}
export async function showStartupSelector<T>(_options: unknown): Promise<T | undefined> {
	return undefined;
}

export function migrateKeybindingsConfig(parsed: Record<string, unknown>): {
	config: Record<string, unknown>;
	migrated: boolean;
} {
	return { config: parsed, migrated: false };
}

/** Subsequence match, case-insensitive — enough for `--list-models <query>`. */
export function fuzzyFilter<T>(items: T[], query: string, getKey?: (item: T) => string): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...items];
	const key = getKey ?? ((item: T) => String(item));
	return items.filter((item) => {
		const text = key(item).toLowerCase();
		let i = 0;
		for (const ch of text) {
			if (ch === q[i]) i++;
		}
		return i === q.length;
	});
}
