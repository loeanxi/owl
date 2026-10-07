/**
 * OpenAI Responses 子集 —— 移植自 manager `gateway/responses`。
 * 支持文字、图片和 function 工具；短期上下文只留在本进程内存里。
 */
import { randomUUID } from "node:crypto";
import type { ApiKey } from "owl-pool";
import { GatewayFault } from "owl-pool";

const MAX_PENDING = 128;
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRY_BYTES = 4_000_000;
const MAX_TOTAL_BYTES = 32_000_000;
const MAX_PREFLIGHT_BYTES = 2_000_000;

interface Context {
	model: string;
	messages: Array<Record<string, unknown>>;
	response: Record<string, unknown>;
}

interface Entry {
	owner: string;
	context: Context;
	expires: number;
	bytes: number;
}

const entries = new Map<string, Entry>();

export function preflightResponse(key: ApiKey, messages: Array<Record<string, unknown>>): void {
	ownerOf(key);
	if (byteSize(messages) > MAX_PREFLIGHT_BYTES) {
		throw tooLarge();
	}
}

export function getResponse(key: ApiKey, id: string): Context {
	purge();
	const entry = entries.get(id);
	if (entry === undefined || entry.owner !== ownerOf(key)) {
		throw missing();
	}
	return structuredClone(entry.context);
}

export function putResponse(
	key: ApiKey,
	id: string,
	model: string,
	messages: Array<Record<string, unknown>>,
	response: Record<string, unknown>,
): void {
	purge();
	const context: Context = { model, messages: structuredClone(messages), response: structuredClone(response) };
	const bytes = byteSize(context);
	if (bytes > MAX_ENTRY_BYTES) {
		throw tooLarge();
	}
	while (entries.size > 0 && (entries.size >= MAX_PENDING || totalBytes() + bytes > MAX_TOTAL_BYTES)) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		entries.delete(oldest);
	}
	entries.set(id, { owner: ownerOf(key), context, expires: Date.now() + TTL_MS, bytes });
}

export function deleteResponse(key: ApiKey, id: string): void {
	getResponse(key, id);
	entries.delete(id);
}

export function toChat(
	request: Record<string, unknown>,
	history: Array<Record<string, unknown>>,
): Record<string, unknown> {
	if (request.background === true) {
		throw unsupported();
	}
	for (const field of ["conversation", "audio", "modalities"]) {
		if (request[field] !== undefined && request[field] !== null) {
			throw unsupported();
		}
	}
	if (request.include !== undefined && request.include !== null) {
		if (!Array.isArray(request.include) || request.include.some((value) => value !== "reasoning.encrypted_content")) {
			throw unsupported();
		}
	}
	if (request.input === undefined || request.input === null) {
		throw invalid();
	}
	const messages: Array<Record<string, unknown>> = [];
	if (typeof request.instructions === "string" && request.instructions.trim().length > 0) {
		messages.push({ role: "system", content: request.instructions });
	}
	messages.push(...history, ...readInput(request.input));
	const out: Record<string, unknown> = {
		model: request.model,
		stream: request.stream === true,
		messages,
	};
	if ("max_output_tokens" in request) {
		out.max_tokens = request.max_output_tokens;
	}
	for (const field of ["temperature", "top_p", "parallel_tool_calls"]) {
		if (field in request) {
			out[field] = request[field];
		}
	}
	if (request.reasoning !== undefined && request.reasoning !== null) {
		if (typeof request.reasoning !== "object" || Array.isArray(request.reasoning)) {
			throw unsupported();
		}
		const reasoning = request.reasoning as Record<string, unknown>;
		if (Object.keys(reasoning).some((key) => key !== "effort" && key !== "summary")) {
			throw unsupported();
		}
		if ("summary" in reasoning && reasoning.summary !== "auto") {
			throw unsupported();
		}
		if ("effort" in reasoning) {
			if (typeof reasoning.effort !== "string" || reasoning.effort.trim().length === 0) {
				throw invalid();
			}
			out.reasoning_effort = reasoning.effort;
		}
	}
	for (const field of ["context_window", "capability_mode"]) {
		if (field in request) {
			out[field] = request[field];
		}
	}
	if (isRecord(request.text) && isRecord(request.text.format) && request.text.format.type !== "text") {
		throw unsupported();
	}
	if (Array.isArray(request.tools)) {
		out.tools = request.tools.map((item) => {
			if (
				!isRecord(item) ||
				item.type !== "function" ||
				typeof item.name !== "string" ||
				item.name.trim().length === 0
			) {
				throw unsupported();
			}
			const fn: Record<string, unknown> = { name: item.name };
			for (const field of ["description", "parameters", "strict"]) {
				if (field in item) {
					fn[field] = item[field];
				}
			}
			return { type: "function", function: fn };
		});
	}
	if (typeof request.tool_choice === "string") {
		if (!["auto", "none", "required"].includes(request.tool_choice)) {
			throw unsupported();
		}
		out.tool_choice = request.tool_choice;
	} else if (isRecord(request.tool_choice)) {
		if (request.tool_choice.type !== "function" || typeof request.tool_choice.name !== "string") {
			throw unsupported();
		}
		out.tool_choice = { type: "function", function: { name: request.tool_choice.name } };
	}
	const session = sessionId(request);
	if (session !== null) {
		out.session_id = session;
	}
	return out;
}

export function readInput(raw: unknown): Array<Record<string, unknown>> {
	if (typeof raw === "string") {
		return [{ role: "user", content: raw }];
	}
	if (!Array.isArray(raw) || raw.length === 0) {
		throw invalid();
	}
	const out: Array<Record<string, unknown>> = [];
	for (const value of raw) {
		if (!isRecord(value)) {
			throw invalid();
		}
		const type = value.type === undefined ? null : String(value.type);
		if (type === "function_call") {
			let assistant = out.at(-1);
			if (assistant === undefined || assistant.role !== "assistant") {
				assistant = { role: "assistant", content: null };
				out.push(assistant);
			}
			const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
			calls.push({
				id: required(value, "call_id"),
				type: "function",
				function: { name: required(value, "name"), arguments: required(value, "arguments") },
			});
			assistant.tool_calls = calls;
		} else if (type === "function_call_output") {
			out.push({ role: "tool", tool_call_id: required(value, "call_id"), content: contentOf(value.output) });
		} else if (type === "message" || "role" in value) {
			const role = required(value, "role");
			if (!["user", "assistant", "system", "developer"].includes(role)) {
				throw invalid();
			}
			out.push({ role, content: contentOf(value.content) });
		} else {
			throw unsupported();
		}
	}
	return out;
}

export function responseObject(
	id: string,
	created: number,
	model: string,
	output: Array<Record<string, unknown>>,
	request: Record<string, unknown>,
	status: string,
	usage: number[] | null,
): Record<string, unknown> {
	return {
		id,
		object: "response",
		created_at: created,
		status,
		model,
		output,
		error: null,
		incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
		previous_response_id: request.previous_response_id ?? null,
		store: request.store !== false,
		parallel_tool_calls: request.parallel_tool_calls !== false,
		usage:
			usage === null
				? null
				: { input_tokens: usage[0] ?? 0, output_tokens: usage[1] ?? 0, total_tokens: usage[2] ?? 0 },
	};
}

export function outputOf(chat: Record<string, unknown>): Array<Record<string, unknown>> {
	const message = messageOf(chat);
	const out: Array<Record<string, unknown>> = [];
	if (typeof message.content === "string" && message.content.length > 0) {
		out.push(messageItem(`msg_${randomUUID().replaceAll("-", "")}`, message.content, "completed"));
	}
	if (Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (!isRecord(call) || !isRecord(call.function)) {
				continue;
			}
			out.push(
				functionItem(
					`fc_${randomUUID().replaceAll("-", "")}`,
					String(call.id ?? ""),
					String(call.function.name ?? ""),
					String(call.function.arguments ?? ""),
					"completed",
				),
			);
		}
	}
	return out;
}

export function responseStatus(chat: Record<string, unknown>): string {
	const choice = firstChoice(chat);
	return choice?.finish_reason === "length" ? "incomplete" : "completed";
}

export function responseUsage(chat: Record<string, unknown>): number[] {
	if (!isRecord(chat.usage)) {
		return [0, 0, 0];
	}
	return [integer(chat.usage.prompt_tokens), integer(chat.usage.completion_tokens), integer(chat.usage.total_tokens)];
}

export function newResponseId(): string {
	return `resp_${randomUUID().replaceAll("-", "")}`;
}

export function coalesceTextForStatelessClient(body: Record<string, unknown>): boolean {
	return (
		body.stream === true &&
		body.store === false &&
		Array.isArray(body.include) &&
		body.include.length === 1 &&
		body.include[0] === "reasoning.encrypted_content" &&
		typeof body.prompt_cache_key === "string" &&
		body.prompt_cache_key.trim().length > 0
	);
}

export class ResponsesStreamBridge {
	readonly #send: (type: string, data: Record<string, unknown>) => void;
	readonly #id: string;
	readonly #model: string;
	readonly #created: number;
	readonly #request: Record<string, unknown>;
	readonly #coalesce: boolean;
	readonly #output: Array<Record<string, unknown>> = [];
	readonly #tools = new Map<number, ToolState>();
	readonly #text = { value: "", id: "", index: -1, emitted: 0 };
	#sequence = 0;
	#status = "completed";

	constructor(
		id: string,
		created: number,
		model: string,
		request: Record<string, unknown>,
		coalesce: boolean,
		send: (type: string, data: Record<string, unknown>) => void,
	) {
		this.#id = id;
		this.#created = created;
		this.#model = model;
		this.#request = request;
		this.#coalesce = coalesce;
		this.#send = send;
	}

	start(): void {
		const response = responseObject(this.#id, this.#created, this.#model, [], this.#request, "in_progress", null);
		this.#event("response.created", { response });
		this.#event("response.in_progress", { response });
	}

	chunk(chat: Record<string, unknown>): void {
		if (!Array.isArray(chat.choices)) {
			return;
		}
		for (const item of chat.choices) {
			if (!isRecord(item) || integer(item.index) !== 0) {
				continue;
			}
			if (item.finish_reason === "length") {
				this.#status = "incomplete";
			}
			if (!isRecord(item.delta)) {
				continue;
			}
			if (typeof item.delta.content === "string" && item.delta.content.length > 0) {
				this.#appendText(item.delta.content);
			}
			if (Array.isArray(item.delta.tool_calls)) {
				for (const call of item.delta.tool_calls) {
					if (isRecord(call)) {
						this.#appendTool(call);
					}
				}
			}
		}
	}

	complete(usage: number[]): Record<string, unknown> {
		if (this.#text.index >= 0) {
			this.#flushText();
			const part = { type: "output_text", text: this.#text.value, annotations: [] };
			this.#event("response.output_text.done", {
				item_id: this.#text.id,
				output_index: this.#text.index,
				content_index: 0,
				text: this.#text.value,
				logprobs: [],
			});
			this.#event("response.content_part.done", {
				item_id: this.#text.id,
				output_index: this.#text.index,
				content_index: 0,
				part,
			});
			const item = messageItem(this.#text.id, this.#text.value, "completed");
			this.#output[this.#text.index] = item;
			this.#event("response.output_item.done", { output_index: this.#text.index, item });
		}
		for (const tool of this.#tools.values()) {
			this.#addTool(tool);
			const args = tool.args.length === 0 ? "{}" : tool.args;
			this.#event("response.function_call_arguments.done", {
				item_id: tool.itemId,
				output_index: tool.index,
				name: tool.name,
				arguments: args,
			});
			const item = functionItem(tool.itemId, tool.callId, tool.name, args, "completed");
			this.#output[tool.index] = item;
			this.#event("response.output_item.done", { output_index: tool.index, item });
		}
		const response = responseObject(
			this.#id,
			this.#created,
			this.#model,
			this.#output,
			this.#request,
			this.#status,
			usage,
		);
		this.#event(this.#status === "incomplete" ? "response.incomplete" : "response.completed", { response });
		return response;
	}

	fail(code: string, message: string): void {
		this.#flushText();
		const response = responseObject(
			this.#id,
			this.#created,
			this.#model,
			this.#output,
			this.#request,
			"failed",
			null,
		);
		response.error = { code, message };
		this.#event("response.failed", { response });
	}

	#appendText(delta: string): void {
		if (this.#text.index < 0) {
			this.#text.id = `msg_${randomUUID().replaceAll("-", "")}`;
			this.#text.index = this.#output.length;
			const item = messageItem(this.#text.id, "", "in_progress");
			item.content = [];
			this.#output.push(item);
			this.#event("response.output_item.added", { output_index: this.#text.index, item });
			this.#event("response.content_part.added", {
				item_id: this.#text.id,
				output_index: this.#text.index,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			});
		}
		this.#text.value += delta;
		if (!this.#coalesce) {
			this.#flushText();
		}
	}

	#flushText(): void {
		if (this.#text.index < 0 || this.#text.value.length === this.#text.emitted) {
			return;
		}
		const delta = this.#text.value.slice(this.#text.emitted);
		this.#text.emitted = this.#text.value.length;
		this.#event("response.output_text.delta", {
			item_id: this.#text.id,
			output_index: this.#text.index,
			content_index: 0,
			delta,
			logprobs: [],
		});
	}

	#appendTool(call: Record<string, unknown>): void {
		if (this.#coalesce) {
			this.#flushText();
		}
		const key = integer(call.index);
		let tool = this.#tools.get(key);
		if (tool === undefined) {
			tool = {
				itemId: `fc_${randomUUID().replaceAll("-", "")}`,
				callId: "",
				name: "",
				args: "",
				index: -1,
				added: false,
			};
			this.#tools.set(key, tool);
		}
		if (typeof call.id === "string" && call.id.length > 0) {
			tool.callId = call.id;
		}
		let delta = "";
		if (isRecord(call.function)) {
			if (typeof call.function.name === "string") {
				tool.name += call.function.name;
			}
			if (typeof call.function.arguments === "string") {
				delta = call.function.arguments;
			}
		}
		tool.args += delta;
		if (!tool.added && tool.callId.length > 0 && tool.name.length > 0 && delta.length > 0) {
			this.#addTool(tool);
			return;
		}
		if (tool.added && delta.length > 0) {
			this.#event("response.function_call_arguments.delta", {
				item_id: tool.itemId,
				output_index: tool.index,
				delta,
			});
		}
	}

	#addTool(tool: ToolState): void {
		if (tool.added) {
			return;
		}
		if (tool.callId.length === 0 || tool.name.length === 0) {
			throw new GatewayFault(502, "invalid_tool_call", "服务返回了不完整的工具调用");
		}
		tool.added = true;
		tool.index = this.#output.length;
		const item = functionItem(tool.itemId, tool.callId, tool.name, "", "in_progress");
		this.#output.push(item);
		this.#event("response.output_item.added", { output_index: tool.index, item });
		if (tool.args.length > 0) {
			this.#event("response.function_call_arguments.delta", {
				item_id: tool.itemId,
				output_index: tool.index,
				delta: tool.args,
			});
		}
	}

	#event(type: string, values: Record<string, unknown>): void {
		this.#send(type, { type, sequence_number: this.#sequence, ...values });
		this.#sequence += 1;
	}
}

interface ToolState {
	itemId: string;
	callId: string;
	name: string;
	args: string;
	index: number;
	added: boolean;
}

function messageItem(id: string, text: string, status: string): Record<string, unknown> {
	return {
		id,
		type: "message",
		status,
		role: "assistant",
		content: [{ type: "output_text", text, annotations: [] }],
	};
}

function functionItem(id: string, callId: string, name: string, args: string, status: string): Record<string, unknown> {
	return { id, type: "function_call", status, call_id: callId, name, arguments: args };
}

function contentOf(raw: unknown): unknown {
	if (typeof raw === "string") {
		return raw;
	}
	if (!Array.isArray(raw)) {
		throw invalid();
	}
	return raw.map((value) => {
		if (!isRecord(value)) {
			throw invalid();
		}
		const type = String(value.type ?? "");
		if (type === "input_text" || type === "output_text" || type === "text") {
			return { type: "text", text: required(value, "text") };
		}
		if (type === "input_image") {
			const image: Record<string, unknown> = { url: required(value, "image_url") };
			if (typeof value.detail === "string") {
				image.detail = value.detail;
			}
			return { type: "image_url", image_url: image };
		}
		throw unsupported();
	});
}

function messageOf(chat: Record<string, unknown>): Record<string, unknown> {
	const choice = firstChoice(chat);
	if (choice === undefined || !isRecord(choice.message)) {
		throw new GatewayFault(502, "invalid_response", "服务返回了无效响应");
	}
	return choice.message;
}

function firstChoice(chat: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!Array.isArray(chat.choices) || !isRecord(chat.choices[0])) {
		return undefined;
	}
	return chat.choices[0];
}

function sessionId(payload: Record<string, unknown>): string | null {
	const direct = validSession(payload.session_id);
	if (direct !== null) {
		return direct;
	}
	if (isRecord(payload.metadata)) {
		return validSession(payload.metadata.session_id);
	}
	return null;
}

function validSession(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
		if (value === undefined || value === null || value === "") {
			return null;
		}
		throw new GatewayFault(400, "invalid_session_id", "会话标识必须是 1 到 256 个字符的非空字符串，且不能含控制字符");
	}
	return value;
}

function required(map: Record<string, unknown>, key: string): string {
	const value = map[key];
	if (typeof value === "string") {
		return value;
	}
	throw invalid();
}

function integer(value: unknown): number {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function byteSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function totalBytes(): number {
	let sum = 0;
	for (const entry of entries.values()) {
		sum += entry.bytes;
	}
	return sum;
}

function purge(): void {
	const now = Date.now();
	for (const [id, entry] of entries) {
		if (entry.expires <= now) {
			entries.delete(id);
		}
	}
}

function ownerOf(key: ApiKey): string {
	if (key.id.trim().length === 0) {
		throw new GatewayFault(401, "authentication_required", "请使用有效的 API Key");
	}
	return key.id;
}

function tooLarge(): GatewayFault {
	return new GatewayFault(
		400,
		"response_context_too_large",
		"对话超过短期保存容量，请设置 store:false 并在后续请求中提供完整对话",
	);
}

function missing(): GatewayFault {
	return new GatewayFault(404, "response_not_found", "响应不存在、已过期或未启用短期保存，请重新提供完整对话");
}

function invalid(): GatewayFault {
	return new GatewayFault(400, "invalid_request", "请求中的消息、图片或工具调用格式无效");
}

function unsupported(): GatewayFault {
	return new GatewayFault(
		400,
		"unsupported_feature",
		"此入口支持文字、图片和 function 工具，当前请求包含尚未支持的功能",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
