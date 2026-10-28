export interface SessionRunTiming {
	runId?: string;
	startedAt: number;
}

export interface SessionRunTimingWire {
	runId?: unknown;
	startedAt?: unknown;
}

/** Bridge timestamps repair cached clocks; duplicate notifications retain the original start. */
export function resolveSessionRunTiming(
	current: SessionRunTiming | undefined,
	incoming: SessionRunTimingWire,
	fallbackStartedAt = 0,
): SessionRunTiming {
	const incomingRunId = typeof incoming.runId === "string" && incoming.runId.trim() ? incoming.runId : undefined;
	const changedRun = Boolean(incomingRunId && current?.runId && incomingRunId !== current.runId);
	const runId = incomingRunId ?? current?.runId;
	const startedAt =
		typeof incoming.startedAt === "number" && Number.isFinite(incoming.startedAt) && incoming.startedAt > 0
			? incoming.startedAt
			: !changedRun && current && Number.isFinite(current.startedAt) && current.startedAt > 0
				? current.startedAt
				: Number.isFinite(fallbackStartedAt) && fallbackStartedAt > 0
					? fallbackStartedAt
					: 0;
	return runId ? { runId, startedAt } : { startedAt };
}
