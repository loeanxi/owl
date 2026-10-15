import { describe, expect, it, vi } from "vitest";
import { ARENA_CODE_URL, fetchArenaLeaderboard, parseArenaLeaderboard } from "../../src/core/news/arena-leaderboard.ts";

// First three records and Flight wrapper captured from the official page on 2026-10-15.
const snapshot = {
	arenaSlug: "code",
	leaderboardSlug: "overall",
	id: "leaderboard-sets/public/leaderboards/webdev-overall-raw/leaderboard-snapshots/latest",
	voteCutoffISOString: "2026-10-13T13:00:00.000Z",
	totalModels: 3,
	entries: [
		{
			rank: 1,
			modelKey: "claude-opus-5.5-max-vertex-webdev",
			modelDisplayName: "claude-opus-5.5-max",
			rating: 1811.149195823145,
			ratingUpper: 1825.7348714270574,
			ratingLower: 1796.5635202192325,
			votes: 2597,
			modelOrganization: "Anthropic",
			modelUrl: "https://www.anthropic.com/claude-opus-5-5",
			releaseType: null,
		},
		{
			rank: 2,
			modelKey: "gpt-6-astra-max-code-codex-harness",
			modelDisplayName: "gpt-6-astra-max",
			rating: 1780.244235647691,
			ratingUpper: 1790.785451784911,
			ratingLower: 1769.7030195104712,
			votes: 5746,
			modelOrganization: "OpenAI",
			modelUrl: "https://openai.com/index/gpt-6-astra/",
			releaseType: null,
		},
		{
			rank: 3,
			modelKey: "claude-sonnet-5-5-xhigh",
			modelDisplayName: "claude-sonnet-5.5-xhigh",
			rating: 1773.6614538733893,
			ratingUpper: 1787.511572893467,
			ratingLower: 1759.8113348533113,
			votes: 2858,
			modelOrganization: "Anthropic",
			modelUrl: "https://www.anthropic.com/claude-sonnet-5-5",
			releaseType: null,
		},
	],
};

function page(board: unknown = snapshot, date = snapshot.voteCutoffISOString, split = false): string {
	const flight = `40:${JSON.stringify(["$", "$L41", null, { leaderboard: board }])}\n`;
	const chunks = split ? [flight.slice(0, 127), flight.slice(127)] : [flight];
	return `<html><time datetime="${date}">Oct 13, 2026</time>${chunks
		.map((chunk) => `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`)
		.join("")}</html>`;
}

describe("Arena public WebDev snapshot", () => {
	it("reads current models, official ranks, votes and original vote cutoff from real Flight format", () => {
		const result = parseArenaLeaderboard(page());
		expect(result.updatedAt).toBe("2026-10-13T13:00:00.000Z");
		expect(result.entries.map(({ rank, model, score }) => ({ rank, model, score }))).toEqual([
			{ rank: 1, model: "claude-opus-5.5-max", score: 1811.15 },
			{ rank: 2, model: "gpt-6-astra-max", score: 1780.24 },
			{ rank: 3, model: "claude-sonnet-5.5-xhigh", score: 1773.66 },
		]);
		expect(result.entries[0]?.detail).toBe("2,597 票 · 分数区间 1797–1826");
		expect(result.entries[0]?.url).toBe("https://www.anthropic.com/claude-opus-5-5");
	});

	it("joins split data chunks without executing upstream JavaScript", () => {
		const html = `<script>self.__next_f.push((() => {throw new Error('must not run')})())</script>${page(snapshot, undefined, true)}`;
		expect(parseArenaLeaderboard(html).entries).toHaveLength(3);
	});

	it("rejects other categories, missing snapshot dates and truncated data", () => {
		expect(() => parseArenaLeaderboard(page({ ...snapshot, arenaSlug: "text" }))).toThrow("格式已变化");
		expect(() => parseArenaLeaderboard(page(snapshot, "2026-10-15T00:00:00.000Z"))).toThrow("榜单日期");
		expect(() => parseArenaLeaderboard(page({ ...snapshot, totalModels: 143 }))).toThrow("结果不完整");
		expect(() =>
			parseArenaLeaderboard(page({ ...snapshot, entries: [snapshot.entries[0], snapshot.entries[0]] })),
		).toThrow("重复");
	});

	it("preserves preliminary results and discards executable model links", () => {
		const board = {
			...snapshot,
			entries: snapshot.entries.map((entry, index) =>
				index === 0 ? { ...entry, releaseType: "pre_release", modelUrl: "javascript:alert(1)" } : entry,
			),
		};
		const result = parseArenaLeaderboard(page(board));
		expect(result.entries[0]?.detail).toContain("初步结果");
		expect(result.entries[0]?.url).toBeUndefined();
	});

	it("uses the origin when available and labels the reader transport when the origin is blocked", async () => {
		const direct = vi.fn(async () => page());
		expect(await fetchArenaLeaderboard(direct)).toMatchObject({ dataUrl: ARENA_CODE_URL, transport: "direct" });
		expect(direct).toHaveBeenCalledTimes(1);
		const blocked = vi.fn(async (url: string) => {
			if (url === ARENA_CODE_URL) throw new Error("HTTP 403");
			return page();
		});
		expect(await fetchArenaLeaderboard(blocked)).toMatchObject({
			updatedAt: "2026-10-13T13:00:00.000Z",
			dataUrl: `https://r.jina.ai/${ARENA_CODE_URL}`,
			transport: "jina-reader",
		});
		expect(blocked).toHaveBeenLastCalledWith(`https://r.jina.ai/${ARENA_CODE_URL}`, { "X-Return-Format": "html" });
	});

	it("fails if both public transports fail instead of returning a fabricated current ranking", async () => {
		await expect(fetchArenaLeaderboard(async () => "<html>Cloudflare challenge</html>")).rejects.toThrow(
			"格式已变化",
		);
	});
});
