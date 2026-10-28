import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessageEvent, Citation } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		beta: {
			messages: {
				create: () => ({
					asResponse: async () => response,
				}),
			},
		},
	} as unknown as Anthropic;
}

/** 一条带引用的完整 SSE 流。 */
function citationStream(citations: unknown[], withDelta: boolean): Response {
	const events: Array<{ event: string; data: string }> = [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: { id: "msg_cite", usage: { input_tokens: 10, output_tokens: 0 } },
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "", ...(withDelta ? {} : { citations }) },
			}),
		},
	];
	if (withDelta) {
		events.push({
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			}),
		});
		for (const citation of citations) {
			events.push({
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "citations_delta", citation },
				}),
			});
		}
	}
	events.push(
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 10, output_tokens: 5 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	);
	return createSseResponse(events);
}

async function run(response: Response): Promise<{ message: { content: unknown[] }; events: AssistantMessageEvent[] }> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	const stream = streamAnthropic(
		model,
		normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
		{ client: createFakeAnthropicClient(response) },
	);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const message = await stream.result();
	return { message, events };
}

function textBlock(message: { content: unknown[] }): { text: string; citations?: Citation[] } {
	const block = message.content.find((part) => (part as { type?: string }).type === "text") as
		| { type: "text"; text: string; citations?: Citation[] }
		| undefined;
	if (block === undefined) throw new Error("no text block");
	return block;
}

describe("Anthropic citations", () => {
	it("normalizes a web search citation arriving as citations_delta", async () => {
		const { message, events } = await run(
			citationStream(
				[
					{
						type: "web_search_result_location",
						cited_text: "the quick brown fox",
						encrypted_index: "enc",
						title: "Example Domain",
						url: "https://example.com/page",
					},
				],
				true,
			),
		);

		const block = textBlock(message);
		expect(block.citations).toEqual([
			{
				title: "Example Domain",
				url: "https://example.com/page",
				snippet: "the quick brown fox",
				source: "web_search_result_location",
			},
		]);
		const citationEvents = events.filter((event) => event.type === "text_citation");
		expect(citationEvents).toHaveLength(1);
	});

	it("normalizes a document citation and keeps its document title", async () => {
		const { message } = await run(
			citationStream(
				[
					{
						type: "char_location",
						cited_text: "quoted passage",
						document_index: 0,
						document_title: "handbook.md",
						start_char_index: 12,
						end_char_index: 26,
						file_id: "file_1",
					},
				],
				true,
			),
		);

		const block = textBlock(message);
		expect(block.citations?.[0]).toEqual({
			title: "handbook.md",
			snippet: "quoted passage",
			startIndex: 12,
			endIndex: 26,
			source: "char_location",
		});
	});

	it("reads citations that arrive with the content block", async () => {
		const { message } = await run(
			citationStream(
				[
					{
						type: "web_search_result_location",
						cited_text: "snippet",
						encrypted_index: "enc",
						title: "T",
						url: "https://example.test/",
					},
				],
				false,
			),
		);

		expect(textBlock(message).citations).toHaveLength(1);
	});

	it("drops citations that carry nothing worth showing", async () => {
		const { message } = await run(citationStream([{ type: "char_location", document_index: 0 }], true));

		expect(textBlock(message).citations).toBeUndefined();
	});
});
