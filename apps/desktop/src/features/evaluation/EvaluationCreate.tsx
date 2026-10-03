import { useEffect, useState } from "react";
import type { EvaluationModel, EvaluationProfileInput, EvaluationTask } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import { IconPlay, IconPlus, IconSearch } from "./EvaluationIcons.tsx";
import type { EvaluationText } from "./evaluation-copy.ts";
import { profileKey, QUICK_TASKS, selectProfile } from "./evaluation-model.ts";

export interface EvaluationStartInput {
	name: string;
	taskIds: string[];
	profiles: EvaluationProfileInput[];
	samples: 1 | 3 | 5;
}

export function EvaluationCreate({ tasks, models, busy, connected, initialTaskId, onStart, onDetails, onCustom, t }: {
	tasks: EvaluationTask[];
	models: EvaluationModel[];
	busy: boolean;
	connected: boolean;
	initialTaskId?: string;
	onStart: (input: EvaluationStartInput) => void;
	onDetails: (task: EvaluationTask) => void;
	onCustom: () => void;
	t: EvaluationText;
}): React.JSX.Element {
	const [selectedTasks, setSelectedTasks] = useState<string[]>(() => initialTaskId ? [initialTaskId] : QUICK_TASKS.filter((id) => tasks.some((task) => task.id === id)));
	const [profiles, setProfiles] = useState<EvaluationProfileInput[]>([]);
	const [samples, setSamples] = useState<1 | 3 | 5>(1);
	const [name, setName] = useState("");
	const [query, setQuery] = useState("");
	useEffect(() => { if (initialTaskId) setSelectedTasks((previous) => previous.includes(initialTaskId) ? previous : [...previous, initialTaskId]); }, [initialTaskId]);
	const availableTasks = selectedTasks.filter((id) => tasks.some((task) => task.id === id));
	const shown = tasks.filter((task) => `${task.id} ${task.title} ${task.prompt}`.toLowerCase().includes(query.toLowerCase()));
	const canStart = connected && !busy && availableTasks.length > 0 && profiles.length > 0 && name.trim().length > 0;
	return <div className="eval-page">
		<div className="eval-crumb">{t("title")} / {t("newRun")}</div>
		<h2 className="eval-page-title">{t("createTitle")}</h2><p className="eval-page-description">{t("createDesc")}</p>
		<div className="eval-create-grid"><div>
			<section className="eval-section"><div className="eval-toolbar" style={{ marginBottom: 12 }}><h3 className="eval-section-title" style={{ marginBottom: 0 }}><span className="eval-step">1</span>{t("selectTasks")}</h3><span className="eval-spacer" /><button className="eval-link" onClick={onCustom}><IconPlus />{t("custom")}</button></div>
				<div className="eval-pack"><IconPlay /><div><strong>{t("quickPack")}</strong><small>{t("quickPackHint")}</small></div><span className="eval-spacer" /><button className="eval-link" onClick={() => setSelectedTasks(QUICK_TASKS.filter((id) => tasks.some((task) => task.id === id)))}>{t("selectTasks")}</button></div>
				<div className="eval-search" style={{ marginBottom: 8 }}><IconSearch /><input aria-label={t("searchTasks")} placeholder={t("searchTasks")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
				<div className="eval-task-select-list">{shown.map((task) => <div key={task.id} className="eval-task-select"><input type="checkbox" id={`eval-select-${task.id}`} checked={selectedTasks.includes(task.id)} onChange={(event) => setSelectedTasks((previous) => event.target.checked ? [...previous, task.id] : previous.filter((id) => id !== task.id))} /><span className="eval-id">{task.id}</span><label htmlFor={`eval-select-${task.id}`}>{task.title}</label><span className="eval-pill">{t(task.category)}</span><button className="eval-link" aria-label={`${t("details")} ${task.title}`} onClick={() => onDetails(task)}>{t("details")}</button></div>)}{shown.length === 0 && <p className="eval-muted">{t("noTasks")}</p>}</div>
				<div className="eval-toolbar" style={{ marginTop: 10 }}><span className="eval-muted">{t("selected", { n: availableTasks.length })}</span><span className="eval-spacer" /><button className="eval-link" onClick={() => setSelectedTasks([])}>{t("clear")}</button></div>
			</section>
			<section className="eval-section"><h3 className="eval-section-title"><span className="eval-step">2</span>{t("selectModels")}</h3>
				{models.length === 0 && <div className="eval-empty" style={{ padding: "25px 5px" }}><strong>{t("noModels")}</strong><p>{t("noModelsHint")}</p></div>}
				{models.map((model) => <div className="eval-model-choice" key={profileKey(model.provider, model.modelId, "default")}><strong>{model.name}</strong><small>{model.sourceName} · {model.provider} / {model.modelId}</small><div className="eval-model-levels">{[...new Set(["default" as const, ...model.supportedThinkingLevels])].map((level) => {
					const id = profileKey(model.provider, model.modelId, level);
					const selected = profiles.some((profile) => profile.id === id);
					return <label key={level} className={selected ? "selected" : ""}><input type="checkbox" checked={selected} onChange={(event) => setProfiles((previous) => selectProfile(previous, { id, provider: model.provider, modelId: model.modelId, thinkingLevel: level }, event.target.checked))} />{level === "default" ? t("defaultThinking") : level}</label>;
				})}</div>{model.supportedThinkingLevels.length === 0 && <small>{t("unsupportedThinking")}</small>}</div>)}
			</section>
		</div><aside><section className="eval-config"><h3 className="eval-section-title"><span className="eval-step">3</span>{t("runConfig")}</h3><label htmlFor="eval-name">{t("runName")}</label><input id="eval-name" className="eval-field" placeholder={t("runNamePlaceholder")} value={name} onChange={(event) => setName(event.target.value)} maxLength={160} />
			<label>{t("samples")}</label><div className="eval-segment" role="group" aria-label={t("samples")}>{([1, 3, 5] as const).map((count) => <button key={count} aria-pressed={samples === count} className={samples === count ? "active" : ""} onClick={() => setSamples(count)}>{count}</button>)}</div>
			<div className="eval-config-stats"><div className="eval-config-row"><span>{t("tasksCount")}</span><strong>{availableTasks.length}</strong></div><div className="eval-config-row"><span>{t("profilesCount")}</span><strong>{profiles.length}</strong></div><div className="eval-config-row"><span>{t("calls")}</span><strong>{availableTasks.length * profiles.length * samples}</strong></div><div className="eval-config-row"><span>{t("estimatedCost")}</span><strong>{t("unknown")}</strong></div></div>
			<p className="eval-config-note">{t("costHint")}</p><button className="eval-button primary" disabled={!canStart} onClick={() => onStart({ name: name.trim(), taskIds: availableTasks, profiles, samples })}><IconPlay />{busy ? t("busy") : t("start")}</button><p className="eval-config-note">{t("startHint")}</p>
		</section><p className="eval-config-guide">{t("directHint")}</p></aside></div>
	</div>;
}
