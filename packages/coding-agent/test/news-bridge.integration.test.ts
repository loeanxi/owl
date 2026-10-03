import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type {
	NewsListResult,
	NewsModelCall,
	NewsModelCaller,
	NewsModelResponse,
	NewsRequest,
	NewsResultByAction,
	NewsSourceInput,
} from "../src/core/news/types.ts";
import { createNewsTools } from "../src/modes/desktop/news-tools.ts";
import type { NewsOpenMessage } from "../src/modes/desktop/protocol.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

const privateBody = "这段完整正文仅用于管理诊断，未许可公开全文。";
const title = "示例团队发布资讯智能体框架";
const summary = "示例团队发布资讯智能体框架，支持任务恢复和步骤日志。";
const evidence = "示例团队发布资讯智能体框架，新增任务恢复和步骤日志。";
const source: NewsSourceInput = {
	id: "bridge-fixture",
	name: "本地示例发布日志",
	kind: "external",
	config: {},
	tier: "T1",
	participation: "editorial",
	enabled: false,
	intervalMinutes: 30,
	siteFulltext: false,
	syndicateFulltext: false,
};

function fakeResponse(value: unknown): NewsModelResponse {
	return {
		text: typeof value === "string" ? value : JSON.stringify(value),
		provider: "faux",
		model: "news-fixture",
		usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: null },
	};
}

/** Only the model boundary is fake; all processing, receipts, queues and publication are real. */
function fauxNews() {
	const calls: NewsModelCall[] = [];
	const callModel: NewsModelCaller = async (request) => {
		calls.push(request);
		switch (request.capability) {
			case "prefilter":
				return fakeResponse({ label: "PASS", reason: "明确描述智能体框架" });
			case "score":
				return fakeResponse({ attentionScore: 80 });
			case "structure":
				return fakeResponse({
					scope: "single",
					category: "ai-products",
					tags: ["产品更新", "Agent"],
					subjects: [],
					fact: {
						title,
						subject: "示例团队",
						action: "发布",
						object: "资讯智能体框架",
						occurredAt: null,
						evidence,
						conditions: [],
					},
				});
			case "understand":
			case "summarize":
				return fakeResponse({
					titleZh: title,
					summaryZh: summary,
					editorialJudgment: "给出了可核对的任务恢复与日志能力。",
				});
			case "group": {
				const input = JSON.parse(request.user) as { candidates: { id: string }[] };
				return fakeResponse({
					query: evidence,
					decisions: input.candidates.map((candidate) => ({
						id: candidate.id,
						relation: "UNRELATED",
						confidence: 1,
					})),
					selection: { addsValue: true, reason: "独立的新发布" },
				});
			}
			case "groupReview":
				return fakeResponse({ relation: "UNRELATED", confidence: 1 });
			case "digest":
				return fakeResponse({ title, digest: summary });
			case "report":
				return fakeResponse({ overview: summary, sections: {} });
			case "assistant":
				return fakeResponse(
					"选定资料说明，该框架支持任务恢复和步骤日志 [1]。这份示例没有给出性能评测，不能据此判断运行效果。",
				);
			default:
				throw new Error(`Unexpected paid fixture capability: ${request.capability}`);
		}
	};
	return { calls, callModel };
}

/** Avoid ambient proxy configuration: SDK/HTTP traffic is permitted only to loopback. */
async function localFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
		throw new Error("Integration fixture forbids external HTTP");
	const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
	const body = init.body ?? (input instanceof Request ? await input.text() : undefined);
	if (body !== undefined && body !== null && typeof body !== "string")
		throw new Error("Fixture requires a text HTTP body");
	return new Promise<Response>((fulfill, reject) => {
		const request = requestHttp(
			url,
			{
				method: init.method ?? (input instanceof Request ? input.method : "GET"),
				headers: Object.fromEntries(headers),
				agent: false,
				signal: init.signal ?? undefined,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.once("error", reject);
				response.once("end", () => {
					const responseHeaders = new Headers();
					for (const [key, value] of Object.entries(response.headers))
						if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
					const status = response.statusCode ?? 500;
					fulfill(
						new Response([204, 304].includes(status) ? null : Buffer.concat(chunks).toString("utf8"), {
							status,
							headers: responseHeaders,
						}),
					);
				});
			},
		);
		request.once("error", reject);
		request.end(body);
	});
}

interface WireResponse {
	type: string;
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "owl-news-bridge-"));
	const absolute = resolve(directory);
	if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-news-bridge-"))
		throw new Error("Unexpected fixture cleanup path");
	const cwd = join(directory, "workspace");
	const agentDir = join(directory, "profile");
	await mkdir(cwd);
	await mkdir(agentDir);
	const faux = fauxNews();
	const forbiddenFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("External news fetch must never run in this fixture");
	});
	const handle = await startDesktopServer({
		port: 0,
		host: "127.0.0.1",
		cwd,
		agentDir,
		mcpServers: {},
		onDiagnostic: () => undefined,
		news: {
			callModel: faux.callModel,
			listModels: () => [{ provider: "faux", id: "news-fixture", name: "Offline news fixture" }],
			resolveModel: async (_capability, configured) => configured ?? { provider: "faux", id: "news-fixture" },
			fetch: forbiddenFetch,
			resolveHost: async () => {
				throw new Error("External DNS must never run");
			},
		},
	});
	const base = `http://127.0.0.1:${handle.port}`;
	const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, { headers: { Origin: base } });
	const clients: Client[] = [];
	let closed = false;
	cleanup.push(async () => {
		if (closed) return;
		closed = true;
		try {
			for (const client of clients) await client.close();
			socket.terminate();
			await handle.close();
		} finally {
			await rm(absolute, { recursive: true, force: true });
		}
	});
	await new Promise<void>((fulfill, reject) => {
		socket.once("open", fulfill);
		socket.once("error", reject);
	});
	function send(message: Record<string, unknown>): Promise<WireResponse> {
		return new Promise((fulfill, reject) => {
			const id = randomUUID();
			const timer = setTimeout(() => {
				socket.off("message", receive);
				reject(new Error(`Bridge request timed out: ${message.type}`));
			}, 8000);
			const receive = (bytes: unknown) => {
				const value = JSON.parse(String(bytes)) as WireResponse;
				if (value.type !== "response" || value.id !== id) return;
				clearTimeout(timer);
				socket.off("message", receive);
				fulfill(value);
			};
			socket.on("message", receive);
			socket.send(JSON.stringify({ ...message, id }));
		});
	}
	async function news<T extends NewsRequest>(request: T): Promise<NewsResultByAction[T["action"]]> {
		const result = await send({ type: "news.request", request });
		if (!result.ok) throw new Error(result.error ?? "News request failed");
		return result.result as NewsResultByAction[T["action"]];
	}
	async function mcp() {
		const client = new Client({ name: "owl-news-integration", version: "1.0.0" }, { capabilities: {} });
		clients.push(client);
		await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/news/mcp`), { fetch: localFetch }));
		return client;
	}
	return { base, agentDir, news, mcp, calls: faux.calls, forbiddenFetch };
}

async function populate(bridge: Awaited<ReturnType<typeof fixture>>) {
	const snapshot = await bridge.news({ action: "snapshot" });
	expect(snapshot.configuration.modelCallsEnabled).toBe(false);
	expect(snapshot.status.databasePath).toBe(join(bridge.agentDir, "news", "news.sqlite"));
	await bridge.news({ action: "saveSource", source });
	await bridge.news({
		action: "ingest",
		sourceId: source.id,
		items: [
			{
				title,
				url: "https://example.test/framework",
				body: `${evidence}\n${privateBody}`,
				publishedAt: new Date().toISOString(),
			},
		],
	});
	await bridge.news({ action: "configure", patch: { modelCallsEnabled: true } });
	await vi.waitFor(
		async () => {
			expect((await bridge.news({ action: "list", query: { mode: "selected" } })).total).toBe(1);
		},
		{ timeout: 20000, interval: 100 },
	);
	await vi.waitFor(
		async () => {
			const jobs = await bridge.news({ action: "jobs" });
			expect(
				jobs.filter(
					(job) =>
						["analyze", "group", "digest"].includes(job.kind) && ["pending", "running"].includes(job.status),
				),
			).toEqual([]);
		},
		{ timeout: 20000, interval: 100 },
	);
	const item = (await bridge.news({ action: "list", query: { mode: "selected" } })).items[0];
	if (!item) throw new Error("Faux processing did not publish an item");
	expect(item).toMatchObject({ title, selected: true, status: "ready", originalBody: null, body: null });
	expect(item.storyId).toBeTruthy();
	expect(bridge.calls.filter((call) => call.capability === "score").map((call) => call.purpose)).toEqual([
		"score-1",
		"score-2",
	]);
	return item;
}

describe("news on the real desktop bridge", () => {
	it("shares queued publication, citations and withdrawal across WebSocket, HTTP, RSS and MCP", async () => {
		const bridge = await fixture();
		const item = await populate(bridge);
		const client = await bridge.mcp();
		const beforeRead = bridge.calls.length;
		const http = await localFetch(`${bridge.base}/api/news/v1/items?mode=selected`);
		expect(http.status).toBe(200);
		const body = (await http.json()) as { data: NewsListResult; _trust: { contentTrust: string } };
		expect(body.data.items.map((entry) => entry.id)).toEqual([item.id]);
		expect(body._trust.contentTrust).toBe("untrusted_external_data");
		expect(JSON.stringify(body)).not.toContain(privateBody);
		const feed = await localFetch(`${bridge.base}/api/news/feed.xml?fulltext=true`);
		expect(feed.headers.get("content-type")).toContain("rss+xml");
		const xml = await feed.text();
		expect(xml).toContain(`<guid isPermaLink="false">${item.id}</guid>`);
		expect(xml).not.toContain(privateBody);
		const tools = await client.listTools();
		expect(tools.tools.map((tool) => tool.name)).toContain("owl_news_latest");
		const latest = await client.callTool({ name: "owl_news_latest", arguments: { mode: "selected" } });
		expect(latest.isError).not.toBe(true);
		expect((latest.structuredContent?.data as NewsListResult).items.map((entry) => entry.id)).toEqual([item.id]);
		expect(bridge.calls).toHaveLength(beforeRead);

		const answer = await bridge.news({
			action: "assistant",
			request: { question: "选定的示例资料有哪些可核对的新能力？", itemIds: [item.id] },
		});
		expect(answer.answer).toContain("[1]");
		expect(answer.citations).toEqual([{ id: 1, itemId: item.id, title, url: item.url }]);
		const assistantCall = bridge.calls.find((call) => call.capability === "assistant");
		expect(assistantCall?.user).not.toContain(privateBody);

		await bridge.news({ action: "withdraw", id: item.id, withdrawn: true });
		expect((await bridge.news({ action: "list", query: { mode: "all" } })).total).toBe(0);
		expect((await localFetch(`${bridge.base}/api/news/v1/items/${item.id}`)).status).toBe(404);
		await expect((await localFetch(`${bridge.base}/api/news/feed.xml`)).text()).resolves.not.toContain(item.id);
		const hidden = await client.callTool({ name: "owl_news_latest", arguments: { mode: "all" } });
		expect((hidden.structuredContent?.data as NewsListResult).total).toBe(0);
		expect(await bridge.news({ action: "adminItem", id: item.id })).toMatchObject({
			withdrawn: true,
			originalTitle: title,
			selectionCandidate: true,
			originalBody: null,
		});
		expect(
			(await bridge.news({ action: "adminItems", status: "withdrawn", query: { mode: "all" } })).items.map(
				(entry) => entry.id,
			),
		).toEqual([item.id]);
		await bridge.news({ action: "withdraw", id: item.id, withdrawn: false });
		expect((await bridge.news({ action: "list" })).items[0]?.id).toBe(item.id);
		expect((await localFetch(`${bridge.base}/api/news/v1/items/${item.id}`)).status).toBe(200);
		await bridge.news({ action: "saveSource", source: { ...source, siteFulltext: true } });
		expect((await bridge.news({ action: "adminItem", id: item.id }))?.originalBody).toBe(
			`${evidence}\n${privateBody}`,
		);
		await expect((await localFetch(`${bridge.base}/api/news/feed.xml?fulltext=true`)).text()).resolves.not.toContain(
			privateBody,
		);
		expect(bridge.forbiddenFetch).not.toHaveBeenCalled();
	}, 45000);

	it("rejects a cross-site WebSocket before it can configure the local service", async () => {
		const bridge = await fixture();
		const socket = new WebSocket(`${bridge.base.replace("http:", "ws:")}/ws`, {
			headers: { Origin: "https://cross-site.invalid" },
		});
		const refusal = await new Promise<number>((fulfill, reject) => {
			const timer = setTimeout(() => {
				socket.terminate();
				reject(new Error("Origin refusal timed out"));
			}, 5000);
			socket.on("error", () => undefined);
			socket.once("unexpected-response", (_request, response) => {
				clearTimeout(timer);
				response.resume();
				socket.terminate();
				fulfill(response.statusCode ?? 0);
			});
			socket.once("open", () => {
				clearTimeout(timer);
				socket.send(
					JSON.stringify({
						type: "news.request",
						id: "cross-site-configure",
						request: { action: "configure", patch: { modelCallsEnabled: true } },
					}),
				);
				socket.terminate();
				reject(new Error("Untrusted socket was accepted"));
			});
		});
		expect(refusal).toBe(401);
		expect((await bridge.news({ action: "snapshot" })).configuration.modelCallsEnabled).toBe(false);
		expect(
			(await localFetch(`${bridge.base}/api/news/v1/items`, { headers: { Origin: "https://cross-site.invalid" } }))
				.status,
		).toBe(403);
		expect(bridge.calls).toEqual([]);
		expect(bridge.forbiddenFetch).not.toHaveBeenCalled();
	}, 15000);

	it("binds news_open to its owning session and reads visibility through the actual WebSocket service", async () => {
		const bridge = await fixture();
		const item = await populate(bridge);
		const messages: NewsOpenMessage[] = [];
		const tools = createNewsTools(
			(request) => bridge.news(request),
			"owning-session",
			(message) => {
				if (message.type !== "news.open") throw new Error("Unexpected news tool broadcast");
				messages.push(message);
			},
		);
		const open = tools.find((tool) => tool.name === "news_open");
		if (!open) throw new Error("news_open is not registered");
		const result = await open.execute(
			randomUUID(),
			{ kind: "item", id: item.id, sessionId: "other-session" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details).toMatchObject({ opened: true, id: item.id });
		expect(messages).toEqual([{ type: "news.open", sessionId: "owning-session", kind: "item", id: item.id }]);
		expect(messages.filter((message) => message.sessionId === "other-session")).toEqual([]);
		await bridge.news({ action: "withdraw", id: item.id, withdrawn: true });
		const unavailable = await open.execute(
			randomUUID(),
			{ kind: "item", id: item.id },
			undefined,
			undefined,
			undefined as never,
		);
		expect(unavailable.details).toHaveProperty("error");
		expect(messages).toHaveLength(1);
		expect(bridge.forbiddenFetch).not.toHaveBeenCalled();
	}, 45000);
});
