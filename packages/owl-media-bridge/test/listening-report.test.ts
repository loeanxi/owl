import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ListeningEntry } from "../src/listening-memory.ts";
import { buildListeningReport, SkipLedger } from "../src/listening-report.ts";

function entry(overrides: Partial<ListeningEntry> & { startedAt: number }): ListeningEntry {
	return {
		id: `t${overrides.startedAt}`,
		playerId: "qq-music",
		playerName: "QQ 音乐",
		title: "晴天",
		artist: "周杰伦",
		playedSeconds: 200,
		lastPlayedAt: overrides.startedAt,
		...overrides,
	};
}

const NOW = new Date("2025-03-15T18:00:00").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("buildListeningReport", () => {
	it("aggregates listened time, track switches, plays and unique tracks for the week", () => {
		const monday = NOW - 6 * DAY_MS;
		const entries = [
			entry({ startedAt: monday, title: "晴天", artist: "周杰伦", playedSeconds: 240 }),
			entry({ startedAt: monday + 1_000, title: "七里香", artist: "周杰伦", playedSeconds: 20 }),
			entry({ startedAt: NOW - 3_600_000, title: "开始懂了", artist: "孙燕姿", playedSeconds: 180 }),
		];
		const report = buildListeningReport(entries, [], { range: "week", now: () => NOW });

		expect(report.range).toBe("week");
		expect(report.listenMs).toBe((240 + 20 + 180) * 1000);
		// Every started track counts as one switch; only >=30s listens count as plays.
		expect(report.trackSwitches).toBe(3);
		expect(report.plays).toBe(2);
		expect(report.uniqueTracks).toBe(2);
		expect(report.topArtists[0]).toMatchObject({ artist: "周杰伦", listenMs: 260_000, plays: 1 });
		expect(report.daily).toHaveLength(7);
	});

	it("keeps only today inside the today range and collapses multi-artist credits", () => {
		const yesterday = NOW - DAY_MS;
		const entries = [
			entry({ startedAt: yesterday, title: "昨天", artist: "A", playedSeconds: 500 }),
			entry({ startedAt: NOW - 60_000, title: "今天早些", artist: "B/C", playedSeconds: 120 }),
		];
		const report = buildListeningReport(entries, [], { range: "today", now: () => NOW });

		expect(report.listenMs).toBe(120_000);
		expect(report.trackSwitches).toBe(1);
		expect(report.topArtists).toEqual([{ artist: "B", listenMs: 120_000, plays: 1 }]);
		expect(report.daily).toHaveLength(1);
	});

	it("flags the most skipped artist once skips dominate recent attempts", () => {
		const base = NOW - 3_600_000;
		const entries = [
			entry({ startedAt: base, title: "a1", artist: "吵闹乐队", playedSeconds: 10 }),
			entry({ startedAt: base + 1_000, title: "a2", artist: "吵闹乐队", playedSeconds: 12 }),
			entry({ startedAt: base + 2_000, title: "a3", artist: "安静歌手", playedSeconds: 240 }),
			entry({ startedAt: base + 3_000, title: "a4", artist: "安静歌手", playedSeconds: 220 }),
		];
		const skips = [
			{ at: base + 500, artist: "吵闹乐队" },
			{ at: base + 1500, artist: "吵闹乐队" },
			{ at: base + 2500, artist: "吵闹乐队" },
		];
		const report = buildListeningReport(entries, skips, { range: "week", now: () => NOW });

		expect(report.skips).toBe(3);
		// 3 skips / (2 switches + 3 skips) = 60%, above the reporting threshold.
		expect(report.mostSkippedArtist).toMatchObject({ artist: "吵闹乐队", skips: 3, skipRatio: 0.6 });
	});

	it("stays quiet when no artist crosses the skip threshold", () => {
		const report = buildListeningReport(
			[entry({ startedAt: NOW - 1_000, title: "x", artist: "A", playedSeconds: 300 })],
			[{ at: NOW - 500, artist: "A" }],
			{ range: "today", now: () => NOW },
		);
		// Ratio reaches 50% but total events stay below the reporting threshold.
		expect(report.skips).toBe(1);
		expect(report.mostSkippedArtist).toBeUndefined();
	});

	it("drops entries that started outside the requested window", () => {
		const entries = [
			entry({ startedAt: NOW - 8 * DAY_MS, title: "上周", artist: "A", playedSeconds: 400 }),
			entry({ startedAt: NOW - DAY_MS, title: "本周内", artist: "A", playedSeconds: 100 }),
		];
		const report = buildListeningReport(entries, [], { range: "week", now: () => NOW });
		expect(report.listenMs).toBe(100_000);
		expect(report.fromDay).not.toBeUndefined();
	});
});

describe("SkipLedger", () => {
	it("persists notes across instances inside the local-day window", () => {
		const dir = mkdtempSync(join(tmpdir(), "dmb-skip-ledger-"));
		try {
			const path = join(dir, "skips.json");
			new SkipLedger(path, { now: () => NOW }).flush(); // creates an empty v1 store

			const writer = new SkipLedger(path, { now: () => NOW });
			writer.note("吵闹乐队");
			writer.note("安静歌手");
			writer.flush();

			// Round-trips through the JSON file.
			const reader = new SkipLedger(path, { now: () => NOW });
			expect(reader.recent(7)).toEqual([
				{ at: NOW, artist: "吵闹乐队" },
				{ at: NOW, artist: "安静歌手" },
			]);
			const stored = JSON.parse(readFileSync(path, "utf8")) as { version: number; skips: unknown[] };
			expect(stored.version).toBe(1);
			expect(stored.skips).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hides entries older than the requested window without deleting them", () => {
		const dir = mkdtempSync(join(tmpdir(), "dmb-skip-ledger-"));
		try {
			const path = join(dir, "skips.json");
			const ledger = new SkipLedger(path, { now: () => NOW });
			ledger.note("老歌歌手");
			ledger.flush();
			// Rewrite the timestamp to eight days ago through the documented shape.
			const stored = JSON.parse(readFileSync(path, "utf8")) as { skips: Array<{ at: number }> };
			const firstSkip = stored.skips[0];
			expect(firstSkip).toBeDefined();
			firstSkip!.at = NOW - 8 * DAY_MS;
			writeFileSync(path, JSON.stringify({ version: 1, skips: stored.skips }), "utf8");

			const reader = new SkipLedger(path, { now: () => NOW });
			expect(reader.recent(7)).toEqual([]);
			expect(reader.recent(9)).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tolerates a corrupted store by degrading to an empty ledger", () => {
		const dir = mkdtempSync(join(tmpdir(), "dmb-skip-ledger-"));
		try {
			const path = join(dir, "broken.json");
			writeFileSync(path, "{not json", "utf8");
			const ledger = new SkipLedger(path, { now: () => NOW });
			expect(ledger.recent(7)).toEqual([]);
			ledger.note("still works");
			ledger.flush();
			const after = JSON.parse(readFileSync(path, "utf8")) as { skips: unknown[] };
			expect(after.skips).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
