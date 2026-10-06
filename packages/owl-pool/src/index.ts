/**
 * owl-pool 公共出口 —— 领域核心（零运行时依赖）。
 * 服务壳 apps/pool-server 与桌面端都从这里取领域 API。
 */

export { type AccountStore, InMemoryAccountStore } from "./account/store.ts";
export {
	type Account,
	type AccountInput,
	asInt,
	asString,
	type CredentialStatus,
	parseCredentials,
} from "./account/types.ts";
export type { CheckInProvider } from "./checkin/provider.ts";
export { randomDeviceId, TraeCheckInProvider, type TraeProviderOptions } from "./checkin/providers/trae.ts";
export {
	readAccessTokenFromFile,
	WorkBuddyCheckInProvider,
	type WorkBuddyProviderOptions,
} from "./checkin/providers/workbuddy.ts";
export { type CheckInRecordStore, InMemoryCheckInRecordStore } from "./checkin/record-store.ts";
export {
	type AccountCheckInOutcome,
	type BatchCheckInOutcome,
	CheckInService,
	type CheckInServiceOptions,
	type CredentialHealthHooks,
	signedToday,
} from "./checkin/service.ts";

export {
	type CheckInRecord,
	type CheckInResult,
	type CheckInStatus,
	checkInAlready,
	checkInAuthError,
	checkInFailed,
	checkInInactive,
	checkInRecordOf,
	checkInSuccess,
	isCheckInOk,
} from "./checkin/types.ts";
export { type ApiResponse, apiErr, apiOk } from "./common/api-response.ts";
export {
	BUSINESS_ZONE,
	businessDayRange,
	businessDayString,
	type DateRange,
	msUntilBusinessTime,
	randomInt,
	sleep,
	todayRange,
} from "./common/business-time.ts";
export { BusinessError } from "./common/error.ts";
export { describeUpstreamError, UpstreamHttpError } from "./common/upstream.ts";
export { isPlatform, PLATFORMS, type Platform, usesSdkBridge } from "./platform.ts";
