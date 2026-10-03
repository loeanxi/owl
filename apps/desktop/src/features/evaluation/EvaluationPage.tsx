import { useEffect, useState } from "react";
import type { EvaluationArtifact, EvaluationTask } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import { EvaluationCreate } from "./EvaluationCreate.tsx";
import { EvaluationDialog, EvaluationTaskDetails, EvaluationTaskEditor } from "./EvaluationDialogs.tsx";
import { EvaluationHistory } from "./EvaluationHistory.tsx";
import { EvaluationLibrary } from "./EvaluationLibrary.tsx";
import { EvaluationResults } from "./EvaluationResults.tsx";
import { EvaluationSummary } from "./EvaluationSummary.tsx";
import { useEvaluationText } from "./evaluation-copy.ts";
import { CATEGORIES, FINISHED_STATUSES, isolatedPreview } from "./evaluation-model.ts";
import { IconActivity, IconAlert, IconBook, IconCheck, IconClock, IconPlus } from "./EvaluationIcons.tsx";
import { useEvaluation } from "./useEvaluation.ts";
import "./evaluation.css";

type EvaluationSection = "results" | "create" | "library" | "history" | "summary";
type EvaluationModal = { type: "details"; task: EvaluationTask } | { type: "editor"; task?: EvaluationTask; copy?: boolean } | { type: "preview"; artifact: EvaluationArtifact };

export function EvaluationPage({ client, active = true, sidebarCollapsed = false }: { client: BridgeClient; active?: boolean; sidebarCollapsed?: boolean }): React.JSX.Element {
	const t = useEvaluationText();
	const state = useEvaluation(client, active);
	const { api, snapshot, run, runId, loading, busy, connected, error, refresh, applyRun, perform, selectRun } = state;
	const [section, setSection] = useState<EvaluationSection>("results");
	const [taskId, setTaskId] = useState("");
	const [sample, setSample] = useState(1);
	const [initialTaskId, setInitialTaskId] = useState<string>();
	const [createRevision, setCreateRevision] = useState(0);
	const [modal, setModal] = useState<EvaluationModal>();
	useEffect(() => {
		if (run && run.id === runId && !run.tasks.some((task) => task.id === taskId)) { setTaskId(run.tasks[0]?.id ?? ""); setSample(1); }
	}, [run, runId, taskId]);
	const task = run?.tasks.find((item) => item.id === taskId) ?? run?.tasks[0];
	const openDetails = (value: EvaluationTask) => setModal({ type: "details", task: value });
	const newRun = (id?: string) => { setInitialTaskId(id); setCreateRevision((previous) => previous + 1); setSection("create"); setModal(undefined); };
	const shownRun = run?.id === runId ? run : undefined;
	const currentSection = section === "create" ? "newRun" : section === "results" ? "results" : section;
	return <div className="owl-eval">
		<aside id="owl-evaluation-sidebar" className="eval-sidebar" hidden={sidebarCollapsed}><div className="eval-brand"><IconActivity /><strong>owl</strong><span className="eval-pill">LOCAL</span></div><div className="eval-module-label"><IconActivity />{t("title")}</div><nav className="eval-nav" aria-label={t("title")}><button className={section === "results" || section === "create" || section === "summary" ? "active" : ""} onClick={() => setSection("results")}><IconActivity />{t("evaluation")}</button><button className={section === "library" ? "active" : ""} onClick={() => setSection("library")}><IconBook />{t("library")}<span className="eval-spacer" />{snapshot?.tasks.length ?? 0}</button><button className={section === "history" ? "active" : ""} onClick={() => { refresh(); setSection("history"); }}><IconClock />{t("history")}<span className="eval-spacer" />{snapshot?.runs.length ?? 0}</button></nav>
			{shownRun && <><div className="eval-subhead">{t("currentRun")}</div><div className="eval-run-mini"><strong>{shownRun.name}</strong><span className="eval-muted">{t(shownRun.status)} · {t("samples")}: {shownRun.samples}</span></div><div className="eval-side-tasks">{CATEGORIES.map((category) => { const tasks = shownRun.tasks.filter((item) => item.category === category); return tasks.length > 0 && <div key={category}><div className="eval-task-group"><span>{t(category)}</span><span>{tasks.length}</span></div>{tasks.map((item) => { const results = shownRun.results.filter((result) => result.taskId === item.id); return <button className={`eval-side-task ${taskId === item.id && section === "results" ? "active" : ""}`} key={item.id} title={item.title} onClick={() => { setTaskId(item.id); setSample(1); setSection("results"); }}><span className="eval-id">{item.id}</span><span className="task-title">{item.title}</span><span className="eval-task-indicator">{results.length > 0 && results.every((result) => FINISHED_STATUSES.has(result.status)) ? <IconCheck /> : <IconClock />}</span></button>; })}</div>; })}</div></>}
			<div className="eval-sidebar-footer"><strong>{t("direct")}</strong>{t("directHint")}</div>
		</aside>
		<main className="eval-main"><header className="eval-main-head"><IconActivity /><h1>{t("title")}</h1><span className="eval-muted">/ {t(currentSection)}</span><span className="eval-spacer" /><span className="eval-muted"><span className="eval-local-dot" style={connected ? undefined : { background: "#d88181" }} />{connected ? t("local") : t("offline")}</span><button className="eval-button" disabled={busy} onClick={refresh}>{t("refresh")}</button><button className="eval-button primary" disabled={busy} onClick={() => newRun()}><IconPlus />{t("newRun")}</button></header>
			{error && <div className="eval-error" role="alert"><IconAlert /><span>{error}</span><span className="eval-spacer" /><button className="eval-link" onClick={refresh}>{t("reconnect")}</button></div>}{!connected && !error && <div className="eval-error" role="status"><IconAlert />{t("offline")}</div>}
			<div className="eval-scroll">{loading && !snapshot ? <div className="eval-empty" role="status"><IconClock />{t("loading")}</div> : snapshot && section === "create" ? <EvaluationCreate key={createRevision} tasks={snapshot.tasks} models={snapshot.models} initialTaskId={initialTaskId} busy={busy} connected={connected} t={t} onDetails={openDetails} onCustom={() => setModal({ type: "editor" })} onStart={(input) => { void perform(async () => { const value = await api.query({ action: "run.start", ...input }); applyRun(value); setTaskId(value.tasks[0]?.id ?? ""); setSample(1); setSection("results"); }); }} /> : snapshot && section === "library" ? <EvaluationLibrary tasks={snapshot.tasks} onDetails={openDetails} onCustom={() => setModal({ type: "editor" })} t={t} /> : snapshot && section === "history" ? <EvaluationHistory runs={snapshot.runs} t={t} onNew={() => newRun()} onOpen={(id) => { selectRun(id); setTaskId(""); setSample(1); setSection("results"); }} /> : runId && !shownRun ? <div className="eval-empty" role="status">{t("loading")}</div> : shownRun && section === "summary" ? <EvaluationSummary run={shownRun} t={t} onResults={() => setSection("results")} /> : shownRun && task ? <EvaluationResults key={shownRun.id} run={shownRun} task={task} sample={sample} busy={busy || !connected} t={t} onSample={setSample} onDetails={() => openDetails(task)} onSummary={() => setSection("summary")} onExpand={(artifact) => setModal({ type: "preview", artifact })} onReveal={(mode, ratings) => { void perform(async () => { applyRun(await api.query({ action: "run.reveal", runId: shownRun.id, taskId: task.id, sample, mode, ratings: mode === "score" ? ratings : undefined })); }); }} onRetry={(result) => { void perform(async () => { applyRun(await api.query({ action: "run.retry", runId: shownRun.id, resultId: result.id })); }); }} onAppend={(samples) => { void perform(async () => { applyRun(await api.query({ action: "run.append", runId: shownRun.id, samples })); }); }} onCancel={() => { void perform(async () => { applyRun(await api.query({ action: "run.cancel", runId: shownRun.id })); }); }} /> : <div className="eval-empty"><IconActivity /><h2>{t("noRuns")}</h2><p>{t("noRunsHint")}</p><button className="eval-button primary" disabled={loading} onClick={() => newRun()}><IconPlus />{t("newRun")}</button>{snapshot && snapshot.runs.length > 0 && <button className="eval-link" onClick={() => setSection("history")}>{t("history")}</button>}</div>}</div>
		</main>
		{modal?.type === "details" && <EvaluationTaskDetails task={modal.task} t={t} onClose={() => setModal(undefined)} onCopy={() => setModal({ type: "editor", task: modal.task, copy: true })} onEdit={() => setModal({ type: "editor", task: modal.task })} onAdd={() => newRun(modal.task.id)} onSource={(url) => { if (!/^https?:\/\//i.test(url)) return; void perform(async () => { const response = await client.request({ type: "open.external", action: "url", target: url }); if (!response.ok) throw new Error(response.error ?? t("error")); }); }} />}
		{modal?.type === "editor" && <EvaluationTaskEditor key={modal.task?.id ?? "new"} task={modal.task} copy={modal.copy} t={t} busy={busy} onClose={() => { if (!busy) setModal(undefined); }} onSave={(value) => { void perform(async () => { await api.query({ action: "task.save", task: value }); refresh(); setModal(undefined); setSection("library"); }); }} />}
		{modal?.type === "preview" && <EvaluationDialog title={t("preview")} onClose={() => setModal(undefined)} preview footer={<button className="eval-button" onClick={() => setModal(undefined)}>{t("close")}</button>}><div className="eval-modal-artifact"><iframe title={t("preview")} sandbox={modal.artifact.type === "html" ? "allow-scripts" : ""} referrerPolicy="no-referrer" srcDoc={isolatedPreview(modal.artifact.content, modal.artifact.type as "svg" | "html")} /></div><p className="eval-page-description">{t("previewHint")}</p></EvaluationDialog>}
	</div>;
}
