import { type Account, InMemoryAccountStore } from "owl-pool";
import { describe, expect, it, vi } from "vitest";
import { copilotQuota, cursorQuota, refreshCredit } from "../src/account/credits.ts";

describe("account quota semantics", () => {
	it("shows Cursor's authoritative percentage quota separately from its explicit zero numeric balance", () => {
		const snapshot = cursorQuota({
			source: "CURSOR_USAGE_SUMMARY",
			sdkAuthenticated: true,
			plan: { used: 2000, limit: 2000, remaining: 0, totalPercentUsed: 67.06341463414634 },
		});
		expect(snapshot.buckets.find((bucket) => bucket.key === "cursor_plan")?.remaining).toBe(0);
		expect(snapshot.buckets.find((bucket) => bucket.key === "cursor_total_percent")?.remaining).toBeCloseTo(
			32.93658536585366,
			6,
		);
		expect(snapshot.authAccepted).toBe(true);
	});
	it("keeps a valid SDK identity healthy when the quota web session belongs to another account", () => {
		const snapshot = cursorQuota({
			source: "CURSOR_DASHBOARD_ONLY",
			sdkAuthenticated: true,
			quotaReason: "ACCOUNT_MISMATCH",
		});
		expect(snapshot).toMatchObject({
			ok: false,
			availability: "UNAVAILABLE",
			authAccepted: true,
			credits: null,
			buckets: [],
		});
		expect(snapshot.label).toBe("CURSOR_ACCOUNT_MISMATCH");
	});
	it("keeps Cursor's explicit zero balance instead of turning bonus statistics into remaining credit", () => {
		const snapshot = cursorQuota({
			source: "CURSOR_USAGE_SUMMARY",
			credentialSource: "LOCAL_DESKTOP",
			membershipType: "pro",
			plan: {
				used: 2000,
				limit: 2000,
				remaining: 0,
				totalPercentUsed: 67.0634,
				breakdown: { included: 2000, bonus: 28933, total: 30933 },
			},
			onDemand: { enabled: false },
		});
		expect(snapshot.buckets[0]?.remaining).toBe(0);
		expect(snapshot.buckets[0]?.total).toBe(2000);
		expect(snapshot.message).toContain("本机 Cursor");
	});
	it("does not invent a USD unit for Cursor amounts that have no declared unit", () => {
		const snapshot = cursorQuota({
			source: "CURSOR_USAGE_SUMMARY",
			plan: { remaining: 0 },
			onDemand: { enabled: true, used: 100, limit: 200, remaining: 80 },
		});
		expect(snapshot.buckets[1]).toMatchObject({ remaining: 80, unit: "" });
	});
	it("records Copilot's authenticated source and reset date without collapsing its request pools", () => {
		const snapshot = copilotQuota({
			authenticated: true,
			credentialSource: "LOCAL_GH",
			accountLogin: "sample-user",
			resetDate: "2026-11-01T00:00:00Z",
			quotaSnapshots: {
				premium_interactions: { entitlementRequests: 7000, usedRequests: 5180, remainingPercentage: 26 },
				chat: { isUnlimitedEntitlement: true },
			},
		});
		expect(snapshot.authAccepted).toBe(true);
		expect(snapshot.message).toContain("sample-user");
		expect(snapshot.buckets[0]).toMatchObject({
			remaining: 1820,
			remainingPercent: 26,
			resetsAt: "2026-11-01T00:00:00Z",
		});
		expect(snapshot.buckets[1]?.unlimited).toBe(true);
	});
	it("persists MiMo's unsupported balance capability without pinging, inventing zero or changing login health", async () => {
		const store = new InMemoryAccountStore();
		const account = store.create({ name: "MiMo sample", platform: "MIMO", credentials: {} }, 0);
		store.patchState(account.id, { credentialStatus: "OK" });
		const ping = vi.fn(async (_account: Account) => "connected");
		const updated = await refreshCredit(store, store.require(account.id), {
			workbuddyBaseUrl: "https://unused.invalid",
			workbuddyAuthRoots: [],
			exchangeTraeToken: async () => "unused",
			mimoPing: ping,
		});
		expect(updated).toMatchObject({
			creditsStatus: "UNAVAILABLE",
			credits: null,
			creditsDetails: null,
			credentialStatus: "OK",
		});
		expect(ping).not.toHaveBeenCalled();
	});
});
