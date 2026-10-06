/**
 * 签到结果与记录 —— 移植自 manager `checkin/CheckInStatus|CheckInResult|CheckInRecord`。
 * 状态语义与 Java 枚举名逐字一致（SUCCESS/ALREADY/INACTIVE/AUTH_ERROR/FAILED），
 * 数据库与前端零转换。
 */
import type { Account } from "../account/types.ts";
import type { Platform } from "../platform.ts";

export type CheckInStatus = "SUCCESS" | "ALREADY" | "INACTIVE" | "AUTH_ERROR" | "FAILED";

export interface CheckInResult {
	status: CheckInStatus;
	message: string | null;
	/** 本次签到获得的积分（拿不到为 null）。 */
	credits: number | null;
	/** 截断后的原始信息，便于排障（≤500 字符）。 */
	detail: string | null;
	occurredAt: number;
}

export function checkInSuccess(
	message: string | null,
	credits: number | null,
	nowMs: number = Date.now(),
): CheckInResult {
	return { status: "SUCCESS", message, credits, detail: null, occurredAt: nowMs };
}

export function checkInAlready(
	message: string | null,
	credits: number | null,
	nowMs: number = Date.now(),
): CheckInResult {
	return { status: "ALREADY", message, credits, detail: null, occurredAt: nowMs };
}

export function checkInInactive(message: string, nowMs: number = Date.now()): CheckInResult {
	return { status: "INACTIVE", message, credits: null, detail: null, occurredAt: nowMs };
}

export function checkInAuthError(message: string, nowMs: number = Date.now()): CheckInResult {
	return { status: "AUTH_ERROR", message, credits: null, detail: null, occurredAt: nowMs };
}

export function checkInFailed(message: string, detail: string | null, nowMs: number = Date.now()): CheckInResult {
	return { status: "FAILED", message, credits: null, detail: truncate(detail, 500), occurredAt: nowMs };
}

/** SUCCESS/ALREADY 都算「签到了」，补签与凭证健康都按它判定。 */
export function isCheckInOk(result: CheckInResult): boolean {
	return result.status === "SUCCESS" || result.status === "ALREADY";
}

function truncate(text: string | null, max: number): string | null {
	if (text === null) {
		return null;
	}
	return text.length <= max ? text : text.slice(0, max);
}

export interface CheckInRecord {
	id: string;
	accountId: string;
	accountName: string;
	platform: Platform;
	status: CheckInStatus;
	message: string | null;
	credits: number | null;
	detail: string | null;
	occurredAt: number;
}

export function checkInRecordOf(account: Account, result: CheckInResult, id: string): CheckInRecord {
	return {
		id,
		accountId: account.id,
		accountName: account.name,
		platform: account.platform,
		status: result.status,
		message: result.message,
		credits: result.credits,
		detail: result.detail,
		occurredAt: result.occurredAt,
	};
}
