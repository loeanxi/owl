import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsStore, NewsUnknownReceiptError } from "../../src/core/news/store.ts";
import type { NewsSourceInput } from "../../src/core/news/types.ts";

const directories: string[] = [];
const stores: NewsStore[] = [];
const budget = { perMinute: 30, perHour: 100, perDay: 300 };
function open(path?: string): NewsStore {
	if (!path) {
		const directory = mkdtempSync(join(tmpdir(), "owl-news-response-cache-"));
		directories.push(directory);
		path = join(directory, "news.sqlite");
	}
	const store = new NewsStore(path);
	stores.push(store);
	return store;
}
afterEach(() => {
	vi.useRealTimers();
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) {
		if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
			throw new Error("Cleanup escaped the temporary directory");
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("news independent response cache", () => {
	it("prunes expired cache entries by their last validated write without deleting payment evidence", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const store = open();
		store.saveResponseCache("old", { value: "expired" });
		store.saveResponseCache("refreshed", { value: "old" });
		const receipt = store.beginReceipt("old-paid-call", "score", "source:original", "fake/model", budget);
		store.receiveReceipt(receipt.receipt.id, { text: "paid evidence" });
		const before = store.receipt(receipt.receipt.id);
		vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
		store.saveResponseCache("boundary", { value: "keep" });
		vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
		store.saveResponseCache("refreshed", { value: "new" });
		expect(store.pruneResponseCache("2026-01-05T00:00:00Z")).toBe(1);
		expect(store.cachedResponse("old")).toBeNull();
		expect(store.cachedResponse("refreshed")).toEqual({ value: "new" });
		expect(store.cachedResponse("boundary")).toEqual({ value: "keep" });
		expect(store.pruneResponseCache("2026-01-05T00:00:00Z")).toBe(0);
		expect(store.receipt(receipt.receipt.id)).toEqual(before);
	});
	it("returns null on a miss and stores false/zero without treating them as misses", () => {
		const store = open();
		expect(store.cachedResponse("missing")).toBeNull();
		store.saveResponseCache("false", false);
		store.saveResponseCache("zero", 0);
		expect(store.cachedResponse("false")).toBe(false);
		expect(store.cachedResponse("zero")).toBe(0);
	});
	it("persists a response through reopening an existing database and overwrites only its key", () => {
		let store = open();
		const path = store.path;
		store.saveResponseCache("validated-score", { attentionScore: 80 });
		store.saveResponseCache("other", ["keep"]);
		store.close();
		stores.splice(stores.indexOf(store), 1);
		store = open(path);
		expect(store.cachedResponse("validated-score")).toEqual({ attentionScore: 80 });
		store.saveResponseCache("validated-score", { attentionScore: 82 });
		expect(store.cachedResponse("validated-score")).toEqual({ attentionScore: 82 });
		expect(store.cachedResponse("other")).toEqual(["keep"]);
	});
	it("takes JSON snapshots rather than allowing mutations of input or returned objects to change the stored response", () => {
		const store = open();
		const response = { text: "validated", nested: { tags: ["AI"] } };
		store.saveResponseCache("copy", response);
		response.nested.tags.push("changed");
		const copy = store.cachedResponse("copy") as typeof response;
		copy.nested.tags.push("mutated");
		expect(store.cachedResponse("copy")).toEqual({ text: "validated", nested: { tags: ["AI"] } });
	});
	it("deletes one key safely and leaves source identity, paid responses and replay behavior unchanged", () => {
		const store = open();
		const source: NewsSourceInput = {
			id: "source-a",
			name: "测试源",
			kind: "external",
			config: {},
			tier: "T1",
			participation: "editorial",
			enabled: false,
			intervalMinutes: 30,
			siteFulltext: false,
			syndicateFulltext: false,
		};
		const savedSource = store.saveSource(source);
		const receipt = store.beginReceipt("paid-key", "score", "source:source-a", "fake/model", budget);
		const paidResponse = {
			text: '{"attentionScore":80}',
			usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, cost: null },
		};
		store.receiveReceipt(receipt.receipt.id, paidResponse, paidResponse.usage);
		store.completeReceipts("source:source-a");
		const paidBefore = store.receipt(receipt.receipt.id);
		const key = "key' OR 1=1 --";
		store.saveResponseCache(key, paidResponse);
		store.saveResponseCache("keep", { attentionScore: 90 });
		store.deleteResponseCache(key);
		expect(store.cachedResponse(key)).toBeNull();
		expect(store.cachedResponse("keep")).toEqual({ attentionScore: 90 });
		expect(store.source(savedSource.id)).toEqual(savedSource);
		expect(store.receipt(receipt.receipt.id)).toEqual(paidBefore);
		expect(store.beginReceipt("paid-key", "score", "source:source-a", "fake/model", budget).cached).toBe(true);
	});
	it("never automatically admits received/completed or pending/failed/unknown receipts to reusable cache", () => {
		const store = open();
		for (const status of ["pending", "received", "completed", "failed", "unknown"] as const) {
			const receipt = store.beginReceipt(status, "score", `item:${status}`, "fake/model", budget);
			if (status === "received" || status === "completed")
				store.receiveReceipt(receipt.receipt.id, { text: "unvalidated" });
			if (status === "completed") store.completeReceipts(`item:${status}`);
			if (status === "failed" || status === "unknown") store.setReceiptState(receipt.receipt.id, status);
			expect(store.cachedResponse(status)).toBeNull();
		}
		store.saveResponseCache("unknown", { validated: true });
		expect(() => store.beginReceipt("unknown", "score", "item:unknown", "fake/model", budget)).toThrow(
			NewsUnknownReceiptError,
		);
	});
	it("rejects an unserializable value without replacing a valid cached response", () => {
		const store = open();
		store.saveResponseCache("valid", { text: "keep" });
		expect(() => store.saveResponseCache("valid", undefined)).toThrow("JSON");
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => store.saveResponseCache("valid", circular)).toThrow();
		expect(store.cachedResponse("valid")).toEqual({ text: "keep" });
	});
});
