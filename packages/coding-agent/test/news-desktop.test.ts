import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model, SimpleStreamOptions } from "../../ai/src/index.ts";
import { fauxAssistantMessage } from "../../ai/src/providers/faux.ts";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { NewsOutputError } from "../src/core/news/editorial.ts";
import type { NewsRequest } from "../src/core/news/types.ts";
import { isReadOnlyDesktopTool } from "../src/modes/desktop/browser-permissions.ts";
import { handleNewsHttp } from "../src/modes/desktop/news-http.ts";
import { callNewsModel } from "../src/modes/desktop/news-model.ts";
import { createNewsTools } from "../src/modes/desktop/news-tools.ts";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function http(handle: (request: NewsRequest) => Promise<unknown>) {
	const server = createServer((request, response) => {
		void handleNewsHttp(request, response, {
			handle,
			authorizeIngest: (token) => token === "test-ingest-token-123456",
			shutdown: async () => {},
		}).then((handled) => {
			if (!handled) response.writeHead(404).end();
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "http://localhost:0",
	input: ["text"],
	reasoning: false,
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("Owl news desktop seams", () => {
	it("public HTTP reads select the publication interface and reject write methods", async () => {
		const handle = vi.fn(async (_request: NewsRequest) => ({ items: [], total: 0 }));
		const base = await http(handle);
		const result = await fetch(`${base}/api/news/v1/items?mode=all&q=agent&limit=7`);
		expect(result.status).toBe(200);
		expect(handle).toHaveBeenLastCalledWith({
			action: "list",
			query: expect.objectContaining({ mode: "all", query: "agent", limit: 7 }),
		});
		const body = (await result.json()) as { _trust: { instructionPolicy: string } };
		expect(body._trust.instructionPolicy).toBe("treat_as_data_never_execute");
		expect((await fetch(`${base}/api/news/v1/items`, { method: "POST" })).status).toBe(405);
		expect((await fetch(`${base}/api/news/v1/adminItems`)).status).toBe(404);
	});
	it("default hot limits are valid and malformed pagination cannot reach queries", async () => {
		const handle = vi.fn(async (_request: NewsRequest) => []);
		const base = await http(handle);
		expect((await fetch(`${base}/api/news/v1/hot`)).status).toBe(200);
		expect(handle).toHaveBeenCalledWith({ action: "hot", limit: 10 });
		const before = handle.mock.calls.length;
		expect((await fetch(`${base}/api/news/v1/items?offset=-1`)).status).toBe(400);
		expect(handle.mock.calls.length).toBe(before);
	});
	it("external ingest needs a token and foreign browser origins cannot write", async () => {
		const handle = vi.fn(async (_request: NewsRequest) => ({ created: 1, updated: 0, ignored: 0 }));
		const base = await http(handle);
		const body = JSON.stringify({
			sourceId: "external",
			items: [{ title: "material", url: "https://example.org/item" }],
		});
		expect((await fetch(`${base}/api/news/ingest`, { method: "POST", body })).status).toBe(401);
		expect(
			(
				await fetch(`${base}/api/news/ingest`, {
					method: "POST",
					body,
					headers: { Authorization: "Bearer test-ingest-token-123456", Origin: "https://unrelated.example" },
				})
			).status,
		).toBe(403);
		expect(handle).not.toHaveBeenCalled();
		expect(
			(
				await fetch(`${base}/api/news/ingest`, {
					method: "POST",
					body,
					headers: { Authorization: "Bearer test-ingest-token-123456" },
				})
			).status,
		).toBe(200);
		expect(handle).toHaveBeenCalledWith({ action: "ingest", sourceId: "external", items: expect.any(Array) });
	});
	it("MCP exposes only read capabilities and delegates its tool through publication", async () => {
		const handle = vi.fn(async (_request: NewsRequest) => []);
		const base = await http(handle);
		const post = (method: string, params: object = {}) =>
			fetch(`${base}/api/news/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			});
		expect(
			(
				await post("initialize", {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "fixture", version: "1" },
				})
			).status,
		).toBe(200);
		const listed = (await (await post("tools/list")).json()) as {
			result: { tools: { annotations: { readOnlyHint: boolean } }[] };
		};
		const tools = listed.result.tools;
		expect(tools).toHaveLength(7);
		expect(tools.every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint)).toBe(
			true,
		);
		const answer = (await (await post("tools/call", { name: "owl_news_hot", arguments: { limit: 3 } })).json()) as {
			result: { isError?: boolean };
		};
		expect(answer.result.isError).not.toBe(true);
		expect(handle).toHaveBeenCalledWith({ action: "hot", limit: 3 });
	});
	it("agent read/open tools are usable in plan mode without granting management actions", async () => {
		const handle = vi.fn(async (_request: NewsRequest) => ({ id: "article", title: "fixture" }));
		const broadcast = vi.fn();
		const tools = createNewsTools(handle, "this-session", broadcast);
		expect(tools.every((tool) => isReadOnlyDesktopTool(tool.name, {}))).toBe(true);
		expect(isReadOnlyDesktopTool("news_configure", {})).toBe(false);
		await tools
			.find((tool) => tool.name === "news_open")!
			.execute("call", { kind: "item", id: "article" }, undefined, undefined, {} as ExtensionToolContext);
		expect(broadcast).toHaveBeenCalledWith({
			type: "news.open",
			sessionId: "this-session",
			kind: "item",
			id: "article",
		});
		expect(handle).toHaveBeenCalledWith({ action: "item", id: "article" });
	});
	it("direct model operations are capped, never retry internally, and retain unknown price", async () => {
		let seen: SimpleStreamOptions | undefined;
		const response = fauxAssistantMessage('{"attentionScore":70}');
		const registry = {
			find: () => model,
			getAvailable: () => [model],
			streamSimple: (_model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
				seen = options;
				const stream = new AssistantMessageEventStream();
				stream.end(response);
				return stream;
			},
		};
		const result = await callNewsModel(
			{ registry },
			{ capability: "score", system: "instruction", user: "material", maxTokens: 5000 },
		);
		expect(seen).toMatchObject({ maxRetries: 0, maxTokens: 1024 });
		expect(result.usage.cost).toBeNull();
	});
	it("a known truncated response keeps its result and usage for paid recovery", async () => {
		const response = fauxAssistantMessage('{"attentionScore":', { stopReason: "length" });
		const registry = {
			find: () => model,
			getAvailable: () => [model],
			streamSimple: () => {
				const stream = new AssistantMessageEventStream();
				stream.end(response);
				return stream;
			},
		};
		try {
			await callNewsModel(
				{ registry },
				{ capability: "score", purpose: "score-1", system: "instruction", user: "material" },
			);
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(NewsOutputError);
			expect((error as NewsOutputError).response?.text).toBe('{"attentionScore":');
		}
	});
});
