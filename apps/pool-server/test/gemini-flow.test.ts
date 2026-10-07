import type { Account } from "owl-pool";
import { classifyGeminiError, GeminiProtocolMapper } from "owl-pool";
import { describe, expect, it } from "vitest";
import { GeminiChatClient } from "../src/gateway/gemini-client.ts";

const mapper = new GeminiProtocolMapper();

function account(): Account {
	return {
		id: "g1",
		name: "Gemini号",
		platform: "GEMINI",
		credentials: { apiKey: "ai-key" },
		enabled: true,
		createdAt: 0,
		updatedAt: 0,
	};
}

function sse(frames: string[]): Response {
	return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("GeminiProtocolMapper", () => {
	it("请求：system→systemInstruction、assistant tool_calls→functionCall、tool→functionResponse 反查函数名", () => {
		const request = mapper.toGeminiRequest(
			{
				messages: [
					{ role: "system", content: "规则A" },
					{ role: "developer", content: "规则B" },
					{ role: "user", content: "看文件" },
					{
						role: "assistant",
						tool_calls: [
							{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
						],
					},
					{ role: "tool", tool_call_id: "c1", content: "内容" },
				],
				max_tokens: 2048,
				temperature: 0.5,
			},
			8192,
		);
		expect(request.systemInstruction).toEqual({ parts: [{ text: "规则A\n\n规则B" }] });
		const contents = request.contents as Array<Record<string, unknown>>;
		expect(contents[0]).toMatchObject({ role: "user", parts: [{ text: "看文件" }] });
		expect(contents[1]).toMatchObject({
			role: "model",
			parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } } }],
		});
		expect(contents[2]).toMatchObject({
			role: "user",
			parts: [{ functionResponse: { name: "read_file", response: { result: "内容" } } }],
		});
		expect((request.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(2048);
	});

	it("响应：functionCall→tool_calls、thought→reasoning_content、thoughtsTokenCount 计入 completion", () => {
		const completion = mapper.toOpenAiCompletion({
			modelVersion: "gemini-2.5-flash",
			candidates: [
				{
					content: {
						parts: [
							{ text: "思考中", thought: true },
							{ text: "答案" },
							{ functionCall: { name: "f", args: { x: 1 } } },
						],
					},
					finishReason: "STOP",
				},
			],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
		});
		const message = (completion.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>;
		expect(message.content).toBe("答案");
		expect(message.reasoning_content).toBe("思考中");
		expect((message.tool_calls as Array<Record<string, unknown>>)[0]!.function).toMatchObject({
			name: "f",
			arguments: '{"x":1}',
		});
		expect((completion.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe("tool_calls");
		expect(completion.usage).toEqual({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
	});

	it("错误分类：RESOURCE_EXHAUSTED→RATE、API key 无效→AUTH、400→BAD_REQUEST", () => {
		expect(classifyGeminiError(429, "RESOURCE_EXHAUSTED", null)).toBe("RATE");
		expect(classifyGeminiError(400, "INVALID_ARGUMENT", "API key not valid")).toBe("AUTH");
		expect(classifyGeminiError(400, null, null)).toBe("BAD_REQUEST");
		const exception = mapper.httpError(
			429,
			JSON.stringify({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }),
		);
		expect(exception.kind).toBe("RATE");
	});
});

describe("GeminiChatClient", () => {
	it("端点/鉴权头/请求形状；流式 finishReason 才收尾并带 usage", async () => {
		const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
		const client = new GeminiChatClient({
			config: {
				baseUrl: "https://generativelanguage.googleapis.com",
				apiVersion: "v1beta",
				defaultMaxTokens: 8192,
				timeoutMs: 5000,
			},
			fetchImpl: (async (input: string | URL, init?: RequestInit) => {
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(init?.headers ?? {})) {
					headers[name.toLowerCase()] = String(value);
				}
				requests.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) });
				return sse([
					JSON.stringify({ candidates: [{ content: { parts: [{ text: "早" }], role: "model" } }] }),
					JSON.stringify({
						candidates: [{ content: { parts: [{ text: "安" }], role: "model" }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
					}),
				]);
			}) as typeof fetch,
		});

		const chunks: Array<Record<string, unknown>> = [];
		await client.chatCompletionStream(
			account(),
			{ model: "gemini/gemini-2.5-flash", messages: [{ role: "user", content: "早" }] },
			(json) => {
				chunks.push(JSON.parse(json));
			},
		);

		const request = requests[0]!;
		expect(request.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
		expect(request.headers["x-goog-api-key"]).toBe("ai-key");
		expect((request.body.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(8192);

		expect(chunks.length).toBe(3); // 2 增量 + 1 收尾
		expect((chunks[0]!.choices as Array<Record<string, unknown>>)[0]!.delta).toMatchObject({
			role: "assistant",
			content: "早",
		});
		const last = chunks[chunks.length - 1]!;
		expect((last.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe("stop");
		expect(last.usage).toEqual({ prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 });
	});

	it("非流式：generateContent → chat.completion；model 剥前缀", async () => {
		const requests: Array<{ url: string }> = [];
		const client = new GeminiChatClient({
			config: {
				baseUrl: "https://generativelanguage.googleapis.com",
				apiVersion: "v1beta",
				defaultMaxTokens: 8192,
				timeoutMs: 5000,
			},
			fetchImpl: (async (input: string | URL) => {
				requests.push({ url: String(input) });
				return new Response(
					JSON.stringify({
						modelVersion: "gemini-2.5-flash",
						candidates: [{ content: { parts: [{ text: "OK" }], role: "model" }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
					}),
					{ status: 200 },
				);
			}) as typeof fetch,
		});
		const completion = await client.chatCompletion(account(), {
			model: "gemini/gemini-2.5-flash",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(requests[0]?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
		);
		expect((completion.choices as Array<Record<string, unknown>>)[0]!.message).toMatchObject({ content: "OK" });
	});

	it("缺 apiKey → AUTH；流缺 finishReason → 上游流不完整（包装 SERVER）", async () => {
		const noKey = account();
		noKey.credentials = {};
		const bare = new GeminiChatClient({
			config: { baseUrl: "https://x", apiVersion: "v1beta", defaultMaxTokens: 16, timeoutMs: 5000 },
			fetchImpl: (async () =>
				sse([
					JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }], role: "model" } }] }),
				])) as typeof fetch,
		});
		await expect(bare.chatCompletionStream(noKey, { model: "m", messages: [] }, () => {})).rejects.toMatchObject({
			kind: "AUTH",
		});

		const withKey = new GeminiChatClient({
			config: { baseUrl: "https://x", apiVersion: "v1beta", defaultMaxTokens: 16, timeoutMs: 5000 },
			fetchImpl: (async () =>
				sse([
					JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }], role: "model" } }] }),
				])) as typeof fetch,
		});
		await expect(
			withKey.chatCompletionStream(account(), { model: "m", messages: [] }, () => {}),
		).rejects.toMatchObject({ kind: "SERVER" });
	});
});
