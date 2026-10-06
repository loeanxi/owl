/**
 * HTTP 服务器组装 —— node:http，handler 链：healthz → API 路由 → 404。
 * 对外统一 ApiResponse 信封；BusinessError 按错误码映射状态码。
 * 阶段 1 无鉴权，只允许绑定回环（见迁移文档 D7）；鉴权在阶段 2 落地。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	type AccountStore,
	BusinessError,
	type CheckInRecordStore,
	type CheckInService,
	describeUpstreamError,
} from "owl-pool";
import { registerAccountRoutes } from "./http/accounts-api.ts";
import { registerCheckInRoutes } from "./http/checkin-api.ts";
import { jsonRespond, readJsonBody, respondErr } from "./http/respond.ts";
import { Router } from "./http/router.ts";
import { MAX_BODY_BYTES } from "./store/db.ts";

export interface PoolServerDeps {
	accounts: AccountStore;
	records: CheckInRecordStore;
	checkin: CheckInService;
	/** healthz 报告用。 */
	dbPath: string;
	isDbAlive: () => boolean;
	startedAt?: number;
	maxBodyBytes?: number;
}

export function createPoolServer(deps: PoolServerDeps): Server {
	const startedAt = deps.startedAt ?? Date.now();
	const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES;

	const router = new Router();
	registerAccountRoutes(router, deps);
	registerCheckInRoutes(router, deps);

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
		try {
			// 健康检查：无鉴权，manager 形状 {status, db, uptimeSeconds}
			if (request.method === "GET" && url.pathname === "/healthz") {
				const alive = deps.isDbAlive();
				const body = {
					status: alive ? "UP" : "DOWN",
					db: alive ? "UP" : "DOWN",
					uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
				};
				jsonRespond(response, alive ? 200 : 503, body);
				return;
			}

			const readBody = <T>() => readJsonBody(request, maxBodyBytes) as Promise<T>;
			const handled = await router.handle(request, response, url, readBody);
			if (!handled) {
				respondErr(response, "common.notFound", `路径不存在: ${request.method} ${url.pathname}`);
			}
		} catch (error) {
			if (error instanceof BusinessError) {
				respondErr(response, error.code, error.message);
			} else {
				console.error("[pool-server] unhandled error:", error);
				respondErr(response, "common.internal", describeUpstreamError(error));
			}
		} finally {
			// 未消费的请求体要排干，否则客户端可能挂在发送上
			if (!response.writableEnded) {
				request.resume();
			}
		}
	}

	return createServer((request, response) => {
		void handle(request, response);
	});
}
