import type { ExtensionRunner } from "../../core/extensions/runner.ts";
import { type DesktopSubagentSource, listDesktopSubagents } from "./subagents.ts";

/** Interrupt the verified parent-owned delegation through its existing extension control. */
export async function interruptDesktopSubagent(
	source: DesktopSubagentSource,
	runId: string,
	runner: Pick<ExtensionRunner, "getToolDefinition" | "createToolContext">,
	requestId: string,
): Promise<{ message: string }> {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) throw new Error("Invalid delegation identifier");
	const children = (await listDesktopSubagents(source)).filter((run) => run.runId === runId);
	if (children.length === 0) throw new Error("Delegation not found in this parent session");
	if (!children.some((run) => run.status === "running" || run.status === "unknown"))
		throw new Error("Delegation is no longer running");
	const tool = runner.getToolDefinition("subagent");
	if (!tool) throw new Error("This session has no subagent control extension");
	const callId = `desktop-interrupt:${requestId}`;
	const result = await tool.execute(
		callId,
		{ action: "interrupt", id: runId },
		undefined,
		undefined,
		runner.createToolContext(callId, undefined),
	);
	const message = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	if (result.isError) throw new Error(message || "Delegation does not support interruption");
	return { message };
}
