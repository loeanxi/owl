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
	return { service, fetch, callModel };
}

async function readerOnly(service: NewsService) {
	for (const existing of service.store.sources()) await service.handle({ action: "deleteSource", id: existing.id });
	await service.handle({ action: "saveSource", source });
}

describe("zero configuration news reader", () => {
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
		service.store.setMeta(`reader-attempt:${source.id}`, 0);
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
