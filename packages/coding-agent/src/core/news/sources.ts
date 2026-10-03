import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";
import { Agent } from "undici";
import type { NewsMaterial, NewsSourceInput } from "./types.ts";

export const NEWS_SECRET_KEYS = ["SOCIALDATA_API_KEY", "DAJIALA_KEY", "EMBEDDING_API_KEY", "GITHUB_TOKEN", "ingest"] as const;
export interface NewsFetchOptions {
	fetch?: typeof fetch;
	resolveHost?: (host: string) => Promise<string[]>;
	allowPrivateNetwork?: boolean;
	timeoutMs?: number;
	maxBytes?: number;
	signal?: AbortSignal;
}
export interface NewsFetchedText { text: string; url: string; status: number; headers: Record<string, string> }
export class NewsHttpRejectedError extends Error {
	status: number;
	constructor(status: number) { super(`信源返回 HTTP ${status}`); this.status = status; }
}

export function isPrivateNewsAddress(address: string): boolean {
	const value = address.replace(/^\[|\]$/g, "").toLowerCase();
	if (value.includes("%")) return true;
	if (isIP(value) === 4) {
		const [a = 0, b = 0] = value.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
			|| (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
			|| (a === 198 && (b === 18 || b === 19));
	}
	if (isIP(value) === 6) {
		if (value === "::" || value === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(value)) return true;
		// Mapped IPv4 and NAT64 may target private IPv4 through an apparently public IPv6 endpoint.
		if (value.startsWith("::ffff:") || value.startsWith("64:ff9b:")) {
			const tail = value.split(":").slice(-2);
			if (value.includes(".")) return isPrivateNewsAddress(value.slice(value.lastIndexOf(":") + 1));
			const high = Number.parseInt(tail[0] ?? "0", 16); const low = Number.parseInt(tail[1] ?? "0", 16);
			return isPrivateNewsAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
		}
		return !/^[23][0-9a-f]{3}:/.test(value);
	}
	return true;
}

/** Bound DNS, transport, redirects and streamed bytes; pin the validated DNS answer to prevent rebinding. */
export async function fetchNewsText(urlValue: string, init: RequestInit = {}, options: NewsFetchOptions = {}): Promise<NewsFetchedText> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("信源请求超时")), options.timeoutMs ?? 25000);
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const maximum = options.maxBytes ?? 4 * 1024 * 1024;
	let url = new URL(urlValue); const initialOrigin = url.origin;
	try {
		for (let redirects = 0; redirects <= 5; redirects++) {
			if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("只允许无凭据的 HTTP(S) 地址");
			const host = url.hostname.replace(/^\[|\]$/g, "");
			if (!options.allowPrivateNetwork && /(^localhost$|\.localhost$|\.local$|\.internal$)/i.test(host)) throw new Error("不允许采集本机或内网地址");
			const resolver = options.resolveHost ?? (async (hostname: string) => (await lookup(hostname, { all: true })).map(entry => entry.address));
			const addresses = isIP(host) ? [host] : await Promise.race([
				resolver(host), new Promise<never>((_resolve, reject) => {
					if (signal.aborted) reject(signal.reason);
					else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
			]);
			if (!addresses.length || (!options.allowPrivateNetwork && addresses.some(isPrivateNewsAddress))) throw new Error("信源解析到不允许的内网地址");
			const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
				const records = addresses.map(address => ({ address, family: isIP(address) }));
				if (lookupOptions.all) callback(null, records);
				else callback(null, records[0]!.address, records[0]!.family);
			};
			const dispatcher = options.fetch ? undefined : new Agent({ connect: { lookup: pinnedLookup } });
			try {
				const headers = new Headers(init.headers);
				if (url.origin !== initialOrigin) { headers.delete("authorization"); headers.delete("cookie"); }
				const requestInit: RequestInit & { dispatcher?: Agent } = { ...init, headers, redirect: "manual", signal, dispatcher };
				const response = await (options.fetch ?? fetch)(url.toString(), requestInit);
				if (response.status >= 300 && response.status < 400 && response.status !== 304) {
					await response.body?.cancel();
					const target = response.headers.get("location"); if (!target) throw new Error("重定向缺少目标地址");
					const next = new URL(target, url);
					if (init.method && init.method !== "GET" && init.method !== "HEAD") throw new Error("不允许带请求正文的采集请求重定向");
					if ((headers.has("authorization") || headers.has("cookie")) && next.origin !== initialOrigin) throw new Error("不允许认证采集请求跨域重定向");
					url = next; continue;
				}
				if (Number(response.headers.get("content-length") ?? 0) > maximum) { await response.body?.cancel(); throw new Error("信源正文超过大小限制"); }
				const chunks: Uint8Array[] = []; let bytes = 0; const reader = response.body?.getReader();
				if (reader) try {
					for (;;) {
						const part = await reader.read(); if (part.done) break;
						bytes += part.value.byteLength; if (bytes > maximum) { await reader.cancel(); throw new Error("信源正文超过大小限制"); }
						chunks.push(part.value);
					}
				} finally { reader.releaseLock(); }
				return { text: Buffer.concat(chunks).toString("utf8"), url: url.toString(), status: response.status, headers: Object.fromEntries(response.headers) };
			} finally { await dispatcher?.close(); }
		}
		throw new Error("信源重定向超过 5 次");
	} finally { clearTimeout(timeout); }
}

export function newsPlainText(value: string): string {
	const document = new DOMParser().parseFromString(`<html><body>${value}</body></html>`, "text/html");
	for (const element of document.querySelectorAll("script,style,iframe,object,embed")) element.remove();
	return document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function safeArticleUrl(value: string, base: string): string | null {
	try { const url = new URL(value, base); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.toString() : null; }
	catch { return null; }
}

export function parseNewsFeed(text: string, base: string, summaryIsBody = false): NewsMaterial[] {
	if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("不允许 XML 外部实体");
	const doc = new DOMParser().parseFromString(text, "text/xml");
	const entries = [...doc.querySelectorAll("item,entry")];
	if (!entries.length && !doc.querySelector("rss,feed,RDF")) throw new Error("信源不是 RSS/Atom 文档");
	return entries.flatMap(entry => {
		const direct = (names: string[]) => [...entry.children].find(node => names.includes(node.localName) || names.includes(node.nodeName));
		const title = newsPlainText(direct(["title"])?.textContent ?? "");
		const links = [...entry.children].filter(node => node.localName === "link");
		const link = links.find(node => !node.getAttribute("rel") || node.getAttribute("rel") === "alternate") ?? links[0];
		const url = safeArticleUrl(link?.getAttribute("href") || link?.textContent || direct(["guid"])?.textContent || "", base);
		if (!url || !title) return [];
		const rawBody = direct(["content:encoded", "encoded", "content"])?.textContent ?? (summaryIsBody ? direct(["description", "summary"])?.textContent : "");
		const date = direct(["pubDate", "published", "date", "updated"])?.textContent;
		const parsed = date ? Date.parse(date) : Number.NaN;
		return [{ title, url, body: rawBody ? newsPlainText(rawBody) : undefined,
			publishedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined,
			author: direct(["creator", "author"])?.textContent?.trim() || undefined,
			externalId: direct(["id", "guid"])?.textContent?.trim() || undefined }];
	});
}

export function parseNewsWebList(html: string, base: string, config: Record<string, unknown>): NewsMaterial[] {
	const doc = new DOMParser().parseFromString(html, "text/html"); const seen = new Set<string>();
	return [...doc.querySelectorAll(String(config.itemSelector || "a[href]"))].flatMap(entry => {
		const selector = config.linkSelector ? String(config.linkSelector) : "a[href]";
		const link = entry.matches(selector) ? entry : entry.querySelector(selector);
		const url = safeArticleUrl(link?.getAttribute("href") ?? "", base);
		const titleNode = config.titleSelector ? (entry.matches(String(config.titleSelector)) ? entry : entry.querySelector(String(config.titleSelector))) : link;
		const title = titleNode?.textContent?.replace(/\s+/g, " ").trim();
		const deny = Array.isArray(config.denyUrlPrefixes) ? config.denyUrlPrefixes as string[] : [];
		const allow = Array.isArray(config.allowUrlPrefixes) ? config.allowUrlPrefixes as string[] : [];
		if (!url || !title || url === base || seen.has(url) || deny.some(prefix => url.startsWith(prefix)) || (allow.length && !allow.some(prefix => url.startsWith(prefix)))) return [];
		seen.add(url);
		const dateNode = config.publishedAtSelector ? entry.querySelector(String(config.publishedAtSelector)) : entry.querySelector("time");
		const date = dateNode?.getAttribute("datetime") || dateNode?.textContent || "";
		const parsed = Date.parse(date);
		const body = config.bodySelector ? entry.querySelector(String(config.bodySelector))?.textContent?.trim() : undefined;
		return [{ title, url, body, publishedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined }];
	});
}

export function newsObjectPath(value: unknown, path: string): unknown {
	let current = value;
	for (const segment of path.split(".").filter(Boolean)) {
		if (segment === "__proto__" || segment === "constructor" || segment === "prototype") return undefined;
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

export function parseNewsJsonList(data: unknown, base: string, config: Record<string, unknown>): NewsMaterial[] {
	const items = newsObjectPath(data, String(config.itemsPath || ""));
	if (!Array.isArray(items)) throw new Error("JSON itemsPath 没有指向数组");
	const read = (item: unknown, paths: unknown, fallback: string[]) => {
		for (const path of Array.isArray(paths) ? paths : fallback) {
			const value = newsObjectPath(item, String(path)); if ((typeof value === "string" && value.trim()) || typeof value === "number") return String(value).trim();
		}
		return "";
	};
	return items.flatMap(item => {
		const title = newsPlainText(read(item, config.titlePaths, ["title", "name"]));
		let target = read(item, config.urlPaths, ["url", "html_url", "link"]);
		if (config.urlTemplate) target = String(config.urlTemplate).replace(/\{([^}]+)\}/g, (_match, path: string) => encodeURIComponent(String(newsObjectPath(item, path) ?? "")));
		const url = safeArticleUrl(target, base); if (!title || !url) return [];
		const value = config.publishedAtPath ? newsObjectPath(item, String(config.publishedAtPath)) : null;
		const date = config.publishedAtUnit === "epoch_s" ? Number(value) * 1000 : config.publishedAtUnit === "epoch_ms" ? Number(value) : Date.parse(String(value ?? ""));
		const body = read(item, config.bodyPaths ?? config.summaryPaths, ["body", "content", "description"]);
		return [{ title, url, body: body ? newsPlainText(body) : undefined, publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : undefined,
			externalId: config.externalIdPath ? String(newsObjectPath(item, String(config.externalIdPath)) ?? "") : undefined,
			author: read(item, config.authorPaths, ["author.name", "author.login", "author"]) || undefined }];
	});
}

export function extractNewsBody(html: string, url: string): { title: string; body: string; publishedAt?: string } {
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const node of doc.querySelectorAll("script,style,iframe,object,embed,form")) node.remove();
	const base = doc.createElement("base"); base.setAttribute("href", url); doc.head.prepend(base);
	const result = new Readability(doc as unknown as Document, { charThreshold: 80, maxElemsToParse: 50000 }).parse();
	const body = result?.textContent?.trim() || doc.querySelector("article,main")?.textContent?.trim() || "";
	if (!body) throw new Error("页面没有可提取正文");
	return { title: result?.title?.trim() || "", body: body.slice(0, 500000), publishedAt: result?.publishedTime || undefined };
}

export interface NewsCollectorOptions extends NewsFetchOptions {
	secrets?: Record<string, string>;
	maxItems?: number;
	paid?: (purpose: string, identity: unknown, run: () => Promise<unknown>) => Promise<unknown>;
}

/** Generic configuration never sends write-only credentials back to the UI. */
export function publicNewsSource<T extends NewsSourceInput>(source: T): T {
	const redact = (value: unknown, key = ""): unknown => {
		if (key === "headers" && value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, /^(accept|content-type|user-agent)$/i.test(name) ? entry : entry ? "[configured]" : ""]));
		if (/api.?key|token|secret|password|authorization|cookie/i.test(key)) return value ? "[configured]" : "";
		if ((key === "url" || key === "feedUrl") && typeof value === "string") {
			try { const url = new URL(value); for (const name of [...url.searchParams.keys()]) if (/key|token|secret|auth|password/i.test(name)) url.searchParams.set(name, "[configured]"); return url.toString(); }
			catch { return value; }
		}
		if (Array.isArray(value)) return value.map(entry => redact(entry));
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry, name)]));
		return value;
	};
	return { ...source, config: redact(source.config) as Record<string, unknown> };
}

export async function collectNewsSource(source: NewsSourceInput, options: NewsCollectorOptions = {}): Promise<NewsMaterial[]> {
	const config = source.config; const maximum = options.maxItems ?? 30; const secrets = options.secrets ?? {};
	const headers = new Headers({ accept: "application/json,application/rss+xml,application/atom+xml,text/html;q=0.9" });
	if (config.headers && typeof config.headers === "object") for (const [name, value] of Object.entries(config.headers)) {
		headers.set(name, String(value).replace(/\$\{([A-Z_]+)\}/g, (_match, key: string) => secrets[key] ?? ""));
	}
	const get = async (url: string, init: RequestInit = {}) => {
		const result = await fetchNewsText(url, { headers, ...init }, options);
		if (result.status < 200 || result.status >= 300) throw new NewsHttpRejectedError(result.status);
		return result;
	};
	if (source.kind === "external") return [];
	if (source.kind === "rss") {
		const result = await get(String(config.feedUrl || "")); return parseNewsFeed(result.text, result.url, config.summaryIsBody === true).slice(0, maximum);
	}
	if (source.kind === "web_list") {
		const result = await get(String(config.url || "")); return parseNewsWebList(result.text, result.url, config).slice(0, maximum);
	}
	if (source.kind === "json_list") {
		const result = await get(String(config.url || "")); return parseNewsJsonList(JSON.parse(result.text) as unknown, result.url, config).slice(0, maximum);
	}
	if (!options.paid) throw new Error("付费采集需要持久回执管理器");
	if (source.kind === "x_search") {
		if (!secrets.SOCIALDATA_API_KEY) throw new Error("请配置 SOCIALDATA_API_KEY");
		if (!config.query) throw new Error("X 信源缺少搜索 query");
		const url = `https://api.socialdata.tools/twitter/search?${new URLSearchParams({ query: String(config.query), type: String(config.searchType || "Latest") })}`;
		const result = await options.paid("x-search", { query: config.query, window: Math.floor(Date.now() / 1800000) }, async () => {
			const response = await get(url, { headers: { authorization: `Bearer ${secrets.SOCIALDATA_API_KEY}` } }); return JSON.parse(response.text) as unknown;
		}) as { tweets?: Record<string, unknown>[] };
		return (result.tweets ?? []).slice(0, maximum).flatMap(tweet => {
			if (tweet.retweeted_status) return [];
			const user = tweet.user as Record<string, unknown> | undefined;
			const body = String(tweet.full_text ?? tweet.text ?? ""); const id = String(tweet.id_str ?? "");
			if (!body || !id || !user?.screen_name) return [];
			return [{ title: body.split("\n")[0]!.slice(0, 180), body, url: `https://x.com/${user.screen_name}/status/${id}`,
				externalId: id, author: String(user.screen_name), publishedAt: String(tweet.tweet_created_at ?? ""), language: String(tweet.lang ?? "") }];
		});
	}
	if (!secrets.DAJIALA_KEY) throw new Error("请配置 DAJIALA_KEY");
	const ghid = String(config.ghid || config.wxid || ""); if (!ghid) throw new Error("公众号信源缺少 ghid/wxid");
	const history = await options.paid("mp-history", { ghid, window: Math.floor(Date.now() / 600000) }, async () => {
		const response = await get("https://www.dajiala.com/fbmain/monitor/v3/post_history", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ghid, key: secrets.DAJIALA_KEY, verifycode: "" }),
		});
		const json = JSON.parse(response.text) as Record<string, unknown>;
		if (Number(json.code ?? 0) !== 0) throw new NewsHttpRejectedError(Number(json.code)); return json;
	}) as { data?: Record<string, unknown>[] };
	const result: NewsMaterial[] = [];
	for (const post of (history.data ?? []).slice(0, maximum)) {
		const url = safeArticleUrl(String(post.url || ""), "https://mp.weixin.qq.com"); if (!url || !post.title) continue;
		const body = await options.paid("mp-article", { url }, async () => {
			const endpoint = `https://www.dajiala.com/fbmain/monitor/v3/article_detail?${new URLSearchParams({ url, key: secrets.DAJIALA_KEY!, mode: "1", verifycode: "" })}`;
			const response = await get(endpoint);
			const json = JSON.parse(response.text) as Record<string, unknown>;
			if (Number(json.code ?? 0) !== 0) throw new NewsHttpRejectedError(Number(json.code)); return json;
		}) as Record<string, unknown>;
		result.push({ title: String(post.title), url, externalId: String(post.sn ?? url),
			body: newsPlainText(String(body.content || post.digest || "")), author: String(body.author || ""), language: "zh",
			publishedAt: post.post_time ? new Date(Number(post.post_time) * 1000).toISOString() : undefined });
	}
	return result;
}
