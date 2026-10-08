import { AnthropicUpstreamMapper } from "owl-pool";
import { describe, expect, it } from "vitest";

describe("native unknown and explicit zero measurements", () => {
	it("missing nonstream usage stays UNKNOWN instead of a synthetic known zero", () => {
		const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: true });
		const result = mapper.toOpenAiCompletion({ model: "faux-model", content: [], stop_reason: "end_turn" });
		expect(result).not.toHaveProperty("usage");
		expect(result.usage_source).toBe("UNKNOWN");
	});
	it("a stream with no basic metrics stays UNKNOWN at the terminal frame", () => {
		const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: true });
		const chunks: Array<Record<string, unknown>> = [];
		const decoder = mapper.newStreamDecoder("faux-model", (chunk) =>
			chunks.push(JSON.parse(chunk) as Record<string, unknown>),
		);
		decoder.onEvent(JSON.stringify({ type: "message_start", message: { usage: null } }));
		decoder.onEvent(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: null }));
		decoder.onEvent(JSON.stringify({ type: "message_stop" }));
		decoder.finish();
		expect(chunks.at(-1)).not.toHaveProperty("usage");
		expect(chunks.at(-1)?.usage_source).toBe("UNKNOWN");
	});
	it("valid input survives a whole-null notification and output-only cumulative updates", () => {
		const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: true });
		const chunks: Array<Record<string, unknown>> = [];
		const decoder = mapper.newStreamDecoder("faux-model", (chunk) =>
			chunks.push(JSON.parse(chunk) as Record<string, unknown>),
		);
		decoder.onEvent(
			JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0 } } }),
		);
		decoder.onEvent(JSON.stringify({ type: "message_delta", usage: null }));
		decoder.onEvent(
			JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } }),
		);
		decoder.onEvent(JSON.stringify({ type: "message_stop" }));
		decoder.finish();
		expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
	});
	it("explicit native zero remains a valid known measurement", () => {
		const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: true });
		const result = mapper.toOpenAiCompletion({
			model: "faux-model",
			content: [],
			stop_reason: "end_turn",
			usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		});
		expect(result.usage).toMatchObject({
			prompt_tokens: 0,
			completion_tokens: 0,
			prompt_tokens_details: { cached_tokens: 0 },
			cache_creation_input_tokens: 0,
		});
		expect(result).not.toHaveProperty("usage_source");
	});
});

describe("Anthropic native cache components normalize consistently", () => {
	const native = {
		input_tokens: 100,
		cache_read_input_tokens: 600,
		cache_creation_input_tokens: 300,
		output_tokens: 50,
	};
	it.each([true, false])("nonstream keeps components and honors foldCacheTokens=%s", (fold) => {
		const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: fold });
		const result = mapper.toOpenAiCompletion({
			model: "faux-model",
			content: [],
			stop_reason: "end_turn",
			usage: native,
		});
		expect(result.usage).toMatchObject({
			prompt_tokens: fold ? 1000 : 100,
			completion_tokens: 50,
			prompt_tokens_details: { cached_tokens: 600 },
			cache_creation_input_tokens: 300,
		});
	});
	it.each([true, false])("stream folds once, retaining cache fields with foldCacheTokens=%s", (fold) => {
		const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: fold });
		const chunks: Array<Record<string, unknown>> = [];
		const decoder = mapper.newStreamDecoder("faux-model", (chunk) =>
			chunks.push(JSON.parse(chunk) as Record<string, unknown>),
		);
		decoder.onEvent(JSON.stringify({ type: "message_start", message: { usage: { ...native, output_tokens: 0 } } }));
		decoder.onEvent(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: native }));
		decoder.onEvent(JSON.stringify({ type: "message_stop" }));
		decoder.finish();
		expect(chunks.at(-1)?.usage).toMatchObject({
			prompt_tokens: fold ? 1000 : 100,
			completion_tokens: 50,
			prompt_tokens_details: { cached_tokens: 600 },
			cache_creation_input_tokens: 300,
		});
	});
	it("absence of native cache fields keeps ordinary input unchanged", () => {
		const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: true });
		const result = mapper.toOpenAiCompletion({
			model: "faux-model",
			content: [],
			stop_reason: "end_turn",
			usage: { input_tokens: 100, output_tokens: 50 },
		});
		expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
	});
	it.each([-1, 0.5, "600", null, Number.MAX_SAFE_INTEGER + 1])(
		"invalid native cache value %s is not truncated or treated as missing",
		(invalid) => {
			const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: true });
			const result = mapper.toOpenAiCompletion({
				model: "faux-model",
				content: [],
				stop_reason: "end_turn",
				usage: { ...native, cache_read_input_tokens: invalid },
			});
			expect(result.usage).toMatchObject({ prompt_tokens_details: { cached_tokens: -1 } });
		},
	);
	it("invalid native stream metrics cannot be erased by a later valid snapshot", () => {
		const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: true });
		const chunks: Array<Record<string, unknown>> = [];
		const decoder = mapper.newStreamDecoder("faux-model", (chunk) =>
			chunks.push(JSON.parse(chunk) as Record<string, unknown>),
		);
		decoder.onEvent(JSON.stringify({ type: "message_start", message: { usage: native } }));
		decoder.onEvent(JSON.stringify({ type: "message_delta", usage: { cache_read_input_tokens: null } }));
		decoder.onEvent(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: native }));
		decoder.onEvent(JSON.stringify({ type: "message_stop" }));
		decoder.finish();
		expect(chunks.at(-1)?.usage).toMatchObject({
			prompt_tokens: -1,
			prompt_tokens_details: { cached_tokens: -1 },
			cache_creation_input_tokens: 300,
		});
	});
});
