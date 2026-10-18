import { InMemoryAccountStore, UpstreamException } from "owl-pool";
import { describe, expect, it } from "vitest";
import { WorkBuddyTokenService } from "../src/account/workbuddy-refresh.ts";

function service(fetchImpl: typeof fetch, accounts = new InMemoryAccountStore()) {
	const created = accounts.create(
		{
			name: "wb",
			platform: "WORKBUDDY",
			credentials: { accessToken: "old-access", refreshToken: "old-refresh", domain: "www.workbuddy.cn" },
			enabled: true,
		},
		1_000,
	);
	const tokens = new WorkBuddyTokenService({
		accounts,
		baseUrl: "https://www.workbuddy.cn",
		userAgent: "CLI/test",
		origin: "https://www.codebuddy.cn",
		referer: "https://www.codebuddy.cn/",
		fetchImpl,
		now: () => 2_000,
	});
	return { accounts, tokens, created };
}

describe("WorkBuddyTokenService", () => {
	it("用 refreshToken 换新 accessToken 并写回账号", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
			calls.push({ url: String(input), headers: new Headers(init?.headers) });
			return new Response(
				JSON.stringify({
					code: 0,
					data: {
						accessToken: "new-access",
						refreshToken: "new-refresh",
						expiresIn: 3600,
						domain: "www.workbuddy.cn",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;
		const { accounts, tokens, created } = service(fetchImpl);
		await expect(tokens.refresh(created)).resolves.toBe("new-access");
		expect(calls[0]?.url).toBe("https://www.workbuddy.cn/v2/auth/token/refresh");
		expect(calls[0]?.headers.get("X-Refresh-Token")).toBe("old-refresh");
		expect(calls[0]?.headers.get("X-Domain")).toBe("www.workbuddy.cn");
		const saved = accounts.require(created.id);
		expect(saved.credentials.accessToken).toBe("new-access");
		expect(saved.credentials.refreshToken).toBe("new-refresh");
		expect(saved.credentialExpiresAt).toBe(2_000 + 3_600_000);
	});

	it("没有 refreshToken 时拒绝续期", async () => {
		const accounts = new InMemoryAccountStore();
		const created = accounts.create(
			{ name: "wb", platform: "WORKBUDDY", credentials: { accessToken: "only" }, enabled: true },
			1_000,
		);
		const tokens = new WorkBuddyTokenService({
			accounts,
			baseUrl: "https://www.workbuddy.cn",
			userAgent: "CLI/test",
			origin: "https://www.codebuddy.cn",
			referer: "https://www.codebuddy.cn/",
			fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
		});
		await expect(tokens.refresh(created)).rejects.toBeInstanceOf(UpstreamException);
	});
});
