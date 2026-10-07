/**
 * Trae 对话上游（SOLO llm_utils_chat）—— 移植自 manager
 * `TraeUpstreamChatClient` + `TraeModelCatalogClient.applyAgentHeaders`。
 * 协议要点：① 会话 Cookie（X-Cloudide-Session）先换 Cloud-IDE-JWT；
 * ② 明文 JSON POST /api/agent/v3/llm_utils_chat；③ 自定义 SSE 事件
 * output / token_usage / done / error → OpenAI chunk；④ 完整性要求
 * done 事件 + 实际产出（content_filter 除外）。
 *
 * 与 manager 的差异（见迁移文档偏离记录）：functionFor 以注入钩子接入，
 * 快照域（阶段 4B）就位前默认恒等映射。
 */
import {
	type Account,
	IncompleteUpstreamStreamException,
	type Platform,
	parseCredentials,
	SseEventReader,
	sha256Hex,
	stripModelPrefix,
	type UpstreamChatClient,
	UpstreamException,
} from "owl-pool";
import { aggregateStreamToCompletion } from "./aggregate.ts";

export interface TraeChatConfig {
	chatBaseUrl: string;
	chatPath: string;
	appId: string;
	ideVersion: string;
	ideVersionCode: string;
	timeoutMs?: number;
}

export interface TraeClientOptions {
	config: TraeChatConfig;
	fetchImpl?: typeof fetch;
	/** 账号模型 → SOLO function 名；快照域就位前默认恒等。 */
	functionFor?(account: Account, model: string): string | null;
}

export class TraeChatClient implements UpstreamChatClient {
	readonly #config: TraeChatConfig;
	readonly #fetchImpl: typeof fetch;
	readonly #functionFor: (account: Account, model: string) => string | null;

	constructor(options: TraeClientOptions) {
		this.#config = options.config;
		this.#fetchImpl = options.fetchImpl ?? fetch;
		this.#functionFor = options.functionFor ?? ((_, model) => model);
	}

	platform(): Platform {
		return "TRAE";
	}

	async chatCompletion(account: Account, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { body } = await aggregateStreamToCompletion(this, account, payload);
		return body;
	}

	async chatCompletionStream(
		account: Account,
		payload: Record<string, unknown>,
		onChunk: (chunkJson: string) => void,
	): Promise<void> {
		const credentials = parseCredentials(account);
		const session = typeof credentials.session === "string" ? credentials.session : "";
		if (session.trim().length === 0) {
			throw new UpstreamException("AUTH", "Trae 账号缺少 session");
		}
		let jwt: string;
		try {
			jwt = await this.exchangeToken(session);
		} catch (error) {
			const message =
				error instanceof UpstreamException ? error.message : error instanceof Error ? error.message : String(error);
			throw new UpstreamException("AUTH", `Trae 会话换 JWT 失败: ${message}`);
		}

		const model = stripModelPrefix(typeof payload.model === "string" ? payload.model : "");
		const fn = this.#functionFor(account, model);
		if (fn === null || fn.trim().length === 0) {
			throw new UpstreamException("BAD_REQUEST", "Trae 账号不支持该模型或目录尚未同步");
		}
		const body = normalizeTraePayload(payload, model, fn);
		const headers = this.agentHeaders(account, credentials, jwt);
		let response: Response;
		try {
			response = await this.#fetchImpl(`${this.#config.chatBaseUrl.replace(/\/+$/, "")}${this.#config.chatPath}`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.#config.timeoutMs ?? 120_000),
			});
		} catch (error) {
			throw new UpstreamException(
				"SERVER",
				`Trae 转发失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok) {
			const text = await response.text();
			const kind =
				response.status === 400
					? "BAD_REQUEST"
					: response.status === 401 || response.status === 403
						? "AUTH"
						: response.status === 429
							? "RATE"
							: "SERVER";
			const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
			const exception = new UpstreamException(kind, `Trae HTTP ${response.status}: ${truncate(text)}`);
			if (!Number.isNaN(retryAfter)) {
				throw new UpstreamException(exception.kind, exception.message, retryAfter);
			}
			throw exception;
		}
		if (!response.body) {
			throw new UpstreamException("SERVER", "Trae 流式响应为空");
		}
		await parseSoloSse(response.body, String(body.model ?? "trae"), onChunk);
	}

	/** 会话 Cookie → Cloud-IDE-JWT（与签到域同一端点）。 */
	async exchangeToken(session: string): Promise<string> {
		const response = await this.#fetchImpl("https://api.trae.cn/cloudide/api/v3/common/GetUserToken", {
			method: "POST",
			headers: {
				Cookie: `X-Cloudide-Session=${session}`,
				Referer: "https://www.trae.cn/",
				Origin: "https://www.trae.cn",
				"User-Agent": "ManagerCheckIn/0.1",
				Accept: "application/json, text/plain, */*",
				"Content-Type": "application/json",
			},
			body: "",
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) {
			throw new UpstreamException(
				response.status === 401 || response.status === 403 ? "AUTH" : "SERVER",
				`GetUserToken HTTP ${response.status}`,
			);
		}
		const parsed: unknown = await response.json();
		const token = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).Result : null;
		const value = token !== null && typeof token === "object" ? (token as Record<string, unknown>).Token : null;
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new UpstreamException("SERVER", "GetUserToken 未返回 Token");
		}
		return value;
	}

	agentHeaders(account: Account, credentials: Record<string, unknown>, jwt: string): Record<string, string> {
		const identity = account.id;
		return {
			Authorization: `Cloud-IDE-JWT ${jwt}`,
			"X-Ide-Token": jwt,
			"X-Cloudide-Token": jwt,
			"x-plugin-channel": "icube-ai",
			"x-app-id": this.#config.appId,
			"x-machine-id": sha256Hex(`trae-manager:${identity}`),
			"x-device-id": deviceId(credentials, identity),
			"x-device-type": "windows",
			"x-app-version": this.#config.ideVersion,
			"x-ide-version": this.#config.ideVersion,
			"x-app-version-code": this.#config.ideVersionCode,
			"x-ide-version-code": this.#config.ideVersionCode,
			"x-ide-version-type": "stable",
			"request-traffic-type": "prod",
			"X-User-Region": "cn",
			"User-Agent": `Trae/${this.#config.ideVersion}`,
		};
	}
}

/** SOLO 自定义 SSE：output / token_usage / done / error → OpenAI chunk。 */
export async function parseSoloSse(
	stream: ReadableStream<Uint8Array>,
	model: string,
	consumer: (chunkJson: string) => void,
): Promise<void> {
	const id = `chatcmpl-${crypto.randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	let sentRole = false;
	const usage: Record<string, unknown> = {};
	let finishReason = "stop";
	let terminal = false;
	const sse = new SseEventReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const emitChunk = (content: string | null, reasoning: string | null, toolCalls: unknown[] | null): void => {
		const chunk: Record<string, unknown> = { id, object: "chat.completion.chunk", created, model };
		const delta: Record<string, unknown> = {};
		if (!sentRole) {
			delta.role = "assistant";
			sentRole = true;
		}
		if (content !== null) {
			delta.content = content;
		}
		if (reasoning !== null) {
			delta.reasoning_content = reasoning;
		}
		if (toolCalls !== null && toolCalls.length > 0) {
			delta.tool_calls = normalizeToolCalls(toolCalls);
		}
		if (Object.keys(delta).length === 0) {
			delta.content = null;
		}
		chunk.choices = [{ index: 0, delta, finish_reason: null }];
		consumer(JSON.stringify(chunk));
	};

	const handleEvent = (event: { name: string; data: string }): void => {
		const name = event.name.toLowerCase();
		if (name === "metadata" || name === "timing_cost" || name === "extra_info") {
			return;
		}
		if (name === "done") {
			const done = parseEvent(event.data);
			if (typeof done.finish_reason === "string" && done.finish_reason.trim().length > 0) {
				finishReason = done.finish_reason;
			}
			terminal = true;
			return;
		}
		if (name === "token_usage") {
			const node = parseEvent(event.data);
			for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
				if (node[field] !== null && node[field] !== undefined) {
					usage[field] = node[field];
				}
			}
			return;
		}
		if (name === "error") {
			const node = parseEvent(event.data);
			const message = typeof node.message === "string" ? node.message : event.data;
			throw new UpstreamException("SERVER", `Trae 流内错误: ${truncate(message)}`);
		}
		// event:output —— 增量内容 / 工具调用
		const node = parseEvent(event.data);
		let content: string | null = null;
		let reasoning: string | null = null;
		if (typeof node.response === "string") {
			content = node.response;
		} else if (typeof node.content === "string") {
			content = node.content;
		}
		if (typeof node.reasoning_content === "string") {
			reasoning = node.reasoning_content;
		}
		const toolCalls = Array.isArray(node.tool_calls) ? node.tool_calls : null;
		if (
			(content === null || content.length === 0) &&
			(reasoning === null || reasoning.length === 0) &&
			(toolCalls === null || toolCalls.length === 0)
		) {
			return;
		}
		emitChunk(content, reasoning, toolCalls);
	};

	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				const event = sse.next(line);
				if (event !== null) {
					handleEvent(event);
				}
				newline = buffer.indexOf("\n");
			}
		}
		const tail = sse.finish();
		if (tail !== null) {
			handleEvent(tail);
		}
	} catch (error) {
		if (error instanceof UpstreamException || error instanceof IncompleteUpstreamStreamException) {
			throw error;
		}
		if (!terminal) {
			throw new IncompleteUpstreamStreamException(error instanceof Error ? error.message : String(error));
		}
	}
	if (!terminal || (!sentRole && finishReason !== "content_filter")) {
		throw new IncompleteUpstreamStreamException();
	}
	const last: Record<string, unknown> = { id, object: "chat.completion.chunk", created, model };
	const lastChoice: Record<string, unknown> = { index: 0, delta: {}, finish_reason: finishReason };
	if (Object.keys(usage).length > 0) {
		last.usage = usage;
	}
	last.choices = [lastChoice];
	consumer(JSON.stringify(last));
}

/** 请求形状：config_name/function + 消息内容数组化 + assistant tool_calls→function_call。 */
export function normalizeTraePayload(
	payload: Record<string, unknown>,
	model: string,
	fn: string,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model,
		config_name: model,
		function: fn,
		stream: true,
	};
	if (Array.isArray(payload.messages)) {
		const adapted: Record<string, unknown>[] = [];
		for (const raw of payload.messages) {
			if (raw === null || typeof raw !== "object") {
				continue;
			}
			const message: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
			if (message.role === "developer") {
				message.role = "system";
			}
			if (typeof message.content === "string") {
				message.content = [{ type: "text", text: message.content }];
			}
			if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
				const converted: unknown[] = [];
				for (const rawCall of message.tool_calls) {
					if (rawCall === null || typeof rawCall !== "object") {
						converted.push(rawCall);
						continue;
					}
					const call: Record<string, unknown> = { ...(rawCall as Record<string, unknown>) };
					if (call.function !== null && typeof call.function === "object") {
						call.function_call = call.function;
						delete call.function;
					}
					converted.push(call);
				}
				message.tool_calls = converted;
			}
			adapted.push(message);
		}
		body.messages = adapted;
	}
	if (Array.isArray(payload.tools)) {
		const adapted: unknown[] = [];
		for (const raw of payload.tools) {
			if (raw === null || typeof raw !== "object") {
				adapted.push(raw);
				continue;
			}
			const tool: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
			const fnRaw = tool.function;
			if (fnRaw !== null && typeof fnRaw === "object") {
				const fnRecord = fnRaw as Record<string, unknown>;
				delete tool.function;
				Object.assign(tool, fnRecord);
			}
			adapted.push(tool);
		}
		body.tools = adapted;
	}
	return body;
}

function normalizeToolCalls(toolCalls: unknown[]): Array<Record<string, unknown>> {
	return toolCalls.map((raw, i) => {
		const tc = (raw ?? {}) as Record<string, unknown>;
		const src = (tc.function ?? tc) as Record<string, unknown>;
		let args = "";
		if (typeof src.arguments === "string") {
			args = src.arguments;
		} else if (src.arguments !== null && src.arguments !== undefined) {
			args = JSON.stringify(src.arguments);
		}
		const one: Record<string, unknown> = {
			index: typeof tc.index === "number" ? tc.index : i,
			type: "function",
			function: {
				...(src.name !== null && src.name !== undefined ? { name: String(src.name) } : {}),
				arguments: args,
			},
		};
		if (typeof tc.id === "string") {
			one.id = tc.id;
		}
		return one;
	});
}

function parseEvent(data: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(data);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		throw new IncompleteUpstreamStreamException();
	}
}

function deviceId(credentials: Record<string, unknown>, identity: string): string {
	const supplied = credentials.deviceId;
	if (typeof supplied === "string" && supplied.length > 0) {
		return supplied;
	}
	// sha256("trae-device:"+id) → [1e15, 1e16) 十六进制取模（对齐 Java）
	const hash = sha256Hex(`trae-device:${identity}`);
	const value = (BigInt(`0x${hash}`) % BigInt("9000000000000000")) + BigInt("1000000000000000");
	return value.toString();
}

function truncate(text: string): string {
	const cleaned = text.replaceAll(/\s+/g, " ").trim();
	return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}
