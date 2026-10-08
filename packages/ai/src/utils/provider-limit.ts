/** Account/billing failures remain terminal even when a gateway wraps them in HTTP 429/5xx. */
const PROVIDER_LIMIT_ERROR_PATTERN = new RegExp(
	[
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
		"insufficient_quota",
		"out of budget",
		"quota exceeded",
		"billing(?!_state\\b)",
		"insufficient[_ -](?:balance|credit|funds|budget)",
		"(?:balance|credit|funds|budget)[_ -](?:insufficient|exhausted)",
		"余额不足",
		"余額不足",
		"额度不足",
		"額度不足",
		"积分不足",
		"積分不足",
		"subscription_sharing_usage_limit_exceeded",
	].join("|"),
	"i",
);

export function isProviderLimitError(errorMessage: string): boolean {
	if (gatewayUsageUnknownCode(errorMessage) !== undefined) return false;
	return PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage);
}

import { gatewayUsageUnknownCode } from "./gateway-usage-unknown.ts";
