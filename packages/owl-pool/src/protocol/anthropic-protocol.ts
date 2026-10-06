/**
 * Anthropic Messages ↔ OpenAI chat.completions 形状转换（对外协议面）——
 * 移植自 manager `gateway/AnthropicProtocolMapper`。仅做协议映射，不碰鉴权/选号/上游。
 */
import { randomUUID } from "node:crypto";
import { GatewayFault } from "../gateway/upstream.ts";

const DEFAULT_MAX_TOKENS = 8192;
const CHARS_PER_TOKEN = 4.0;
const LOW_MAX_BUDGET_TOKENS = 8192;
const MEDIUM_MAX_BUDGET_TOKENS = 20480;

type Mapish = Record<string, unknown>;

export type AnthropicStreamSender = (event: string, data: Mapish) => void;

function str(map: Mapish, key: string, fallback: string): string {
	const value = map[key];
	return value === null || value === undefined ? fallback : String(value);
}

function strOrNull(map: Mapish, key: string): string | null {
	const value = map[key];
	return typeof value === "string" ? value : null;
}

function copyIfPresent(out: Mapish, req: Mapish, key: string): void {
	if (req[key] !== null && req[key] !== undefined) {
		out[key] = req[key];
	}
}

function isMap(value: unknown): value is Mapish {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Anthropic thinking 开关 → 网关思考等级；关闭或未开启返回 null。 */
function thinkingEffort(thinking: unknown): string | null {
	if (thinking === null || thinking === undefined || thinking === false) {
		return null;
	}
	if (!isMap(thinking)) {
		return "medium";
	}
	if (Object.keys(thinking).length === 0 || thinking.type === "disabled") {
		return null;
	}
	const budget = thinking.budget_tokens;
	if (typeof budget !== "number") {
		return "medium";
	}
	if (budget <= LOW_MAX_BUDGET_TOKENS) {
		return "low";
	}
	return budget <= MEDIUM_MAX_BUDGET_TOKENS ? "medium" : "high";
}

/** Anthropic Messages 请求 → OpenAI chat.completions 请求。 */
export function anthropicToOpenAiPayload(req: Mapish, codexRoute = false): Mapish {
	const out: Mapish = {};
	out.model = str(req, "model", "unknown");
	out.max_tokens = requestMaxTokens(req);

	const messages: Mapish[] = [];
	appendSystem(messages, req.system);
	appendMessages(messages, req.messages);
	out.messages = messages;

	if (Array.isArray(req.tools) && req.tools.length > 0) {
		out.tools = convertTools(req.tools);
	}
	const toolChoice = convertToolChoice(req.tool_choice);
	if (toolChoice !== null && toolChoice !== undefined) {
		out.tool_choice = toolChoice;
	}
	copyIfPresent(out, req, "temperature");
	copyIfPresent(out, req, "top_p");
	// 显式扩展：客户端可直接选择档位
	copyIfPresent(out, req, "reasoning_effort");
	if (out.reasoning_effort === null || out.reasoning_effort === undefined) {
		// Claude Code 等用 thinking.budget_tokens 表达思考预算；按区间归入网关档位
		const budgetEffort = thinkingEffort(req.thinking);
		if (budgetEffort !== null) {
			out.reasoning_effort = budgetEffort;
		}
	}
	copyIfPresent(out, req, "context_window");
	copyIfPresent(out, req, "capability_mode");
	if (Array.isArray(req.stop_sequences) && req.stop_sequences.length > 0) {
		out.stop = req.stop_sequences;
	}
	if (isMap(req.metadata) && req.metadata.user_id !== null && req.metadata.user_id !== undefined) {
		out.user = String(req.metadata.user_id);
	}
	const stream = req.stream === true || String(req.stream) === "true";
	out.stream = stream;
	if (codexRoute) {
		const failedToolIds = collectFailedToolIds(req.messages);
		if (failedToolIds.length > 0) {
			out._codexToolErrorIds = failedToolIds;
		}
	}
	return out;
}

function collectFailedToolIds(rawMessages: unknown): string[] {
	const failedIds: string[] = [];
	if (!Array.isArray(rawMessages)) {
		return failedIds;
	}
	for (const item of rawMessages) {
		if (!isMap(item) || str(item, "role", "user") !== "user" || !Array.isArray(item.content)) {
			continue;
		}
		for (const block of item.content) {
			if (!isMap(block) || str(block, "type", "") !== "tool_result" || block.is_error !== true) {
				continue;
			}
			const id = str(block, "tool_use_id", "");
			if (id.length > 0 && !failedIds.includes(id)) {
				failedIds.push(id);
			}
		}
	}
	return failedIds;
}

/** OpenAI 完整响应 → Anthropic message 对象。 */
export function openAiToAnthropicMessage(openAiBody: Mapish, requestedModel: string | null): Mapish {
	const message: Mapish = {};
	message.id = `msg_${randomUUID().replaceAll("-", "")}`;
	message.type = "message";
	message.role = "assistant";
	message.model = requestedModel ?? str(openAiBody, "model", "unknown");
	message.content = convertAssistantContent(openAiBody);
	message.stop_reason = mapStopReason(openAiBody, hasToolUse(openAiBody));
	message.stop_sequence = null;
	message.usage = convertUsage(openAiBody.usage);
	return message;
}

export function anthropicErrorBody(type: string | null, message: string | null): Mapish {
	return {
		type: "error",
		error: {
			type: type === null || type.trim().length === 0 ? "api_error" : type,
			message: message === null ? "上游错误" : message,
		},
	};
}

/** 粗算 input_tokens，供 count_tokens / message_start 用。 */
export function estimateAnthropicInputTokens(anthropicReq: Mapish): number {
	let chars = flattenText(anthropicReq.system)?.length ?? 0;
	if (Array.isArray(anthropicReq.messages)) {
		for (const msg of anthropicReq.messages) {
			if (isMap(msg)) {
				chars += flattenText(msg.content)?.length ?? 0;
			}
		}
	}
	return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

function appendSystem(messages: Mapish[], system: unknown): void {
	const text = flattenText(system);
	if (text === null || text.trim().length === 0) {
		return;
	}
	messages.push({ role: "system", content: text });
}

function appendMessages(messages: Mapish[], raw: unknown): void {
	if (!Array.isArray(raw)) {
		return;
	}
	for (const item of raw) {
		if (!isMap(item)) {
			continue;
		}
		const role = str(item, "role", "user");
		if (role === "assistant") {
			appendAssistant(messages, item.content);
		} else {
			appendUserBlocks(messages, item.content);
		}
	}
}

function appendAssistant(messages: Mapish[], content: unknown): void {
	if (typeof content === "string") {
		messages.push({ role: "assistant", content });
		return;
	}
	if (!Array.isArray(content)) {
		return;
	}
	let text = "";
	const toolCalls: Mapish[] = [];
	for (const block of content) {
		if (!isMap(block)) {
			continue;
		}
		const type = str(block, "type", "text");
		if (type === "text") {
			if (text.length > 0) {
				text += "\n";
			}
			text += str(block, "text", "");
		} else if (type === "tool_use") {
			toolCalls.push(convertToolUse(block));
		}
	}
	const msg: Mapish = { role: "assistant", content: text.length === 0 ? null : text };
	if (toolCalls.length > 0) {
		msg.tool_calls = toolCalls;
	}
	messages.push(msg);
}

function appendUserBlocks(messages: Mapish[], content: unknown): void {
	if (typeof content === "string") {
		messages.push({ role: "user", content });
		return;
	}
	if (!Array.isArray(content)) {
		return;
	}
	const userTexts: string[] = [];
	const userParts: Mapish[] = [];
	for (const block of content) {
		if (!isMap(block)) {
			continue;
		}
		const type = str(block, "type", "text");
		if (type === "tool_result") {
			flushUserParts(messages, userTexts, userParts);
			messages.push(convertToolResult(block));
			continue;
		}
		if (type === "text") {
			userTexts.push(str(block, "text", ""));
			continue;
		}
		if (type === "image") {
			const part = convertImage(block);
			if (part !== null) {
				userParts.push(part);
			}
		}
	}
	flushUserParts(messages, userTexts, userParts);
}

function flushUserParts(messages: Mapish[], userTexts: string[], userParts: Mapish[]): void {
	if (userTexts.length === 0 && userParts.length === 0) {
		return;
	}
	const msg: Mapish = { role: "user" };
	if (userParts.length === 0) {
		msg.content = userTexts.join("\n");
	} else {
		const content: unknown[] = userTexts.map((text) => ({ type: "text", text }));
		content.push(...userParts);
		msg.content = content;
	}
	messages.push(msg);
	userTexts.length = 0;
	userParts.length = 0;
}

function convertImage(block: Mapish): Mapish | null {
	const source = block.source;
	if (!isMap(source)) {
		return null;
	}
	const srcType = str(source, "type", "base64");
	let url: string;
	if (srcType === "url") {
		url = str(source, "url", "");
	} else {
		const media = str(source, "media_type", "image/png");
		const data = str(source, "data", "");
		url = `data:${media};base64,${data}`;
	}
	return { type: "image_url", image_url: { url } };
}

function convertToolUse(block: Mapish): Mapish {
	const id = str(block, "id", "");
	return {
		id: id.length === 0 ? `toolu_${randomUUID()}` : id,
		type: "function",
		function: {
			name: str(block, "name", ""),
			arguments: block.input === null || block.input === undefined ? "{}" : JSON.stringify(block.input),
		},
	};
}

function convertToolResult(block: Mapish): Mapish {
	return {
		role: "tool",
		tool_call_id: str(block, "tool_use_id", ""),
		content: flattenToolResultContent(block.content),
	};
}

function flattenToolResultContent(content: unknown): unknown {
	if (Array.isArray(content) && content.some((part) => isMap(part) && part.type === "image")) {
		const converted: Mapish[] = [];
		for (const item of content) {
			if (isMap(item)) {
				if (item.type === "image") {
					const image = convertImage(item);
					if (image === null) {
						throw new GatewayFault(400, "invalid_image", "图片格式无效");
					}
					converted.push(image);
				} else if (typeof item.text === "string") {
					converted.push({ type: "text", text: item.text });
				}
			} else if (typeof item === "string") {
				converted.push({ type: "text", text: item });
			}
		}
		return converted;
	}
	if (content === null || content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		let out = "";
		for (const part of content) {
			const text = isMap(part) ? strOrNull(part, "text") : typeof part === "string" ? part : null;
			if (text !== null) {
				if (out.length > 0) {
					out += "\n";
				}
				out += text;
			}
		}
		return out;
	}
	return JSON.stringify(content);
}

function convertTools(tools: unknown[]): Mapish[] {
	const out: Mapish[] = [];
	for (const item of tools) {
		if (!isMap(item)) {
			continue;
		}
		const fn: Mapish = { name: str(item, "name", ""), description: str(item, "description", "") };
		const schema = item.input_schema;
		if (schema === null || schema === undefined) {
			fn.parameters = { type: "object", properties: {} };
		} else {
			fn.parameters = schema;
		}
		out.push({ type: "function", function: fn });
	}
	return out;
}

function convertToolChoice(raw: unknown): unknown {
	if (raw === null || raw === undefined) {
		return null;
	}
	if (typeof raw === "string") {
		return raw;
	}
	if (!isMap(raw)) {
		return null;
	}
	const type = str(raw, "type", "auto");
	switch (type) {
		case "none":
			return "none";
		case "any":
			return "required";
		case "tool":
			return { type: "function", function: { name: str(raw, "name", "") } };
		default:
			return "auto";
	}
}

function convertAssistantContent(openAiBody: Mapish): Mapish[] {
	const content: Mapish[] = [];
	const message = choiceMessage(openAiBody);
	const text = message.content;
	if (typeof text === "string" && text.trim().length > 0) {
		content.push({ type: "text", text });
	}
	if (Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (isMap(call)) {
				content.push(convertOpenAiToolCall(call));
			}
		}
	}
	return content;
}

function convertOpenAiToolCall(call: Mapish): Mapish {
	const fn = isMap(call.function) ? call.function : call;
	const id = str(call, "id", "");
	let input: Mapish = {};
	try {
		const parsed: unknown = JSON.parse(str(fn, "arguments", "{}") || "{}");
		if (isMap(parsed)) {
			input = parsed;
		}
	} catch {
		input = { _raw: str(fn, "arguments", "") };
	}
	return {
		type: "tool_use",
		id: id.length === 0 ? `toolu_${randomUUID()}` : id,
		name: str(fn, "name", ""),
		input,
	};
}

function hasToolUse(openAiBody: Mapish): boolean {
	const calls = choiceMessage(openAiBody).tool_calls;
	return Array.isArray(calls) && calls.length > 0;
}

function mapStopReason(openAiBody: Mapish, toolUse: boolean): string {
	const finish = choiceFinish(openAiBody);
	switch (finish) {
		case "length":
			return "max_tokens";
		case "tool_calls":
		case "function_call":
			return "tool_use";
		case "stop_sequence":
			return "stop_sequence";
		default:
			return toolUse ? "tool_use" : "end_turn";
	}
}

function convertUsage(usage: unknown): Mapish {
	const out: Mapish = { input_tokens: 0, output_tokens: 0 };
	if (isMap(usage)) {
		out.input_tokens = asInt(usage.prompt_tokens, 0);
		out.output_tokens = asInt(usage.completion_tokens, 0);
	}
	return out;
}

function choiceMessage(openAiBody: Mapish): Mapish {
	const choices = openAiBody.choices;
	if (Array.isArray(choices) && choices.length > 0 && isMap(choices[0])) {
		const choice = choices[0] as Mapish;
		if (isMap(choice.message)) {
			return choice.message;
		}
	}
	return {};
}

function choiceFinish(openAiBody: Mapish): string {
	const choices = openAiBody.choices;
	if (Array.isArray(choices) && choices.length > 0 && isMap(choices[0])) {
		const finish = (choices[0] as Mapish).finish_reason;
		return finish === null || finish === undefined ? "stop" : String(finish);
	}
	return "stop";
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
			if (isMap(part)) {
				const text = strOrNull(part, "text");
				if (text !== null) {
					if (out.length > 0) {
						out += "\n";
					}
					out += text;
				}
			}
		}
		return out;
	}
	return null;
}

function requestMaxTokens(req: Mapish): number {
	if (!("max_tokens" in req)) {
		return DEFAULT_MAX_TOKENS;
	}
	const raw = req.max_tokens;
	if (typeof raw !== "number" || !Number.isInteger(raw)) {
		throw invalidMaxTokens();
	}
	if (raw <= 0 || raw > Number.MAX_SAFE_INTEGER) {
		throw invalidMaxTokens();
	}
	return raw;
}

function invalidMaxTokens(): GatewayFault {
	return new GatewayFault(400, "invalid_max_tokens", "max_tokens 必须是 1 至 2147483647 的 JSON 整数");
}

function asInt(value: unknown, fallback: number): number {
	if (typeof value === "number") {
		return Math.trunc(value);
	}
	try {
		return value === null || value === undefined ? fallback : Number.parseInt(String(value), 10);
	} catch {
		return fallback;
	}
}
