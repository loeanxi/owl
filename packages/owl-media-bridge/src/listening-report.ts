import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync } from "./atomic-write.ts";
import type { ListeningEntry } from "./listening-memory.ts";

export type ListeningReportRange = "today" | "week";

/** One ranked artist row of the weekly report. */
export interface ListeningReportArtist {
	readonly artist: string;
	readonly listenMs: number;
	readonly plays: number;
}

export interface ListeningReportSkippedArtist {
	readonly artist: string;
	readonly plays: number;
	readonly skips: number;
	readonly skipRatio: number;
}

export interface ListeningReportDay {
	/** Local calendar day in `YYYY-MM-DD` form. */
	readonly day: string;
	readonly listenMs: number;
}

/**
 * The “音乐年报” mini report: how long was listened, the artist ranking, how
 * many track switches happened, and which artist keeps getting skipped.
 * Aggregated on demand from `ListeningEntry` rows plus recorded skip events —
 * no second history store.
 */
export interface ListeningReport {
	readonly range: ListeningReportRange;
	readonly fromDay: string;
	readonly toDay: string;
	/** Approximate total time in the playing state. */
	readonly listenMs: number;
	/** Track switches in the window (every started track counts once). */
	readonly trackSwitches: number;
	/** Tracks actually heard for at least {@link PLAY_THRESHOLD_MS}. */
	readonly plays: number;
	readonly skips: number;
	readonly uniqueTracks: number;
	readonly topArtists: readonly ListeningReportArtist[];
	readonly mostSkippedArtist?: ListeningReportSkippedArtist;
	/** One bucket per calendar day across the window, oldest first. */
	readonly daily: readonly ListeningReportDay[];
}

export interface SkipRecord {
	readonly at: number;
	readonly artist: string;
}

export function buildListeningReport(
	entries: readonly ListeningEntry[],
	skips: readonly SkipRecord[],
	options: { range: ListeningReportRange; now?: () => number },
): ListeningReport {
	const now = (options.now ?? Date.now)();
	const range = options.range === "today" ? "today" : "week";
	const startMs = range === "today" ? startOfDay(now) : startOfDay(now) - 6 * DAY_MS;
	const endMs = now + 1_000;

	const ordered = [...entries]
		.sort((a, b) => a.startedAt - b.startedAt)
		.filter((entry) => entry.startedAt >= startMs && entry.startedAt <= endMs);
	const windowSkips = skips.filter((skip) => skip.at >= startMs && skip.at <= endMs && skip.artist !== "");

	const listenMsTotal = ordered.reduce((total, entry) => total + Math.max(0, entry.playedSeconds) * 1000, 0);
	let plays = 0;
	const trackKeys = new Set<string>();
	const artists = new Map<string, { listenMs: number; plays: number; switches: number }>();
	for (const entry of ordered) {
		const listenedMs = Math.max(0, entry.playedSeconds) * 1000;
		const heardFully = listenedMs >= PLAY_THRESHOLD_MS;
		if (heardFully) {
			plays += 1;
			trackKeys.add(`${normalizeText(entry.title)}\u0000${normalizeText(entry.artist)}`);
		}
		const artist = primaryArtist(entry.artist);
		const stat = artists.get(artist) ?? { listenMs: 0, plays: 0, switches: 0 };
		stat.listenMs += listenedMs;
		stat.switches += 1;
		if (heardFully) stat.plays += 1;
		artists.set(artist, stat);
	}
	const skipsByArtist = new Map<string, number>();
	for (const skip of windowSkips) {
		const artist = primaryArtist(skip.artist);
		skipsByArtist.set(artist, (skipsByArtist.get(artist) ?? 0) + 1);
	}

	let mostSkippedArtist: ListeningReportSkippedArtist | undefined;
	for (const [artist, skipsCount] of skipsByArtist) {
		if (skipsCount <= 0) continue;
		const stat = artists.get(artist) ?? { listenMs: 0, plays: 0, switches: 0 };
		const total = stat.switches + skipsCount;
		const ratio = total === 0 ? 0 : skipsCount / total;
		if (total < SKIP_MIN_EVENTS || ratio < SKIP_RATIO) continue;
		if (
			mostSkippedArtist === undefined ||
			ratio > mostSkippedArtist.skipRatio ||
			(ratio === mostSkippedArtist.skipRatio && skipsCount > mostSkippedArtist.skips)
		) {
			mostSkippedArtist = { artist, plays: stat.plays, skips: skipsCount, skipRatio: ratio };
		}
	}

	const buckets = new Map<string, number>();
	const lastDayStart = startOfDay(now);
	for (
		let dayMs = range === "today" ? lastDayStart : lastDayStart - 6 * DAY_MS;
		dayMs <= lastDayStart;
		dayMs += DAY_MS
	) {
		buckets.set(dayKey(dayMs), 0);
	}
	for (const entry of ordered) {
		const day = dayKey(entry.startedAt);
		if (!buckets.has(day)) continue;
		buckets.set(day, (buckets.get(day) ?? 0) + Math.max(0, entry.playedSeconds) * 1000);
	}

	return {
		range,
		fromDay: dayKey(startMs),
		toDay: dayKey(now),
		listenMs: Math.round(listenMsTotal),
		trackSwitches: ordered.length,
		plays,
		skips: windowSkips.length,
		uniqueTracks: trackKeys.size,
		topArtists: [...artists.entries()]
			.map(([artist, stat]) => ({ artist, listenMs: Math.round(stat.listenMs), plays: stat.plays }))
			.sort((a, b) => b.listenMs - a.listenMs || b.plays - a.plays)
			.slice(0, 5),
		mostSkippedArtist,
		daily: [...buckets.entries()].map(([day, listenMs]) => ({ day, listenMs: Math.round(listenMs) })),
	};
}

/**
 * Process-local ledger of explicit next/previous presses, powering
 * “你最近总跳过 XX 的歌”. Kept separate from `ListeningMemory` so the shared
 * listening-history store stays owned by its own feature; this is metadata
 * only (artist name + timestamp), never images or lyrics.
 */
export class SkipLedger {
	private skips: SkipRecord[] = [];
	private loaded = false;
	private saveTimer: NodeJS.Timeout | undefined;

	private readonly filePath: string;
	private readonly now: () => number;
	private readonly maxAgeDays: number;
	private readonly maxEntries: number;

	constructor(
		filePath: string = defaultLedgerPath(),
		options: { now?: () => number; maxAgeDays?: number; maxEntries?: number } = {},
	) {
		this.filePath = filePath;
		this.now = options.now ?? Date.now;
		this.maxAgeDays = options.maxAgeDays ?? 30;
		this.maxEntries = options.maxEntries ?? 5_000;
	}

	/** Record one explicit skip. Never throws and never blocks playback paths. */
	note(artist: string): void {
		try {
			this.ensureLoaded();
			this.skips.push({ at: this.now(), artist });
			this.prune();
			this.scheduleSave();
		} catch {
			// Analytics must never break a control command.
		}
	}

	/** Skips inside the last `days` local calendar days, oldest first. */
	recent(days: number): SkipRecord[] {
		try {
			this.ensureLoaded();
			const cutoff = startOfDay(this.now()) - (Math.max(1, days) - 1) * DAY_MS;
			return this.skips.filter((skip) => skip.at >= cutoff);
		} catch {
			return [];
		}
	}

	flush(): void {
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		this.saveNow();
	}

	dispose(): void {
		try {
			this.flush();
		} catch {}
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		try {
			if (existsSync(this.filePath)) {
				const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<{
					version: number;
					skips: unknown;
				}>;
				if (parsed.version === 1 && Array.isArray(parsed.skips)) {
					this.skips = parsed.skips
						.filter((item): item is SkipRecord => {
							if (typeof item !== "object" || item === null) return false;
							const record = item as Record<string, unknown>;
							return (
								typeof record.at === "number" && Number.isFinite(record.at) && typeof record.artist === "string"
							);
						})
						.map((item) => ({ at: item.at, artist: item.artist }));
				}
			}
			this.loaded = true;
			this.prune();
		} catch {
			// Corrupted file degrades to an empty ledger; retry on next process.
			this.loaded = true;
		}
	}

	private prune(): void {
		const cutoff = startOfDay(this.now()) - (this.maxAgeDays - 1) * DAY_MS;
		this.skips = this.skips.filter((skip) => Number.isFinite(skip.at) && skip.at >= cutoff).slice(-this.maxEntries);
	}

	private scheduleSave(): void {
		if (this.saveTimer !== undefined) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.saveNow();
		}, 1_500);
		this.saveTimer.unref?.();
	}

	private saveNow(): void {
		atomicWriteFileSync(this.filePath, JSON.stringify({ version: 1, skips: this.skips }));
	}
}

function defaultLedgerPath(): string {
	// lib/listening-report.js -> ../data/listening-skips.json (repo/data when built in place).
	return resolve(fileURLToPath(new URL("../data/listening-skips.json", import.meta.url)));
}

const PLAY_THRESHOLD_MS = 30_000;
const SKIP_MIN_EVENTS = 4;
const SKIP_RATIO = 0.5;
const DAY_MS = 24 * 60 * 60 * 1000;
const ARTIST_SPLIT = /[/／、,&，,·・|]/;

function startOfDay(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function dayKey(at: number): string {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function normalizeText(value: string): string {
	return value.trim().toLocaleLowerCase();
}

/** Multi-artist credits collapse to the first listed name for ranking. */
function primaryArtist(value: string): string {
	return value.split(ARTIST_SPLIT)[0]?.trim() || value.trim();
}
