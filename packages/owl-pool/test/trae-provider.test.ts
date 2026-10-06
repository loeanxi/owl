import { describe, expect, it } from "vitest";
import type { Account } from "../src/account/types.ts";
import { TraeCheckInProvider } from "../src/checkin/providers/trae.ts";

function makeAccount(credentials: Record<string, unknown>): Account {
	return {
		id: "acc-trae",
		name: "Trae 测试号",
		platform: "TRAE",
		credentials,
		enabled: true,
		createdAt: 0,
		updatedAt: 0,
	};
}

const TOKEN_URL_PART = "GetUserToken";
const CLAIM_URL_PART = "checkin_credits/claim";

interface ClaimCall {
	deviceId: string;
}

/** Trae 上游桩：token 端点固定发 JWT，claim 端点按脚本逐次返回。 */
function traeStub(
	claimScript: Array<Record<string, unknown>>,
	tokenBody = JSON.stringify({ Result: { Token: "jwt-1" } }),
	tokenStatus = 200,
): {
	fetchImpl: typeof fetch;
	claimCalls: ClaimCall[];
	requestUrls: string[];
} {
	const claimCalls: ClaimCall[] = [];
	const requestUrls: string[] = [];
	let claimIndex = 0;
	const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		requestUrls.push(url);
		const headers = new Headers(init?.headers);
		if (url.includes(TOKEN_URL_PART)) {
			return new Response(tokenBody, { status: tokenStatus });
		}
		if (url.includes(CLAIM_URL_PART)) {
			claimCalls.push({ deviceId: String(headers.get("x-device-id")) });
			const script = claimScript[Math.min(claimIndex, claimScript.length - 1)];
			claimIndex++;
			return new Response(JSON.stringify(script), { status: 200 });
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	return { fetchImpl, claimCalls, requestUrls };
}

function noSleep(): { sleepImpl: (ms: number) => Promise<void>; sleeps: number[] } {
	const sleeps: number[] = [];
	return {
		sleepImpl: async (ms: number) => {
			sleeps.push(ms);
		},
		sleeps,
	};
}

describe("TraeCheckInProvider", () => {
	it("换 token → 领取成功（code 0 + credits）", async () => {
		const { fetchImpl, claimCalls, requestUrls } = traeStub([{ code: 0, credits: 30, message: "签到成功" }]);
		const provider = new TraeCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ session: "sess-1", deviceId: "1234567890123456" }));

		expect(result.status).toBe("SUCCESS");
		expect(result.credits).toBe(30);
		expect(requestUrls[0]).toContain("/cloudide/api/v3/common/GetUserToken");
		expect(requestUrls[1]).toContain("/trae/api/v2/ug/checkin_credits/claim");
		// 凭证里的 deviceId 优先，不轮换
		expect(claimCalls[0]?.deviceId).toBe("1234567890123456");
	});

	it("checked_in:true 且 credits 为 0 且 code 非 0 → ALREADY", async () => {
		const { fetchImpl } = traeStub([{ code: 200, checked_in: true, credits: 0 }]);
		const provider = new TraeCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ session: "sess-1" }));

		expect(result.status).toBe("ALREADY");
		expect(result.message).toBe("今日已签到");
	});

	it("code=0 优先于 already 分支 → SUCCESS", async () => {
		const { fetchImpl } = traeStub([{ code: 0, checked_in: true, credits: 8 }]);
		const provider = new TraeCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ session: "sess-1" }));
		expect(result.status).toBe("SUCCESS");
		expect(result.credits).toBe(8);
	});

	it("命中 9074 换设备号重试，成功后带 _deviceIdUsed；退避在 [800,1500)", async () => {
		const { fetchImpl, claimCalls } = traeStub([{ code: 9074 }, { code: "9074" }, { code: 0, credits: 5 }]);
		const { sleepImpl, sleeps } = noSleep();
		const fixedDevices = ["9000000000000001", "9000000000000002", "9000000000000003"];
		let deviceCursor = 0;
		const provider = new TraeCheckInProvider({
			fetchImpl,
			sleepImpl,
			randomDeviceIdImpl: () => fixedDevices[deviceCursor++ % fixedDevices.length]!,
		});
		const result = await provider.checkIn(makeAccount({ session: "sess-1" }));

		expect(result.status).toBe("SUCCESS");
		expect(claimCalls).toHaveLength(3);
		// 首次用随机设备号（凭证未带），9074 后轮换且不重复
		expect(claimCalls[0]?.deviceId).toBe(fixedDevices[0]);
		expect(claimCalls[1]?.deviceId).toBe(fixedDevices[1]);
		expect(claimCalls[2]?.deviceId).toBe(fixedDevices[2]);
		expect(sleeps).toHaveLength(2);
		for (const ms of sleeps) {
			expect(ms).toBeGreaterThanOrEqual(800);
			expect(ms).toBeLessThan(1500);
		}
	});

	it("重试上限内一直 9074 → FAILED 提示风控", async () => {
		const { fetchImpl, claimCalls } = traeStub([{ code: 9074 }]);
		const provider = new TraeCheckInProvider({
			fetchImpl,
			sleepImpl: async () => {},
			randomDeviceIdImpl: () => "8888888888888888",
		});
		const result = await provider.checkIn(makeAccount({ session: "sess-1" }));

		expect(result.status).toBe("FAILED");
		expect(result.message).toContain("9074");
		expect(claimCalls).toHaveLength(5);
	});

	it("缺少 session → AUTH_ERROR", async () => {
		const { fetchImpl } = traeStub([]);
		const provider = new TraeCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({}));
		expect(result.status).toBe("AUTH_ERROR");
		expect(result.message).toContain("session");
	});

	it("换 token 401/403 → AUTH_ERROR 提示重新登录", async () => {
		const { fetchImpl } = traeStub([], "{}", 401);
		const provider = new TraeCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ session: "expired" }));
		expect(result.status).toBe("AUTH_ERROR");
		expect(result.message).toContain("重新登录");
	});

	it("GetUserToken 无 Token → FAILED", async () => {
		const { fetchImpl } = traeStub([], JSON.stringify({ Result: {} }));
		const provider = new TraeCheckInProvider({ fetchImpl });
		const result = await provider.checkIn(makeAccount({ session: "sess-1" }));
		expect(result.status).toBe("FAILED");
		expect(result.message).toContain("GetUserToken");
	});
});
