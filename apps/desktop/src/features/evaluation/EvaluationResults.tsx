import { EvaluationResultCard } from "./EvaluationResultCard.tsx";
import { useEffect, useRef, useState } from "react";
import type { EvaluationArtifact, EvaluationRating, EvaluationResultView, EvaluationRunView, EvaluationTask } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";
import { FINISHED_STATUSES, groupResults } from "./evaluation-model.ts";
import { evaluationConversations, type EvaluationConversationState } from "./evaluation-conversation.ts";
import { IconCheck, IconLock } from "./EvaluationIcons.tsx";

export function EvaluationResults({ run, task, sample, busy, t, onSample, onDetails, onReveal, onRetry, onExpand, onAppend, onCancel, onSummary, onSend, onCancelFollowup, onExternal }: {
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
	onSend: (result: EvaluationResultView, prompt: string) => Promise<void>;
	onCancelFollowup: (result: EvaluationResultView, followupId: string) => Promise<void>;
	onExternal: (url: string) => void;
}): React.JSX.Element {
	const [drafts, setDrafts] = useState<Record<string, EvaluationRating>>({});
	const [validation, setValidation] = useState("");
	const [selectedAttempts, setSelectedAttempts] = useState<Record<string, string>>({});
	const [focusedRoot, setFocusedRoot] = useState<string>();
	const conversationState = useRef(new Map<string, EvaluationConversationState>());
	const attemptCounts = useRef(new Map<string, number>());
	useEffect(() => setValidation(""), [task.id, sample]);
	useEffect(() => setFocusedRoot(undefined), [task.id, sample]);
	const group = run.groups.find((item) => item.taskId === task.id && item.sample === sample);
	const results = groupResults(run, task.id, sample);
	const conversations = evaluationConversations(results);
	useEffect(() => {
		const updates: Record<string, string> = {};
		for (const conversation of conversations) {
			const count = attemptCounts.current.get(conversation.root.id);
			if (count !== undefined && count < conversation.attempts.length) updates[conversation.root.id] = conversation.attempts[conversation.attempts.length - 1].id;
			attemptCounts.current.set(conversation.root.id, conversation.attempts.length);
		}
		if (Object.keys(updates).length) setSelectedAttempts((previous) => ({ ...previous, ...updates }));
	}, [conversations]);
	const successes = results.filter((result) => result.status === "completed");
	const ready = results.length > 0 && results.every((result) => FINISHED_STATUSES.has(result.status));
	const revealed = group?.revealed === true;
	const completedCount = run.results.filter((result) => FINISHED_STATUSES.has(result.status)).length;
	const updateDraft = (result: EvaluationResultView, update: Partial<EvaluationRating>) => setDrafts((previous) => ({ ...previous, [result.id]: { ...(previous[result.id] ?? result.rating ?? { scores: {}, note: "" }), ...update } }));
	const reveal = (mode: "score" | "skip") => {
		const ratings = Object.fromEntries(successes.map((result) => [result.id, drafts[result.id] ?? result.rating ?? { scores: {}, note: "" }]));
		const incomplete = successes.filter((result) => task.rubric.some((item) => !ratings[result.id].scores[item.id]));
		if (mode === "score" && (successes.length === 0 || incomplete.length > 0)) { setValidation(`${t("incompleteScores")} ${incomplete.map((result) => `${t("result", { letter: result.anonymousLabel })} (${t("attempt", { n: result.attempt })})`).join("、")}`); return; }
		setValidation("");
		onReveal(mode, ratings);
	};
	return <div className="eval-conversation-workspace">
		<div className="eval-result-head"><div className="eval-crumb">{run.name} / {t("results")}</div><div className="eval-toolbar"><h2 className="eval-page-title">{task.title}</h2><span className="eval-pill">{task.id}</span><span className="eval-pill">{t(task.category)}</span><span className="eval-spacer" /><button className="eval-button" onClick={onSummary}>{t("summary")}</button></div><p className="eval-page-description">{t("scope", { tasks: run.tasks.length, profiles: run.profileCount, samples: run.samples })} · {t("progress", { done: completedCount, total: run.results.length })}</p>
			<div className="eval-result-controls"><select className="eval-field" aria-label={t("samples")} value={sample} onChange={(event) => { setValidation(""); onSample(Number(event.target.value)); }}>{Array.from({ length: run.samples }, (_, index) => index + 1).map((number) => <option key={number} value={number}>{t("sample", { n: number })}</option>)}</select><button className="eval-button" onClick={onDetails}>{t("rubric")}</button><span className="eval-spacer" />{run.samples < 3 && <button className="eval-button" disabled={busy || run.status === "running"} onClick={() => onAppend(3)}>{t("appendThree")}</button>}{run.samples < 5 && <button className="eval-button" disabled={busy || run.status === "running"} onClick={() => onAppend(5)}>{t("appendFive")}</button>}{run.status === "running" && <button className="eval-button danger" disabled={busy} onClick={onCancel}>{t("cancel")}</button>}</div>
			{run.status === "running" && <div className="eval-progress" role="progressbar" aria-valuenow={completedCount} aria-valuemin={0} aria-valuemax={run.results.length}><span style={{ width: `${run.results.length ? completedCount / run.results.length * 100 : 0}%` }} /></div>}
		</div>
		<div className="eval-notice">{revealed ? <IconCheck /> : <IconLock />}<div><strong>{revealed ? t("revealed") : t("anonymous")}</strong><small>{revealed ? t("revealHint") : t("anonymousHint")}</small></div></div>
		<div className={`eval-result-grid${focusedRoot ? " is-focused" : ""}`}>{conversations.map((conversation) => {
			const result = conversation.attempts.find((item) => item.id === selectedAttempts[conversation.root.id]) ?? conversation.attempts[conversation.attempts.length - 1];
			let uiState = conversationState.current.get(result.id);
			if (!uiState) { uiState = { draft: "", scrollTop: 0, following: true, thinkingOpen: {} }; conversationState.current.set(result.id, uiState); }
			return <div className="eval-chat-column" hidden={!!focusedRoot && focusedRoot !== conversation.root.id} key={conversation.root.id}><EvaluationResultCard key={result.id} result={result} group={conversation} task={task} busy={busy} uiState={uiState} focused={focusedRoot === conversation.root.id} onFocus={() => setFocusedRoot((current) => current === conversation.root.id ? undefined : conversation.root.id)} onAttempt={(id) => setSelectedAttempts((previous) => ({ ...previous, [conversation.root.id]: id })) draft={drafts[result.id] ?? result.rating ?? { scores: {}, note: "" }} t={t} onDraft={(update) => updateDraft(result, update)} onRetry={() => onRetry(result)} onExpand={onExpand} onSend={(prompt) => onSend(result, prompt)} onCancelFollowup={(id) => onCancelFollowup(result, id)} onExternal={onExternal} /></div>;
		})}</div>
		{results.length === 0 && <div className="eval-empty">{t("loading")}</div>}
		<div className="eval-compare-foot"><span className="eval-muted" role={validation ? "alert" : undefined}>{validation || (revealed ? t("revealHint") : !ready ? t("notReady") : successes.length === 0 ? t("nothingToScore") : t("anonymousHint"))}</span><span className="eval-spacer" />{!revealed && <><button className="eval-button" disabled={busy || !ready} onClick={() => reveal("skip")}>{t("skipReveal")}</button><button className="eval-button primary" disabled={busy || !ready || successes.length === 0} onClick={() => reveal("score")}>{busy ? t("busy") : t("submitReveal")}</button></>}</div>
	</div>;
}
