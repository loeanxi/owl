/**
 * OpenAI Chat ⇄ Anthropic Messages 上游映射 —— 移植自 manager
 * `gateway/ZCodeProtocolMapper`，叠加 `ClaudeProtocolMapper` 的三个扩展点
 * （thinking 预算注入、thinking 增量透出、缓存折算输入）。只做形状转换，不做网络 IO。
 *
 * 上游只讲 Anthropic 协议：请求必填 max_tokens；工具为 tool_use/tool_result 内容块；
 * 流式事件为 message_start / content_block_* / message_delta / message_stop。
 */
import { randomUUID } from "node:crypto";
import { stripModelPrefix } from "../gateway/model-router.ts";
import { UpstreamException } from "../gateway/upstream.ts";
import { IncompleteUpstreamStreamException } from "./openai-stream.ts";

type Mapish = Record<string, unknown>;

export interface AnthropicUpstreamMapperOptions {
	/** 错误信息前缀（"ZCode" / "Claude"）。 */
	label: string;
	/** Claude 叠加：effort → thinking 预算（≥1024 才注入，注入后移除 temperature）。 */
	thinkingBudgets?: { low: number; medium: number; high: number };
	/** Claude 叠加：thinking 增量/内容块透出为 reasoning_content。 */
	exposeThinking?: boolean;
	/** Claude 叠加：cache_creation/cache_read 折算进 prompt_tokens。 */
	foldCacheTokens?: boolean;
}

function isMap(value: unknown): value is Mapish {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	return null;
}

function longValue(value: unknown): number {
	return typeof value === "number" ? Math.trunc(value) : 0;
}

function flattenText(content: unknown): string | null {
	if (content === null || content === undefined) {
		return null;
	}
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		let out = "";
		for (const part of content) {
			const text = isMap(part)
				? typeof part.text === "string"
					? part.text
					: null
				: typeof part === "string"
					? part
					: null;
			if (text !== null) {
				if (out.length > 0) {
					out += "\n";
				}
				out += text;
			}
		}
		return out;
	}
	return null;
}

function parseJsonObject(args: unknown): Mapish {
	if (args === null || args === undefined) {
		return {};
	}
	if (isMap(args)) {
		return args;
	}
	if (typeof args === "string" && args.trim().length > 0) {
		try {
			const parsed: unknown = JSON.parse(args);
			return isMap(parsed) ? parsed : {};
		} catch {
			return { _raw: args };
		}
	}
	return { _raw: String(args) };
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max);
}

/** Anthropic stop_reason → OpenAI finish_reason。 */
function finishReason(stopReason: string | null): string {
	if (stopReason === null) {
		return "stop";
	}
	switch (stopReason) {
		case "max_tokens":
			return "length";
		case "tool_use":
			return "tool_calls";
		default:
			return "stop"; // end_turn / stop_sequence
	}
}

/**
 * BigModel 配额/欠费码（如 1113）或额度文案 → QUOTA（长冷却）；
 * 认证类 → AUTH；请求形状类 → BAD_REQUEST（不换号）；其余 SERVER。
 */
export function classifyUpstreamError(
	type: string | null,
	message: string | null,
	code: unknown,
): UpstreamException["kind"] {
	const text = `${message ?? ""} ${code === null || code === undefined ? "" : String(code)}`;
	if (
		text.includes("1113") ||
		text.includes("1005") ||
		text.includes("PlanLimit") ||
		text.includes("额度") ||
		text.includes("积分") ||
		text.toLowerCase().includes("insufficient") ||
		text.toLowerCase().includes("quota")
	) {
		return "QUOTA";
	}
	if (type === null) {
		return "SERVER";
	}
	switch (type) {
		case "authentication_error":
		case "permission_error":
			return "AUTH";
		case "invalid_request_error":
		case "not_found_error":
		case "request_too_large":
			return "BAD_REQUEST";
		case "rate_limit_error":
			return "RATE";
		default:
			return "SERVER";
	}
}

/** 单次流式调用的解码状态：块索引→工具序号映射、首 chunk 角色与收尾 usage。 */
export function buildUpstreamError(label: string, error: unknown): UpstreamException {
	let type: string | null = null;
	let message: string | null = null;
	let code: unknown = null;
	if (isMap(error)) {
		type = typeof error.type === "string" ? error.type : null;
		message = typeof error.message === "string" ? error.message : null;
		code = error.code;
	}
	return new UpstreamException(
		classifyUpstreamError(type, message, code),
		`${label} 上游错误${code !== null && code !== undefined ? ` ${String(code)}` : ""}${message !== null && message.trim().length > 0 ? `: ${message}` : ""}`,
	);
}

export class AnthropicStreamDecoder {
	readonly #id = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
	readonly #created = Math.floor(Date.now() / 1000);
	readonly #model: string;
	readonly #consumer: (chunkJson: string) => void;
	readonly #options: AnthropicUpstreamMapperOptions;
	readonly #toolIndexByBlock = new Map<number, number>();
	#nextToolIndex = 0;
	#sentRole = false;
	#finishReason = "stop";
	#sawToolUse = false;
	#terminal = false;
	#responseEvidence = false;
	#finished = false;
	#inputTokens = 0;
	#outputTokens = 0;

	constructor(model: string, consumer: (chunkJson: string) => void, options: AnthropicUpstreamMapperOptions) {
		this.#model = model;
		this.#consumer = consumer;
		this.#options = options;
	}

	/** 处理一条 SSE data（不含 data: 前缀）。返回 false 表示流已终结（message_stop）。 */
	onEvent(data: string): boolean {
		let event: Mapish;
		try {
			const parsed: unknown = JSON.parse(data);
			if (!isMap(parsed)) {
				throw new IncompleteUpstreamStreamException();
			}
			event = parsed;
		} catch (error) {
			if (error instanceof IncompleteUpstreamStreamException) {
				throw error;
			}
			throw new IncompleteUpstreamStreamException();
		}
		const type = typeof event.type === "string" ? event.type : "";
		switch (type) {
			case "message_start": {
				if (isMap(event.message) && isMap(event.message.usage)) {
					this.#inputTokens = longValue(event.message.usage.input_tokens);
					this.#outputTokens = longValue(event.message.usage.output_tokens);
				}
				break;
			}
			case "content_block_start": {
				if (isMap(event.content_block) && event.content_block.type === "tool_use") {
					this.#sawToolUse = true;
					const blockIndex = longValue(event.index);
					const toolIndex = this.#nextToolIndex++;
					this.#toolIndexByBlock.set(blockIndex, toolIndex);
					const call: Mapish = {
						index: toolIndex,
						id:
							event.content_block.id === null || event.content_block.id === undefined
								? `call_${randomUUID().replaceAll("-", "").slice(0, 8)}`
								: String(event.content_block.id),
						type: "function",
						function: { name: String(event.content_block.name ?? ""), arguments: "" },
					};
					this.#emit((delta) => {
						delta.tool_calls = [call];
					});
				}
				break;
			}
			case "content_block_delta": {
				if (!isMap(event.delta)) {
					break;
				}
				const delta = event.delta;
				if (delta.type === "text_delta" && delta.text !== null && delta.text !== undefined) {
					const text = String(delta.text);
					this.#emit((d) => {
						d.content = text;
					});
				} else if (delta.type === "thinking_delta") {
					this.#onThinkingDelta(
						delta.thinking === null || delta.thinking === undefined ? "" : String(delta.thinking),
					);
				} else if (
					delta.type === "input_json_delta" &&
					delta.partial_json !== null &&
					delta.partial_json !== undefined
				) {
					const blockIndex = longValue(event.index);
					const toolIndex = this.#toolIndexByBlock.get(blockIndex);
					if (toolIndex !== undefined) {
						const call: Mapish = { index: toolIndex, function: { arguments: String(delta.partial_json) } };
						this.#emit((d) => {
							d.tool_calls = [call];
						});
					}
				}
				// signature_delta 等其余增量无输出语义
				break;
			}
			case "message_delta": {
				if (
					isMap(event.delta) &&
					typeof event.delta.stop_reason === "string" &&
					event.delta.stop_reason.length > 0
				) {
					this.#finishReason = finishReason(event.delta.stop_reason);
					this.#responseEvidence = true;
				}
				if (isMap(event.usage)) {
					this.#inputTokens = Math.max(this.#inputTokens, longValue(event.usage.input_tokens));
					this.#outputTokens = Math.max(this.#outputTokens, longValue(event.usage.output_tokens));
				}
				break;
			}
			case "message_stop": {
				this.#terminal = true;
				return false;
			}
			case "error":
				throw buildUpstreamError(this.#options.label, event.error);
			default:
				// ping / content_block_stop 等无输出语义
				break;
		}
		return true;
	}

	/** 兼容用 [DONE] 而非原生 message_stop 收尾的网关。 */
	done(): void {
		this.#terminal = true;
	}

	isComplete(): boolean {
		return this.#terminal && this.#responseEvidence;
	}

	/** 只有显式完成的响应才能产出成功的收尾 chunk。 */
	finish(): void {
		if (this.#finished) {
			return;
		}
		if (!this.isComplete()) {
			throw new IncompleteUpstreamStreamException();
		}
		this.#finished = true;
		const effective = this.#finishReason === "stop" && this.#sawToolUse ? "tool_calls" : this.#finishReason;
		const chunk: Mapish = this.#baseChunk();
		chunk.choices = [{ index: 0, delta: {}, finish_reason: effective }];
		chunk.usage = {
			prompt_tokens: this.#inputTokens,
			completion_tokens: this.#outputTokens,
			total_tokens: this.#inputTokens + this.#outputTokens,
		};
		this.#consumer(JSON.stringify(chunk));
	}

	#emit(fill: (delta: Mapish) => void): void {
		this.#responseEvidence = true;
		const chunk: Mapish = this.#baseChunk();
		const delta: Mapish = {};
		if (!this.#sentRole) {
			delta.role = "assistant";
			this.#sentRole = true;
		}
		fill(delta);
		chunk.choices = [{ index: 0, delta, finish_reason: null }];
		this.#consumer(JSON.stringify(chunk));
	}

	#onThinkingDelta(thinking: string): void {
		if (this.#options.exposeThinking && thinking.length > 0) {
			this.#emit((delta) => {
				delta.reasoning_content = thinking;
			});
		}
	}

	#baseChunk(): Mapish {
		return { id: this.#id, object: "chat.completion.chunk", created: this.#created, model: this.#model };
	}
}

export class AnthropicUpstreamMapper {
	readonly #options: AnthropicUpstreamMapperOptions;

	constructor(options: AnthropicUpstreamMapperOptions) {
		this.#options = options;
	}

	/** OpenAI Chat 请求 → Anthropic Messages 请求。 */
	toAnthropicRequest(payload: Mapish, defaultMaxTokens: number): Mapish {
		const req: Mapish = {};
		req.model = stripModelPrefix(typeof payload.model === "string" ? payload.model : null);
		let maxTokens = positiveInt(payload.max_tokens);
		if (maxTokens === null) {
			maxTokens = positiveInt(payload.max_completion_tokens);
		}
		req.max_tokens = maxTokens ?? defaultMaxTokens;

		let system = "";
		const messages: Mapish[] = [];
		const pendingToolResults: Mapish[] = [];
		if (Array.isArray(payload.messages)) {
			for (const item of payload.messages) {
				if (!isMap(item)) {
					continue;
				}
				const role = String(item.role);
				if (role === "system" || role === "developer") {
					const text = flattenText(item.content);
					if (text !== null && text.trim().length > 0) {
						system = system.length > 0 ? `${system}\n\n${text}` : text;
					}
					continue;
				}
				if (role === "tool" || role === "function") {
					const block = this.#toolResultBlock(item);
					if (block !== null) {
						pendingToolResults.push(block);
					}
					continue;
				}
				this.#flushToolResults(messages, pendingToolResults);
				messages.push(role === "assistant" ? this.#assistantMessage(item) : this.#userMessage(item));
			}
		}
		this.#flushToolResults(messages, pendingToolResults);
		if (system.length > 0) {
			req.system = system;
		}
		req.messages = messages;

		if (Array.isArray(payload.tools) && payload.tools.length > 0) {
			const anthropicTools: Mapish[] = [];
			for (const item of payload.tools) {
				if (
					isMap(item) &&
					isMap(item.function) &&
					item.function.name !== null &&
					item.function.name !== undefined
				) {
					const fn = item.function;
					const converted: Mapish = { name: String(fn.name) };
					if (typeof fn.description === "string" && fn.description.trim().length > 0) {
						converted.description = fn.description;
					}
					converted.input_schema = isMap(fn.parameters) ? fn.parameters : { type: "object", properties: {} };
					anthropicTools.push(converted);
				}
			}
			if (anthropicTools.length > 0) {
				req.tools = anthropicTools;
				const toolChoice = this.#toolChoice(payload.tool_choice);
				if (toolChoice !== null) {
					req.tool_choice = toolChoice;
				}
			}
		}
		if (payload.stop !== null && payload.stop !== undefined) {
			const stops: string[] = [];
			if (Array.isArray(payload.stop)) {
				for (const stop of payload.stop) {
					if (stop !== null && stop !== undefined) {
						stops.push(String(stop));
					}
				}
			} else {
				stops.push(String(payload.stop));
			}
			if (stops.length > 0) {
				req.stop_sequences = stops;
			}
		}
		if (typeof payload.temperature === "number") {
			req.temperature = payload.temperature;
		}
		if (typeof payload.top_p === "number") {
			req.top_p = payload.top_p;
		}
		return this.augmentRequest(payload, req);
	}

	/** 请求级扩展点：Claude 注入 thinking 预算（与 temperature 互斥）。 */
	augmentRequest(payload: Mapish, req: Mapish): Mapish {
		const budgets = this.#options.thinkingBudgets;
		if (budgets === undefined) {
			return req;
		}
		const effort = typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : null;
		if (effort === null) {
			return req;
		}
		const budget =
			effort === "low"
				? budgets.low
				: effort === "medium"
					? budgets.medium
					: effort === "high"
						? budgets.high
						: null;
		if (budget !== null && budget >= 1024) {
			req.thinking = { type: "enabled", budget_tokens: budget };
			// Anthropic 约束：thinking 启用时 temperature 不可设置
			delete req.temperature;
		}
		return req;
	}

	/** Anthropic 完整响应 → OpenAI chat.completion。 */
	toOpenAiCompletion(anthropic: Mapish): Mapish {
		let text = "";
		let reasoning = "";
		const toolCalls: Mapish[] = [];
		if (Array.isArray(anthropic.content)) {
			for (const item of anthropic.content) {
				if (!isMap(item)) {
					continue;
				}
				if (item.type === "text" && typeof item.text === "string") {
					text += item.text;
				} else if (item.type === "thinking") {
					const reasoningText = this.#reasoningText(item);
					if (reasoningText !== null && reasoningText.trim().length > 0) {
						reasoning = reasoning.length > 0 ? `${reasoning}\n${reasoningText}` : reasoningText;
					}
				} else if (item.type === "tool_use" && item.name !== null && item.name !== undefined) {
					toolCalls.push({
						id:
							item.id === null || item.id === undefined
								? `call_${randomUUID().replaceAll("-", "").slice(0, 8)}`
								: String(item.id),
						type: "function",
						function: { name: String(item.name), arguments: JSON.stringify(item.input ?? {}) },
					});
				}
			}
		}
		let finish = finishReason(typeof anthropic.stop_reason === "string" ? anthropic.stop_reason : null);
		if (finish === "stop" && toolCalls.length > 0) {
			finish = "tool_calls";
		}
		const message: Mapish = { role: "assistant", content: text.length > 0 ? text : null };
		if (reasoning.length > 0) {
			message.reasoning_content = reasoning;
		}
		if (toolCalls.length > 0) {
			message.tool_calls = toolCalls;
		}
		return {
			id: `chatcmpl_${randomUUID().replaceAll("-", "")}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: String(anthropic.model ?? "unknown"),
			choices: [{ index: 0, message, finish_reason: finish }],
			usage: this.#openAiUsage(anthropic.usage),
		};
	}

	newStreamDecoder(model: string, consumer: (chunkJson: string) => void): AnthropicStreamDecoder {
		return new AnthropicStreamDecoder(model, consumer, this.#options);
	}

	/** Anthropic 流内 error 事件 → 上游异常（含 BigModel 配额码识别）。 */
	#errorEvent(error: unknown): UpstreamException {
		return buildUpstreamError(this.#options.label, error);
	}

	/** HTTP 状态 + Anthropic error 体 → 上游异常分类。 */
	httpError(status: number, body: string): UpstreamException {
		let type: string | null = null;
		let message: string | null = null;
		let code: unknown = null;
		if (body.trim().length > 0) {
			try {
				const parsed: unknown = JSON.parse(body);
				if (isMap(parsed) && isMap(parsed.error)) {
					type = typeof parsed.error.type === "string" ? parsed.error.type : null;
					message = typeof parsed.error.message === "string" ? parsed.error.message : null;
					code = parsed.error.code;
				} else if (isMap(parsed) && parsed.message !== null && parsed.message !== undefined) {
					message = String(parsed.message);
				}
			} catch {
				// 非 JSON 体按原文截断
				message = truncate(body, 200);
			}
		}
		let kind = classifyUpstreamError(type, message, code);
		if (status === 401 || status === 403) {
			kind = "AUTH";
		} else if (status === 429 && kind !== "QUOTA") {
			kind = "RATE";
		}
		let text = `${this.#options.label} HTTP ${status}`;
		if (code !== null && code !== undefined) {
			text += ` ${String(code)}`;
		}
		if (message !== null && message.trim().length > 0) {
			text += `: ${truncate(message, 200)}`;
		}
		return new UpstreamException(kind, text);
	}

	#openAiUsage(anthropicUsage: unknown): Mapish {
		let input = 0;
		let output = 0;
		if (isMap(anthropicUsage)) {
			input = longValue(anthropicUsage.input_tokens);
			output = longValue(anthropicUsage.output_tokens);
			if (this.#options.foldCacheTokens) {
				// Anthropic input_tokens 不含缓存分量；内部只按 prompt/completion 记账
				input +=
					longValue(anthropicUsage.cache_creation_input_tokens) +
					longValue(anthropicUsage.cache_read_input_tokens);
			}
		}
		return {
			prompt_tokens: input,
			completion_tokens: output,
			total_tokens: input + output,
		};
	}

	/** 非流式 thinking 内容块 → reasoning 文本（Claude 叠加，ZCode 默认不透出）。 */
	#reasoningText(block: Mapish): string | null {
		return this.#options.exposeThinking && typeof block.thinking === "string" ? block.thinking : null;
	}

	#flushToolResults(messages: Mapish[], pending: Mapish[]): void {
		if (pending.length === 0) {
			return;
		}
		messages.push({ role: "user", content: [...pending] });
		pending.length = 0;
	}

	#userMessage(msg: Mapish): Mapish {
		const blocks = this.#contentBlocks(msg.content, false);
		if (blocks.length === 0) {
			blocks.push(this.#textBlock(""));
		}
		return { role: "user", content: blocks };
	}

	#assistantMessage(msg: Mapish): Mapish {
		const blocks = this.#contentBlocks(msg.content, true);
		if (Array.isArray(msg.tool_calls)) {
			for (const item of msg.tool_calls) {
				if (
					!isMap(item) ||
					!isMap(item.function) ||
					item.function.name === null ||
					item.function.name === undefined
				) {
					continue;
				}
				blocks.push({
					type: "tool_use",
					id:
						item.id === null || item.id === undefined
							? `call_${randomUUID().replaceAll("-", "").slice(0, 8)}`
							: String(item.id),
					name: String(item.function.name),
					input: parseJsonObject(item.function.arguments),
				});
			}
		}
		if (blocks.length === 0) {
			blocks.push(this.#textBlock(""));
		}
		return { role: "assistant", content: blocks };
	}

	#toolResultBlock(msg: Mapish): Mapish | null {
		let toolCallId: unknown = msg.tool_call_id;
		if ((toolCallId === null || toolCallId === undefined) && msg.id !== null && msg.id !== undefined) {
			toolCallId = msg.id;
		}
		if (toolCallId === null || toolCallId === undefined || String(toolCallId).trim().length === 0) {
			return null;
		}
		const block: Mapish = { type: "tool_result", tool_use_id: String(toolCallId) };
		const content = msg.content;
		if (Array.isArray(content)) {
			const blocks: Mapish[] = [];
			let simple = true;
			for (const part of content) {
				if (isMap(part) && part.type === "text" && part.text !== null && part.text !== undefined) {
					blocks.push(this.#textBlock(String(part.text)));
				} else if (isMap(part) && part.type === "image_url") {
					const image = this.#imageFromUrl(part.image_url);
					if (image !== null) {
						blocks.push(image);
						simple = false;
					}
				} else if (typeof part === "string") {
					blocks.push(this.#textBlock(part));
				}
			}
			if (blocks.length > 0) {
				block.content = simple ? flattenBlocks(blocks) : blocks;
			}
		} else if (content !== null && content !== undefined) {
			block.content = String(content);
		}
		return block;
	}

	/** 任意 OpenAI content（string 或部件数组）→ Anthropic 内容块数组。 */
	#contentBlocks(content: unknown, assistant: boolean): Mapish[] {
		const blocks: Mapish[] = [];
		if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === "string") {
					blocks.push(this.#textBlock(part));
				} else if (!isMap(part)) {
				} else if (part.type === "text" && part.text !== null && part.text !== undefined) {
					blocks.push(this.#textBlock(String(part.text)));
				} else if (part.type === "image_url" && !assistant) {
					const image = this.#imageFromUrl(part.image_url);
					if (image !== null) {
						blocks.push(image);
					}
				}
			}
		} else if (
			content !== null &&
			content !== undefined &&
			!(typeof content === "string" && content.trim().length === 0)
		) {
			blocks.push(this.#textBlock(String(content)));
		}
		return blocks;
	}

	/** data: URL → base64 块；http(s) → url 块。 */
	#imageFromUrl(imageUrl: unknown): Mapish | null {
		let url: string | null = null;
		if (isMap(imageUrl) && imageUrl.url !== null && imageUrl.url !== undefined) {
			url = String(imageUrl.url);
		} else if (typeof imageUrl === "string") {
			url = imageUrl;
		}
		if (url === null || url.trim().length === 0) {
			return null;
		}
		let source: Mapish;
		if (url.startsWith("data:")) {
			const comma = url.indexOf(",");
			if (comma > 5 && comma < url.length - 1) {
				const meta = url.slice(5, comma);
				const semicolon = meta.indexOf(";");
				let mediaType = semicolon > 0 ? meta.slice(0, semicolon) : meta;
				if (mediaType.trim().length === 0) {
					mediaType = "image/png";
				}
				source = { type: "base64", media_type: mediaType, data: url.slice(comma + 1) };
			} else {
				return null;
			}
		} else {
			source = { type: "url", url };
		}
		return { type: "image", source };
	}

	#toolChoice(raw: unknown): Mapish | null {
		if (raw === null || raw === undefined) {
			return null;
		}
		if (typeof raw === "string") {
			switch (raw) {
				case "auto":
					return { type: "auto" };
				case "none":
					return { type: "none" };
				case "required":
					return { type: "any" };
				default:
					return null;
			}
		}
		if (isMap(raw)) {
			if (raw.type === "tool" && raw.name !== null && raw.name !== undefined) {
				return { type: "tool", name: String(raw.name) };
			}
			if (isMap(raw.function) && raw.function.name !== null && raw.function.name !== undefined) {
				return { type: "tool", name: String(raw.function.name) };
			}
		}
		return null;
	}

	#textBlock(text: string): Mapish {
		return { type: "text", text: text ?? "" };
	}
}

function flattenBlocks(blocks: Mapish[]): string {
	return blocks
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}
