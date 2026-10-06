/**
 * OpenAI chunk → Anthropic SSE 事件桥 —— 移植自 manager `gateway/AnthropicStreamBridge`。
 * 稳定的 content 索引保序交错并行工具调用；文本块与工具块互斥切换时自动关闭旧块。
 */
import { randomUUID } from "node:crypto";
import { GatewayFault } from "../gateway/upstream.ts";
import type { AnthropicStreamSender } from "./anthropic-protocol.ts";

interface ToolState {
	index: number;
	id: string;
	name: string;
	buffered: string;
}

export class AnthropicStreamBridge {
	readonly #messageId = `msg_${randomUUID().replaceAll("-", "")}`;
	readonly #model: string;
	readonly #sender: AnthropicStreamSender;
	readonly #tools = new Map<number, ToolState>();
	readonly #open = new Set<number>();
	#nextIndex = 0;
	#textIndex = -1;
	#inputTokens: number;
	#outputTokens = 0;
	#started = false;
	#sawToolUse = false;
	#stopReason = "end_turn";

	constructor(model: string, estimatedInputTokens: number, sender: AnthropicStreamSender) {
		this.#model = model;
		this.#inputTokens = estimatedInputTokens;
		this.#sender = sender;
	}

	/** 喂一个 OpenAI chunk JSON 字符串。 */
	onOpenAiChunk(chunk: string): void {
		let root: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(chunk);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("not object");
			}
			root = parsed as Record<string, unknown>;
		} catch {
			throw new GatewayFault(502, "invalid_response", "服务返回了无效响应");
		}
		const usage = root.usage;
		if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
			const record = usage as Record<string, unknown>;
			if (typeof record.prompt_tokens === "number") {
				this.#inputTokens = record.prompt_tokens;
			}
			if (typeof record.completion_tokens === "number") {
				this.#outputTokens = record.completion_tokens;
			}
		}
		const choices = root.choices;
		const choice =
			Array.isArray(choices) && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : undefined;
		const delta =
			choice !== undefined && choice.delta !== null && typeof choice.delta === "object"
				? (choice.delta as Record<string, unknown>)
				: {};
		if (choice !== undefined && typeof choice.finish_reason === "string") {
			this.#stopReason = choice.finish_reason;
		}
		if (typeof delta.content === "string" && delta.content.length > 0) {
			this.#text(delta.content);
		}
		if (Array.isArray(delta.tool_calls)) {
			for (const call of delta.tool_calls) {
				this.#tool(call);
			}
		}
	}

	complete(): void {
		this.#begin();
		for (const tool of this.#tools.values()) {
			this.#startTool(tool);
		}
		for (const index of [...this.#open]) {
			this.#close(index);
		}
		const stop = this.#stopReason === "length" ? "max_tokens" : this.#sawToolUse ? "tool_use" : "end_turn";
		this.#send("message_delta", {
			type: "message_delta",
			delta: { stop_reason: stop, stop_sequence: null },
			usage: { input_tokens: Math.max(0, this.#inputTokens), output_tokens: Math.max(0, this.#outputTokens) },
		});
		this.#send("message_stop", { type: "message_stop" });
	}

	fail(type: string, message: string): void {
		this.#send("error", { type: "error", error: { type, message } });
	}

	#begin(): void {
		if (this.#started) {
			return;
		}
		this.#started = true;
		this.#send("message_start", {
			type: "message_start",
			message: {
				id: this.#messageId,
				type: "message",
				role: "assistant",
				model: this.#model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: Math.max(0, this.#inputTokens), output_tokens: 0 },
			},
		});
	}

	#text(text: string): void {
		this.#begin();
		if (this.#textIndex < 0) {
			this.#textIndex = this.#nextIndex++;
			this.#open.add(this.#textIndex);
			this.#send("content_block_start", {
				type: "content_block_start",
				index: this.#textIndex,
				content_block: { type: "text", text: "" },
			});
		}
		this.#send("content_block_delta", {
			type: "content_block_delta",
			index: this.#textIndex,
			delta: { type: "text_delta", text },
		});
	}

	#tool(call: unknown): void {
		this.#begin();
		this.#sawToolUse = true;
		if (this.#textIndex >= 0) {
			this.#close(this.#textIndex);
			this.#textIndex = -1;
		}
		const record = call !== null && typeof call === "object" ? (call as Record<string, unknown>) : {};
		const callIndex = typeof record.index === "number" ? record.index : 0;
		let tool = this.#tools.get(callIndex);
		if (tool === undefined) {
			tool = { index: -1, id: "", name: "", buffered: "" };
			this.#tools.set(callIndex, tool);
		}
		if (typeof record.id === "string" && record.id !== "") {
			tool.id = record.id;
		}
		const fn =
			record.function !== null && typeof record.function === "object"
				? (record.function as Record<string, unknown>)
				: {};
		if (typeof fn.name === "string") {
			tool.name += fn.name;
		}
		const args = typeof fn.arguments === "string" ? fn.arguments : "";
		if (tool.index < 0) {
			tool.buffered += args;
			if (tool.id.length > 0 && tool.name.length > 0 && args.length > 0) {
				this.#startTool(tool);
			}
		} else if (args.length > 0) {
			this.#arguments(tool.index, args);
		}
	}

	#startTool(tool: ToolState): void {
		if (tool.index >= 0) {
			return;
		}
		if (tool.id.length === 0 || tool.name.length === 0) {
			throw new GatewayFault(502, "invalid_tool_call", "服务返回了不完整的工具调用");
		}
		tool.index = this.#nextIndex++;
		this.#open.add(tool.index);
		this.#send("content_block_start", {
			type: "content_block_start",
			index: tool.index,
			content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
		});
		if (tool.buffered.length > 0) {
			this.#arguments(tool.index, tool.buffered);
			tool.buffered = "";
		}
	}

	#arguments(index: number, args: string): void {
		this.#send("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: { type: "input_json_delta", partial_json: args },
		});
	}

	#close(index: number): void {
		if (this.#open.delete(index)) {
			this.#send("content_block_stop", { type: "content_block_stop", index });
		}
	}

	#send(event: string, data: Record<string, unknown>): void {
		this.#sender(event, data);
	}
}
