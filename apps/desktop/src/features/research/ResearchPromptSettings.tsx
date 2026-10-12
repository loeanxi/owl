import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { inferResearchPromptModelFamilies, researchPromptModelLabel } from "../../../../../packages/coding-agent/src/core/research/prompt-models.ts";
import { getUiLanguage } from "../../i18n/index.ts";
import { useResearchText } from "./research-copy.ts";
import { MAX_RESEARCH_PROMPT_CONTENT_LENGTH, MAX_RESEARCH_PROMPT_COUNT, MAX_RESEARCH_PROMPT_FILE_BYTES, promptLibraryError, researchPromptModelOptions, type ResearchPromptController, visibleResearchPrompts } from "./research-prompts.ts";
import "./research-prompts.css";

export function ResearchPromptSettings({ controller, running, onClose }: { controller: ResearchPromptController; running: boolean; onClose: () => void }): React.JSX.Element {
	const text = useResearchText();
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	const id = useId();
	const closeButton = useRef<HTMLButtonElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const [removeId, setRemoveId] = useState<string>();
	const visiblePresets = visibleResearchPrompts(state);
	const selected = visiblePresets.find((preset) => preset.id === state.selectedId);
	const modelOptions = researchPromptModelOptions(state.draft.presets);
	const selectedModels = selected ? inferResearchPromptModelFamilies(selected) : [];
	const activePreset = state.saved?.presets.find((preset) => preset.id === state.saved?.activePresetId);
	const editable = state.ready && !state.busy;
	const writable = editable && state.connected;
	const validationError = promptLibraryError(state.draft);
	const canApply = writable && Boolean(selected?.content.trim()) && !validationError;
	useEffect(() => { closeButton.current?.focus(); }, []);
	useEffect(() => { setRemoveId(undefined); }, [state.selectedId]);
	const importFile = async (file: File): Promise<void> => {
		if (file.size > MAX_RESEARCH_PROMPT_FILE_BYTES) { controller.reportError(new Error(text("promptFileTooLarge", { size: MAX_RESEARCH_PROMPT_FILE_BYTES / 1_000_000 }))); return; }
		try { controller.import(await file.text(), file.name); }
		catch (error) { controller.reportError(error); }
	};
	return <aside className="research-prompts-panel" aria-labelledby={`${id}-title`}>
		<header><h2 id={`${id}-title`}>{text("promptManage")}</h2><button ref={closeButton} type="button" onClick={onClose}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m9 5-5 5 5 5M4 10h12" /></svg>{text("promptClose")}</button></header>
		<div className="research-prompts-body" aria-busy={state.busy}>
			<p className="research-prompts-scope">{text("promptScope")}</p>
			{running && <p className="research-prompts-hint" role="status">{text("promptRunning")}</p>}
			{!state.connected && <p className="research-prompts-feedback" role="status">{text("disconnected")}</p>}
			{!state.ready && !state.error && state.connected && <p className="research-prompts-feedback" role="status">{text("promptLoading")}</p>}
			{state.error && <div className="research-prompts-feedback" role="alert"><p>{state.error}</p>{state.connected && <button type="button" disabled={state.busy} onClick={() => void controller.load()}>{text("promptRetry")}</button>}</div>}
			{state.notice && <div className="research-prompts-feedback" role="status"><p>{text(state.notice, { path: state.exportedPath ?? "" })}</p>{state.notice === "promptExported" && <button type="button" disabled={!state.connected} onClick={() => void controller.revealExport()}>{text("promptOpenLocation")}</button>}</div>}
			{state.ready && validationError && !state.error && <p className="research-prompts-feedback" role="status">{validationError}</p>}
			{state.ready && <>
				<div className="research-prompts-enable"><label><input type="checkbox" checked={Boolean(state.saved?.enabled)} disabled={!writable || (!state.saved?.enabled && !canApply)} onChange={(event) => void (event.target.checked ? controller.apply() : controller.restore())} /><span>{text("promptEnable")}</span></label><p>{state.saved?.enabled && activePreset ? text("promptEnabled", { name: activePreset.name }) : text("promptDefault")}</p><small>{text("promptEnableHint")}</small></div>
				<div className="research-prompts-filters">
					<label htmlFor={`${id}-model-filter`}>{text("promptModelFilter")}</label><select id={`${id}-model-filter`} value={state.modelFilter} disabled={!editable} onChange={(event) => controller.setFilters({ modelFilter: event.target.value })}><option value="all">{text("promptAllModels")}</option>{modelOptions.map((family) => <option key={family} value={family}>{researchPromptModelLabel(family, getUiLanguage())} ({state.draft.presets.filter((preset) => inferResearchPromptModelFamilies(preset).includes(family)).length})</option>)}</select>
					<label htmlFor={`${id}-search`}>{text("promptSearch")}</label><input id={`${id}-search`} type="search" value={state.searchQuery} placeholder={text("promptSearchPlaceholder")} disabled={!editable} onChange={(event) => controller.setFilters({ searchQuery: event.target.value })} />
					<div className="research-prompts-filter-summary"><span aria-live="polite">{text("promptFilteredCount", { shown: visiblePresets.length, total: state.draft.presets.length })}</span>{(state.modelFilter !== "all" || state.searchQuery !== "") && <button type="button" disabled={!editable} onClick={() => controller.resetFilters()}>{text("promptResetFilters")}</button>}</div>
				</div>
				<div className="research-prompts-picker"><label htmlFor={`${id}-preset`}>{text("promptPreset")}</label><div><select id={`${id}-preset`} value={state.selectedId ?? ""} disabled={!editable || visiblePresets.length === 0} onChange={(event) => controller.select(event.target.value)}>{state.selectedId === null && <option value="">{text("promptPreset")}</option>}{visiblePresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name || text("promptNewName")}{preset.id === state.saved?.activePresetId && state.saved.enabled ? " *" : ""}</option>)}</select><button type="button" disabled={!editable || state.draft.presets.length >= MAX_RESEARCH_PROMPT_COUNT} onClick={() => controller.add()}>{text("promptAdd")}</button></div></div>
				{selected ? <div className="research-prompts-editor">
					<label htmlFor={`${id}-name`}>{text("promptName")}</label><input id={`${id}-name`} value={selected.name} maxLength={120} disabled={!editable} onChange={(event) => controller.edit({ name: event.target.value })} />
					<details className="research-prompts-model-editor"><summary>{text("promptModelsSummary", { models: selectedModels.map((family) => researchPromptModelLabel(family, getUiLanguage())).join(getUiLanguage() === "zh" ? "、" : ", ") })}<small>{text("promptEditModels")}</small></summary><fieldset className="research-prompts-models" disabled={!editable} aria-describedby={`${id}-models-hint`}><legend>{text("promptModels")}</legend><div>{modelOptions.map((family) => <label key={family}><input type="checkbox" value={family} checked={selectedModels.includes(family)} onChange={(event) => { const next = event.target.checked ? family === "general" ? ["general"] : [...selectedModels.filter((value) => value !== "general"), family] : selectedModels.filter((value) => value !== family); controller.edit({ modelFamilies: next.length ? next : ["general"] }); }} /><span>{researchPromptModelLabel(family, getUiLanguage())}</span></label>)}</div><small id={`${id}-models-hint`}>{text("promptModelsHint")}</small></fieldset></details>
					<label htmlFor={`${id}-content`}>{text("promptContent")}</label><textarea id={`${id}-content`} className="research-prompts-text" value={selected.content} maxLength={MAX_RESEARCH_PROMPT_CONTENT_LENGTH} disabled={!editable} aria-describedby={`${id}-content-hint`} spellCheck={false} onChange={(event) => controller.edit({ content: event.target.value })} /><small id={`${id}-content-hint`}>{text("promptContentHint")}</small>
					<label htmlFor={`${id}-description`}>{text("promptDescription")}</label><input id={`${id}-description`} value={selected.description ?? ""} maxLength={2_000} disabled={!editable} onChange={(event) => controller.edit({ description: event.target.value })} />
					<label htmlFor={`${id}-source`}>{text("promptSource")}</label><input id={`${id}-source`} type="url" placeholder="https://github.com/…" value={selected.sourceUrl ?? ""} maxLength={2_048} disabled={!editable} onChange={(event) => controller.edit({ sourceUrl: event.target.value })} />
					{state.saved?.enabled && state.saved.activePresetId === selected.id && state.dirty && <p className="research-prompts-hint">{text("promptActiveEdit")}</p>}
					{removeId === selected.id ? <div className="research-prompts-delete-confirm"><p>{text("promptRemoveConfirm", { name: selected.name || text("promptNewName") })}</p><button type="button" disabled={!editable} onClick={() => { controller.removeSelected(); setRemoveId(undefined); }}>{text("promptConfirmRemove")}</button><button type="button" onClick={() => setRemoveId(undefined)}>{text("promptCancel")}</button></div> : <button className="research-prompts-delete" type="button" disabled={!editable} onClick={() => setRemoveId(selected.id)}>{text("promptRemove")}</button>}
				</div> : state.draft.presets.length === 0 ? <p className="research-prompts-empty">{text("promptEmpty")}</p> : <div className="research-prompts-empty"><p>{text(visiblePresets.length ? "promptChoosePrompt" : "promptNoMatches")}</p><button type="button" disabled={!editable} onClick={() => controller.resetFilters()}>{text("promptResetFilters")}</button></div>}
				<div className="research-prompts-transfer"><input ref={fileInput} type="file" accept=".txt,.md,.mkd,.json,text/plain,text/markdown,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} /><button type="button" disabled={!editable} onClick={() => fileInput.current?.click()}>{text("promptImport")}</button><button type="button" disabled={!writable || Boolean(validationError) || state.draft.presets.length === 0} onClick={() => void controller.exportLibrary()}>{text("promptExport")}</button><small>{text("promptImportHint")}</small></div>
				<details className="research-prompts-preview"><summary>{text("promptPreview")}</summary><pre>{state.defaultPrompt}</pre></details>
			</>}
		</div>
		<footer><span role="status">{state.busy ? text("promptBusy") : state.dirty ? text("promptUnsaved") : ""}</span><div><button type="button" disabled={!writable || !state.dirty || Boolean(validationError)} onClick={() => void controller.save()}>{text("promptSave")}</button><button className="research-prompts-primary" type="button" disabled={!canApply} onClick={() => void controller.apply()}>{text("promptApply")}</button></div><button className="research-prompts-restore" type="button" disabled={!writable || !state.saved?.enabled} onClick={() => void controller.restore()}>{text("promptRestore")}</button></footer>
	</aside>;
}
