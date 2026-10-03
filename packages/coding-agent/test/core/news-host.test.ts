import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportNewsItems } from "../../src/core/news/export.ts";
import { DEFAULT_NEWS_CONFIGURATION } from "../../src/core/news/industry.ts";
import { NewsService } from "../../src/core/news/service.ts";
import {
	collectNewsSource,
	extractNewsBody,
	fetchNewsText,
	parseNewsFeed,
	parseNewsJsonList,
	parseNewsWebList,
	publicNewsSource,
} from "../../src/core/news/sources.ts";
import { NewsBudgetError, NewsStore, NewsUnknownReceiptError } from "../../src/core/news/store.ts";
import type { NewsAnalysis, NewsModelCaller, NewsModelResponse, NewsSourceInput } from "../../src/core/news/types.ts";

const temporary: string[] = [];
function directory() {
	const path = mkdtempSync(join(tmpdir(), "owl-news-test-"));
	temporary.push(path);
	return path;
}
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const sourceInput: NewsSourceInput = {
	id: "test",
	name: "测试资料",
	kind: "external",
	config: {},
	tier: "T1",
	participation: "editorial",
	enabled: false,
	intervalMinutes: 30,
	siteFulltext: false,
	syndicateFulltext: false,
};
const analysis: NewsAnalysis = {
	relevance: "pass",
	scores: [80, 80],
	score: 80,
	selectionCandidate: true,
	title: "发布新模型",
	summary: "原文已说明发布新模型。",
	reason: "",
	category: "launch",
	tags: [],
	entities: [],
	contentKind: "single",
	fact: { subject: "模型", action: "发布", object: "新模型", occurredAt: null, evidence: ["发布新模型"] },
};
const response: NewsModelResponse = {
	text: "{}",
	provider: "fake",
	model: "fake",
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: null },
};

describe("news durable ledger", () => {
	it("deduplicates tracked URLs, keeps revisions, and enqueues analysis atomically", () => {
		const path = join(directory(), "news.sqlite");
		let store = new NewsStore(path);
		const source = store.saveSource(sourceInput);
		const first = store.ingest(source, {
			title: "发布新模型",
			url: "https://example.com/a?utm_source=feed",
			body: "发布新模型",
		});
		expect(
			store.ingest(source, { title: "发布新模型", url: "https://example.com/a", body: "发布新模型" }).changed,
		).toBe(false);
		expect(store.jobs()).toHaveLength(1);
		store.close();
		store = new NewsStore(path);
		expect(store.item(first.item.id)?.originalBody).toBe("发布新模型");
		const revised = store.ingest(source, {
			title: "发布新模型",
			url: "https://example.com/a",
			body: "发布新模型，新增说明。",
		});
		expect(revised.item.revision).toBe(2);
		expect(store.commitAnalysis(first.item.id, 1, analysis)).toBeNull();
		expect(store.jobs()).toHaveLength(2);
		store.close();
	});
	it("recovers received output without paying again, while uncertain calls require manual release", () => {
		const path = join(directory(), "news.sqlite");
		let store = new NewsStore(path);
		const paid = store.beginReceipt("received", "score", "item:a:1", "fake", DEFAULT_NEWS_CONFIGURATION.budget);
		store.receiveReceipt(paid.receipt.id, response, response.usage);
		const uncertain = store.beginReceipt("uncertain", "score", "item:b:1", "fake", DEFAULT_NEWS_CONFIGURATION.budget);
		store.enqueue("analyze", "a", { revision: 1 });
		store.claimJob(() => true);
		store.close();
		store = new NewsStore(path);
		store.recover();
		expect(
			store.beginReceipt("received", "score", "item:a:1", "fake", DEFAULT_NEWS_CONFIGURATION.budget).receipt
				.response,
		).toEqual(response);
		expect(store.jobs()[0]?.status).toBe("pending");
		expect(() =>
			store.beginReceipt("uncertain", "score", "item:b:1", "fake", DEFAULT_NEWS_CONFIGURATION.budget),
		).toThrow(NewsUnknownReceiptError);
		store.setReceiptState(uncertain.receipt.id, "failed");
		expect(
			store.beginReceipt("uncertain", "score", "item:b:1", "fake", DEFAULT_NEWS_CONFIGURATION.budget).receipt
				.attempts,
		).toBe(2);
		store.close();
	});
	it("budgets transport attempts and prevents a second process from taking a live worker", () => {
		const path = join(directory(), "news.sqlite");
		const store = new NewsStore(path);
		const other = new NewsStore(path);
		expect(store.acquireLease("first", 1000)).toBe(true);
		expect(other.acquireLease("second", 2000)).toBe(false);
		expect(other.acquireLease("second", 32000)).toBe(true);
		const budget = { perMinute: 1, perHour: 10, perDay: 10 };
		const receipt = store.beginReceipt("one", "score", "a", "fake", budget);
		store.receiveReceipt(receipt.receipt.id, response);
		expect(store.beginReceipt("one", "score", "a", "fake", budget).cached).toBe(true);
		expect(() => store.beginReceipt("two", "score", "b", "fake", budget)).toThrow(NewsBudgetError);
		other.close();
		store.close();
	});
	it("does not publish scoring candidates before grouping and keeps manual copy on a later analysis", () => {
		const store = new NewsStore(join(directory(), "news.sqlite"));
		const source = store.saveSource(sourceInput);
		const result = store.ingest(source, { title: "发布新模型", url: "https://example.com/a", body: "发布新模型" });
		expect(store.commitAnalysis(result.item.id, 1, analysis)?.selected).toBe(false);
		store.editItem(result.item.id, { title: "人工标题" }, true);
		const next = store.ingest(source, {
			title: "发布新模型",
			url: "https://example.com/a",
			body: "发布新模型，有补充",
		});
		expect(store.commitAnalysis(next.item.id, 2, analysis)?.title).toBe("人工标题");
		store.close();
	});
});

describe("news collectors and network boundary", () => {
	it("parses RSS CDATA, Atom alternate links, selector HTML and JSON mappings", () => {
		expect(
			parseNewsFeed(
				"<rss><channel><item><title>模型发布</title><link>https://example.com/a</link><content:encoded><![CDATA[<p>正文说明</p>]]></content:encoded></item></channel></rss>",
				"https://example.com",
			)[0]?.body,
		).toBe("正文说明");
		expect(
			parseNewsFeed(
				'<feed><entry><title>模型发布</title><link rel="self" href="/api"/><link rel="alternate" href="/a"/><content>正文</content></entry></feed>',
				"https://example.com",
			)[0]?.url,
		).toBe("https://example.com/a");
		expect(
			parseNewsWebList(
				'<article><a href="/a"><h2>模型发布</h2></a><time datetime="2026-01-01T08:00:00Z"></time></article>',
				"https://example.com",
				{ itemSelector: "article", titleSelector: "h2" },
			),
		).toHaveLength(1);
		expect(
			parseNewsJsonList({ data: [{ headline: "模型发布", id: 7 }] }, "https://example.com", {
				itemsPath: "data",
				titlePaths: ["headline"],
				urlTemplate: "https://example.com/{id}",
			})[0]?.url,
		).toBe("https://example.com/7");
		expect(() =>
			parseNewsFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]><rss/>', "https://example.com"),
		).toThrow("外部实体");
	});
	it("extracts article text without script or active markup", () => {
		const result = extractNewsBody(
			`<html><head><title>测试文章</title></head><body><article><h1>测试文章</h1><p>${"这是实际正文，发布新模型并给出了技术说明。".repeat(30)}</p><script>secret()</script></article></body></html>`,
			"https://example.com/a",
		);
		expect(result.body).toContain("实际正文");
		expect(result.body).not.toContain("secret()");
	});
	it("blocks private redirects before a second request and rejects over-size streaming responses", async () => {
		const fake = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("", { status: 302, headers: { location: "http://127.0.0.1/secret" } }));
		await expect(
			fetchNewsText("https://example.com", {}, { fetch: fake, resolveHost: async () => ["8.8.8.8"] }),
		).rejects.toThrow("内网");
		expect(fake).toHaveBeenCalledTimes(1);
		const large = vi.fn<typeof fetch>().mockResolvedValue(new Response("123456789"));
		await expect(
			fetchNewsText("https://example.com", {}, { fetch: large, resolveHost: async () => ["8.8.8.8"], maxBytes: 4 }),
		).rejects.toThrow("大小");
	});
	it("does not expose source secrets and consumes paid X/MP providers through receipts", async () => {
		const publicSource = publicNewsSource({
			...sourceInput,
			config: { headers: { Authorization: "super-secret" }, apiKey: "key-value" },
		});
		expect(JSON.stringify(publicSource)).not.toContain("super-secret");
		expect(JSON.stringify(publicSource)).not.toContain("key-value");
		const fake = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ tweets: [{ id_str: "1", full_text: "发布新模型", user: { screen_name: "model" } }] }),
				),
			);
		const paid = vi.fn(async (_purpose: string, _identity: unknown, run: () => Promise<unknown>) => run());
		const rows = await collectNewsSource(
			{ ...sourceInput, kind: "x_search", config: { query: "from:model" } },
			{ fetch: fake, resolveHost: async () => ["8.8.8.8"], secrets: { SOCIALDATA_API_KEY: "fake-only" }, paid },
		);
		expect(rows[0]?.externalId).toBe("1");
		expect(paid).toHaveBeenCalledTimes(1);
		const mpFetch = vi.fn<typeof fetch>().mockImplementation(async (input) =>
			String(input).includes("post_history")
				? new Response(
						JSON.stringify({
							code: 0,
							data: [
								{
									title: "公众号文章",
									url: "https://mp.weixin.qq.com/s?sessionid=one",
									sn: "stable-article-id",
									update_time: 123456,
								},
							],
						}),
					)
				: new Response(JSON.stringify({ code: 0, content: "公众号文章正文" })),
		);
		const mpPaid = vi.fn(async (_purpose: string, _identity: unknown, run: () => Promise<unknown>) => run());
		const mpRows = await collectNewsSource(
			{ ...sourceInput, id: "mp", kind: "mp_account", config: { ghid: "gh_test" } },
			{ fetch: mpFetch, resolveHost: async () => ["8.8.8.8"], secrets: { DAJIALA_KEY: "fake-only" }, paid: mpPaid },
		);
		expect(mpRows[0]?.body).toBe("公众号文章正文");
		expect(mpPaid.mock.calls[1]?.[0]).toBe("mp-article");
		expect(mpPaid.mock.calls[1]?.[1]).toEqual({ articleId: "stable-article-id", updatedAt: "123456" });
	});
});

describe("news application service", () => {
	it("starts offline, denies unconfigured ingestion, and exposes only full-text grants across exports", async () => {
		const callModel = vi.fn<NewsModelCaller>();
		const fetcher = vi.fn<typeof fetch>();
		const service = new NewsService({ agentDir: directory(), callModel, fetch: fetcher });
		service.start();
		expect((await service.handle({ action: "snapshot" })).configuration.modelCallsEnabled).toBe(false);
		expect(service.authorizeIngest("a".repeat(20))).toBe(false);
		await service.handle({ action: "configure", patch: {}, secrets: { ingest: "a".repeat(20) } });
		expect(service.authorizeIngest("a".repeat(20))).toBe(true);
		expect(JSON.stringify(await service.handle({ action: "snapshot" }))).not.toContain("a".repeat(20));
		const source = service.store.saveSource(sourceInput);
		const raw = service.store.ingest(source, {
			title: "发布新模型",
			url: "https://example.com/a",
			body: "付费正文",
		}).item;
		service.store.commitAnalysis(raw.id, 1, analysis);
		service.store.editItem(raw.id, { selected: true, novel: true });
		const item = await service.handle({ action: "item", id: raw.id });
		expect(item?.originalBody).toBeNull();
		const content = await service.handle({ action: "export", format: "json", fulltext: true });
		expect(content.content).not.toContain("付费正文");
		service.store.writeSource({ ...source, syndicateFulltext: true });
		expect(exportNewsItems("markdown", service.store.items(), service.store.sources(), true).content).toContain(
			"付费正文",
		);
		service.store.editItem(raw.id, { withdrawn: true });
		expect((await service.handle({ action: "list", query: { mode: "all" } })).items).toHaveLength(0);
		expect(callModel).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
		await service.close();
	});
	it("shares successful X responses across equivalent source previews", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					tweets: [
						{
							id_str: "123",
							full_text: "发布新模型并说明技术细节。",
							tweet_created_at: "2026-10-04T08:00:00Z",
							user: { screen_name: "model" },
						},
					],
				}),
			),
		);
		const service = new NewsService({
			agentDir: directory(),
			callModel: vi.fn<NewsModelCaller>(),
			fetch: fetcher,
			resolveHost: async () => ["8.8.8.8"],
		});
		await service.handle({ action: "configure", patch: {}, secrets: { SOCIALDATA_API_KEY: "faux-only" } });
		const source: NewsSourceInput = {
			...sourceInput,
			id: "x-primary",
			kind: "x_search",
			config: { query: "from:model", searchType: "Latest" },
		};
		const first = await service.handle({ action: "previewSource", source });
		const second = await service.handle({
			action: "previewSource",
			source: { ...source, id: "x-duplicate" },
		});
		expect(second).toEqual(first);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(service.store.receipts().filter((receipt) => receipt.capability === "x-search")).toHaveLength(1);
		await service.close();
	});
	it("does not repeat an uncertain shared X request before its receipt is released", async () => {
		const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("simulated disconnect"));
		const service = new NewsService({
			agentDir: directory(),
			callModel: vi.fn<NewsModelCaller>(),
			fetch: fetcher,
			resolveHost: async () => ["8.8.8.8"],
		});
		await service.handle({ action: "configure", patch: {}, secrets: { SOCIALDATA_API_KEY: "faux-only" } });
		const source: NewsSourceInput = {
			...sourceInput,
			id: "x-primary",
			kind: "x_search",
			config: { query: "from:model", searchType: "Latest" },
		};
		await expect(service.handle({ action: "previewSource", source })).rejects.toBeInstanceOf(NewsUnknownReceiptError);
		await expect(
			service.handle({ action: "previewSource", source: { ...source, id: "x-duplicate" } }),
		).rejects.toBeInstanceOf(NewsUnknownReceiptError);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(service.store.receipts().filter((receipt) => receipt.capability === "x-search")).toHaveLength(1);
		await service.close();
	});
	it("preserves processed output after restart and completes a full faux-model pipeline", async () => {
		const agentDir = directory();
		const calls = vi.fn<NewsModelCaller>(async (request) => {
			let text = "{}";
			if (request.capability === "prefilter") text = JSON.stringify({ label: "PASS", reason: "相关" });
			if (request.capability === "score") text = JSON.stringify({ attentionScore: 80 });
			if (request.capability === "group") {
				const input = JSON.parse(request.user) as { candidates?: { id: string }[] };
				text = JSON.stringify({
					query: "same occurrence",
					decisions: (input.candidates ?? []).map((candidate) => ({
						id: candidate.id,
						relation: "SAME_OCCURRENCE",
						confidence: 1,
					})),
					selection: { addsValue: false, reason: "同一事件的另一信源报道" },
				});
			}
			if (request.capability === "structure")
				text = JSON.stringify({
					scope: "single",
					category: "launch",
					tags: [],
					subjects: [],
					fact: { title: "发布新模型", subject: "模型", action: "发布", object: "新模型", evidence: "发布新模型" },
				});
			if (["understand", "summarize"].includes(request.capability))
				text = JSON.stringify({ titleZh: "发布新模型", summaryZh: "原文说明发布新模型。" });
			if (request.capability === "digest")
				text = JSON.stringify({ title: "发布新模型", digest: "原文说明发布新模型。" });
			return { ...response, text };
		});
		let service = new NewsService({ agentDir, callModel: calls });
		await service.handle({ action: "saveSource", source: sourceInput });
		const models = Object.fromEntries(
			["prefilter", "score", "structure", "understand", "summarize", "group", "groupReview", "digest"].map((key) => [
				key,
				{ provider: "fake", id: "fake" },
			]),
		);
		await service.handle({ action: "configure", patch: { modelCallsEnabled: true, models } });
		const publishedAt = new Date().toISOString();
		await service.handle({
			action: "ingest",
			sourceId: "test",
			items: [
				{
					title: "发布新模型",
					url: "https://example.com/a",
					body: "发布新模型并说明技术细节。",
					publishedAt,
				},
			],
		});
		service.start();
		await vi.waitFor(async () => expect((await service.handle({ action: "list" })).total).toBe(1), { timeout: 5000 });
		const firstScores = service.store.items().find((item) => item.sourceId === "test")?.scores;
		await service.handle({ action: "saveSource", source: { ...sourceInput, id: "test-copy" } });
		await service.handle({
			action: "ingest",
			sourceId: "test-copy",
			items: [
				{
					title: "发布新模型",
					url: "https://example.com/a",
					body: "发布新模型并说明技术细节。",
					publishedAt,
				},
			],
		});
		await vi.waitFor(
			() => {
				const copy = service.store.items().find((item) => item.sourceId === "test-copy");
				expect(copy?.status).toBe("ready");
				expect(copy?.scores).toEqual(firstScores);
			},
			{ timeout: 5000 },
		);
		expect(calls.mock.calls.filter(([request]) => request.capability === "score")).toHaveLength(2);
		const count = calls.mock.calls.length;
		expect(count).toBeGreaterThanOrEqual(5);
		await service.close();
		service = new NewsService({ agentDir, callModel: calls });
		service.start();
		expect((await service.handle({ action: "list", query: { mode: "all" } })).total).toBe(2);
		await service.close();
		expect(calls.mock.calls.length).toBe(count);
	});
});
