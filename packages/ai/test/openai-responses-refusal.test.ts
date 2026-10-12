import type { ResponseOutputMessage, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "refusal-fixture",
	name: "Refusal fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://fixture.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 512,
};

function message(content: ResponseOutputMessage["content"], id = "msg_fixture"): ResponseOutputMessage {
	return { type: "message", id, role: "assistant", status: "completed", phase: "final_answer", content };
}

function terminal(output: ResponseOutputMessage[] = [], status = "completed", reason?: string) {
	return {
		type: status === "incomplete" ? "response.incomplete" : "response.completed",
		sequence_number: 99,
		response: {
			id: "resp_fixture",
			status,
			output,
			...(reason ? { incomplete_details: { reason } } : {}),
			usage: {
				input_tokens: 20,
				output_tokens: 7,
				total_tokens: 27,
				input_tokens_details: { cached_tokens: 2 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	};
}

async function run(events: readonly unknown[]) {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	const fetch = vi.fn<FetchFunction>().mockImplementation(async () => {
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	});
	const stream = streamOpenAIResponses(
		model,
		normalizeContext({ messages: [{ role: "user", content: "Inspect a self-authored fixture.", timestamp: 0 }] }),
		{ apiKey: "sk-test-fixture", fetch, maxRetries: 2 },
	);
	const normalizedEvents: AssistantMessageEvent[] = [];
	for await (const event of stream) normalizedEvents.push(event);
	return { result: await stream.result(), normalizedEvents, fetch };
}

const added: ResponseStreamEvent = {
	type: "response.output_item.added",
	sequence_number: 0,
	output_index: 0,
	item: message([]),
};

function refusalEvent(type: "response.refusal.delta" | "response.refusal.done", text: string, contentIndex = 0) {
	return {
		type,
		sequence_number: 1,
		output_index: 0,
		content_index: contentIndex,
		item_id: "msg_fixture",
		...(type === "response.refusal.delta" ? { delta: text } : { refusal: text }),
	};
}

describe("OpenAI Responses explicit refusal handling through SSE and the provider wrapper", () => {
	it("retains the provider marker and original text without reporting success or retrying", async () => {
		const item = message([{ type: "refusal", refusal: "Provider declined this request." }]);
		const { result, normalizedEvents, fetch } = await run([
			added,
			refusalEvent("response.refusal.delta", "Provider declined "),
			refusalEvent("response.refusal.delta", "this request."),
			refusalEvent("response.refusal.done", "Provider declined this request."),
			{ type: "response.output_item.done", sequence_number: 4, output_index: 0, item },
			terminal([item]),
		]);

		expect(result).toMatchObject({
			stopReason: "error",
			rawStopReason: "completed",
			refusal: { source: "provider", text: "Provider declined this request." },
			content: [{ type: "text", text: "Provider declined this request." }],
			usage: { input: 18, output: 7, totalTokens: 27 },
		});
		expect(result.errorMessage).toContain("Provider refusal");
		expect(normalizedEvents.at(-1)?.type).toBe("error");
		expect(normalizedEvents.some((event) => event.type === "done")).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps normal text separate from refusal metadata in a mixed message", async () => {
		const item = message([
			{ type: "output_text", text: "I inspected the header. ", annotations: [] },
			{ type: "refusal", refusal: "I declined the next step." },
		]);
		const { result } = await run([
			added,
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "I inspected the header. " },
			refusalEvent("response.refusal.delta", "I declined the next ", 1),
			refusalEvent("response.refusal.done", "I declined the next step.", 1),
			{ type: "response.output_item.done", output_index: 0, item },
			terminal([item]),
		]);
		expect(result).toMatchObject({
			stopReason: "error",
			refusal: { source: "provider", text: "I declined the next step." },
			content: [{ type: "text", text: "I inspected the header. I declined the next step." }],
		});
	});

	it.each(["refusal.done", "output_item.done", "completed"])(
		"detects an empty refusal sent only in %s",
		async (shape) => {
			const item = message([{ type: "refusal", refusal: "" }]);
			const payload =
				shape === "refusal.done"
					? [refusalEvent("response.refusal.done", ""), terminal()]
					: shape === "output_item.done"
						? [{ type: "response.output_item.done", output_index: 0, item }, terminal()]
						: [terminal([item])];
			const { result } = await run(payload);
			expect(result).toMatchObject({
				stopReason: "error",
				rawStopReason: "completed",
				refusal: { source: "provider" },
			});
			expect(result.errorMessage).toContain("Provider refusal");
		},
	);

	it.each(["refusal.done", "output_item.done", "completed"])(
		"preserves refusal text when only %s provides it",
		async (shape) => {
			const item = message([{ type: "refusal", refusal: "Only final payload has this text." }]);
			const payload =
				shape === "refusal.done"
					? [refusalEvent("response.refusal.done", "Only final payload has this text."), terminal()]
					: shape === "output_item.done"
						? [{ type: "response.output_item.done", output_index: 0, item }, terminal()]
						: [terminal([item])];
			const { result } = await run(payload);
			expect(result).toMatchObject({
				stopReason: "error",
				refusal: { source: "provider", text: "Only final payload has this text." },
				content: [{ type: "text", text: "Only final payload has this text." }],
			});
		},
	);

	it("does not reclassify a truncated refusal stream as successful", async () => {
		const { result } = await run([refusalEvent("response.refusal.delta", "Partial refusal")]);
		expect(result).toMatchObject({
			stopReason: "error",
			refusal: { source: "provider", text: "Partial refusal" },
			content: [{ type: "text", text: "Partial refusal" }],
		});
		expect(result.errorMessage).toContain("ended before a terminal response event");
	});

	it.each(["response.content_part.added", "response.content_part.done"])(
		"detects a refusal content part from %s without preceding item events",
		async (type) => {
			const { result } = await run([
				{
					type,
					output_index: 0,
					content_index: 0,
					item_id: "msg_fixture",
					part: { type: "refusal", refusal: "Part refusal" },
				},
				terminal(),
			]);
			expect(result).toMatchObject({
				stopReason: "error",
				refusal: { source: "provider", text: "Part refusal" },
				content: [{ type: "text", text: "Part refusal" }],
			});
		},
	);

	it("uses authoritative refusal.done text when it corrects the delta", async () => {
		const { result } = await run([
			added,
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Inspected. " },
			refusalEvent("response.refusal.delta", "Draft refusal", 1),
			refusalEvent("response.refusal.done", "Final refusal", 1),
			terminal(),
		]);
		expect(result).toMatchObject({
			refusal: { source: "provider", text: "Final refusal" },
			content: [{ type: "text", text: "Inspected. Final refusal" }],
		});
	});

	it("preserves multiple refusal parts without duplicating terminal payload text", async () => {
		const item = message([
			{ type: "refusal", refusal: "First refusal. " },
			{ type: "refusal", refusal: "Second refusal." },
		]);
		const { result } = await run([
			added,
			refusalEvent("response.refusal.done", "First refusal. "),
			refusalEvent("response.refusal.done", "Second refusal.", 1),
			{ type: "response.output_item.done", output_index: 0, item },
			terminal([item]),
		]);
		expect(result).toMatchObject({
			refusal: { source: "provider", text: "First refusal. Second refusal." },
			content: [{ type: "text", text: "First refusal. Second refusal." }],
		});
	});

	it("keeps a tool call plus explicit refusal out of the successful tool-use path", async () => {
		const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read", arguments: "{}" };
		const { result, normalizedEvents } = await run([
			{ type: "response.output_item.done", output_index: 1, item },
			refusalEvent("response.refusal.done", "Provider declined"),
			terminal(),
		]);
		expect(result.stopReason).toBe("error");
		expect(result).toMatchObject({ refusal: { source: "provider", text: "Provider declined" } });
		expect(result.content.some((block) => block.type === "toolCall")).toBe(true);
		expect(normalizedEvents.at(-1)?.type).toBe("error");
	});

	it("retains incomplete provider status when refusal and max-output truncation coexist", async () => {
		const item = message([{ type: "refusal", refusal: "Refusal before truncation" }]);
		const { result } = await run([terminal([item], "incomplete", "max_output_tokens")]);
		expect(result).toMatchObject({
			stopReason: "error",
			rawStopReason: "incomplete.max_output_tokens",
			refusal: { source: "provider", text: "Refusal before truncation" },
		});
	});

	it("does not mark a normal answer mentioning refusals as a provider refusal", async () => {
		const item = message([
			{ type: "output_text", text: "The string 'I cannot help' is test data.", annotations: [] },
		]);
		const { result, normalizedEvents } = await run([
			{ type: "response.output_item.done", output_index: 0, item },
			terminal([item]),
		]);
		expect(result.stopReason).toBe("stop");
		expect(result).not.toHaveProperty("refusal");
		expect(normalizedEvents.at(-1)?.type).toBe("done");
	});

	it("keeps completed tool calls usable when no provider refusal exists", async () => {
		const item = {
			type: "function_call",
			id: "fc_fixture",
			call_id: "call_fixture",
			name: "read",
			arguments: '{"path":"fixture.js"}',
		};
		const { result } = await run([
			{ type: "response.output_item.added", output_index: 0, item },
			{ type: "response.output_item.done", output_index: 0, item },
			terminal(),
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(result).not.toHaveProperty("refusal");
		expect(result.content).toMatchObject([{ type: "toolCall", name: "read", arguments: { path: "fixture.js" } }]);
	});
});
