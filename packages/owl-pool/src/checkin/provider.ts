/**
 * 平台签到 SPI —— 移植自 manager `checkin/CheckInProvider`。
 * 新增平台：实现本接口并注册进 CheckInService 即可，路由自动生效。
 */
import type { Account } from "../account/types.ts";
import type { Platform } from "../platform.ts";
import type { CheckInResult } from "./types.ts";

export interface CheckInProvider {
	supports(): Platform;
	/** 该账号是否具备本平台签到所需的额外凭证（默认具备）。 */
	isConfigured?(account: Account): boolean;
	checkIn(account: Account): Promise<CheckInResult>;
}
