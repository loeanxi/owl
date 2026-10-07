/**
 * Gemini（Google AI Studio API Key）对话上游 —— 移植自 manager
 * `GeminiUpstreamChatClient`。端点 /{apiVersion}/models/{model}:
 * (generateContent|streamGenerateContent?alt=sse)，鉴权 x-goog-api-key。
 */
import {
	type Account,
	GeminiProtocolMapper,
	IncompleteUpstreamStreamException,
	isNetworkBlip,
	type Platform,
	parseCredentials,
	SseEventReader,
	type UpstreamChatClient,
	UpstreamException,
} from "owl-pool";
import { aggregateStreamToCompletion } from "./aggregate.ts";

export interface GeminiChatConfig {
	baseUrl: string;
	apiVersion: string;
	defaultMaxTokens: number;
	timeoutMs?: number;
}

export interface GeminiClientOptions {
	config: GeminiChatConfig;
	fetchImpl?: typeof fetch;
}

export class GeminiChatClient implements UpstreamChatClient {
	readonly #config: GeminiChatConfig;
	readonly #mapper = new GeminiProtocolMapper();
	readonly #fetchImpl: typeof fetch;

	constructor(options: GeminiClientOptions) {
		this.#config = options.config;
		this.#fetchImpl = options.fetchImpl ?? fetch;
	}

	platform(): Platform {
		return "GEMINI";
	}

	async chatCompletion(account: Account, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		const model = upstreamModel(payload);
		const request = this.#mapper.toGeminiRequest(payload, this.#config.defaultMaxTokens);
		const response = await this.post(account, `/models/${model}:generateContent`, request, "application/json");
		const body = await response.text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(body) as unknown;
		} catch {
			throw new UpstreamException("SERVER", "Gemini 响应解析失败");
		}
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			(parsed as Record<string, unknown>).error !== null &&
			(parsed as Record<string, unknown>).error !== undefined
		) {
			throw this.#mapper.httpError(200, body);
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new UpstreamException("SERVER", "Gemini 响应解析失败");
		}
		return this.#mapper.toOpenAiCompletion(parsed as Record<string, unknown>);
	}

	async chatCompletionStream(
		account: Account,
		payload: Record<string, unknown>,
		onChunk: (chunkJson: string) => void,
	): Promise<void> {
		const model = upstreamModel(payload);
		const request = this.#mapper.toGeminiRequest(payload, this.#config.defaultMaxTokens);
		let emitted = false;
		let lastIo: Error | null = null;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const decoder = this.#mapper.newStreamDecoder(model, (chunk) => {
				emitted = true;
				onChunk(chunk);
			});
			try {
				const response = await this.post(
					account,
					`/models/${model}:streamGenerateContent?alt=sse`,
					request,
					"text/event-stream",
				);
				if (!response.body) {
					throw new UpstreamException("SERVER", "Gemini 流式响应为空");
				}
				await decodeSse(response.body, decoder);
				return;
			} catch (error) {
				if (error instanceof UpstreamException) {
					throw error;
				}
				const message = error instanceof Error ? error.message : String(error);
				lastIo = error instanceof Error ? error : new Error(message);
				if (attempt < 2 && !emitted && isNetworkBlip(message)) {
					continue;
				}
				throw new UpstreamException("SERVER", `Gemini 转发失败: ${message}`);
			}
		}
		throw new UpstreamException("SERVER", `Gemini 转发失败: ${lastIo?.message ?? "unknown"}`);
	}

	async post(account: Account, path: string, body: unknown, accept: string): Promise<Response> {
		const apiKey = requireApiKey(account);
		let response: Response;
		try {
			response = await this.#fetchImpl(
				`${this.#config.baseUrl.replace(/\/+$/, "")}/${this.#config.apiVersion}${path}`,
				{
					method: "POST",
					headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json", Accept: accept },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(this.#config.timeoutMs ?? 120_000),
				},
			);
		} catch (error) {
			throw new UpstreamException(
				"SERVER",
				`Gemini 请求失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok) {
			const text = await response.text();
			const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
			const exception = this.#mapper.httpError(response.status, text);
			if (!Number.isNaN(retryAfter)) {
				throw new UpstreamException(exception.kind, exception.message, retryAfter);
			}
			throw exception;
		}
		return response;
	}
}

function upstreamModel(payload: Record<string, unknown>): string {
	const raw = String(payload.model ?? "");
	const slash = raw.indexOf("/");
	const withoutPrefix = slash >= 0 ? raw.slice(slash + 1) : raw;
	const at = withoutPrefix.indexOf("@");
	return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix;
}

function requireApiKey(account: Account): string {
	const apiKey = parseCredentials(account).apiKey;
	if (apiKey === null || apiKey === undefined || String(apiKey).trim().length === 0) {
		throw new UpstreamException("AUTH", "GEMINI apiKey 缺失");
	}
	return String(apiKey);
}

async function decodeSse(
	stream: ReadableStream<Uint8Array>,
	decoder: ReturnType<GeminiProtocolMapper["newStreamDecoder"]>,
): Promise<void> {
	const reader = stream.getReader();
	const sse = new SseEventReader();
	const d = decoder as unknown as {
		onEvent(data: string): boolean;
		done(): void;
		finish(): void;
	};
	const decode = new TextDecoder();
	let buffer = "";
	const handle = (data: string): void => {
		if (data.trim() === "[DONE]") {
			d.done();
			return;
		}
		d.onEvent(data);
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decode.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				const event = sse.next(line);
				if (event !== null) {
					handle(event.data);
				}
				newline = buffer.indexOf("\n");
			}
		}
		const tail = sse.finish();
		if (tail !== null) {
			handle(tail.data);
		}
		d.finish();
	} catch (error) {
		if (error instanceof UpstreamException || error instanceof IncompleteUpstreamStreamException) {
			throw error;
		}
		throw new UpstreamException(
			"SERVER",
			`Gemini SSE 解析失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
