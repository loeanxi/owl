/**
 * Grok（xAI API Key）对话上游 —— 移植自 manager `gateway/GrokUpstreamChatClient`。
 * 上游 /v1/chat/completions 即标准 OpenAI 兼容协议，请求近透传
 * （剥内部字段与上游不识别的扩展参数），流式原样转发 OpenAI chunk；
 * 显式请求流末尾 usage chunk，保证 KNOWN 结算口径。429 → RATE 换号；401/403 → AUTH。
 */
import type { Account } from "owl-pool";
import { type Platform, parseCredentials, type UpstreamChatClient, UpstreamException } from "owl-pool";

/** 内部路由/能力扩展字段，不属于上游契约，转发前剥掉。 */
const STRIPPED_KEYS = new Set(["_managerAccountId", "context_window", "reasoning_effort", "reasoning"]);

export interface GrokClientOptions {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	/** 上游超时毫秒（manager: upstream-timeout-seconds=120）。 */
	timeoutMs?: number;
}

export class GrokUpstreamClient implements UpstreamChatClient {
	readonly #baseUrl: string;
	readonly #fetchImpl: typeof fetch;
	readonly #timeoutMs: number;

	constructor(options: GrokClientOptions = {}) {
		this.#baseUrl = (options.baseUrl ?? "https://api.x.ai").replace(/\/+$/, "");
		this.#fetchImpl = options.fetchImpl ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? 120_000;
	}

	platform(): Platform {
		return "GROK";
	}

	async chatCompletion(
		account: Account,
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const response = await this.post(account, sanitized(payload), "application/json", signal);
		const body = await response.text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(body) as unknown;
		} catch {
			throw new UpstreamException("SERVER", "Grok 响应解析失败");
		}
		if (parsed !== null && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
			throw httpError(200, body);
		}
		if (parsed === null || typeof parsed !== "object") {
			throw new UpstreamException("SERVER", "Grok 响应解析失败");
		}
		return parsed as Record<string, unknown>;
	}

	async chatCompletionStream(
		account: Account,
		payload: Record<string, unknown>,
		onChunk: (chunkJson: string) => void,
		signal?: AbortSignal,
	): Promise<void> {
		const request = sanitized(payload);
		request.stream = true;
		// 显式请求流末尾 usage chunk，保证 KNOWN 结算口径
		if (request.stream_options === null || request.stream_options === undefined) {
			request.stream_options = { include_usage: true };
		}
		const response = await this.post(account, request, "text/event-stream", signal);
		if (!response.body) {
			throw new UpstreamException("SERVER", "Grok 流式响应为空");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n");
			while (boundary >= 0) {
				const line = buffer.slice(0, boundary).replace(/\r$/, "");
				buffer = buffer.slice(boundary + 1);
				relayLine(line, onChunk);
				boundary = buffer.indexOf("\n");
			}
		}
		if (buffer.length > 0) {
			relayLine(buffer.replace(/\r$/, ""), onChunk);
		}
	}

	async post(account: Account, body: unknown, accept: string, signal?: AbortSignal): Promise<Response> {
		signal?.throwIfAborted();
		const apiKey = requireApiKey(account);
		let response: Response;
		try {
			response = await this.#fetchImpl(`${this.#baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					Accept: accept,
				},
				body: JSON.stringify(body),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)])
					: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (error) {
			signal?.throwIfAborted();
			// IO 瞬断按 SERVER 分类（换号路径据 reason 判定短冷却）
			const message = error instanceof Error ? error.message : String(error);
			throw new UpstreamException("SERVER", `Grok 转发失败: ${message}`);
		}
		if (!response.ok) {
			const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
			const text = await response.text();
			const exception = httpError(response.status, text);
			if (!Number.isNaN(retryAfter)) {
				throw new UpstreamException(exception.kind, exception.message, retryAfter);
			}
			throw exception;
		}
		return response;
	}
}

/** SSE 行 → OpenAI chunk 回调（data: 前缀剥除，[DONE] 原样上抛）。 */
function relayLine(line: string, onChunk: (chunkJson: string) => void): void {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) {
		return;
	}
	const payload = trimmed.slice(5).trim();
	if (payload.length === 0) {
		return;
	}
	onChunk(payload === "[DONE]" ? "[DONE]" : payload);
}

/** 剥内部字段（保留其余请求形状），确保 model 不带路由前缀与 @档位 后缀。 */
export function sanitized(payload: Record<string, unknown>): Record<string, unknown> {
	const request: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (!STRIPPED_KEYS.has(key)) {
			request[key] = value;
		}
	}
	const model = String(request.model ?? "");
	const slash = model.indexOf("/");
	const withoutPrefix = slash >= 0 ? model.slice(slash + 1) : model;
	const at = withoutPrefix.indexOf("@");
	request.model = at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix;
	return request;
}

function requireApiKey(account: Account): string {
	const apiKey = parseCredentials(account).apiKey;
	if (apiKey === null || apiKey === undefined || String(apiKey).trim().length === 0) {
		throw new UpstreamException("AUTH", "GROK apiKey 缺失");
	}
	return String(apiKey);
}

/** 非 2xx → 分类异常（对齐 Java httpError 的状态映射）。 */
function httpError(status: number, body: string): UpstreamException {
	const snippet = body.replaceAll(/\s+/g, " ").slice(0, 300);
	if (status === 401 || status === 403) {
		return new UpstreamException("AUTH", `Grok HTTP ${status}: ${snippet}`);
	}
	if (status === 429) {
		return new UpstreamException("RATE", `Grok HTTP 429: ${snippet}`);
	}
	if (status >= 400 && status < 500) {
		return new UpstreamException("BAD_REQUEST", `Grok HTTP ${status}: ${snippet}`);
	}
	return new UpstreamException("SERVER", `Grok HTTP ${status}: ${snippet}`);
}
