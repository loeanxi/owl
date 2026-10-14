import assert from "node:assert/strict";
import test from "node:test";
import {
	buildBoard,
	buildTrend,
	buildYearHeat,
	type CareerAgentUsage,
	OTHER_GROUP,
	YEAR_HEAT_WEEKS,
} from "./token-career.ts";

const TODAY = "2026-10-14";

function agent(id: string, days: [string, number][], sessions = 1): CareerAgentUsage {
	const total = days.reduce((sum, [, tokens]) => sum + tokens, 0);
	return {
		id,
		name: id,
		status: "ok",
		sessions,
		totals: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: 0 },
		byDay: days.map(([date, totalTokens]) => ({ date, totalTokens })),
		byModel: [{ key: `p/${id}-model`, totalTokens: total }],
	};
}

test("trend keeps every token of the range and folds agents beyond top 5 into other", () => {
	const agents = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) =>
		agent(id, [
			["2026-10-01", (index + 1) * 10],
			["2026-10-14", 1],
		]),
	);
	const trend = buildTrend(agents, "", "30", TODAY);
	assert.equal(trend.weekly, false);
	assert.equal(trend.buckets.length, 30);
	assert.deepEqual(trend.groups, ["g", "f", "e", "d", "c", OTHER_GROUP]);
	const day = trend.buckets.find((bucket) => bucket.start === "2026-10-01")!;
	assert.equal(day.parts[OTHER_GROUP], 20 + 10);
	assert.equal(trend.total, 280 + 7);
	assert.equal(trend.activeBuckets, 2);
});

test("trend aggregates by Monday-start weeks once the range exceeds 120 days", () => {
	const agents = [agent("a", [["2025-01-01", 5], ["2026-10-12", 3], ["2026-10-14", 4]])];
	const trend = buildTrend(agents, "", "all", TODAY);
	assert.equal(trend.weekly, true);
	assert.equal(trend.total, 12);
	const last = trend.buckets.at(-1)!;
	assert.equal(last.start, "2026-10-12");
	assert.equal(last.total, 7);
	assert.ok(trend.buckets[0]!.start <= "2025-01-01");
});

test("trend respects the agent filter", () => {
	const agents = [agent("a", [["2026-10-10", 5]]), agent("b", [["2026-10-10", 7]])];
	const trend = buildTrend(agents, "b", "90", TODAY);
	assert.equal(trend.total, 7);
	assert.deepEqual(trend.groups, ["b"]);
});

test("year heat spans 53 Monday-start weeks and marks future days", () => {
	const board = buildBoard([agent("a", [["2026-09-20", 100], ["2026-10-02", 50], ["2026-10-14", 10]])], "", TODAY);
	const heat = buildYearHeat(board.byDay, TODAY);
	assert.equal(heat.weeks.length, YEAR_HEAT_WEEKS);
	assert.equal(heat.weeks[0]![0]!.date.length, 10);
	assert.equal(new Date(`${heat.weeks[0]![0]!.date}T12:00:00`).getDay(), 1);
	const lastWeek = heat.weeks.at(-1)!;
	assert.equal(lastWeek[2]!.date, TODAY);
	assert.equal(lastWeek[3]!.level, -1);
	assert.equal(heat.total, 160);
	assert.equal(heat.activeDays, 3);
	assert.equal(heat.monthToDate, 60);
	assert.equal(heat.lastMonthToDate, 0);
	assert.deepEqual(heat.bestMonth, { month: "2026-09", tokens: 100 });
	assert.equal(heat.weekday.reduce((sum, value) => sum + value, 0), 160);
});

test("board records the end date of the longest streak and the 10B milestone", () => {
	const board = buildBoard(
		[agent("a", [["2026-01-01", 1], ["2026-01-02", 1], ["2026-01-03", 1], ["2026-02-01", 10_000_000_000]])],
		"",
		TODAY,
	);
	assert.equal(board.longestStreak, 3);
	assert.equal(board.longestStreakEnd, "2026-01-03");
	assert.ok(board.milestones.some((item) => item.key === "t10b" && item.date === "2026-02-01"));
});
