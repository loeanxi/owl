/**
 * pool-server 入口 —— 装配领域层与管理端鉴权栈/HTTP/存储/定时器。
 * 运行：`node dist/main.js`（esbuild 产物）或 `npm run dev`（Node 类型剥离直跑 src）。
 */
import { mkdirSync, existsSync as pathExists } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Platform, UpstreamChatClient } from "owl-pool";
import {
	AccountPoolRouter,
	ApiKeyService,
	BillingService,
	CheckInService,
	MemoryGatewayState,
	RouteGeneration,
	StickySessionService,
	TraeCheckInProvider,
	WorkBuddyCheckInProvider,
} from "owl-pool";
import { loadConfig } from "./config.ts";
import { AnthropicCompatibleClient } from "./gateway/anthropic-compatible.ts";
import { GeminiChatClient } from "./gateway/gemini-client.ts";
import { GrokUpstreamClient } from "./gateway/grok-client.ts";
import { SdkBridgeChatClient, SdkBridgeManager } from "./gateway/sdk-bridge.ts";
import { MimoChatClient, MimoServeManager } from "./gateway/mimo-client.ts";
import type { GatewayServiceDeps } from "./gateway/service.ts";
import { TraeChatClient } from "./gateway/trae-client.ts";
import { WorkBuddyChatClient } from "./gateway/workbuddy-client.ts";
import { CheckInScheduler } from "./scheduler.ts";
import { AdminGuard } from "./security/admin-guard.ts";
import { AdminAuthService } from "./security/admin-service.ts";
import { createPoolServer } from "./server.ts";
import { SqliteAccountStore } from "./store/account-store.ts";
import { SqliteAdminCredentialStore } from "./store/admin-credential-store.ts";
import { SqliteBillingStore } from "./store/billing-store.ts";
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

	const dbFile = pathResolve(config.dbPath);
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
	const billingStore = new SqliteBillingStore(db);
	const billing = new BillingService({ store: billingStore });
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
	const zcode = new AnthropicCompatibleClient({
		platform: "ZCODE",
		label: "ZCode",
		anthropicVersion: config.gateway.zcode.anthropicVersion,
		defaultMaxTokens: config.gateway.zcode.defaultMaxTokens,
		timeoutMs: config.gateway.upstreamTimeoutMs,
	});
	upstreams.set(zcode.platform(), zcode);
	const claude = new AnthropicCompatibleClient({
		platform: "CLAUDE",
		label: "Claude",
		baseUrl: config.gateway.claude.baseUrl,
		defaultMaxTokens: config.gateway.claude.defaultMaxTokens,
		anthropicVersion: config.gateway.claude.anthropicVersion,
		oauthBetaHeaders: config.gateway.claude.oauthBetaHeaders,
		cliVersion: config.gateway.claude.cliVersion,
		thinkingBudgets: config.gateway.claude.thinkingBudgets,
		exposeThinking: true,
		foldCacheTokens: true,
		timeoutMs: config.gateway.upstreamTimeoutMs,
	});
	upstreams.set(claude.platform(), claude);
	const workbuddy = new WorkBuddyChatClient({
		config: {
			baseUrl: config.gateway.workbuddy.baseUrl,
			chatPath: config.gateway.workbuddy.chatPath,
			userAgent: config.gateway.workbuddy.userAgent,
			origin: config.gateway.workbuddy.origin,
			referer: config.gateway.workbuddy.referer,
			timeoutMs: config.gateway.upstreamTimeoutMs,
		},
	});
	upstreams.set(workbuddy.platform(), workbuddy);
	const trae = new TraeChatClient({
		config: {
			chatBaseUrl: config.gateway.trae.chatBaseUrl,
			chatPath: config.gateway.trae.chatPath,
			appId: config.gateway.trae.appId,
			ideVersion: config.gateway.trae.ideVersion,
			ideVersionCode: config.gateway.trae.ideVersionCode,
			timeoutMs: config.gateway.upstreamTimeoutMs,
		},
	});
	upstreams.set(trae.platform(), trae);
	const gemini = new GeminiChatClient({
		config: {
			baseUrl: config.gateway.gemini.baseUrl,
			apiVersion: config.gateway.gemini.apiVersion,
			defaultMaxTokens: config.gateway.gemini.defaultMaxTokens,
			timeoutMs: config.gateway.upstreamTimeoutMs,
		},
	});
	upstreams.set(gemini.platform(), gemini);
	const mimoManager = new MimoServeManager({ config: config.gateway.mimo, allAccounts: () => accounts.list() });
	const mimoClient = new MimoChatClient(mimoManager, { config: config.gateway.mimo, allAccounts: () => accounts.list() });
	upstreams.set(mimoClient.platform(), mimoClient);
	// SDK 桥（CURSOR/COPILOT/QODER）：脚本路径对 cwd / src / dist 三种深度解析
	const bridgeScriptCandidates = [
		pathResolve(config.gateway.bridge.script),
		pathResolve(pathResolve(), "../bridge/src/main.mjs"),
		fileURLToPath(new URL("../../bridge/src/main.mjs", import.meta.url)),
	];
	const bridgeScript =
		bridgeScriptCandidates.find((candidate) => pathExists(candidate)) ?? config.gateway.bridge.script;
	const bridgeManager = new SdkBridgeManager({ ...config.gateway.bridge, script: bridgeScript }, accounts);
	for (const bridgePlatform of ["CURSOR", "COPILOT", "QODER"] as const) {
		const bridgeClient = new SdkBridgeChatClient(bridgeManager, accounts, bridgePlatform, {
			...config.gateway.bridge,
			script: bridgeScript,
		});
		upstreams.set(bridgeClient.platform(), bridgeClient);
	}
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
		backupDb: db,
		backupDir: pathResolve("data/backups"),
		billing,
		billingStore,
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
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(pathResolve(process.argv[1])).href;
if (invokedDirectly) {
	void main();
}
