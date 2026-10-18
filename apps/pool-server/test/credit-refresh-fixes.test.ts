import { type Account, InMemoryAccountStore, sha256Hex, UpstreamException } from "owl-pool";
import { describe, expect, it } from "vitest";
import { type CreditHooks, query, refreshCredit } from "../src/account/credits.ts";
import { type PingHooks, pingAccount } from "../src/account/ping.ts";

function account(platform: Account["platform"], credentials: Record<string, unknown>, id = "acct-1"): Account {
	return { id, name: id, platform, credentials, enabled: true, createdAt: 0, updatedAt: 0 };
}

function hooks(fetchImpl: typeof fetch, extra: Partial<CreditHooks> = {}): CreditHooks {
	return {
		fetchImpl,
		workbuddyBaseUrl: "https://www.workbuddy.cn",
		workbuddyAuthRoots: [],
		exchangeTraeToken: async () => "jwt",
		...extra,
	};
}

describe("credit refresh fixes", () => {
	it("renews a WorkBuddy login ticket when the quota API rejects it with a JSON body", async () => {
		const seen: string[] = [];
		let attempts = 0;
		const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("authorization") ?? "");
			attempts += 1;
			if (attempts === 1) {
				return Response.json({ code: 401, msg: "unauthorized" }, { status: 401 });
			}
			return Response.json({ code: 0, data: { Packages: [{ CycleRemainCapacity: 12 }] } });
		}) as typeof fetch;
		const snapshot = await query(
			account("WORKBUDDY", { accessToken: "old-access", refreshToken: "old-refresh" }),
			hooks(fetchImpl, { refreshWorkBuddy: async () => "new-access" }),
		);
		expect(snapshot.ok).toBe(true);
		expect(snapshot.credits).toBe(12);
		expect(seen).toContain("Bearer new-access");
	});

	it("keeps the same Trae device id across quota checks and matches the chat derivation", async () => {
		const devices: string[] = [];
		const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
			devices.push(new Headers(init?.headers).get("x-device-id") ?? "");
			return Response.json({
				code: 0,
				user_entitlement_pack_list: [
					{ entitlement_base_info: { quota: { credits_limit: 10 } }, usage: { credits_amount: 1 } },
				],
			});
		}) as typeof fetch;
		const current = account("TRAE", { session: "sess" }, "trae-acct");
		await query(current, hooks(fetchImpl));
		await query(current, hooks(fetchImpl));
		const hash = sha256Hex("trae-device:trae-acct");
		const expected = ((BigInt(`0x${hash}`) % BigInt("9000000000000000")) + BigInt("1000000000000000")).toString();
		expect(devices).toEqual([expected, expected]);
	});

	it("marks a Claude credential expired when the quota API rejects the login", async () => {
		const snapshot = await query(
			account("CLAUDE", { authType: "oauth", accessToken: "expired" }),
			hooks((async () => new Response("{}")) as typeof fetch, {
				claudeUsage: async () => {
					throw new UpstreamException("AUTH", "Claude 登录已失效");
				},
			}),
		);
		expect(snapshot.ok).toBe(false);
		expect(snapshot.authRejected).toBe(true);
		expect(snapshot.message).toBe("Claude 登录已失效");
	});

	it("uses a stored Trae device id instead of deriving one", async () => {
		let device = "";
		const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
			device = new Headers(init?.headers).get("x-device-id") ?? "";
			return Response.json({
				code: 0,
				user_entitlement_pack_list: [
					{ entitlement_base_info: { quota: { credits_limit: 10 } }, usage: { credits_amount: 1 } },
				],
			});
		}) as typeof fetch;
		await query(account("TRAE", { session: "sess", deviceId: "1234567890123456" }), hooks(fetchImpl));
		expect(device).toBe("1234567890123456");
	});

	it("marks a WorkBuddy credential expired when refresh is rejected", async () => {
		const fetchImpl = (async () =>
			Response.json({ code: 401, msg: "unauthorized" }, { status: 200 })) as typeof fetch;
		const snapshot = await query(
			account("WORKBUDDY", { accessToken: "old-access", refreshToken: "dead" }),
			hooks(fetchImpl, {
				refreshWorkBuddy: async () => {
					throw new UpstreamException("AUTH", "WorkBuddy refreshToken 已失效");
				},
			}),
		);
		expect(snapshot.ok).toBe(false);
		expect(snapshot.authRejected).toBe(true);
		expect(snapshot.message).toBe("WorkBuddy refreshToken 已失效");
	});

	it("marks a WorkBuddy credential expired when the renewed ticket is still rejected", async () => {
		const fetchImpl = (async () =>
			Response.json({ code: 401, msg: "unauthorized" }, { status: 200 })) as typeof fetch;
		const snapshot = await query(
			account("WORKBUDDY", { accessToken: "old-access", refreshToken: "rotating" }),
			hooks(fetchImpl, { refreshWorkBuddy: async () => "still-bad" }),
		);
		expect(snapshot.authRejected).toBe(true);
		expect(snapshot.message).toContain("HTTP 401");
	});

	it("keeps stored credit expiry when the WorkBuddy detail request fails", async () => {
		const accounts = new InMemoryAccountStore();
		const created = accounts.create(
			{
				name: "wb",
				platform: "WORKBUDDY",
				credentials: { accessToken: "ticket" },
				enabled: true,
			},
			0,
		);
		const stored = JSON.stringify([{ at: 1_900_000_000_000, remaining: 12 }]);
		accounts.patchState(created.id, { creditsExpiry: stored });
		const fetchImpl = (async (input: string | URL) => {
			const url = String(input);
			if (url.includes("get-user-resource-summary")) {
				return Response.json({ code: 0, data: { Packages: [{ CycleRemainCapacity: 12 }] } });
			}
			return new Response("<html>bad gateway</html>", { status: 502 });
		}) as typeof fetch;
		const updated = await refreshCredit(accounts, accounts.require(created.id), hooks(fetchImpl));
		expect(updated.credits).toBe(12);
		expect(updated.creditsExpiry).toBe(stored);
	});

	it("includes the HTTP status when a Trae usage response is not JSON", async () => {
		const fetchImpl = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
		const snapshot = await query(account("TRAE", { session: "sess" }), hooks(fetchImpl));
		expect(snapshot.ok).toBe(false);
		expect(snapshot.message).toContain("HTTP 502");
		expect(snapshot.message).not.toContain("SyntaxError");
	});

	it("renews a WorkBuddy login ticket when the ping body says 401", async () => {
		const seen: string[] = [];
		let attempts = 0;
		const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("authorization") ?? "");
			attempts += 1;
			if (attempts === 1) {
				return Response.json({ code: 401, msg: "unauthorized" }, { status: 200 });
			}
			return Response.json({ code: 0, msg: "ok" });
		}) as typeof fetch;
		const pingHooks: PingHooks = {
			fetchImpl,
			workbuddyBaseUrl: "https://www.workbuddy.cn",
			workbuddyAuthRoots: [],
			exchangeTraeToken: async () => "jwt",
			refreshWorkBuddy: async () => "new-access",
		};
		const result = await pingAccount(
			account("WORKBUDDY", { accessToken: "old-access", refreshToken: "old-refresh" }),
			pingHooks,
		);
		expect(result.ok).toBe(true);
		expect(seen).toEqual(["Bearer old-access", "Bearer new-access"]);
	});
});
