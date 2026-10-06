import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../src/account/types.ts";
import { readAccessTokenFromFile, WorkBuddyCheckInProvider } from "../src/checkin/providers/workbuddy.ts";

function makeAccount(credentials: Record<string, unknown>, platform: Account["platform"] = "WORKBUDDY"): Account {
	return {
		id: "acc-1",
		name: "测试号",
		platform,
		credentials,
		enabled: true,
		createdAt: 0,
		updatedAt: 0,
	};
}

interface CapturedRequest {
	url: string;
	init: RequestInit;
}

/** 按 URL 前缀给出固定响应的 fetch 桩。 */
function stubFetch(responses: Record<string, string | { status: number; body: string }>): {
	fetchImpl: typeof fetch;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, init: init ?? {} });
		const matchedKey = Object.keys(responses).find((key) => url.includes(key));
		const spec = matchedKey === undefined ? { status: 200, body: "{}" } : responses[matchedKey];
		const status = typeof spec === "string" ? 200 : spec.status;
		const body = typeof spec === "string" ? spec : spec.body;
		return new Response(body, { status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return { fetchImpl, requests };
}

const STATUS_PATH = "checkin-activity-status";
const CLAIM_PATH = "daily-checkin";

describe("WorkBuddyCheckInProvider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("查状态未签 → 领取成功（code 0 + credits）", async () => {
		const { fetchImpl, requests } = stubFetch({
			[STATUS_PATH]: JSON.stringify({ code: 1, message: "not checked in" }),
			[CLAIM_PATH]: JSON.stringify({ code: 0, credits: 50, message: "签到成功" }),
		});
		const provider = new WorkBuddyCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ accessToken: "tok-1" }));

		expect(result.status).toBe("SUCCESS");
		expect(result.message).toBe("签到成功");
		expect(result.credits).toBe(50);
		expect(requests).toHaveLength(2);
		expect(requests[0].url).toContain("/v2/billing/meter/checkin-activity-status");
		expect(requests[1].url).toContain("/v2/billing/meter/daily-checkin");
		const headers = requests[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tok-1");
		expect(headers["User-Agent"]).toBe("ManagerCheckIn/0.1");
		expect(requests[0].init.body).toBe("{}");
	});

	it("状态即返回 code=10001 → ALREADY，不再请求领取", async () => {
		const { fetchImpl, requests } = stubFetch({
			[STATUS_PATH]: JSON.stringify({ code: 10001 }),
		});
		const provider = new WorkBuddyCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ accessToken: "tok" }));

		expect(result.status).toBe("ALREADY");
		expect(result.message).toBe("今日已签到");
		expect(requests).toHaveLength(1);
	});

	it("嵌套信封 checked_in:true → ALREADY（claimed/success 缺席才算已签）", async () => {
		const { fetchImpl } = stubFetch({
			[STATUS_PATH]: JSON.stringify({ data: { checked_in: true, credits: "12" } }),
		});
		const provider = new WorkBuddyCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ accessToken: "tok" }));

		expect(result.status).toBe("ALREADY");
		expect(result.credits).toBe(12);
	});

	it("领取响应 message 含「已签」→ ALREADY", async () => {
		const { fetchImpl } = stubFetch({
			[STATUS_PATH]: JSON.stringify({ code: 1 }),
			[CLAIM_PATH]: JSON.stringify({ code: 500, message: "今天已签到过啦" }),
		});
		const provider = new WorkBuddyCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ accessToken: "tok" }));

		expect(result.status).toBe("ALREADY");
	});

	it("code 404 / 活动未开启 → INACTIVE", async () => {
		const { fetchImpl } = stubFetch({
			[STATUS_PATH]: JSON.stringify({ code: 404, message: "活动不存在" }),
		});
		const provider = new WorkBuddyCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ accessToken: "tok" }));

		expect(result.status).toBe("INACTIVE");
		expect(result.message).toBe("签到活动未开启");
	});

	it("401 → AUTH_ERROR；且 403 只有带鉴权关键字才算鉴权失败", async () => {
		const { fetchImpl } = stubFetch({ [STATUS_PATH]: { status: 401, body: JSON.stringify({ code: 401 }) } });
		const provider = new WorkBuddyCheckInProvider({ fetchImpl });
		const authFailed = await provider.checkIn(makeAccount({ accessToken: "expired" }));
		expect(authFailed.status).toBe("AUTH_ERROR");

		const { fetchImpl: fetch403Plain } = stubFetch({
			[STATUS_PATH]: { status: 200, body: JSON.stringify({ code: 403, message: "其他错误" }) },
		});
		const notAuth = await new WorkBuddyCheckInProvider({ fetchImpl: fetch403Plain }).checkIn(
			makeAccount({ accessToken: "tok" }),
		);
		expect(notAuth.status).toBe("FAILED");

		const { fetchImpl: fetch403Auth } = stubFetch({
			[STATUS_PATH]: { status: 200, body: JSON.stringify({ code: 403, message: "unauthorized token" }) },
		});
		const auth403 = await new WorkBuddyCheckInProvider({ fetchImpl: fetch403Auth }).checkIn(
			makeAccount({ accessToken: "tok" }),
		);
		expect(auth403.status).toBe("AUTH_ERROR");
	});

	it("上游回 HTML（被拦截/token 失效）→ FAILED 且消息说明 HTML", async () => {
		const { fetchImpl } = stubFetch({ [STATUS_PATH]: "<html>captcha</html>" });
		const provider = new WorkBuddyCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ accessToken: "tok" }));

		expect(result.status).toBe("FAILED");
		expect(result.message).toContain("HTML");
	});

	it("领取失败（非成功码）→ FAILED，detail 收原始响应", async () => {
		const { fetchImpl } = stubFetch({
			[STATUS_PATH]: JSON.stringify({ code: 1 }),
			[CLAIM_PATH]: JSON.stringify({ code: 500, message: "系统开小差" }),
		});
		const provider = new WorkBuddyCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ accessToken: "tok" }));

		expect(result.status).toBe("FAILED");
		expect(result.message).toBe("系统开小差");
		expect(result.detail).toContain("系统开小差");
	});

	it("没有可用凭证 → AUTH_ERROR", async () => {
		const { fetchImpl } = stubFetch({});
		const provider = new WorkBuddyCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({}));
		expect(result.status).toBe("AUTH_ERROR");

		// $wbEncrypted 加密信封不处理 → AUTH_ERROR
		const encrypted = await new WorkBuddyCheckInProvider({ fetchImpl }).checkIn(
			makeAccount({ accessToken: "$wbEncrypted:xxx" }),
		);
		expect(encrypted.status).toBe("AUTH_ERROR");
	});
});

describe("readAccessTokenFromFile（authFile 白名单）", () => {
	it("官方文件名可读，嵌套 session.accessToken 兼容；加密信封返回 null", () => {
		const dir = mkdtempSync(join(tmpdir(), "owl-pool-wb-"));
		const file = join(dir, "workbuddy-desktop.info");
		writeFileSync(file, JSON.stringify({ session: { accessToken: "nested-tok" } }));
		expect(readAccessTokenFromFile(file)).toBe("nested-tok");

		writeFileSync(file, JSON.stringify({ accessToken: "$wbEncrypted:abc" }));
		expect(readAccessTokenFromFile(file)).toBeNull();
	});

	it("非官方文件名且不在白名单目录 → 拒绝读取", () => {
		const dir = mkdtempSync(join(tmpdir(), "owl-pool-wb-"));
		const file = join(dir, "secret.txt");
		writeFileSync(file, JSON.stringify({ accessToken: "tok" }));
		expect(() => readAccessTokenFromFile(file)).toThrow(/不被允许/);

		// 配置白名单目录后放行
		expect(readAccessTokenFromFile(file, [dir])).toBe("tok");
	});
});
