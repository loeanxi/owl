import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EvaluationBootstrap, EvaluationRunSummary, EvaluationRunView, EvaluationTask, EvaluationViewFocus } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import { EvaluationClient } from "./evaluation-client.ts";
import { evaluationHasLiveWork } from "./evaluation-conversation.ts";

/** `focus` limits polled answer content to the task sample on screen; other groups carry statuses and scores only. */
export function useEvaluation(client: BridgeClient, active: boolean, focus: EvaluationViewFocus) {
	const api = useMemo(() => new EvaluationClient(client), [client]);
	const [snapshot, setSnapshot] = useState<EvaluationBootstrap>();
	const [run, setRun] = useState<EvaluationRunView>();
	const [runId, setRunId] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [connected, setConnected] = useState(true);
	const [revision, setRevision] = useState(0);
	const [pollRevision, setPollRevision] = useState(0);
	const runRequest = useRef(0);
	const selectedRun = useRef<string | undefined>(undefined);
	const polling = useRef(false);
	const actionPending = useRef(false);
	const mounted = useRef(true);
	const focusKey = JSON.stringify(focus);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const refresh = useCallback(() => { setRevision((value) => value + 1); setPollRevision((value) => value + 1); }, []);
	const repoll = useCallback(() => setPollRevision((value) => value + 1), []);
	const setRuns = useCallback((runs: EvaluationRunSummary[]) => setSnapshot((previous) => previous ? { ...previous, runs } : previous), []);
	const setTasks = useCallback((tasks: EvaluationTask[]) => setSnapshot((previous) => previous ? { ...previous, tasks } : previous), []);
	const reloadRuns = useCallback(() => { void api.query({ action: "run.list" }).then((runs) => { if (mounted.current) setRuns(runs); }, () => {}); }, [api, setRuns]);
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
		const focusValue = JSON.parse(focusKey) as EvaluationViewFocus;
		const poll = async () => {
			if (!current) return;
			if (polling.current) { timer = setTimeout(() => { void poll(); }, 500); return; }
			polling.current = true;
			const serial = ++runRequest.current;
			try {
				const value = await api.query({ action: "run.get", runId, focus: focusValue });
				if (!current || serial !== runRequest.current) return;
				setRun(value);
				if (evaluationHasLiveWork(value)) timer = setTimeout(() => { void poll(); }, 500);
				else {
					const runs = await api.query({ action: "run.list" });
					if (current) setRuns(runs);
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
	}, [active, api, connected, runId, pollRevision, focusKey, setRuns]);
	const applyRun = useCallback((value: EvaluationRunView) => {
		++runRequest.current;
		selectedRun.current = value.id;
		setRun(value);
		setRunId(value.id);
		repoll();
		reloadRuns();
	}, [repoll, reloadRuns]);
	const applyCurrentRun = useCallback((value: EvaluationRunView) => {
		if (selectedRun.current !== value.id) return;
		++runRequest.current;
		setRun(value);
		repoll();
	}, [repoll]);
	const selectRun = useCallback((id: string) => { selectedRun.current = id; ++runRequest.current; setRunId(id); }, []);
	const forgetRun = useCallback(() => { selectedRun.current = undefined; ++runRequest.current; setRunId(undefined); setRun(undefined); }, []);
	const perform = useCallback(async (operation: () => Promise<void>) => {
		if (actionPending.current) return;
		actionPending.current = true;
		setBusy(true);
		setError("");
		try { await operation(); }
		catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { actionPending.current = false; if (mounted.current) setBusy(false); }
	}, []);
	return { api, snapshot, run, runId, loading, busy, error, connected, refresh, perform, applyRun, applyCurrentRun, setError, selectRun, forgetRun, setRuns, setTasks };
}
