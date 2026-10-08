/**
 * pool-server 入口 —— 装配领域层与管理端鉴权栈/HTTP/存储/定时器。
 * 运行：`node dist/main.js`（esbuild 产物）或 `npm run dev`（Node 类型剥离直跑 src）。
 */
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Platform, UpstreamChatClient } from "owl-pool";
import {
	AccountPoolRouter,
	ApiKeyService,
	BillingService,
	CheckInService,
	MemoryGatewayState,
	parseCredentials,
	RouteGeneration,
	StickySessionService,
	TraeCheckInProvider,
	WorkBuddyCheckInProvider,
} from "owl-pool";
import { ClaudeOauthLogin } from "./account/claude-oauth.ts";
import { refreshCredit } from "./account/credits.ts";
import { AccountLoginService } from "./account/login.ts";
import { pingAccount } from "./account/ping.ts";
import { QoderCheckInProvider } from "./account/qoder-checkin.ts";
import { probeAccount } from "./catalog/discovery.ts";
import { loadConfig } from "./config.ts";
import { AnthropicCompatibleClient } from "./gateway/anthropic-compatible.ts";
import { createClaudeTokenResolver } from "./gateway/claude-token.ts";
import { CodexChatClient } from "./gateway/codex-client.ts";
import { ContinuationRegistry } from "./gateway/continuation.ts";
import { GeminiChatClient } from "./gateway/gemini-client.ts";
import { GrokUpstreamClient } from "./gateway/grok-client.ts";
import { GatewayLifecycle } from "./gateway/lifecycle.ts";
import { MimoChatClient, MimoServeManager } from "./gateway/mimo-client.ts";
import { SdkBridgeChatClient, SdkBridgeManager } from "./gateway/sdk-bridge.ts";
import { resolveSdkBridgeScript } from "./gateway/sdk-bridge-entry.ts";
import type { GatewayServiceDeps } from "./gateway/service.ts";
import { TraeChatClient } from "./gateway/trae-client.ts";
import { WorkBuddyChatClient } from "./gateway/workbuddy-client.ts";
import { CheckInScheduler } from "./scheduler.ts";
import { AdminGuard } from "./security/admin-guard.ts";
import { AdminAuthService } from "./security/admin-service.ts";
import { MemberConcurrencyService } from "./security/member-concurrency.ts";
import { createPoolServer } from "./server.ts";
import { SqliteAccountStore } from "./store/account-store.ts";
import { SqliteAdminCredentialStore } from "./store/admin-credential-store.ts";
import { listSnapshots, snapshotToZip } from "./store/backup.ts";
import { SqliteBillingStore } from "./store/billing-store.ts";
import { newRecordId, SqliteCheckInRecordStore } from "./store/checkin-record-store.ts";
import { dbAlive, openDb } from "./store/db.ts";
import { SqliteApiKeyStore, SqliteCallLogStore, SqliteCatalogStore } from "./store/gateway-stores.ts";
import { SqliteMemberStore } from "./store/member-store.ts";

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
	const gatewayLifecycle = new GatewayLifecycle();
	// Never credit legacy/unlinked holds based on age or missing usage alone.
	billing.sweepStale();
	const billingJanitor = setInterval(() => {
		try {
			billing.sweepStale(gatewayLifecycle.activeCallIds());
		} catch (error) {
			console.error(`[pool-server] 计费待核对检查失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, 60_000);
	billingJanitor.unref();
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
		foldCacheTokens: true,
		timeoutMs: config.gateway.upstreamTimeoutMs,
	});
	upstreams.set(zcode.platform(), zcode);
	const claudeTokens = createClaudeTokenResolver(accounts, {
		clientId: config.gateway.claude.oauthClientId,
		tokenUrl: config.gateway.claude.oauthTokenUrl,
	});
	const claude = new AnthropicCompatibleClient({
		platform: "CLAUDE",
		label: "Claude",
		baseUrl: config.gateway.claude.baseUrl,
		defaultMaxTokens: config.gateway.claude.defaultMaxTokens,
		anthropicVersion: config.gateway.claude.anthropicVersion,
		oauthBetaHeaders: config.gateway.claude.oauthBetaHeaders,
		cliVersion: config.gateway.claude.cliVersion,
		refreshOauth: (account) => claudeTokens.resolve(account),
		rejectOauth: (accountId, token) => claudeTokens.reject(accountId, token),
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
			timeoutMs: config.gateway.workbuddy.timeoutMs,
			streamIdleTimeoutMs: config.gateway.workbuddy.streamIdleTimeoutMs,
			streamMaxDurationMs: config.gateway.workbuddy.streamMaxDurationMs,
		},
		authFileRoots: config.workbuddyAuthFileRoots,
		supportsModel: (account, model) => workBuddySupports(db, account.id, model),
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
		functionFor: (account, model) => traeFunctionFor(db, account.id, model),
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
	const mimoClient = new MimoChatClient(mimoManager, {
		config: config.gateway.mimo,
		allAccounts: () => accounts.list(),
	});
	upstreams.set(mimoClient.platform(), mimoClient);
	const codex = new CodexChatClient({
		homeRoot: pathResolve(config.gateway.codex.homeRoot),
		executable: config.gateway.codex.executable,
	});
	upstreams.set(codex.platform(), codex);
	// 默认桥入口随当前源码/编译入口解析，显式配置保留自己的路径。
	const bridgeScript = resolveSdkBridgeScript(config.gateway.bridge.script, import.meta.url);
	const bridgeManager = new SdkBridgeManager({ ...config.gateway.bridge, script: bridgeScript }, accounts);
	const checkin = new CheckInService({
		accounts,
		records,
		providers: [
			new WorkBuddyCheckInProvider({
				baseUrl: config.workbuddyBaseUrl,
				authFileRoots: config.workbuddyAuthFileRoots,
			}),
			new TraeCheckInProvider({ baseUrl: config.traeBaseUrl }),
			new QoderCheckInProvider(async (account) => {
				const client = await bridgeManager.clientFor(account);
				return client.request("checkin", {}, 60_000);
			}),
		],
		newId: newRecordId,
	});
	for (const bridgePlatform of ["CURSOR", "COPILOT", "QODER"] as const) {
		const bridgeClient = new SdkBridgeChatClient(bridgeManager, accounts, bridgePlatform, {
			...config.gateway.bridge,
			script: bridgeScript,
		});
		upstreams.set(bridgeClient.platform(), bridgeClient);
	}
	const continuation = new ContinuationRegistry();
	const concurrency = new MemberConcurrencyService(new SqliteMemberStore(db), {
		defaultLimit: config.memberConcurrency.defaultLimit,
		maxWaiting: config.memberConcurrency.maxWaiting,
		waitMillis: config.memberConcurrency.waitMillis,
	});
	const claudeOauth = new ClaudeOauthLogin(accounts, {
		clientId: config.gateway.claude.oauthClientId,
		tokenUrl: config.gateway.claude.oauthTokenUrl,
		authorizeUrl: "https://claude.com/cai/oauth/authorize",
		redirectUri: "https://platform.claude.com/oauth/code/callback",
		scopes:
			"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
	});
	const login = new AccountLoginService(accounts, bridgeManager, claudeOauth);
	const creditHooks = {
		workbuddyBaseUrl: config.gateway.workbuddy.baseUrl,
		workbuddyAuthRoots: config.workbuddyAuthFileRoots,
		exchangeTraeToken: (session: string) => trae.exchangeToken(session),
		codexQuota: (account: Parameters<typeof codex.quota>[0]) => codex.quota(account),
		mimoPing: (account: Parameters<typeof mimoClient.ping>[0]) => mimoClient.ping(account),
		sdkQuota: async (account: Parameters<typeof bridgeManager.clientFor>[0]) => {
			const client = await bridgeManager.clientFor(account);
			return client.request("quota", {}, 25_000);
		},
		claudeUsage: (account: Parameters<typeof claudeTokens.resolve>[0]) =>
			claudeUsage(config.gateway.claude, claudeTokens, account),
		probe: async (account: Parameters<typeof probeAccount>[0]) => {
			const probed = await probeAccount(account);
			return { ok: probed.ok === true, message: typeof probed.message === "string" ? probed.message : "" };
		},
	};
	const pingHooks = {
		workbuddyBaseUrl: config.gateway.workbuddy.baseUrl,
		workbuddyAuthRoots: config.workbuddyAuthFileRoots,
		exchangeTraeToken: (session: string) => trae.exchangeToken(session),
		codexPing: (account: Parameters<typeof codex.ping>[0]) => codex.ping(account),
		mimoPing: (account: Parameters<typeof mimoClient.ping>[0]) => mimoClient.ping(account),
		sdkStatus: async (account: Parameters<typeof bridgeManager.clientFor>[0]) => {
			const client = await bridgeManager.clientFor(account);
			return client.request("auth_status", {}, 20_000);
		},
	};
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
		continuation,
		concurrency,
		lifecycle: gatewayLifecycle,
	};

	const server = createPoolServer({
		accounts,
		records,
		checkin,
		dbPath: dbFile,
		isDbAlive: () => dbAlive(db),
		admin,
		gateway: { gateway: gatewayDeps, gatewayConfig: config.gateway },
		refreshCredit: (account) => refreshCredit(accounts, account, creditHooks),
		probeCredential: async (account) => {
			if (account.platform !== "CURSOR") return null;
			return (await bridgeManager.clientFor(account)).request("auth_status", {}, 20_000);
		},
		pingAccount: (account) => pingAccount(account, pingHooks),
		login,
		concurrency,
		liveDiscovery: {
			trae: { ...config.gateway.trae, remoteBaseUrl: "https://solo.trae.cn" },
			workbuddy: { ...config.gateway.workbuddy, authFileRoots: config.workbuddyAuthFileRoots },
			sdkCatalog: async (account) => {
				const client = await bridgeManager.clientFor(account);
				return client.request("catalog", {}, 30_000);
			},
		},
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
	scheduleBackups(db, pathResolve("data/backups"));

	console.log(`owl pool-server listening on http://${config.host}:${config.port}（db: ${dbFile}）`);

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[pool-server] 收到 ${signal}，退出`);
		scheduler.stop();
		clearInterval(billingJanitor);
		server.close();
		const drained = await gatewayLifecycle.drain(3000);
		if (!drained) console.warn("[pool-server] 等待中的调用尚未结束；已保留未确定计费的预占待核对");
		bridgeManager.stop();
		mimoManager.stop();
		server.closeAllConnections();
		db.close();
		process.exitCode = 0;
		if (!drained) setTimeout(() => process.exit(0), 100).unref();
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

function scheduleBackups(db: DatabaseSync, dir: string): void {
	const run = () => {
		try {
			const files = listSnapshots(dir);
			const latest = files[0];
			if (latest !== undefined) {
				const age = Date.now() - statSync(pathResolve(dir, latest)).mtimeMs;
				if (age < 20 * 60 * 60 * 1000) {
					return;
				}
			}
			snapshotToZip(db, dir);
			for (const extra of listSnapshots(dir).slice(14)) {
				unlinkSync(pathResolve(dir, extra));
			}
		} catch (error) {
			console.error(`[pool-server] 备份失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const timer = setInterval(run, 60 * 60 * 1000);
	timer.unref();
	setTimeout(run, 15_000).unref();
}

async function claudeUsage(
	claude: { baseUrl: string; anthropicVersion: string },
	tokens: { resolve(account: import("owl-pool").Account): Promise<string> },
	account: import("owl-pool").Account,
): Promise<Record<string, unknown> | null> {
	if (String(parseCredentials(account).authType ?? "").toLowerCase() !== "oauth") {
		return null;
	}
	const token = await tokens.resolve(account);
	const response = await fetch(`${claude.baseUrl.replace(/\/+$/, "")}/api/oauth/usage`, {
		headers: {
			Authorization: `Bearer ${token}`,
			"anthropic-version": claude.anthropicVersion,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		return null;
	}
	const body: unknown = await response.json();
	return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Trae 调用名以该账号已迁入的模型快照为准；没有快照就不能猜。 */
function traeFunctionFor(db: DatabaseSync, accountId: string, model: string): string | null {
	const row = db
		.prepare("SELECT model_functions FROM trae_account_model_snapshots WHERE account_id = ?")
		.get(accountId) as { model_functions?: string } | undefined;
	if (row?.model_functions === undefined || row.model_functions.length === 0) return null;
	let map: unknown;
	try {
		map = JSON.parse(row.model_functions);
	} catch {
		return null;
	}
	if (map === null || typeof map !== "object") return null;
	const value = (map as Record<string, unknown>)[model];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** 有快照时只放行目录里的模型；没有快照就不能猜。 */
function workBuddySupports(db: DatabaseSync, accountId: string, model: string): boolean {
	const row = db
		.prepare("SELECT model_ids FROM workbuddy_account_model_snapshots WHERE account_id = ?")
		.get(accountId) as { model_ids?: string } | undefined;
	if (row?.model_ids === undefined || row.model_ids.length === 0) {
		return false;
	}
	let ids: unknown;
	try {
		ids = JSON.parse(row.model_ids);
	} catch {
		return false;
	}
	if (!Array.isArray(ids)) {
		return false;
	}
	return ids.some((id) => id === model);
}

// 直接运行时才启动（被测试/其他模块 import 时不拉起服务）
const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(pathResolve(process.argv[1])).href;
if (invokedDirectly) {
	void main();
}
