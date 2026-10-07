/**
 * 网关 HTTP 端点 —— /v1/chat/completions（流式 SSE + 非流式）与 /v1/models。
 * 错误一律 OpenAI 协议体；被拒请求也带 X-Request-Id（排障链路第一步）。
 * SSE：15s keepalive 注释帧；客户端断开即停止输出。
 */
import type { ServerResponse } from "node:http";
import { type ApiKeyService, GatewayFault, ModelAccessException, UpstreamException } from "owl-pool";
import {
	coalesceTextForStatelessClient,
	deleteResponse,
	getResponse,
	newResponseId,
	outputOf,
	preflightResponse,
	putResponse,
	ResponsesStreamBridge,
	readInput,
	responseObject,
	responseStatus,
	responseUsage,
	toChat,
} from "../gateway/responses.ts";
import {
	type AuthenticatedGatewayRequest,
	authenticateGatewayRequest,
	chatCompletion,
	chatCompletionStream,
	type GatewayConfig,
	type GatewayServiceDeps,
	listModelsForKey,
} from "../gateway/service.ts";
import { jsonRespond } from "./respond.ts";
import type { RequestContext, Router } from "./router.ts";

const KEEPALIVE_MS = 15_000;

export interface GatewayRoutesDeps {
	gateway: GatewayServiceDeps;
	gatewayConfig: GatewayConfig;
}

export function registerGatewayRoutes(router: Router, deps: GatewayRoutesDeps): void {
	router.post("/v1/chat/completions", async (ctx) => {
		const verdict = authenticateGatewayRequest(deps.gateway, ctx.request);
		if (!verdict.ok) {
			writeGatewayError(ctx.response, verdict.reject.status, verdict.reject.code, verdict.reject.message);
			return;
		}
		const { auth } = verdict;
		ctx.response.setHeader("X-Request-Id", auth.requestId);
		const payload = await ctx.readBody<Record<string, unknown>>();
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
			writeGatewayError(ctx.response, 400, "invalid_request", "请求体必须是 JSON 对象");
			return;
		}
		if (payload.stream === true) {
			await streamResponse(ctx, deps.gateway, auth, payload);
			return;
		}
		try {
			const body = await chatCompletion(deps.gateway, auth, payload);
			jsonRespond(ctx.response, 200, body);
		} catch (error) {
			writeGatewayFailure(ctx.response, auth.requestId, error);
		}
	});

	router.post("/v1/responses", async (ctx) => {
		await handleResponses(ctx, deps);
	});

	router.get("/v1/responses/:id", async (ctx) => {
		const verdict = authenticateGatewayRequest(deps.gateway, ctx.request);
		if (!verdict.ok) {
			writeGatewayError(ctx.response, verdict.reject.status, verdict.reject.code, verdict.reject.message);
			return;
		}
		try {
			jsonRespond(ctx.response, 200, getResponse(verdict.auth.key, ctx.params.id ?? "").response);
		} catch (error) {
			writeGatewayFailure(ctx.response, verdict.auth.requestId, error);
		}
	});

	router.delete("/v1/responses/:id", async (ctx) => {
		const verdict = authenticateGatewayRequest(deps.gateway, ctx.request);
		if (!verdict.ok) {
			writeGatewayError(ctx.response, verdict.reject.status, verdict.reject.code, verdict.reject.message);
			return;
		}
		try {
			const id = ctx.params.id ?? "";
			deleteResponse(verdict.auth.key, id);
			jsonRespond(ctx.response, 200, { id, object: "response.deleted", deleted: true });
		} catch (error) {
			writeGatewayFailure(ctx.response, verdict.auth.requestId, error);
		}
	});

	router.get("/v1/models", async (ctx) => {
		const verdict = authenticateGatewayRequest(deps.gateway, ctx.request);
		if (!verdict.ok) {
			writeGatewayError(ctx.response, verdict.reject.status, verdict.reject.code, verdict.reject.message);
			return;
		}
		ctx.response.setHeader("X-Request-Id", verdict.auth.requestId);
		const data = listModelsForKey(deps.gateway, verdict.auth.key);
		jsonRespond(ctx.response, 200, { object: "list", data });
	});
}

async function handleResponses(ctx: RequestContext, deps: GatewayRoutesDeps): Promise<void> {
	const verdict = authenticateGatewayRequest(deps.gateway, ctx.request);
	if (!verdict.ok) {
		writeGatewayError(ctx.response, verdict.reject.status, verdict.reject.code, verdict.reject.message);
		return;
	}
	const { auth } = verdict;
	ctx.response.setHeader("X-Request-Id", auth.requestId);
	const body = await ctx.readBody<Record<string, unknown>>();
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		writeGatewayError(ctx.response, 400, "invalid_request", "请求体必须是 JSON 对象");
		return;
	}
	try {
		let prior: Array<Record<string, unknown>> = [];
		if (typeof body.previous_response_id === "string" && body.previous_response_id.trim().length > 0) {
			const context = getResponse(auth.key, body.previous_response_id);
			if (body.model === undefined || body.model === null) {
				body.model = context.model;
			}
			if (context.model !== body.model) {
				throw new GatewayFault(400, "model_mismatch", "续接响应时必须使用相同公开模型");
			}
			prior = context.messages;
		}
		const chat = toChat(body, prior);
		const history = [...prior, ...readInput(body.input)];
		if (body.store !== false) {
			preflightResponse(auth.key, history);
		}
		const id = newResponseId();
		const created = Math.floor(Date.now() / 1000);
		const model = String(body.model ?? "");
		if (body.stream === true) {
			await streamResponses(ctx, deps.gateway, auth, chat, body, history, id, created, model);
			return;
		}
		const result = (await chatCompletion(deps.gateway, auth, chat)) as Record<string, unknown>;
		const response = responseObject(
			id,
			created,
			model,
			outputOf(result),
			body,
			responseStatus(result),
			responseUsage(result),
		);
		saveResponse(auth.key, response, history, body);
		jsonRespond(ctx.response, 200, response);
	} catch (error) {
		writeGatewayFailure(ctx.response, auth.requestId, error);
	}
}

async function streamResponses(
	ctx: RequestContext,
	gateway: GatewayServiceDeps,
	auth: AuthenticatedGatewayRequest,
	chat: Record<string, unknown>,
	body: Record<string, unknown>,
	history: Array<Record<string, unknown>>,
	id: string,
	created: number,
	model: string,
): Promise<void> {
	const response = ctx.response;
	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-store",
		Connection: "keep-alive",
		"X-Request-Id": auth.requestId,
	});
	const usage = [0, 0, 0];
	const bridge = new ResponsesStreamBridge(
		id,
		created,
		model,
		body,
		coalesceTextForStatelessClient(body),
		(type, data) => {
			if (!response.writableEnded) {
				response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
			}
		},
	);
	bridge.start();
	try {
		await chatCompletionStream(gateway, auth, chat, (chunkJson) => {
			const chunk = JSON.parse(chunkJson) as Record<string, unknown>;
			if (chunk.usage !== undefined && typeof chunk.usage === "object" && chunk.usage !== null) {
				const next = responseUsage(chunk);
				usage[0] = next[0] ?? 0;
				usage[1] = next[1] ?? 0;
				usage[2] = next[2] ?? 0;
			}
			bridge.chunk(chunk);
		});
		const completed = bridge.complete(usage);
		saveResponse(auth.key, completed, history, body);
	} catch (error) {
		const failure = error instanceof GatewayFault ? error : new GatewayFault(502, "upstream_error", "上游调用失败");
		bridge.fail(failure.code, failure.message);
	} finally {
		if (!response.writableEnded) {
			response.end();
		}
	}
}

function saveResponse(
	key: AuthenticatedGatewayRequest["key"],
	response: Record<string, unknown>,
	history: Array<Record<string, unknown>>,
	request: Record<string, unknown>,
): void {
	if (request.store === false) {
		return;
	}
	const complete = [...history];
	if (Array.isArray(response.output) && response.output.length > 0) {
		complete.push(...readInput(response.output));
	}
	putResponse(key, String(response.id), String(response.model), complete, response);
}

/** SSE 输出：15s keepalive 注释帧；客户端断开即停止；失败且未产出时按协议写错误事件。 */
async function streamResponse(
	ctx: RequestContext,
	gateway: GatewayServiceDeps,
	auth: AuthenticatedGatewayRequest,
	payload: Record<string, unknown>,
): Promise<void> {
	const response: ServerResponse = ctx.response;
	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-store",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
		"X-Request-Id": auth.requestId,
	});
	let closed = false;
	let emitted = false;
	const keepalive = setInterval(() => {
		if (!closed) {
			response.write(": keepalive\n\n");
		}
	}, KEEPALIVE_MS);
	const finish = (): void => {
		if (!closed) {
			closed = true;
			clearInterval(keepalive);
			response.end();
		}
	};
	ctx.request.on("close", () => {
		closed = true;
		clearInterval(keepalive);
	});
	const writeChunk = (json: string): void => {
		emitted = true;
		if (!closed) {
			response.write(`data: ${json}\n\n`);
		}
	};
	try {
		await chatCompletionStream(gateway, auth, payload, (chunkJson) => {
			writeChunk(chunkJson);
		});
		if (!closed) {
			response.write("data: [DONE]\n\n");
		}
		finish();
	} catch (error) {
		const failure = normalize(error);
		if (!closed && !emitted) {
			writeChunk(
				JSON.stringify({
					error: { message: failure.message, type: failure.code, code: failure.code, request_id: auth.requestId },
				}),
			);
			response.write("data: [DONE]\n\n");
		}
		finish();
	}
}

function writeGatewayFailure(response: ServerResponse, requestId: string, error: unknown): void {
	const failure = normalize(error);
	jsonRespond(response, failure.status, {
		error: { message: failure.message, type: failure.code, code: failure.code, request_id: requestId },
	});
}

interface GatewayFailure {
	status: number;
	code: string;
	message: string;
}

function normalize(error: unknown): GatewayFailure {
	if (error instanceof ModelAccessException) {
		return { status: error.status, code: error.code, message: error.message };
	}
	if (error instanceof GatewayFault) {
		return { status: error.status, code: error.code, message: error.message };
	}
	if (error instanceof UpstreamException) {
		return { status: 502, code: "upstream_error", message: `上游调用失败：${error.message}` };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { status: 500, code: "internal_error", message: `网关内部错误：${message}` };
}

function writeGatewayError(response: ServerResponse, status: number, code: string, message: string): void {
	if (status === 401) {
		response.setHeader("WWW-Authenticate", "Bearer");
	}
	jsonRespond(response, status, { error: { message, type: code, code, request_id: "" } });
}

// 供后续 Key 并发准入使用（阶段 3 范围外的扩展点）
export type { ApiKeyService };

// ── Anthropic 协议端点（阶段 4A）──
import {
	AnthropicStreamBridge,
	anthropicErrorBody,
	anthropicToOpenAiPayload,
	estimateAnthropicInputTokens,
	openAiToAnthropicMessage,
} from "owl-pool";

/** Anthropic 协议错误类型（对齐 manager controller：429→rate_limit / 4xx→invalid_request / 5xx→api_error）。 */
function anthropicTypeOf(status: number): string {
	if (status === 429) {
		return "rate_limit_error";
	}
	return status < 500 ? "invalid_request_error" : "api_error";
}

function upstreamKindType(error: UpstreamException): string {
	switch (error.kind) {
		case "AUTH":
			return "authentication_error";
		case "RATE":
		case "QUOTA":
			return "rate_limit_error";
		case "BAD_REQUEST":
			return "invalid_request_error";
		default:
			return "api_error";
	}
}

function writeAnthropicError(
	response: ServerResponse,
	status: number,
	type: string,
	message: string,
	requestId: string,
): void {
	const body = anthropicErrorBody(type, message);
	body.request_id = requestId;
	jsonRespond(response, status, body);
}

/** POST /v1/messages 与 /v1/messages/count_tokens：Anthropic 客户端直连。 */
export function registerAnthropicGatewayRoutes(router: Router, deps: GatewayRoutesDeps): void {
	router.post("/v1/messages", async (ctx) => {
		const verdict = authenticateGatewayRequest(deps.gateway, ctx.request);
		if (!verdict.ok) {
			writeAnthropicError(
				ctx.response,
				verdict.reject.status,
				anthropicTypeOf(verdict.reject.status),
				verdict.reject.message,
				"",
			);
			return;
		}
		const { auth } = verdict;
		ctx.response.setHeader("X-Request-Id", auth.requestId);
		const anthropicPayload = await ctx.readBody<Record<string, unknown>>();
		if (anthropicPayload === null || typeof anthropicPayload !== "object" || Array.isArray(anthropicPayload)) {
			writeAnthropicError(ctx.response, 400, "invalid_request_error", "请求体必须是 JSON 对象", auth.requestId);
			return;
		}
		// Anthropic Messages → OpenAI chat 形状；会话字段透传给 sticky
		const payload = anthropicToOpenAiPayload(anthropicPayload);
		for (const field of ["session_id", "conversation_id", "metadata", "capability_mode", "context_window"] as const) {
			if (anthropicPayload[field] !== undefined) {
				payload[field] = anthropicPayload[field];
			}
		}
		const requestedModel = typeof anthropicPayload.model === "string" ? anthropicPayload.model : null;
		if (payload.stream === true) {
			const response: ServerResponse = ctx.response;
			response.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
				"X-Request-Id": auth.requestId,
			});
			let closed = false;
			let emitted = false;
			const send = (event: string, data: Record<string, unknown>): void => {
				emitted = true;
				if (!closed) {
					response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
				}
			};
			const bridge = new AnthropicStreamBridge(
				String(anthropicPayload.model ?? requestedModel ?? "unknown"),
				0,
				send,
			);
			const keepalive = setInterval(() => {
				if (!closed) {
					response.write(": keepalive\n\n");
				}
			}, KEEPALIVE_MS);
			const finish = (): void => {
				if (!closed) {
					closed = true;
					clearInterval(keepalive);
					response.end();
				}
			};
			ctx.request.on("close", () => {
				closed = true;
				clearInterval(keepalive);
			});
			try {
				await chatCompletionStream(deps.gateway, auth, payload, (chunkJson) => {
					bridge.onOpenAiChunk(chunkJson);
				});
				bridge.complete();
				finish();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const type =
					error instanceof UpstreamException ? upstreamKindType(error) : anthropicTypeOf(normalize(error).status);
				if (!closed && !emitted) {
					bridge.fail(type, message);
				}
				finish();
			}
			return;
		}
		try {
			const openAiBody = await chatCompletion(deps.gateway, auth, payload);
			jsonRespond(ctx.response, 200, openAiToAnthropicMessage(openAiBody, requestedModel));
		} catch (error) {
			if (error instanceof UpstreamException) {
				writeAnthropicError(ctx.response, 502, upstreamKindType(error), error.message, auth.requestId);
				return;
			}
			const failure = normalize(error);
			writeAnthropicError(
				ctx.response,
				failure.status,
				anthropicTypeOf(failure.status),
				failure.message,
				auth.requestId,
			);
		}
	});

	router.post("/v1/messages/count_tokens", async (ctx) => {
		const verdict = authenticateGatewayRequest(deps.gateway, ctx.request);
		if (!verdict.ok) {
			writeAnthropicError(
				ctx.response,
				verdict.reject.status,
				anthropicTypeOf(verdict.reject.status),
				verdict.reject.message,
				"",
			);
			return;
		}
		const payload = await ctx.readBody<Record<string, unknown>>();
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
			writeAnthropicError(
				ctx.response,
				400,
				"invalid_request_error",
				"请求体必须是 JSON 对象",
				verdict.auth.requestId,
			);
			return;
		}
		jsonRespond(ctx.response, 200, { input_tokens: estimateAnthropicInputTokens(payload) });
	});
}
