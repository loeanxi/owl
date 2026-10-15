import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsService } from "../../src/core/news/service.ts";
import { parseNewsFeed } from "../../src/core/news/sources.ts";
import type { NewsModelCaller, NewsSourceInput } from "../../src/core/news/types.ts";

const services: NewsService[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	vi.useRealTimers();
	for (const directory of directories.splice(0)) {
		if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("owl-news-ready-"))
			throw new Error("Unexpected reader fixture cleanup path");
		rmSync(directory, { recursive: true, force: true });
	}
});

const source: NewsSourceInput = {
	id: "reader-feed",
	name: "Publisher",
	kind: "rss",
	config: { feedUrl: "https://example.com/feed" },
	tier: "T1",
	participation: "editorial",
	enabled: true,
	intervalMinutes: 30,
	siteFulltext: false,
	syndicateFulltext: false,
};
const feed = `<rss><channel><item><guid>release-1</guid><title>Publisher releases model</title>
<link>https://example.com/release-1</link><description><![CDATA[<p>Publisher's exact public excerpt.</p>]]></description>
<pubDate>Wed, 14 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`;

function fixture(fetch = vi.fn(async () => new Response(feed, { headers: { etag: "release-1" } }))) {
	const agentDir = mkdtempSync(join(tmpdir(), "owl-news-ready-"));
	directories.push(agentDir);
	const callModel = vi.fn<NewsModelCaller>(async () => {
		throw new Error("Reader must not call a model");
	});
	const service = new NewsService({ agentDir, callModel, fetch, resolveHost: async () => ["93.184.216.34"] });
	services.push(service);
	return { service, fetch, callModel, agentDir };
}

async function readerOnly(service: NewsService) {
	for (const existing of service.store.sources()) await service.handle({ action: "deleteSource", id: existing.id });
	await service.handle({ action: "saveSource", source });
}

describe("zero configuration news reader", () => {
	it("keeps activated public feeds current in the worker without a reader page or model calls", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const { service, fetch, callModel } = fixture();
		await readerOnly(service);
		await service.handle({ action: "saveSource", source: { ...source, intervalMinutes: 1 } });
		service.start();
		await vi.advanceTimersByTimeAsync(10000);
		expect(fetch).not.toHaveBeenCalled();
		await service.handle({ action: "ready" });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(60000);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(callModel).not.toHaveBeenCalled();
		expect(service.store.jobs()).toEqual([]);
	});

	it("resumes activated feeds after restarting the service and respects the saved cadence", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const { service, fetch, callModel, agentDir } = fixture();
		await readerOnly(service);
		await service.handle({ action: "saveSource", source: { ...source, intervalMinutes: 2 } });
		await service.handle({ action: "ready" });
		await vi.advanceTimersByTimeAsync(0);
		await service.close();
		vi.setSystemTime(new Date("2026-10-15T00:01:00Z"));
		const reopened = new NewsService({ agentDir, callModel, fetch, resolveHost: async () => ["93.184.216.34"] });
		services.push(reopened);
		reopened.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(60000);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(callModel).not.toHaveBeenCalled();
	});

	it("backs off repeated source failures while retaining the last successful cards", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const { service, fetch, callModel } = fixture();
		await readerOnly(service);
		await service.handle({ action: "saveSource", source: { ...source, intervalMinutes: 1 } });
		await service.handle({ action: "ready" });
		await vi.advanceTimersByTimeAsync(0);
		fetch.mockRejectedValue(new Error("offline"));
		service.start();
		await vi.advanceTimersByTimeAsync(60000);
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60000);
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60000);
		expect(fetch).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(180000);
		expect(fetch).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(60000);
		expect(fetch).toHaveBeenCalledTimes(4);
		expect((await service.handle({ action: "snapshot" })).status.reader).toMatchObject({
			lastUpdatedAt: "2026-10-15T00:00:00.000Z",
			failedSourceCount: 1,
		});
		expect((await service.handle({ action: "list", query: { mode: "all" } })).items).toHaveLength(1);
		expect(callModel).not.toHaveBeenCalled();
	});

	it("keeps free feed health independent from editorial collection errors and dates", async () => {
		const { service } = fixture();
		await readerOnly(service);
		const editorial = {
			...service.store.source(source.id)!,
			lastCollectedAt: "2026-10-01T00:00:00.000Z",
			nextCollectedAt: "2026-10-01T00:30:00.000Z",
			lastError: "Editorial model unavailable",
		};
		service.store.writeSource(editorial);
		await service.handle({ action: "ready" });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		expect(service.store.source(source.id)).toMatchObject(editorial);
		expect((await service.handle({ action: "snapshot" })).status.reader).toMatchObject({ failedSourceCount: 0 });
		expect((await service.handle({ action: "sources" }))[0]?.reader).toMatchObject({
			lastCollectedAt: expect.any(String),
			lastError: null,
		});
	});

	it("does not persist derived reader health when the source settings are saved", async () => {
		const { service } = fixture();
		await readerOnly(service);
		const projected = (await service.handle({ action: "sources" }))[0]!;
		expect(projected.reader).toBeDefined();
		await service.handle({ action: "saveSource", source: { ...projected, enabled: false } });
		expect(service.store.source(source.id)?.reader).toBeUndefined();
	});

	it("limits free reading independently from the editorial model throughput setting", async () => {
		const item = feed.match(/<item>[\s\S]*?<\/item>/)![0];
		const multiple = `<rss><channel>${Array.from({ length: 5 }, (_, index) =>
			item.replaceAll("release-1", `release-${index}`),
		).join("")}</channel></rss>`;
		const { service, callModel } = fixture(vi.fn(async () => new Response(multiple)));
		await readerOnly(service);
		await service.handle({ action: "configure", patch: { maxItemsPerSource: 3 } });
		await service.handle({ action: "ready" });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		expect((await service.handle({ action: "list", query: { mode: "all" } })).items).toHaveLength(5);
		expect(callModel).not.toHaveBeenCalled();
	});

	it("discards old HTTP validators and failure state when a feed address changes", async () => {
		const headers: Headers[] = [];
		const fetcher = vi.fn(async (_input?: string | URL | Request, init?: RequestInit) => {
			headers.push(new Headers(init?.headers));
			return new Response(feed, { headers: { etag: "release-1" } });
		});
		const { service } = fixture(fetcher);
		await readerOnly(service);
		await service.handle({ action: "ready" });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		await service.handle({
			action: "saveSource",
			source: { ...source, config: { feedUrl: "https://example.com/new-feed" } },
		});
		expect((await service.handle({ action: "sources" }))[0]?.reader).toMatchObject({
			lastCollectedAt: null,
			lastError: null,
		});
		expect(await service.handle({ action: "ready", force: true })).toMatchObject({ queued: 1 });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		expect(headers).toHaveLength(2);
		expect(headers[1]?.has("if-none-match")).toBe(false);
	});

	it("caps repeated failure backoff at one hour and permits a throttled manual retry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const { service, fetch } = fixture();
		await readerOnly(service);
		fetch.mockRejectedValue(new Error("offline"));
		await service.handle({ action: "ready" });
		await vi.advanceTimersByTimeAsync(0);
		for (const delay of [120000, 240000, 480000, 960000, 1920000, 3600000, 3600000]) {
			const next = Date.now() + delay;
			expect((await service.handle({ action: "snapshot" })).status.reader?.nextRefreshAt).toBe(
				new Date(next).toISOString(),
			);
			vi.setSystemTime(next - 1);
			expect(await service.handle({ action: "ready" })).toMatchObject({ queued: 0 });
			vi.setSystemTime(next);
			expect(await service.handle({ action: "ready" })).toMatchObject({ queued: 1 });
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(fetch).toHaveBeenCalledTimes(8);
		vi.setSystemTime(Date.now() + 60000);
		expect(await service.handle({ action: "ready", force: true })).toMatchObject({ queued: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(9);
	});

	it("publishes feed titles before a slow article excerpt and keeps fulltext permissions intact", async () => {
		let completeArticle: (response: Response) => void = () => {};
		const article = new Promise<Response>((resolveArticle) => {
			completeArticle = resolveArticle;
		});
		const sparseFeed = feed.replace(/<description>[\s\S]*?<\/description>/, "");
		const fetcher = vi.fn(async (input?: string | URL | Request) => {
			return String(input).endsWith("/feed") ? new Response(sparseFeed) : article;
		});
		const { service, callModel } = fixture(fetcher);
		await readerOnly(service);
		await service.handle({ action: "ready" });
		try {
			await vi.waitFor(async () => {
				const result = await service.handle({ action: "list", query: { mode: "all" } });
				expect(result.items[0]).toMatchObject({ title: "Publisher releases model", summary: "", status: "ready" });
			});
			expect((await service.handle({ action: "snapshot" })).status.reader).toMatchObject({
				refreshing: true,
				lastUpdatedAt: expect.any(String),
				failedSourceCount: 0,
			});
		} finally {
			completeArticle(
				new Response(
					'<html><meta property="og:description" content="Publisher article description with actual capabilities and limitations."></html>',
					{ headers: { "content-type": "text/html" } },
				),
			);
		}
		await vi.waitFor(async () =>
			expect((await service.handle({ action: "snapshot" })).status.reader?.refreshing).toBe(false),
		);
		expect((await service.handle({ action: "list", query: { mode: "all" } })).items[0]).toMatchObject({
			summary: "Publisher article description with actual capabilities and limitations.",
			body: null,
			originalBody: null,
			fulltextAllowed: false,
		});
		expect(callModel).not.toHaveBeenCalled();
	});

	it("shares the article request budget across feeds and finishes sparse cached cards after a 304", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const sparseItem = feed.match(/<item>[\s\S]*?<\/item>/)![0].replace(/<description>[\s\S]*?<\/description>/, "");
		const fetchedArticles: string[] = [];
		const fetcher = vi.fn(async (input?: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (/\/feed(?:-b)?$/.test(url)) {
				if (new Headers(init?.headers).has("if-none-match")) return new Response(null, { status: 304 });
				const entries = Array.from({ length: 10 }, (_, index) =>
					sparseItem.replaceAll("release-1", `${url.endsWith("-b") ? "b" : "a"}-${index}`),
				);
				return new Response(`<rss><channel>${entries.join("")}</channel></rss>`, { headers: { etag: "sparse" } });
			}
			fetchedArticles.push(url);
			return new Response(
				'<html><meta property="og:description" content="Publisher article description with actual capabilities and limitations."></html>',
				{ headers: { "content-type": "text/html" } },
			);
		});
		const { service, callModel } = fixture(fetcher);
		await readerOnly(service);
		await service.handle({
			action: "saveSource",
			source: { ...source, id: "reader-b", config: { feedUrl: "https://example.com/feed-b" } },
		});
		await service.handle({ action: "ready" });
		await vi.waitFor(async () =>
			expect((await service.handle({ action: "snapshot" })).status.reader?.refreshing).toBe(false),
		);
		const first = (await service.handle({ action: "list", query: { mode: "all" } })).items;
		expect(first).toHaveLength(20);
		expect(first.filter((item) => !!item.summary)).toHaveLength(12);
		expect(fetchedArticles).toHaveLength(12);
		vi.setSystemTime(Date.now() + 60000);
		await service.handle({ action: "ready", force: true });
		await vi.waitFor(async () =>
			expect((await service.handle({ action: "snapshot" })).status.reader?.refreshing).toBe(false),
		);
		const second = (await service.handle({ action: "list", query: { mode: "all" } })).items;
		expect(second.every((item) => !!item.summary)).toBe(true);
		expect(fetchedArticles).toHaveLength(20);
		expect(new Set(fetchedArticles).size).toBe(20);
		expect(callModel).not.toHaveBeenCalled();
		expect(Object.keys(service.store.getMeta("reader-excerpts-v1") ?? {})).toHaveLength(20);
	});

	it("stops background refresh for sources explicitly disabled or deleted after activation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		const { service, fetch } = fixture();
		await readerOnly(service);
		await service.handle({ action: "saveSource", source: { ...source, intervalMinutes: 1 } });
		await service.handle({ action: "ready" });
		await vi.advanceTimersByTimeAsync(0);
		await service.handle({ action: "saveSource", source: { ...source, enabled: false, intervalMinutes: 1 } });
		service.start();
		await vi.advanceTimersByTimeAsync(120000);
		expect(fetch).toHaveBeenCalledOnce();
		await service.handle({ action: "deleteSource", id: source.id });
		await vi.advanceTimersByTimeAsync(120000);
		expect(fetch).toHaveBeenCalledOnce();
		expect(service.store.source(source.id)).toBeNull();
	});
	it("retains RSS excerpts separately from full article text", () => {
		const material = parseNewsFeed(feed, "https://example.com/feed")[0];
		expect(material?.summary).toBe("Publisher's exact public excerpt.");
		expect(material?.body).toBeUndefined();
	});

	it("publishes factual feed cards without model configuration, fulltext fetches, or paid jobs", async () => {
		const { service, fetch, callModel } = fixture();
		await readerOnly(service);
		const ready = await service.handle({ action: "ready" });
		expect(ready).toMatchObject({ queued: 1, refreshing: true, enabledSourceCount: 1 });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		const result = await service.handle({ action: "list", query: { mode: "all" } });
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			title: "Publisher releases model",
			summary: "Publisher's exact public excerpt.",
			contentOrigin: "source",
			status: "ready",
			score: null,
			selected: false,
			body: null,
			originalBody: null,
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(callModel).not.toHaveBeenCalled();
		expect(service.store.jobs()).toEqual([]);
		expect(service.store.receipts()).toEqual([]);
		expect((await service.handle({ action: "snapshot" })).configuration).toMatchObject({
			collectEnabled: false,
			modelCallsEnabled: false,
			models: {},
		});
	});

	it("deduplicates refresh clicks and keeps cached content when a source fails", async () => {
		const { service, fetch } = fixture();
		await readerOnly(service);
		await Promise.all([service.handle({ action: "ready" }), service.handle({ action: "ready", force: true })]);
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		expect((await service.handle({ action: "ready", force: true })).queued).toBe(0);
		expect(fetch).toHaveBeenCalledOnce();
		service.store.setMeta(`reader-source-state:${source.id}`, {
			...service.store.getMeta<Record<string, unknown>>(`reader-source-state:${source.id}`),
			lastAttemptAt: 0,
		});
		fetch.mockRejectedValueOnce(new Error("offline"));
		await service.handle({ action: "ready", force: true });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		expect((await service.handle({ action: "snapshot" })).status.reader).toMatchObject({
			enabledSourceCount: 1,
			failedSourceCount: 1,
			lastUpdatedAt: expect.any(String),
		});
		expect((await service.handle({ action: "list", query: { mode: "all" } })).items).toHaveLength(1);
		expect(await service.handle({ action: "ready" })).toMatchObject({ queued: 0, failedSourceCount: 1 });
	});

	it("preserves an existing editorial edition when the feed only supplies a newly parsed excerpt", async () => {
		const { service } = fixture();
		await readerOnly(service);
		const { summary: _excerpt, ...material } = parseNewsFeed(feed, "https://example.com/feed")[0]!;
		const existing = service.store.ingest(service.store.source(source.id)!, material);
		service.store.editItem(existing.item.id, {
			status: "ready",
			relevance: "pass",
			selected: true,
			title: "人工编辑标题",
			summary: "保留已有编辑摘要。",
		});
		await service.handle({ action: "ready" });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		expect(service.store.item(existing.item.id)).toMatchObject({
			revision: 1,
			title: "人工编辑标题",
			summary: "保留已有编辑摘要。",
			selected: true,
		});
	});

	it("keeps free feed validators and schedules separate so explicit editorial collection can analyze cached reader cards", async () => {
		const headers: Headers[] = [];
		const bodyFeed = feed.replace(
			"</item>",
			"<content:encoded><![CDATA[<p>Publisher's actual article body.</p>]]></content:encoded></item>",
		);
		const fetcher = vi.fn(async (_input?: string | URL | Request, init?: RequestInit) => {
			const requestHeaders = new Headers(init?.headers);
			headers.push(requestHeaders);
			return requestHeaders.has("if-none-match")
				? new Response(null, { status: 304 })
				: new Response(bodyFeed, { headers: { etag: "release-1" } });
		});
		const { service, callModel } = fixture(fetcher);
		await readerOnly(service);
		await service.handle({ action: "ready" });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		expect(service.store.source(source.id)?.nextCollectedAt).toBeNull();
		expect(service.store.getMeta(`source-cursor:${source.id}`)).toBeNull();
		expect(service.store.getMeta(`reader-source-cursor:${source.id}`)).toMatchObject({ etag: "release-1" });
		callModel.mockResolvedValue({
			text: JSON.stringify({ label: "BLOCK", reason: "Fixture editorial decision" }),
			provider: "fixture",
			model: "fixture",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: null },
		});
		await service.handle({
			action: "configure",
			patch: {
				modelCallsEnabled: true,
				models: { prefilter: { provider: "fixture", id: "fixture" } },
			},
		});
		service.start();
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		await service.handle({ action: "run", sourceId: source.id });
		await vi.waitFor(() => expect(service.store.items()[0]?.status).toBe("blocked"));
		expect(headers).toHaveLength(2);
		expect(headers[1]?.has("if-none-match")).toBe(false);
		expect(callModel).toHaveBeenCalledOnce();
		expect(service.store.items()[0]?.contentOrigin).toBe("editorial");
	});

	it("initializes untouched public defaults while respecting explicitly disabled and deleted sources", async () => {
		const { service, callModel } = fixture();
		const disabled = service.store.source("rss-openai-news")!;
		await service.handle({ action: "saveSource", source: { ...disabled, enabled: false } });
		await service.handle({ action: "deleteSource", id: "rss-google-deepmind" });
		await service.handle({ action: "ready" });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		expect(service.store.source("rss-openai-news")?.enabled).toBe(false);
		expect(service.store.source("rss-google-deepmind")).toBeNull();
		expect(service.store.source("rss-hugging-face")?.enabled).toBe(true);
		expect(callModel).not.toHaveBeenCalled();
	});

	it.each(["blocked", "processing"] as const)(
		"does not replace a %s editorial record when feed text changes",
		async (status) => {
			const { service } = fixture();
			await readerOnly(service);
			const material = parseNewsFeed(feed, "https://example.com/feed")[0]!;
			const existing = service.store.ingest(service.store.source(source.id)!, {
				...material,
				title: "Previous publisher title",
			});
			service.store.editItem(existing.item.id, { status, relevance: status === "blocked" ? "block" : "unknown" });
			await service.handle({ action: "ready" });
			await vi.waitFor(async () =>
				expect((await service.handle({ action: "snapshot" })).status.running).toBe(false),
			);
			expect(service.store.item(existing.item.id)).toMatchObject({
				revision: 1,
				status,
				title: "Previous publisher title",
			});
			expect((await service.handle({ action: "list", query: { mode: "all" } })).items).toEqual([]);
		},
	);

	it("excludes paid and credentialed sources and does not drain an existing editorial backlog", async () => {
		const { service, fetch, callModel } = fixture();
		await readerOnly(service);
		await service.handle({ action: "configure", patch: { modelCallsEnabled: true } });
		await service.handle({
			action: "saveSource",
			source: { ...source, id: "paid", kind: "x_search", config: { query: "ai" } },
		});
		await service.handle({
			action: "saveSource",
			source: {
				...source,
				id: "authenticated",
				config: { feedUrl: "https://example.com/private?token=private" },
			},
		});
		const pending = service.store.ingest(service.store.source(source.id)!, {
			title: "Pending",
			url: "https://example.com/pending",
		});
		await service.handle({ action: "ready" });
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		expect(fetch).toHaveBeenCalledOnce();
		expect(callModel).not.toHaveBeenCalled();
		expect(service.store.item(pending.item.id)?.status).toBe("pending");
		expect(service.store.jobs()).toHaveLength(1);
		expect(service.store.jobs()[0]?.status).toBe("pending");
	});
});
