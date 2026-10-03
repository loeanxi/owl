import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeStatus } from "./domain/types.ts";

/** One "what played just now" row in the local listening history. */
export interface ListeningEntry {
	readonly id: string;
	readonly playerId: string;
	readonly playerName: string;
	readonly title: string;
	readonly artist: string;
	readonly album?: string;
	readonly artworkUrl?: string;
	readonly durationSeconds?: number;
	readonly startedAt: number;
	lastPlayedAt: number;
	/** Approximate seconds the track actually stayed in the playing state. */
	playedSeconds: number;
}

/** One locally kept favorite. Never written back to any player. */
export interface FavoriteEntry {
	readonly key: string;
	readonly playerId: string;
	readonly title: string;
	readonly artist: string;
	readonly album?: string;
	readonly artworkUrl?: string;
	readonly addedAt: number;
}

export interface MemorySummary {
	readonly favorite: boolean;
	readonly favoritesCount: number;
	readonly todayTracks: number;
	readonly todaySeconds: number;
}

export interface FavoriteToggleInput {
	readonly playerId: string;
	readonly title: string;
	readonly artist: string;
	readonly album?: string;
	readonly artworkUrl?: string;
}

export interface ListeningMemoryOptions {
	readonly maxDays?: number;
	readonly maxEntriesPerDay?: number;
	readonly maxFavorites?: number;
	readonly now?: () => number;
}

interface StoredEntry extends ListeningEntry {}
interface StoredState {
	readonly version: 1;
	readonly favorites: FavoriteEntry[];
	readonly days: Record<string, StoredEntry[]>;
}

const STATE_VERSION = 1;
const DEFAULT_MAX_DAYS = 7;
const DEFAULT_MAX_ENTRIES_PER_DAY = 400;
const DEFAULT_MAX_FAVORITES = 200;
/** Observations can pause for a while (player closed); never credit a whole gap as listening time. */
const MAX_PLAYTIME_GAP_MS = 30_000;
const SAVE_DEBOUNCE_MS = 1_500;

function defaultStorePath(): string {
	// lib/listening-memory.js -> ../data/listening-memory.json (repo/data when built in place).
	return resolve(fileURLToPath(new URL("../data/listening-memory.json", import.meta.url)));
}

/**
 * Process-local "my music memory": today's listening history plus client-owned
 * local favorites, persisted to one small metadata-only JSON file.
 *
 * Safety notes:
 * - Only text metadata (title/artist/album/URLs) is stored; no images or
 *   lyrics ever reach this store or the disk.
 * - Favorites are purely local; nothing is written back to QQ Music or
 *   NetEase Cloud Music.
 * - Every method tolerates a missing or corrupted file: the worst case is an
 *   empty in-memory view, never a failed status read.
 */
export class ListeningMemory {
	private state: StoredState = { version: STATE_VERSION, favorites: [], days: {} };
	private loaded = false;
	private nextEntryId = 1;
	private activeKey: string | undefined;
	private activeEntryId: string | undefined;
	private lastObservedAt = 0;
	private saveTimer: NodeJS.Timeout | undefined;
	private readonly filePath: string;
	private readonly now: () => number;
	private readonly maxDays: number;
	private readonly maxEntriesPerDay: number;
	private readonly maxFavorites: number;

	constructor(filePath: string = defaultStorePath(), options: ListeningMemoryOptions = {}) {
		this.filePath = filePath;
		this.maxDays = options.maxDays ?? DEFAULT_MAX_DAYS;
		this.maxEntriesPerDay = options.maxEntriesPerDay ?? DEFAULT_MAX_ENTRIES_PER_DAY;
		this.maxFavorites = options.maxFavorites ?? DEFAULT_MAX_FAVORITES;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Feed one authoritative status sample. Consecutive samples of the same
	 * track extend that entry's approximate playtime instead of creating rows.
	 * Never throws so the status hot path stays safe.
	 */
	note(status: BridgeStatus): void {
		try {
			const observedAt = this.now();
			const track = status.track;
			if (status.state === "unavailable" || track === undefined) {
				this.activeKey = undefined;
				this.activeEntryId = undefined;
				this.lastObservedAt = observedAt;
				return;
			}
			this.ensureLoaded();
			const key = trackKey(status.playerId, track.title, track.artist);
			if (key !== this.activeKey) {
				const day = this.dayBucket(observedAt);
				const entry: StoredEntry = {
					id: `t${this.nextEntryId}`,
					playerId: status.playerId,
					playerName: status.playerName,
					title: track.title,
					artist: track.artist,
					...(track.album ? { album: track.album } : {}),
					...(track.artworkUrl ? { artworkUrl: track.artworkUrl } : {}),
					...(track.durationSeconds !== undefined ? { durationSeconds: track.durationSeconds } : {}),
					startedAt: observedAt,
					lastPlayedAt: observedAt,
					playedSeconds: 0,
				};
				this.nextEntryId += 1;
				day.push(entry);
				this.trimDay(day);
				this.activeKey = key;
				this.activeEntryId = entry.id;
				this.lastObservedAt = observedAt;
				this.scheduleSave();
				return;
			}
			const entry = this.findActiveEntry();
			if (entry === undefined) {
				this.lastObservedAt = observedAt;
				return;
			}
			if (status.state === "playing") {
				const gap = observedAt - this.lastObservedAt;
				if (gap >= 0 && gap <= MAX_PLAYTIME_GAP_MS) entry.playedSeconds += gap / 1000;
			}
			if (entry.lastPlayedAt < observedAt) {
				entry.lastPlayedAt = observedAt;
				this.scheduleSave();
			}
			this.lastObservedAt = observedAt;
		} catch {
			// Memory features must never break the authoritative status path.
		}
	}

	/** Today's entries, oldest first, in the server's local timezone. */
	today(): readonly ListeningEntry[] {
		try {
			this.ensureLoaded();
			return [...(this.state.days[this.dayKey(this.now())] ?? [])];
		} catch {
			return [];
		}
	}

	/** Most recent entries across retained days, newest first. */
	recent(limit: number): readonly ListeningEntry[] {
		try {
			this.ensureLoaded();
			const days = Object.keys(this.state.days).sort();
			const merged: ListeningEntry[] = [];
			for (let index = days.length - 1; index >= 0 && merged.length < limit; index -= 1) {
				const dayKey = days[index];
				if (dayKey === undefined) continue;
				const dayEntries = this.state.days[dayKey] ?? [];
				for (let entryIndex = dayEntries.length - 1; entryIndex >= 0 && merged.length < limit; entryIndex -= 1) {
					const entry = dayEntries[entryIndex];
					if (entry !== undefined) merged.push(entry);
				}
			}
			return merged;
		} catch {
			return [];
		}
	}

	favorites(): readonly FavoriteEntry[] {
		try {
			this.ensureLoaded();
			return [...this.state.favorites];
		} catch {
			return [];
		}
	}

	/** Add-or-remove by identity; returns whether the track is now a favorite. */
	toggleFavorite(input: FavoriteToggleInput): { favorite: boolean; favorites: readonly FavoriteEntry[] } {
		this.ensureLoaded();
		const key = trackKey(input.playerId, input.title, input.artist);
		const existing = this.state.favorites.find((favorite) => favorite.key === key);
		if (existing !== undefined) {
			this.state = { ...this.state, favorites: this.state.favorites.filter((favorite) => favorite.key !== key) };
			this.scheduleSave();
			return { favorite: false, favorites: this.favorites() };
		}
		const favorite: FavoriteEntry = {
			key,
			playerId: input.playerId,
			title: input.title,
			artist: input.artist,
			...(input.album ? { album: input.album } : {}),
			...(input.artworkUrl ? { artworkUrl: input.artworkUrl } : {}),
			addedAt: this.now(),
		};
		const favorites = [favorite, ...this.state.favorites].slice(0, this.maxFavorites);
		this.state = { ...this.state, favorites };
		this.scheduleSave();
		return { favorite: true, favorites: this.favorites() };
	}

	removeFavorite(key: string): boolean {
		this.ensureLoaded();
		const before = this.state.favorites.length;
		this.state = { ...this.state, favorites: this.state.favorites.filter((favorite) => favorite.key !== key) };
		const removed = this.state.favorites.length !== before;
		if (removed) this.scheduleSave();
		return removed;
	}

	/** Compact counters for every browser poll; `favorite` reflects the given current track. */
	summary(track: BridgeStatus["track"], playerId: string): MemorySummary {
		try {
			this.ensureLoaded();
			const favorites = this.state.favorites;
			const favorite =
				track !== undefined && favorites.some((item) => item.key === trackKey(playerId, track.title, track.artist));
			let todaySeconds = 0;
			for (const entry of this.today()) todaySeconds += Math.max(0, entry.playedSeconds);
			return {
				favorite,
				favoritesCount: favorites.length,
				todayTracks: this.today().length,
				todaySeconds: Math.round(todaySeconds),
			};
		} catch {
			return { favorite: false, favoritesCount: 0, todayTracks: 0, todaySeconds: 0 };
		}
	}

	/** Force a synchronous save; used by dispose and before tests assert on the file. */
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
		} catch {
			// A failing final write must never break plugin teardown.
		}
	}

	/** The active entry may have started yesterday and rolled past midnight, so search every retained day. */
	private findActiveEntry(): StoredEntry | undefined {
		if (this.activeEntryId === undefined) return undefined;
		for (const day of Object.values(this.state.days)) {
			const entry = day.find((item) => item.id === this.activeEntryId);
			if (entry !== undefined) return entry;
		}
		return undefined;
	}

	private dayBucket(at: number): StoredEntry[] {
		const key = this.dayKey(at);
		const existing = this.state.days[key];
		if (existing !== undefined) return existing;
		const bucket: StoredEntry[] = [];
		this.state = { ...this.state, days: { ...this.state.days, [key]: bucket } };
		return bucket;
	}

	private trimDay(day: StoredEntry[]): void {
		while (day.length > this.maxEntriesPerDay) day.shift();
	}

	private dayKey(at: number): string {
		const date = new Date(at);
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${date.getFullYear()}-${month}-${day}`;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		try {
			if (existsSync(this.filePath)) {
				const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredState>;
				if (parsed.version === STATE_VERSION) {
					this.state = {
						version: STATE_VERSION,
						favorites: Array.isArray(parsed.favorites)
							? parsed.favorites.filter(isStoredFavorite).slice(0, this.maxFavorites)
							: [],
						days: sanitizeDays(parsed.days, this.maxDays, this.maxEntriesPerDay),
					};
					const highestEntry = numberedEntryId(Object.values(this.state.days).flat().at(-1)?.id);
					this.nextEntryId = Math.max(1, highestEntry + 1);
				}
			}
			this.pruneOldDays();
			this.loaded = true;
		} catch {
			// Corrupted store: keep serving the empty in-memory state and retry on a later call.
		}
	}

	private pruneOldDays(): void {
		const cutoff = this.dayKey(this.now() - this.maxDays * 24 * 60 * 60 * 1000);
		const days = Object.fromEntries(Object.entries(this.state.days).filter(([key]) => key >= cutoff));
		if (Object.keys(days).length !== Object.keys(this.state.days).length) {
			this.state = { ...this.state, days };
			this.scheduleSave();
		}
	}

	private scheduleSave(): void {
		if (!this.loaded) return;
		if (this.saveTimer !== undefined) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			try {
				this.saveNow();
			} catch {
				// Disk failures degrade to memory-only operation.
			}
		}, SAVE_DEBOUNCE_MS);
		this.saveTimer.unref?.();
	}

	private saveNow(): void {
		if (!this.loaded) return;
		const directory = dirname(this.filePath);
		mkdirSync(directory, { recursive: true });
		const tempPath = `${this.filePath}.tmp`;
		writeFileSync(tempPath, JSON.stringify(this.state), "utf8");
		renameSync(tempPath, this.filePath);
	}
}

function trackKey(playerId: string, title: string, artist: string): string {
	return `${normalize(playerId)}|${normalize(title)}|${normalize(artist)}`;
}

function normalize(value: string): string {
	return value.trim().toLocaleLowerCase();
}

function isStoredFavorite(value: unknown): value is FavoriteEntry {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.key === "string" &&
		typeof record.playerId === "string" &&
		typeof record.title === "string" &&
		typeof record.artist === "string" &&
		typeof record.addedAt === "number"
	);
}

function sanitizeDays(value: unknown, maxDays: number, maxEntriesPerDay: number): Record<string, StoredEntry[]> {
	if (typeof value !== "object" || value === null) return {};
	const result: Record<string, StoredEntry[]> = {};
	for (const [key, entries] of Object.entries(value as Record<string, unknown>)) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Array.isArray(entries)) continue;
		const cleaned = entries.filter(isStoredEntry).slice(-maxEntriesPerDay);
		if (cleaned.length > 0) result[key] = cleaned;
	}
	const keys = Object.keys(result).sort().slice(-maxDays);
	const pruned: Record<string, StoredEntry[]> = {};
	for (const key of keys) {
		const entries = result[key];
		if (entries !== undefined) pruned[key] = entries;
	}
	return pruned;
}

function isStoredEntry(value: unknown): value is StoredEntry {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.playerId === "string" &&
		typeof record.title === "string" &&
		typeof record.artist === "string" &&
		typeof record.startedAt === "number" &&
		typeof record.playedSeconds === "number"
	);
}

function numberedEntryId(id: string | undefined): number {
	if (id === undefined) return 0;
	const parsed = Number.parseInt(id.slice(1), 10);
	return Number.isFinite(parsed) ? parsed : 0;
}
