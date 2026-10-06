import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_OWL_APPEARANCE, normalizeHexColor, parseOwlAppearance } from "./owl-appearance.ts";

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
	assert.equal(parseOwlAppearance({ preset: "" }).preset, "");
	for (const bad of ["green", "OWL-GREEN", "CODEX", 42, {}, null]) {
		assert.equal(parseOwlAppearance({ preset: bad }).preset, "");
	}
});
