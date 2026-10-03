import { useLayoutEffect, useRef, useState } from "react";
import type { EvaluationArtifact, EvaluationRating, EvaluationResultView, EvaluationTask } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";
import { downloadEvaluationArtifact, isolatedPreview } from "./evaluation-model.ts";
import { evaluationProcessStage } from "./evaluation-process.ts";
import { IconAlert, IconCheck, IconClock, IconInfo } from "./EvaluationIcons.tsx";

type ResultTab = "process" | "preview" | "source" | "answer" | "analysis";

export function EvaluationResultCard({ result, task, draft, busy, t, onDraft, onRetry, onExpand }: {
	result: EvaluationResultView;
	task: EvaluationTask;
	draft: EvaluationRating;
	busy: boolean;
	t: EvaluationText;
	onDraft: (update: Partial<EvaluationRating>) => void;
	onRetry: () => void;
	onExpand: (artifact: EvaluationArtifact) => void;
}): React.JSX.Element {
	const [tab, setTab] = useState<ResultTab>(result.status === "queued" || result.status === "running" ? "process" : task.outputType === "code" || task.outputType === "json" ? "source" : "preview");
	const textElement = useRef<HTMLElement | null>(null);
	const following = useRef<Record<ResultTab, boolean>>({ process: true, preview: true, answer: true, source: true, analysis: true });
	const readingPositions = useRef<Partial<Record<ResultTab, number>>>({});
	const [followPaused, setFollowPaused] = useState(false);
	const generating = result.status === "queued" || result.status === "running";
	const stage = evaluationProcessStage(result);
	const hasThinkingChannel = typeof result.thinking === "string";
	const thinkingText = hasThinkingChannel ? result.thinking : "";
	const bodyText = result.output;
	const artifact = result.artifact;
	const canPreview = result.status === "completed" && artifact?.previewAllowed && (artifact.type === "svg" || artifact.type === "html");
	const isFailure = result.status === "failed" || result.status === "cancelled" || result.status === "interrupted";
	const tabs: ResultTab[] = task.outputType === "svg" || task.outputType === "html" ? ["process", "preview", "source", "answer", "analysis"] : ["process", "source", "answer", "analysis"];
	const profileName = result.revealed && result.profile ? t("modelConfig", { model: result.profile.model.name, level: result.profile.thinkingLevel === "default" ? t("defaultThinking") : result.profile.thinkingLevel }) : t("result", { letter: result.anonymousLabel });
	const scores = result.revealed ? result.rating?.scores ?? {} : draft.scores;
	const emptyProcess = generating ? result.status === "queued" ? t("queueDetail") : hasThinkingChannel ? t("waitingFirstSegment") : t("waitingBody") : result.error || t(result.status);
	const answerText = tab === "source" ? artifact?.content || bodyText : tab === "analysis" ? !hasThinkingChannel ? t("thinkingServiceUnavailable") : thinkingText || (generating ? t("thinkingNotReturned") : t("noAnalysis")) : bodyText;
	const displayText = answerText || (generating ? t("waitingBody") : result.error || t(result.status));
	const contentRevision = tab === "process" ? `${thinkingText}\u0000${bodyText}\u0000${emptyProcess}` : displayText;
	const phaseDetail = stage === "thinking" ? t("receivingThinking") : stage === "answering" ? t("streamingBody") : stage === "checking" ? t("checkingDetail") : stage === "waiting" ? t("requestSent") : "";
	const setTextElement = (element: HTMLElement | null) => { textElement.current = element; };
	const onScroll = (event: React.UIEvent<HTMLElement>) => {
		const element = event.currentTarget;
		const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 32;
		following.current[tab] = atBottom;
		readingPositions.current[tab] = element.scrollTop;
		setFollowPaused(!atBottom);
	};
	useLayoutEffect(() => {
		const element = textElement.current;
		if (element) element.scrollTop = following.current[tab] ? element.scrollHeight : readingPositions.current[tab] ?? 0;
		setFollowPaused(!following.current[tab]);
	}, [contentRevision, tab]);
	return <article className="eval-result-card">
		<div className="eval-result-top"><div className="eval-result-avatar">{result.anonymousLabel}</div><div style={{ minWidth: 0 }}><div className="eval-result-name" title={profileName}>{profileName}</div><div className="eval-result-caption">{result.revealed ? result.profile?.model.sourceName ?? t("unknown") : t("hiddenIdentity")}{result.attempt > 1 ? ` · ${t("attempt", { n: result.attempt })}` : ""}</div></div></div>
		<div className="eval-result-tabs">{tabs.map((value) => <button key={value} className={tab === value ? "active" : ""} aria-pressed={tab === value} onClick={() => { if (textElement.current) readingPositions.current[tab] = textElement.current.scrollTop; setTab(value); }}>{t(value)}</button>)}</div>
		{generating && <div className="eval-live-status" role="status" data-generation-phase={stage}><span className="eval-pill">{t(stage === "waiting" ? "running" : stage)}</span>{stage === "waiting" && <span className="eval-waiting-indicator" aria-hidden="true" />}<span>{phaseDetail}</span>{followPaused && tab !== "preview" && <button className="eval-link" onClick={() => { following.current[tab] = true; setFollowPaused(false); if (textElement.current) textElement.current.scrollTop = textElement.current.scrollHeight; }}>{t("followOutput")}</button>}</div>}
		<div className="eval-artifact">
			{tab === "preview" ? canPreview && artifact ? <iframe title={`${t("preview")} ${result.anonymousLabel}`} sandbox={artifact.type === "html" ? "allow-scripts allow-forms" : ""} referrerPolicy="no-referrer" srcDoc={isolatedPreview(artifact.content, artifact.type as "svg" | "html")} /> : <div className="eval-artifact-placeholder">{isFailure ? <IconAlert /> : result.status === "completed" ? <IconInfo /> : <IconClock />}<strong>{isFailure || result.status !== "completed" ? t(result.status) : t("noArtifact")}</strong>{result.error && <small>{result.error}</small>}</div>
				: tab === "process" ? <div ref={setTextElement} className="eval-process-pane eval-stream-scroll" data-live-output={generating ? "true" : undefined} onScroll={onScroll} role="region" aria-label={t("process")}>
					{!hasThinkingChannel && <p className="eval-process-service-notice">{t("thinkingServiceUnavailable")}</p>}
					{thinkingText && <section className="eval-process-section eval-process-thinking" data-process-section="thinking"><h4>{t("returnedThinking")}</h4><pre>{thinkingText}</pre></section>}
					{bodyText && <section className="eval-process-section eval-process-answer" data-process-section="answer"><h4>{t("responseBody")}</h4><pre>{bodyText}</pre></section>}
					{!thinkingText && !bodyText && <p className="eval-process-empty">{emptyProcess}</p>}
				</div> : <pre className="eval-stream-scroll" ref={setTextElement} data-live-output={generating ? "true" : undefined} onScroll={onScroll}>{displayText}</pre>}
		</div>
		{artifact && result.status === "completed" && <div className="eval-artifact-actions"><span>{canPreview ? t("previewHint") : artifact.type.toUpperCase()}</span><span className="eval-spacer" />{canPreview && <button className="eval-link" onClick={() => onExpand(artifact)}>{t("expand")}</button>}<button className="eval-link" onClick={() => downloadEvaluationArtifact(artifact.content, `${task.id}-${result.anonymousLabel}-${result.sample}.${artifact.type === "code" ? "txt" : artifact.type}`, artifact.type)}>{t("download")}</button></div>}
		<div className="eval-checks"><div className="eval-checks-title">{t("automatic")}<span className="eval-spacer" /><span className="eval-pill">{t(result.status)}</span></div>{result.checks.length === 0 ? <p className="eval-muted" style={{ fontSize: 10 }}>{t("checksEmpty")}</p> : result.checks.map((check) => <div key={check.id} className={`eval-check-item ${check.status === "failed" ? "fail" : ""}`}>{check.status === "passed" ? <IconCheck /> : check.status === "failed" ? <IconAlert /> : <IconInfo />}<div>{check.label} · {t(check.status === "passed" ? "passed" : check.status === "failed" ? "failed" : "unchecked")}<small>{check.detail}</small></div></div>)}{isFailure && <button className="eval-link" style={{ marginTop: 8 }} disabled={busy} title={t("retryHint")} onClick={onRetry}>{t("retry")}</button>}</div>
		<div className="eval-manual"><div className="eval-score-heading">{t("manual")}<span>{result.revealed ? result.rating ? t("saved") : t("skipped") : t("scoreScale")}</span></div>{task.rubric.map((item) => <div className="eval-score-row" key={item.id}><span title={item.description}>{item.label}</span>{result.revealed ? <strong>{typeof scores[item.id] === "number" ? scores[item.id] : "—"} / 5</strong> : <div className="eval-rating" role="group" aria-label={`${result.anonymousLabel} ${item.label}`}>{[1, 2, 3, 4, 5].map((score) => <button key={score} className={scores[item.id] === score ? "selected" : ""} aria-pressed={scores[item.id] === score} aria-label={t("score", { n: score })} disabled={result.status !== "completed" || busy} onClick={() => onDraft({ scores: { ...scores, [item.id]: score } })}>{score}</button>)}</div>}</div>)}{result.revealed ? result.rating?.note && <p className="eval-muted" style={{ marginTop: 9, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{result.rating.note}</p> : <textarea className="eval-score-note" aria-label={`${result.anonymousLabel} ${t("notes")}`} placeholder={t("notesPlaceholder")} disabled={result.status !== "completed" || busy} value={draft.note} maxLength={4000} onChange={(event) => onDraft({ note: event.target.value })} />}</div>
		{result.revealed && <div className="eval-result-metrics"><div><strong>{typeof result.durationMs === "number" ? t("seconds", { n: (result.durationMs / 1000).toFixed(1) }) : t("unknown")}</strong><span>{t("duration")}</span></div><div title={result.usage ? t("rawUsage", { input: result.usage.input, output: result.usage.output }) : t("unknown")}><strong>{result.usage ? result.usage.total.toLocaleString() : t("unknown")}</strong><span>{t("tokens")}</span></div><div><strong>{typeof result.costUsd === "number" ? `US$${result.costUsd.toFixed(5)}` : t("unknown")}</strong><span>{t("fee")}</span></div></div>}
		{result.revealed && result.actualModel && <details className="eval-model-meta"><summary>{result.actualModel.responseModel && result.actualModel.responseModel !== result.actualModel.modelId ? t("modelMismatch", { model: result.actualModel.responseModel }) : t("actualRequest")}</summary><div><span>{t("actualRequest")}</span><code>{result.actualModel.provider} / {result.actualModel.modelId}</code></div><div><span>{t("responseModel")}</span><code>{result.actualModel.responseModel ?? t("unknown")}</code></div><div><span>{t("forwardedThinking")}</span><code>{result.actualModel.providerThinkingLevel ?? result.actualModel.forwardedThinkingLevel ?? t("providerDefault")}</code></div></details>}
	</article>;
}
