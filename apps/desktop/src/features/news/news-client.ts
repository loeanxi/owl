import type { NewsRequest, NewsResultByAction } from "../../../../../packages/coding-agent/src/core/news/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import { t } from "../../i18n/index.ts";

/** All news operations use the desktop connection; credentials never return to this client. */
export class NewsClient {
	private readonly bridge: BridgeClient;
	constructor(bridge: BridgeClient) {
		this.bridge = bridge;
	}
	query<A extends NewsRequest["action"]>(
		request: Extract<NewsRequest, { action: A }>,
	): Promise<NewsResultByAction[A]> {
		return new Promise<NewsResultByAction[A]>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(t("news.timeout"))),
				request.action === "evaluate" ? 600_000 : 180_000,
			);
			this.bridge.request<NewsResultByAction[A]>({ type: "news.request", request }).then(
				(response) => {
					clearTimeout(timer);
					if (!response.ok) {
						reject(new Error(response.error ?? t("common.operationFailed")));
						return;
					}
					if (response.result === undefined) {
						reject(new Error(t("news.invalidResponse")));
						return;
					}
					resolve(response.result as NewsResultByAction[A]);
				},
				(error: unknown) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
	openUrl(url: string): Promise<void> {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			return Promise.reject(new Error(t("news.invalidUrl")));
		}
		if (!/^https?:$/.test(target.protocol)) return Promise.reject(new Error(t("news.invalidUrl")));
		return this.bridge.request({ type: "open.external", action: "url", target: url }).then((response) => {
			if (!response.ok) throw new Error(response.error ?? t("common.operationFailed"));
		});
	}
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function downloadNews(content: string, filename: string, mime: string): void {
	const url = URL.createObjectURL(new Blob([content], { type: mime }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
