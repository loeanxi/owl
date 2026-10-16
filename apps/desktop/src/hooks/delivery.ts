import type { ChatEntry, ToolCard } from "./transcript.ts";

export interface DeliveryCriterion {
	criterion: string;
	status: "pending" | "verified" | "blocked";
	evidence?: string;
	toolCallId?: string;
	/** A successful execution observed before this checklist was recorded, from the same user turn. */
	tool?: ToolCard;
}
export interface DeliveryChecklist { goal: string; criteria: DeliveryCriterion[] }

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only a successful task_check registration is a record; ordinary assistant prose is not. */
export function deliveryChecklist(entries: readonly ChatEntry[]): DeliveryChecklist | undefined {
	const observed = new Map<string, ToolCard>();
	let checklist: DeliveryChecklist | undefined;
	for (const entry of entries) {
		if (entry.kind === "user" && !entry.queued) { observed.clear(); checklist = undefined; }
		if (entry.kind !== "assistant") continue;
		for (const tool of entry.tools) {
			if (tool.status !== "ok" || !tool.output) continue;
			if (tool.name !== "task_check") { observed.set(tool.id, tool); continue; }
			let args: Record<string, unknown> | undefined;
			let result: Record<string, unknown> | undefined;
			try { args = recordOf(JSON.parse(tool.args)); } catch { continue; }
			if (args?.clear === true) { checklist = undefined; continue; }
			try { result = recordOf(JSON.parse(tool.output.text)); } catch { continue; }
			// Inspecting an old checklist does not register it for this turn.
			if (!Array.isArray(args?.criteria) || !result || typeof result.goal !== "string" || !result.goal.trim() || result.goal.length > 500 || !Array.isArray(result.criteria) || result.criteria.length > 20) continue;
			const criteria: DeliveryCriterion[] = [];
			for (const raw of result.criteria) {
				const item = recordOf(raw);
				if (!item || typeof item.criterion !== "string" || !item.criterion.trim() || item.criterion.length > 300 || !["pending", "verified", "blocked"].includes(String(item.status)) || (item.evidence !== undefined && typeof item.evidence !== "string") || (item.toolCallId !== undefined && typeof item.toolCallId !== "string")) continue;
				const toolCallId = typeof item.toolCallId === "string" ? item.toolCallId : undefined;
				criteria.push({ criterion: item.criterion, status: item.status as DeliveryCriterion["status"], ...(typeof item.evidence === "string" ? { evidence: item.evidence.slice(0, 1500) } : {}), ...(toolCallId ? { toolCallId, tool: observed.get(toolCallId) } : {}) });
			}
			if (criteria.length === result.criteria.length && criteria.length > 0) checklist = { goal: result.goal, criteria };
		}
	}
	return checklist;
}
