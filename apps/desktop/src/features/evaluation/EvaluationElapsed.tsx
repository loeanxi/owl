import { useEffect, useRef, useState } from "react";
import type { EvaluationFollowupView, EvaluationResultView } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";

type TimedReply = EvaluationResultView | EvaluationFollowupView;

/** Interpolate the server's relative runtime with a monotonic clock between snapshots. */
export function EvaluationElapsed({ reply, t }: { reply: TimedReply; t: EvaluationText }): React.JSX.Element {
	const [, tick] = useState(0);
	const reported = reply.elapsedMs ?? (reply.status !== "running" && reply.status !== "queued" ? reply.durationMs : null);
	const elapsedMs = typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : null;
	const running = reply.status === "running" && elapsedMs !== null;
	const now = performance.now();
	const anchor = useRef({ id: reply.id, status: reply.status, reported: elapsedMs, elapsedMs, observedAt: now });
	if (anchor.current.id !== reply.id || anchor.current.status !== reply.status || anchor.current.reported !== elapsedMs) {
		const previous = anchor.current;
		const continued = running && previous.id === reply.id && previous.status === "running" && previous.elapsedMs !== null ? previous.elapsedMs + Math.max(0, now - previous.observedAt) : 0;
		anchor.current = { id: reply.id, status: reply.status, reported: elapsedMs, elapsedMs: running && elapsedMs !== null ? Math.max(elapsedMs, continued) : elapsedMs, observedAt: now };
	}
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => tick((value) => value + 1), 1000);
		return () => clearInterval(timer);
	}, [reply.id, running]);
	const currentMs = running && anchor.current.elapsedMs !== null ? anchor.current.elapsedMs + Math.max(0, now - anchor.current.observedAt) : elapsedMs;
	const seconds = Math.floor((currentMs ?? 0) / 1000);
	const hours = Math.floor(seconds / 3600);
	const time = `${hours > 0 ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
	const state = reply.status === "queued" ? "queued" : currentMs === null ? "unknown" : running ? "running" : "finished";
	const label = state === "queued" ? t("queued") : state === "unknown" ? t("elapsedUnknown") : t(running ? "elapsedRunning" : "elapsedFinished", { time });
	return <span className="eval-reply-elapsed" data-elapsed-state={state} data-elapsed-ms={currentMs === null ? undefined : Math.floor(currentMs)} title={t("elapsedHint")}>{label}</span>;
}
