import { useCallback, useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { DesktopSubagentSummary } from "../bridge/protocol.ts";

/** Observe the parent's runs without mounting or resuming the child sessions. */
export function useSubagents(client: BridgeClient, connected: boolean, sessionId: string | undefined, active: boolean): {
	runs: DesktopSubagentSummary[]; loading: boolean; error?: string; refresh: () => void;
} {
	const [reading, setReading] = useState<{ sessionId?: string; runs: DesktopSubagentSummary[]; loading: boolean; error?: string }>({ runs: [], loading: false });
	const [revision, setRevision] = useState(0);
	const refresh = useCallback(() => setRevision((value) => value + 1), []);
	useEffect(() => {
		if (!sessionId || !connected || !active) return;
		let disposed = false;
		let inFlight = false;
		let timer: ReturnType<typeof setTimeout>;
		const load = async (): Promise<void> => {
			if (disposed || inFlight) return;
			inFlight = true;
			setReading((current) => current.sessionId === sessionId ? current : { sessionId, runs: [], loading: true });
			try {
				const response = await client.request<DesktopSubagentSummary[]>({ type: "subagent.list", sessionId });
				if (disposed) return;
				if (!response.ok) throw new Error(response.error ?? "subagent.list failed");
				const runs = response.result ?? [];
				setReading((current) => current.sessionId === sessionId && !current.loading && !current.error && JSON.stringify(current.runs) === JSON.stringify(runs) ? current : { sessionId, runs, loading: false });
			} catch (error) {
				if (!disposed) setReading((current) => ({ sessionId, runs: current.sessionId === sessionId ? current.runs : [], loading: false, error: error instanceof Error ? error.message : String(error) }));
			} finally {
				inFlight = false;
				if (!disposed) timer = setTimeout(() => void load(), 2000);
			}
		};
		void load();
		return () => { disposed = true; clearTimeout(timer); };
	}, [client, connected, sessionId, active, revision]);
	return { runs: reading.sessionId === sessionId ? reading.runs : [], loading: Boolean(connected && active && sessionId && (reading.sessionId !== sessionId || reading.loading)), error: reading.sessionId === sessionId ? reading.error : undefined, refresh };
}
