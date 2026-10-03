import assert from "node:assert/strict";
import { test } from "node:test";
import { mapWorldLayout } from "./geometry.ts";

function close(actual: number, expected: number): void {
	assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} should equal ${expected}`);
}

test("normal and narrow detail viewports retain the map ratio and keep selected places visible", () => {
	for (const [width, height] of [[900, 820], [1200, 720], [528, 714], [320, 714]]) {
		for (const focus of [{ x: 61, y: 42 }, { x: 78, y: 26 }, { x: 30, y: 73 }]) {
			const layout = mapWorldLayout(width, height, 1, focus);
			close(layout.width / layout.height, 900 / 820);
			assert.ok(layout.width >= width - 1e-7);
			assert.ok(layout.height >= height - 1e-7);
			const x = layout.left + focus.x / 100 * layout.width;
			const y = layout.top + focus.y / 100 * layout.height;
			assert.ok(x >= 0 && x <= width, `selected x ${x} outside ${width}`);
			assert.ok(y >= 0 && y <= height, `selected y ${y} outside ${height}`);
		}
	}
	const narrow = mapWorldLayout(320, 714, 1, { x: 61, y: 42 });
	close(narrow.left + 0.61 * narrow.width, 160);
});

test("edge focus clamps the world to viewport bounds rather than exposing empty space", () => {
	const near = mapWorldLayout(500, 600, 1.45, { x: 0, y: 0 });
	assert.equal(near.left, 0);
	assert.equal(near.top, 0);
	const far = mapWorldLayout(500, 600, 1.45, { x: 100, y: 100 });
	close(far.left, 500 - far.width);
	close(far.top, 600 - far.height);
	assert.deepEqual(mapWorldLayout(500, 600, 1.45, { x: -20, y: 150 }), mapWorldLayout(500, 600, 1.45, { x: 0, y: 100 }));
});

test("zoom limits preserve proportional dimensions and center dimensions smaller than the viewport", () => {
	const focus = { x: 61, y: 42 };
	const reduced = mapWorldLayout(900, 820, 0.85, focus);
	close(reduced.width, 765);
	close(reduced.height, 697);
	close(reduced.left, 67.5);
	close(reduced.top, 61.5);
	assert.deepEqual(mapWorldLayout(900, 820, 0.1, focus), reduced);
	const enlarged = mapWorldLayout(900, 820, 1.45, focus);
	close(enlarged.width / reduced.width, 1.45 / 0.85);
	assert.deepEqual(mapWorldLayout(900, 820, 5, focus), enlarged);
	const narrow = mapWorldLayout(320, 714, 0.85, focus);
	close(narrow.left + 0.61 * narrow.width, 160);
	close(narrow.top, (714 - narrow.height) / 2);
});

test("hidden or invalid viewport sizes return a safe zero box, with finite defaults for zoom and focus", () => {
	for (const [width, height] of [[0, 714], [528, 0], [-1, 820], [Number.NaN, 820], [900, Number.POSITIVE_INFINITY]]) {
		assert.deepEqual(mapWorldLayout(width, height, 1, { x: 61, y: 42 }), { width: 0, height: 0, left: 0, top: 0 });
	}
	assert.deepEqual(mapWorldLayout(528, 714, Number.NaN, { x: Number.NaN, y: Number.POSITIVE_INFINITY }), mapWorldLayout(528, 714, 1, { x: 50, y: 50 }));
});
