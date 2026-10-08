const QODER_API_BASE = "https://openapi.qoder.com.cn";
const REQUEST_TIMEOUT_MS = 12_000;

/** 签到 PAT 可读取账户额度；不会写入模型 SDK 的认证环境或修改登录状态。 */
export function qoderQuotaPersonalToken(credentials: Record<string, unknown>): string | null {
	const token =
		credentials.checkinToken ??
		credentials.QODERCN_PERSONAL_ACCESS_TOKEN ??
		["accessToken", "personalAccessToken", "authToken", "apiKey", "token"]
			.map((key) => credentials[key])
			.find((value) => value !== undefined);
	if (token === undefined) {
		return null;
	}
	if (typeof token !== "string" || token.trim().length === 0) {
		throw new Error("Qoder CN 额度 PAT 必须是非空字符串，请更新账号凭证");
	}
	return token.trim();
}

/** 与官方 CLI 的 exchangePersonalToken / fetchQuotaUsage 使用相同的只读账户接口。 */
export async function queryQoderQuota(
	personalToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
	const exchange = await requestJson(fetchImpl, "/api/v1/jobToken/exchange", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ personal_token: personalToken }),
	});
	const exchangeData = record(exchange.data) ?? exchange;
	const token = [exchange.token, exchangeData.token, exchangeData.device_token, exchangeData.access_token].find(
		(value) => typeof value === "string" && value.trim().length > 0,
	);
	if (typeof token !== "string") {
		throw new Error("Qoder CN 额度 PAT 兑换未返回访问凭证，请稍后重试");
	}
	const payload = await requestJson(fetchImpl, "/api/v2/quota/usage", {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
	});
	const data = record(payload.data) ?? payload;
	const result: Record<string, unknown> = {};
	const pools = [
		["userQuota", data.user_quota ?? data.userQuota, false],
		["addOnQuota", data.add_on_quota ?? data.addOnQuota, false],
		[
			"orgResourcePackage",
			data.org_resource_package ?? data.orgResourcePackage ?? data.shared_quota ?? data.sharedQuota,
			true,
		],
	] as const;
	for (const [key, raw, organization] of pools) {
		const pool = projectPool(raw, organization);
		if (pool !== null) {
			result[key] = pool;
		}
	}
	return result;
}

async function requestJson(fetchImpl: typeof fetch, path: string, init: RequestInit): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetchImpl(`${QODER_API_BASE}${path}`, {
			...init,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			throw new Error("Qoder CN 额度查询超时，请稍后重试");
		}
		throw new Error("Qoder CN 额度服务连接失败，请稍后重试");
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error("Qoder CN 额度 PAT 无效或已过期，请更新签到 PAT");
	}
	if (response.status === 429) {
		throw new Error("Qoder CN 额度请求过于频繁，请稍后再试");
	}
	if (response.status >= 500) {
		throw new Error("Qoder CN 额度服务暂时不可用，请稍后重试");
	}
	if (!response.ok) {
		throw new Error(`Qoder CN 额度服务返回 HTTP ${response.status}，请稍后重试`);
	}
	try {
		const payload: unknown = await response.json();
		const parsed = record(payload);
		if (parsed !== null) {
			return parsed;
		}
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			throw new Error("Qoder CN 额度查询超时，请稍后重试");
		}
		// 原始上游响应或解析错误可能含访问凭证，不向账号页透传。
	}
	throw new Error("Qoder CN 额度服务返回无效数据，请稍后重试");
}

function projectPool(raw: unknown, organization: boolean): Record<string, unknown> | null {
	const source = record(raw);
	if (source === null) {
		return null;
	}
	const total = numeric(organization ? (source.cap ?? source.total) : source.total);
	const used = numeric(source.used);
	const remaining =
		numeric(source.remaining) ??
		(total !== null && used !== null && total >= 0 && used >= 0 ? Math.max(0, total - used) : null);
	if (total === null && used === null && remaining === null) {
		return null;
	}
	return {
		...(total === null ? {} : { [organization ? "cap" : "total"]: total }),
		...(used === null ? {} : { used }),
		...(remaining === null ? {} : { remaining }),
		...(typeof source.unit === "string" && source.unit.trim().length > 0 ? { unit: source.unit.trim() } : {}),
		...(organization && typeof source.available === "boolean" ? { available: source.available } : {}),
	};
}

function numeric(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
