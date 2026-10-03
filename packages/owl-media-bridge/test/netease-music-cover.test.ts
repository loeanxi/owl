import { describe, expect, it } from "vitest";
import { NeteaseMusicCoverResolver } from "../src/adapters/netease-music-cover.ts";

function response(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("NeteaseMusicCoverResolver", () => {
	it("resolves album artwork and keeps timed translations on a separate field", async () => {
		const resolver = new NeteaseMusicCoverResolver(async (input) => {
			if (input.includes("/search/get/web")) {
				return response({
					result: {
						songs: [
							{
								id: 42,
								name: "晴天",
								duration: 257000,
								artists: [{ id: 7, name: "周杰伦" }],
								album: { picUrl: "https://p3.music.126.net/cover.jpg" },
							},
						],
					},
				});
			}
			if (input.includes("/artist/top/song"))
				return response({
					songs: [
						{ al: { picUrl: "https://p1.music.126.net/cover.jpg" } },
						{ al: { picUrl: "https://p3.music.126.net/artist-album.jpg" } },
					],
				});
			return response({
				lrc: { lyric: "[00:01.00]原文\n[00:02.00]第二句" },
				tlyric: { lyric: "[00:01.00]Translation" },
			});
		});

		await expect(resolver.resolve({ title: "晴天", artist: "周杰伦" })).resolves.toEqual({
			artworkUrl: "https://p3.music.126.net/cover.jpg",
			backgroundImageUrls: [
				"https://p3.music.126.net/cover.jpg?param=750y750",
				"https://p3.music.126.net/artist-album.jpg?param=750y750",
			],
			durationSeconds: 257,
			lyrics: [
				{ startMs: 1000, text: "原文", translation: "Translation" },
				{ startMs: 2000, text: "第二句" },
			],
		});
	});

	it("prefers the artist portrait first in the background rotation, matching QQ Music parity", async () => {
		const resolver = new NeteaseMusicCoverResolver(async (input) => {
			if (input.includes("/search/get/web")) {
				return response({
					result: {
						songs: [
							{
								id: 42,
								name: "晴天",
								duration: 257000,
								artists: [{ id: 7, name: "周杰伦" }],
								album: { picUrl: "https://p3.music.126.net/cover.jpg" },
							},
						],
					},
				});
			}
			if (input.includes("/artist/top/song"))
				return response({ songs: [{ al: { picUrl: "https://p3.music.126.net/other-album.jpg" } }] });
			if (input.includes("/api/artist/7"))
				return response({ artist: { img1v1Url: "http://p1.music.126.net/artist-portrait.jpg" } });
			return response({ lrc: { lyric: "[00:01.00]原文" } });
		});

		await expect(resolver.resolve({ title: "晴天", artist: "周杰伦" })).resolves.toMatchObject({
			artistImageUrl: "http://p1.music.126.net/artist-portrait.jpg?param=750y750",
			backgroundImageUrls: [
				"http://p1.music.126.net/artist-portrait.jpg?param=750y750",
				"https://p3.music.126.net/cover.jpg?param=750y750",
				"https://p3.music.126.net/other-album.jpg?param=750y750",
			],
		});
	});

	it("keeps composing backgrounds when the artist endpoint fails", async () => {
		const resolver = new NeteaseMusicCoverResolver(async (input) => {
			if (input.includes("/search/get/web")) {
				return response({
					result: {
						songs: [
							{
								id: 42,
								name: "晴天",
								artists: [{ id: 7, name: "周杰伦" }],
								album: { picUrl: "https://p3.music.126.net/cover.jpg" },
							},
						],
					},
				});
			}
			if (input.includes("/api/artist/7")) return new Response("", { status: 503 });
			return response({ lrc: { lyric: "[00:01.00]原文" } });
		});

		await expect(resolver.resolve({ title: "晴天", artist: "周杰伦" })).resolves.toMatchObject({
			artistImageUrl: undefined,
			backgroundImageUrls: ["https://p3.music.126.net/cover.jpg?param=750y750"],
		});
	});

	it("uses a successful lyric response from cache without repeating metadata lookup", async () => {
		let searches = 0;
		const resolver = new NeteaseMusicCoverResolver(async (input) => {
			if (input.includes("/search/get/web")) {
				searches += 1;
				return response({
					result: {
						songs: [
							{
								id: 42,
								name: "晴天",
								duration: 257000,
								artists: [{ name: "周杰伦" }],
								album: { picUrl: "https://p3.music.126.net/cover.jpg" },
							},
						],
					},
				});
			}
			return response({ lrc: { lyric: "[00:01.00]原文" } });
		});

		await resolver.resolve({ title: "晴天", artist: "周杰伦" });
		await resolver.resolve({ title: "晴天", artist: "周杰伦" });
		expect(searches).toBe(1);
	});

	it("retries lyrics without discarding cached visuals after a transient lyric failure", async () => {
		let searches = 0;
		let lyricRequests = 0;
		const resolver = new NeteaseMusicCoverResolver(async (input) => {
			if (input.includes("/search/get/web")) {
				searches += 1;
				return response({
					result: {
						songs: [
							{
								id: 42,
								name: "晴天",
								artists: [{ name: "周杰伦" }],
								album: { picUrl: "https://p3.music.126.net/cover.jpg" },
							},
						],
					},
				});
			}
			if (input.includes("/song/lyric")) {
				lyricRequests += 1;
				return lyricRequests === 1
					? new Response("", { status: 503 })
					: response({ lrc: { lyric: "[00:01.00]恢复的歌词" } });
			}
			return response({});
		});

		await expect(resolver.resolve({ title: "晴天", artist: "周杰伦" })).resolves.toMatchObject({
			artworkUrl: "https://p3.music.126.net/cover.jpg",
			lyrics: undefined,
		});
		await expect(resolver.resolve({ title: "晴天", artist: "周杰伦" })).resolves.toMatchObject({
			lyrics: [{ startMs: 1000, text: "恢复的歌词" }],
		});
		expect(searches).toBe(1);
		expect(lyricRequests).toBe(2);
	});

	it("falls back to the song-detail endpoint when the search entry lacks album art", async () => {
		let detailCalls = 0;
		const resolver = new NeteaseMusicCoverResolver(async (input) => {
			if (input.includes("/search/get/web")) {
				return response({
					result: { songs: [{ id: 42, name: "晴天", artists: [{ name: "周杰伦" }], album: {} }] },
				});
			}
			if (input.includes("/song/detail/")) {
				detailCalls += 1;
				return response({ songs: [{ album: { picUrl: "https://p3.music.126.net/detail.jpg" } }] });
			}
			return response({ lrc: { lyric: "[00:01.00]原文" } });
		});

		await expect(resolver.resolve({ title: "晴天", artist: "周杰伦" })).resolves.toMatchObject({
			artworkUrl: "https://p3.music.126.net/detail.jpg",
			backgroundImageUrls: ["https://p3.music.126.net/detail.jpg?param=750y750"],
		});
		expect(detailCalls).toBe(1);
	});

	it("skips the song-detail endpoint when the search entry already has album art", async () => {
		let detailCalls = 0;
		const resolver = new NeteaseMusicCoverResolver(async (input) => {
			if (input.includes("/song/detail/")) {
				detailCalls += 1;
				return response({ songs: [] });
			}
			if (input.includes("/search/get/web")) {
				return response({
					result: {
						songs: [
							{
								id: 42,
								name: "晴天",
								artists: [{ name: "周杰伦" }],
								album: { picUrl: "https://p3.music.126.net/cover.jpg" },
							},
						],
					},
				});
			}
			return response({ lrc: { lyric: "[00:01.00]原文" } });
		});

		await resolver.resolve({ title: "晴天", artist: "周杰伦" });
		expect(detailCalls).toBe(0);
	});

	it("does not resolve a same-title song from a different artist", async () => {
		const resolver = new NeteaseMusicCoverResolver(async (input) => {
			if (input.includes("/search/get/web"))
				return response({
					result: {
						songs: [
							{
								id: 42,
								name: "晴天",
								artists: [{ name: "另一个歌手" }],
								album: { picUrl: "https://cover.test/wrong.jpg" },
							},
						],
					},
				});
			throw new Error("a mismatched song must not fetch related metadata");
		});

		await expect(resolver.resolve({ title: "晴天", artist: "周杰伦" })).resolves.toEqual({});
	});

	it("filters timed production credits and section markers from synced lyrics", async () => {
		const resolver = new NeteaseMusicCoverResolver(async (input) => {
			if (input.includes("/search/get/web"))
				return response({
					result: {
						songs: [
							{
								id: 42,
								name: "晴天",
								artists: [{ name: "周杰伦" }],
								album: { picUrl: "https://cover.test/晴天.jpg" },
							},
						],
					},
				});
			return response({ lrc: { lyric: "[00:00.00]作曲：周杰伦\n[00:00.50]verse 1\n[00:01.00]第一句" } });
		});

		await expect(resolver.resolve({ title: "晴天", artist: "周杰伦" })).resolves.toMatchObject({
			lyrics: [{ startMs: 1000, text: "第一句" }],
		});
	});
});
