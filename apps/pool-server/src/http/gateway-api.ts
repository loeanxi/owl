/**
 * 网关 HTTP 端点 —— /v1/chat/completions（流式 SSE + 非流式）与 /v1/models。
 * 错误一律 OpenAI 协议体；被拒请求也带 X-Request-Id（排障链路第一步）。
 * SSE：15s keepalive 注释帧；客户端断开即停止输出。
 */
import type { ServerResponse } from "node:http";
import { type ApiKeyService, GatewayFault, ModelAccessException, UpstreamException } from "owl-pool";
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
