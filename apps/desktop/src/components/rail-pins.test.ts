import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRailPins, toggleRailPin } from "./rail-pins.ts";

test("normalizing drops unknown views, duplicates, and non-strings while keeping pin order", () => {
	assert.deepEqual(normalizeRailPins(["map", "bogus", "map", 42, null, "mail"]), ["map", "mail"]);
	assert.deepEqual(normalizeRailPins("map"), []);
	assert.deepEqual(normalizeRailPins(null), []);
});

test("toggling pins and unpins without mutating the source list", () => {
	const pins = toggleRailPin(["projects"], "map");
	assert.deepEqual(pins, ["projects", "map"]);
	assert.deepEqual(toggleRailPin(pins, "projects"), ["map"]);
	assert.deepEqual(pins, ["projects", "map"]);
});
