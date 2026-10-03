import { EvaluationResultCard } from "./EvaluationResultCard.tsx";
import { useEffect, useState } from "react";
import type { EvaluationArtifact, EvaluationRating, EvaluationResultView, EvaluationRunView, EvaluationTask } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";
import { FINISHED_STATUSES, groupResults } from "./evaluation-model.ts";
import { evaluationConversations, type EvaluationRunUiState } from "./evaluation-conversation.ts";
import { IconCheck, IconLock } from "./EvaluationIcons.tsx";

export function EvaluationResults({ run, task, sample, busy, uiCache, t, onSample, onDetails, onReveal, onRetry, onExpand, onAppend, onCancel, onSummary, onSend, onCancelFollowup, onExternal }: {
	run: EvaluationRunView;
	task: EvaluationTask;
	sample: number;
	busy: boolean;
	uiCache: EvaluationRunUiState;
	t: EvaluationText;
	onSample: (sample: number) => void;
	onDetails: () => void;
	onReveal: (mode: "score" | "skip", ratings: Record<string, EvaluationRating>) => void;
	onRetry: (result: EvaluationResultView) => void;
	onExpand: (artifact: EvaluationArtifact) => void;
	onAppend: (samples: 3 | 5) => void;
	onCancel: () => void;
	onSummary: () => void;
	onSend: (result: EvaluationResultView, prompt: string) => Promise<void>;
	onCancelFollowup: (result: EvaluationResultView, followupId: string) => Promise<void>;
	onExternal: (url: string) => void;
}): React.JSX.Element {
	const [drafts, setDrafts] = useState(uiCache.ratings);
	const [validation, setValidation] = useState("");
	const [selectedAttempts, setSelectedAttempts] = useState(uiCache.selectedAttempts);
	const [focusedRoot, setFocusedRoot] = useState<string>();
	useEffect(() => setValidation(""), [task.id, sample]);
	useEffect(() => setFocusedRoot(undefined), [task.id, sample]);
	const group = run.groups.find((item) => item.taskId === task.id && item.sample === sample);
	const results = groupResults(run, task.id, sample);
	const conversations = evaluationConversations(results);
	useEffect(() => {
		const updates: Record<string, string> = {};
		for (const conversation of conversations) {
			const count = uiCache.attemptCounts.get(conversation.root.id);
			if (count !== undefined && count < conversation.attempts.length) updates[conversation.root.id] = conversation.attempts[conversation.attempts.length - 1].id;
			uiCache.attemptCounts.set(conversation.root.id, conversation.attempts.length);
		}
		if (Object.keys(updates).length) setSelectedAttempts((previous) => { uiCache.selectedAttempts = { ...previous, ...updates }; return uiCache.selectedAttempts; });
	}, [conversations, uiCache]);
	const successes = results.filter((result) => result.status === "completed");
	const ready = results.length > 0 && results.every((result) => FINISHED_STATUSES.has(result.status));
	const revealed = group?.revealed === true;
	const completedCount = run.results.filter((result) => FINISHED_STATUSES.has(result.status)).length;
	const updateDraft = (result: EvaluationResultView, update: Partial<EvaluationRating>) => setDrafts((previous) => { uiCache.ratings = { ...previous, [result.id]: { ...(previous[result.id] ?? result.rating ?? { scores: {}, note: "" }), ...update } }; return uiCache.ratings; });
	const reveal = (mode: "score" | "skip") => {
		const ratings = Object.fromEntries(successes.map((result) => [result.id, drafts[result.id] ?? result.rating ?? { scores: {}, note: "" }]));
		const incomplete = successes.filter((result) => task.rubric.some((item) => !ratings[result.id].scores[item.id]));
		if (mode === "score" && (successes.length === 0 || incomplete.length > 0)) { setValidation(`${t("incompleteScores")} ${incomplete.map((result) => `${t("result", { letter: result.anonymousLabel })} (${t("attempt", { n: result.attempt })})`).join("、")}`); return; }
		setValidation("");
		onReveal(mode, ratings);
	};
	return <div className="eval-conversation-workspace">
		<div className="eval-result-head"><div className="eval-toolbar eval-conversation-toolbar" data-fd-id="evaluation-task-toolbar"><div className="eval-chat-task-heading"><h2 className="eval-page-title" data-fd-id="evaluation-task-title">{task.title}</h2><p className="eval-page-description">{task.id} · {t(task.category)} / {run.name} · {t("progress", { done: completedCount, total: run.results.length })}</p></div><select className="eval-field" aria-label={t("samples")} value={sample} onChange={(event) => { setValidation(""); onSample(Number(event.target.value)); }}>{Array.from({ length: run.samples }, (_, index) => index + 1).map((number) => <option key={number} value={number}>{t("sample", { n: number })}</option>)}</select><button className="eval-button" onClick={onDetails}>{t("rubric")}</button><button className="eval-button" onClick={onSummary}>{t("summary")}</button>{!revealed && <><button className="eval-button" disabled={busy || !ready} onClick={() => reveal("skip")}>{t("skipReveal")}</button><button className="eval-button primary" disabled={busy || !ready || successes.length === 0} onClick={() => reveal("score")}>{busy ? t("busy") : t("submitReveal")}</button></>}</div>
			<div className="eval-result-controls eval-run-actions"><span className="eval-muted">{t("scope", { tasks: run.tasks.length, profiles: run.profileCount, samples: run.samples })}</span><span className="eval-spacer" />{run.samples < 3 && <button className="eval-button" disabled={busy || run.status === "running"} onClick={() => onAppend(3)}>{t("appendThree")}</button>}{run.samples < 5 && <button className="eval-button" disabled={busy || run.status === "running"} onClick={() => onAppend(5)}>{t("appendFive")}</button>}{run.status === "running" && <button className="eval-button danger" disabled={busy} onClick={onCancel}>{t("cancel")}</button>}</div>
			{run.status === "running" && <div className="eval-progress" role="progressbar" aria-valuenow={completedCount} aria-valuemin={0} aria-valuemax={run.results.length}><span style={{ width: `${run.results.length ? completedCount / run.results.length * 100 : 0}%` }} /></div>}
		</div>
		<div className="eval-notice" data-fd-id="evaluation-anonymous-note">{revealed ? <IconCheck /> : <IconLock />}<div><strong>{revealed ? t("revealHint") : t("anonymousHint")}</strong></div></div>
		<div className={`eval-result-grid${focusedRoot ? " is-focused" : ""}`}>{conversations.map((conversation) => {
			const result = conversation.attempts.find((item) => item.id === selectedAttempts[conversation.root.id]) ?? conversation.attempts[conversation.attempts.length - 1];
			let uiState = uiCache.conversations.get(result.id);
			if (!uiState) { uiState = { draft: "", scrollTop: 0, following: true, thinkingOpen: {} }; uiCache.conversations.set(result.id, uiState); }
			return <div className="eval-chat-column" hidden={!!focusedRoot && focusedRoot !== conversation.root.id} key={conversation.root.id}><EvaluationResultCard key={result.id} result={result} group={conversation} task={task} busy={busy} uiState={uiState} focused={focusedRoot === conversation.root.id} onFocus={() => setFocusedRoot((current) => current === conversation.root.id ? undefined : conversation.root.id)} onAttempt={(id) => setSelectedAttempts((previous) => { uiCache.selectedAttempts = { ...previous, [conversation.root.id]: id }; return uiCache.selectedAttempts; })} draft={drafts[result.id] ?? result.rating ?? { scores: {}, note: "" }} t={t} onDraft={(update) => updateDraft(result, update)} onRetry={() => onRetry(result)} onExpand={onExpand} onSend={(prompt) => onSend(result, prompt)} onCancelFollowup={(id) => onCancelFollowup(result, id)} onExternal={onExternal} /></div>;
		})}</div>
		{results.length === 0 && <div className="eval-empty">{t("loading")}</div>}
		{validation && <div className="eval-compare-foot"><span className="eval-muted" role="alert">{validation}</span></div>}
	</div>;
}
