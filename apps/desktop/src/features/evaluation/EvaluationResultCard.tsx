import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EvaluationArtifact, EvaluationFollowupView, EvaluationRating, EvaluationResultView, EvaluationTask } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";
import { conversationMarkdown, type EvaluationConversationGroup, type EvaluationConversationState } from "./evaluation-conversation.ts";
import { downloadEvaluationArtifact, FINISHED_STATUSES, isolatedPreview } from "./evaluation-model.ts";
import { evaluationProcessStage } from "./evaluation-process.ts";
import { EvaluationDialog } from "./EvaluationDialogs.tsx";
import { EvaluationElapsed } from "./EvaluationElapsed.tsx";
import { IconAlert, IconCheck, IconInfo } from "./EvaluationIcons.tsx";

type Reply = EvaluationResultView | EvaluationFollowupView;
type Drawer = { type: "rating" | "checks" } | { type: "source"; reply: Reply };

export function EvaluationResultCard({ result, group, task, draft, busy, uiState, t, focused, onFocus, onAttempt, onDraft, onRetry, onExpand, onSend, onCancelFollowup, onExternal }: {
	result: EvaluationResultView;
	group: EvaluationConversationGroup;
	task: EvaluationTask;
	draft: EvaluationRating;
	busy: boolean;
	uiState: EvaluationConversationState;
	t: EvaluationText;
	focused: boolean;
	onFocus: () => void;
	onAttempt: (id: string) => void;
	onDraft: (update: Partial<EvaluationRating>) => void;
	onRetry: () => void;
	onExpand: (artifact: EvaluationArtifact) => void;
	onSend: (prompt: string) => Promise<void>;
	onCancelFollowup: (followupId: string) => Promise<void>;
	onExternal: (url: string) => void;
}): React.JSX.Element {
	const [drawer, setDrawer] = useState<Drawer>();
	const [prompt, setPrompt] = useState(uiState.draft);
	const [pending, setPending] = useState(false);
	const [messageError, setMessageError] = useState("");
	const [paused, setPaused] = useState(!uiState.following);
	const messages = useRef<HTMLDivElement>(null);
	const followups = result.followups ?? [];
	const currentFollowup = followups.find((item) => item.status === "queued" || item.status === "running");
	const liveReply = currentFollowup ?? followups[followups.length - 1] ?? result;
	const stage = evaluationProcessStage(liveReply);
	const generating = liveReply.status === "queued" || liveReply.status === "running";
	const profileName = result.revealed && result.profile ? t("modelConfig", { model: result.profile.model.name, level: result.profile.thinkingLevel === "default" ? t("defaultThinking") : result.profile.thinkingLevel }) : t("result", { letter: result.anonymousLabel });
	const scores = result.revealed ? result.rating?.scores ?? {} : draft.scores;
	const ratingComplete = task.rubric.every((item) => typeof scores[item.id] === "number");
	const canSend = FINISHED_STATUSES.has(result.status) && result.output.trim().length > 0 && !currentFollowup && !busy && !pending && followups.length < 20;
	const contentRevision = `${result.thinking}\u0000${result.output}\u0000${result.status}\u0000${followups.map((item) => `${item.id}:${item.status}:${item.thinking}:${item.output}`).join("\u0000")}`;
	const followBottom = () => {
		uiState.following = true;
		setPaused(false);
		if (messages.current) messages.current.scrollTop = messages.current.scrollHeight;
	};
	useLayoutEffect(() => {
		const element = messages.current;
		if (element) element.scrollTop = uiState.following ? element.scrollHeight : uiState.scrollTop;
	}, [contentRevision, uiState]);
	const send = async () => {
		const text = prompt.trim();
		if (!canSend || !text) return;
		setPending(true);
		setMessageError("");
		try { await onSend(text); uiState.draft = ""; setPrompt(""); followBottom(); }
		catch (cause) { setMessageError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setPending(false); }
	};
	return <article className={`eval-result-card eval-chat-window${focused ? " is-focused" : ""}`} data-result-id={result.id} data-conversation-root={group.root.id} data-fd-id={`evaluation-chat-${group.root.anonymousLabel.toLowerCase()}`}>
		<header className="eval-result-top eval-chat-header"><div className="eval-result-avatar">{result.anonymousLabel}</div><div className="eval-chat-name"><div className="eval-result-name" title={profileName}>{profileName}</div><div className="eval-result-caption">{t("independentConversation")} · {t("sample", { n: result.sample })}{result.id !== group.root.id ? ` · ${t("retryOrigin", { letter: group.root.anonymousLabel })}` : ""}</div></div><span className="eval-spacer" /><span className={`eval-chat-status${generating ? " is-generating" : ""}`} data-generation-phase={stage}>{generating ? <i className="eval-waiting-indicator" aria-hidden="true" /> : liveReply.status === "completed" ? <IconCheck /> : <IconAlert />}{t(stage === "waiting" ? "running" : stage)}</span><button className="eval-chat-focus" aria-label={focused ? t("restoreConversations") : t("focusConversation")} title={focused ? t("restoreConversations") : t("focusConversation")} onClick={onFocus}>{focused ? "↙" : "⤢"}</button></header>
		{group.attempts.length > 1 && <div className="eval-attempt-bar"><label>{t("attemptHistory")}<select className="eval-field" data-action="attempt" aria-label={`${t("attemptHistory")} ${group.root.anonymousLabel}`} value={result.id} onChange={(event) => onAttempt(event.target.value)}>{group.attempts.map((item) => <option key={item.id} value={item.id}>{t("result", { letter: item.anonymousLabel })} · {t("attempt", { n: item.attempt })} · {t(item.status)}</option>)}</select></label></div>}
		<div ref={messages} className="eval-messages eval-stream-scroll" data-fd-id={`evaluation-messages-${group.root.anonymousLabel.toLowerCase()}`} role="region" aria-label={`${t("conversationMessages")} ${result.anonymousLabel}`} data-live-output={generating ? "true" : undefined} onScroll={(event) => { const element = event.currentTarget; uiState.scrollTop = element.scrollTop; uiState.following = element.scrollHeight - element.scrollTop - element.clientHeight <= 32; setPaused(!uiState.following); }} onClick={(event) => { const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]"); if (link) { event.preventDefault(); if (/^https?:\/\//i.test(link.href)) onExternal(link.href); } }}>
			<div className="eval-chat-message eval-user-message"><div className="eval-user-bubble"><small>{t("benchmarkPrompt")}</small><div>{task.prompt}</div>{task.input && <details className="eval-fixed-input"><summary>{t("fixedInput")}</summary><pre>{task.input}</pre></details>}</div></div>
			<EvaluationReply result={result} reply={result} t={t} uiState={uiState} benchmark artifactAnchor={`evaluation-artifact-${group.root.anonymousLabel.toLowerCase()}`} onSource={() => setDrawer({ type: "source", reply: result })} onExpand={onExpand} onRetry={onRetry} busy={busy} />
			{followups.length > 0 && <div className="eval-followup-divider">{t("followupScope")}</div>}
			{followups.map((reply) => <div key={reply.id} data-followup-id={reply.id}><div className="eval-chat-message eval-user-message"><div className="eval-user-bubble">{reply.prompt}</div></div><EvaluationReply result={result} reply={reply} t={t} uiState={uiState} onSource={() => setDrawer({ type: "source", reply })} onExpand={onExpand} busy={busy} /></div>)}
			{paused && <button className="eval-follow-bottom" onClick={followBottom}>{t("followOutput")} ↓</button>}
		</div>
		<div className="eval-composer" data-fd-id={`evaluation-composer-${group.root.anonymousLabel.toLowerCase()}`}><div className="eval-composer-input"><textarea data-fd-id={`evaluation-input-${group.root.anonymousLabel.toLowerCase()}`} aria-label={t("followupPlaceholder", { letter: result.anonymousLabel })} placeholder={!FINISHED_STATUSES.has(result.status) ? t("followupWait") : !result.output.trim() ? t("followupNoBody") : followups.length >= 20 ? t("followupLimit") : t("followupPlaceholder", { letter: result.anonymousLabel })} value={prompt} maxLength={10000} disabled={busy || pending || !FINISHED_STATUSES.has(result.status) || !result.output.trim() || followups.length >= 20} onChange={(event) => { uiState.draft = event.target.value; setPrompt(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="eval-composer-actions"><span>{t("followupCostHint")}</span><span className="eval-spacer" />{currentFollowup ? <button className="eval-chat-stop" data-action="cancel-followup" disabled={busy || pending} aria-label={t("stopFollowup")} title={t("stopFollowup")} onClick={async () => { setPending(true); setMessageError(""); try { await onCancelFollowup(currentFollowup.id); } catch (cause) { setMessageError(cause instanceof Error ? cause.message : String(cause)); } finally { setPending(false); } }}>■</button> : <button className="eval-send" data-action="send-followup" disabled={!canSend || !prompt.trim()} aria-label={t("sendFollowup", { letter: result.anonymousLabel })} onClick={() => { void send(); }}>↑</button>}</div></div>{messageError && <p className="eval-chat-local-error" role="alert">{messageError}</p>}</div>
		<footer className="eval-window-footer"><button className="eval-check-link" data-action="checks" onClick={() => setDrawer({ type: "checks" })}>{result.checks.length > 0 ? result.checks.some((item) => item.status === "failed") ? <IconAlert /> : result.checks.every((item) => item.status === "passed") ? <IconCheck /> : <IconInfo /> : <IconInfo />}{FINISHED_STATUSES.has(result.status) && result.status !== "completed" ? t("failureInfo") : t("automatic")}</button><span className="eval-spacer" /><button className="eval-score-link" data-action="rating" data-fd-id={`evaluation-score-${group.root.anonymousLabel.toLowerCase()}`} disabled={result.status !== "completed"} onClick={() => setDrawer({ type: "rating" })}>{ratingComplete ? "★ " : "☆ "}{ratingComplete ? result.revealed ? t("saved") : t("scoreDrafted") : t("reviewBenchmark")}</button></footer>
		{drawer && <div className="eval-chat-drawer" data-drawer={drawer.type}><EvaluationDialog title={drawer.type === "rating" ? `${t("reviewBenchmark")} · ${result.anonymousLabel}` : drawer.type === "checks" ? `${t("automatic")} · ${result.anonymousLabel}` : `${t("source")} · ${result.anonymousLabel}`} onClose={() => setDrawer(undefined)} footer={<button className="eval-button primary" onClick={() => setDrawer(undefined)}>{drawer.type === "rating" && !result.revealed ? t("keepScores") : t("close")}</button>}>
			{drawer.type === "rating" ? <><p className="eval-drawer-description">{t("ratingScope", { sample: result.sample, attempt: result.attempt })}</p><div className="eval-manual"><div className="eval-score-heading">{t("manual")}<span>{result.revealed ? result.rating ? t("saved") : t("skipped") : t("scoreScale")}</span></div>{task.rubric.map((item) => <div className="eval-score-row" key={item.id}><div><strong>{item.label}</strong><small>{item.description}</small></div>{result.revealed ? <strong>{typeof scores[item.id] === "number" ? scores[item.id] : "—"} / 5</strong> : <div className="eval-rating" role="group" aria-label={`${result.anonymousLabel} ${item.label}`}>{[1, 2, 3, 4, 5].map((score) => <button key={score} className={scores[item.id] === score ? "selected" : ""} aria-pressed={scores[item.id] === score} aria-label={t("score", { n: score })} disabled={busy} onClick={() => onDraft({ scores: { ...scores, [item.id]: score } })}>{score}</button>)}</div>}</div>)}{result.revealed ? result.rating?.note && <p className="eval-drawer-description">{result.rating.note}</p> : <textarea className="eval-score-note" aria-label={`${result.anonymousLabel} ${t("notes")}`} placeholder={t("notesPlaceholder")} disabled={busy} value={draft.note} maxLength={4000} onChange={(event) => onDraft({ note: event.target.value })} />}</div></>
				: drawer.type === "source" ? <pre className="eval-source-drawer">{drawer.reply.artifact?.content || drawer.reply.output || t("waitingBody")}</pre>
					: <><p className="eval-drawer-description">{t("checksScope")}</p>{result.error && <p className="eval-chat-local-error">{result.error}</p>}<div className="eval-checks">{result.checks.length === 0 ? <p className="eval-muted">{t("checksEmpty")}</p> : result.checks.map((check) => <div key={check.id} className={`eval-check-item ${check.status === "failed" ? "fail" : ""}`}>{check.status === "passed" ? <IconCheck /> : check.status === "failed" ? <IconAlert /> : <IconInfo />}<div>{check.label} · {t(check.status === "passed" ? "passed" : check.status === "failed" ? "failed" : "unchecked")}<small>{check.detail}</small></div></div>)}</div>{result.revealed && <EvaluationMetrics reply={result} t={t} />}{result.revealed && result.actualModel && <details className="eval-model-meta"><summary>{result.actualModel.responseModel && result.actualModel.responseModel !== result.actualModel.modelId ? t("modelMismatch", { model: result.actualModel.responseModel }) : t("actualRequest")}</summary><div><span>{t("actualRequest")}</span><code>{result.actualModel.provider} / {result.actualModel.modelId}</code></div><div><span>{t("responseModel")}</span><code>{result.actualModel.responseModel ?? t("unknown")}</code></div><div><span>{t("forwardedThinking")}</span><code>{result.actualModel.providerThinkingLevel ?? result.actualModel.forwardedThinkingLevel ?? t("providerDefault")}</code></div></details>}</>}
		</EvaluationDialog></div>}
	</article>;
}

function EvaluationReply({ result, reply, benchmark = false, artifactAnchor, uiState, busy, t, onSource, onExpand, onRetry }: { result: EvaluationResultView; reply: Reply; benchmark?: boolean; artifactAnchor?: string; uiState: EvaluationConversationState; busy: boolean; t: EvaluationText; onSource: () => void; onExpand: (artifact: EvaluationArtifact) => void; onRetry?: () => void }): React.JSX.Element {
	const [, refreshThinking] = useState(0);
const [copyError, setCopyError] = useState("");
	const generating = reply.status === "queued" || reply.status === "running";
	const stage = evaluationProcessStage(reply);
	const thinkingOpen = uiState.thinkingOpen[reply.id] ?? (generating && !!reply.thinking);
	const artifact = reply.status === "completed" ? reply.artifact : null;
	const canPreview = !!artifact?.previewAllowed && (artifact.type === "svg" || artifact.type === "html");
	const failure = reply.status === "failed" || reply.status === "cancelled" || reply.status === "interrupted";
	const artifactContent = artifact?.content;
	const artifactType = artifact?.type;
	const answer = useMemo(() => canPreview && artifactContent ? reply.output.replace(/```(?:svg|xml|html)?\s*([\s\S]*?)```/gi, (block, content: string) => content.trim() === artifactContent.trim() ? "" : block).replace(artifactContent, "").trim() : reply.output, [canPreview, artifactContent, reply.output]);
	const markdownAnswer = useMemo(() => conversationMarkdown(answer), [answer]);
const previewHtml = useMemo(() => canPreview && artifactContent && (artifactType === "svg" || artifactType === "html") ? isolatedPreview(artifactContent, artifactType) : "", [canPreview, artifactContent, artifactType]);
const plainCode = artifact && (artifact.type === "code" || artifact.type === "json") && reply.output.trim() === artifact.content.trim();
return <div className="eval-chat-message eval-assistant-message" data-message-id={reply.id} data-benchmark-answer={benchmark ? "true" : undefined}>
		<div className="eval-assistant-label"><span className="eval-tiny-avatar">{result.anonymousLabel}</span><span>{t("result", { letter: result.anonymousLabel })}</span><span className="eval-measure-tag">{benchmark ? t("benchmarkAnswer") : t("followupAnswer")}</span></div>
		{(reply.thinking || generating) ? <details className="eval-thinking" data-message-id={reply.id} open={thinkingOpen}><summary onClick={(event) => { event.preventDefault(); uiState.thinkingOpen[reply.id] = !thinkingOpen; refreshThinking((value) => value + 1); }}>{t("returnedThinking")}<EvaluationElapsed reply={reply} t={t} /><small>{generating && stage === "thinking" ? t("receivingThinkingText") : t("toggleThinking")}</small></summary><div className="eval-thinking-body" data-process-section="thinking">{reply.thinking || (typeof reply.thinking === "string" ? t("thinkingNotReturned") : t("thinkingServiceUnavailable"))}</div></details> : <div className="eval-reply-timing"><EvaluationElapsed reply={reply} t={t} /></div>}
		{answer && (plainCode ? <pre className="eval-chat-code eval-chat-answer" data-process-section="answer">{answer}</pre> : <div className="eval-chat-answer" data-process-section="answer" dangerouslySetInnerHTML={{ __html: markdownAnswer }} />)}
		{generating && <p className="eval-chat-waiting" role="status"><i className="eval-waiting-indicator" aria-hidden="true" />{stage === "thinking" ? t("receivingThinking") : stage === "answering" ? t("streamingBody") : stage === "checking" ? t("checkingDetail") : reply.status === "queued" ? t("queueDetail") : t("waitingFirstSegment")}</p>}
		{canPreview && artifact && <div className="eval-chat-artifact" data-fd-id={artifactAnchor}><div className="eval-artifact"><iframe title={`${t("preview")} ${result.anonymousLabel}${benchmark ? "" : ` ${t("followupAnswer")}`}`} sandbox={artifact.type === "html" ? "allow-scripts allow-forms" : ""} referrerPolicy="no-referrer" srcDoc={previewHtml} /></div><div className="eval-artifact-actions"><strong>{artifact.type.toUpperCase()} · {t("preview")}</strong><span className="eval-spacer" /><button className="eval-link" data-action="source" onClick={onSource}>{t("source")}</button><button className="eval-link" onClick={() => onExpand(artifact)}>{t("expand")}</button><button className="eval-link" onClick={() => downloadEvaluationArtifact(artifact.content, `${result.taskId}-${result.anonymousLabel}-${reply.id}.${artifact.type}`, artifact.type)}>{t("download")}</button></div></div>}
		{failure && <div className="eval-chat-failure"><strong>{t(reply.status)}</strong><p>{reply.error || t("generationIncomplete")}</p>{onRetry && <button className="eval-button" disabled={busy} title={t("retryHint")} onClick={onRetry}>{t("retry")}</button>}</div>}
		{!generating && reply.output && <div className="eval-assistant-actions"><button className="eval-link" data-action="copy-answer" onClick={async () => { try { await navigator.clipboard.writeText(reply.output); setCopyError(""); } catch { setCopyError(t("copyFailed")); } }}>{t("copyAnswer")}</button><button className="eval-link" data-action="source" onClick={onSource}>{t("source")}</button>{artifact && !canPreview && <button className="eval-link" onClick={() => downloadEvaluationArtifact(artifact.content, `${result.taskId}-${result.anonymousLabel}-${reply.id}.${artifact.type === "code" ? "txt" : artifact.type}`, artifact.type)}>{t("download")}</button>}</div>}
		{copyError && <p className="eval-chat-local-error" role="alert">{copyError}</p>}
{!benchmark && result.revealed && FINISHED_STATUSES.has(reply.status) && <EvaluationMetrics reply={reply} t={t} />}
	</div>;
}

function EvaluationMetrics({ reply, t }: { reply: Reply; t: EvaluationText }): React.JSX.Element {
	return <div className="eval-result-metrics"><div><strong>{typeof reply.durationMs === "number" ? t("seconds", { n: (reply.durationMs / 1000).toFixed(1) }) : t("unknown")}</strong><span>{t("duration")}</span></div><div title={reply.usage ? t("rawUsage", { input: reply.usage.input, output: reply.usage.output }) : t("unknown")}><strong>{reply.usage ? reply.usage.total.toLocaleString() : t("unknown")}</strong><span>{t("tokens")}</span></div><div><strong>{typeof reply.costUsd === "number" ? `US$${reply.costUsd.toFixed(5)}` : t("unknown")}</strong><span>{t("fee")}</span></div></div>;
}
