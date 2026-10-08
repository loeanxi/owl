import type { Account } from "owl-pool";
import { parseCredentials } from "owl-pool";
import type { CreditBucket, CreditSnapshot } from "./credits.ts";

const QUOTA_ENDPOINTS: Record<string, string> = {
	BIGMODEL: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
	ZAI: "https://api.z.ai/api/monitor/usage/quota/limit",
	ZCODE_PLAN: "https://zcode.z.ai/api/monitor/usage/quota/limit",
};

/** Coding Plan 的账户额度接口；不会执行模型请求或用连通性替代余额。 */
export async function queryZcodeQuota(account: Account, fetchImpl: typeof fetch = fetch): Promise<CreditSnapshot> {
	const credentials = parseCredentials(account);
	const apiKey = typeof credentials.apiKey === "string" ? credentials.apiKey.trim() : "";
	if (apiKey.length === 0) {
		return failed("ZCode 额度查询缺少 apiKey，请更新账号凭证");
	}
	const channel = typeof credentials.channel === "string" ? credentials.channel.trim().toUpperCase() : "BIGMODEL";
	const endpoint = QUOTA_ENDPOINTS[channel];
	if (endpoint === undefined) {
		return failed("ZCode 额度查询不支持当前通道，请检查账号配置");
	}
	let response: Response;
	try {
		response = await fetchImpl(endpoint, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		return failed(
			error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
				? "ZCode 额度查询超时，请稍后重试"
				: "ZCode 额度服务连接失败，请稍后重试",
		);
	}
	if (response.status === 401 || response.status === 403) {
		return { ...failed("ZCode API Key 无效或已过期，请更新账号凭证"), authRejected: true };
	}
	if (response.status === 429) {
		return failed("ZCode 额度请求过于频繁，请稍后再试");
	}
	if (response.status === 404 || response.status === 405) {
		return { ...failed("ZCode 当前通道暂未提供可读取的额度接口"), availability: "UNAVAILABLE" };
	}
	if (!response.ok) {
		return failed(`ZCode 额度服务返回 HTTP ${response.status}，请稍后重试`);
	}
	try {
		return parseZcodeQuota(await response.json());
	} catch (error) {
		return failed(
			error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
				? "ZCode 额度查询超时，请稍后重试"
				: "ZCode 额度服务返回无效数据，请稍后重试",
		);
	}
}

/** 保留官方两个窗口的原始剩余值，窗口额度不可相加。 */
export function parseZcodeQuota(payload: unknown): CreditSnapshot {
	const root = record(payload);
	if (root === null) {
		return failed("ZCode 额度服务返回无效数据，请稍后重试");
	}
	const code = numeric(root.code);
	if (root.success === false || (code !== null && code !== 0 && code !== 200)) {
		return failed("ZCode 额度服务未成功返回账户额度，请稍后重试");
	}
	const data = record(root.data);
	const limits = data?.limits ?? root.limits;
	const buckets: CreditBucket[] = [];
	for (const raw of Array.isArray(limits) ? limits : []) {
		const row = record(raw);
		if (row === null || (row.type !== "CREDIT_LIMIT" && row.type !== "TOKENS_LIMIT")) {
			continue;
		}
		const unit = numeric(row.unit);
		const count = numeric(row.number);
		const key = unit === 3 && count === 5 ? "hour5" : unit === 6 && count === 1 ? "weekly" : null;
		if (key === null) {
			continue;
		}
		let total = nonnegative(row.usage);
		let used = nonnegative(row.currentValue);
		const explicitRemaining = nonnegative(row.remaining);
		const remaining = explicitRemaining ?? (total !== null && used !== null ? Math.max(0, total - used) : null);
		if (used === null && total !== null && explicitRemaining !== null) {
			used = Math.max(0, total - explicitRemaining);
		}
		const percentage = numeric(row.percentage);
		const remainingPercent =
			percentage !== null
				? Math.max(0, Math.min(100, 100 - percentage))
				: total !== null && total > 0 && remaining !== null
					? Math.max(0, Math.min(100, (remaining / total) * 100))
					: null;
		if (remaining === null && remainingPercent === null) {
			continue;
		}
		const hasNumericQuota = total !== null || explicitRemaining !== null;
		if (!hasNumericQuota && remainingPercent !== null) {
			used = 100 - remainingPercent;
			total = 100;
		}
		const reset = numeric(row.nextResetTime);
		const resetDate = reset === null ? null : new Date(reset);
		buckets.push({
			key,
			label: key === "hour5" ? "5 小时窗口" : "周窗口",
			used,
			total,
			remaining,
			remainingPercent,
			unit: hasNumericQuota ? "积分" : "%",
			resetsAt: resetDate !== null && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null,
			note: null,
		});
	}
	return buckets.length === 0
		? failed("ZCode 未返回可读取的 5 小时或周额度，请稍后重试")
		: { ok: true, credits: null, label: "ZCode 订阅额度", message: "", buckets };
}

function failed(message: string): CreditSnapshot {
	return { ok: false, credits: null, label: null, message, buckets: [] };
}

function nonnegative(value: unknown): number | null {
	const result = numeric(value);
	return result !== null && result >= 0 ? result : null;
}

function numeric(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value)) ? Number(value) : null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
