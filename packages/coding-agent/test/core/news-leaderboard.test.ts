import { afterEach, describe, expect, it, vi } from "vitest";
import {
	leaderboardFreshness,
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
const currentMap = {
	sources: ["lib/constants.js", "Table/modelLinks.js"],
	sourcesContent: [
		'export const RELEASES = ["2026-09-02"]; const RELEASE_LABELS = {"2026-09-02":"2026-10-14"};',
		metadata,
	],
};
const arenaDate = "2026-10-13T13:00:00.000Z";
const arenaData = {
	arenaSlug: "code",
	leaderboardSlug: "overall",
	id: "snapshots/webdev-overall-current",
	voteCutoffISOString: arenaDate,
	totalModels: 1,
	entries: [
		{
			modelKey: "current-coder",
			modelDisplayName: "Current Coder",
			rating: 1800,
			ratingUpper: 1810,
			ratingLower: 1790,
			rank: 1,
			votes: 500,
		},
	],
};
const arenaHtml = `<time datetime="${arenaDate}"></time><script>self.__next_f.push(${JSON.stringify([1, `a:${JSON.stringify(["$", "$L", null, { leaderboard: arenaData }])}\n`])})</script>`;
const aaHtml =
	"<table><thead><tr><th>Model</th><th>Creator</th><th>Artificial Analysis Intelligence Index</th></tr></thead><tbody><tr><td>Current Reasoner</td><td>Example</td><td>58</td></tr></tbody></table>";

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
		if (url === "https://livebench.ai/") return new Response('<script src="/static/js/main.current.js"></script>');
		if (url.endsWith("main.current.js.map")) return Response.json(currentMap);
		if (url.includes("table_2026_09_02.csv")) return new Response(csv);
		if (url.includes("categories_2026_09_02.json")) return Response.json(categories);
		if (url === "https://arena.ai/leaderboard/code/webdev") return new Response(arenaHtml);
		if (url === "https://artificialanalysis.ai/leaderboards/models") return new Response(aaHtml);
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
	it("does not present a freshly downloaded old benchmark as current model rankings", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const { service } = setup();
		const result = await service.get();
		const historical = result.boards.find((board) => board.id === "swe-bench-verified");
		expect(historical).toMatchObject({ reference: true, stale: false, freshness: { state: "outdated" } });
		expect(historical?.freshness?.ageDays).toBeGreaterThan(200);
		expect(result.boards.filter((board) => !board.reference).map((board) => board.id)).toEqual([
			"livebench-overall",
			"arena-code",
			"artificial-analysis",
		]);
		expect(result.boards[0]).toMatchObject({ updatedAt: "2026-10-14", freshness: { state: "current" } });
		expect(result.boards[2]).toMatchObject({ updatedAt: null, freshness: { state: "unknown" } });
	});
	it("does not mistake missing or future source dates for a fresh assessment", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		expect(leaderboardFreshness(null).state).toBe("unknown");
		expect(leaderboardFreshness("invalid").state).toBe("unknown");
		expect(leaderboardFreshness("2027-01-01").state).toBe("unknown");
	});
	it("discovers the latest release, fetches without credentials, and serves persistent cache", async () => {
		const { store, service, fetch, options } = setup();
		const result = await service.get();
		expect(result.refreshIntervalMinutes).toBe(30);
		expect(result.boards.map((board) => board.entries.length)).toEqual([3, 1, 1, 1]);
		expect(result.boards[0]).toMatchObject({ updatedAt: "2026-10-14", stale: false, error: null });
		expect(result.boards[0]?.checkedAt).toBeTruthy();
		expect(fetch).toHaveBeenCalledTimes(7);
		for (const [, init] of fetch.mock.calls) {
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
			expect(new Headers(init?.headers).has("cookie")).toBe(false);
		}
		const reopened = new NewsLeaderboardService(store, options);
		expect(await reopened.get()).toEqual(result);
		expect(fetch).toHaveBeenCalledTimes(7);
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
		expect(fetch).toHaveBeenCalledTimes(7);
		expect(first.boards[0]?.entries).toHaveLength(3);
		expect(first.boards.find((board) => board.id === "swe-bench-verified")).toMatchObject({
			stale: true,
			checkedAt: null,
			entries: [],
			error: "信源返回 HTTP 503",
		});
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
		const callsAfterFailure = fetch.mock.calls.length;
		await service.get();
		expect(fetch).toHaveBeenCalledTimes(callsAfterFailure);
		vi.setSystemTime(new Date("2026-10-15T01:03:00Z"));
		await service.get();
		expect(fetch.mock.calls.length).toBeGreaterThan(callsAfterFailure);
	});

	it("supports explicit refresh during cache TTL and never replaces good rows with broken source data", async () => {
		const { service, fetch } = setup();
		const first = await service.get();
		const original = fetch.getMockImplementation()!;
		fetch.mockImplementation(async (input, init) =>
			String(input).endsWith("leaderboards.json") ? Response.json({ leaderboards: [] }) : original(input, init),
		);
		const next = await service.get(true);
		expect(fetch).toHaveBeenCalledTimes(14);
		expect(next.boards[3]?.entries).toEqual(first.boards[3]?.entries);
		expect(next.boards[3]?.stale).toBe(true);
		expect(next.boards[0]?.stale).toBe(false);
	});
	it("discards v1 source cache and recomputes freshness even when using a fresh local cache", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const { service, store, options, fetch } = setup();
		store.saveResponseCache("news-leaderboard:v1:livebench-overall", {
			board: { id: "livebench-overall", entries: [{ id: "archived", model: "Archived model", score: 99 }] },
			attemptedAt: new Date().toISOString(),
		});
		const first = await service.get();
		expect(first.boards[0]?.entries.some((entry) => entry.model === "Archived model")).toBe(false);
		expect(first.boards[1]?.entries[0]?.score).toBe(1800);
		const cached = new NewsLeaderboardService(store, options);
		const before = fetch.mock.calls.length;
		expect((await cached.get()).boards[1]?.entries[0]?.score).toBe(1800);
		expect(fetch.mock.calls.length).toBe(before);
	});
});
