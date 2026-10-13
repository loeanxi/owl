import type { ITheme } from "@xterm/xterm";
import type { WorkbenchPalette } from "../theme-observer.ts";

/** ANSI hues stay meaningful; light mode needs darker values than xterm's defaults. */
export function terminalTheme(palette: WorkbenchPalette, resolveColor: (color: string) => string): ITheme {
	const background = resolveColor(palette.canvas);
	const foreground = resolveColor(palette.text);
	const accent = resolveColor(palette.accent);
	return {
		background,
		foreground,
		cursor: accent,
		cursorAccent: background,
		selectionBackground: resolveColor(`color-mix(in srgb, ${palette.accent} 28%, ${palette.canvas})`),
		selectionForeground: foreground,
		...(palette.theme === "light" ? {
			black: "#242a25", red: "#a72935", green: "#286839", yellow: "#845a13", blue: "#285c92", magenta: "#7b4094", cyan: "#22686c", white: "#657066",
			brightBlack: "#58625a", brightRed: "#b82d3d", brightGreen: "#286839", brightYellow: "#845a13", brightBlue: "#285c92", brightMagenta: "#7b4094", brightCyan: "#22686c", brightWhite: "#3d473f",
		} : {
			black: "#242a25", red: "#ef8794", green: "#91c899", yellow: "#d9bb75", blue: "#8bb5e0", magenta: "#c1a0d4", cyan: "#85c4c8", white: "#d8e0d9",
			brightBlack: "#969f97", brightRed: "#ffa3ac", brightGreen: "#b1e0b5", brightYellow: "#eed099", brightBlue: "#a9cbef", brightMagenta: "#dfbbed", brightCyan: "#a1e0de", brightWhite: "#f3f6f3",
		}),
	};
}
