import { t } from "../../i18n/index.ts";

export function mailErrorText(failure: unknown, fallback = t("mail.error")): string {
	const message = failure instanceof Error ? failure.message : typeof failure === "string" ? failure : fallback;
	return /^(bridge not connected|bridge disconnected)$/i.test(message) ? t("mail.offline") : message;
}
