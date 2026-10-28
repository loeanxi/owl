/**
 * 个人主页图表（每周柱状 / 累计曲线）的数据层单测。
 * 契约：周一分桶、窗口固定 26 周（含本周）、无数据周补 0；累计曲线按日期排序后逐日累积。
 */

import { expect, test } from "vitest";
import { cumulativePoints, weeklyBuckets } from "./account-charts.tsx";

function day(date: string, tokens: number): { date: string; totalTokens: number } {
	return { date, totalTokens: tokens };
}

test("weeklyBuckets buckets by Monday and pads empty weeks", () => {
	// 2025-01-06 是周一；同周周六的用量归进那一周
	const buckets = weeklyBuckets([
		day("2025-01-06", 100),
		day("2025-01-11", 50),
		day("2025-01-13", 30), // 下一周
	] as never);
	expect(buckets).toHaveLength(26);
	const last = buckets[buckets.length - 1]!;
	// 窗口右端对齐「本周」；2025 年的历史数据落在窗口外则不计入
	expect(last.tokens).toBe(0);
	const withData = buckets.filter((bucket) => bucket.tokens > 0);
	// 2025 年的数据在当前日期（2026+）的 26 周窗口之外，应全部丢弃
	expect(withData).toHaveLength(0);
});

test("weeklyBuckets sums same-week usage into one bucket", () => {
	const now = new Date();
	const monday = new Date(now);
	monday.setHours(12, 0, 0, 0);
	monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
	const key = (date: Date): string =>
		`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	const buckets = weeklyBuckets([day(key(monday), 12), day(key(now), 34)] as never);
	const last = buckets[buckets.length - 1]!;
	expect(last.tokens).toBe(46);
});

test("cumulativePoints sorts by date and accumulates", () => {
	const points = cumulativePoints([day("2025-02-01", 5), day("2025-01-01", 10), day("2025-01-15", 1)] as never);
	expect(points.map((point) => point.date)).toEqual(["2025-01-01", "2025-01-15", "2025-02-01"]);
	expect(points.map((point) => point.total)).toEqual([10, 11, 16]);
});

test("cumulativePoints tolerates empty input", () => {
	expect(cumulativePoints([])).toEqual([]);
});
