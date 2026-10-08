export type AgentRunOutcome = "done" | "aborted" | "error";

/** The run boundary can be aborted after its last assistant message already completed. */
export function settledRunStatus(
	event: { aborted?: unknown },
	previous?: AgentRunOutcome,
): { outcome: AgentRunOutcome; notifyDone: boolean } {
	const outcome = previous === "error" ? "error" : event.aborted === true ? "aborted" : previous ?? "done";
	return { outcome, notifyDone: outcome === "done" };
}
