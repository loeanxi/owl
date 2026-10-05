import assert from "node:assert/strict";
import test from "node:test";
import { HEATMAP_WEEKS, heatmapCells } from "./usage-heatmap.ts";

function key(offset: number): string {
	const date = new Date();
	date.setHours(12, 0, 0, 0);
	date.setDate(date.getDate() - offset);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

test("all range keeps a full 26-week grid when only a few days have usage", () => {
	const heat = heatmapCells(
		[
			{ date: key(0), totalTokens: 100 },
			{ date: key(1), totalTokens: 40 },
			{ date: key(3), totalTokens: 10 },
		],
		"all",
	);
	assert.equal(heat.fill, true);
	assert.equal(heat.cells.length, HEATMAP_WEEKS);
	for (const week of heat.cells) assert.equal(week.length, 7);
	const today = heat.cells.flat().find((cell) => cell.date === key(0));
	assert.ok(today && today.level >= 1);
	const quiet = heat.cells.flat().find((cell) => cell.date === key(20));
	assert.ok(quiet);
	assert.equal(quiet.level, 0);
	const first = heat.cells[0]?.[0];
	assert.ok(first);
	assert.equal(new Date(`${first.date}T12:00:00`).getDay(), 1);
});

test("7d stays inside the returned window", () => {
	const days = Array.from({ length: 7 }, (_, index) => ({
		date: key(6 - index),
		totalTokens: index === 6 ? 10 : 0,
	}));
	const heat = heatmapCells(days, "7d");
	assert.equal(heat.fill, false);
	assert.ok(heat.cells.length >= 1 && heat.cells.length <= 3);
	assert.ok(heat.cells.length < HEATMAP_WEEKS);
});
