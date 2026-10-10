import {
	type Account,
	AccountPoolRouter,
	GatewayFault,
	InMemoryAccountStore,
	MemoryGatewayState,
	type Platform,
	type ResolvedModel,
	type ResolvedRouteTarget,
	RouteGeneration,
	StickySessionService,
	type UpstreamChatClient,
} from "owl-pool";
import { describe, expect, it } from "vitest";
import { normalizeTraePayload, TraeChatClient } from "../src/gateway/trae-client.ts";
import { normalizeWorkBuddyPayload, WorkBuddyChatClient } from "../src/gateway/workbuddy-client.ts";

function sse(frames: string[]): Response {
	// 带 event: 行的帧原样成帧；纯 data 帧加 data: 前缀
	const payload = frames.map((frame) => (frame.includes("\n") ? `${frame}\n\n` : `data: ${frame}\n\n`)).join("");
	return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function account(credentials: Record<string, unknown>, id = "acc-1"): Account {
	return { id, name: "测试号", platform: "WORKBUDDY", credentials, enabled: true, createdAt: 0, updatedAt: 0 };
}

describe("WorkBuddyChatClient", () => {
	const wb = new WorkBuddyChatClient({
		config: {
			baseUrl: "https://copilot.tencent.com",
			chatPath: "/v2/chat/completions",
			userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
			origin: "https://www.codebuddy.cn",
			referer: "https://www.codebuddy.cn/",
			timeoutMs: 5000,
		},
	});

	it("归一：剥指纹字段、tool_choice 归一字符串、hy3 缺省 high", () => {
		const body = normalizeWorkBuddyPayload({
			model: "wb/hy3",
			stream: true,
			user: "u1",
			store: true,
			max_completion_tokens: 512,
			tool_choice: { type: "function", function: { name: "read_file" } },
			messages: [{ role: "user", content: [{ type: "text", text: "hi cc_x:1" }] }],
		});
		expect(body.stream).toBeUndefined();
		expect(body.user).toBeUndefined();
		expect(body.max_tokens).toBe(512);
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.tool_choice).toBe("read_file");
		expect(body.model).toBe("hy3");
		expect(body.reasoning_effort).toBe("high");
	});

	it("流式：请求带渠道铁律头；SSE 转 OpenAI chunk + 收尾 chunk（finish+usage）", async () => {
		const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
		let call = 0;
		const client = new WorkBuddyChatClient({
			config: {
				baseUrl: "https://copilot.tencent.com",
				chatPath: "/v2/chat/completions",
				userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
				origin: "https://www.codebuddy.cn",
				referer: "https://www.codebuddy.cn/",
				timeoutMs: 5000,
			},
			fetchImpl: (async (input: string | URL, init?: RequestInit) => {
				call++;
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(init?.headers ?? {})) {
					headers[name.toLowerCase()] = String(value);
				}
				requests.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) });
				if (call === 1) {
					return sse([
						JSON.stringify({ choices: [{ index: 0, delta: { content: "你" } }] }),
						JSON.stringify({ choices: [{ index: 0, delta: { content: "好" } }] }),
						JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
						JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
						"[DONE]",
					]);
				}
				// 非流式聚合路径：复用同一流
				return sse([
					JSON.stringify({
						choices: [{ index: 0, delta: { content: "聚合" }, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
					"[DONE]",
				]);
			}) as typeof fetch,
		});
		const wbAccount = account({ accessToken: "wb-tok" });
		const chunks: Array<Record<string, unknown>> = [];
		await client.chatCompletionStream(
			wbAccount,
			{ model: "hy3", messages: [{ role: "user", content: "hi" }] },
			(json) => {
				chunks.push(JSON.parse(json));
			},
		);

		const request = requests[0]!;
		expect(request.url).toBe("https://copilot.tencent.com/v2/chat/completions");
		expect(request.headers.authorization).toBe("Bearer wb-tok");
		expect(request.headers.origin).toBe("https://www.codebuddy.cn");
		expect(request.headers["x-product"]).toBe("SaaS");
		expect(request.headers["x-no-user-id"]).toBe("1");
		expect(request.headers["x-refresh-token"]).toBeUndefined();
		expect(request.body.stream).toBe(true);

		expect(chunks.length).toBe(4); // 3 增量 + 1 收尾
		expect((chunks[0]!.choices as Array<Record<string, unknown>>)[0]!.delta).toMatchObject({
			role: "assistant",
			content: "你",
		});
		const last = chunks[chunks.length - 1]!;
		expect((last.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe("stop");
		expect(last.usage).toMatchObject({ total_tokens: 7 });

		// 非流式 = 流式聚合
		const completion = await client.chatCompletion(wbAccount, {
			model: "hy3",
			messages: [{ role: "user", content: "hi" }],
		});
		expect((completion.choices as Array<Record<string, unknown>>)[0]!.message).toMatchObject({
			role: "assistant",
			content: "聚合",
		});
	});

	it("加密信封 accessToken → AUTH", async () => {
		await expect(
			wb.chatCompletionStream(
				account({ accessToken: "$wbEncrypted:xxx" }),
				{ model: "hy3", messages: [] },
				() => {},
			),
		).rejects.toMatchObject({ name: "UpstreamException", kind: "AUTH" });
	});

	it("11128 渠道拒绝：退避重试后放行，不再透传原始 JSON", async () => {
		let call = 0;
		const client = new WorkBuddyChatClient({
			config: {
				baseUrl: "https://copilot.tencent.com",
				chatPath: "/v2/chat/completions",
				userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
				origin: "https://www.codebuddy.cn",
				referer: "https://www.codebuddy.cn/",
				timeoutMs: 5000,
			},
			fetchImpl: (async () => {
				call++;
				if (call === 1) {
					return new Response(
						JSON.stringify({ code: 11128, msg: "Illegal API invocation from an unapproved channel" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				return sse([
					JSON.stringify({ choices: [{ index: 0, delta: { content: "好" } }] }),
					JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
					"[DONE]",
				]);
			}) as typeof fetch,
		});
		const chunks: Array<Record<string, unknown>> = [];
		await client.chatCompletionStream(account({ accessToken: "wb-tok" }), { model: "hy3", messages: [] }, (json) => {
			chunks.push(JSON.parse(json));
		});
		expect(call).toBe(2); // 首次 11128 抽检拦截 → 重试放行
		expect(chunks.length).toBe(3); // 内容增量 + finish 帧增量 + 收尾 chunk
	});

	it("11128 连续拦截：重试耗尽 → upstream_channel_rejected，不透传原始 JSON", async () => {
		let call = 0;
		const client = new WorkBuddyChatClient({
			config: {
				baseUrl: "https://copilot.tencent.com",
				chatPath: "/v2/chat/completions",
				userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
				origin: "https://www.codebuddy.cn",
				referer: "https://www.codebuddy.cn/",
				timeoutMs: 5000,
			},
			fetchImpl: (async () => {
				call++;
				return new Response(
					JSON.stringify({ code: 11128, msg: "Illegal API invocation from an unapproved channel" }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}) as typeof fetch,
		});
		const failure = await client
			.chatCompletionStream(account({ accessToken: "wb-tok" }), { model: "hy3", messages: [] }, () => {})
			.catch((error: unknown) => error);
		expect(call).toBe(3); // 500ms + 1000ms 两次退避后耗尽
		expect(failure).toBeInstanceOf(GatewayFault);
		expect(failure).toMatchObject({ status: 502, code: "upstream_channel_rejected" });
		expect((failure as Error).message).not.toContain("Illegal API invocation");
	});

	it("其他 400 仍按 BAD_REQUEST 透传", async () => {
		const client = new WorkBuddyChatClient({
			config: {
				baseUrl: "https://copilot.tencent.com",
				chatPath: "/v2/chat/completions",
				userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
				origin: "https://www.codebuddy.cn",
				referer: "https://www.codebuddy.cn/",
				timeoutMs: 5000,
			},
			fetchImpl: (async () =>
				new Response(JSON.stringify({ code: 11101, msg: "bad" }), { status: 400 })) as typeof fetch,
		});
		await expect(
			client.chatCompletionStream(account({ accessToken: "wb-tok" }), { model: "hy3", messages: [] }, () => {}),
		).rejects.toMatchObject({ name: "UpstreamException", kind: "BAD_REQUEST" });
	});
});

describe("渠道拒绝的路由处理", () => {
	function target(platform: Platform): ResolvedRouteTarget {
		return {
			platform,
			upstreamModel: "star-a",
			priority: 0,
			supportsImages: false,
			supportsTools: true,
			reasoningEfforts: ["high"],
			effectiveEffort: null,
		};
	}

	function resolution(routes: ResolvedRouteTarget[]): ResolvedModel {
		return {
			publicId: "star-lm",
			routes,
			modelVersion: null,
			defaultReasoningEffort: null,
			defaultContextWindow: null,
			requestedReasoningEffort: null,
			effectiveReasoningEffort: null,
			requestedContextWindow: null,
			compatible: false,
			policyAction: null,
			policyRule: null,
		};
	}

	function fixture(): { generation: RouteGeneration; router: AccountPoolRouter; workBuddyIds: string[] } {
		const accounts = new InMemoryAccountStore();
		const workBuddyIds = ["a", "b"].map(
			(token) =>
				accounts.create(
					{ name: `wb-${token}`, platform: "WORKBUDDY", credentials: { accessToken: token }, enabled: true },
					0,
				).id,
		);
		accounts.create({ name: "grok", platform: "GROK", credentials: { apiKey: "k" }, enabled: true }, 0);
		const router = new AccountPoolRouter({
			accounts,
			accountCooldownMs: 60_000,
			cooldownState: new MemoryGatewayState(),
		});
		const generation = new RouteGeneration({
			accounts,
			router,
			sticky: new StickySessionService({ enabled: false, ttlSeconds: 900 }),
			upstreams: new Map<Platform, UpstreamChatClient>([
				["WORKBUDDY", {} as UpstreamChatClient],
				["GROK", {} as UpstreamChatClient],
			]),
			maxRotate: 3,
		});
		return { generation, router, workBuddyIds };
	}

	const rejectWorkBuddy = (tried: string[]) => async (selected: Account) => {
		tried.push(selected.platform);
		if (selected.platform === "WORKBUDDY") {
			throw new GatewayFault(502, "upstream_channel_rejected", "rejected");
		}
		return "ok";
	};

	it("同平台不换号、不冷却，降级到下一路由目标", async () => {
		const { generation, router, workBuddyIds } = fixture();
		const tried: string[] = [];
		const result = await generation.route(
			{
				key: { id: "k" } as never,
				payload: { model: "star-lm", messages: [] },
				resolution: resolution([target("WORKBUDDY"), target("GROK")]),
				sessionId: null,
			},
			rejectWorkBuddy(tried),
		);
		expect(result).toBe("ok");
		expect(tried).toEqual(["WORKBUDDY", "GROK"]);
		for (const id of workBuddyIds) {
			expect(router.isCooling(id)).toBe(false);
		}
	});

	it("没有其他路由目标时把渠道拒绝抛给调用方", async () => {
		const { generation } = fixture();
		const tried: string[] = [];
		await expect(
			generation.route(
				{
					key: { id: "k" } as never,
					payload: { model: "star-lm", messages: [] },
					resolution: resolution([target("WORKBUDDY")]),
					sessionId: null,
				},
				rejectWorkBuddy(tried),
			),
		).rejects.toMatchObject({ code: "upstream_channel_rejected" });
		expect(tried).toEqual(["WORKBUDDY"]);
	});
});

describe("TraeChatClient", () => {
	function trae(): {
		client: TraeChatClient;
		requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
	} {
		const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
		const client = new TraeChatClient({
			config: {
				chatBaseUrl: "https://trae-api-cn.mchost.guru",
				chatPath: "/api/agent/v3/llm_utils_chat",
				appId: "icube-ai",
				ideVersion: "2.63.2",
				ideVersionCode: "2630200",
				timeoutMs: 5000,
			},
			fetchImpl: (async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(init?.headers ?? {})) {
					headers[name.toLowerCase()] = String(value);
				}
				const body =
					init?.body === undefined || init.body === ""
						? {}
						: (JSON.parse(String(init.body)) as Record<string, unknown>);
				requests.push({ url, headers, body });
				if (url.includes("GetUserToken")) {
					return new Response(JSON.stringify({ code: 0, Result: { Token: "jwt-1" } }), { status: 200 });
				}
				return sse([
					'event: output\ndata: {"response":"早上"}',
					'event: output\ndata: {"reasoning_content":"想一下"}',
					'event: token_usage\ndata: {"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}',
					'event: done\ndata: {"finish_reason":"stop"}',
				]);
			}) as typeof fetch,
		});
		return { client, requests };
	}

	it("JWT 交换 → agent 头 → SOLO 事件转 OpenAI chunk + 收尾", async () => {
		const { client, requests } = trae();
		const chunks: Array<Record<string, unknown>> = [];
		await client.chatCompletionStream(
			account({ session: "sess-1" }, "trae-1"),
			{ model: "trae/solo-1", messages: [{ role: "user", content: "早" }] },
			(json) => {
				chunks.push(JSON.parse(json));
			},
		);

		// ① 换 JWT
		expect(requests[0]?.url).toBe("https://api.trae.cn/cloudide/api/v3/common/GetUserToken");
		expect(requests[0]?.headers.cookie).toBe("X-Cloudide-Session=sess-1");
		// ② 对话：Cloud-IDE-JWT + 设备头 + SOLO body
		const chat = requests[1]!;
		expect(chat.url).toBe("https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat");
		expect(chat.headers.authorization).toBe("Cloud-IDE-JWT jwt-1");
		expect(chat.headers["x-plugin-channel"]).toBe("icube-ai");
		expect(chat.headers["x-device-id"]).toMatch(/^\d{16}$/);
		expect(chat.body.model).toBeUndefined();
		expect(chat.body.config_name).toBe("solo-1");
		expect(chat.body.config_source).toBe(1);
		expect(chat.headers["x-icube-product"]).toBe("Work");
		expect(Array.isArray(chat.body.messages)).toBe(true);
		expect((chat.body.messages as Array<Record<string, unknown>>)[0]?.content).toEqual([
			{ type: "text", text: "早" },
		]);

		// ③ chunk 流：2 增量（content/reasoning）+ 收尾（finish+usage）
		expect(chunks.length).toBe(3);
		expect(chunks[0]!.choices).toEqual([
			{ index: 0, delta: { role: "assistant", content: "早上" }, finish_reason: null },
		]);
		expect((chunks[1]!.choices as Array<Record<string, unknown>>)[0]!.delta).toMatchObject({
			reasoning_content: "想一下",
		});
		const last = chunks[chunks.length - 1]!;
		expect((last.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe("stop");
		expect(last.usage).toMatchObject({ total_tokens: 13 });
	});

	it("SOLO 请求形状：developer→system、assistant tool_calls→function_call、工具拍平", () => {
		const body = normalizeTraePayload(
			{
				messages: [
					{ role: "developer", content: "规则" },
					{
						role: "assistant",
						tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
					},
				],
				tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
			},
			"solo-1",
			"solo_1_fn",
		);
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(messages[0]?.role).toBe("system");
		expect(messages[1]?.tool_calls).toEqual([
			{ id: "c1", type: "function", function_call: { name: "f", arguments: "{}" } },
		]);
		expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
			name: "f",
			description: "d",
			parameters: { type: "object" },
		});
		expect(body.function).toBe("solo_1_fn");
	});

	it("缺 session → AUTH", async () => {
		const { client } = trae();
		await expect(
			client.chatCompletionStream(account({}), { model: "m", messages: [] }, () => {}),
		).rejects.toMatchObject({ kind: "AUTH" });
	});
});
