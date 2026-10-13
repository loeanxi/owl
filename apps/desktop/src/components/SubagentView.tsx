import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { DesktopSubagentDetail, DesktopSubagentSummary } from "../bridge/protocol.ts";
import { rebuild, type ToolCard } from "../hooks/transcript.ts";
import { getUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";
import type { ConversationView } from "./ConversationHeader.tsx";
import { IconChevron, IconRefresh } from "./icons.tsx";
import { useSubagentText } from "./subagent-copy.ts";
import "./subagent-view.css";

export type SubagentSelection = { parentSessionId: string; id?: string; toolCallId?: string; card?: ToolCard };

export function selectedSubagent(runs: readonly DesktopSubagentSummary[], selection: SubagentSelection): DesktopSubagentSummary | undefined {
	return runs.filter((run) => run.parentSessionId === selection.parentSessionId && (selection.id ? run.id === selection.id : selection.toolCallId !== undefined && run.toolCallId === selection.toolCallId)).sort((left, right) => left.childIndex - right.childIndex || (left.startedAt ?? "").localeCompare(right.startedAt ?? "") || left.id.localeCompare(right.id))[0];
}

export function SubagentView({ client, connected, selection, runs, listLoading, listError, view, onBack, onRefresh, onSelect, onOpenUrl, headerActions }: {
	client: BridgeClient; connected: boolean; selection: SubagentSelection; runs: readonly DesktopSubagentSummary[]; listLoading: boolean; listError?: string; view: ConversationView;
	onBack: () => void; onRefresh: () => void; onSelect: (id: string) => void; onOpenUrl?: (url: string) => void;
	headerActions?: ReactNode;
}): React.JSX.Element {
	const copy = useSubagentText();
	const run = selectedSubagent(runs, selection);
	const [reading, setReading] = useState<{ id?: string; detail?: DesktopSubagentDetail; error?: string }>({});
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		if (!run || !connected) return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		const load = async (): Promise<void> => {
			try {
				const response = await client.request<DesktopSubagentDetail>({ type: "subagent.get", sessionId: run.parentSessionId, runId: run.runId, childIndex: run.childIndex });
				if (disposed) return;
				if (!response.ok || !response.result) throw new Error(response.error ?? copy.error);
				setReading({ id: run.id, detail: response.result });
				if (response.result.status === "running" || response.result.status === "unknown") timer = setTimeout(() => void load(), 1500);
			} catch (error) {
				if (disposed) return;
				setReading((current) => ({ id: run.id, detail: current.id === run.id ? current.detail : undefined, error: error instanceof Error ? error.message : String(error) }));
			}
		};
		void load();
		return () => { disposed = true; clearTimeout(timer); };
	}, [client, connected, run?.id, run?.status, revision]);
	const detail = run && reading.id === run.id ? reading.detail : undefined;
	const error = (run && reading.id === run.id ? reading.error : undefined) ?? listError;
	const entries = useMemo(() => rebuild((detail?.messages ?? []).filter((message): message is Record<string, unknown> => Boolean(message && typeof message === "object" && !Array.isArray(message)))), [detail]);
	const record = detail ?? run;
	const status = record?.status ?? "unknown";
	const statusText = { running: copy.statusRunning, completed: copy.statusCompleted, failed: copy.statusFailed, paused: copy.statusPaused, stopped: copy.statusStopped, unknown: copy.statusUnknown }[status];
	const siblings = run ? runs.filter((candidate) => candidate.parentSessionId === run.parentSessionId && (run.toolCallId ? candidate.toolCallId === run.toolCallId : candidate.runId === run.runId)).sort((left, right) => left.childIndex - right.childIndex || left.id.localeCompare(right.id)) : [];
	const reload = (): void => { onRefresh(); setRevision((value) => value + 1); };
	const activity = (detail?.activity ?? []).filter((item) => item.text || item.toolName || item.args !== undefined);
	const activityLabels = { message: copy.activityMessage, tool_start: copy.activityStart, tool_end: copy.activityEnd, stdout: copy.activityOutput, stderr: copy.activityError };
	return <section className="owl-subagent-view" aria-label={copy.open}>
		<div className="owl-subagent-toolbar">
			<button type="button" className="owl-subagent-button" onClick={onBack}><IconChevron className="h-3.5 w-3.5 rotate-180" />{copy.back}</button>
			{record && <span className="owl-subagent-state" data-status={status}>{statusText}</span>}
			<button type="button" className="owl-subagent-button" onClick={reload} disabled={!connected} title={copy.retry}><IconRefresh className="h-3.5 w-3.5" />{copy.retry}</button>
			{headerActions && <div className="owl-subagent-toolbar-controls">{headerActions}</div>}
		</div>
		{siblings.length > 1 && <nav className="owl-subagent-siblings" aria-label={copy.batch}>{siblings.map((sibling) => <button type="button" key={sibling.id} className="owl-subagent-button" aria-current={sibling.id === run?.id ? "page" : undefined} onClick={() => onSelect(sibling.id)}>{sibling.agent} · {sibling.childIndex + 1}</button>)}</nav>}
		{!connected && <p className="owl-subagent-notice" role="status">{copy.offline}</p>}
		{error && <p className="owl-subagent-notice is-error" role="alert">{copy.error}: {error}</p>}
		{!run ? <div className="owl-subagent-empty" role="status"><p>{listLoading ? copy.loading : selection.card?.status === "running" || selection.card?.status === "pending" ? copy.waiting : copy.unavailable}</p>{selection.card && <details><summary>{copy.toolDetails}</summary><pre>{selection.card.detail ?? selection.card.args}</pre>{selection.card.output?.text && <pre>{selection.card.output.text}</pre>}</details>}</div> : <>
			{record?.currentTool && <p className="owl-subagent-notice" role="status">{copy.currentTool}: <code>{record.currentTool}</code></p>}
			{!detail && !error && <p className="owl-subagent-notice" role="status">{copy.loading}</p>}
			{view === "context" ? <div className="owl-subagent-content"><h2>{copy.task}</h2><p className="owl-subagent-task">{record?.task}</p>{record?.model && <p><code>{record.model}</code></p>}<p><code>{record?.cwd}</code></p></div> : view === "trajectory" ? <div className="owl-subagent-content">
				<h2>{copy.activity}</h2>{activity.length === 0 && <p className="owl-subagent-notice">{copy.noActivity}</p>}
				<ol className="owl-subagent-activity">{activity.map((item) => <li key={item.id} data-error={item.isError || undefined}><div><time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleTimeString(getUiLanguage() === "en" ? "en-US" : "zh-CN")}</time><span className="owl-subagent-activity-kind">{activityLabels[item.type]}</span>{item.toolName && <code>{item.toolName}</code>}</div>{item.text && <pre>{item.text}</pre>}{item.args !== undefined && <details><summary>{copy.toolDetails}</summary><pre>{JSON.stringify(item.args, null, 2)}</pre></details>}</li>)}</ol>
			</div> : <><details className="owl-subagent-task-summary"><summary>{copy.task}</summary><p>{record?.task}</p></details>{entries.length > 0 ? <ChatStream key={run.id} entries={entries} activity={status === "running" ? connected ? "working" : "disconnected" : "idle"} onOpenUrl={onOpenUrl} /> : <div className="owl-subagent-empty">{copy.emptyMessages}</div>}</>}
			{detail?.error && <p className="owl-subagent-notice is-error" role="alert">{detail.error}</p>}
			{detail?.truncated && <p className="owl-subagent-notice">{copy.truncated}</p>}
		</>}
		<p className="owl-subagent-footer">{copy.readOnly}</p>
	</section>;
}
