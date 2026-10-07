/**
 * HTTP 服务器组装 —— node:http，handler 链：healthz → 管理端守卫 → API 路由 → 404。
 * 对外统一 ApiResponse 信封；BusinessError 按错误码映射状态码。
 * 阶段 2 起 /api/** 由 AdminGuard 把关（匿名白名单：login/logout/setup/session），
 * 服务仍默认只绑回环（对外部署还需反代 + requireHttps，见迁移文档）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
	type Account,
	type AccountStore,
	BusinessError,
	type CheckInRecordStore,
	type CheckInService,
	describeUpstreamError,
} from "owl-pool";
import type { LiveDiscoveryOptions } from "./catalog/discovery.ts";
import { registerDiagnosticRoutes } from "./diagnostics.ts";
import { chatCompletion } from "./gateway/service.ts";
import { registerAccountRoutes } from "./http/accounts-api.ts";
import { registerAdminRoutes } from "./http/admin-api.ts";
import { registerCheckInRoutes } from "./http/checkin-api.ts";
import {
	registerGatewayAdminRoutes,
	registerKeyAdminRoutes,
	registerModelAdminRoutes,
} from "./http/gateway-admin-api.ts";
import { type GatewayRoutesDeps, registerAnthropicGatewayRoutes, registerGatewayRoutes } from "./http/gateway-api.ts";
import { tryServeManagerSite } from "./http/manager-site.ts";
import { registerManagerUiRoutes } from "./http/manager-ui-routes.ts";
import { listAdminMembers, registerMemberRoutes } from "./http/member-api.ts";
import { jsonRespond, readJsonBody, respondErr } from "./http/respond.ts";
import { Router } from "./http/router.ts";
import type { AdminGuard } from "./security/admin-guard.ts";
import type { AdminAuthService, AdminSecurityConfig } from "./security/admin-service.ts";
import type { MemberConcurrencyService } from "./security/member-concurrency.ts";
import { registerBackupRoutes } from "./store/backup.ts";
import { registerBillingRoutes } from "./store/billing-store.ts";
import { MAX_BODY_BYTES } from "./store/db.ts";
import { SqliteMemberStore } from "./store/member-store.ts";

/** 管理端鉴权栈：配置 + 服务 + 守卫 + 可信代层数，由入口装配一次。 */
export interface AdminStack {
	config: AdminSecurityConfig;
	service: AdminAuthService;
	guard: AdminGuard;
	trustedProxyCount: number;
}

export interface PoolServerDeps {
	accounts: AccountStore;
	records: CheckInRecordStore;
	checkin: CheckInService;
	/** healthz 报告用。 */
	dbPath: string;
	isDbAlive: () => boolean;
	/** 管理端鉴权栈；缺省时退化为「自救模式」（仅回环可访问 /api/**）。 */
	admin?: AdminStack;
	/** 网关栈（/v1/*，阶段 3）；缺省时 /v1 返回网关未启用。 */
	gateway?: GatewayRoutesDeps;
	liveDiscovery?: LiveDiscoveryOptions;
	startedAt?: number;
	maxBodyBytes?: number;
	refreshCredit?(account: Account): Promise<Account>;
	pingAccount?(account: Account): Promise<Record<string, unknown>>;
	login?: {
		login(account: Account): Promise<Record<string, unknown>>;
		status(account: Account): Promise<Record<string, unknown>>;
		cancel(account: Account, jobId: string | null): Promise<Record<string, unknown>>;
		input(account: Account, text: string): Promise<Record<string, unknown>>;
	};
	concurrency?: MemberConcurrencyService;
}

export function createPoolServer(deps: PoolServerDeps): Server {
	const startedAt = deps.startedAt ?? Date.now();
	const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES;

	const router = new Router();
	registerAccountRoutes(router, deps);
	registerCheckInRoutes(router, deps);
	const gateway = deps.gateway;
	if (gateway?.gateway.backupDb !== undefined) {
		registerDiagnosticRoutes(router, {
			db: gateway.gateway.backupDb,
			accounts: deps.accounts,
			upstreams: gateway.gateway.upstreams,
		});
	}
	// 具体路径要先于 /api/models/:id，否则 discovered 会被当成模型 id。
	const gatewayDb = gateway?.gateway.backupDb;
	const memberPortal = gateway !== undefined && gatewayDb !== undefined;
	registerManagerUiRoutes(router, {
		accounts: deps.accounts,
		callLogs: gateway?.gateway.callLogs,
		maxRotate: gateway?.gatewayConfig.maxRotate ?? 3,
		memberPortal,
		listMembers: memberPortal
			? () => listAdminMembers(new SqliteMemberStore(gatewayDb), gateway.gateway.keys)
			: undefined,
		db: gatewayDb,
		catalog: gateway?.gateway.catalog,
		backupDir: gateway?.gateway.backupDir,
		liveDiscovery: deps.liveDiscovery,
	});
	if (memberPortal) {
		registerMemberRoutes(router, {
			db: gatewayDb,
			keys: gateway.gateway.keys,
			catalog: gateway.gateway.catalog,
			billingStore: gateway.gateway.billingStore,
			callLogs: gateway.gateway.callLogs,
			dataDir: dirname(deps.dbPath),
			trustedProxyCount: deps.admin?.trustedProxyCount ?? gateway.gateway.trustedProxyCount,
			completeChat: (auth, payload) => chatCompletion(gateway.gateway, auth, payload),
			tryRateLimit: (bucket, perMinute) => gateway.gateway.state.tryAcquireRateLimit(bucket, perMinute),
			concurrency: deps.concurrency,
		});
	}
	const billingStore = deps.gateway?.gateway.billingStore;
	const billing = deps.gateway?.gateway.billing;
	if (billingStore !== undefined && billing !== undefined) {
		registerBillingRoutes(router, {
			billing,
			store: billingStore,
			db: deps.gateway?.gateway.backupDb,
			catalog: deps.gateway?.gateway.catalog,
		});
	}
	const backupDb = deps.gateway?.gateway.backupDb;
	const backupDir = deps.gateway?.gateway.backupDir;
	if (backupDb !== undefined && backupDir !== undefined) {
		registerBackupRoutes(router, { db: backupDb, backupDir });
	}
	if (deps.admin !== undefined) {
		registerAdminRoutes(router, {
			config: deps.admin.config,
			service: deps.admin.service,
			guard: deps.admin.guard,
			checkin: deps.checkin,
			trustedProxyCount: deps.admin.trustedProxyCount,
		});
	}
	if (deps.gateway !== undefined) {
		registerGatewayRoutes(router, deps.gateway);
		registerAnthropicGatewayRoutes(router, deps.gateway);
		registerKeyAdminRoutes(router, { keys: deps.gateway.gateway.keys, db: deps.gateway.gateway.backupDb });
		registerModelAdminRoutes(router, { catalog: deps.gateway.gateway.catalog });
		registerGatewayAdminRoutes(router, {
			callLogs: deps.gateway.gateway.callLogs,
			catalog: deps.gateway.gateway.catalog,
		});
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
		try {
			// CORS：owl 桌面页（8787 桥）与管理台窗口跨源访问 pool-server API。
			// 仅放行回环来源；凭据模式下 ACAO 必须回显具体 Origin。
			const origin = request.headers.origin;
			if (origin !== undefined && /\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
				response.setHeader("Access-Control-Allow-Origin", origin);
				response.setHeader("Access-Control-Allow-Credentials", "true");
				response.setHeader("Vary", "Origin");
				if (request.method === "OPTIONS") {
					response.writeHead(204, {
						"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
						"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Request-Id",
						"Access-Control-Max-Age": "600",
					});
					response.end();
					return;
				}
			}

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

			// 原版 manager 静态站：/ 首页、/admin 管理台、/member 成员端，以及 css/js/图。
			if (tryServeManagerSite(request, response, url.pathname)) {
				return;
			}

			// 管理端守卫（AdminAuthFilter 等价物）：/api/** 除匿名白名单外一律要求认证；
			// 未装配鉴权栈时仅放行回环对端（自救语义）
			const guard = deps.admin?.guard;
			const verdict = guard !== undefined ? guard.check(request, url.pathname) : loopbackOnlyVerdict(request);
			if (!verdict.ok) {
				jsonRespond(response, verdict.status, { ok: false, error: verdict.error, code: verdict.code });
				return;
			}

			const readBody = <T>() => readJsonBody(request, maxBodyBytes) as Promise<T>;
			const handled = await router.handle(request, response, url, readBody);
			if (!handled) {
				respondErr(response, "common.notFound", `路径不存在: ${request.method} ${url.pathname}`);
			}
		} catch (error) {
			if (isAuthError(error)) {
				respondErr(response, error.code, error.message);
			} else if (error instanceof BusinessError) {
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

/** 未装配鉴权栈时的兜底：只放行回环对端（自救语义，白名单同守卫）。 */
function loopbackOnlyVerdict(
	request: IncomingMessage,
): { ok: true; admin: null } | { ok: false; status: number; code: string; error: string } {
	const remote = request.socket.remoteAddress ?? "";
	if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") {
		return { ok: true, admin: null };
	}
	return { ok: false, status: 403, code: "admin.disabledLoopbackOnly", error: "服务未配置管理端鉴权，仅允许本机访问" };
}

function isAuthError(error: unknown): error is Error & { code: string } {
	if (!(error instanceof Error)) {
		return false;
	}
	const code: unknown = (error as { code?: unknown }).code;
	return typeof code === "string" && code.startsWith("admin.");
}
