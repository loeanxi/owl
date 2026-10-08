/**
 * WorkBuddy / CodeBuddy 对话上游 —— 移植自 manager `WorkBuddyUpstreamChatClient`。
 * 实测协议铁律：① 上游只回 SSE（code 11101 拒绝非流式）→ 一律 stream:true，
 * 非流式本地聚合；② Origin/Referer 必须是 codebuddy.cn（否则 11128 unapproved
 * channel）；③ 缺省身份头显式占位，chat 请求绝不携带 X-Refresh-Token；
 * ④ hy3* 系模型缺省 reasoning_effort=high。
 */
import {
	type Account,
	GatewayFault,
	IncompleteUpstreamStreamException,
	isNetworkBlip,
	OpenAiStreamCompletion,
	type Platform,
	SseEventReader,
	stripModelPrefix,
	type UpstreamChatClient,
	UpstreamException,
} from "owl-pool";
import { workBuddyToken } from "../catalog/workbuddy-catalog.ts";
import { aggregateStreamToCompletion } from "./aggregate.ts";

export interface WorkBuddyChatConfig {
	baseUrl: string;
	chatPath: string;
	userAgent: string;
	origin: string;
	referer: string;
	timeoutMs?: number;
	/** Explicit timeoutMs remains an absolute hard cap. Otherwise use idle + total bounds. */
	streamIdleTimeoutMs?: number;
	streamMaxDurationMs?: number;
}

export interface WorkBuddyClientOptions {
	config: WorkBuddyChatConfig;
	fetchImpl?: typeof fetch;
	authFileRoots?: string[];
	/** 账号模型快照。返回 false 表示该账号目录里没有这个模型。 */
	supportsModel?(account: Account, model: string): boolean;
}

export class WorkBuddyChatClient implements UpstreamChatClient {
	readonly #config: WorkBuddyChatConfig;
	readonly #fetchImpl: typeof fetch;
	readonly #authFileRoots: string[];
	readonly #supportsModel: ((account: Account, model: string) => boolean) | undefined;

	constructor(options: WorkBuddyClientOptions) {
		this.#config = options.config;
		this.#fetchImpl = options.fetchImpl ?? fetch;
		this.#authFileRoots = options.authFileRoots ?? [];
		this.#supportsModel = options.supportsModel;
	}

	platform(): Platform {
		return "WORKBUDDY";
	}

	async chatCompletion(
		account: Account,
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const { body } = await aggregateStreamToCompletion(this, account, payload, signal);
		return body;
	}

	async chatCompletionStream(
		account: Account,
		payload: Record<string, unknown>,
		onChunk: (chunkJson: string) => void,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const model = stripModelPrefix(typeof payload.model === "string" ? payload.model : "");
		if (this.#supportsModel !== undefined && !this.#supportsModel(account, model)) {
			throw new UpstreamException("BAD_REQUEST", "WorkBuddy 账号不支持该模型或目录尚未同步");
		}
		let accessToken: string;
		try {
			accessToken = workBuddyToken(account, this.#authFileRoots);
		} catch (error) {
			throw new UpstreamException(
				"AUTH",
				error instanceof Error ? error.message : "WorkBuddy accessToken 缺失或为加密信封",
			);
		}
		const body = normalizeWorkBuddyPayload(payload);
		// 上游只认 stream:true
		body.stream = true;
		let emitted = false;
		let lastIo: Error | null = null;
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				await this.postChat(
					accessToken,
					body,
					(chunk) => {
						emitted = true;
						onChunk(chunk);
					},
					signal,
				);
				return;
			} catch (error) {
				signal?.throwIfAborted();
				if (error instanceof UpstreamException || error instanceof GatewayFault) {
					throw error;
				}
				const message = error instanceof Error ? error.message : String(error);
				lastIo = error instanceof Error ? error : new Error(message);
				// 已向下游吐过 SSE 不能换连接重放；瞬断且未吐数据重试一次
				if (attempt < 2 && !emitted && isNetworkBlip(message)) {
					continue;
				}
				throw new UpstreamException("SERVER", `WorkBuddy 转发失败: ${message}`);
			}
		}
		throw new UpstreamException("SERVER", `WorkBuddy 转发失败: ${lastIo?.message ?? "unknown"}`);
	}

	async postChat(
		accessToken: string,
		body: Record<string, unknown>,
		onChunk: (chunkJson: string) => void,
		caller?: AbortSignal,
	): Promise<void> {
		caller?.throwIfAborted();
		const controller = new AbortController();
		const idleMs = this.#config.streamIdleTimeoutMs ?? 120_000;
		const totalMs = this.#config.timeoutMs ?? this.#config.streamMaxDurationMs ?? 600_000;
		const explicit = this.#config.timeoutMs !== undefined;
		const abortFromCaller = () => controller.abort(caller?.reason);
		caller?.addEventListener("abort", abortFromCaller, { once: true });
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const touch = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(
				() =>
					controller.abort(
						new GatewayFault(
							504,
							"upstream_stream_idle_timeout",
							`WorkBuddy 流连续 ${idleMs}ms 未收到数据，已中止等待`,
						),
					),
				idleMs,
			);
		};
		const totalTimer = setTimeout(
			() =>
				controller.abort(
					new GatewayFault(
						504,
						"upstream_timeout",
						`WorkBuddy ${explicit ? "显式绝对期限" : "流总时长上限"} ${totalMs}ms 已到，已中止等待`,
					),
				),
			totalMs,
		);
		let rejectAbort: (reason: unknown) => void = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = reject;
		});
		const abortWait = () => rejectAbort(controller.signal.reason);
		controller.signal.addEventListener("abort", abortWait, { once: true });
		touch();
		try {
			let response: Response;
			try {
				const pending = this.#fetchImpl(`${this.#config.baseUrl.replace(/\/+$/, "")}${this.#config.chatPath}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"User-Agent": this.#config.userAgent,
						Origin: this.#config.origin,
						Referer: this.#config.referer,
						Accept: "text/event-stream",
						"Content-Type": "application/json",
						"X-Requested-With": "XMLHttpRequest",
						"X-Product": "SaaS",
						// 三铁律：缺省身份头显式占位；绝不携带 X-Refresh-Token
						"X-No-User-Id": "1",
						"X-No-Enterprise-Id": "1",
						"X-No-Department-Info": "1",
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				// A non-cooperative transport still cannot keep our request waiting indefinitely.
				void pending.then(
					(late) => {
						if (controller.signal.aborted) void late.body?.cancel().catch(() => {});
					},
					() => {},
				);
				response = await Promise.race([pending, aborted]);
			} catch (error) {
				controller.signal.throwIfAborted();
				const cause = error !== null && typeof error === "object" && "cause" in error ? error.cause : null;
				const code = cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
				if (!["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
					throw new GatewayFault(
						502,
						"upstream_stream_interrupted",
						`WorkBuddy 请求中断，费用待核对: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				throw new UpstreamException(
					"SERVER",
					`WorkBuddy 请求未建立连接 (${code}): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!response.ok) {
				let text = "";
				const errorReader = response.body?.getReader();
				if (errorReader) {
					const decoder = new TextDecoder();
					const cancelErrorBody = () => {
						void errorReader.cancel(controller.signal.reason).catch(() => {});
					};
					controller.signal.addEventListener("abort", cancelErrorBody, { once: true });
					try {
						for (;;) {
							const { done, value } = await Promise.race([errorReader.read(), aborted]);
							if (done) break;
							touch();
							text += decoder.decode(value, { stream: true });
							if (text.length >= 4096) break;
						}
					} finally {
						controller.signal.removeEventListener("abort", cancelErrorBody);
						void errorReader.cancel().catch(() => {});
						errorReader.releaseLock();
					}
				}
				const kind =
					response.status === 400
						? "BAD_REQUEST"
						: response.status === 401 || response.status === 403
							? "AUTH"
							: response.status === 429
								? "RATE"
								: "SERVER";
				const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
				const exception = new UpstreamException(kind, `WorkBuddy HTTP ${response.status}: ${truncate(text)}`);
				if (!Number.isNaN(retryAfter)) {
					throw new UpstreamException(exception.kind, exception.message, retryAfter);
				}
				throw exception;
			}
			if (!response.body) {
				throw new GatewayFault(502, "upstream_stream_interrupted", "WorkBuddy 流式响应为空，费用待核对");
			}
			touch();
			try {
				await parseSseToOpenAi(response.body, String(body.model), onChunk, {
					signal: controller.signal,
					onActivity: touch,
				});
			} catch (error) {
				controller.signal.throwIfAborted();
				throw new GatewayFault(
					502,
					"upstream_stream_interrupted",
					`WorkBuddy 流中断，费用待核对: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} finally {
			clearTimeout(totalTimer);
			if (idleTimer) clearTimeout(idleTimer);
			caller?.removeEventListener("abort", abortFromCaller);
			controller.signal.removeEventListener("abort", abortWait);
		}
	}
}

/** 上游 SSE → OpenAI chat.completion.chunk JSON 行；EOF 后补收尾 chunk（finish_reason + usage）。 */
export async function parseSseToOpenAi(
	stream: ReadableStream<Uint8Array>,
	model: string,
	consumer: (chunkJson: string) => void,
	options?: { signal?: AbortSignal; onActivity?(): void },
): Promise<void> {
	const id = `chatcmpl-${crypto.randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	let sentRole = false;
	let lastUsage: Record<string, unknown> | null = null;
	let finishReason: string | null = null;
	let indexTool = 0;
	const completion = new OpenAiStreamCompletion();
	const sse = new SseEventReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const emitChunk = (delta: Record<string, unknown>): void => {
		const chunk: Record<string, unknown> = { id, object: "chat.completion.chunk", created, model };
		const d: Record<string, unknown> = { ...(delta as Record<string, unknown>) };
		if (!sentRole) {
			d.role = "assistant";
			sentRole = true;
		}
		if (Object.keys(d).length === 0) {
			d.content = null;
		}
		chunk.choices = [{ index: 0, delta: d, finish_reason: null }];
		consumer(JSON.stringify(chunk));
	};

	const handleEvent = (data: string): void => {
		if (data.trim() === "[DONE]") {
			completion.done();
			return;
		}
		let payload: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(data);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new IncompleteUpstreamStreamException();
			}
			payload = parsed as Record<string, unknown>;
		} catch (error) {
			if (error instanceof IncompleteUpstreamStreamException) {
				throw error;
			}
			throw new IncompleteUpstreamStreamException();
		}
		completion.observe(payload);
		if (payload.usage !== null && typeof payload.usage === "object" && !Array.isArray(payload.usage)) {
			lastUsage = payload.usage as Record<string, unknown>;
		}
		const choices = payload.choices;
		if (!Array.isArray(choices) || choices.length === 0) {
			return;
		}
		const choice0 = choices[0] as Record<string, unknown>;
		if (
			typeof choice0.finish_reason === "string" &&
			["stop", "length", "tool_calls", "function_call", "content_filter"].includes(choice0.finish_reason)
		) {
			finishReason = choice0.finish_reason;
		}
		const delta = (choice0.delta ?? {}) as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		if (typeof delta.content === "string") {
			out.content = delta.content;
		}
		if (typeof delta.reasoning_content === "string") {
			out.reasoning_content = delta.reasoning_content;
		}
		if (Array.isArray(delta.tool_calls)) {
			const toolCalls: Array<Record<string, unknown>> = delta.tool_calls.map((raw) => {
				const tc = (raw ?? {}) as Record<string, unknown>;
				const fn = (tc.function ?? tc) as Record<string, unknown>;
				const one: Record<string, unknown> = {
					index: typeof tc.index === "number" ? tc.index : indexTool++,
					type: typeof tc.type === "string" ? tc.type : "function",
					function: {
						...(typeof fn.name === "string" ? { name: fn.name } : {}),
						...(typeof fn.arguments === "string" ? { arguments: fn.arguments } : {}),
					},
				};
				if (typeof tc.id === "string") {
					one.id = tc.id;
				}
				return one;
			});
			out.tool_calls = toolCalls;
		}
		emitChunk(out);
	};

	const reader = stream.getReader();
	let rejectAbort: (reason: unknown) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const interrupt = () => {
		rejectAbort(options?.signal?.reason);
		void reader.cancel(options?.signal?.reason).catch(() => {});
	};
	options?.signal?.addEventListener("abort", interrupt, { once: true });
	const pump = async (): Promise<void> => {
		options?.signal?.throwIfAborted();
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), aborted]);
			if (done) {
				break;
			}
			options?.onActivity?.();
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				const event = sse.next(line);
				if (event !== null) {
					handleEvent(event.data);
				}
				newline = buffer.indexOf("\n");
			}
		}
		const tail = sse.finish();
		if (tail !== null) {
			handleEvent(tail.data);
		}
	};

	try {
		await pump();
	} catch (error) {
		options?.signal?.throwIfAborted();
		if (error instanceof IncompleteUpstreamStreamException) {
			throw error;
		}
		throw new UpstreamException(
			"SERVER",
			`WorkBuddy SSE 解析失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		options?.signal?.removeEventListener("abort", interrupt);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	completion.requireComplete();

	// 收尾 chunk：finish_reason + usage（终止原因与最终 usage 只在此发一次）
	const last: Record<string, unknown> = { id, object: "chat.completion.chunk", created, model };
	const lastChoice: Record<string, unknown> = { index: 0, delta: {}, finish_reason: finishReason ?? "stop" };
	if (lastUsage !== null) {
		last.usage = lastUsage;
	}
	last.choices = [lastChoice];
	consumer(JSON.stringify(last));
}

/**
 * 请求形状归一：剥新客户端指纹字段、旧字段名回退、tool_choice 归一成字符串、
 * 模型剥路由前缀、hy3* 缺省思考档 high。
 */
export function normalizeWorkBuddyPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const body: Record<string, unknown> = { ...payload };
	for (const key of [
		"stream",
		"user",
		"metadata",
		"store",
		"stream_options",
		"service_tier",
		"logprobs",
		"top_logprobs",
		"seed",
		"n",
		"thinking",
		"anthropic_version",
		"system",
		"max_tokens_to_sample",
	]) {
		delete body[key];
	}
	stripFingerprintKeys(body);
	if (typeof body.max_completion_tokens === "number") {
		// max_completion_tokens 是新 OpenAI 客户端指纹 → 旧字段名
		body.max_tokens = body.max_completion_tokens;
	}
	delete body.max_completion_tokens;
	const toolChoice = body.tool_choice;
	if (toolChoice !== null && typeof toolChoice === "object") {
		const fn = (toolChoice as Record<string, unknown>).function;
		body.tool_choice =
			fn !== null && typeof fn === "object" && (fn as Record<string, unknown>).name !== undefined
				? String((fn as Record<string, unknown>).name)
				: "auto";
	}
	const bareModel = stripModelPrefix(typeof body.model === "string" ? body.model : "");
	body.model = bareModel;
	if (bareModel.startsWith("hy3") && body.reasoning_effort === undefined) {
		body.reasoning_effort = "high";
	}
	if (body.model === undefined || body.model === "") {
		body.model = "hy3";
	}
	return body;
}

/** 递归剥指纹键（cc_* / x-anthropic* / anthropic_version）。 */
function stripFingerprintKeys(node: unknown): void {
	if (node !== null && typeof node === "object" && !Array.isArray(node)) {
		const map = node as Record<string, unknown>;
		for (const key of Object.keys(map)) {
			const lowered = key.toLowerCase();
			if (lowered.startsWith("cc_") || lowered.startsWith("x-anthropic") || lowered === "anthropic_version") {
				delete map[key];
			}
		}
		for (const value of Object.values(map)) {
			stripFingerprintKeys(value);
		}
	} else if (Array.isArray(node)) {
		for (const item of node) {
			stripFingerprintKeys(item);
		}
	}
}

function truncate(text: string): string {
	const cleaned = text.replaceAll(/\s+/g, " ").trim();
	return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}
