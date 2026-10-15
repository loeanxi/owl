import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NewsLeaderboardService,
	parseLiveBenchLeaderboard,
	parseSweBenchLeaderboard,
} from "../../src/core/news/leaderboard.ts";

const metadata = `export const modelLinks = {
    "alpha": { displayName: "Alpha", organization: "Example", url: "https://example.com/alpha" },
    "beta": {
        displayName: "Beta", organization: "Example",
        variants: [ { rawName: "beta-high", displayName: "Beta High" } ]
    },
    "gamma": { displayName: "Gamma", url: "javascript:alert(1)" },
    "tuned": { displayName: "Tuned", finetune: { baseKey: "alpha" } },
};`;
const categories = { Reasoning: ["logic_a", "logic_b"], Coding: ["code"] };
const csv = "model,logic_a,logic_b,code\nalpha,100,100,40\nbeta-high,70,70,70\ngamma,0,0,100\n";
const swe = {
	leaderboards: [
		{
			name: "Verified",
			results: [
				{
					folder: "verified-alpha",
					model_display: "Alpha",
					model_org: "Example",
					resolved: 76.8,
					agent: "mini-SWE-agent",
					reasoning_effort: "high",
					date: "2026-02-17",
					"mini-swe-agent_version": "2.0.0",
					site: "https://example.com/alpha",
				},
			],
		},
	],
};

function setup() {
	const cache = new Map<string, unknown>();
	const store = {
		cachedResponse: (key: string): unknown => structuredClone(cache.get(key) ?? null),
		saveResponseCache: (key: string, value: unknown): void => {
			cache.set(key, structuredClone(value));
		},
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
		const url = String(input);
		if (url.endsWith("leaderboards.json")) return Response.json(swe);
		if (url.endsWith("constants.js")) return new Response('export const RELEASES = ["2025-04-02", "2026-06-25"];');
		if (url.endsWith("table_2026_06_25.csv")) return new Response(csv);
		if (url.endsWith("categories_2026_06_25.json")) return Response.json(categories);
		if (url.endsWith("modelLinks.js")) return new Response(metadata);
		return new Response("Not found", { status: 404 });
	});
	const options = { fetch, resolveHost: async () => ["8.8.8.8"] };
	return { store, fetch, options, service: new NewsLeaderboardService(store, options) };
}

afterEach(() => vi.useRealTimers());

describe("public model leaderboard parsing", () => {
	it("uses category-weighted scores, preserves effort variants, and shares rank on ties", () => {
		const entries = parseLiveBenchLeaderboard(csv, categories, metadata);
		expect(entries.map(({ model, rank, score }) => ({ model, rank, score }))).toEqual([
			{ model: "Alpha", rank: 1, score: 70 },
			{ model: "Beta High", rank: 1, score: 70 },
			{ model: "Gamma", rank: 3, score: 50 },
		]);
		expect(entries[2]?.url).toBeUndefined();
	});

	it("handles CSV quoting, skips unknown/fine-tuned models and excludes incomplete categories", () => {
		const input = [
			"\uFEFFmodel,logic_a,logic_b,code",
			'"alpha",100,100,40',
			"beta-high,,,90",
			"unknown,100,100,100",
			"tuned,100,100,100",
			"gamma,0,0,0",
		].join("\r\n");
		expect(parseLiveBenchLeaderboard(input, categories, metadata).map((entry) => entry.id)).toEqual([
			"alpha",
			"gamma",
		]);
	});

	it("rejects mismatched releases and invalid data instead of manufacturing zero scores", () => {
		expect(() => parseLiveBenchLeaderboard(csv, { Reasoning: ["missing"] }, metadata)).toThrow("缺少评测子任务");
		expect(() => parseLiveBenchLeaderboard('model,logic_a,logic_b,code\n"alpha,10', categories, metadata)).toThrow(
			"内容不完整",
		);
		expect(() => parseLiveBenchLeaderboard("model,logic_a,logic_b,code\nalpha,,,", categories, metadata)).toThrow(
			"暂无完整",
		);
		expect(() => parseLiveBenchLeaderboard(csv, categories, "throw new Error('do not run')")).toThrow("格式已变化");
	});

	it("compares only mini-SWE-agent runs and retains source evaluation dates", () => {
		const original = swe.leaderboards[0]!.results[0]!;
		const parsed = parseSweBenchLeaderboard({
			leaderboards: [
				{
					name: "Verified",
					results: [
						original,
						{ ...original, folder: "different-agent", agent: "Different agent", resolved: 99 },
						{ ...original, folder: "warned", warning: "Invalid run", resolved: 100 },
						{ ...original, folder: "invalid-score", resolved: null },
						{ ...original, folder: "beta", model_display: "Beta", resolved: 80, date: "2026-04-01" },
					],
				},
			],
		});
		expect(parsed.updatedAt).toBe("2026-04-01");
		expect(parsed.entries.map(({ model, score }) => ({ model, score }))).toEqual([
			{ model: "Beta (high)", score: 80 },
			{ model: "Alpha (high)", score: 76.8 },
		]);
		expect(parsed.entries[1]?.detail).toBe("mini-SWE-agent 2.0.0 · 2026-02-17");
		expect(() => parseSweBenchLeaderboard({ leaderboards: [] })).toThrow("未提供 Verified");
	});
});

describe("public model leaderboard lifecycle", () => {
	it("discovers the latest release, fetches without credentials, and serves persistent cache", async () => {
		const { store, service, fetch, options } = setup();
		const result = await service.get();
		expect(result.refreshIntervalMinutes).toBe(30);
		expect(result.boards.map((board) => board.entries.length)).toEqual([3, 1]);
		expect(result.boards[0]).toMatchObject({ updatedAt: "2026-06-25", stale: false, error: null });
		expect(result.boards[0]?.checkedAt).toBeTruthy();
		expect(fetch).toHaveBeenCalledTimes(5);
		for (const [, init] of fetch.mock.calls) {
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
			expect(new Headers(init?.headers).has("cookie")).toBe(false);
		}
		const reopened = new NewsLeaderboardService(store, options);
		expect(await reopened.get()).toEqual(result);
		expect(fetch).toHaveBeenCalledTimes(5);
	});

	it("shares concurrent refresh work and keeps one source working when the other fails", async () => {
		const { service, fetch } = setup();
		const original = fetch.getMockImplementation()!;
		fetch.mockImplementation(async (input, init) =>
			String(input).endsWith("leaderboards.json")
				? new Response("unavailable", { status: 503 })
				: original(input, init),
		);
		const [first, second] = await Promise.all([service.get(), service.get(true)]);
		expect(first).toEqual(second);
		expect(fetch).toHaveBeenCalledTimes(5);
		expect(first.boards[0]?.entries).toHaveLength(3);
		expect(first.boards[1]).toMatchObject({ stale: true, checkedAt: null, entries: [], error: "信源返回 HTTP 503" });
	});

	it("retains last successful entries and timestamp on refresh failure and bounds retry frequency", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const { service, fetch } = setup();
		const success = await service.get();
		vi.setSystemTime(new Date("2026-10-15T01:00:00Z"));
		fetch.mockRejectedValue(new Error("offline"));
		const failed = await service.get();
		for (const [index, board] of failed.boards.entries()) {
			expect(board.entries).toEqual(success.boards[index]?.entries);
			expect(board.checkedAt).toBe(success.boards[index]?.checkedAt);
			expect(board.stale).toBe(true);
			expect(board.error).toBe("offline");
		}
		expect(fetch).toHaveBeenCalledTimes(7);
		await service.get();
		expect(fetch).toHaveBeenCalledTimes(7);
		vi.setSystemTime(new Date("2026-10-15T01:03:00Z"));
		await service.get();
		expect(fetch).toHaveBeenCalledTimes(9);
	});

	it("supports explicit refresh during cache TTL and never replaces good rows with broken source data", async () => {
		const { service, fetch } = setup();
		const first = await service.get();
		const original = fetch.getMockImplementation()!;
		fetch.mockImplementation(async (input, init) =>
			String(input).endsWith("leaderboards.json") ? Response.json({ leaderboards: [] }) : original(input, init),
		);
		const next = await service.get(true);
		expect(fetch).toHaveBeenCalledTimes(10);
		expect(next.boards[1]?.entries).toEqual(first.boards[1]?.entries);
		expect(next.boards[1]?.stale).toBe(true);
		expect(next.boards[0]?.stale).toBe(false);
	});
});
