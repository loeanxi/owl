/** Session-owned execution controls. These requests never abort the parent agent. */
export interface DesktopProcessSummary {
	id: number;
	sessionId: string;
	command: string;
	cwd: string;
	startedAt: number;
	status: "running" | "completed" | "failed" | "stopped";
	exitCode?: number | null;
}

export interface DesktopProcessDetail extends DesktopProcessSummary {
	output: string;
	omittedBytes: number;
	totalBytes: number;
}

export type DesktopExecutionRequest =
	| { type: "process.list"; id: string; sessionId: string }
	| { type: "process.get" | "process.kill"; id: string; sessionId: string; processId: number }
	| { type: "subagent.interrupt"; id: string; sessionId: string; runId: string };
