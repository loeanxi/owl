/**
 * 业务时间 —— 移植自 manager `common/BusinessTime`。
 * 「业务今日」以 Asia/Shanghai（固定 +08:00，无夏令时）为准，
 * 签到/账单日切都不看服务器本地时区。
 */

export const BUSINESS_ZONE = "Asia/Shanghai";
const BUSINESS_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 业务日区间 [from, to)（epoch 毫秒）。 */
export interface DateRange {
	from: number;
	to: number;
}

/** 当前业务日（yyyy-MM-dd，Asia/Shanghai）。 */
export function businessDayString(nowMs: number = Date.now()): string {
	return new Date(nowMs + BUSINESS_OFFSET_MS).toISOString().slice(0, 10);
}

/** 指定业务日的 [from, to)。 */
export function businessDayRange(day: string): DateRange {
	const fromMs = Date.parse(`${day}T00:00:00.000Z`) - BUSINESS_OFFSET_MS;
	return { from: fromMs, to: fromMs + 24 * 60 * 60 * 1000 };
}

/** 今天业务日的 [from, to)。 */
export function todayRange(nowMs: number = Date.now()): DateRange {
	return businessDayRange(businessDayString(nowMs));
}

/** 距离下一个「业务日 at 时:分」（Asia/Shanghai）的毫秒数，用于定时签到。 */
export function msUntilBusinessTime(hour: number, minute: number, nowMs: number = Date.now()): number {
	const shifted = nowMs + BUSINESS_OFFSET_MS;
	const dayStartUtc = Math.floor(shifted / 86_400_000) * 86_400_000;
	let target = dayStartUtc + (hour * 60 + minute) * 60_000 - BUSINESS_OFFSET_MS;
	if (target <= nowMs) {
		target += 86_400_000;
	}
	return target - nowMs;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** [min, min+bound) 内的随机整数（移植 Java ThreadLocalRandom.nextInt(bound) 语义）。 */
export function randomInt(min: number, bound: number): number {
	return min + Math.floor(Math.random() * bound);
}
