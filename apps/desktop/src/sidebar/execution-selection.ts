import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";

export interface ExecutionSelection {
	sessionId: string;
	mode: "tasks" | "tool";
	toolId?: string;
	ownerIndex?: number;
	/** Stored by the tab when first opened; account switches cannot expose prior output. */
	profile?: string;
}

export function parseExecutionSelection(path: string | undefined): ExecutionSelection | undefined {
	try {
		const raw: unknown = JSON.parse(path ?? "null");
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const item = raw as Record<string, unknown>;
		if (typeof item.sessionId !== "string" || !item.sessionId || (item.mode !== "tasks" && item.mode !== "tool"))
			return undefined;
		return {
			sessionId: item.sessionId,
			mode: item.mode,
			...(typeof item.toolId === "string" ? { toolId: item.toolId } : {}),
			...(typeof item.ownerIndex === "number" && Number.isSafeInteger(item.ownerIndex) && item.ownerIndex >= 0
				? { ownerIndex: item.ownerIndex }
				: {}),
			...(typeof item.profile === "string" ? { profile: item.profile } : {}),
		};
	} catch {
		return undefined;
	}
}

export function selectedExecutionTool(
	entries: readonly ChatEntry[],
	selection: ExecutionSelection,
): ToolCard | undefined {
	if (!selection.toolId) return undefined;
	if (selection.ownerIndex !== undefined) {
		const owner = entries[selection.ownerIndex];
		return owner?.kind === "assistant" ? owner.tools.find((tool) => tool.id === selection.toolId) : undefined;
	}
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.kind !== "assistant") continue;
		const tool = entry.tools.find((candidate) => candidate.id === selection.toolId);
		if (tool) return tool;
	}
	return undefined;
}
