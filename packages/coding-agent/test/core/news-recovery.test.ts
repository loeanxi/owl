import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NEWS_CONFIGURATION } from "../../src/core/news/industry.ts";
import { NewsService } from "../../src/core/news/service.ts";
import { collectNewsSource } from "../../src/core/news/sources.ts";
import { NewsStore, newsHash } from "../../src/core/news/store.ts";
import type {
	NewsAnalysis,
	NewsModelCaller,
	NewsModelResponse,
	NewsReport,
	NewsSourceInput,
} from "../../src/core/news/types.ts";

const directories: string[] = [];
function temporary() {
	const path = mkdtempSync(join(tmpdir(), "owl-news-recovery-"));
	directories.push(path);
	return path;
}
afterEach(() => {
	vi.useRealTimers();
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const source: NewsSourceInput = {
	id: "test",
	name: "测试资料",
	kind: "external",
	config: {},
	tier: "T1",
	participation: "editorial",
	enabled: false,
	intervalMinutes: 30,
	siteFulltext: true,
	syndicateFulltext: false,
};
function modelResponse(capability: string): NewsModelResponse {
	const payload: Record<string, unknown> = {
		prefilter: { label: "PASS", reason: "相关" },
		score: { attentionScore: 80 },
		structure: {
			scope: "single",
			category: "launch",
			tags: [],
			subjects: [],
			fact: { title: "发布新模型", subject: "模型", action: "发布", object: "新模型", evidence: "发布新模型" },
		},
		understand: { titleZh: "发布新模型", summaryZh: "原文说明发布新模型。" },
		summarize: { titleZh: "发布新模型", summaryZh: "原文说明发布新模型。" },
		digest: { title: "发布新模型", digest: "原文说明发布新模型。" },
	};
	return {
		text: JSON.stringify(payload[capability] ?? {}),
		provider: "fake",
		model: "fake",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: null },
	};
}
const analysis: NewsAnalysis = {
	relevance: "pass",
	scores: [80, 80],
	score: 80,
	selectionCandidate: true,
	title: "发布新模型",
	summary: "发布新模型。",
	reason: "",
	category: "launch",
	tags: [],
	entities: [],
	contentKind: "single",
	fact: { subject: "模型", action: "发布", object: "新模型", occurredAt: null, evidence: ["发布新模型"] },
};
async function configureAndIngest(service: NewsService) {
	await service.handle({ action: "saveSource", source });
	await service.handle({ action: "configure", patch: { modelCallsEnabled: true } });
	await service.handle({
		action: "ingest",
		sourceId: source.id,
		items: [
			{
				title: "发布新模型",
				url: "https://example.com/a",
				body: "发布新模型并说明技术细节。",
				publishedAt: new Date().toISOString(),
			},
		],
	});
}

describe("news known/unknown payment recovery", () => {
	it("releases only the malformed structure response on explicit retry and retains every paid output", async () => {
		let malformed = true;
		const calls = vi.fn<NewsModelCaller>(async (request) => {
			if (request.capability === "structure" && malformed) {
				malformed = false;
				return { ...modelResponse("structure"), text: "{" };
			}
			return modelResponse(request.capability);
		});
		const service = new NewsService({
			agentDir: temporary(),
			callModel: calls,
			resolveModel: async () => ({ provider: "fake", id: "fake" }),
		});
		try {
			await configureAndIngest(service);
			service.start();
			await vi.waitFor(async () =>
				expect((await service.handle({ action: "adminItems", status: "failed" })).total).toBe(1),
			);
			const receipts = await service.handle({ action: "receipts" });
			expect(receipts.filter((receipt) => receipt.error).map((receipt) => receipt.capability)).toEqual([
				"structure",
			]);
			expect(receipts.find((receipt) => receipt.capability === "structure")?.status).toBe("received");
			expect(calls).toHaveBeenCalledTimes(4);
			const itemId = service.store.items()[0]!.id;
			await service.handle({ action: "retry", itemId });
			await vi.waitFor(async () => expect((await service.handle({ action: "list" })).total).toBe(1));
			const after = await service.handle({ action: "receipts" });
			const structure = after.find((receipt) => receipt.capability === "structure")!;
			expect(structure.attempts).toBe(2);
			expect(structure.model).toBe("fake/fake");
			expect(after.filter((receipt) => receipt.capability === "score").map((receipt) => receipt.attempts)).toEqual([
				1, 1,
			]);
			const audit = new DatabaseSync(service.store.path, { readOnly: true });
			try {
				expect(
					audit.prepare("SELECT count(*) AS n FROM news_receipt_outputs WHERE receipt_id=?").get(structure.id)?.n,
				).toBe(2);
			} finally {
				audit.close();
			}
		} finally {
			await service.close();
		}
	});
	it("keeps transport ambiguity unpaid on normal retry until that receipt is explicitly released", async () => {
		let fail = true;
		const calls = vi.fn<NewsModelCaller>(async (request) => {
			if (fail) {
				fail = false;
				throw new Error("connection lost after send");
			}
			return modelResponse(request.capability);
		});
		const service = new NewsService({
			agentDir: temporary(),
			callModel: calls,
			resolveModel: async () => ({ provider: "fake", id: "fake" }),
		});
		try {
			await configureAndIngest(service);
			service.start();
			await vi.waitFor(async () =>
				expect((await service.handle({ action: "receipts" }))[0]?.status).toBe("unknown"),
			);
			const id = service.store.items()[0]!.id;
			await service.handle({ action: "retry", itemId: id });
			await vi.waitFor(async () =>
				expect((await service.handle({ action: "adminItems", status: "failed" })).total).toBe(1),
			);
			expect(calls).toHaveBeenCalledTimes(1);
			await service.handle({ action: "retry", receiptId: (await service.handle({ action: "receipts" }))[0]!.id });
			await vi.waitFor(async () => expect((await service.handle({ action: "list" })).total).toBe(1));
		} finally {
			await service.close();
		}
	});
	it("does not let an old late response overwrite a manually authorized newer attempt", () => {
		const store = new NewsStore(join(temporary(), "news.sqlite"));
		try {
			const first = store.beginReceipt("same", "score", "item:a:1", "fake", DEFAULT_NEWS_CONFIGURATION.budget);
			store.setReceiptState(first.receipt.id, "unknown");
			store.setReceiptState(first.receipt.id, "failed");
			const next = store.beginReceipt("same", "score", "item:a:1", "fake", DEFAULT_NEWS_CONFIGURATION.budget);
			store.receiveReceipt(first.receipt.id, { old: true }, null, 1);
			store.setReceiptState(first.receipt.id, "unknown", "late", 1);
			expect(store.receipt(next.receipt.id)?.status).toBe("pending");
			store.receiveReceipt(next.receipt.id, { current: true }, null, 2);
			expect(store.receipt(next.receipt.id)?.response).toEqual({ current: true });
		} finally {
			store.close();
		}
	});
	it("renews a lease throughout a long call and graceful shutdown while a second process cannot reclaim", async () => {
		vi.useFakeTimers();
		let release: (() => void) | undefined;
		const calls: NewsModelCaller = async (request) =>
			request.capability === "prefilter"
				? new Promise((resolve) => {
						release = () => resolve(modelResponse("prefilter"));
					})
				: modelResponse(request.capability);
		const service = new NewsService({
			agentDir: temporary(),
			callModel: calls,
			resolveModel: async () => ({ provider: "fake", id: "fake" }),
		});
		const other = new NewsStore(service.store.path);
		let closed = false;
		try {
			await configureAndIngest(service);
			service.start();
			await vi.advanceTimersByTimeAsync(1);
			expect(release).toBeTypeOf("function");
			await vi.advanceTimersByTimeAsync(40000);
			expect(other.acquireLease("second")).toBe(false);
			const closing = service.close();
			await vi.advanceTimersByTimeAsync(40000);
			expect(other.acquireLease("second")).toBe(false);
			release!();
			await closing;
			closed = true;
			expect(other.acquireLease("second")).toBe(true);
		} finally {
			release?.();
			if (!closed) await service.close();
			other.close();
			vi.useRealTimers();
		}
	});
});

describe("news live publication filtering", () => {
	it("keeps snapshots while removing withdrawn cached leads, orphan related groups and stale story digests", async () => {
		const service = new NewsService({
			agentDir: temporary(),
			callModel: async (request) => modelResponse(request.capability),
		});
		try {
			const origin = service.store.saveSource(source);
			const a = service.store.ingest(origin, {
				title: "撤回报道",
				url: "https://example.com/withdraw",
				body: "撤回正文",
			}).item;
			const b = service.store.ingest(origin, {
				title: "保留报道",
				url: "https://example.com/keep",
				body: "保留正文",
			}).item;
			service.store.commitAnalysis(a.id, 1, { ...analysis, title: "撤回报道", summary: "撤回摘要" });
			service.store.commitAnalysis(b.id, 1, { ...analysis, title: "保留报道", summary: "保留摘要" });
			service.store.editItem(a.id, { selected: true, novel: true });
			service.store.editItem(b.id, { selected: true, novel: true });
			service.store.saveStory({
				id: "event",
				title: "撤回报道",
				summary: "旧摘要包含撤回报道",
				category: "launch",
				tags: [],
				entities: [],
				createdAt: a.publishedAt,
				updatedAt: a.publishedAt,
				reports: [],
				sourceCount: 2,
				manual: false,
				relatedStoryIds: [],
			});
			service.store.moveItem(a.id, "event");
			service.store.moveItem(b.id, "event");
			service.store.setMeta(
				"story-digest:event",
				newsHash(
					service.store.story("event")!.reports.map((item) => [item.id, item.revision, item.title, item.summary]),
				),
			);
			const report: NewsReport = {
				id: "daily:2026-01-01",
				kind: "daily",
				key: "2026-01-01",
				periodStart: a.publishedAt,
				periodEnd: a.publishedAt,
				title: "测试日报",
				lead: "撤回报道\n撤回摘要",
				leadItemId: a.id,
				highlights: [a.id, b.id],
				sections: [
					{ label: "栏目", summary: "撤回摘要", items: [service.store.item(a.id)!, service.store.item(b.id)!] },
				],
				briefs: [],
				relatedItems: { [a.id]: [service.store.item(b.id)!] },
				createdAt: a.publishedAt,
				sourceCount: 9,
				storyCount: 9,
			};
			service.store.saveReport(report);
			service.store.editItem(a.id, { withdrawn: true });
			const projected = await service.handle({ action: "report", kind: "daily", key: report.key });
			expect(JSON.stringify(projected)).not.toContain("撤回摘要");
			expect(projected?.lead).toContain("保留报道");
			expect(projected?.relatedItems).toEqual({});
			expect(projected?.sourceCount).toBe(1);
			expect(projected?.storyCount).toBe(1);
			expect(service.store.reports()[0]?.lead).toContain("撤回报道");
			expect((await service.handle({ action: "story", id: "event" }))?.summary).toBe("保留摘要");
			expect((await service.handle({ action: "adminItems", status: "withdrawn" })).items[0]?.id).toBe(a.id);
			await service.handle({ action: "saveSource", source: { ...source, siteFulltext: false } });
			const masked = await service.handle({ action: "report", kind: "daily", key: report.key });
			expect(masked?.sections[0]?.items[0]?.body).toBeNull();
			expect(masked?.sections[0]?.items[0]?.originalBody).toBeNull();
		} finally {
			await service.close();
		}
	});
	it("collects Dajiala history and body through two bounded paid calls", async () => {
		const fake = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						code: 0,
						data: [{ title: "公众号资讯", url: "https://mp.weixin.qq.com/s/article", post_time: 1760000000 }],
					}),
				),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, content: "<p>实际正文</p>" })));
		const paid = vi.fn(async (_purpose: string, _identity: unknown, run: () => Promise<unknown>) => run());
		const items = await collectNewsSource(
			{ ...source, kind: "mp_account", config: { ghid: "fake-account" } },
			{ fetch: fake, resolveHost: async () => ["8.8.8.8"], secrets: { DAJIALA_KEY: "fake-only" }, paid },
		);
		expect(items[0]?.body).toBe("实际正文");
		expect(paid).toHaveBeenCalledTimes(2);
	});
});
