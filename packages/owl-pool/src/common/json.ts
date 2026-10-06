/**
 * 宽松 JSON 探查工具 —— 移植自 manager `WorkBuddyCheckInProvider` 里的
 * JsonNode 辅助逻辑。上游签到/积分接口的响应信封五花八门
 * （code 0/200、success/claimed 标志、data/result/payload/body 嵌套），
 * 这组函数做「多信封深搜」，是签到判定的容错基础。
 */

/** 深搜第一个命中的键值：先顶层逐键，再按常见信封（data/result/payload/body）递归。 */
export function findDeep(node: unknown, keys: string[]): unknown {
	if (node === null || typeof node !== "object") {
		return undefined;
	}
	const record = node as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined && value !== null) {
			return value;
		}
	}
	for (const envelope of ["data", "result", "payload", "body"]) {
		const nested = record[envelope];
		if (nested !== null && typeof nested === "object") {
			const found = findDeep(nested, keys);
			if (found !== undefined) {
				return found;
			}
		}
	}
	return undefined;
}

/** 深搜数值型状态码（code/statusCode/status），解析不了返回 -1。 */
export function envelopeCode(node: unknown): number {
	const value = findDeep(node, ["code", "statusCode", "status"]);
	if (value === undefined) {
		return -1;
	}
	if (typeof value === "number") {
		return value;
	}
	const parsed = Number.parseInt(String(value), 10);
	return Number.isNaN(parsed) ? -1 : parsed;
}

/**
 * 布尔标志判定：boolean true；文本 "true"/"ok"/"success"；
 * 数值 >0 仅在键名含 claim/check 时算数（如 claimedCount）。
 */
export function hasFlag(node: unknown, keys: string[]): boolean {
	for (const key of keys) {
		const value = findDeep(node, [key]);
		if (value === undefined) {
			continue;
		}
		if (typeof value === "boolean" && value) {
			return true;
		}
		if (typeof value === "string") {
			const lowered = value.toLowerCase();
			if (lowered === "true" || lowered === "ok" || lowered === "success") {
				return true;
			}
		}
		if (typeof value === "number" && value > 0 && (key.includes("claim") || key.includes("check"))) {
			return true;
		}
	}
	return false;
}

/** 深搜第一个非空文本字段。 */
export function envelopeText(node: unknown, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = findDeep(node, [key]);
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return undefined;
}

/** 整体文本里是否包含任一关键字（大小写不敏感）。 */
export function hasText(node: unknown, keywords: string[]): boolean {
	const all = node === null || node === undefined ? "" : JSON.stringify(node).toLowerCase();
	return keywords.some((keyword) => all.includes(keyword.toLowerCase()));
}
