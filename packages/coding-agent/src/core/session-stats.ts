/**
 * Session statistics / context usage — extracted from AgentSession.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import {
	calculateContextTokens,
	estimateContextBreakdown,
	estimateProjectedContextTokens,
} from "./compaction/index.ts";
import type { ContextUsage, ContextUsageBreakdown } from "./extensions/index.ts";
import {
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionManager,
	type SessionProjection,
} from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

export interface SessionStatsSnapshot {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

export function computeSessionStats(options: {
	entries: readonly SessionEntry[];
	sessionFile: string | undefined;
	sessionId: string;
	contextUsage?: ContextUsage;
}): SessionStatsSnapshot {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	const usageTotals = createUsageTotals();

	for (const entry of options.entries) {
		if (entry.type === "usage") {
			addUsageToTotals(usageTotals, entry.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(usageTotals, entry.usage);
		}
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
			if (message.usage) {
				addUsageToTotals(usageTotals, message.usage);
			}
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistantMsg = message as AssistantMessage;
			if (Array.isArray(assistantMsg.content)) {
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
			}
			addUsageToTotals(usageTotals, assistantMsg.usage);
		}
	}

	return {
		sessionFile: options.sessionFile,
		sessionId: options.sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: usageTotals.input,
			output: usageTotals.output,
			cacheRead: usageTotals.cacheRead,
			cacheWrite: usageTotals.cacheWrite,
			total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
		},
		cost: usageTotals.cost,
		contextUsage: options.contextUsage,
	};
}

export function computeContextUsage(options: {
	model: Model<any> | undefined;
	projection: SessionProjection;
	branch: SessionEntry[];
}): ContextUsage | undefined {
	const model = options.model;
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	const { projection, branch } = options;
	const latestCompaction = getLatestCompactionEntry(branch);

	if (latestCompaction) {
		const projectedAssistants = new Set(
			projection.entries.flatMap((entry) =>
				entry.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.stopReason !== "aborted" &&
						message.stopReason !== "error" &&
						calculateContextTokens(message.usage) > 0,
				)
					? [entry.sourceEntry.id]
					: [],
			),
		);
		const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
		const hasPostCompactionUsage = branch
			.slice(compactionIndex + 1)
			.some((entry) => projectedAssistants.has(entry.id));
		if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
	}

	const estimate = estimateProjectedContextTokens(projection, branch);
	const percent = (estimate.tokens / contextWindow) * 100;

	const raw = estimateContextBreakdown(projection.messages as AgentMessage[]);
	const rawTotal = raw.systemPrompt + raw.toolDefinitions + raw.messages + raw.toolResults;
	const breakdown: ContextUsageBreakdown | undefined =
		rawTotal > 0 && estimate.tokens > 0
			? {
					systemPrompt: Math.round((raw.systemPrompt / rawTotal) * estimate.tokens),
					toolDefinitions: Math.round((raw.toolDefinitions / rawTotal) * estimate.tokens),
					messages: Math.round((raw.messages / rawTotal) * estimate.tokens),
					toolResults: Math.round((raw.toolResults / rawTotal) * estimate.tokens),
				}
			: undefined;

	return {
		tokens: estimate.tokens,
		contextWindow,
		percent,
		...(breakdown ? { breakdown } : {}),
	};
}

export function contextUsageFromSession(
	sessionManager: SessionManager,
	model: Model<any> | undefined,
): ContextUsage | undefined {
	return computeContextUsage({
		model,
		projection: sessionManager.buildSessionProjection(),
		branch: sessionManager.getBranch(),
	});
}
