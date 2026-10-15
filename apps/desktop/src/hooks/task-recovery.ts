import type { BridgeClient } from "../bridge/client.ts";
import type { SessionStatsResult } from "../bridge/protocol.ts";
import { t } from "../i18n/index.ts";
import type { ChatEntry, RetryBannerState } from "./transcript.ts";

export type TaskRecovery = {
	id: string;
	reason: string;
	completedTools: number;
	uncertainTools: number;
};

/** Only the latest failed response can offer recovery; old errors and user stops cannot. */
export function taskRecovery(entries: readonly ChatEntry[], retryStatus?: RetryBannerState | null): TaskRecovery | undefined {
	const latest = entries.findLastIndex((entry) => entry.kind === "assistant" || entry.kind === "user");
	const entry = entries[latest];
	if (entry?.kind !== "assistant" || entry.aborted) return undefined;
	const reason = entry.error || (retryStatus?.phase === "failed" ? retryStatus.reason : undefined);
	if (!reason) return undefined;
	let completedTools = 0;
	let uncertainTools = 0;
	for (let index = latest; index >= 0; index--) {
		const row = entries[index]!;
		if (row.kind === "user" && !row.queued) break;
		if (row.kind !== "assistant") continue;
		for (const tool of row.tools) {
			if (tool.output && (tool.status === "ok" || tool.status === "error")) completedTools++;
			else uncertainTools++;
		}
	}
	return { id: `${entry.entryId ?? entry.timestamp ?? latest}:${reason}`, reason, completedTools, uncertainTools };
}

/** Switch only on an explicit user choice, then continue the same history without rewinding. */
export async function continueTask(client: Pick<BridgeClient, "request">, sessionId: string, model?: string): Promise<SessionStatsResult | undefined> {
	let stats: SessionStatsResult | undefined;
	if (model) {
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) throw new Error(t("recovery.invalidModel"));
		const changed = await client.request<SessionStatsResult>({ type: "session.setModel", sessionId, provider: model.slice(0, slash), model: model.slice(slash + 1) });
		if (!changed.ok) throw new Error(changed.error ?? t("recovery.modelFailed"));
		stats = changed.result;
	}
	const response = await client.request({ type: "session.continue", sessionId, message: t("app.resumePrompt") });
	if (!response.ok) throw new Error(response.error ?? t("app.resumeFailed"));
	return stats;
}
