import { describe, expect, it } from "vitest";
import { parseLrc, QqMusicCoverResolver, withTranslations } from "../src/adapters/qq-music-cover.ts";

function response(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("QqMusicCoverResolver", () => {
	it("resolves and caches the album cover by title and artist metadata", async () => {
		const urls: string[] = [];
		const resolver = new QqMusicCoverResolver(async (input) => {
			urls.push(input);
			if (input.startsWith("https://c.y.qq.com/")) {
				return response({ data: { song: { itemlist: [{ mid: "song-mid", name: "知足", singer: "五月天" }] } } });
			}
			return response({
				"music.pf_song_detail_svr": {
					data: { track_info: { album: { mid: "album-mid" }, singer: [{ mid: "artist-mid" }] } },
				},
			});
		});
		const track = { title: "知足", artist: "五月天" };

		await expect(resolver.resolve(track)).resolves.toMatchObject({
			artworkUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000album-mid.jpg",
			artistImageUrl: "https://y.gtimg.cn/music/photo_new/T001R800x800M000artist-mid.jpg",
			backgroundImageUrls: [
				"https://y.gtimg.cn/music/photo_new/T001R800x800M000artist-mid.jpg",
				"https://y.gtimg.cn/music/photo_new/T002R800x800M000album-mid.jpg",
			],
			lyrics: undefined,
		});
		await expect(resolver.resolve(track)).resolves.toMatchObject({
			backgroundImageUrls: [
				"https://y.gtimg.cn/music/photo_new/T001R800x800M000artist-mid.jpg",
				"https://y.gtimg.cn/music/photo_new/T002R800x800M000album-mid.jpg",
			],
		});
		expect(urls).toHaveLength(4);
	});

	it("preserves parsed lyrics when a later status poll uses the visual cache", async () => {
		const resolver = new QqMusicCoverResolver(async (input) => {
			if (input.includes("smartbox_new")) {
				return response({ data: { song: { itemlist: [{ mid: "song-mid", name: "知足", singer: "五月天" }] } } });
			}
			if (input.includes("fcg_query_lyric_new"))
				return response({ lyric: "[00:01.00]第一句\n[00:02.00]第二句", trans: "[00:01.00]Line one" });
			return response({
				"music.pf_song_detail_svr": {
					data: { track_info: { album: { mid: "album-mid" }, singer: [{ mid: "artist-mid" }] } },
				},
			});
		});
		const track = { title: "知足", artist: "五月天" };
		const expectedLyrics = [
			{ startMs: 1000, text: "第一句", translation: "Line one" },
			{ startMs: 2000, text: "第二句" },
		];

		await expect(resolver.resolve(track)).resolves.toMatchObject({ lyrics: expectedLyrics });
		await expect(resolver.resolve(track)).resolves.toMatchObject({ lyrics: expectedLyrics });
	});

	it("retries lyrics when the first visual lookup cached artwork during a temporary lyric failure", async () => {
		let lyricAttempts = 0;
		const resolver = new QqMusicCoverResolver(async (input) => {
			if (input.includes("smartbox_new")) {
				return response({ data: { song: { itemlist: [{ mid: "song-mid", name: "知足", singer: "五月天" }] } } });
			}
			if (input.includes("fcg_query_lyric_new")) {
				lyricAttempts += 1;
				return lyricAttempts === 1
					? new Response("temporary lyric outage", { status: 503 })
					: response({ lyric: "[00:01.00]第一句" });
			}
			return response({
				"music.pf_song_detail_svr": {
					data: { track_info: { album: { mid: "album-mid" }, singer: [{ mid: "artist-mid" }] } },
				},
			});
		});
		const track = { title: "知足", artist: "五月天" };

		await expect(resolver.resolve(track)).resolves.toMatchObject({
			artworkUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000album-mid.jpg",
			lyrics: undefined,
		});
		await expect(resolver.resolve(track)).resolves.toMatchObject({
			lyrics: [{ startMs: 1000, text: "第一句" }],
		});
		expect(lyricAttempts).toBe(2);
	});

	it("shares one in-flight lookup between concurrent pollers for the same track", async () => {
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const resolver = new QqMusicCoverResolver(async (input) => {
			calls += 1;
			if (input.includes("smartbox_new") && input.includes(encodeURIComponent("知足"))) {
				await gate;
				return response({ data: { song: { itemlist: [{ mid: "song-mid", name: "知足", singer: "五月天" }] } } });
			}
			if (input.includes("smartbox_new")) return response({ data: { song: { itemlist: [] } } });
			if (input.includes("fcg_query_lyric_new")) return response({ lyric: "[00:01.00]第一句" });
			return response({
				"music.pf_song_detail_svr": {
					data: { track_info: { album: { mid: "album-mid" }, singer: [{ mid: "artist-mid" }] } },
				},
			});
		});
		const track = { title: "知足", artist: "五月天" };

		const first = resolver.resolve(track);
		const second = resolver.resolve(track);
		release();
		await expect(Promise.all([first, second])).resolves.toMatchObject(
			Array(2).fill({ artworkUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000album-mid.jpg" }),
		);
		expect(calls).toBe(4);
	});

	it("returns no cover when metadata has no exact song match", async () => {
		const resolver = new QqMusicCoverResolver(async () =>
			response({ data: { song: { itemlist: [{ mid: "other", name: "别的歌", singer: "别人" }] } } }),
		);
		await expect(resolver.resolve({ title: "知足", artist: "五月天" })).resolves.toEqual({});
	});

	it("matches live and composite-artist media-session titles", async () => {
		const resolver = new QqMusicCoverResolver(async (input) => {
			if (input.includes("smartbox_new"))
				return response({
					data: { song: { itemlist: [{ mid: "song-mid", name: "别叫我达芬奇", singer: "张震岳" }] } },
				});
			if (input.includes("fcg_query_lyric_new")) return response({ lyric: "[00:01.00]第一句" });
			return response({
				"music.pf_song_detail_svr": {
					data: { track_info: { album: { mid: "album-mid" }, singer: [{ mid: "artist-mid" }] } },
				},
			});
		});

		await expect(
			resolver.resolve({ title: "别叫我达芬奇 (Live)", artist: "张震岳/品冠/焦迈奇 · 闪光的乐队 第5期" }),
		).resolves.toMatchObject({
			artworkUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000album-mid.jpg",
			lyrics: [{ startMs: 1000, text: "第一句" }],
		});
	});

	it("degrades to empty visuals when a lookup request hangs past the timeout", async () => {
		const resolver = new QqMusicCoverResolver(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
			60 * 1000,
			50,
		);

		await expect(resolver.resolve({ title: "知足", artist: "五月天" })).resolves.toEqual({});
	});

	it("parses timestamped lyric lines for the playback overlay", () => {
		expect(parseLrc("[00:01.20]第一句\n[01:02.345]第二句")).toEqual([
			{ startMs: 1200, text: "第一句" },
			{ startMs: 62345, text: "第二句" },
		]);
	});

	it("attaches translations only when their timestamps align with original lines", () => {
		const originals = parseLrc("[00:01.00]第一句\n[00:02.00]第二句");
		const translations = parseLrc("[00:01.00]Line one\n[00:02.00]第二句\n[00:03.00]Unmatched");
		expect(withTranslations(originals, translations)).toEqual([
			{ startMs: 1000, text: "第一句", translation: "Line one" },
			{ startMs: 2000, text: "第二句" },
		]);
		// Translation-only tracks fall through untouched so the UI still has content.
		expect(withTranslations([], translations)).toEqual(translations);
	});
});
