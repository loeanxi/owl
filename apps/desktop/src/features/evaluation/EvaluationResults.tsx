import { useState } from "react";
import type { EvaluationArtifact, EvaluationRating, EvaluationResultView, EvaluationRunView, EvaluationTask } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";
import { downloadEvaluationArtifact, FINISHED_STATUSES, groupResults, isolatedPreview } from "./evaluation-model.ts";
import { IconAlert, IconCheck, IconClock, IconInfo, IconLock } from "./EvaluationIcons.tsx";

export function EvaluationResults({ run, task, sample, busy, t, onSample, onDetails, onReveal, onRetry, onExpand, onAppend, onCancel, onSummary }: {
	run: EvaluationRunView;
	task: EvaluationTask;
	sample: number;
	busy: boolean;
	t: EvaluationText;
	onSample: (sample: number) => void;
	onDetails: () => void;
	onReveal: (mode: "score" | "skip", ratings: Record<string, EvaluationRating>) => void;
	onRetry: (result: EvaluationResultView) => void;
	onExpand: (artifact: EvaluationArtifact) => void;
	onAppend: (samples: 3 | 5) => void;
	onCancel: () => void;
	onSummary: () => void;
}): React.JSX.Element {
	const [drafts, setDrafts] = useState<Record<string, EvaluationRating>>({});
	const [validation, setValidation] = useState("");
	const group = run.groups.find((item) => item.taskId === task.id && item.sample === sample);
	const results = groupResults(run, task.id, sample);
	const successes = results.filter((result) => result.status === "completed");
	const ready = results.length > 0 && results.every((result) => FINISHED_STATUSES.has(result.status));
	const revealed = group?.revealed === true;
	const completedCount = run.results.filter((result) => FINISHED_STATUSES.has(result.status)).length;
	const updateDraft = (result: EvaluationResultView, update: Partial<EvaluationRating>) => setDrafts((previous) => ({ ...previous, [result.id]: { ...(previous[result.id] ?? result.rating ?? { scores: {}, note: "" }), ...update } }));
	const reveal = (mode: "score" | "skip") => {
		const ratings = Object.fromEntries(successes.map((result) => [result.id, drafts[result.id] ?? result.rating ?? { scores: {}, note: "" }]));
		if (mode === "score" && (successes.length === 0 || successes.some((result) => task.rubric.some((item) => !ratings[result.id].scores[item.id])))) { setValidation(t("incompleteScores")); return; }
		setValidation("");
		onReveal(mode, ratings);
	};
	return <>
		<div className="eval-result-head"><div className="eval-crumb">{run.name} / {t("results")}</div><div className="eval-toolbar"><h2 className="eval-page-title">{task.title}</h2><span className="eval-pill">{task.id}</span><span className="eval-pill">{t(task.category)}</span><span className="eval-spacer" /><button className="eval-button" onClick={onSummary}>{t("summary")}</button></div><p className="eval-page-description">{t("scope", { tasks: run.tasks.length, profiles: run.profileCount, samples: run.samples })} · {t("progress", { done: completedCount, total: run.results.length })}</p>
			<div className="eval-result-controls"><select className="eval-field" aria-label={t("samples")} value={sample} onChange={(event) => { setValidation(""); onSample(Number(event.target.value)); }}>{Array.from({ length: run.samples }, (_, index) => index + 1).map((number) => <option key={number} value={number}>{t("sample", { n: number })}</option>)}</select><button className="eval-button" onClick={onDetails}>{t("rubric")}</button><span className="eval-spacer" />{run.samples < 3 && <button className="eval-button" disabled={busy || run.status === "running"} onClick={() => onAppend(3)}>{t("appendThree")}</button>}{run.samples < 5 && <button className="eval-button" disabled={busy || run.status === "running"} onClick={() => onAppend(5)}>{t("appendFive")}</button>}{run.status === "running" && <button className="eval-button danger" disabled={busy} onClick={onCancel}>{t("cancel")}</button>}</div>
			{run.status === "running" && <div className="eval-progress" role="progressbar" aria-valuenow={completedCount} aria-valuemin={0} aria-valuemax={run.results.length}><span style={{ width: `${run.results.length ? completedCount / run.results.length * 100 : 0}%` }} /></div>}
		</div>
		<div className="eval-notice">{revealed ? <IconCheck /> : <IconLock />}<div><strong>{revealed ? t("revealed") : t("anonymous")}</strong><small>{revealed ? t("revealHint") : t("anonymousHint")}</small></div></div>
		<div className="eval-result-grid">{results.map((result) => <EvaluationResultCard key={result.id} result={result} task={task} busy={busy} draft={drafts[result.id] ?? result.rating ?? { scores: {}, note: "" }} t={t} onDraft={(update) => updateDraft(result, update)} onRetry={() => onRetry(result)} onExpand={onExpand} />)}</div>
		{results.length === 0 && <div className="eval-empty">{t("loading")}</div>}
		<div className="eval-compare-foot"><span className="eval-muted" role={validation ? "alert" : undefined}>{validation || (revealed ? t("revealHint") : !ready ? t("notReady") : successes.length === 0 ? t("nothingToScore") : t("anonymousHint"))}</span><span className="eval-spacer" />{!revealed && <><button className="eval-button" disabled={busy || !ready} onClick={() => reveal("skip")}>{t("skipReveal")}</button><button className="eval-button primary" disabled={busy || !ready || successes.length === 0} onClick={() => reveal("score")}>{busy ? t("busy") : t("submitReveal")}</button></>}</div>
	</>;
}

function EvaluationResultCard({ result, task, draft, busy, t, onDraft, onRetry, onExpand }: {
	result: EvaluationResultView;
	task: EvaluationTask;
	draft: EvaluationRating;
	busy: boolean;
	t: EvaluationText;
	onDraft: (update: Partial<EvaluationRating>) => void;
	onRetry: () => void;
	onExpand: (artifact: EvaluationArtifact) => void;
}): React.JSX.Element {
	const [tab, setTab] = useState<"preview" | "source" | "answer" | "analysis">(task.outputType === "code" || task.outputType === "json" ? "source" : "preview");
	const artifact = result.artifact;
	const canPreview = artifact?.previewAllowed && (artifact.type === "svg" || artifact.type === "html");
	const isFailure = result.status === "failed" || result.status === "cancelled" || result.status === "interrupted";
	const tabs: (typeof tab)[] = task.outputType === "svg" || task.outputType === "html" ? ["preview", "source", "answer"] : ["source", "answer"];
	if (result.revealed) tabs.push("analysis");
	const profileName = result.revealed && result.profile ? t("modelConfig", { model: result.profile.model.name, level: result.profile.thinkingLevel === "default" ? t("defaultThinking") : result.profile.thinkingLevel }) : t("result", { letter: result.anonymousLabel });
	const scores = result.revealed ? result.rating?.scores ?? {} : draft.scores;
	return <article className="eval-result-card"><div className="eval-result-top"><div className="eval-result-avatar">{result.anonymousLabel}</div><div style={{ minWidth: 0 }}><div className="eval-result-name" title={profileName}>{profileName}</div><div className="eval-result-caption">{result.revealed ? result.profile?.model.sourceName ?? t("unknown") : t("hiddenIdentity")}{result.attempt > 1 ? ` · ${t("attempt", { n: result.attempt })}` : ""}</div></div></div>
		<div className="eval-result-tabs">{tabs.map((value) => <button key={value} className={tab === value ? "active" : ""} aria-pressed={tab === value} onClick={() => setTab(value)}>{t(value)}</button>)}</div>
		<div className="eval-artifact">{tab === "preview" ? canPreview && artifact ? <iframe title={`${t("preview")} ${result.anonymousLabel}`} sandbox={artifact.type === "html" ? "allow-scripts" : ""} referrerPolicy="no-referrer" srcDoc={isolatedPreview(artifact.content, artifact.type as "svg" | "html")} /> : <div className="eval-artifact-placeholder">{isFailure ? <IconAlert /> : result.status === "completed" ? <IconInfo /> : <IconClock />}<strong>{isFailure || result.status !== "completed" ? t(result.status) : t("noArtifact")}</strong>{result.error && <small>{result.error}</small>}</div> : <pre>{tab === "source" ? artifact?.content || result.output || (result.error ? `${t(result.status)}: ${result.error}` : t(result.status)) : tab === "analysis" ? result.thinking || t("noAnalysis") : result.output || result.error || t(result.status)}</pre>}</div>
		{artifact && <div className="eval-artifact-actions"><span>{canPreview ? t("previewHint") : artifact.type.toUpperCase()}</span><span className="eval-spacer" />{canPreview && <button className="eval-link" onClick={() => onExpand(artifact)}>{t("expand")}</button>}<button className="eval-link" onClick={() => downloadEvaluationArtifact(artifact.content, `${task.id}-${result.anonymousLabel}-${result.sample}.${artifact.type === "code" ? "txt" : artifact.type}`, artifact.type)}>{t("download")}</button></div>}
		<div className="eval-checks"><div className="eval-checks-title">{t("automatic")}<span className="eval-spacer" /><span className="eval-pill">{t(result.status)}</span></div>{result.checks.length === 0 ? <p className="eval-muted" style={{ fontSize: 10 }}>{t("checksEmpty")}</p> : result.checks.map((check) => <div key={check.id} className={`eval-check-item ${check.status === "failed" ? "fail" : ""}`}>{check.status === "passed" ? <IconCheck /> : check.status === "failed" ? <IconAlert /> : <IconInfo />}<div>{check.label} · {t(check.status === "passed" ? "passed" : check.status === "failed" ? "failed" : "unchecked")}<small>{check.detail}</small></div></div>)}{isFailure && <button className="eval-link" style={{ marginTop: 8 }} disabled={busy} title={t("retryHint")} onClick={onRetry}>{t("retry")}</button>}</div>
		<div className="eval-manual"><div className="eval-score-heading">{t("manual")}<span>{result.revealed ? result.rating ? t("saved") : t("skipped") : t("scoreScale")}</span></div>{task.rubric.map((item) => <div className="eval-score-row" key={item.id}><span title={item.description}>{item.label}</span>{result.revealed ? <strong>{typeof scores[item.id] === "number" ? scores[item.id] : "—"} / 5</strong> : <div className="eval-rating" role="group" aria-label={`${result.anonymousLabel} ${item.label}`}>{[1, 2, 3, 4, 5].map((score) => <button key={score} className={scores[item.id] === score ? "selected" : ""} aria-pressed={scores[item.id] === score} aria-label={t("score", { n: score })} disabled={result.status !== "completed" || busy} onClick={() => onDraft({ scores: { ...scores, [item.id]: score } })}>{score}</button>)}</div>}</div>)}{result.revealed ? result.rating?.note && <p className="eval-muted" style={{ marginTop: 9, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{result.rating.note}</p> : <textarea className="eval-score-note" aria-label={`${result.anonymousLabel} ${t("notes")}`} placeholder={t("notesPlaceholder")} disabled={result.status !== "completed" || busy} value={draft.note} maxLength={4000} onChange={(event) => onDraft({ note: event.target.value })} />}</div>
		{result.revealed && <div className="eval-result-metrics"><div><strong>{typeof result.durationMs === "number" ? t("seconds", { n: (result.durationMs / 1000).toFixed(1) }) : t("unknown")}</strong><span>{t("duration")}</span></div><div title={result.usage ? t("rawUsage", { input: result.usage.input, output: result.usage.output }) : t("unknown")}><strong>{result.usage ? result.usage.total.toLocaleString() : t("unknown")}</strong><span>{t("tokens")}</span></div><div><strong>{typeof result.costUsd === "number" ? `US$${result.costUsd.toFixed(5)}` : t("unknown")}</strong><span>{t("fee")}</span></div></div>}
	</article>;
}
