import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRepeat, isExpired, nextRunAt, type ScheduleRepeat, validateRepeat } from "./schedule-cron.ts";

/** 固定基准：2026-10-07（周三）10:30 本地时间。 */
const BASE = new Date(2026, 9, 7, 10, 30, 0, 0).getTime();
const DAY = 86_400_000;

test("daily: 严格晚于基准的下一个时刻", () => {
	const repeat: ScheduleRepeat = { kind: "daily", time: "08:30" };
	// 10:30 之后 → 明天 08:30
	assert.equal(nextRunAt(repeat, BASE), new Date(2026, 9, 8, 8, 30).getTime());
	// 08:00 之后 → 当天 08:30
	assert.equal(nextRunAt(repeat, new Date(2026, 9, 7, 8, 0).getTime()), new Date(2026, 9, 7, 8, 30).getTime());
	// 整点整分相等不算（严格晚于）
	assert.equal(nextRunAt(repeat, new Date(2026, 9, 7, 8, 30).getTime()), new Date(2026, 9, 8, 8, 30).getTime());
});

test("weekly: 下一个指定星期几", () => {
	const repeat: ScheduleRepeat = { kind: "weekly", weekday: 1, time: "09:00" };
	// 2026-10-07 是周三；下一个周一是 10-12
	assert.equal(nextRunAt(repeat, BASE), new Date(2026, 9, 12, 9, 0).getTime());
	// 周一 08:00 → 当天 09:00
	assert.equal(nextRunAt(repeat, new Date(2026, 9, 12, 8, 0).getTime()), new Date(2026, 9, 12, 9, 0).getTime());
	// 周一 09:00 整 → 下周一
	assert.equal(nextRunAt(repeat, new Date(2026, 9, 12, 9, 0).getTime()), new Date(2026, 9, 19, 9, 0).getTime());
});

test("once: 未来时刻原样返回，过期回 null", () => {
	const at = BASE + 60 * 60_000;
	assert.equal(nextRunAt({ kind: "once", at }, BASE), at);
	assert.equal(nextRunAt({ kind: "once", at }, at), null);
	assert.equal(isExpired({ kind: "once", at }, at), true);
	assert.equal(isExpired({ kind: "once", at }, at - 1), false);
});

test("interval: 整分钟对齐外推", () => {
	const repeat: ScheduleRepeat = { kind: "interval", minutes: 20 };
	const next = nextRunAt(repeat, BASE + 5 * 60_000)!; // 10:35 → 下一个整刻度 + 20min
	assert.equal(new Date(next).getSeconds(), 0);
	assert.ok(next > BASE);
});

test("cron: 五段表达式与 dom/dow 并集语义", () => {
	// 每小时 0 分
	const hourly = nextRunAt({ kind: "cron", expr: "0 * * * *" }, BASE)!;
	assert.equal(new Date(hourly).getMinutes(), 0);
	assert.equal(hourly, new Date(2026, 9, 7, 11, 0).getTime());
	// 工作日 09:00
	const weekday = nextRunAt({ kind: "cron", expr: "0 9 * * 1-5" }, BASE)!;
	assert.equal(weekday, new Date(2026, 9, 8, 9, 0).getTime());
	// dom 与 dow 同时受限：并集（13 日周五 或 所有周五）
	const both = nextRunAt({ kind: "cron", expr: "0 8 13 * 5" }, BASE)!;
	// 10-09 周五（比 10-13 周二早）
	assert.equal(both, new Date(2026, 9, 9, 8, 0).getTime());
	// 步进 */15
	const step = nextRunAt({ kind: "cron", expr: "*/15 * * * *" }, BASE)!;
	assert.equal(step, new Date(2026, 9, 7, 10, 45).getTime());
	// 永不存在（2 月 31 日）→ null
	assert.equal(nextRunAt({ kind: "cron", expr: "0 0 31 2 *" }, BASE), null);
});

test("validateRepeat: 各规则的可读报错", () => {
	assert.equal(validateRepeat({ kind: "daily", time: "08:30" }), null);
	// 一位小时宽容接受（8:30 = 08:30）
	assert.equal(validateRepeat({ kind: "daily", time: "8:30" }), null);
	assert.match(validateRepeat({ kind: "daily", time: "25:00" }) ?? "", /HH:mm/);
	assert.equal(validateRepeat({ kind: "weekly", weekday: 0, time: "09:00" }), null);
	assert.match(validateRepeat({ kind: "weekly", weekday: 7, time: "09:00" }) ?? "", /星期/);
	assert.match(validateRepeat({ kind: "interval", minutes: 3 }) ?? "", /5 到 1440/);
	assert.match(validateRepeat({ kind: "cron", expr: "0 9 * *" }) ?? "", /五段/);
	assert.equal(validateRepeat({ kind: "cron", expr: "*/10 9-18 * * 1-5" }), null);
});

test("describeRepeat: 人类可读", () => {
	assert.equal(describeRepeat({ kind: "daily", time: "08:30" }), "每天 08:30");
	assert.equal(describeRepeat({ kind: "weekly", weekday: 1, time: "09:00" }), "周一 09:00");
	assert.equal(describeRepeat({ kind: "interval", minutes: 20 }), "每 20 分钟");
	assert.equal(describeRepeat({ kind: "interval", minutes: 120 }), "每 2 小时");
	assert.match(describeRepeat({ kind: "once", at: BASE }), /一次性 · 2026-10-07 10:30/);
	assert.equal(describeRepeat({ kind: "daily", time: "8:30" }), "每天 08:30");
	assert.equal(DAY, 86_400_000);
});
