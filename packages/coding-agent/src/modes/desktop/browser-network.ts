import type { Page, Request, Response } from "playwright-core";

const MAX_ENTRIES = 300;
const MAX_LIST = 100;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 32 * 1024;
const MAX_HEADER_CHARS = 16 * 1024;
const REDACTED = "[REDACTED]";

export interface BrowserNetworkListOptions {
	since?: number;
	limit?: number;
	/** Case-insensitive substring match against the redacted URL. */
	url?: string;
	status?: number;
	failed?: boolean;
}

export interface BrowserNetworkDetailOptions {
	includeRequestBody?: boolean;
	includeResponseBody?: boolean;
	maxBodyChars?: number;
}

export interface BrowserNetworkSummary {
	requestId: string;
	sequence: number;
	method: string;
	url: string;
	status: number | null;
	startedAt: number;
	durationMs: number | null;
	state: "pending" | "response" | "finished" | "failed";
	failure: string | null;
	resourceType: string;
	redirectedFrom: string | null;
	/** The URL or failure message exceeded the metadata budget. */
	truncated: boolean;
}

export interface BrowserNetworkBody {
	state: "not_requested" | "available" | "none" | "pending" | "unavailable" | "binary" | "too_large" | "unsupported";
	text?: string;
	/** True when the returned text is a prefix, rather than the complete redacted body. */
	truncated: boolean;
	sourceBytes: number | null;
	reason?: string;
}

export interface BrowserNetworkHeaders {
	values: Record<string, string>;
	/** Playwright's synchronous headers omit some security headers. */
	complete: false;
	truncated: boolean;
}

interface NetworkEntry {
	summary: BrowserNetworkSummary;
	request: Request;
	response: Response | null;
	requestHeaders: BrowserNetworkHeaders;
	responseHeaders: BrowserNetworkHeaders | null;
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(Math.floor(value), maximum));
}

function secretKey(key: string): boolean {
	return /auth|cookie|password|passwd|passphrase|token|apikey|secret|credential|sessionid|csrf|xsrf/.test(
		key.toLowerCase().replace(/[^a-z0-9]/g, ""),
	);
}

/** Redact labelled credentials in plain text as well as strings embedded in JSON. */
function safeText(text: string, depth = 0): string {
	return text
		.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (value) => safeUrl(value, depth + 1))
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, `$1 ${REDACTED}`)
		.replace(
			/(["']?[a-z0-9_-]*(?:auth|cookie|password|passwd|passphrase|token|api[-_]?key|secret|credential|session[-_]?id|csrf|xsrf)[a-z0-9_-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&<>]+)/gi,
			(_match, prefix: string) => `${prefix}"${REDACTED}"`,
		);
}

function safeUrl(value: string, depth = 0): string {
	if (depth > 4) return "[nested URL omitted]";
	try {
		const url = new URL(value);
		if (url.protocol === "data:") return "data:[body omitted]";
		url.username = "";
		url.password = "";
		url.hash = "";
		const parameters = [...url.searchParams.entries()];
		url.search = "";
		for (const [key, content] of parameters) {
			url.searchParams.append(key, secretKey(key) ? REDACTED : safeText(content, depth));
		}
		return url.toString();
	} catch {
		return "[invalid URL omitted]";
	}
}

function safeHeaders(raw: Record<string, string>): BrowserNetworkHeaders {
	const values: Record<string, string> = {};
	let remaining = MAX_HEADER_CHARS;
	let truncated = false;
	for (const [key, value] of Object.entries(raw)) {
		if (key.length > 256 || remaining <= key.length || Object.keys(values).length >= 100) {
			truncated = true;
			continue;
		}
		const safe = secretKey(key)
			? REDACTED
			: /^(location|content-location|referer|origin)$/i.test(key)
				? safeUrl(value)
				: safeText(value);
		const limit = Math.min(2048, remaining - key.length);
		values[key.toLowerCase()] = safe.slice(0, limit);
		remaining -= key.length + values[key.toLowerCase()].length;
		if (safe.length > limit) truncated = true;
	}
	return { values, complete: false, truncated };
}

function redactedJson(value: unknown, depth = 0): unknown {
	if (depth > 64) throw new Error("JSON nesting exceeds the redaction budget");
	if (typeof value === "string") return safeText(value);
	if (Array.isArray(value)) return value.map((item) => redactedJson(item, depth + 1));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, secretKey(key) ? REDACTED : redactedJson(item, depth + 1)]),
	);
}

function bodyResult(
	state: BrowserNetworkBody["state"],
	sourceBytes: number | null,
	reason?: string,
): BrowserNetworkBody {
	return { state, truncated: false, sourceBytes, ...(reason ? { reason } : {}) };
}

function formatBody(buffer: Buffer, contentType: string, maxChars: number): BrowserNetworkBody {
	if (buffer.length > MAX_BODY_BYTES) return bodyResult("too_large", buffer.length, "source_body_byte_limit");
	if (buffer.length === 0) return bodyResult("none", 0);
	if (buffer.includes(0)) return bodyResult("binary", buffer.length, "binary_content");
	const source = buffer.toString("utf8");
	let text: string;
	try {
		if (/\bjson\b|\+json\b/i.test(contentType)) {
			text = JSON.stringify(redactedJson(JSON.parse(source)));
		} else if (/application\/x-www-form-urlencoded/i.test(contentType)) {
			const parameters = new URLSearchParams(source);
			text = [...parameters.entries()]
				.map(
					([key, value]) =>
						`${encodeURIComponent(key)}=${encodeURIComponent(secretKey(key) ? REDACTED : safeText(value))}`,
				)
				.join("&");
		} else {
			text = safeText(source);
		}
	} catch {
		return bodyResult("unsupported", buffer.length, "body_cannot_be_safely_parsed");
	}
	return {
		state: "available",
		text: text.slice(0, maxChars),
		truncated: text.length > maxChars,
		sourceBytes: buffer.length,
	};
}

function bodyType(headers: BrowserNetworkHeaders): { type: string; declaredBytes: number | null } {
	const type = headers.values["content-type"] ?? "";
	const length = headers.values["content-length"];
	const declaredBytes = length && /^\d+$/.test(length) ? Number(length) : null;
	return { type, declaredBytes };
}

function bodyPreflight(headers: BrowserNetworkHeaders): BrowserNetworkBody | null {
	const { type, declaredBytes } = bodyType(headers);
	if (declaredBytes !== null && declaredBytes > MAX_BODY_BYTES) {
		return bodyResult("too_large", declaredBytes, "declared_body_byte_limit");
	}
	if (type && !/^text\/|\bjson\b|\+json\b|application\/x-www-form-urlencoded/i.test(type)) {
		return bodyResult("binary", declaredBytes, "non_text_content_type");
	}
	if (!type) return bodyResult("unsupported", declaredBytes, "unknown_content_type");
	return null;
}

/**
 * Passive per-page network journal. Retains bounded metadata and Playwright references,
 * never caches bodies, never intercepts requests and never reads bodies unless requested.
 * Playwright body() materializes an entire body; unknown/decompressed transport sizes
 * cannot be bounded before that call, although returned text and retained metadata are.
 */
export class BrowserNetworkJournal {
	private readonly page: Page;
	private readonly maxEntries: number;
	private readonly entries = new Map<string, NetworkEntry>();
	private requestIds = new WeakMap<Request, string>();
	private sequence = 0;
	private dropped = 0;
	private disposed = false;

	constructor(page: Page, limits?: { maxEntries?: number }) {
		this.page = page;
		this.maxEntries = bounded(limits?.maxEntries, MAX_ENTRIES, MAX_ENTRIES);
		page.on("request", this.onRequest);
		page.on("response", this.onResponse);
		page.on("requestfinished", this.onFinished);
		page.on("requestfailed", this.onFailed);
	}

	private readonly onRequest = (request: Request): void => {
		if (this.disposed || this.requestIds.has(request)) return;
		const sequence = ++this.sequence;
		const requestId = String(sequence);
		this.requestIds.set(request, requestId);
		const from = request.redirectedFrom();
		const url = safeUrl(request.url());
		const timing = request.timing();
		const summary: BrowserNetworkSummary = {
			requestId,
			sequence,
			method: request.method().slice(0, 32),
			url: url.slice(0, 2048),
			status: null,
			startedAt: timing.startTime > 0 ? timing.startTime : Date.now(),
			durationMs: null,
			state: "pending",
			failure: null,
			resourceType: request.resourceType().slice(0, 32),
			redirectedFrom: from ? (this.requestIds.get(from) ?? null) : null,
			truncated: url.length > 2048,
		};
		this.entries.set(requestId, {
			summary,
			request,
			response: null,
			requestHeaders: safeHeaders(request.headers()),
			responseHeaders: null,
		});
		if (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
			this.dropped++;
		}
	};

	private readonly onResponse = (response: Response): void => {
		const entry = this.find(response.request());
		if (!entry) return;
		entry.response = response;
		entry.responseHeaders = safeHeaders(response.headers());
		entry.summary.status = response.status();
		entry.summary.state = "response";
	};

	private readonly onFinished = (request: Request): void => {
		const entry = this.find(request);
		if (!entry) return;
		entry.summary.state = "finished";
		const timing = request.timing();
		entry.summary.durationMs =
			timing.responseEnd >= 0 ? timing.responseEnd : Math.max(0, Date.now() - entry.summary.startedAt);
	};

	private readonly onFailed = (request: Request): void => {
		const entry = this.find(request);
		if (!entry) return;
		entry.summary.state = "failed";
		const failure = safeText(request.failure()?.errorText ?? "Request failed (no error details)");
		entry.summary.failure = failure.slice(0, 2048);
		entry.summary.truncated ||= failure.length > 2048;
		const timing = request.timing();
		entry.summary.durationMs =
			timing.responseEnd >= 0 ? timing.responseEnd : Math.max(0, Date.now() - entry.summary.startedAt);
	};

	private find(request: Request): NetworkEntry | undefined {
		const id = this.requestIds.get(request);
		return id === undefined ? undefined : this.entries.get(id);
	}

	list(options: BrowserNetworkListOptions = {}) {
		const limit = bounded(options.limit, 50, MAX_LIST);
		const since = options.since === undefined || !Number.isFinite(options.since) ? 0 : Math.max(0, options.since);
		const url = options.url?.toLowerCase();
		const matches = [...this.entries.values()].filter(({ summary }) => {
			return (
				summary.sequence > since &&
				(!url || summary.url.toLowerCase().includes(url)) &&
				(options.status === undefined || summary.status === options.status) &&
				(options.failed === undefined || (summary.state === "failed") === options.failed)
			);
		});
		const requests = matches.slice(0, limit).map(({ summary }) => ({ ...summary }));
		const truncated = matches.length > limit;
		return {
			requests,
			cursor: truncated ? requests[requests.length - 1].sequence : Math.max(this.sequence, since),
			oldestSequence: this.entries.values().next().value?.summary.sequence ?? null,
			dropped: this.dropped,
			truncated,
			limits: { maxEntries: this.maxEntries, maxReturned: limit },
		};
	}

	async detail(requestId: string, options: BrowserNetworkDetailOptions = {}) {
		const entry = this.entries.get(requestId);
		if (!entry) throw new Error(`Network request not found or evicted: ${requestId}`);
		const maxBodyChars = bounded(options.maxBodyChars, 8 * 1024, MAX_BODY_CHARS);
		let requestBody = bodyResult("not_requested", null);
		let responseBody = bodyResult("not_requested", null);
		if (options.includeRequestBody) {
			const preflight = bodyPreflight(entry.requestHeaders);
			if (preflight && preflight.state !== "unsupported") requestBody = preflight;
			else {
				const buffer = entry.request.postDataBuffer();
				requestBody = buffer
					? (preflight ?? formatBody(buffer, bodyType(entry.requestHeaders).type, maxBodyChars))
					: bodyResult("none", 0);
			}
		}
		if (options.includeResponseBody) {
			if (entry.summary.state === "pending" || entry.summary.state === "response") {
				responseBody = bodyResult("pending", null, "request_not_finished");
			} else if (!entry.response || !entry.responseHeaders || entry.summary.state === "failed") {
				responseBody = bodyResult("unavailable", null, "response_missing_or_request_failed");
			} else if (entry.summary.method === "HEAD" || entry.summary.status === 204 || entry.summary.status === 304) {
				responseBody = bodyResult("none", 0);
			} else {
				const preflight = bodyPreflight(entry.responseHeaders);
				if (preflight) responseBody = preflight;
				else {
					try {
						const buffer = await entry.response.body();
						responseBody = formatBody(buffer, bodyType(entry.responseHeaders).type, maxBodyChars);
					} catch {
						responseBody = bodyResult("unavailable", null, "response_body_unavailable");
					}
				}
			}
		}
		return {
			request: { ...entry.summary },
			requestHeaders: { ...entry.requestHeaders, values: { ...entry.requestHeaders.values } },
			responseHeaders: entry.responseHeaders
				? { ...entry.responseHeaders, values: { ...entry.responseHeaders.values } }
				: null,
			requestBody,
			responseBody,
			limits: {
				maxBodyChars,
				maxBodyBytes: MAX_BODY_BYTES,
				bodyReadMode:
					"Playwright materializes each requested body; unknown or decoded source sizes are checked after reading",
				redaction: "known_secret_fields",
			},
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.page.off("request", this.onRequest);
		this.page.off("response", this.onResponse);
		this.page.off("requestfinished", this.onFinished);
		this.page.off("requestfailed", this.onFailed);
		this.entries.clear();
		this.requestIds = new WeakMap();
	}
}
