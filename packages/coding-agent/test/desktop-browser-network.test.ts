import { EventEmitter } from "node:events";
import type { Page, Request, Response } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserNetworkJournal } from "../src/modes/desktop/browser-network.ts";

interface RequestOptions {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	body?: Buffer;
	failure?: string;
	redirectedFrom?: Request;
}

function fakeRequest(options: RequestOptions = {}) {
	const postDataBuffer = vi.fn(() => options.body ?? null);
	const timing = vi.fn(() => ({
		startTime: 1000,
		domainLookupStart: -1,
		domainLookupEnd: -1,
		connectStart: -1,
		secureConnectionStart: -1,
		connectEnd: -1,
		requestStart: 0,
		responseStart: 10,
		responseEnd: 90,
	}));
	const methods: Pick<
		Request,
		"url" | "method" | "resourceType" | "redirectedFrom" | "timing" | "headers" | "postDataBuffer" | "failure"
	> = {
		url: () => options.url ?? "https://example.test/api/save",
		method: () => options.method ?? "GET",
		resourceType: () => "fetch",
		redirectedFrom: () => options.redirectedFrom ?? null,
		timing,
		headers: () => options.headers ?? {},
		postDataBuffer,
		failure: () => (options.failure ? { errorText: options.failure } : null),
	};
	return { request: methods as Request, postDataBuffer, timing };
}

function fakeResponse(
	request: Request,
	options: { status?: number; headers?: Record<string, string>; body?: Buffer; unavailable?: boolean } = {},
) {
	const body = vi.fn(async () => {
		if (options.unavailable) throw new Error("The target has been closed token=upstream-secret");
		return options.body ?? Buffer.from('{"ok":true}');
	});
	const methods: Pick<Response, "request" | "status" | "headers" | "body"> = {
		request: () => request,
		status: () => options.status ?? 200,
		headers: () => options.headers ?? { "content-type": "application/json" },
		body,
	};
	return { response: methods as Response, body };
}

describe("desktop browser network journal", () => {
	let page: EventEmitter;
	let journal: BrowserNetworkJournal;

	beforeEach(() => {
		page = new EventEmitter();
		journal = new BrowserNetworkJournal(page as unknown as Page);
	});

	afterEach(() => journal.dispose());

	it("tracks request, response, and completion without reading any body", () => {
		const { request, postDataBuffer } = fakeRequest();
		const { response, body } = fakeResponse(request);
		page.emit("request", request);
		expect(journal.list().requests[0]).toMatchObject({ status: null, state: "pending", durationMs: null });
		page.emit("response", response);
		expect(journal.list().requests[0]).toMatchObject({ status: 200, state: "response", durationMs: null });
		page.emit("requestfinished", request);
		expect(journal.list().requests[0]).toMatchObject({
			requestId: "1",
			sequence: 1,
			method: "GET",
			resourceType: "fetch",
			startedAt: 1000,
			status: 200,
			state: "finished",
			durationMs: 90,
		});
		expect(postDataBuffer).not.toHaveBeenCalled();
		expect(body).not.toHaveBeenCalled();
	});

	it("distinguishes HTTP errors from transport failures and preserves response status", () => {
		const http = fakeRequest();
		page.emit("request", http.request);
		page.emit("response", fakeResponse(http.request, { status: 503 }).response);
		page.emit("requestfinished", http.request);
		const failed = fakeRequest({
			failure: "failed at https://user:password@example.test/?token=hidden&x=1 Authorization: Bearer another-secret",
		});
		page.emit("request", failed.request);
		page.emit("response", fakeResponse(failed.request, { status: 200 }).response);
		page.emit("requestfailed", failed.request);
		expect(journal.list({ status: 503 }).requests[0]).toMatchObject({ state: "finished", failure: null });
		const failure = journal.list({ failed: true }).requests[0];
		expect(failure).toMatchObject({ state: "failed", status: 200, durationMs: 90 });
		for (const secret of ["password", "hidden", "another-secret"]) expect(failure.failure).not.toContain(secret);
	});

	it("records redirect chains as separate requests", () => {
		const first = fakeRequest({ url: "http://example.test/old" });
		const second = fakeRequest({ url: "https://example.test/new", redirectedFrom: first.request });
		page.emit("request", first.request);
		page.emit("response", fakeResponse(first.request, { status: 302 }).response);
		page.emit("requestfinished", first.request);
		page.emit("request", second.request);
		expect(journal.list().requests.map(({ requestId, redirectedFrom }) => ({ requestId, redirectedFrom }))).toEqual([
			{ requestId: "1", redirectedFrom: null },
			{ requestId: "2", redirectedFrom: "1" },
		]);
	});

	it("paginates filtered results and reports eviction without returning internal references", async () => {
		journal.dispose();
		journal = new BrowserNetworkJournal(page as unknown as Page, { maxEntries: 3 });
		for (let index = 0; index < 5; index++) {
			const { request } = fakeRequest({ url: `https://example.test/api/${index}` });
			page.emit("request", request);
			page.emit("response", fakeResponse(request, { status: index % 2 === 0 ? 500 : 200 }).response);
		}
		const first = journal.list({ status: 500, url: "/API/", limit: 1 });
		expect(first).toMatchObject({ cursor: 3, oldestSequence: 3, dropped: 2, truncated: true });
		const second = journal.list({ status: 500, since: first.cursor, limit: 1 });
		expect(second).toMatchObject({ cursor: 5, truncated: false });
		expect(second.requests[0].sequence).toBe(5);
		first.requests[0].url = "mutation";
		expect(journal.list().requests[0].url).not.toBe("mutation");
		await expect(journal.detail("1")).rejects.toThrow("evicted");
		expect(journal.list({ url: "no-match", since: 3 }).cursor).toBe(5);
	});

	it("bounds retention and list size even with oversized user limits", () => {
		journal.dispose();
		journal = new BrowserNetworkJournal(page as unknown as Page, { maxEntries: 10_000 });
		for (let index = 0; index < 305; index++) page.emit("request", fakeRequest().request);
		expect(journal.list({ limit: 10_000 })).toMatchObject({
			dropped: 5,
			oldestSequence: 6,
			truncated: true,
			limits: { maxEntries: 300, maxReturned: 100 },
		});
		expect(journal.list({ limit: Number.NaN }).requests).toHaveLength(50);
	});

	it("redacts query, credentials, fragments, and headers while marking header incompleteness", async () => {
		const { request, postDataBuffer } = fakeRequest({
			url: "https://user:pw@example.test/api?api-key=key-value&token=first&token=second&x=ok#access_token=hash-secret",
			headers: {
				authorization: "Bearer bearer-secret",
				cookie: "sid=cookie-secret",
				"x-api-key": "header-secret",
				referer: "https://example.test/?password=referer-secret",
				"content-type": "application/json",
			},
		});
		const { response, body } = fakeResponse(request, {
			headers: { "set-cookie": "sid=response-secret", "content-type": "application/json" },
		});
		page.emit("request", request);
		page.emit("response", response);
		const detail = await journal.detail("1");
		const serialized = JSON.stringify(detail);
		for (const secret of [
			"key-value",
			"first",
			"second",
			"hash-secret",
			"bearer-secret",
			"cookie-secret",
			"header-secret",
			"referer-secret",
			"response-secret",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(detail.requestHeaders).toMatchObject({ complete: false, values: { authorization: "[REDACTED]" } });
		expect(detail.requestBody.state).toBe("not_requested");
		expect(detail.responseBody.state).toBe("not_requested");
		expect(postDataBuffer).not.toHaveBeenCalled();
		expect(body).not.toHaveBeenCalled();
	});

	it("redacts nested JSON secret fields and embedded credentials before truncating", async () => {
		const source = JSON.stringify({
			password: "never-expose",
			items: [{ access_token: "nested-secret", ordinary: "ok" }],
			note: "Bearer text-secret",
			url: "https://u:p@example.test/?api_key=url-secret",
			message: "x".repeat(200),
		});
		const { request } = fakeRequest({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: Buffer.from(source),
		});
		const response = fakeResponse(request, { body: Buffer.from(source) });
		page.emit("request", request);
		page.emit("response", response.response);
		page.emit("requestfinished", request);
		const detail = await journal.detail("1", {
			includeRequestBody: true,
			includeResponseBody: true,
			maxBodyChars: 150,
		});
		for (const body of [detail.requestBody, detail.responseBody]) {
			expect(body).toMatchObject({ state: "available", truncated: true, sourceBytes: Buffer.byteLength(source) });
			expect(body.text).toHaveLength(150);
			for (const secret of ["never-expose", "nested-secret", "text-secret", "url-secret"])
				expect(body.text).not.toContain(secret);
		}
	});

	it("redacts form fields and refuses binary bodies", async () => {
		const form = fakeRequest({
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: Buffer.from("user=test&password=form-secret&api%5Fkey=key-secret"),
		});
		page.emit("request", form.request);
		const formBody = (await journal.detail("1", { includeRequestBody: true })).requestBody;
		expect(formBody.state).toBe("available");
		expect(formBody.text).toContain("user=test");
		expect(formBody.text).not.toContain("form-secret");
		expect(formBody.text).not.toContain("key-secret");
		const binary = fakeRequest({ headers: { "content-type": "image/png" }, body: Buffer.from([1, 0, 2]) });
		page.emit("request", binary.request);
		expect((await journal.detail("2", { includeRequestBody: true })).requestBody.state).toBe("binary");
		expect(binary.postDataBuffer).not.toHaveBeenCalled();
	});

	it("refuses declared oversized bodies before reading and checks unknown sizes after reading", async () => {
		const request = fakeRequest({ headers: { "content-type": "text/plain", "content-length": "262145" } });
		const declared = fakeResponse(request.request, {
			headers: { "content-type": "text/plain", "content-length": "262145" },
		});
		page.emit("request", request.request);
		page.emit("response", declared.response);
		page.emit("requestfinished", request.request);
		const detail = await journal.detail("1", { includeRequestBody: true, includeResponseBody: true });
		expect(detail.requestBody).toMatchObject({ state: "too_large", reason: "declared_body_byte_limit" });
		expect(detail.responseBody).toMatchObject({ state: "too_large", reason: "declared_body_byte_limit" });
		expect(request.postDataBuffer).not.toHaveBeenCalled();
		expect(declared.body).not.toHaveBeenCalled();
		const unknown = fakeRequest();
		const actual = fakeResponse(unknown.request, { body: Buffer.alloc(262145, "x") });
		page.emit("request", unknown.request);
		page.emit("response", actual.response);
		page.emit("requestfinished", unknown.request);
		const tooLarge = await journal.detail("2", { includeResponseBody: true });
		expect(tooLarge.responseBody).toMatchObject({
			state: "too_large",
			sourceBytes: 262145,
			reason: "source_body_byte_limit",
		});
		expect(tooLarge.limits.bodyReadMode).toContain("after reading");
	});

	it("reports unfinished, unavailable, unknown content, and invalid JSON bodies explicitly", async () => {
		const pending = fakeRequest();
		page.emit("request", pending.request);
		expect(await journal.detail("1", { includeRequestBody: true, includeResponseBody: true })).toMatchObject({
			requestBody: { state: "none", sourceBytes: 0 },
			responseBody: { state: "pending", reason: "request_not_finished" },
		});
		const unavailable = fakeResponse(pending.request, { unavailable: true });
		page.emit("response", unavailable.response);
		page.emit("requestfinished", pending.request);
		expect((await journal.detail("1", { includeResponseBody: true })).responseBody).toMatchObject({
			state: "unavailable",
		});
		for (const [headers, body] of [
			[{}, "password=raw-secret"],
			[{ "content-type": "application/json" }, '{"token":"unfinished-secret'],
		] as const) {
			const item = fakeRequest();
			page.emit("request", item.request);
			page.emit("response", fakeResponse(item.request, { headers, body: Buffer.from(body) }).response);
			page.emit("requestfinished", item.request);
			const id = journal.list().requests.at(-1)?.requestId ?? "";
			expect((await journal.detail(id, { includeResponseBody: true })).responseBody.state).toBe("unsupported");
		}
	});

	it("returns an empty body for HEAD/204 and caps requested text output", async () => {
		const head = fakeRequest({ method: "HEAD" });
		const headResponse = fakeResponse(head.request, { status: 204 });
		page.emit("request", head.request);
		page.emit("response", headResponse.response);
		page.emit("requestfinished", head.request);
		expect((await journal.detail("1", { includeResponseBody: true })).responseBody.state).toBe("none");
		expect(headResponse.body).not.toHaveBeenCalled();
		const plain = fakeRequest();
		page.emit("request", plain.request);
		page.emit(
			"response",
			fakeResponse(plain.request, { headers: { "content-type": "text/plain" }, body: Buffer.alloc(40000, "x") })
				.response,
		);
		page.emit("requestfinished", plain.request);
		expect(
			(await journal.detail("2", { includeResponseBody: true, maxBodyChars: 1_000_000 })).responseBody.text,
		).toHaveLength(32768);
	});

	it("bounds metadata and removes all listeners and retained references on disposal", async () => {
		const request = fakeRequest({
			url: `https://example.test/${"x".repeat(3000)}`,
			headers: { "x-large": "x".repeat(3000) },
		});
		page.emit("request", request.request);
		const detail = await journal.detail("1");
		expect(detail.request.url).toHaveLength(2048);
		expect(detail.request.truncated).toBe(true);
		expect(detail.requestHeaders).toMatchObject({ truncated: true });
		expect(detail.requestHeaders.values["x-large"]).toHaveLength(2048);
		journal.dispose();
		journal.dispose();
		for (const event of ["request", "response", "requestfailed", "requestfinished"])
			expect(page.listenerCount(event)).toBe(0);
		page.emit("request", fakeRequest().request);
		expect(journal.list().requests).toHaveLength(0);
		await expect(journal.detail("1")).rejects.toThrow("not found");
	});
});
