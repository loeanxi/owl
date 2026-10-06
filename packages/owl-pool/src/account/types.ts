/**
 * 账号聚合根 —— 移植自 manager `account/Account`（实体）。
 * credentials 是按平台解释的灵活 JSON：
 * - WORKBUDDY：{"accessToken":"..."} 或 {"authFile":"C:/path/workbuddy-desktop.info"}
 * - TRAE：{"session":"<X-Cloudide-Session>","deviceId":"<16位数字，可选>"}
 * 对外 API 只回脱敏视图（后续阶段补 AccountResponse）。
 */
import type { Platform } from "../platform.ts";

/** 凭证健康状态（credential_status 列）。 */
export type CredentialStatus = "OK" | "WARN" | "EXPIRED" | "UNKNOWN" | "ERROR";

export interface Account {
	id: string;
	name: string;
	platform: Platform;
	/** 按平台解释的凭证对象（SQLite 里存 JSON 文本）。 */
	credentials: Record<string, unknown>;
	/** Trae 重新登录后递增，用于使旧会话失效。 */
	sessionGeneration?: number;
	/** Trae session 哈希，唯一约束防重复录入。 */
	traeSessionHash?: string | null;
	enabled: boolean;
	remark?: string | null;
	/** 最近一次签到（epoch 毫秒 + 状态/消息），补签判定依据。 */
	lastCheckInAt?: number | null;
	lastCheckInStatus?: string | null;
	lastCheckInMessage?: string | null;
	/** 积分快照（最近一次刷新）。 */
	credits?: number | null;
	creditsLabel?: string | null;
	creditsStatus?: string | null;
	creditsMessage?: string | null;
	creditsDetails?: string | null;
	creditsUpdatedAt?: number | null;
	/** 凭证健康。 */
	credentialExpiresAt?: number | null;
	credentialStatus?: CredentialStatus | null;
	credentialCheckedAt?: number | null;
	credentialMessage?: string | null;
	/** 上游故障冷却期（epoch 毫秒），网关选号时跳过。 */
	cooldownUntil?: number | null;
	createdAt: number;
	updatedAt: number;
}

/** 创建/更新账号的入参（REST AccountRequest 的领域形态）。 */
export interface AccountInput {
	name: string;
	platform: Platform;
	credentials: Record<string, unknown>;
	enabled?: boolean;
	remark?: string | null;
}

/**
 * 解析 credentials：容忍存量数据里存成 JSON 字符串的形态
 * （对齐 manager AccountService.parseCredentials）。
 */
export function parseCredentials(account: Pick<Account, "credentials">): Record<string, unknown> {
	// 容忍存量数据里 credentials 存成 JSON 字符串的形态（域类型虽是对象，DB 行可能不是）
	const raw: unknown = account.credentials;
	if (raw !== null && typeof raw === "object") {
		return raw as Record<string, unknown>;
	}
	if (typeof raw === "string" && raw.trim().length > 0) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object") {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// 落到下面的空对象
		}
	}
	return {};
}

export function asString(value: unknown): string | undefined {
	return value === null || value === undefined ? undefined : String(value);
}

export function asInt(value: unknown, fallback: number): number {
	if (value === null || value === undefined) {
		return fallback;
	}
	if (typeof value === "number") {
		return Math.trunc(value);
	}
	const parsed = Number.parseInt(String(value), 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}
