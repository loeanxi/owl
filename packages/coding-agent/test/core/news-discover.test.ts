import { describe, expect, it, vi } from "vitest";
import { discoverNewsFeed } from "../../src/core/news/sources.ts";

const feed = (title: string) =>
	`<rss><channel><title>${title}</title>${[1, 2, 3, 4]
		.map((n) => `<item><title>第 ${n} 条</title><link>https://example.com/post/${n}</link></item>`)
		.join("")}</channel></rss>`;

function site(pages: Record<string, string>) {
	const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		const body = pages[url];
		return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
	});
	return { fetch, options: { fetch, resolveHost: async () => ["8.8.8.8"] } };
}

describe("discoverNewsFeed", () => {
	it("uses a pasted feed address directly", async () => {
		const { options } = site({ "https://example.com/feed.xml": feed("示例博客") });
		const found = await discoverNewsFeed("example.com/feed.xml", options);
		expect(found.feedUrl).toBe("https://example.com/feed.xml");
		expect(found.title).toBe("示例博客");
		expect(found.items.map((item) => item.title)).toEqual(["第 1 条", "第 2 条", "第 3 条"]);
	});

	it("follows the feed a homepage advertises", async () => {
		const { options } = site({
			"https://example.com/": `<html><head><title>示例站</title><link rel="alternate" type="application/rss+xml" href="/posts.rss"></head></html>`,
			"https://example.com/posts.rss": feed(""),
		});
		const found = await discoverNewsFeed("https://example.com/", options);
		expect(found.feedUrl).toBe("https://example.com/posts.rss");
		expect(found.title).toBe("示例站");
	});

	it("falls back to conventional feed paths", async () => {
		const { options } = site({
			"https://example.com/": "<html><head><title>示例站</title></head></html>",
			"https://example.com/atom.xml": feed("示例 Atom"),
		});
		expect((await discoverNewsFeed("https://example.com/", options)).feedUrl).toBe("https://example.com/atom.xml");
	});

	it("says plainly when a site has no feed", async () => {
		const { options } = site({ "https://example.com/": "<html><head><title>示例站</title></head></html>" });
		await expect(discoverNewsFeed("https://example.com/", options)).rejects.toThrow("没有找到订阅源");
	});
});
