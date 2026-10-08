import type { Account } from "owl-pool";
import { describe, expect, it, vi } from "vitest";
import { parseZcodeQuota, queryZcodeQuota } from "../src/account/zcode-quota.ts";

function account(credentials: Record<string, unknown>): Account {
	return {
		id: "zcode-quota",
		name: "ZCode",
		platform: "ZCODE",
		credentials,
		enabled: true,
		createdAt: 0,
		updatedAt: 0,
	};
}

describe("ZCode 只读额度查询", () => {
	it.each([
		["BIGMODEL", "https://open.bigmodel.cn/api/monitor/usage/quota/limit"],
		["ZAI", "https://api.z.ai/api/monitor/usage/quota/limit"],
		[undefined, "https://open.bigmodel.cn/api/monitor/usage/quota/limit"],
	])("按 %s 通道读取真实额度，不要求账号额外配置 baseUrl", async (channel, endpoint) => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				code: 200,
				success: true,
				data: {
					limits: [
						{
							type: "CREDIT_LIMIT",
							unit: 3,
							number: 5,
							usage: 2000,
							currentValue: 56,
							remaining: 1943,
							percentage: 2,
							nextResetTime: 1791438486166,
						},
						{
							type: "CREDIT_LIMIT",
							unit: 6,
							number: 1,
							usage: 10000,
							currentValue: 5684,
							remaining: 4315,
							percentage: 56,
						},
					],
				},
			}),
		);
		const snapshot = await queryZcodeQuota(
			account({ apiKey: "test-api-key", ...(channel === undefined ? {} : { channel }) }),
			fetchImpl,
		);
		expect(snapshot).toMatchObject({
			ok: true,
			credits: null,
			buckets: [
				{
					key: "hour5",
					used: 56,
					total: 2000,
					remaining: 1943,
					remainingPercent: 98,
					unit: "积分",
					resetsAt: "2026-10-08T05:48:06.166Z",
				},
				{ key: "weekly", used: 5684, total: 10000, remaining: 4315, remainingPercent: 44, unit: "积分" },
			],
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(String(url)).toBe(endpoint);
		expect(init?.method).toBe("GET");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-api-key");
		expect(init?.body).toBeUndefined();
		expect(JSON.stringify(snapshot)).not.toContain("test-api-key");
	});

	it("旧百分比口径保留两个窗口，不伪造剩余积分", () => {
		expect(
			parseZcodeQuota({
				limits: [
					{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 100 },
					{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 20 },
				],
			}),
		).toMatchObject({
			ok: true,
			credits: null,
			buckets: [
				{ key: "hour5", used: 100, total: 100, remaining: null, remainingPercent: 0, unit: "%" },
				{ key: "weekly", used: 20, total: 100, remaining: null, remainingPercent: 80, unit: "%" },
			],
		});
	});

	it("零余额有效，缺少 remaining 时仅由完整 total/used 计算", () => {
		expect(
			parseZcodeQuota({
				data: {
					limits: [
						{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 10, currentValue: 10 },
						{ type: "CREDIT_LIMIT", unit: 6, number: 1, remaining: 0 },
					],
				},
			}),
		).toMatchObject({ ok: true, buckets: [{ remaining: 0 }, { remaining: 0 }] });
	});

	it.each([
		{},
		{ data: { limits: [] } },
		{ limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, remaining: 5 }] },
		{ limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5 }] },
		{ limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, remaining: false, usage: "", percentage: null }] },
	])("未知额度不能显示成功或 0：%j", (payload) => {
		expect(parseZcodeQuota(payload)).toMatchObject({ ok: false, credits: null, buckets: [] });
	});

	it.each([401, 403, 429, 500, 404])("HTTP %i 返回受控错误，不泄露上游原文", async (status) => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ msg: "test-api-key private-user" }, { status }));
		const snapshot = await queryZcodeQuota(account({ apiKey: "test-api-key", channel: "BIGMODEL" }), fetchImpl);
		expect(snapshot).toMatchObject({ ok: false, credits: null, buckets: [] });
		expect(snapshot.authRejected).toBe(status === 401 || status === 403 ? true : undefined);
		expect(snapshot.message).not.toMatch(/test-api-key|private-user/);
	});

	it("HTTP 200 的上游业务失败不能误读成成功", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				code: 500,
				success: false,
				msg: "test-api-key",
				data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, remaining: 100 }] },
			}),
		);
		expect(await queryZcodeQuota(account({ apiKey: "test-api-key" }), fetchImpl)).toMatchObject({
			ok: false,
			credits: null,
			buckets: [],
		});
	});

	it.each([{ channel: "BIGMODEL" }, { apiKey: " " }, { apiKey: "test-api-key", channel: "OTHER" }])(
		"缺凭证或不支持的通道不访问其他上游：%j",
		async (credentials) => {
			const fetchImpl = vi.fn<typeof fetch>();
			expect(await queryZcodeQuota(account(credentials), fetchImpl)).toMatchObject({
				ok: false,
				credits: null,
				buckets: [],
			});
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("网络和无效 JSON 错误均不透传凭证", async () => {
		for (const fetchImpl of [
			vi.fn<typeof fetch>().mockRejectedValue(new Error("test-api-key")),
			vi.fn<typeof fetch>().mockResolvedValue(new Response("test-api-key")),
		]) {
			const snapshot = await queryZcodeQuota(account({ apiKey: "test-api-key" }), fetchImpl);
			expect(snapshot.ok).toBe(false);
			expect(snapshot.message).not.toContain("test-api-key");
		}
	});
});
