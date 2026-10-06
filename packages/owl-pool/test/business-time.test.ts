import { describe, expect, it } from "vitest";
import { businessDayRange, businessDayString, msUntilBusinessTime, todayRange } from "../src/common/business-time.ts";

describe("business-time（Asia/Shanghai 业务日）", () => {
	// 2026-10-07T22:00:00Z → 上海 2026-10-08 06:00
	const NOW = Date.parse("2026-10-07T22:00:00.000Z");

	it("业务日按 +08:00 计算，不看 UTC 日期", () => {
		expect(businessDayString(NOW)).toBe("2026-10-08");
		// epoch 0 = 上海 1970-01-01 08:00
		expect(businessDayString(0)).toBe("1970-01-01");
	});

	it("todayRange 左闭右开，跨过 UTC 午夜仍在同一业务日", () => {
		const range = todayRange(NOW);
		expect(range.to - range.from).toBe(86_400_000);
		// NOW 在上海 06:00，落在当天区间内
		expect(NOW).toBeGreaterThanOrEqual(range.from);
		expect(NOW).toBeLessThan(range.to);
		// 业务日 06:00 对应的 UTC 时点比 range.from 晚 6 小时
		expect(NOW - range.from).toBe(6 * 3_600_000);
	});

	it("msUntilBusinessTime：今日未到返回今天差值，已过返回明天差值", () => {
		// 上海 06:00，目标今日 00:05 已过 → 明天 00:05，差 18h05m
		expect(msUntilBusinessTime(0, 5, NOW)).toBe((18 * 60 + 5) * 60_000);
		// 目标今日 08:00 未到 → 差 2 小时
		expect(msUntilBusinessTime(8, 0, NOW)).toBe(2 * 3_600_000);
	});

	it("businessDayRange 与字符串互逆", () => {
		const range = businessDayRange("2026-10-08");
		expect(businessDayString(range.from)).toBe("2026-10-08");
		expect(businessDayString(range.to - 1)).toBe("2026-10-08");
		expect(businessDayString(range.to)).toBe("2026-10-09");
	});
});
