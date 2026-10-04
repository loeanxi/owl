import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsService } from "../../src/core/news/service.ts";
import { NewsStore } from "../../src/core/news/store.ts";
import type { NewsMaterial, NewsModelCall, NewsModelResponse, NewsSourceInput } from "../../src/core/news/types.ts";

const stores: NewsStore[] = [];
const services: NewsService[] = [];
const directories: string[] = [];
function directory() {
	const path = mkdtempSync(join(tmpdir(), "owl-news-body-cache-"));
	directories.push(path);
	return path;
}
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const store of stores.splice(0)) store.close();
	for (const path of directories.splice(0)) {
		if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith("owl-news-body-cache-"))
			throw new Error("Unexpected body cache fixture cleanup path");
		rmSync(path, { recursive: true, force: true });
	}
});

const sourceInput: NewsSourceInput = {
	id: "rss-body-cache",
	name: "示例RSS",
	kind: "rss",
	config: { feedUrl: "https://example.com/feed.xml" },
	tier: "T1",
	participation: "editorial",
	enabled: false,
	intervalMinutes: 30,
	siteFulltext: false,
	syndicateFulltext: false,
};
const material: NewsMaterial = {
	title: "示例团队发布资讯框架",
	url: "https://example.com/article",
	externalId: "article-guid",
	publishedAt: "2026-10-04T00:00:00.000Z",
	author: "示例作者",
};
const fullBody = "示例团队发布资讯框架。正文介绍来源管理、任务恢复和引用校验，并提供完整使用步骤。".repeat(30);

function ledger() {
	const store = new NewsStore(join(directory(), "news.sqlite"));
	stores.push(store);
	return { store, source: store.saveSource(sourceInput) };
}

describe("news material body preservation", () => {
	it("keeps a saved body and the entire processed item when only the identical feed metadata returns", () => {
		const { store, source } = ledger();
		const first = store.ingest(source, { ...material, body: fullBody });
		store.editItem(first.item.id, {
			status: "ready",
			relevance: "pass",
			scores: [71, 72],
			score: 71,
			selected: false,
		});
		const processed = store.item(first.item.id);
		const beforeJobs = store.jobs().length;
		const recollected = store.ingest(source, material);
		expect(recollected.changed).toBe(false);
		expect(recollected.item).toEqual(processed);
		expect(store.material(first.item.id)?.body).toBe(fullBody);
		expect(store.jobs()).toHaveLength(beforeJobs);
	});

	it("uses the persisted identity key when the old material omitted a GUID equal to its URL", () => {
		const { store, source } = ledger();
		const { externalId: _externalId, ...withoutGuid } = material;
		const first = store.ingest(source, { ...withoutGuid, body: fullBody });
		const next = store.ingest(source, { ...withoutGuid, externalId: withoutGuid.url });
		expect(next.changed).toBe(false);
		expect(next.item.id).toBe(first.item.id);
		expect(next.item.revision).toBe(1);
		expect(next.item.originalBody).toBe(fullBody);
	});

	it.each([
		{ label: "title", patch: { title: "示例团队更新资讯框架" } },
		{ label: "publication date", patch: { publishedAt: "2026-10-05T00:00:00.000Z" } },
		{ label: "author", patch: { author: "另一位作者" } },
	])("invalidates the old body when feed $label changes", ({ patch }) => {
		const { store, source } = ledger();
		const first = store.ingest(source, { ...material, body: fullBody });
		const next = store.ingest(source, { ...material, ...patch });
		expect(next.changed).toBe(true);
		expect(next.item.id).toBe(first.item.id);
		expect(next.item.revision).toBe(2);
		expect(next.item.originalBody).toBeNull();
		expect(store.material(first.item.id)?.body).toBeUndefined();
	});

	it("never carries cached text to a different GUID or publisher despite an identical article URL", () => {
		const { store, source } = ledger();
		const first = store.ingest(source, { ...material, body: fullBody });
		const differentGuid = store.ingest(source, { ...material, externalId: "another-guid" });
		const differentSource = store.ingest(store.saveSource({ ...sourceInput, id: "another-publisher" }), material);
		for (const next of [differentGuid, differentSource]) {
			expect(next.changed).toBe(true);
			expect(next.item.id).not.toBe(first.item.id);
			expect(next.item.revision).toBe(1);
			expect(next.item.originalBody).toBeNull();
		}
		expect(store.material(first.item.id)?.body).toBe(fullBody);
	});

	it.each(["", "另一份明确提供的完整正文。"])("retains explicit body replacement semantics: %s", (body) => {
		const { store, source } = ledger();
		const first = store.ingest(source, { ...material, body: fullBody });
		const next = store.ingest(source, { ...material, body });
		expect(next.changed).toBe(true);
		expect(next.item.id).toBe(first.item.id);
		expect(next.item.revision).toBe(2);
		expect(store.material(first.item.id)?.body).toBe(body);
		expect(next.item.originalBody).toBe(body || null);
	});

	it("keeps non-RSS source body omission semantics unchanged", () => {
		const { store } = ledger();
		const source = store.saveSource({ ...sourceInput, kind: "external" });
		const first = store.ingest(source, { ...material, body: fullBody });
		const next = store.ingest(source, material);
		expect(next.changed).toBe(true);
		expect(next.item.id).toBe(first.item.id);
		expect(next.item.revision).toBe(2);
		expect(next.item.originalBody).toBeNull();
	});
});

describe("news recollection after manual article completion", () => {
	it("collects, records a 403, processes a genuine body once, and recollects without losing the body or repaying", async () => {
		const stamp = new Date().toUTCString();
		const feed = `<rss><channel><item><title>${material.title}</title><link>${material.url}</link><guid>article-guid</guid><pubDate>${stamp}</pubDate><author>${material.author}</author><description>仅有摘要，不是正文。</description></item></channel></rss>`;
		const fetcher = vi.fn<typeof fetch>(async (input) =>
			String(input).endsWith("/feed.xml") ? new Response(feed) : new Response("article denied", { status: 403 }),
		);
		const callModel = vi.fn(async (request: NewsModelCall): Promise<NewsModelResponse> => {
			let output: unknown;
			switch (request.capability) {
				case "prefilter":
					output = { label: "PASS", reason: "正文说明资讯框架发布" };
					break;
				case "score":
					output = { attentionScore: request.purpose === "score-2" ? 72 : 71 };
					break;
				case "structure":
					output = { scope: "single", category: "ai-products", tags: [], subjects: [], fact: null };
					break;
				case "understand":
				case "summarize":
					output = { titleZh: material.title, summaryZh: "示例团队发布资讯框架。" };
					break;
				default:
					throw new Error(`Unexpected fixture model capability: ${request.capability}`);
			}
			return {
				text: JSON.stringify(output),
				provider: "fixture",
				model: "fixture",
				usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: null },
			};
		});
		const service = new NewsService({
			agentDir: directory(),
			fetch: fetcher,
			callModel,
			resolveHost: async () => ["8.8.8.8"],
			resolveModel: async () => ({ provider: "fixture", id: "fixture" }),
		});
		services.push(service);
		await service.handle({ action: "saveSource", source: sourceInput });
		await service.handle({ action: "configure", patch: { modelCallsEnabled: true } });
		service.start();
		await vi.waitFor(async () => expect((await service.handle({ action: "snapshot" })).status.running).toBe(false));
		await service.handle({ action: "run", sourceId: sourceInput.id });
		await vi.waitFor(() => expect(service.store.items()[0]?.status).toBe("failed"));
		const id = service.store.items()[0]!.id;
		expect(callModel).not.toHaveBeenCalled();
		await service.handle({
			action: "ingest",
			sourceId: sourceInput.id,
			itemId: id,
			expectedRevision: 1,
			items: [{ title: material.title, url: material.url, body: fullBody }],
		});
		await vi.waitFor(async () => {
			expect(service.store.item(id)?.status).toBe("ready");
			expect((await service.handle({ action: "snapshot" })).status.running).toBe(false);
		});
		const processed = service.store.item(id)!;
		expect(processed).toMatchObject({
			revision: 2,
			originalBody: fullBody,
			scores: [71, 72],
			score: 71,
			selected: false,
			fulltextAllowed: false,
		});
		expect(callModel).toHaveBeenCalledTimes(5);
		const receipts = service.store.receipts();
		await service.handle({ action: "run", sourceId: sourceInput.id });
		await vi.waitFor(async () => {
			expect(
				service.store.jobs().filter((job) => job.kind === "collect" && job.status === "completed"),
			).toHaveLength(2);
			expect((await service.handle({ action: "snapshot" })).status.running).toBe(false);
		});
		expect(service.store.item(id)).toEqual(processed);
		expect(service.store.material(id)?.body).toBe(fullBody);
		expect(callModel).toHaveBeenCalledTimes(5);
		expect(service.store.receipts()).toEqual(receipts);
		expect(fetcher.mock.calls.filter(([input]) => String(input) === material.url)).toHaveLength(1);
	});
});
