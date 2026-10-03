import type { LyricLine, Track } from "../domain/types.ts";
import { parseLrc, withTranslations } from "./qq-music-cover.ts";

interface SearchSong {
	readonly id?: number;
	readonly name?: string;
	readonly duration?: number;
	readonly artists?: readonly { readonly id?: number; readonly name?: string }[];
	readonly album?: { readonly picUrl?: string };
}
interface ArtistInfoPayload {
	readonly artist?: { readonly img1v1Url?: string; readonly picUrl?: string };
}
interface CacheEntry {
	readonly visuals: NeteaseMusicVisuals;
	readonly songId?: number;
	readonly lyricsResolved?: boolean;
	readonly expiresAt: number;
}
interface LookupResult {
	readonly visuals: NeteaseMusicVisuals;
	readonly songId?: number;
	readonly lyricsResolved?: boolean;
}
interface LyricFetchResult {
	readonly lyrics?: readonly LyricLine[];
	readonly resolved: boolean;
}
export interface NeteaseMusicVisuals {
	readonly artworkUrl?: string;
	readonly artistImageUrl?: string;
	readonly backgroundImageUrls?: readonly string[];
	readonly lyrics?: readonly LyricLine[];
	readonly durationSeconds?: number;
}
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const REQUEST_TIMEOUT_MS = 3000;
const EMPTY_VISUALS_TTL_MS = 15_000;

function scopedSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): { readonly signal: AbortSignal; done(): void } {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(abort, timeoutMs);
	if (parent?.aborted) controller.abort();
	else parent?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		done: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abort);
		},
	};
}

/** Resolves NetEase public metadata without cookies; the artist portrait plus related album art enrich backgrounds. */
export class NeteaseMusicCoverResolver {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, Promise<LookupResult>>();
	private readonly fetcher: FetchLike;
	private readonly ttlMs: number;
	private readonly timeoutMs: number;
	constructor(fetcher: FetchLike = fetch, ttlMs = 60 * 60 * 1000, timeoutMs = REQUEST_TIMEOUT_MS) {
		this.fetcher = fetcher;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
	}

	async resolve(track: Track, signal?: AbortSignal): Promise<NeteaseMusicVisuals> {
		throwIfAborted(signal);
		const key = `${normalize(track.title)}\u0000${normalize(track.artist)}`;
		const cached = this.cache.get(key);
		if (cached !== undefined && cached.expiresAt > Date.now()) {
			if (cached.visuals.lyrics === undefined && cached.lyricsResolved !== true && cached.songId !== undefined) {
				const lyricResult = await this.fetchLyrics(cached.songId, signal);
				if (lyricResult.resolved) {
					const refreshed = {
						...cached,
						visuals: { ...cached.visuals, lyrics: lyricResult.lyrics },
						lyricsResolved: true,
					};
					this.cache.set(key, refreshed);
					return refreshed.visuals;
				}
			}
			return cached.visuals;
		}
		const pending = this.inflight.get(key);
		if (pending !== undefined) {
			const result = await pending;
			throwIfAborted(signal);
			return result.visuals;
		}
		const running = this.lookup(track, signal);
		this.inflight.set(key, running);
		try {
			const result = await running;
			throwIfAborted(signal);
			const hasVisuals = Boolean(
				result.visuals.artworkUrl || result.visuals.backgroundImageUrls?.length || result.visuals.lyrics?.length,
			);
			this.cache.set(key, { ...result, expiresAt: Date.now() + (hasVisuals ? this.ttlMs : EMPTY_VISUALS_TTL_MS) });
			return result.visuals;
		} finally {
			this.inflight.delete(key);
		}
	}

	private async lookup(track: Track, signal?: AbortSignal): Promise<LookupResult> {
		try {
			const search = await this.runFetch(
				"https://music.163.com/api/search/get/web?csrf_token=",
				{
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						referer: "https://music.163.com/",
						"user-agent": "Mozilla/5.0",
					},
					body: new URLSearchParams({
						s: `${track.title} ${track.artist}`,
						type: "1",
						offset: "0",
						total: "true",
						limit: "10",
					}).toString(),
				},
				signal,
			);
			if (!search.ok) return { visuals: {} };
			const payload = (await search.json()) as { readonly result?: { readonly songs?: readonly SearchSong[] } };
			const song = findSong(payload.result?.songs ?? [], track);
			if (song?.id === undefined) return { visuals: {} };
			// The /search response omits album art (album only carries a name), so
			// fall back to the song-detail endpoint to keep artwork working.
			let artworkUrl = song.album?.picUrl;
			if (artworkUrl === undefined || artworkUrl === "") {
				artworkUrl = await this.fetchArtwork(song.id, signal);
			}
			const artistId = song.artists?.[0]?.id;
			const artistImageUrl = await this.fetchArtistImage(artistId, signal);
			const backgroundImageUrls = this.composeBackgroundImages(
				artworkUrl,
				artistImageUrl,
				await this.fetchRelatedCovers(artistId, signal),
			);
			const lyricResult = await this.fetchLyrics(song.id, signal);
			const durationSeconds =
				typeof song.duration === "number" && Number.isFinite(song.duration) && song.duration > 0
					? song.duration / 1000
					: undefined;
			return {
				visuals: { artworkUrl, artistImageUrl, backgroundImageUrls, lyrics: lyricResult.lyrics, durationSeconds },
				songId: song.id,
				lyricsResolved: lyricResult.resolved,
			};
		} catch {
			return { visuals: {} };
		}
	}

	private async fetchArtwork(songId: number, signal?: AbortSignal): Promise<string | undefined> {
		try {
			const response = await this.runFetch(
				`https://music.163.com/api/song/detail/?id=${encodeURIComponent(String(songId))}&ids=%5B${encodeURIComponent(String(songId))}%5D`,
				{ headers: { referer: "https://music.163.com/", "user-agent": "Mozilla/5.0" } },
				signal,
			);
			if (!response.ok) return undefined;
			const payload = (await response.json()) as {
				readonly songs?: readonly { readonly album?: { readonly picUrl?: string } }[];
			};
			const picUrl = payload.songs?.[0]?.album?.picUrl;
			return picUrl === undefined || picUrl === "" ? undefined : picUrl;
		} catch {
			return undefined;
		}
	}

	/**
	 * Parity with QQ Music: resolve the singer photo through the public artist
	 * endpoint so NetEase tracks get a real artist portrait as the preferred
	 * background instead of only album covers. Degrades silently.
	 */
	private async fetchArtistImage(artistId: number | undefined, signal?: AbortSignal): Promise<string | undefined> {
		if (artistId === undefined) return undefined;
		try {
			const response = await this.runFetch(
				`https://music.163.com/api/artist/${encodeURIComponent(String(artistId))}`,
				{ headers: { referer: "https://music.163.com/", "user-agent": "Mozilla/5.0" } },
				signal,
			);
			if (!response.ok) return undefined;
			const payload = (await response.json()) as ArtistInfoPayload;
			const url = payload.artist?.img1v1Url ?? payload.artist?.picUrl;
			return url === undefined || url === "" ? undefined : upgradedImageUrl(url);
		} catch {
			return undefined;
		}
	}

	private async fetchRelatedCovers(artistId: number | undefined, signal?: AbortSignal): Promise<readonly string[]> {
		if (artistId === undefined) return [];
		try {
			const response = await this.runFetch(
				`https://music.163.com/api/artist/top/song?id=${encodeURIComponent(String(artistId))}&limit=6&offset=0`,
				{ headers: { referer: "https://music.163.com/", "user-agent": "Mozilla/5.0" } },
				signal,
			);
			if (!response.ok) return [];
			const payload = (await response.json()) as {
				readonly songs?: readonly { readonly al?: { readonly picUrl?: string } }[];
			};
			const covers: string[] = [];
			for (const song of payload.songs ?? []) {
				const picUrl = song.al?.picUrl;
				if (typeof picUrl === "string" && picUrl !== "") covers.push(upgradedImageUrl(picUrl));
			}
			return covers;
		} catch {
			return [];
		}
	}

	/**
	 * Background order mirrors QQ Music: artist photo first, then the current
	 * album cover, then related album art — all at background-friendly sizes.
	 */
	private composeBackgroundImages(
		artworkUrl: string | undefined,
		artistImageUrl: string | undefined,
		relatedCovers: readonly string[],
	): readonly string[] | undefined {
		const images = [
			...(artistImageUrl !== undefined ? [artistImageUrl] : []),
			...(artworkUrl !== undefined && artworkUrl !== "" ? [upgradedImageUrl(artworkUrl)] : []),
			...relatedCovers,
		];
		const uniqueImages = uniqueImageUrls(images).slice(0, 6);
		return uniqueImages.length === 0 ? undefined : uniqueImages;
	}

	private async fetchLyrics(songId: number, signal?: AbortSignal): Promise<LyricFetchResult> {
		try {
			const response = await this.runFetch(
				`https://music.163.com/api/song/lyric?id=${encodeURIComponent(String(songId))}&lv=-1&tv=-1`,
				{ headers: { referer: "https://music.163.com/", "user-agent": "Mozilla/5.0" } },
				signal,
			);
			if (!response.ok) return { resolved: false };
			const payload = (await response.json()) as {
				readonly lrc?: { readonly lyric?: string };
				readonly tlyric?: { readonly lyric?: string };
			};
			return {
				lyrics: cleanLyrics(
					mergeTranslations(parseLrc(payload.lrc?.lyric ?? ""), parseLrc(payload.tlyric?.lyric ?? "")),
				),
				resolved: true,
			};
		} catch {
			return { resolved: false };
		}
	}

	private async runFetch(input: string, init: RequestInit, parent?: AbortSignal): Promise<Response> {
		const scoped = scopedSignal(parent, this.timeoutMs);
		try {
			return await this.fetcher(input, { ...init, signal: scoped.signal });
		} finally {
			scoped.done();
		}
	}
}

function findSong(songs: readonly SearchSong[], track: Track): SearchSong | undefined {
	const title = normalize(track.title);
	const artist = normalize(track.artist);
	return songs.find(
		(song) =>
			normalize(song.name) === title &&
			song.artists?.some(
				(candidate) => artist.includes(normalize(candidate.name)) || normalize(candidate.name).includes(artist),
			),
	);
}
function normalize(value: string | undefined): string {
	return (value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, "");
}
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new Error("NetEase Music metadata lookup aborted.");
}
function uniqueImageUrls(images: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	return images.filter((image) => {
		let key = image;
		try {
			key = new URL(image).pathname;
		} catch {}
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * NetEase image CDN serves any size through the `?param=WxH` suffix. Backgrounds
 * and artist portraits want more pixels than the default ~300px search results.
 */
function upgradedImageUrl(url: string, size = "750y750"): string {
	return url.includes("?") ? url : `${url}?param=${size}`;
}
/**
 * Keep the original text and its translation on separate fields so the client
 * can toggle 原文/双语/翻译 without re-parsing combined strings.
 */
export function mergeTranslations(
	original: readonly LyricLine[],
	translations: readonly LyricLine[],
): readonly LyricLine[] | undefined {
	const merged = withTranslations(original, translations);
	return merged.length === 0 ? undefined : merged;
}

function cleanLyrics(lines: readonly LyricLine[] | undefined): readonly LyricLine[] | undefined {
	if (lines === undefined) return undefined;
	const metadata =
		/^(作词|作曲|编曲|制作人|监制|出品|营销|OP|SP|弦乐编排|和声|录音|混音|母带|统筹|音乐总监|配唱|吉他|贝斯|鼓手|鼓|programming)\s*[:：]/iu;
	const section = /^(?:verse|pre|hook|chorus|bridge|intro|outro)(?:\s*\d+)?$/iu;
	const filtered = lines.filter((line) => !metadata.test(line.text) && !section.test(line.text.trim()));
	return filtered.length === 0 ? undefined : filtered;
}
