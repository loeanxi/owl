/**
 * pool-server 入口 —— 装配领域层与管理端鉴权栈/HTTP/存储/定时器。
 * 运行：`node dist/main.js`（esbuild 产物）或 `npm run dev`（Node 类型剥离直跑 src）。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Platform, UpstreamChatClient } from "owl-pool";
import {
	AccountPoolRouter,
	ApiKeyService,
	CheckInService,
	MemoryGatewayState,
	RouteGeneration,
	StickySessionService,
	TraeCheckInProvider,
	WorkBuddyCheckInProvider,
} from "owl-pool";
import { loadConfig } from "./config.ts";
import { AnthropicCompatibleClient } from "./gateway/anthropic-compatible.ts";
import { GrokUpstreamClient } from "./gateway/grok-client.ts";
import type { GatewayServiceDeps } from "./gateway/service.ts";
import { CheckInScheduler } from "./scheduler.ts";
import { AdminGuard } from "./security/admin-guard.ts";
import { AdminAuthService } from "./security/admin-service.ts";
import { createPoolServer } from "./server.ts";
import { SqliteAccountStore } from "./store/account-store.ts";
import { SqliteAdminCredentialStore } from "./store/admin-credential-store.ts";
import { newRecordId, SqliteCheckInRecordStore } from "./store/checkin-record-store.ts";
import { dbAlive, openDb } from "./store/db.ts";
import { SqliteApiKeyStore, SqliteCallLogStore, SqliteCatalogStore } from "./store/gateway-stores.ts";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const config = loadConfig(env);
	const allowNonLoopback =
		config.admin.enabled && (config.admin.password.length > 0 || config.admin.setupToken.length >= 32);
	if (!isLoopback(config.host) && !allowNonLoopback) {
		console.error(
			"[pool-server] 拒绝绑定非回环地址：需要管理端鉴权就绪（配置 OWL_POOL_ADMIN_PASSWORD，或提供 32 位以上 OWL_POOL_ADMIN_SETUP_TOKEN 供首次向导）。",
		);
		throw new Error("non-loopback bind rejected");
	}

	const dbFile = resolve(config.dbPath);
	mkdirSync(dirname(dbFile), { recursive: true });
	const db = openDb(dbFile);
	const accounts = new SqliteAccountStore(db);
	const records = new SqliteCheckInRecordStore(db);
	const checkin = new CheckInService({
		accounts,
		records,
		providers: [
			new WorkBuddyCheckInProvider({
				baseUrl: config.workbuddyBaseUrl,
				authFileRoots: config.workbuddyAuthFileRoots,
			}),
			new TraeCheckInProvider({ baseUrl: config.traeBaseUrl }),
		],
		newId: newRecordId,
	});

	// 管理端鉴权栈（阶段 2）：口令/会话/锁定/守卫
	const adminService = new AdminAuthService({
		config: config.admin,
		credentials: new SqliteAdminCredentialStore(db),
	});
	if (config.admin.enabled && adminService.isSetupRequired()) {
		console.log(
			"[pool-server] 管理端尚未设置口令：请完成首次设置（本机回环直接设置；远程需 OWL_POOL_ADMIN_SETUP_TOKEN）。",
		);
	}
	const admin = {
		config: config.admin,
		service: adminService,
		guard: new AdminGuard({ config: config.admin, service: adminService }),
		trustedProxyCount: config.trustedProxyCount,
	};

	// 网关栈（阶段 3）：Key 服务 + 目录 + 号池路由 + 换号执行 + 上游通道
	const apiKeyStore = new SqliteApiKeyStore(db);
	const keys = new ApiKeyService({ store: apiKeyStore });
	const catalog = new SqliteCatalogStore(db);
	const callLogs = new SqliteCallLogStore(db);
	const gatewayState = new MemoryGatewayState();
	const poolRouter = new AccountPoolRouter({
		accounts,
		accountCooldownMs: config.gateway.accountCooldownMs,
		cooldownState: gatewayState,
	});
	const sticky = new StickySessionService({
		enabled: config.gateway.stickyEnabled,
		ttlSeconds: config.gateway.stickyTtlSeconds,
	});
	const upstreams = new Map<Platform, UpstreamChatClient>();
	const grok = new GrokUpstreamClient({
		baseUrl: config.gateway.grokBaseUrl,
		timeoutMs: config.gateway.upstreamTimeoutMs,
	});
	upstreams.set(grok.platform(), grok);
	const generation = new RouteGeneration({
		accounts,
		router: poolRouter,
		sticky,
		upstreams,
		maxRotate: config.gateway.maxRotate,
	});
	const gatewayDeps: GatewayServiceDeps = {
		config: config.gateway,
		state: gatewayState,
		keys,
		accounts,
		router: poolRouter,
		generation,
		sticky,
		upstreams,
		callLogs,
		catalog,
		listPublishedModels: () => catalog.listModels(),
		trustedProxyCount: config.trustedProxyCount,
	};

	const server = createPoolServer({
		accounts,
		records,
		checkin,
		dbPath: dbFile,
		isDbAlive: () => dbAlive(db),
		admin,
		gateway: { gateway: gatewayDeps, gatewayConfig: config.gateway },
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => resolveListen());
	});

	const scheduler = new CheckInScheduler(checkin, {
		hour: config.checkInHour,
		minute: config.checkInMinute,
		staggerMs: config.checkInStaggerMs,
	});
	scheduler.start();

	console.log(`owl pool-server listening on http://${config.host}:${config.port}（db: ${dbFile}）`);

	const shutdown = (signal: string) => {
		console.log(`[pool-server] 收到 ${signal}，退出`);
		scheduler.stop();
		server.close();
		db.close();
		process.exit(0);
	};
	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// 直接运行时才启动（被测试/其他模块 import 时不拉起服务）
const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
	void main();
}
