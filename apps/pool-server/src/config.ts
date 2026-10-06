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
