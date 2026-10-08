import { type Account, InMemoryAccountStore } from "owl-pool";
import { describe, expect, it, vi } from "vitest";
import { type CreditHooks, query, refreshCredit } from "../src/account/credits.ts";
import { queryQoderQuota } from "../src/account/qoder-quota.ts";

function account(credentials: Record<string, unknown>): Account {
	return {
		id: "qoder-quota-test",
		name: "Qoder 额度测试号",
		platform: "QODER",
		credentials,
		enabled: true,
		createdAt: 0,
		updatedAt: 0,
	};
}

function hooks(fetchImpl: typeof fetch): CreditHooks {
	return {
		fetchImpl,
		workbuddyBaseUrl: "https://unused.invalid",
		workbuddyAuthRoots: [],
		exchangeTraeToken: async () => "unused",
		sdkQuota: vi.fn(async () => {
			throw new Error("SDK bridge is not installed");
		}),
	};
}

describe("Qoder CN PAT 只读额度查询", () => {
	it("仅签到 PAT 的账号能独立查询套餐 0 和加购 700，不启动 SDK 或领取权益", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ token: "exchanged-quota-token" }))
			.mockResolvedValueOnce(
				Response.json({
					user_id: "test-user",
					user_type: "FREE",
					user_quota: { total: 0, used: 0, remaining: 0 },
					add_on_quota: { total: 700, used: 0, remaining: 700 },
				}),
			);
		const creditHooks = hooks(fetchImpl);
		const current = account({ checkinToken: "quota-test-pat" });
		const snapshot = await query(current, creditHooks);

		expect(snapshot.ok).toBe(true);
		expect(snapshot.buckets).toMatchObject([
			{ key: "plan", remaining: 0, total: 0, used: 0 },
			{ key: "addon", remaining: 700, total: 700, used: 0 },
		]);
		expect(creditHooks.sdkQuota).not.toHaveBeenCalled();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const [exchangeUrl, exchangeInit] = fetchImpl.mock.calls[0]!;
		expect(String(exchangeUrl)).toBe("https://openapi.qoder.com.cn/api/v1/jobToken/exchange");
		expect(exchangeInit?.method).toBe("POST");
		expect(JSON.parse(String(exchangeInit?.body))).toEqual({ personal_token: "quota-test-pat" });
		const [quotaUrl, quotaInit] = fetchImpl.mock.calls[1]!;
		expect(String(quotaUrl)).toBe("https://openapi.qoder.com.cn/api/v2/quota/usage");
		expect(quotaInit?.method).toBe("GET");
		expect(new Headers(quotaInit?.headers).get("Authorization")).toBe("Bearer exchanged-quota-token");
		expect(quotaInit?.body).toBeUndefined();
		expect(current.credentials).toEqual({ checkinToken: "quota-test-pat" });
		expect(JSON.stringify(snapshot)).not.toMatch(/quota-test-pat|exchanged-quota-token|test-user/);
	});

	it("没有 PAT 的 ACCOUNT_HOME 账号继续使用 SDK 额度路径", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const sdkQuota = vi.fn(async () => ({ userQuota: { total: 100, used: 30, remaining: 70 } }));
		const snapshot = await query(account({ authSource: "ACCOUNT_HOME" }), { ...hooks(fetchImpl), sdkQuota });
		expect(snapshot).toMatchObject({ ok: true, buckets: [{ key: "plan", remaining: 70 }] });
		expect(sdkQuota).toHaveBeenCalledTimes(1);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("兼容 camelCase 多池，只保留额度字段，组织不可用状态继续交给已有解析器", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: { access_token: "quota-access-token" } }))
			.mockResolvedValueOnce(
				Response.json({
					token: "upstream-secret",
					email: "private@example.invalid",
					userQuota: { total: 10, used: 4, extra: "private" },
					addOnQuota: { remaining: "800", unit: "Credits" },
					sharedQuota: { total: 100, used: 20, available: false, apiKey: "upstream-secret" },
				}),
			);
		const snapshot = await query(account({ checkinToken: "quota-test-pat" }), hooks(fetchImpl));
		expect(snapshot).toMatchObject({
			ok: true,
			buckets: [
				{ key: "plan", total: 10, used: 4, remaining: 6 },
				{ key: "addon", remaining: 800, total: null, used: null },
				{ key: "organization", total: 100, used: 20, remaining: 80, unavailable: true },
			],
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/upstream-secret|private@example|quota-access-token|extra|apiKey/);
	});

	it.each(["QODERCN_PERSONAL_ACCESS_TOKEN", "accessToken", "personalAccessToken", "authToken", "apiKey", "token"])(
		"已有 %s PAT 也可直接读取额度而不改变模型环境",
		async (key) => {
			const beforeModelToken = process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ token: "quota-access-token" }))
				.mockResolvedValueOnce(Response.json({ userQuota: { remaining: 1 } }));
			const creditHooks = hooks(fetchImpl);
			expect((await query(account({ [key]: "quota-test-pat" }), creditHooks)).ok).toBe(true);
			expect(creditHooks.sdkQuota).not.toHaveBeenCalled();
			expect(process.env.QODERCN_PERSONAL_ACCESS_TOKEN).toBe(beforeModelToken);
		},
	);

	it.each([
		{},
		{ session: { total_credits: 0, model_usage: {} } },
		{ userQuota: {} },
		{ userQuota: { total: "", used: null, remaining: "invalid" } },
		{ userQuota: { total: false, used: [], remaining: {} } },
	])("未知或无效额度不能显示成 0：%j", async (response) => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ token: "quota-access-token" }))
			.mockResolvedValueOnce(Response.json(response));
		const snapshot = await query(account({ checkinToken: "quota-test-pat" }), hooks(fetchImpl));
		expect(snapshot).toMatchObject({ ok: false, credits: null, buckets: [] });
		expect(snapshot.message).toContain("未返回账户额度");
	});

	it("保留负数总额哨兵，不从它计算出虚假的 0 余额", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ token: "quota-access-token" }))
			.mockResolvedValueOnce(Response.json({ user_quota: { total: -1, used: 3 } }));
		expect(await queryQoderQuota("quota-test-pat", fetchImpl)).toEqual({ userQuota: { total: -1, used: 3 } });
	});

	it.each([
		[401, "PAT 无效或已过期"],
		[403, "PAT 无效或已过期"],
		[429, "请求过于频繁"],
		[500, "服务暂时不可用"],
		[503, "服务暂时不可用"],
		[400, "HTTP 400"],
	])("额度接口 HTTP %i 报告独立错误，不透传原文且不修改模型认证状态", async (status, message) => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ token: "quota-access-token" }))
			.mockResolvedValueOnce(
				Response.json({ message: "quota-test-pat quota-access-token private-error" }, { status }),
			);
		const accounts = new InMemoryAccountStore();
		const created = accounts.create(
			{ name: "额度测试", platform: "QODER", credentials: { checkinToken: "quota-test-pat" } },
			0,
		);
		const current = accounts.patchState(created.id, {
			credentialStatus: "OK",
			credentialMessage: "模型认证正常",
			credentialCheckedAt: 1,
		});
		const refreshed = await refreshCredit(accounts, current, hooks(fetchImpl));
		expect(refreshed.creditsStatus).toBe("FAIL");
		expect(refreshed.creditsMessage).toContain(message);
		expect(refreshed.creditsMessage).not.toMatch(/quota-test-pat|quota-access-token|private-error/);
		expect(refreshed.credentialStatus).toBe("OK");
		expect(refreshed.credentialMessage).toBe("模型认证正常");
		expect(refreshed.credentialCheckedAt).toBe(1);
	});

	it.each([401, 403, 429, 503])("PAT 兑换 HTTP %i 失败时不继续查额度", async (status) => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ token: "private-error" }, { status }));
		const snapshot = await query(account({ checkinToken: "quota-test-pat" }), hooks(fetchImpl));
		expect(snapshot.ok).toBe(false);
		expect(snapshot.message).not.toContain("private-error");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("兑换未返回 token 不能当成明确的 PAT 失效，也不能读取额度", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message: "private-error" }));
		const snapshot = await query(account({ checkinToken: "quota-test-pat" }), hooks(fetchImpl));
		expect(snapshot.ok).toBe(false);
		expect(snapshot.message).toContain("未返回访问凭证");
		expect(snapshot.message).not.toMatch(/失效|无效或已过期|private-error/);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it.each([
		[new DOMException("quota-test-pat private-error", "TimeoutError"), "查询超时"],
		[new Error("quota-access-token private-error"), "服务连接失败"],
	])("网络错误只返回受控诊断", async (error, message) => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(error);
		const snapshot = await query(account({ checkinToken: "quota-test-pat" }), hooks(fetchImpl));
		expect(snapshot).toMatchObject({ ok: false, credits: null, buckets: [] });
		expect(snapshot.message).toContain(message);
		expect(snapshot.message).not.toMatch(/quota-test-pat|quota-access-token|private-error/);
	});

	it("成功状态中的非 JSON 原始响应不外泄", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("quota-test-pat private-error", { status: 200 }));
		const snapshot = await query(account({ checkinToken: "quota-test-pat" }), hooks(fetchImpl));
		expect(snapshot.ok).toBe(false);
		expect(snapshot.message).toContain("返回无效数据");
		expect(snapshot.message).not.toMatch(/quota-test-pat|private-error/);
	});

	it("等待响应体期间超时也显示额度超时，不透传底层诊断", async () => {
		const response = Response.json({});
		vi.spyOn(response, "json").mockRejectedValue(new DOMException("quota-test-pat private-error", "TimeoutError"));
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
		const snapshot = await query(account({ checkinToken: "quota-test-pat" }), hooks(fetchImpl));
		expect(snapshot.ok).toBe(false);
		expect(snapshot.message).toContain("查询超时");
		expect(snapshot.message).not.toMatch(/quota-test-pat|private-error/);
	});

	it("显式无效的签到 PAT 不回退到另一账号凭证或 SDK", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const creditHooks = hooks(fetchImpl);
		const snapshot = await query(account({ checkinToken: " ", accessToken: "other-pat" }), creditHooks);
		expect(snapshot.ok).toBe(false);
		expect(snapshot.message).toContain("非空字符串");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(creditHooks.sdkQuota).not.toHaveBeenCalled();
	});
});
