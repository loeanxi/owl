/**
 * Read-only session reporting: stats, context usage, JSONL export, transcript helpers.
 *
 * Extracted from AgentSession so the class keeps thin delegating methods instead of owning
 * query implementations. Everything here is a pure read over persisted session entries plus
 * the live message list — no mutation, no event emission, no abort handling.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import type { ContextUsage } from "./extensions/index.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import type { SessionManager } from "./session-manager.ts";
import { computeContextUsage, computeSessionStats, type SessionStatsSnapshot } from "./session-stats.ts";

/**
 * The read-only slice of AgentSession these queries need.
 * AgentSession structurally satisfies it; keeping the surface narrow keeps the reporting
 * helpers testable without constructing a full session.
 */
export interface SessionReportingSource {
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly sessionManager: SessionManager;
	readonly messages: readonly AgentMessage[];
	/** The model whose input limits govern the projected context. */
	limitsModel(): Model<any> | undefined;
}

/**
 * Session statistics. Aggregates over ALL session entries (including history that was
 * compacted away), so token/cost totals reflect what was actually billed.
 */
export function sessionStats(source: SessionReportingSource): SessionStatsSnapshot {
	return computeSessionStats({
		entries: source.sessionManager.getEntries(),
		sessionFile: source.sessionFile,
		sessionId: source.sessionId,
		contextUsage: sessionContextUsage(source),
	});
}

/** Token breakdown of the current context projection, when the model exposes limits. */
export function sessionContextUsage(source: SessionReportingSource): ContextUsage | undefined {
	return computeContextUsage({
		model: source.limitsModel(),
		projection: source.sessionManager.buildSessionProjection(),
		branch: source.sessionManager.getBranch(),
	});
}

/**
 * Export the current session branch to a JSONL file.
 * @returns The resolved output file path.
 */
export function exportSessionBranchToJsonl(source: SessionReportingSource, outputPath?: string): string {
	return exportSessionToJsonl(source.sessionManager, outputPath);
}

/**
 * Text content of the last assistant message.
 * Useful for /copy command.
 * @returns Text content, or undefined if no assistant message exists
 */
export function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((m) => {
			if (m.role !== "assistant") return false;
			const msg = m as AssistantMessage;
			// Skip aborted messages with no content
			if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
			return true;
		});

	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of (lastAssistant as AssistantMessage).content) {
		if (content.type === "text") {
			text += content.text;
		}
	}

	return text.trim() || undefined;
}
