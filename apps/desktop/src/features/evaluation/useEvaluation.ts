import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EvaluationBootstrap, EvaluationRunView } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import { EvaluationClient } from "./evaluation-client.ts";
import { evaluationHasLiveWork } from "./evaluation-conversation.ts";

export function useEvaluation(client: BridgeClient, active: boolean) {
	const api = useMemo(() => new EvaluationClient(client), [client]);
	const [snapshot, setSnapshot] = useState<EvaluationBootstrap>();
	const [run, setRun] = useState<EvaluationRunView>();
	const [runId, setRunId] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [connected, setConnected] = useState(true);
	const [revision, setRevision] = useState(0);
	const runRequest = useRef(0);
	const selectedRun = useRef<string | undefined>(undefined);
	const polling = useRef(false);
	const actionPending = useRef(false);
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const refresh = useCallback(() => setRevision((value) => value + 1), []);
	useEffect(() => client.onStatus((up) => { setConnected(up); if (up) refresh(); }), [client, refresh]);
	useEffect(() => {
		if (!active) return;
		let current = true;
		setLoading(!snapshot);
		void api.query({ action: "bootstrap" }).then((value) => {
			if (current) { setSnapshot(value); setError(""); setConnected(true); }
		}, (cause: unknown) => {
			if (current) {
				const message = cause instanceof Error ? cause.message : String(cause);
				setError(message);
				if (/bridge (not connected|disconnected)/i.test(message)) setConnected(false);
			}
		}).finally(() => { if (current) setLoading(false); });
		return () => { current = false; };
	}, [api, active, revision]);
	useEffect(() => {
		if (!active || !runId || !connected) return;
		let current = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			if (!current) return;
			if (polling.current) { timer = setTimeout(() => { void poll(); }, 500); return; }
			polling.current = true;
			const serial = ++runRequest.current;
			try {
				const value = await api.query({ action: "run.get", runId });
				if (!current || serial !== runRequest.current) return;
				setRun(value);
				if (evaluationHasLiveWork(value)) timer = setTimeout(() => { void poll(); }, 500);
				else {
					const runs = await api.query({ action: "run.list" });
					if (current) setSnapshot((previous) => previous ? { ...previous, runs } : previous);
				}
			} catch (cause) {
				if (!current || serial !== runRequest.current) return;
				setError(cause instanceof Error ? cause.message : String(cause));
				timer = setTimeout(() => { void poll(); }, 5000);
			} finally {
				polling.current = false;
			}
		};
		void poll();
		return () => { current = false; if (timer) clearTimeout(timer); };
	}, [active, api, connected, runId, revision, refresh]);
	const applyRun = useCallback((value: EvaluationRunView) => {
		++runRequest.current;
		selectedRun.current = value.id;
		setRun(value);
		setRunId(value.id);
		refresh();
	}, [refresh]);
	const applyCurrentRun = useCallback((value: EvaluationRunView) => {
		if (selectedRun.current !== value.id) return;
		++runRequest.current;
		setRun(value);
		refresh();
	}, [refresh]);
	const selectRun = useCallback((id: string) => { selectedRun.current = id; ++runRequest.current; setRunId(id); }, []);
	const perform = useCallback(async (operation: () => Promise<void>) => {
		if (actionPending.current) return;
		actionPending.current = true;
		setBusy(true);
		setError("");
		try { await operation(); }
		catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { actionPending.current = false; if (mounted.current) setBusy(false); }
	}, []);
	return { api, snapshot, run, runId, loading, busy, error, connected, refresh, perform, applyRun, applyCurrentRun, setError, selectRun };
}
