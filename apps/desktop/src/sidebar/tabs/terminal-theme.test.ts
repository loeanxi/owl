import assert from "node:assert/strict";
import { test } from "node:test";
import { readWorkbenchPalette } from "../theme-observer.ts";
import { terminalTheme } from "./terminal-theme.ts";

test("terminal foreground, cursor and selection use the actual scoped custom palette", () => {
	const values: Record<string, string> = { "--workbench-canvas": "#101820", "--workbench-text": "#ddeeff", "--color-owl-accent": "#ffaa22" };
	const palette = readWorkbenchPalette({ getPropertyValue: (name) => values[name] ?? "" }, "dark");
	const resolved: string[] = [];
	const theme = terminalTheme(palette, (color) => { resolved.push(color); return `resolved:${color}`; });
	assert.equal(theme.background, "resolved:#101820");
	assert.equal(theme.foreground, "resolved:#ddeeff");
	assert.equal(theme.cursor, "resolved:#ffaa22");
	assert.equal(theme.cursorAccent, theme.background);
	assert.equal(theme.selectionForeground, theme.foreground);
	assert.deepEqual(resolved, ["#101820", "#ddeeff", "#ffaa22", "color-mix(in srgb, #ffaa22 28%, #101820)"]);
});

test("switching to light mode replaces the ANSI palette instead of retaining bright dark-mode colors", () => {
	const empty = { getPropertyValue: () => "" };
	const light = terminalTheme(readWorkbenchPalette(empty, "light"), (color) => color);
	const dark = terminalTheme(readWorkbenchPalette(empty, "dark"), (color) => color);
	assert.equal(light.background, "#fafbf9");
	assert.equal(light.foreground, "#3d3a32");
	assert.notEqual(light.brightYellow, dark.brightYellow);
	assert.notEqual(light.brightGreen, dark.brightGreen);
	assert.notEqual(light.white, dark.white);
});
