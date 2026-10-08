import { isProviderLimitError } from "../../../../packages/ai/src/utils/provider-limit.ts";
import { getUiLanguage, t } from "../i18n/index.ts";

const LIMIT_COPY = {
	zh: {
		account: "账户额度或计费校验未通过：",
		balance:
			"单次请求的预估费用可能包含输出额度预留。可降低设置中的单次回复输出预算，并核对当前密钥的可用额度及未结算请求。",
		quota: "请核对当前密钥的账户额度、套餐限制或计费状态。",
	},
	en: {
		account: "Account quota or billing check failed: ",
		balance:
			"The request estimate may include reserved output tokens. Lower the per-reply output budget in settings and check this key's available balance and pending requests.",
		quota: "Check this key's account quota, plan limits or billing status.",
	},
};

/** Preserve the gateway's detail, but classify billing failures before HTTP status. */
export function formatProviderError(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const match = raw.match(/^\s*(\d{3})(?:\s*[:-]\s*|\s+)([\s\S]*)$/);
	const status = match?.[1];
	const detail = match?.[2] ?? raw;
	let message = detail;
	try {
		const body: unknown = JSON.parse(detail);
		if (body && typeof body === "object") {
			const record = body as Record<string, unknown>;
			const error =
				record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;
			const candidate =
				record.message ??
				error?.message ??
				(typeof record.error === "string" ? record.error : undefined) ??
				error?.code ??
				error?.type ??
				record.code ??
				record.type;
			if (typeof candidate === "string" && candidate) message = candidate;
		}
	} catch {
		// Plain-text and malformed JSON errors retain the original provider detail.
	}
	if (isProviderLimitError(raw)) {
		const copy = LIMIT_COPY[getUiLanguage()];
		const balanceFailure =
			/余额|余額|积分|積分|insufficient[ _-](?:balance|credit|funds|budget)|(?:balance|credit|funds|budget)[ _-](?:insufficient|exhausted)/i.test(
				raw,
			);
		return `${copy.account}${message}\n${balanceFailure ? copy.balance : copy.quota}`;
	}
	if (status === "429") return t("err.rateLimited", { message: message || t("err.rateLimitedFallback") });
	if (status === "401" || status === "403") return t("err.keyInvalid", { message: message || raw });
	if (status?.startsWith("5")) return t("err.serverUnavailable", { status, message: message || t("err.retryLater") });
	if (status && message) return t("err.httpStatus", { message, status });
	return message;
}
