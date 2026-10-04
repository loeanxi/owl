import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsService } from "../../src/core/news/service.ts";
import { parseNewsFeed } from "../../src/core/news/sources.ts";
import type { NewsModelCall, NewsModelResponse, NewsSourceInput } from "../../src/core/news/types.ts";

const services: NewsService[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const directory of directories.splice(0)) {
		if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("owl-news-article-"))
			throw new Error("Unexpected news article fixture cleanup path");
		rmSync(directory, { recursive: true, force: true });
	}
});

const title = "示例团队发布资讯框架";
const url = "https://example.com/article";
const realBody = "示例团队发布资讯框架。完整正文介绍了来源管理、任务恢复、引用校验以及具体使用步骤。".repeat(30);
const challenge =
	'<html><head><title>Just a moment...</title></head><body><main>Checking your browser...</main><script>window._cf_chl_opt={};var path="/cdn-cgi/challenge-platform/";</script></body></html>';
const source: NewsSourceInput = {
	id: "rss-article",
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

async function fixture(response: () => Response, body?: string) {
	const agentDir = mkdtempSync(join(tmpdir(), "owl-news-article-"));
	directories.push(agentDir);
	const fetcher = vi.fn<typeof fetch>(async () => response());
	const callModel = vi.fn(
		async (_request: NewsModelCall): Promise<NewsModelResponse> => ({
			text: JSON.stringify({ label: "BLOCK", reason: "离线示例不参与精选" }),
			provider: "fixture",
			model: "fixture",
			usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: null },
		}),
	);
	const service = new NewsService({
		agentDir,
		fetch: fetcher,
		callModel,
		resolveHost: async () => ["8.8.8.8"],
		resolveModel: async () => ({ provider: "fixture", id: "fixture" }),
	});
	services.push(service);
	await service.handle({ action: "saveSource", source });
	await service.handle({ action: "configure", patch: { modelCallsEnabled: true } });
	const material =
		body === undefined
			? parseNewsFeed(
					`<rss><channel><item><title>${title}</title><link>${url}</link><guid>stable-article-guid</guid><author>原作者</author><pubDate>${new Date().toUTCString()}</pubDate><description>这只是RSS提供的短摘要，没有具体步骤。</description></item></channel></rss>`,
					source.config.feedUrl as string,
				)[0]!
			: { title, url, body };
	await service.handle({ action: "ingest", sourceId: source.id, items: [material] });
	const item = service.store.items().find((entry) => entry.sourceId === source.id)!;
	service.start();
	return { service, fetcher, callModel, id: item.id, material };
}

describe("news article content acquisition", () => {
	it.each([401, 403, 404, 410])(
		"marks HTTP %s article denial permanently failed before any model call",
		async (status) => {
			const { service, fetcher, callModel, id } = await fixture(() => new Response("denied", { status }));
			await vi.waitFor(() => expect(service.store.item(id)?.status).toBe("failed"), { timeout: 1000 });
			const job = service.store.jobs().find((entry) => entry.kind === "analyze")!;
			expect(job.status).toBe("failed");
			expect(job.attempts).toBe(1);
			expect(job.error).toContain(`HTTP ${status}`);
			expect(job.error).toContain("请补充正文后重新处理");
			expect(service.store.item(id)?.originalBody).toBeNull();
			expect(callModel).not.toHaveBeenCalled();
			expect(service.store.receipts()).toHaveLength(0);
			await vi.waitFor(async () =>
				expect((await service.handle({ action: "snapshot" })).status.running).toBe(false),
			);
			service.store.updateJob({ ...job, nextAttemptAt: new Date(0).toISOString() });
			await service.handle({ action: "configure", patch: {} });
			await vi.waitFor(async () =>
				expect((await service.handle({ action: "snapshot" })).status.running).toBe(false),
			);
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);

	it.each([
		{
			label: "authoritative challenge header",
			html: `<html><body><main>${realBody}</main></body></html>`,
			headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
		},
		{
			label: "combined challenge markup",
			html: challenge,
			headers: { "cf-mitigated": "", "content-type": "text/html" },
		},
	])("does not send an HTTP200 $label to a model", async ({ html, headers }) => {
		const { service, callModel, id } = await fixture(() => new Response(html, { headers }));
		await vi.waitFor(() => expect(service.store.item(id)?.status).toBe("failed"), { timeout: 1000 });
		expect(service.store.item(id)?.error).toContain("HTTP 200");
		expect(service.store.item(id)?.originalBody).toBeNull();
		expect(callModel).not.toHaveBeenCalled();
		expect(service.store.receipts()).toHaveLength(0);
	});

	it("keeps server errors on the existing bounded retry policy", async () => {
		const { service, callModel, id } = await fixture(() => new Response("server failed", { status: 503 }));
		await vi.waitFor(() => expect(service.store.item(id)?.error).toContain("HTTP 503"));
		expect(service.store.item(id)?.status).toBe("pending");
		expect(service.store.jobs().find((entry) => entry.kind === "analyze")?.status).toBe("pending");
		expect(callModel).not.toHaveBeenCalled();
	});

	it("does not mistake an article mentioning Cloudflare or a generic moment title for a challenge", async () => {
		const html = `<html><head><title>Just a moment...</title></head><body><article>${realBody}<p>Cloudflare是本文讨论的CDN服务。示例代码可引用window._cf_chl_opt，但未构成挑战页。</p></article></body></html>`;
		const { service, callModel, id } = await fixture(
			() => new Response(html, { headers: { "content-type": "text/html" } }),
		);
		await vi.waitFor(() => expect(service.store.item(id)?.status).toBe("blocked"));
		expect(callModel).toHaveBeenCalledOnce();
		expect(service.store.item(id)?.originalBody).toContain(realBody);
	});

	it("imports real text into the same RSS URL as a new revision without rereading or paying for the failed job", async () => {
		const { service, fetcher, callModel, id, material } = await fixture(
			() => new Response("denied", { status: 403 }),
		);
		await vi.waitFor(() => expect(service.store.item(id)?.status).toBe("failed"), { timeout: 1000 });
		const failed = service.store.jobs().find((entry) => entry.kind === "analyze")!;
		expect(material.body).toBeUndefined();
		expect(
			(
				await service.handle({
					action: "ingest",
					sourceId: source.id,
					itemId: id,
					expectedRevision: 1,
					items: [{ title, url, body: realBody }],
				})
			).updated,
		).toBe(1);
		await vi.waitFor(() => expect(service.store.item(id)?.status).toBe("blocked"));
		expect(service.store.item(id)?.revision).toBe(2);
		expect(service.store.item(id)?.originalBody).toBe(realBody);
		expect(service.store.items().filter((item) => item.sourceId === source.id)).toHaveLength(1);
		expect(service.store.material(id)?.externalId).toBe("stable-article-guid");
		expect(service.store.material(id)?.publishedAt).toBe(material.publishedAt);
		expect(service.store.material(id)?.author).toBe("原作者");
		expect(service.store.item(id)?.selected).toBe(false);
		expect(service.store.item(id)?.fulltextAllowed).toBe(false);
		expect(await service.handle({ action: "adminItem", id })).toMatchObject({
			originalBody: null,
			body: null,
			fulltextAllowed: false,
			originalBodyAvailable: true,
		});
		service.store.editItem(id, { status: "ready", relevance: "pass" });
		expect(await service.handle({ action: "item", id })).toMatchObject({
			originalBody: null,
			body: null,
			fulltextAllowed: false,
			originalBodyAvailable: true,
		});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(callModel).toHaveBeenCalledOnce();
		expect(JSON.parse(callModel.mock.calls[0]![0].user).material.body).toBe(realBody);
		expect(service.store.receipts()).toHaveLength(1);
		expect(
			(
				await service.handle({
					action: "ingest",
					sourceId: source.id,
					itemId: id,
					expectedRevision: 2,
					items: [{ title, url, body: realBody }],
				})
			).ignored,
		).toBe(1);
		expect(service.store.item(id)?.revision).toBe(2);
		expect(service.store.jobs().find((entry) => entry.id === failed.id)?.status).toBe("failed");
		await service.handle({ action: "retry", jobId: failed.id });
		await vi.waitFor(() =>
			expect(service.store.jobs().find((entry) => entry.id === failed.id)?.status).toBe("completed"),
		);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(callModel).toHaveBeenCalledOnce();
		expect(service.store.receipts()).toHaveLength(1);
	});

	it.each(["", "   ", challenge])(
		"rejects an explicit empty or challenge body import before creating a revision: %s",
		async (body) => {
			const { service, id } = await fixture(() => new Response("denied", { status: 403 }));
			await expect(
				service.handle({
					action: "ingest",
					sourceId: source.id,
					itemId: id,
					expectedRevision: 1,
					items: [{ title, url, body }],
				}),
			).rejects.toThrow();
			expect(service.store.item(id)?.revision).toBe(1);
		},
	);

	it.each([
		{ label: "missing target", itemId: "missing", expectedRevision: 1, targetUrl: url },
		{ label: "outdated revision", expectedRevision: 2, targetUrl: url },
		{ label: "different URL", expectedRevision: 1, targetUrl: "https://example.com/other" },
	])(
		"rejects unsafe target body updates without modifying stored material: $label",
		async ({ itemId, expectedRevision, targetUrl }) => {
			const { service, id } = await fixture(() => new Response("denied", { status: 403 }));
			await expect(
				service.handle({
					action: "ingest",
					sourceId: source.id,
					itemId: itemId ?? id,
					expectedRevision,
					items: [{ title, url: targetUrl, body: realBody }],
				}),
			).rejects.toThrow();
			expect(service.store.item(id)?.revision).toBe(1);
			expect(service.store.item(id)?.originalBody).toBeNull();
			expect(service.store.items().filter((entry) => entry.sourceId === source.id)).toHaveLength(1);
		},
	);

	it("rejects a different source or multiple entries when a target item is specified", async () => {
		const { service, id } = await fixture(() => new Response("denied", { status: 403 }));
		await service.handle({ action: "saveSource", source: { ...source, id: "other-source" } });
		await expect(
			service.handle({
				action: "ingest",
				sourceId: "other-source",
				itemId: id,
				expectedRevision: 1,
				items: [{ title, url, body: realBody }],
			}),
		).rejects.toThrow();
		await expect(
			service.handle({
				action: "ingest",
				sourceId: source.id,
				itemId: id,
				expectedRevision: 1,
				items: [
					{ title, url, body: realBody },
					{ title, url, body: realBody },
				],
			}),
		).rejects.toThrow();
		expect(service.store.item(id)?.revision).toBe(1);
	});

	it("preserves ordinary ingest identity rules when no target is supplied", async () => {
		const { service, id } = await fixture(() => new Response("denied", { status: 403 }));
		const result = await service.handle({
			action: "ingest",
			sourceId: source.id,
			items: [{ title, url, body: realBody }],
		});
		expect(result.created).toBe(1);
		expect(service.store.item(id)?.revision).toBe(1);
		expect(service.store.items().filter((entry) => entry.sourceId === source.id)).toHaveLength(2);
	});

	it("accepts ordinary XML documentation containing a Cloudflare reference", async () => {
		const body =
			"<document><title>Cloudflare使用说明</title><description>XML中提及Cloudflare和挑战流程是文档内容。</description></document>";
		const { service, callModel, id } = await fixture(() => new Response("unused"), body);
		await vi.waitFor(() => expect(service.store.item(id)?.status).toBe("blocked"));
		expect(callModel).toHaveBeenCalledOnce();
		expect(service.store.item(id)?.originalBody).toBe(body);
	});
});
