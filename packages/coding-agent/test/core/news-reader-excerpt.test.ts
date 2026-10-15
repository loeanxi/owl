import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichNewsReaderExcerpts, type ReaderExcerptCacheEntry } from "../../src/core/news/reader-excerpt.ts";
import type { NewsMaterial } from "../../src/core/news/types.ts";

afterEach(() => vi.useRealTimers());

const material: NewsMaterial = {
	title: "Publisher releases a new model",
	url: "https://example.com/article",
	publishedAt: "2026-10-14T12:00:00.000Z",
};
const description = "The publisher describes a new model, its evaluated capabilities, and how developers can use it.";

function htmlResponse(html: string) {
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function fixture() {
	const cache = new Map<string, ReaderExcerptCacheEntry>();
	const fetcher = vi.fn<typeof fetch>(async () =>
		htmlResponse(`<html><head><meta property="og:description" content="${description}"></head></html>`),
	);
	return {
		fetcher,
		cache,
		options: {
			fetch: fetcher,
			resolveHost: async () => ["93.184.216.34"],
			budget: { remaining: 12 },
			readCache: (key: string) => cache.get(key) ?? null,
			writeCache: (key: string, entry: ReaderExcerptCacheEntry) => cache.set(key, entry),
		},
	};
}

describe("automatic publisher excerpts", () => {
	it("uses publisher metadata without changing feed identity, publication time, or full article text", async () => {
		const { fetcher, options } = fixture();
		fetcher.mockImplementationOnce(async () =>
			htmlResponse(
				`<html><head><meta name="description" content="Secondary publisher description for this model."><meta property="og:description" content="${description}"></head><body><article>Other full text</article></body></html>`,
			),
		);
		const [result] = await enrichNewsReaderExcerpts([material], options);
		expect(result).toEqual({ ...material, summary: description });
		expect(result?.body).toBeUndefined();
		expect(material.summary).toBeUndefined();
		expect(Object.fromEntries(new Headers(fetcher.mock.calls[0]?.[1]?.headers))).toEqual({
			accept: "text/html,application/xhtml+xml",
		});
	});

	it("fills image captions and otherwise uses a bounded readable article excerpt", async () => {
		const { fetcher, options } = fixture();
		const article =
			"The research team explains the model and provides publicly reproducible evaluation results. ".repeat(20);
		fetcher.mockImplementationOnce(async () =>
			htmlResponse(
				`<html><head><title>Article</title></head><body><article><p>${article}</p></article></body></html>`,
			),
		);
		const [result] = await enrichNewsReaderExcerpts([{ ...material, summary: "Image caption" }], options);
		expect(result?.summary).toBe(article.slice(0, 600));
		expect(result?.summary).toHaveLength(600);
		expect(result?.body).toBeUndefined();
	});

	it("does not request articles when the feed already supplies a useful excerpt or body", async () => {
		const { fetcher, options } = fixture();
		const values = [
			{ ...material, summary: "Publisher's exact public excerpt." },
			{ ...material, body: description },
		];
		expect(await enrichNewsReaderExcerpts(values, options)).toEqual(values);
		expect(fetcher).not.toHaveBeenCalled();
		expect(options.budget.remaining).toBe(12);
	});

	it("skips hosting-platform boilerplate metadata and extracts the publisher's actual article", async () => {
		const { fetcher, options } = fixture();
		const article = "The researchers introduce a model for high-resolution weather simulation. ".repeat(12);
		fetcher.mockImplementationOnce(async () =>
			htmlResponse(
				`<html><head><title>Research</title><meta property="og:description" content="A Blog post by Ai2 on Hugging Face"></head><body><article><p>${article}</p></article></body></html>`,
			),
		);
		expect((await enrichNewsReaderExcerpts([material], options))[0]?.summary).toBe(article.slice(0, 600));
	});

	it("shares a strict request budget across concurrent source batches and preserves their order", async () => {
		const { fetcher, options } = fixture();
		options.budget.remaining = 3;
		const first = Array.from({ length: 6 }, (_, index) => ({ ...material, url: `${material.url}/a/${index}` }));
		const second = Array.from({ length: 6 }, (_, index) => ({ ...material, url: `${material.url}/b/${index}` }));
		const [one, two] = await Promise.all([
			enrichNewsReaderExcerpts(first, options),
			enrichNewsReaderExcerpts(second, options),
		]);
		expect(fetcher).toHaveBeenCalledTimes(3);
		expect(options.budget.remaining).toBe(0);
		expect([...one, ...two].filter((entry) => entry.summary === description)).toHaveLength(3);
		expect(one.map((entry) => entry.url)).toEqual(first.map((entry) => entry.url));
		expect(two.map((entry) => entry.url)).toEqual(second.map((entry) => entry.url));
	});

	it("reuses success and failure caches and retries failed requests only after their cooldown", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const { fetcher, cache, options } = fixture();
		const failed = { ...material, url: `${material.url}/denied`, summary: "Image caption" };
		fetcher.mockImplementation(async (url) =>
			String(url).endsWith("/denied")
				? new Response("Forbidden", { status: 403 })
				: htmlResponse(`<html><head><meta name="description" content="${description}"></head></html>`),
		);
		expect(await enrichNewsReaderExcerpts([material, failed], options)).toEqual([
			{ ...material, summary: description },
			failed,
		]);
		expect(cache.size).toBe(2);
		expect(await enrichNewsReaderExcerpts([material, failed], options)).toEqual([
			{ ...material, summary: description },
			failed,
		]);
		expect(fetcher).toHaveBeenCalledTimes(2);
		vi.setSystemTime(new Date("2026-10-15T02:00:01Z"));
		await enrichNewsReaderExcerpts([material, failed], options);
		expect(fetcher).toHaveBeenCalledTimes(3);
		await enrichNewsReaderExcerpts([{ ...material, title: "Publisher updates its model announcement" }], options);
		expect(fetcher).toHaveBeenCalledTimes(4);
	});

	it("ignores challenge pages and non-HTML responses while retaining the feed card", async () => {
		const { fetcher, options } = fixture();
		fetcher.mockImplementationOnce(async () =>
			htmlResponse(
				`<html><head><title>Just a moment...</title><meta name="description" content="${description}"></head><script>window._cf_chl_opt={};'/cdn-cgi/challenge-platform/'</script></html>`,
			),
		);
		fetcher.mockImplementationOnce(
			async () =>
				new Response(JSON.stringify({ article: description }), { headers: { "content-type": "application/json" } }),
		);
		const values = [material, { ...material, url: `${material.url}/json` }];
		expect(await enrichNewsReaderExcerpts(values, options)).toEqual(values);
	});

	it("keeps private addresses blocked even when another caller enables private-network collection", async () => {
		const { fetcher, options } = fixture();
		const values = [{ ...material, url: "http://127.0.0.1/secrets" }];
		expect(await enrichNewsReaderExcerpts(values, { ...options, allowPrivateNetwork: true })).toEqual(values);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("bounds HTML bytes and aborts a stalled request after five seconds", async () => {
		vi.useFakeTimers();
		const { fetcher, options } = fixture();
		fetcher.mockImplementationOnce(async () => htmlResponse("x".repeat(600 * 1024)));
		expect(await enrichNewsReaderExcerpts([material], { ...options, maxBytes: 4 * 1024 * 1024 })).toEqual([material]);
		fetcher.mockImplementationOnce(
			async (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const delayed = { ...material, url: `${material.url}/slow` };
		const request = enrichNewsReaderExcerpts([delayed], { ...options, timeoutMs: 60000 });
		await vi.advanceTimersByTimeAsync(5000);
		expect(await request).toEqual([delayed]);
	});
});
