import { useContext, useEffect, useRef, useState } from "react";
import type { DesktopProcessDetail, DesktopProcessSummary, DesktopSubagentSummary } from "../../bridge/protocol.ts";
import { ExecutionContext, type ExecutionContextValue } from "../execution-context.tsx";
import { useExecutionText } from "../execution-copy.ts";
import { parseExecutionSelection, selectedExecutionTool, type ExecutionSelection } from "../execution-selection.ts";
import type { TabComponentProps } from "../registry.ts";
import "./execution-tab.css";

type ExecutionTabProps = Pick<TabComponentProps, "tab" | "store" | "client" | "profile" | "onOpenFile">;

export function ExecutionTab(props: ExecutionTabProps): React.JSX.Element {
	const copy = useExecutionText();
	const context = useContext(ExecutionContext);
	const selection = parseExecutionSelection(props.tab.path);
	const boundProfile = useRef(selection?.profile ?? props.profile ?? context.profile);
	if (!boundProfile.current && (props.profile ?? context.profile)) boundProfile.current = props.profile ?? context.profile;
	useEffect(() => {
		if (selection && !selection.profile && boundProfile.current) props.store.setTabPath(props.tab.id, JSON.stringify({ ...selection, profile: boundProfile.current }));
	}, [props.store, props.tab.id, props.tab.path]);
	if (!selection) return <div className="owl-execution"><div className="owl-execution-empty" role="status">{copy.invalid}</div></div>;
	if (!boundProfile.current || !props.profile || !context.profile) return <div className="owl-execution"><div className="owl-execution-empty" role="status">{copy.accountLoading}</div></div>;
	if (boundProfile.current !== props.profile || context.profile !== props.profile) return <div className="owl-execution"><div className="owl-execution-empty" role="status">{copy.profileChanged}</div></div>;
	if (selection.sessionId !== context.sessionId) return <div className="owl-execution"><div className="owl-execution-empty" role="status"><p>{copy.ownerChanged}</p>{context.onOpenSession && <button type="button" className="owl-execution-button" onClick={() => context.onOpenSession?.(selection.sessionId)}>{copy.openOwner}</button>}</div></div>;
	return <ExecutionOwnerView key={`${props.profile}:${selection.sessionId}:${selection.mode}:${selection.toolId ?? ""}:${selection.ownerIndex ?? ""}`} {...props} context={context} selection={selection} />;
}

function ExecutionOwnerView({ client, onOpenFile, context, selection }: ExecutionTabProps & { context: ExecutionContextValue; selection: ExecutionSelection }): React.JSX.Element {
	const copy = useExecutionText();
	const [processes, setProcesses] = useState<DesktopProcessSummary[]>([]);
	const [processId, setProcessId] = useState<number>();
	const [detail, setDetail] = useState<DesktopProcessDetail>();
	const [revision, setRevision] = useState(0);
	const [loading, setLoading] = useState(selection.mode === "tasks");
	const [error, setError] = useState<string>();
	const [readingError, setReadingError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [stopping, setStopping] = useState<string>();
	const [copied, setCopied] = useState(false);
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const tool = selection.mode === "tool" ? selectedExecutionTool(context.entries, selection) : undefined;
	useEffect(() => {
		if (selection.mode !== "tasks") return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const load = async (): Promise<void> => {
			try {
				const response = await client.request<DesktopProcessSummary[]>({ type: "process.list", sessionId: selection.sessionId });
				if (!response.ok) throw new Error(response.error ?? copy.failed);
				if (!disposed) { setProcesses(response.result ?? []); setLoading(false); setReadingError(undefined); }
			} catch (cause) {
				if (!disposed) { setReadingError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); }
			} finally { if (!disposed) timer = setTimeout(() => void load(), 2000); }
		};
		void load();
		return () => { disposed = true; clearTimeout(timer); };
	}, [client, selection.sessionId, selection.mode, revision]);
	useEffect(() => {
		if (processId === undefined) { setDetail(undefined); return; }
		let disposed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const load = async (): Promise<void> => {
			try {
				const response = await client.request<DesktopProcessDetail>({ type: "process.get", sessionId: selection.sessionId, processId });
				if (!response.ok || !response.result) throw new Error(response.error ?? copy.failed);
				if (disposed) return;
				setDetail(response.result);
				if (response.result.status === "running") timer = setTimeout(() => void load(), 1500);
			} catch (cause) { if (!disposed) setReadingError(cause instanceof Error ? cause.message : String(cause)); }
		};
		void load();
		return () => { disposed = true; clearTimeout(timer); };
	}, [client, processId, selection.sessionId, revision]);
	useEffect(() => { setCopied(false); }, [tool?.id, tool?.output?.text, processId, detail?.output]);
	const refresh = (): void => { context.onRefreshSubagents(); setRevision((value) => value + 1); };
	const stopProcess = async (id: number): Promise<void> => {
		setStopping(`process:${id}`); setError(undefined); setNotice(undefined);
		try {
			const response = await client.request<DesktopProcessDetail>({ type: "process.kill", sessionId: selection.sessionId, processId: id });
			if (!response.ok || !response.result) throw new Error(response.error ?? copy.failed);
			if (!mounted.current) return;
			if (processId === id) setDetail(response.result);
			setNotice(response.result.status === "running" ? copy.stopPending : copy.stopped);
			refresh();
		} catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (mounted.current) setStopping(undefined); }
	};
	const interrupt = async (runId: string): Promise<void> => {
		setStopping(`agent:${runId}`); setError(undefined); setNotice(undefined);
		try {
			const response = await client.request<{ message: string }>({ type: "subagent.interrupt", sessionId: selection.sessionId, runId });
			if (!response.ok) throw new Error(response.error ?? copy.noControl);
			if (!mounted.current) return;
			setNotice(copy.interrupted); refresh();
		} catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (mounted.current) setStopping(undefined); }
	};
	const outputText = selection.mode === "tool" ? tool?.output?.text ?? "" : detail && detail.id === processId ? detail.output : "";
	const copyOutput = async (): Promise<void> => {
		try { await navigator.clipboard.writeText(outputText); if (mounted.current) setCopied(true); }
		catch { if (mounted.current) setError(copy.copyFailed); }
	};
	const groups = new Map<string, DesktopSubagentSummary[]>();
	for (const run of context.subagents) {
		if (run.parentSessionId !== selection.sessionId) continue;
		const group = groups.get(run.runId) ?? [];
		group.push(run); groups.set(run.runId, group);
	}
	const showingOutput = selection.mode === "tool" || processId !== undefined;
	const status = selection.mode === "tool" ? tool?.status : detail && detail.id === processId ? detail.status : undefined;
	const statusLabel = status === "failed" ? copy.failedStatus : status ? copy[status] : undefined;
	return <section className="owl-execution" aria-label={showingOutput ? copy.output : copy.tasks}>
		<header className="owl-execution-toolbar">
			{processId !== undefined && <button type="button" className="owl-execution-button" onClick={() => { setProcessId(undefined); setDetail(undefined); }}>{copy.back}</button>}
			<strong>{showingOutput ? copy.output : copy.tasks}</strong>
			{status && <span className="owl-execution-state" data-status={status}>{statusLabel}</span>}
			{showingOutput ? <button type="button" className="owl-execution-button owl-execution-push" disabled={!outputText} onClick={() => void copyOutput()}>{copied ? copy.copied : copy.copy}</button> : <button type="button" className="owl-execution-button owl-execution-push" onClick={refresh}>{copy.refresh}</button>}
		</header>
		{(error ?? readingError) && <p className="owl-execution-notice is-error" role="alert">{error ?? readingError}</p>}
		{notice && <p className="owl-execution-notice" role="status">{notice}</p>}
		{showingOutput ? <>
			<div className="owl-execution-output-heading"><code>{tool?.name ?? detail?.command}</code>{detail?.exitCode !== undefined && <span>{copy.exitCode}: {detail.exitCode === null ? "—" : detail.exitCode}</span>}</div>
			{selection.mode === "tool" && !tool ? <p className="owl-execution-empty" role="status">{copy.missingTool}</p> : <div className="owl-execution-output" tabIndex={0} aria-label={copy.output}><pre><code>{outputText || (processId !== undefined && !detail ? copy.loading : copy.emptyOutput)}</code></pre></div>}
			{tool && <details className="owl-execution-arguments"><summary>{copy.arguments}</summary><pre>{tool.detail ?? tool.args}</pre></details>}
			{tool?.output?.images && <div className="owl-execution-images">{tool.output.images.map((image, index) => <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`${copy.images} ${index + 1}`} />)}</div>}
			{tool?.output?.fullPath && <button type="button" className="owl-execution-button owl-execution-full" onClick={() => onOpenFile(tool.output!.fullPath!)}>{copy.fullOutput}</button>}
			{detail && detail.omittedBytes > 0 && <p className="owl-execution-notice">{copy.truncated}</p>}
			{detail?.status === "running" && <footer className="owl-execution-footer"><button type="button" className="owl-execution-button is-danger" disabled={Boolean(stopping)} onClick={() => void stopProcess(detail.id)}>{stopping ? copy.stopping : copy.stop}</button></footer>}
		</> : <div className="owl-execution-task-list">
			{loading && <p className="owl-execution-notice" role="status">{copy.loading}</p>}
			{!loading && !readingError && groups.size === 0 && processes.length === 0 && <div className="owl-execution-empty"><strong>{copy.emptyTasks}</strong><p>{copy.emptyHint}</p></div>}
			{groups.size > 0 && <h3>{copy.agents} <span>{context.subagents.filter((run) => run.parentSessionId === selection.sessionId).length}</span></h3>}
			{[...groups].map(([runId, runs]) => <article className="owl-execution-task" key={runId} data-run-id={runId}>
				{runs.map((run) => <div key={run.id} className="owl-execution-agent"><div><strong>{run.agent}</strong><span className="owl-execution-state" data-status={run.status}>{run.status === "failed" ? copy.failedStatus : copy[run.status]}</span></div><p>{run.task}</p>{run.currentTool && <code>{run.currentTool}</code>}<button type="button" className="owl-execution-button" onClick={() => context.onOpenSubagent(run.id)}>{copy.viewAgent}</button></div>)}
				{runs.some((run) => run.status === "running" || run.status === "unknown") && <div className="owl-execution-task-actions">{runs.length > 1 && <small>{copy.batchHint}</small>}<button type="button" className="owl-execution-button is-danger" disabled={Boolean(stopping)} title={copy.batchHint} onClick={() => void interrupt(runId)}>{stopping === `agent:${runId}` ? copy.stopping : copy.interrupt}</button></div>}
			</article>)}
			{processes.length > 0 && <h3>{copy.commands} <span>{processes.length}</span></h3>}
			{processes.map((process) => <article className="owl-execution-task" key={process.id} data-process-id={process.id}><div className="owl-execution-process-title"><code>#{process.id}</code><span className="owl-execution-state" data-status={process.status}>{process.status === "failed" ? copy.failedStatus : copy[process.status]}</span></div><pre className="owl-execution-command">{process.command}</pre><p className="owl-execution-cwd">{process.cwd}</p><div className="owl-execution-task-actions"><button type="button" className="owl-execution-button" onClick={() => { setDetail(undefined); setProcessId(process.id); }}>{copy.viewOutput}</button>{process.status === "running" && <button type="button" className="owl-execution-button is-danger" disabled={Boolean(stopping)} onClick={() => void stopProcess(process.id)}>{stopping === `process:${process.id}` ? copy.stopping : copy.stop}</button>}</div></article>)}
		</div>}
	</section>;
}
