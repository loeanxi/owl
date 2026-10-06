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
export {
	applyEffortPolicy,
	type EffortApplied,
	type EffortMapping,
	type EffortPolicySpec,
	OVER_LIMIT_DENY,
	OVER_LIMIT_DOWNGRADE,
	type ParsedEffortPolicy,
	parseEffortPolicy,
	passthrough,
	serializeEffortPolicy,
	TO_DENY,
	validateEffortPolicy,
} from "./apikey/effort-policy.ts";
export {
	DENY_ALL,
	intersectIps,
	ipAllowed,
	isIpSubset,
	unrestricted,
	validateIpRules,
} from "./apikey/key-ip-policy.ts";
// ── API Key 域（阶段 3）──
export {
	convergeEffort,
	EFFORT_ORDER,
	effortRank,
	isKnownEffort,
	type KnownEffort,
	nearestEffort,
	normalizeEffort,
} from "./apikey/reasoning-effort-scale.ts";
export {
	ApiKeyService,
	type ApiKeyServiceOptions,
	type ApiKeyStore,
	type CreatedKey,
	keyBoundPlatform,
} from "./apikey/service.ts";
export {
	type ApiKey,
	type ApiKeyInput,
	boundPlatformOf,
	isActive,
	normalizeAllowedIps,
	normalizeAllowedModels,
	resolveEffectiveKey,
} from "./apikey/types.ts";
export {
	type CapabilityRequest,
	type CatalogData,
	isPlaceholder,
	ModelAccessException,
	modelAllowed,
	parseCapabilityRequest,
	type ResolvedModel,
	type ResolvedRouteTarget,
	resolveModel,
} from "./catalog/resolve.ts";
// ── 模型目录域（阶段 3）──
export type { DiscoveredCapacity, ModelRoute, PublishedModel } from "./catalog/types.ts";
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
// ── 网关域（阶段 3）──
export { sha256Hex } from "./gateway/crypto-lite.ts";
export {
	type GenerationAttempt,
	type GenerationRequest,
	RouteGeneration,
	type RouteGenerationDeps,
} from "./gateway/execution.ts";
export { stripModelPrefix } from "./gateway/model-router.ts";
export {
	AccountPoolRouter,
	cooldownMillis,
	hasPersistedCooldown,
	isNetworkBlip,
	pickByCreditWeight,
	pickHealthyByCreditWeight,
} from "./gateway/pool-router.ts";
export { FixedWindowRateLimiter, MemoryGatewayState } from "./gateway/rate-limit.ts";
export {
	type StickyBinding,
	type StickySessionOptions,
	StickySessionService,
	type StickyStateStore,
	stickySessionId,
	stripStickyFields,
} from "./gateway/sticky-sessions.ts";
export {
	DEFAULT_OUTPUT,
	estimateMaxOutputTokens,
	estimatePromptTokens,
	estimateTextPromptTokens,
	MAX_RESERVE_OUTPUT,
} from "./gateway/token-estimator.ts";
export {
	GatewayFault,
	isDirectChatPlatform,
	type UpstreamChatClient,
	type UpstreamErrorKind,
	UpstreamException,
} from "./gateway/upstream.ts";
export { isPlatform, PLATFORMS, type Platform, usesSdkBridge } from "./platform.ts";
// ── 协议域（阶段 4A）──
export {
	anthropicErrorBody,
	anthropicToOpenAiPayload,
	estimateAnthropicInputTokens,
	openAiToAnthropicMessage,
} from "./protocol/anthropic-protocol.ts";
export { AnthropicStreamBridge } from "./protocol/anthropic-stream-bridge.ts";
export {
	AnthropicStreamDecoder,
	AnthropicUpstreamMapper,
	type AnthropicUpstreamMapperOptions,
	classifyUpstreamError,
} from "./protocol/anthropic-upstream.ts";
export {
	IncompleteUpstreamStreamException,
	OpenAiStreamCompletion,
	type SseEvent,
	SseEventReader,
	UpstreamStreamError,
	UpstreamToolCallAggregator,
} from "./protocol/openai-stream.ts";
