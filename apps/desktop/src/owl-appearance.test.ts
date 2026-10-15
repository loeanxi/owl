import assert from "node:assert/strict";
import test from "node:test";
import { accentTextColor, applyOwlAppearance, DEFAULT_OWL_APPEARANCE, isGlassPreset, normalizeHexColor, parseOwlAppearance, presetThemeLock, resolveSurfaceTheme } from "./owl-appearance.ts";

test("normalizeHexColor accepts only #rgb and #rrggbb and normalizes to lowercase #rrggbb", () => {
	assert.equal(normalizeHexColor("#ABC"), "#aabbcc");
	assert.equal(normalizeHexColor(" #2F9E5A "), "#2f9e5a");
	assert.equal(normalizeHexColor("#2f9e5a"), "#2f9e5a");
	for (const bad of ["", "2f9e5a", "#259e", "#2f9e5a5a", "red", "#ABCDEF00", null, undefined, 42]) {
		assert.equal(normalizeHexColor(bad), "");
	}
});

test("missing and malformed saved colors fall back to an all-default set", () => {
	for (const raw of [undefined, null, false, "blue", [1], 7]) {
		assert.deepEqual(parseOwlAppearance(raw), { ...DEFAULT_OWL_APPEARANCE });
	}
});

test("invalid fields fall back independently without discarding valid colors", () => {
	assert.deepEqual(
		parseOwlAppearance({
			accent: "#8B5CF6",
			dark: { background: "#111", foreground: "nope" },
			light: { background: 42, foreground: "#faf9f5" },
			unrelated: "ignored",
		}),
		{
			preset: "",
			glass: "clear",
			accent: "#8b5cf6",
			dark: { background: "#111111", foreground: "" },
			light: { background: "", foreground: "#faf9f5" },
		},
	);
});

test("non-object nested values do not crash parsing", () => {
	assert.deepEqual(parseOwlAppearance({ dark: "#262624", light: "light" }), { ...DEFAULT_OWL_APPEARANCE });
});

test("known presets are kept and unknown ones fall back to the default preset", () => {
	assert.equal(parseOwlAppearance({ preset: "owl-green" }).preset, "owl-green");
	assert.equal(parseOwlAppearance({ preset: "codex" }).preset, "codex");
	assert.equal(parseOwlAppearance({ preset: "liquid-glass" }).preset, "liquid-glass");
	assert.equal(parseOwlAppearance({ preset: "frost" }).preset, "frost");
	for (const preset of ["ink", "polar-night", "ink-hc", "vscode-modern", "vscode-classic", "monokai", "monokai-dimmed", "solarized", "abyss", "tomorrow-night-blue", "kimbie-dark", "red", "high-contrast"]) {
		assert.equal(parseOwlAppearance({ preset }).preset, preset);
		assert.equal(presetThemeLock(parseOwlAppearance({ preset }).preset), null);
		assert.equal(isGlassPreset(parseOwlAppearance({ preset }).preset), false);
	}
	assert.equal(parseOwlAppearance({ preset: "" }).preset, "");
	assert.equal(parseOwlAppearance({ preset: "quiet-light" }).preset, "quiet-light");
	for (const bad of ["green", "OWL-GREEN", "CODEX", "liquid_glass", "Monokai", "solarized-dark", "cursor", "vscode", 42, {}, null]) {
		assert.equal(parseOwlAppearance({ preset: bad }).preset, "");
	}
});

test("glass mode keeps known values and falls back to clear", () => {
	for (const mode of ["clear", "blur", "acrylic"]) {
		assert.equal(parseOwlAppearance({ glass: mode }).glass, mode);
	}
	for (const bad of [undefined, "mica", "ACRYLIC", 1, null]) {
		assert.equal(parseOwlAppearance({ glass: bad }).glass, "clear");
	}
});

test("frost shares the glass family and locks the dark theme", () => {
	assert.equal(isGlassPreset("frost"), true);
	assert.equal(isGlassPreset("liquid-glass"), true);
	assert.equal(isGlassPreset("codex"), false);
	assert.equal(presetThemeLock("frost"), "dark");
	assert.equal(presetThemeLock("liquid-glass"), null);
	assert.equal(presetThemeLock(""), null);
});

test("quiet light only has a light palette, so it locks the light theme", () => {
	assert.equal(presetThemeLock("quiet-light"), "light");
	assert.equal(isGlassPreset("quiet-light"), false);
});

test("accent text stays readable on bright, dark and middle-tone custom colors and hover shades", () => {
	const luminance = (hex: string, shade = 1): number => {
		const channels = [1, 3, 5].map((offset) => {
			const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) * shade / 255;
			return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		});
		return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
	};
	for (const color of ["#50a992", "#268574", "#4d9aff", "#0066cc", "#007aff", "#0a84ff", "#a6e22e", "#2aa198", "#1a6fa8", "#4a8ee0", "#bbdaff", "#f79a32", "#ff6666", "#81a1c1", "#2778c1", "#88c0d0", "#0064b0", "#0078d4", "#005fb8", "#007acc", "#6a92c0", "#705697", "#f38518", "#006bbd", "#ffff00", "#111111", "#777777", "#bd3473"]) {
		for (const shade of [1, 0.84]) {
			const bg = luminance(color, shade);
			const fg = luminance(accentTextColor(color, shade));
			assert.ok((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) >= 4.5, `${color} at ${shade}`);
		}
	}
});

test("appearance changes update accent foregrounds and clear custom colors when switching back to defaults", (t) => {
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const values = new Map<string, string>();
	const events: string[] = [];
	const root = {
		dataset: { owlTheme: "dark" },
		style: { setProperty: (name: string, value: string) => values.set(name, value), removeProperty: (name: string) => values.delete(name), getPropertyValue: (name: string) => values.get(name) ?? "" },
	};
	Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
	Object.defineProperty(globalThis, "window", { configurable: true, value: {
		getComputedStyle: () => ({ getPropertyValue: (name: string) => values.get(name) ?? (name.endsWith("accent-hover") ? "#428e7a" : "#50a992") }),
		dispatchEvent: (event: Event) => { events.push(event.type); },
	} });
	t.after(() => {
		if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
		if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
	});
	applyOwlAppearance(parseOwlAppearance({ accent: "#ffff00", dark: { background: "#20202a", foreground: "#eee8f0" } }));
	assert.equal(values.get("--color-owl-on-accent"), "#111111");
	assert.equal(values.get("--color-owl-on-accent-hover"), "#111111");
	assert.equal(values.get("--owl-ui-canvas-override"), "#20202a");
	assert.equal(values.get("--owl-preview-dark-bg"), "#20202a");
	assert.equal(values.get("--owl-preview-dark-fg"), "#eee8f0");
	assert.equal(values.get("--owl-preview-light-bg"), "#faf9f5");
	applyOwlAppearance(parseOwlAppearance({ accent: "#111111" }));
	assert.equal(values.get("--color-owl-on-accent"), "#ffffff");
	assert.equal(values.has("--owl-ui-canvas-override"), false);
	applyOwlAppearance(parseOwlAppearance({}));
	assert.equal(values.has("--color-owl-accent"), false);
	assert.equal(values.get("--color-owl-on-accent"), "#111111");
	assert.equal(values.get("--owl-preview-dark-bg"), "#1e1e1e");
	assert.deepEqual(events, ["owl-appearance-change", "owl-appearance-change", "owl-appearance-change"]);
});

test("surface theme follows a loaded wallpaper palette and falls back when wallpaper is disabled", () => {
	assert.equal(resolveSurfaceTheme({ owlTheme: "dark", owlWallpaper: "on", owlGlassTheme: "light" }), "light");
	assert.equal(resolveSurfaceTheme({ owlTheme: "light", owlWallpaper: "on", owlGlassTheme: "dark" }), "dark");
	assert.equal(resolveSurfaceTheme({ owlTheme: "light", owlWallpaper: "off", owlGlassTheme: "dark" }), "light");
	assert.equal(resolveSurfaceTheme({ owlTheme: "dark", owlWallpaper: "on" }), "dark");
	assert.equal(resolveSurfaceTheme({ owlTheme: "light", owlGlassTheme: "invalid" }), "light");
});
