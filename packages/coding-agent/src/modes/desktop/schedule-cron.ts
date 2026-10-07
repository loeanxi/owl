/**
 * 自动化任务的时间引擎：重复规则校验 + 下一次运行时刻计算。
 *
 * 规则五种（与桥协议 ScheduleRepeat 同构）：每天 / 每周 / 一次性 / 间隔分钟 /
 * 五段 cron（分 时 日 月 周）。所有计算只依赖注入的毫秒时刻，便于测试。
 */

export type ScheduleRepeat =
	| { kind: "daily"; time: string }
	| { kind: "weekly"; weekday: number; time: string }
	| { kind: "once"; at: number }
	| { kind: "interval"; minutes: number }
	| { kind: "cron"; expr: string };

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 人类可读的重复说明（任务卡徽章 / 投递前缀用）。时刻统一补零成 HH:mm。 */
export function describeRepeat(repeat: ScheduleRepeat): string {
	switch (repeat.kind) {
		case "daily": {
			const time = parseHHmm(repeat.time);
			return `每天 ${time ? `${pad2(time.h)}:${pad2(time.m)}` : repeat.time}`;
		}
		case "weekly": {
			const time = parseHHmm(repeat.time);
			return `${WEEKDAY_NAMES[repeat.weekday] ?? "每周"} ${time ? `${pad2(time.h)}:${pad2(time.m)}` : repeat.time}`;
		}
		case "once":
			return `一次性 · ${formatLocal(repeat.at)}`;
		case "interval":
			return repeat.minutes % 60 === 0 ? `每 ${repeat.minutes / 60} 小时` : `每 ${repeat.minutes} 分钟`;
		case "cron":
			return `cron ${repeat.expr}`;
	}
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function formatLocal(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseHHmm(time: string): { h: number; m: number } | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
	if (!match) return null;
	const h = Number(match[1]);
	const m = Number(match[2]);
	if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return null;
	return { h, m };
}

/** 校验重复规则；不合法返回错误文案，合法返回 null。 */
export function validateRepeat(repeat: ScheduleRepeat): string | null {
	switch (repeat.kind) {
		case "daily":
			return parseHHmm(repeat.time) === null ? "时间格式应为 HH:mm" : null;
		case "weekly":
			if (!Number.isInteger(repeat.weekday) || repeat.weekday < 0 || repeat.weekday > 6)
				return "星期取值 0（周日）到 6（周六）";
			return parseHHmm(repeat.time) === null ? "时间格式应为 HH:mm" : null;
		case "once":
			return Number.isFinite(repeat.at) && repeat.at > 0 ? null : "一次性任务需要一个有效时刻";
		case "interval":
			return Number.isInteger(repeat.minutes) && repeat.minutes >= 5 && repeat.minutes <= 1440
				? null
				: "间隔取 5 到 1440 分钟";
		case "cron": {
			const fields = parseCron(repeat.expr);
			return fields ? null : "cron 表达式应为五段：分 时 日 月 周";
		}
	}
}

/** 某任务是否已经「过期完成」（一次性且时刻已过）。 */
export function isExpired(repeat: ScheduleRepeat, now: number): boolean {
	return repeat.kind === "once" && repeat.at <= now;
}

/**
 * 计算严格晚于 `after` 的下一次运行时刻；不再有下一次（过期的一次性）回 null。
 * cron 无匹配（如 2 月 30 日）在 366 天内找不到就回 null。
 */
export function nextRunAt(repeat: ScheduleRepeat, after: number): number | null {
	switch (repeat.kind) {
		case "once":
			return repeat.at > after ? repeat.at : null;
		case "interval": {
			// 对齐到整分钟刻度再外推一步，避免运行间隔漂移到奇秒。
			const step = repeat.minutes * 60_000;
			const base = Math.ceil(after / 60_000) * 60_000;
			return base + step;
		}
		case "daily":
		case "weekly": {
			const time = parseHHmm(repeat.time);
			if (!time) return null;
			const candidate = new Date(after);
			candidate.setHours(time.h, time.m, 0, 0);
			if (repeat.kind === "daily") {
				return candidate.getTime() > after ? candidate.getTime() : candidate.getTime() + 86_400_000;
			}
			let offset = (repeat.weekday - candidate.getDay() + 7) % 7;
			if (offset === 0 && candidate.getTime() <= after) offset = 7;
			return candidate.getTime() + offset * 86_400_000;
		}
		case "cron":
			return cronNext(repeat.expr, after);
	}
}

// ── 五段 cron：分 时 日 月 周（0-6，0=周日；支持 * , - / ） ─────────────

interface CronFields {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number> | null;
	months: Set<number>;
	daysOfWeek: Set<number> | null;
}

function parseField(part: string, min: number, max: number): Set<number> | null {
	const out = new Set<number>();
	for (const piece of part.split(",")) {
		const range = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(piece.trim());
		if (!range) return null;
		const startRaw = range[1];
		const endRaw = range[2];
		const stepRaw = range[3];
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		if (!Number.isInteger(step) || step < 1) return null;
		let from = min;
		let to = max;
		if (startRaw !== "*") {
			from = Number(startRaw);
			if (!Number.isInteger(from) || from < min || from > max) return null;
			to = endRaw === undefined ? from : Number(endRaw);
			if (!Number.isInteger(to) || to < min || to > max || to < from) return null;
		}
		for (let value = from; value <= to; value += step) out.add(value);
	}
	return out.size > 0 ? out : null;
}

function parseCron(expr: string): CronFields | null {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const minutes = parseField(parts[0]!, 0, 59);
	const hours = parseField(parts[1]!, 0, 23);
	const daysOfMonth = parts[2] === "*" ? null : parseField(parts[2]!, 1, 31);
	const months = parseField(parts[3]!, 1, 12);
	const daysOfWeek = parts[4] === "*" ? null : parseField(parts[4]!, 0, 6);
	if (!minutes || !hours || !months || (parts[2] !== "*" && !daysOfMonth) || (parts[4] !== "*" && !daysOfWeek))
		return null;
	return {
		minutes,
		hours,
		daysOfMonth: parts[2] === "*" ? null : daysOfMonth,
		months,
		daysOfWeek: parts[4] === "*" ? null : daysOfWeek,
	};
}

function cronMatches(fields: CronFields, date: Date): boolean {
	if (!fields.months.has(date.getMonth() + 1)) return false;
	if (!fields.hours.has(date.getHours()) || !fields.minutes.has(date.getMinutes())) return false;
	// 标准语义：日与周都受限时取并集。
	const domRestricted = fields.daysOfMonth !== null;
	const dowRestricted = fields.daysOfWeek !== null;
	if (domRestricted && dowRestricted) {
		return fields.daysOfMonth!.has(date.getDate()) || fields.daysOfWeek!.has(date.getDay());
	}
	if (domRestricted && !fields.daysOfMonth!.has(date.getDate())) return false;
	if (dowRestricted && !fields.daysOfWeek!.has(date.getDay())) return false;
	return true;
}

/** cron 的下一次触发；逐分钟扫描，366 天内无匹配回 null（如永不存在的大日期）。 */
function cronNext(expr: string, after: number): number | null {
	const fields = parseCron(expr);
	if (!fields) return null;
	const cursor = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
	const limit = after + 366 * 86_400_000;
	while (cursor.getTime() <= limit) {
		if (cronMatches(fields, cursor)) return cursor.getTime();
		cursor.setMinutes(cursor.getMinutes() + 1);
	}
	return null;
}
