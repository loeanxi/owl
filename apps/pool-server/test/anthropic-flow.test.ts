import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AccountPoolRouter,
	ApiKeyService,
	MemoryGatewayState,
	type Platform,
	RouteGeneration,
	StickySessionService,
	type UpstreamChatClient,
} from "owl-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicCompatibleClient } from "../src/gateway/anthropic-compatible.ts";
import type { GatewayServiceDeps } from "../src/gateway/service.ts";
import { createPoolServer } from "../src/server.ts";
import { SqliteAccountStore } from "../src/store/account-store.ts";
import { newRecordId, SqliteCheckInRecordStore } from "../src/store/checkin-record-store.ts";
import { dbAlive, openDb } from "../src/store/db.ts";
import { SqliteApiKeyStore, SqliteCallLogStore, SqliteCatalogStore } from "../src/store/gateway-stores.ts";

let workdir: string;
let server: ReturnType<typeof createPoolServer>;
let baseUrl: string;
let plaintextKey = "";
const zcodeRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

/** ZCode 上游桩：校验 Anthropic 请求形状，回放脚本响应。 */
const zcodeFetch: typeof fetch = (async (input: string | URL, init?: RequestInit) => {
	const url = String(input);
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(init?.headers ?? {})) {
		headers[name.toLowerCase()] = String(value);
	}
	const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
	zcodeRequests.push({ url, headers, body });
	const script = responses.shift();
	if (script === undefined) {
		return new Response(JSON.stringify({ error: { type: "api_error", message: "no script" } }), { status: 500 });
	}
	return script;
}) as typeof fetch;

const responses: Response[] = [];

function sseResponse(frames: string[]): Response {
	const payload = frames.map((frame) => `data: ${frame}\n\n`).join("");
	return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "owl-pool-anthropic-"));
	const db = openDb(join(workdir, "pool.db"));
	const accounts = new SqliteAccountStore(db);
	const created = accounts.create(
		{ name: "GLM号", platform: "ZCODE", credentials: { apiKey: "zk-1", channel: "BIGMODEL" }, enabled: true },
		0,
	);
	accounts.patchState(created.id, { credits: 9 });

	const records = new SqliteCheckInRecordStore(db);
	const checkin = { countUnsigned: () => 0, catchUpUnsigned: async () => null } as unknown as Parameters<
		typeof createPoolServer
	>[0]["checkin"];
	const keys = new ApiKeyService({ store: new SqliteApiKeyStore(db) });
	const catalog = new SqliteCatalogStore(db);
	const state = new MemoryGatewayState();
	const poolRouter = new AccountPoolRouter({ accounts, accountCooldownMs: 60_000, cooldownState: state });
	const sticky = new StickySessionService({ enabled: true, ttlSeconds: 900 });
	const zcodeClient = new AnthropicCompatibleClient(
		{ platform: "ZCODE", label: "ZCode", anthropicVersion: "2023-06-01", defaultMaxTokens: 8192, timeoutMs: 10_000 },
		{ fetchImpl: zcodeFetch },
	);
	const upstreams = new Map<Platform, UpstreamChatClient>([[zcodeClient.platform(), zcodeClient]]);
	const generation = new RouteGeneration({ accounts, router: poolRouter, sticky, upstreams, maxRotate: 3 });
	const gateway: GatewayServiceDeps = {
		config: {
			enabled: true,
			globalRateLimitPerMinute: 600,
			ipRateLimitPerMinute: 300,
			ipWhitelist: null,
			maxRotate: 3,
			accountCooldownMs: 60_000,
			upstreamTimeoutMs: 10_000,
			stickyEnabled: true,
			stickyTtlSeconds: 900,
		},
		state,
		keys,
		accounts,
		router: poolRouter,
		generation,
		sticky,
		upstreams,
		callLogs: new SqliteCallLogStore(db),
		catalog,
		listPublishedModels: () => catalog.listModels(),
		trustedProxyCount: 0,
	};
	catalog.saveModel({
		id: "m1",
		publicId: "glm-5",
		name: "GLM-5",
		description: null,
		modelVersion: null,
		contextWindow: null,
		defaultContextWindow: null,
		defaultReasoningEffort: null,
		maxOutputTokens: null,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: [],
		published: true,
		sortOrder: 0,
		updatedAt: 0,
	});
	// 容量表：ZCODE glm-5 可用（无窗口限制）
	db.exec(
		"INSERT INTO discovered_models (platform, upstream_model, available, context_window, max_output_tokens, updated_at) VALUES ('ZCODE', 'glm-5', 1, NULL, NULL, 0)",
	);
	catalog.saveRoute({
		id: "r1",
		modelId: "m1",
		platform: "ZCODE",
		upstreamModel: "glm-5",
		priority: 0,
		enabled: true,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: [],
	});
	const createdKey = keys.create({ name: "claude-code" });
	plaintextKey = createdKey.plaintext;

	server = createPoolServer({
		accounts,
		records,
		checkin: checkin as never,
		dbPath: join(workdir, "pool.db"),
		isDbAlive: () => dbAlive(db),
		gateway: { gateway, gatewayConfig: gateway.config },
	});
	await new Promise<void>((resolveListen) => {
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.close();
	setTimeout(() => {
		try {
			rmSync(workdir, { recursive: true, force: true });
		} catch {
			// Windows 句柄延迟
		}
	}, 200);
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any; text: string }> {
	const response = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": plaintextKey,
			Authorization: `Bearer ${plaintextKey}`,
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	try {
		return { status: response.status, json: JSON.parse(text), text };
	} catch {
		return { status: response.status, json: null, text };
	}
}

describe("Anthropic 协议端点（/v1/messages）", () => {
	it("非流式：请求转 Anthropic 形状（system/工具/max_tokens 默认），响应转 message", async () => {
		responses.push(
			new Response(
				JSON.stringify({
					id: "msg_up",
					type: "message",
					role: "assistant",
					model: "glm-5",
					content: [
						{ type: "text", text: "你好" },
						{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
					],
					stop_reason: "tool_use",
					usage: { input_tokens: 21, output_tokens: 7 },
				}),
				{ status: 200 },
			),
		);
		const { status, json } = await post("/v1/messages", {
			model: "glm-5",
			max_tokens: 1024,
			system: "你是助手",
			messages: [
				{ role: "user", content: "读一下 a.ts" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "文件内容" }] },
			],
		});
		expect(status).toBe(200);

		// 上游请求：ZCode BIGMODEL 端点 + x-api-key + anthropic-version + Anthropic 形状
		const request = zcodeRequests[zcodeRequests.length - 1]!;
		expect(request.url).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages");
		expect(request.headers["x-api-key"]).toBe("zk-1");
		expect(request.headers["anthropic-version"]).toBe("2023-06-01");
		expect(request.body.max_tokens).toBe(1024);
		expect(request.body.system).toBe("你是助手");
		const messages = request.body.messages as Array<Record<string, unknown>>;
		// tool_result 聚成一条 user 消息的 tool_result 块
		expect(
			messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("tool_result")),
		).toBe(true);
		expect(request.body.tools).toBeUndefined(); // 请求未带 tools

		// 响应映射回 Anthropic message
		expect(json.type).toBe("message");
		expect(json.role).toBe("assistant");
		expect(json.model).toBe("glm-5");
		expect(json.stop_reason).toBe("tool_use");
		expect(json.content).toEqual([
			{ type: "text", text: "你好" },
			{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
		]);
		expect(json.usage).toEqual({ input_tokens: 21, output_tokens: 7 });
	});

	it("流式：OpenAI chunk 经流桥转 content_block/message_delta/message_stop", async () => {
		responses.push(
			sseResponse([
				JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } }),
				JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
				JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "午" } }),
				JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "安" } }),
				JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { input_tokens: 9, output_tokens: 2 },
				}),
				JSON.stringify({ type: "message_stop" }),
			]),
		);
		const { status, text } = await post("/v1/messages", {
			model: "glm-5",
			max_tokens: 128,
			messages: [{ role: "user", content: "打个招呼" }],
			stream: true,
		});
		expect(status).toBe(200);
		const events = text
			.split("\n\n")
			.filter((frame) => frame.startsWith("event: "))
			.map((frame) => frame.split("\n")[0]!.slice(7));
		expect(events[0]).toBe("message_start");
		expect(events).toContain("content_block_delta");
		expect(events[events.length - 2]).toBe("message_delta");
		expect(events[events.length - 1]).toBe("message_stop");
		// 不应出现 OpenAI 形状的 data 帧
		expect(text).not.toContain("chat.completion.chunk");
	});

	it("count_tokens：按 4 字符/token 粗算", async () => {
		const { status, json } = await post("/v1/messages/count_tokens", {
			model: "glm-5",
			messages: [{ role: "user", content: "abcd".repeat(10) }],
		});
		expect(status).toBe(200);
		expect(json.input_tokens).toBe(10);
	});

	it("上游 401 → 502 authentication_error（Anthropic 错误体）", async () => {
		responses.push(
			new Response(JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }), { status: 401 }),
		);
		const { status, json } = await post("/v1/messages", {
			model: "glm-5",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(status).toBe(502);
		expect(json.type).toBe("error");
		expect(json.error.type).toBe("authentication_error");
	});

	it("未上架模型 → 404 model_not_found（Anthropic 错误体）", async () => {
		const { status, json } = await post("/v1/messages", {
			model: "nope",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(status).toBe(404);
		expect(json.error.type).toBe("invalid_request_error");
	});
});
