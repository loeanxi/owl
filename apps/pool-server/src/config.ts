/**
 * 服务配置 —— env 驱动，全部有默认值。
 * 对齐 manager 的 env 覆盖习惯，但换成 OWL_POOL_ 前缀；
 * 默认只绑回环（manager 安全基线），端口 8790 避开 Java 版 8787。
 */
import { dirname, join } from "node:path";
import { isPlatform, type Platform } from "owl-pool";
import type { AdminSecurityConfig } from "./security/admin-service.ts";

export interface PoolConfig {
	host: string;
	port: number;
	/** SQLite 数据库文件路径。 */
	dbPath: string;
	/** WorkBuddy 上游基址。 */
	workbuddyBaseUrl?: string;
	/** WorkBuddy authFile 读取白名单目录（逗号/分号分隔）。 */
	workbuddyAuthFileRoots: string[];
	/** Trae 上游基址。 */
	traeBaseUrl?: string;
	/** 每日签到时刻（业务日 Asia/Shanghai）。 */
	checkInHour: number;
	checkInMinute: number;
	/** 账号间签到间隔毫秒。 */
	checkInStaggerMs: number;
	/** 管理端鉴权域（对齐 manager `manager.admin.*` + `manager.security.trusted-proxy-count`）。 */
	admin: AdminSecurityConfig;
	/** 可信反代层数；0 = 完全不信转发头。 */
	trustedProxyCount: number;
	/** 网关域（对齐 manager `manager.gateway.*`）。 */
	gateway: {
		enabled: boolean;
		globalRateLimitPerMinute: number;
		ipRateLimitPerMinute: number;
		ipWhitelist: string | null;
		maxRotate: number;
		accountCooldownMs: number;
		upstreamTimeoutMs: number;
		stickyEnabled: boolean;
		stickyTtlSeconds: number;
		grokBaseUrl?: string;
		zcode: { anthropicVersion: string; defaultMaxTokens: number };
		workbuddy: { baseUrl: string; chatPath: string; userAgent: string; origin: string; referer: string };
		trae: { chatBaseUrl: string; chatPath: string; appId: string; ideVersion: string; ideVersionCode: string };
		gemini: { baseUrl: string; apiVersion: string; defaultMaxTokens: number };
		mimo: { executable: string; hostname: string; requestTimeoutMs: number; readyTimeoutMs: number };
		bridge: {
			nodeExecutable: string;
			script: string;
			homeRoot: string;
			requestTimeoutMs: number;
			idleRecycleMs: number;
			userHome: string;
		};
		claude: {
			baseUrl: string;
			defaultMaxTokens: number;
			anthropicVersion: string;
			oauthBetaHeaders: string;
			cliVersion: string;
			thinkingBudgets: { low: number; medium: number; high: number };
		};
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
	const dbPath = env.OWL_POOL_DB ?? "data/pool.db";
	const dataDir = dirname(dbPath);
	return {
		host: env.OWL_POOL_HOST ?? "127.0.0.1",
		port: intOr(env.OWL_POOL_PORT, 8790),
		dbPath,
		workbuddyBaseUrl: blankToUndefined(env.OWL_POOL_WORKBUDDY_BASE_URL),
		workbuddyAuthFileRoots: (env.OWL_POOL_WORKBUDDY_AUTH_FILE_ROOTS ?? "")
			.split(/[,;]+/)
			.map((part) => part.trim())
			.filter((part) => part.length > 0),
		traeBaseUrl: blankToUndefined(env.OWL_POOL_TRAE_BASE_URL),
		checkInHour: intOr(env.OWL_POOL_CHECKIN_HOUR, 0),
		checkInMinute: intOr(env.OWL_POOL_CHECKIN_MINUTE, 5),
		checkInStaggerMs: intOr(env.OWL_POOL_CHECKIN_STAGGER_MS, 3000),
		trustedProxyCount: intOr(env.OWL_POOL_TRUSTED_PROXY_COUNT, 0),
		gateway: {
			enabled: boolOr(env.OWL_POOL_GATEWAY_ENABLED, true),
			globalRateLimitPerMinute: intOr(env.OWL_POOL_GATEWAY_GLOBAL_RATE, 600),
			ipRateLimitPerMinute: intOr(env.OWL_POOL_GATEWAY_IP_RATE, 300),
			ipWhitelist: blankToUndefined(env.OWL_POOL_GATEWAY_IP_WHITELIST) ?? null,
			maxRotate: intOr(env.OWL_POOL_GATEWAY_MAX_ROTATE, 3),
			accountCooldownMs: intOr(env.OWL_POOL_GATEWAY_COOLDOWN_MS, 60_000),
			upstreamTimeoutMs: intOr(env.OWL_POOL_GATEWAY_UPSTREAM_TIMEOUT_MS, 120_000),
			stickyEnabled: boolOr(env.OWL_POOL_GATEWAY_STICKY_ENABLED, true),
			stickyTtlSeconds: intOr(env.OWL_POOL_GATEWAY_STICKY_TTL, 3600),
			grokBaseUrl: blankToUndefined(env.OWL_POOL_GROK_BASE_URL),
			workbuddy: {
				baseUrl: env.OWL_POOL_WB_CHAT_BASE_URL ?? "https://copilot.tencent.com",
				chatPath: env.OWL_POOL_WB_CHAT_PATH ?? "/v2/chat/completions",
				userAgent: env.OWL_POOL_WB_USER_AGENT ?? "CLI/2.63.2 CodeBuddy/2.63.2",
				origin: env.OWL_POOL_WB_ORIGIN ?? "https://www.codebuddy.cn",
				referer: env.OWL_POOL_WB_REFERER ?? "https://www.codebuddy.cn/",
			},
			mimo: {
				executable: env.OWL_POOL_MIMO_EXECUTABLE ?? "mimo",
				hostname: env.OWL_POOL_MIMO_HOSTNAME ?? "127.0.0.1",
				requestTimeoutMs: intOr(env.OWL_POOL_MIMO_REQUEST_TIMEOUT_MS, 120_000),
				readyTimeoutMs: intOr(env.OWL_POOL_MIMO_READY_TIMEOUT_MS, 25_000),
			},
			bridge: {
				nodeExecutable: env.OWL_POOL_BRIDGE_NODE ?? "node",
				script: env.OWL_POOL_BRIDGE_SCRIPT ?? "bridge/src/main.mjs",
				homeRoot: env.OWL_POOL_BRIDGE_HOME_ROOT ?? "data/bridge-accounts",
				requestTimeoutMs: intOr(env.OWL_POOL_BRIDGE_REQUEST_TIMEOUT_MS, 600_000),
				idleRecycleMs: intOr(env.OWL_POOL_BRIDGE_IDLE_RECYCLE_MS, 600_000),
				userHome: env.OWL_POOL_BRIDGE_USER_HOME ?? env.USERPROFILE ?? env.HOME ?? "",
			},
			gemini: {
				baseUrl: env.OWL_POOL_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com",
				apiVersion: env.OWL_POOL_GEMINI_API_VERSION ?? "v1beta",
				defaultMaxTokens: intOr(env.OWL_POOL_GEMINI_DEFAULT_MAX_TOKENS, 8192),
			},
			trae: {
				chatBaseUrl: env.OWL_POOL_TRAE_CHAT_BASE_URL ?? "https://trae-api-cn.mchost.guru",
				chatPath: env.OWL_POOL_TRAE_CHAT_PATH ?? "/api/agent/v3/llm_utils_chat",
				appId: env.OWL_POOL_TRAE_APP_ID ?? "icube-ai",
				ideVersion: env.OWL_POOL_TRAE_IDE_VERSION ?? "2.63.2",
				ideVersionCode: env.OWL_POOL_TRAE_IDE_VERSION_CODE ?? "2630200",
			},
			zcode: {
				anthropicVersion: env.OWL_POOL_ZCODE_ANTHROPIC_VERSION ?? "2023-06-01",
				defaultMaxTokens: intOr(env.OWL_POOL_ZCODE_DEFAULT_MAX_TOKENS, 8192),
			},
			claude: {
				baseUrl: env.OWL_POOL_CLAUDE_BASE_URL ?? "https://api.anthropic.com",
				defaultMaxTokens: intOr(env.OWL_POOL_CLAUDE_DEFAULT_MAX_TOKENS, 8192),
				anthropicVersion: env.OWL_POOL_CLAUDE_ANTHROPIC_VERSION ?? "2023-06-01",
				oauthBetaHeaders:
					env.OWL_POOL_CLAUDE_OAUTH_BETA_HEADERS ??
					"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
				cliVersion: env.OWL_POOL_CLAUDE_CLI_VERSION ?? "2.1.258",
				thinkingBudgets: {
					low: intOr(env.OWL_POOL_CLAUDE_THINKING_BUDGET_LOW, 4096),
					medium: intOr(env.OWL_POOL_CLAUDE_THINKING_BUDGET_MEDIUM, 16384),
					high: intOr(env.OWL_POOL_CLAUDE_THINKING_BUDGET_HIGH, 24576),
				},
			},
		},
		admin: {
			enabled: boolOr(env.OWL_POOL_ADMIN_ENABLED, true),
			username: env.OWL_POOL_ADMIN_USERNAME ?? "admin",
			password: env.OWL_POOL_ADMIN_PASSWORD ?? "",
			setupToken: env.OWL_POOL_ADMIN_SETUP_TOKEN ?? "",
			apiKey: env.OWL_POOL_ADMIN_API_KEY ?? "",
			// 与 manager 的 cookie 名（loean_admin）刻意不同：客户端是全新的 owl 桌面端
			cookieName: env.OWL_POOL_ADMIN_COOKIE ?? "owl_pool_admin",
			sessionTtlHours: intOr(env.OWL_POOL_ADMIN_SESSION_TTL_HOURS, 12),
			requireHttps: boolOr(env.OWL_POOL_ADMIN_REQUIRE_HTTPS, false),
			maxLoginFailures: intOr(env.OWL_POOL_ADMIN_MAX_LOGIN_FAILURES, 10),
			lockoutMinutes: intOr(env.OWL_POOL_ADMIN_LOCKOUT_MINUTES, 10),
			failureStoreFile: boolOr(env.OWL_POOL_ADMIN_PERSIST, true) ? join(dataDir, "admin-login-failures.json") : null,
			sessionStoreFile: boolOr(env.OWL_POOL_ADMIN_PERSIST, true) ? join(dataDir, "admin-sessions.json") : null,
		},
	};
}

/** 平台白名单过滤（账号接口的 ?platform= 参数）。 */
export function platformQuery(value: string | undefined): Platform | undefined {
	if (value === undefined || value.length === 0) {
		return undefined;
	}
	if (!isPlatform(value)) {
		return undefined;
	}
	return value;
}

function intOr(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim().length === 0) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function boolOr(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined || raw.trim().length === 0) {
		return fallback;
	}
	return raw === "1" || raw.toLowerCase() === "true";
}

function blankToUndefined(raw: string | undefined): string | undefined {
	return raw === undefined || raw.trim().length === 0 ? undefined : raw;
}
