/**
 * Anthropic 协议兼容上游客户端 —— 移植自 manager `ZCodeUpstreamChatClient`
 * 与 `ClaudeUpstreamChatClient` 的公共形态。
 *
 * ZCode 三通道（凭据 channel 字段决定端点）：
 * BIGMODEL → open.bigmodel.cn/api/anthropic；ZAI → api.z.ai/api/anthropic；
 * ZCODE_PLAN → zcode.z.ai/api/v1/zcode-plan/anthropic。鉴权 x-api-key + anthropic-version。
 * Claude：OAuth 订阅号（credentials.authType==="oauth"）走 Bearer + anthropic-beta +
 * claude-cli 身份头（缺 beta 会被上游降级到第三方配额）；API Key 账号走 x-api-key。
 */
import {
	type Account,
	AnthropicUpstreamMapper,
	IncompleteUpstreamStreamException,
	isNetworkBlip,
	type Platform,
	parseCredentials,
	SseEventReader,
	type UpstreamChatClient,
	UpstreamException,
} from "owl-pool";

/** ZCode 通道 → 端点基址（对齐 manager gateway.zcode.*）。 */
export const ZCODE_CHANNEL_BASE_URLS: Record<string, string> = {
	BIGMODEL: "https://open.bigmodel.cn/api/anthropic",
	ZAI: "https://api.z.ai/api/anthropic",
	ZCODE_PLAN: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
};

export interface AnthropicCompatibleConfig {
	platform: Platform;
	label: string;
	/** 固定基址（Claude）；ZCode 用凭据 channel 动态解析，此字段留空。 */
	baseUrl?: string;
	anthropicVersion: string;
	defaultMaxTokens: number;
	/** Claude OAuth 流量必带的 beta 集。 */
	oauthBetaHeaders?: string;
	cliVersion?: string;
	thinkingBudgets?: { low: number; medium: number; high: number };
	exposeThinking?: boolean;
	foldCacheTokens?: boolean;
	timeoutMs?: number;
	/** Claude OAuth：返回当前可用 accessToken，必要时先刷新。 */
	refreshOauth?: (account: Account) => Promise<string>;
	/** 上游 401 时标记这枚 token 已失效，下次解析会刷新。 */
	rejectOauth?: (accountId: string, token: string) => void;
}

export interface AnthropicCompatibleOptions {
	fetchImpl?: typeof fetch;
	/** 平台级出网代理（预留；阶段 4B 接 undici ProxyAgent）。 */
	proxyUrl?: string;
}

export class AnthropicCompatibleClient implements UpstreamChatClient {
	readonly #config: AnthropicCompatibleConfig;
	readonly #mapper: AnthropicUpstreamMapper;
	readonly #fetchImpl: typeof fetch;

	constructor(config: AnthropicCompatibleConfig, options: AnthropicCompatibleOptions = {}) {
		this.#config = config;
		this.#mapper = new AnthropicUpstreamMapper({
			label: config.label,
			thinkingBudgets: config.thinkingBudgets,
			exposeThinking: config.exposeThinking ?? false,
			foldCacheTokens: config.foldCacheTokens ?? true,
		});
		this.#fetchImpl = options.fetchImpl ?? fetch;
	}

	platform(): Platform {
		return this.#config.platform;
	}

	async chatCompletion(
		account: Account,
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		signal?.throwIfAborted();
		const auth = await this.authOf(account);
		const request = this.#mapper.toAnthropicRequest(payload, this.#config.defaultMaxTokens);
		request.stream = false;
		const response = await this.post(auth, request, "application/json", signal);
		const body = await response.text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(body) as unknown;
		} catch {
			throw new UpstreamException("SERVER", `${this.#config.label} 响应不是 JSON 对象`);
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new UpstreamException("SERVER", `${this.#config.label} 响应不是 JSON 对象`);
		}
		return this.#mapper.toOpenAiCompletion(parsed as Record<string, unknown>);
	}

	async chatCompletionStream(
		account: Account,
		payload: Record<string, unknown>,
		onChunk: (chunkJson: string) => void,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const auth = await this.authOf(account);
		const request = this.#mapper.toAnthropicRequest(payload, this.#config.defaultMaxTokens);
		request.stream = true;
		let emitted = false;
		const guarded = (chunk: string): void => {
			emitted = true;
			onChunk(chunk);
		};
		// 每次尝试新建解码器：重试只在未吐出任何 chunk 时发生，旧状态作废
		let lastIo: Error | null = null;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const decoder = this.#mapper.newStreamDecoder(String(request.model), guarded);
			try {
				await this.postStream(auth, request, decoder, signal);
				return;
			} catch (error) {
				signal?.throwIfAborted();
				if (error instanceof UpstreamException) {
					throw error;
				}
				const message = error instanceof Error ? error.message : String(error);
				lastIo = error instanceof Error ? error : new Error(message);
				if (attempt < 2 && !emitted && isNetworkBlip(message)) {
					continue;
				}
				throw new UpstreamException("SERVER", `${this.#config.label} 转发失败: ${message}`);
			}
		}
		throw new UpstreamException("SERVER", `${this.#config.label} 转发失败: ${lastIo?.message ?? "unknown"}`);
	}

	async post(auth: AuthContext, body: unknown, accept: string, signal?: AbortSignal): Promise<Response> {
		signal?.throwIfAborted();
		let response: Response;
		try {
			response = await this.#fetchImpl(`${this.baseUrlOf(auth.account)}/v1/messages`, {
				method: "POST",
				headers: { ...this.headersOf(auth), Accept: accept },
				body: JSON.stringify(body),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(this.#config.timeoutMs ?? 120_000)])
					: AbortSignal.timeout(this.#config.timeoutMs ?? 120_000),
			});
		} catch (error) {
			signal?.throwIfAborted();
			throw new UpstreamException(
				"SERVER",
				`${this.#config.label} 请求失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok) {
			if (response.status === 401 && auth.oauth && this.#config.rejectOauth !== undefined) {
				this.#config.rejectOauth(auth.account.id, auth.secret);
			}
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

	async postStream(
		auth: AuthContext,
		request: Record<string, unknown>,
		decoder: ReturnType<AnthropicUpstreamMapper["newStreamDecoder"]>,
		signal?: AbortSignal,
	): Promise<void> {
		const response = await this.post(auth, request, "text/event-stream", signal);
		if (!response.body) {
			throw new UpstreamException("SERVER", `${this.#config.label} 流式响应为空`);
		}
		// 原生或兼容终止证据都要求具备，才允许产出收尾 chunk
		const reader = response.body.getReader();
		const sse = new SseEventReader();
		const decoder2 = decoder as unknown as {
			onEvent(data: string): boolean;
			done(): void;
			isComplete(): boolean;
			finish(): void;
		};
		const decode = new TextDecoder();
		let buffer = "";
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
						const data = event.data.trim();
						if (data === "[DONE]") {
							decoder2.done();
							finishDecoder(decoder2);
							return;
						}
						if (!decoder2.onEvent(event.data)) {
							finishDecoder(decoder2);
							return;
						}
					}
					newline = buffer.indexOf("\n");
				}
			}
			const tail = sse.finish();
			if (tail !== null) {
				const data = tail.data.trim();
				if (data === "[DONE]") {
					decoder2.done();
				} else {
					decoder2.onEvent(tail.data);
				}
			}
			finishDecoder(decoder2);
		} catch (error) {
			if (error instanceof UpstreamException || error instanceof IncompleteUpstreamStreamException) {
				throw error;
			}
			throw new UpstreamException(
				"SERVER",
				`${this.#config.label} SSE 解析失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	baseUrlOf(account: Account): string {
		if (this.#config.baseUrl !== undefined) {
			return this.#config.baseUrl.replace(/\/+$/, "");
		}
		const channel = String(parseCredentials(account).channel ?? "BIGMODEL").toUpperCase();
		const base = ZCODE_CHANNEL_BASE_URLS[channel];
		if (base === undefined) {
			throw new UpstreamException("BAD_REQUEST", `未知 ZCode 通道: ${channel}`);
		}
		return base;
	}

	async authOf(account: Account): Promise<AuthContext> {
		const credentials = parseCredentials(account);
		const oauth = credentials.authType === "oauth";
		if (oauth && this.#config.refreshOauth !== undefined) {
			return { account, oauth: true, secret: await this.#config.refreshOauth(account) };
		}
		const secret = oauth ? String(credentials.accessToken ?? "") : String(credentials.apiKey ?? "");
		if (secret.trim().length === 0) {
			throw new UpstreamException("AUTH", `${this.#config.label} ${oauth ? "accessToken" : "apiKey"} 缺失`);
		}
		return { account, oauth, secret };
	}

	headersOf(auth: AuthContext): Record<string, string> {
		const headers: Record<string, string> = {
			"anthropic-version": this.#config.anthropicVersion,
			"Content-Type": "application/json",
		};
		if (auth.oauth) {
			headers.Authorization = `Bearer ${auth.secret}`;
			// 缺 beta 集会被上游降级到第三方配额
			headers["anthropic-beta"] = this.#config.oauthBetaHeaders ?? "";
			headers["User-Agent"] = `claude-cli/${this.#config.cliVersion ?? "2.1.258"} (external, cli)`;
			headers["X-App"] = "cli";
			headers["X-Stainless-Lang"] = "js";
		} else {
			headers["x-api-key"] = auth.secret;
		}
		return headers;
	}
}

interface AuthContext {
	account: Account;
	oauth: boolean;
	secret: string;
}

function finishDecoder(decoder: {
	onEvent(data: string): boolean;
	done(): void;
	isComplete(): boolean;
	finish(): void;
}): void {
	try {
		decoder.finish();
	} catch (error) {
		if (error instanceof IncompleteUpstreamStreamException) {
			throw error;
		}
		throw new UpstreamException("SERVER", "流收尾失败");
	}
}
