import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface BalanceAccount {
	platform: string;
	credits?: number | string | null;
	creditsLabel?: string | null;
	creditsStatus?: string;
	creditsUpdatedAt?: number;
	creditsUnlimited?: boolean;
	creditBuckets?: Array<Record<string, unknown> | null>;
	lastCheckInCredits?: number;
}

interface BalanceMetric {
	key: string;
	bucketKey: string;
	label: string;
	unit: string;
	resourceType: string;
	source: "scalar" | "bucket";
	kind: "sum" | "range";
	remaining: number | null;
	total: number | null;
	minimum: number | null;
	maximum: number | null;
	count: number;
	unlimitedCount: number;
	unavailableCount: number;
	unknownCount: number;
}

interface PlatformBalance {
	platform: string;
	accountCount: number;
	knownCount: number;
	failedCount: number;
	unknownCount: number;
	unlimitedCount: number;
	unavailableCount: number;
	updatedAt: number | null;
	metrics: BalanceMetric[];
}

interface BalanceApi {
	summarize(accounts: BalanceAccount[]): PlatformBalance[];
}

const browser: { PoolAccountBalances?: BalanceApi } = {};
runInNewContext(readFileSync(new URL("../public/account-balances.js", import.meta.url), "utf8"), { window: browser });
const balances = browser.PoolAccountBalances;
if (balances === undefined) throw new Error("The account balance API was not installed");

describe("account platform balance summaries", () => {
	it("does not classify an unavailable balance capability as a failed or zero balance", () => {
		const result = balances.summarize([{ platform: "MIMO", creditsStatus: "UNAVAILABLE", credits: null }]);
		expect(result[0]).toMatchObject({
			unavailableQueryCount: 1,
			failedCount: 0,
			unknownCount: 0,
			knownCount: 0,
			metrics: [],
		});
	});
	it("combines WorkBuddy cycle balances regardless of the number of packages per account", () => {
		const result = balances.summarize([
			{ platform: "WORKBUDDY", credits: 25962.41, creditsLabel: "CycleRemainCapacity×3" },
			{ platform: "WORKBUDDY", credits: 1599.58, creditsLabel: "CycleRemainCapacity×2" },
		]);
		expect(result[0]?.metrics).toHaveLength(1);
		expect(result[0]?.metrics[0]?.count).toBe(2);
		expect(result[0]?.metrics[0]?.remaining).toBeCloseTo(27561.99, 2);
	});
	it("keeps providers and scalar resource labels separate, with zero as a known balance", () => {
		const result = balances.summarize([
			{ platform: "WORKBUDDY", credits: 15, creditsLabel: "Credits", creditsUpdatedAt: 100 },
			{ platform: "TRAE", credits: 100, creditsLabel: "Credits" },
			{ platform: "WORKBUDDY", credits: "5", creditsLabel: "Credits", creditsUpdatedAt: 200 },
			{ platform: "WORKBUDDY", credits: 0, creditsLabel: "CycleRemaining" },
			{ platform: "WORKBUDDY", credits: null },
		]);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ accountCount: 4, knownCount: 3, unknownCount: 1, updatedAt: 100 });
		expect(result[0]?.metrics).toMatchObject([
			{ label: "Credits", remaining: 20, count: 2, kind: "sum" },
			{ label: "CycleRemaining", remaining: 0, count: 1, kind: "sum" },
		]);
		expect(result[1]?.metrics[0]?.remaining).toBe(100);
	});

	it("uses the oldest valid snapshot in either account order and ignores missing or invalid timestamps", () => {
		const older: BalanceAccount = { platform: "TRAE", credits: 10, creditsUpdatedAt: 100 };
		const newer: BalanceAccount = { platform: "TRAE", credits: 20, creditsUpdatedAt: 200 };
		const undated: BalanceAccount[] = [
			{ platform: "TRAE", credits: 30 },
			{ platform: "TRAE", credits: 40, creditsUpdatedAt: 0 },
			{ platform: "TRAE", credits: 50, creditsUpdatedAt: Number.NaN },
		];
		expect(balances.summarize([newer, ...undated, older])[0]?.updatedAt).toBe(100);
		expect(balances.summarize([older, ...undated, newer])[0]?.updatedAt).toBe(100);
		expect(balances.summarize([newer])[0]?.updatedAt).toBe(200);
		expect(balances.summarize(undated)[0]?.updatedAt).toBeNull();
	});

	it("preserves unknown samples in a partially known pool even when all accounts have another known pool", () => {
		const result = balances.summarize([
			{
				platform: "QODER",
				creditBuckets: [
					{ key: "plan", unit: "Credits", remaining: 30 },
					{ key: "addon", unit: "Credits", remaining: 10 },
				],
			},
			{
				platform: "QODER",
				creditBuckets: [
					{ key: "plan", unit: "Credits", remaining: null },
					{ key: "addon", unit: "Credits", remaining: 20 },
				],
			},
		]);
		expect(result[0]).toMatchObject({ accountCount: 2, knownCount: 2, unknownCount: 0 });
		expect(result[0]?.metrics).toMatchObject([
			{ bucketKey: "plan", remaining: 30, count: 1, unknownCount: 1 },
			{ bucketKey: "addon", remaining: 30, count: 2, unknownCount: 0 },
		]);
	});

	it("excludes failed snapshots, nonfinite balances, subscription probes, and check-in rewards", () => {
		const result = balances.summarize([
			{ platform: "MIMO", credits: null, creditsLabel: "订阅套餐", creditsStatus: "OK" },
			{ platform: "MIMO", credits: Number.NaN, lastCheckInCredits: 500 },
			{ platform: "MIMO", credits: Number.POSITIVE_INFINITY },
			{ platform: "MIMO", credits: "", creditsLabel: "订阅套餐" },
			{ platform: "MIMO", credits: 500, creditsStatus: "FAIL", creditBuckets: [{ key: "plan", remaining: 400 }] },
		]);
		expect(result[0]).toMatchObject({
			accountCount: 5,
			knownCount: 0,
			failedCount: 1,
			unknownCount: 4,
			unlimitedCount: 0,
			metrics: [],
		});
	});

	it("keeps plan, add-on, resource types and units in independent pools", () => {
		const result = balances.summarize([
			{
				platform: "QODER",
				credits: 9999,
				creditBuckets: [
					{ key: "plan", unit: "Credits", remaining: 30, total: 100 },
					{ key: "addon", unit: "Credits", remaining: 10 },
					{ key: "plan", unit: "USD", remaining: 2 },
					{ key: "plan", unit: "Credits", resourceType: "image", remaining: 7 },
				],
			},
			{
				platform: "QODER",
				creditBuckets: [
					{ key: "plan", unit: "Credits", remaining: 20, total: 100 },
					{ key: "addon", unit: "Credits", remaining: 0 },
				],
			},
		]);
		expect(result[0]?.knownCount).toBe(2);
		expect(result[0]?.metrics).toMatchObject([
			{ bucketKey: "plan", unit: "Credits", remaining: 50, total: 200, count: 2 },
			{ bucketKey: "addon", remaining: 10, count: 2, total: null },
			{ bucketKey: "plan", unit: "USD", remaining: 2 },
			{ bucketKey: "plan", resourceType: "image", remaining: 7 },
		]);
	});

	it("reports percentage and time-window ranges without adding accounts' quotas", () => {
		const result = balances.summarize([
			{
				platform: "CODEX",
				creditBuckets: [
					{ key: "primary", unit: "%", remaining: 50, remainingPercent: 50, total: 100 },
					{ key: "secondary", unit: "%", remainingPercent: 0 },
				],
			},
			{
				platform: "CODEX",
				creditBuckets: [
					{ key: "primary", unit: "%", remainingPercent: 80 },
					{ key: "secondary", unit: "%", remainingPercent: 25 },
				],
			},
			{
				platform: "CURSOR",
				creditBuckets: [{ key: "cursor_plan", remaining: 20, unit: "USD", resetsAt: "2026-11-01" }],
			},
			{
				platform: "CURSOR",
				creditBuckets: [{ key: "cursor_plan", remaining: 5, unit: "USD" }],
			},
		]);
		expect(result[0]?.metrics).toMatchObject([
			{ kind: "range", unit: "%", remaining: null, total: null, minimum: 50, maximum: 80, count: 2 },
			{ kind: "range", unit: "%", remaining: null, minimum: 0, maximum: 25 },
		]);
		expect(result[1]?.metrics[0]).toMatchObject({
			kind: "range",
			remaining: null,
			minimum: 5,
			maximum: 20,
			count: 2,
		});
	});

	it("keeps fallback percentages separate from credit amounts", () => {
		const result = balances.summarize([
			{ platform: "COPILOT", creditBuckets: [{ key: "premium", unit: "次", remaining: 50 }] },
			{ platform: "COPILOT", creditBuckets: [{ key: "premium", unit: "次", remainingPercent: 80 }] },
		]);
		expect(result[0]?.metrics).toMatchObject([
			{ unit: "次", kind: "sum", remaining: 50 },
			{ unit: "%", kind: "range", remaining: 80 },
		]);
	});

	it("shows shared organization pools as a range and excludes unavailable buckets", () => {
		const result = balances.summarize([
			{
				platform: "QODER",
				creditBuckets: [
					{ key: "organization", unit: "Credits", remaining: 100 },
					{ key: "addon", unit: "Credits", remaining: 500, unavailable: true },
				],
			},
			{ platform: "QODER", creditBuckets: [{ key: "organization", unit: "Credits", remaining: 100 }] },
			{ platform: "QODER", creditBuckets: [{ key: "addon", unit: "Credits", remaining: 50, unavailable: true }] },
		]);
		expect(result[0]).toMatchObject({ knownCount: 2, unavailableCount: 2, unknownCount: 0 });
		expect(result[0]?.metrics).toMatchObject([
			{ bucketKey: "organization", kind: "range", remaining: null, minimum: 100, maximum: 100, count: 2 },
			{ bucketKey: "addon", remaining: null, count: 0, unavailableCount: 2 },
		]);
	});

	it("tracks unlimited balances independently from finite and unknown balances", () => {
		const result = balances.summarize([
			{ platform: "TRAE", credits: 10, creditsLabel: "Trae Credits" },
			{ platform: "TRAE", credits: 900, creditsLabel: "Trae Credits", creditsUnlimited: true },
			{ platform: "COPILOT", creditBuckets: [{ key: "chat", unit: "次", unlimited: true, remaining: 500 }] },
			{ platform: "COPILOT", creditBuckets: [{ key: "premium", unit: "次", remaining: null }] },
		]);
		expect(result[0]).toMatchObject({ knownCount: 1, unlimitedCount: 1, unknownCount: 0 });
		expect(result[0]?.metrics[0]).toMatchObject({ remaining: 10, count: 1, unlimitedCount: 1 });
		expect(result[1]).toMatchObject({ knownCount: 0, unlimitedCount: 1, unknownCount: 1 });
		expect(result[1]?.metrics[0]).toMatchObject({ remaining: null, count: 0, unlimitedCount: 1 });
	});

	it("derives a finite balance only when both total and used are known, without mutating input", () => {
		const input: BalanceAccount[] = [
			{
				platform: "QODER",
				creditBuckets: [
					{ key: "plan", unit: "Credits", total: 100, used: 100 },
					{ key: "addon", unit: "Credits", total: 500 },
					null,
				],
			},
		];
		const before = structuredClone(input);
		const result = balances.summarize(input);
		expect(result[0]?.knownCount).toBe(1);
		expect(result[0]?.metrics).toMatchObject([
			{ bucketKey: "plan", remaining: 0, count: 1 },
			{ bucketKey: "addon", remaining: null, count: 0, unknownCount: 1 },
		]);
		expect(input).toEqual(before);
	});
});
