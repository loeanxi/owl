/**
 * 服务配置 —— env 驱动，全部有默认值。
 * 对齐 manager 的 env 覆盖习惯，但换成 OWL_POOL_ 前缀；
 * 默认只绑回环（manager 安全基线），端口 8790 避开 Java 版 8787。
 */
import { isPlatform, type Platform } from "owl-pool";

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
	return {
		host: env.OWL_POOL_HOST ?? "127.0.0.1",
		port: intOr(env.OWL_POOL_PORT, 8790),
		dbPath: env.OWL_POOL_DB ?? "data/pool.db",
		workbuddyBaseUrl: blankToUndefined(env.OWL_POOL_WORKBUDDY_BASE_URL),
		workbuddyAuthFileRoots: (env.OWL_POOL_WORKBUDDY_AUTH_FILE_ROOTS ?? "")
			.split(/[,;]+/)
			.map((part) => part.trim())
			.filter((part) => part.length > 0),
		traeBaseUrl: blankToUndefined(env.OWL_POOL_TRAE_BASE_URL),
		checkInHour: intOr(env.OWL_POOL_CHECKIN_HOUR, 0),
		checkInMinute: intOr(env.OWL_POOL_CHECKIN_MINUTE, 5),
		checkInStaggerMs: intOr(env.OWL_POOL_CHECKIN_STAGGER_MS, 3000),
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

function blankToUndefined(raw: string | undefined): string | undefined {
	return raw === undefined || raw.trim().length === 0 ? undefined : raw;
}
