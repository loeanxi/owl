import {
	getSessionProcess,
	killSessionProcess,
	listSessionProcesses,
	type ProcessEntry,
	waitSessionProcess,
} from "../../core/tools/process-store.ts";
import type { DesktopProcessDetail, DesktopProcessSummary } from "./execution-types.ts";

function describe(entry: ProcessEntry): DesktopProcessSummary {
	return {
		id: entry.id,
		sessionId: entry.sessionId,
		command: entry.command,
		cwd: entry.cwd,
		startedAt: entry.startedAt,
		status:
			entry.exitCode === undefined
				? "running"
				: entry.killed
					? "stopped"
					: entry.exitCode === 0
						? "completed"
						: "failed",
		...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
	};
}

/** Only commands that actually yielded a process ID are background tasks. */
export function listDesktopProcesses(sessionId: string): DesktopProcessSummary[] {
	if (!sessionId) throw new Error("Missing owner session");
	return listSessionProcesses(sessionId)
		.filter((entry) => entry.backgrounded)
		.map(describe);
}

/** The UI observes recent output without consuming the model's pending buffer. */
export function getDesktopProcess(sessionId: string, processId: number): DesktopProcessDetail {
	if (!sessionId || !Number.isSafeInteger(processId) || processId < 1) throw new Error("Invalid process identifier");
	const entry = getSessionProcess(processId, sessionId);
	if (!entry?.backgrounded) throw new Error("Background process not found in this session");
	const snapshot = entry.recent.snapshot();
	return {
		...describe(entry),
		output: snapshot.content,
		omittedBytes: snapshot.omittedBytes,
		totalBytes: snapshot.totalBytes,
	};
}

export async function killDesktopProcess(sessionId: string, processId: number): Promise<DesktopProcessDetail> {
	getDesktopProcess(sessionId, processId);
	const entry = getSessionProcess(processId, sessionId)!;
	killSessionProcess(entry);
	await waitSessionProcess(entry, 3000);
	return getDesktopProcess(sessionId, processId);
}
