/**
 * OpenAI Chat ⇄ Gemini generateContent 协议转换 —— 移植自 manager
 * `gateway/GeminiProtocolMapper`。只做形状转换，不做网络 IO。
 *
 * 请求：system/developer → systemInstruction；user/assistant → contents(role user/model)；
 * assistant.tool_calls → functionCall part；tool 消息 → functionResponse part
 * （函数名从同回合 assistant.tool_calls 反查）；tools → functionDeclarations；
 * tool_choice → toolConfig。响应：parts 文本/functionCall/thought → reasoning_content；
 * usageMetadata 的 candidates+thoughts 计入 completion（思考 token 按输出计费口径）。
 * 图片仅支持 data:URL 内联（远程 URL 不做服务端抓取）。
 */
import { randomUUID } from "node:crypto";
import { UpstreamException } from "../gateway/upstream.ts";
import { IncompleteUpstreamStreamException } from "./openai-stream.ts";

type Mapish = Record<string, unknown>;

const CHARS_PER_TOKEN = 4.0;

function isMap(value: unknown): value is Mapish {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
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

function writeJson(value: unknown): string {
	return JSON.stringify(value ?? {});
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max);
}

/** Gemini stopReason → OpenAI finish_reason（SAFETY/RECITATION 等按正常结束处理）。 */
export function geminiFinishReason(raw: unknown): string {
	switch (String(raw ?? "")) {
		case "MAX_TOKENS":
			return "length";
		case "STOP":
		case "null":
			return "stop";
		default:
			return "stop";
	}
}

/** RESOURCE_EXHAUSTED/429 → RATE 换号；认证类 → AUTH；请求形状 → BAD_REQUEST。 */
export function classifyGeminiError(
	status: number,
	geminiStatus: string | null,
	message: string | null,
): UpstreamException["kind"] {
	const text = `${message ?? ""} ${geminiStatus ?? ""}`;
	if (geminiStatus === "RESOURCE_EXHAUSTED" || status === 429) {
		return "RATE";
	}
	if (
		status === 401 ||
		status === 403 ||
		text.toLowerCase().includes("api key not valid") ||
		text.toLowerCase().includes("permission denied")
	) {
		return "AUTH";
	}
	if (status === 400 || status === 404) {
		return "BAD_REQUEST";
	}
	return "SERVER";
}

export class GeminiProtocolMapper {
	/** OpenAI Chat 请求 → Gemini generateContent 请求体（model 在路径上，不进 body）。 */
	toGeminiRequest(payload: Mapish, defaultMaxTokens: number): Mapish {
		const req: Mapish = {};
		let system = "";
		const contents: Mapish[] = [];
		// tool_call_id → function name（functionResponse 必须带原始函数名）
		const toolNames = new Map<string, string>();
		if (Array.isArray(payload.messages)) {
			for (const item of payload.messages) {
				if (isMap(item) && item.role === "assistant" && Array.isArray(item.tool_calls)) {
					for (const call of item.tool_calls) {
						if (
							isMap(call) &&
							call.id !== null &&
							call.id !== undefined &&
							isMap(call.function) &&
							call.function.name !== null &&
							call.function.name !== undefined
						) {
							toolNames.set(String(call.id), String(call.function.name));
						}
					}
				}
			}
		}
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
					this.#appendFunctionResponse(contents, toolNames, item);
					continue;
				}
				const geminiRole = role === "assistant" ? "model" : "user";
				const parts = this.#contentParts(item, geminiRole);
				if (parts.length > 0) {
					contents.push({ role: geminiRole, parts });
				}
			}
		}
		if (system.length > 0) {
			req.systemInstruction = { parts: [{ text: system }] };
		}
		req.contents = contents;

		const generationConfig: Mapish = {};
		let maxTokens = positiveInt(payload.max_tokens);
		if (maxTokens === null) {
			maxTokens = positiveInt(payload.max_completion_tokens);
		}
		generationConfig.maxOutputTokens = maxTokens ?? defaultMaxTokens;
		if (typeof payload.temperature === "number") {
			generationConfig.temperature = payload.temperature;
		}
		if (typeof payload.top_p === "number") {
			generationConfig.topP = payload.top_p;
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
				generationConfig.stopSequences = stops;
			}
		}
		req.generationConfig = generationConfig;

		if (Array.isArray(payload.tools) && payload.tools.length > 0) {
			const declarations: Mapish[] = [];
			for (const item of payload.tools) {
				if (
					isMap(item) &&
					isMap(item.function) &&
					item.function.name !== null &&
					item.function.name !== undefined
				) {
					const fn = item.function;
					const declaration: Mapish = { name: String(fn.name) };
					if (typeof fn.description === "string" && fn.description.trim().length > 0) {
						declaration.description = fn.description;
					}
					declaration.parameters = isMap(fn.parameters) ? fn.parameters : { type: "object", properties: {} };
					declarations.push(declaration);
				}
			}
			if (declarations.length > 0) {
				req.tools = [{ functionDeclarations: declarations }];
				const toolConfig = this.#toolConfig(payload.tool_choice, declarations);
				if (toolConfig !== null) {
					req.toolConfig = toolConfig;
				}
			}
		}
		return req;
	}

	/** Gemini generateContent 响应 → OpenAI chat.completion。 */
	toOpenAiCompletion(gemini: Mapish): Mapish {
		let text = "";
		let reasoning = "";
		const toolCalls: Mapish[] = [];
		const candidates = gemini.candidates;
		if (Array.isArray(candidates) && candidates.length > 0 && isMap(candidates[0])) {
			const content = (candidates[0] as Mapish).content;
			if (isMap(content) && Array.isArray(content.parts)) {
				for (const part of content.parts) {
					if (!isMap(part)) {
						continue;
					}
					if (
						isMap(part.functionCall) &&
						part.functionCall.name !== null &&
						part.functionCall.name !== undefined
					) {
						toolCalls.push({
							id: `call_${randomUUID().replaceAll("-", "")}`,
							type: "function",
							function: {
								name: String(part.functionCall.name),
								arguments: writeJson(part.functionCall.args ?? {}),
							},
						});
					} else if (typeof part.text === "string") {
						if (part.thought === true) {
							reasoning += part.text;
						} else {
							text += part.text;
						}
					}
				}
			}
		}
		let finish = geminiFinishReason(this.#firstCandidate(gemini).finishReason);
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
			model: String(gemini.modelVersion ?? "gemini"),
			choices: [{ index: 0, message, finish_reason: finish }],
			usage: this.openAiUsage(gemini.usageMetadata),
		};
	}

	newStreamDecoder(model: string, consumer: (chunkJson: string) => void): GeminiStreamDecoder {
		return new GeminiStreamDecoder(model, consumer);
	}

	/** HTTP 状态 + Gemini error 体 → 上游异常分类。 */
	httpError(status: number, body: string): UpstreamException {
		let message: string | null = null;
		let geminiStatus: string | null = null;
		let code: unknown = null;
		if (body.trim().length > 0) {
			try {
				const parsed: unknown = JSON.parse(body);
				if (isMap(parsed) && isMap(parsed.error)) {
					message = typeof parsed.error.message === "string" ? parsed.error.message : null;
					geminiStatus = typeof parsed.error.status === "string" ? parsed.error.status : null;
					code = parsed.error.code;
				} else if (isMap(parsed) && parsed.message !== null && parsed.message !== undefined) {
					message = String(parsed.message);
				}
			} catch {
				message = truncate(body, 200);
			}
		}
		const kind = classifyGeminiError(status, geminiStatus, message);
		let text = `Gemini HTTP ${status}`;
		if (code !== null && code !== undefined) {
			text += ` ${String(code)}`;
		}
		if (message !== null && message.trim().length > 0) {
			text += `: ${truncate(message, 200)}`;
		}
		return new UpstreamException(kind, text);
	}

	#firstCandidate(gemini: Mapish): Mapish {
		const candidates = gemini.candidates;
		if (Array.isArray(candidates) && candidates.length > 0 && isMap(candidates[0])) {
			return candidates[0] as Mapish;
		}
		return {};
	}

	openAiUsage(usageMetadata: unknown): Mapish {
		let input = 0;
		let completion = 0;
		if (isMap(usageMetadata)) {
			input = longValue(usageMetadata.promptTokenCount);
			completion = longValue(usageMetadata.candidatesTokenCount) + longValue(usageMetadata.thoughtsTokenCount);
		}
		return { prompt_tokens: input, completion_tokens: completion, total_tokens: input + completion };
	}

	#contentParts(msg: Mapish, role: string): Mapish[] {
		const parts: Mapish[] = [];
		if (role === "model" && Array.isArray(msg.tool_calls)) {
			for (const call of msg.tool_calls) {
				if (
					isMap(call) &&
					isMap(call.function) &&
					call.function.name !== null &&
					call.function.name !== undefined
				) {
					parts.push({
						functionCall: { name: String(call.function.name), args: parseJsonObject(call.function.arguments) },
					});
				}
			}
		}
		const content = msg.content;
		if (Array.isArray(content)) {
			for (const chunk of content) {
				if (typeof chunk === "string") {
					parts.push({ text: chunk });
				} else if (isMap(chunk) && chunk.type === "text" && chunk.text !== null && chunk.text !== undefined) {
					parts.push({ text: String(chunk.text) });
				} else if (isMap(chunk) && chunk.type === "image_url" && role === "user") {
					const inline = inlineData(chunk.image_url);
					if (inline !== null) {
						parts.push(inline);
					}
				}
			}
		} else if (typeof content === "string" && content.trim().length > 0) {
			parts.push({ text: content });
		}
		return parts;
	}

	#appendFunctionResponse(contents: Mapish[], toolNames: Map<string, string>, msg: Mapish): void {
		const toolCallId = msg.tool_call_id === null || msg.tool_call_id === undefined ? msg.id : msg.tool_call_id;
		if (toolCallId === null || toolCallId === undefined) {
			return;
		}
		const name = toolNames.get(String(toolCallId)) ?? String(toolCallId);
		const text = flattenText(msg.content);
		contents.push({
			role: "user",
			parts: [{ functionResponse: { name, response: { result: text === null ? "" : text } } }],
		});
	}

	#toolConfig(raw: unknown, _declarations: Mapish[]): Mapish | null {
		let mode: string | null = null;
		let allowed: string[] | null = null;
		if (typeof raw === "string") {
			mode = raw === "none" ? "NONE" : raw === "required" ? "ANY" : null;
		} else if (isMap(raw)) {
			let name: string | null = null;
			if (raw.type === "tool" && raw.name !== null && raw.name !== undefined) {
				name = String(raw.name);
			} else if (isMap(raw.function) && raw.function.name !== null && raw.function.name !== undefined) {
				name = String(raw.function.name);
			}
			if (name !== null) {
				mode = "ANY";
				allowed = [name];
			}
		}
		if (mode === null) {
			return null;
		}
		const config: Mapish = { mode };
		if (allowed !== null) {
			config.allowedFunctionNames = allowed;
		}
		return { functionCallingConfig: config };
	}
}

/** Gemini 仅支持 base64 内联图；远程 URL 不抓取。 */
function inlineData(imageUrl: unknown): Mapish | null {
	let url: string | null = null;
	if (isMap(imageUrl) && imageUrl.url !== null && imageUrl.url !== undefined) {
		url = String(imageUrl.url);
	} else if (typeof imageUrl === "string") {
		url = imageUrl;
	}
	if (url === null || !url.startsWith("data:")) {
		return null;
	}
	const comma = url.indexOf(",");
	if (comma <= 5) {
		return null;
	}
	const meta = url.slice(5, comma);
	const semicolon = meta.indexOf(";");
	let mimeType = semicolon > 0 ? meta.slice(0, semicolon) : meta;
	if (mimeType.trim().length === 0) {
		mimeType = "image/png";
	}
	return { inline_data: { mimeType, data: url.slice(comma + 1) } };
}

/** 单次流式调用的解码状态：alt=sse 的 JSON chunk → OpenAI delta；显式 finishReason 才准收尾。 */
export class GeminiStreamDecoder {
	readonly #id = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
	readonly #created = Math.floor(Date.now() / 1000);
	readonly #model: string;
	readonly #consumer: (chunkJson: string) => void;
	#nextToolIndex = 0;
	#sentRole = false;
	#finishReason = "stop";
	#sawToolCall = false;
	#terminal = false;
	#finished = false;
	#usage: Mapish | null = null;

	constructor(model: string, consumer: (chunkJson: string) => void) {
		this.#model = model;
		this.#consumer = consumer;
	}

	/** 处理一条 SSE data（不含 data: 前缀）。返回 false 表示流已终结。 */
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
		if (isMap(event.error)) {
			const mapper = new GeminiProtocolMapper();
			throw mapper.httpError(500, JSON.stringify({ error: event.error }));
		}
		if (Array.isArray(event.candidates)) {
			for (const candidate of event.candidates) {
				if (!isMap(candidate)) {
					continue;
				}
				if (isMap(candidate.content) && Array.isArray(candidate.content.parts)) {
					for (const part of candidate.content.parts) {
						this.#emitPart(part);
					}
				}
				if (
					typeof candidate.finishReason === "string" &&
					candidate.finishReason.trim().length > 0 &&
					candidate.finishReason !== "FINISH_REASON_UNSPECIFIED"
				) {
					this.#finishReason = geminiFinishReason(candidate.finishReason);
					this.#terminal = true;
				}
			}
		}
		if (isMap(event.usageMetadata)) {
			this.#usage = { ...event.usageMetadata };
		}
		if (
			isMap(event.promptFeedback) &&
			typeof event.promptFeedback.blockReason === "string" &&
			event.promptFeedback.blockReason.trim().length > 0 &&
			event.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED"
		) {
			this.#terminal = true;
			this.#finishReason = "content_filter";
		}
		return true;
	}

	isComplete(): boolean {
		return this.#terminal;
	}

	/** 显式 candidate finishReason 或 prompt 拒绝必须先于收尾 chunk。 */
	finish(): void {
		if (this.#finished) {
			return;
		}
		if (!this.#terminal) {
			throw new IncompleteUpstreamStreamException();
		}
		this.#finished = true;
		const effective = this.#finishReason === "stop" && this.#sawToolCall ? "tool_calls" : this.#finishReason;
		const chunk: Mapish = this.#baseChunk();
		chunk.choices = [{ index: 0, delta: {}, finish_reason: effective }];
		if (this.#usage !== null) {
			chunk.usage = new GeminiProtocolMapper().openAiUsage(this.#usage);
		}
		this.#consumer(JSON.stringify(chunk));
	}

	#emitPart(part: unknown): void {
		if (!isMap(part)) {
			return;
		}
		if (isMap(part.functionCall) && part.functionCall.name !== null && part.functionCall.name !== undefined) {
			this.#sawToolCall = true;
			const entry: Mapish = {
				index: this.#nextToolIndex++,
				id: `call_${randomUUID().replaceAll("-", "")}`,
				type: "function",
				function: { name: String(part.functionCall.name), arguments: writeJson(part.functionCall.args ?? {}) },
			};
			this.#emit((delta) => {
				delta.tool_calls = [entry];
			});
		} else if (typeof part.text === "string" && part.text.length > 0) {
			if (part.thought === true) {
				this.#emit((delta) => {
					delta.reasoning_content = part.text;
				});
			} else {
				this.#emit((delta) => {
					delta.content = part.text;
				});
			}
		}
	}

	#emit(fill: (delta: Mapish) => void): void {
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

	#baseChunk(): Mapish {
		return { id: this.#id, object: "chat.completion.chunk", created: this.#created, model: this.#model };
	}
}
