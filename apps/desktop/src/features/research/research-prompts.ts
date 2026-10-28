import {
	filterResearchPromptPresets,
	inferResearchPromptModelFamilies,
	RESEARCH_PROMPT_LIMITS,
	RESEARCH_PROMPT_MODEL_FAMILIES,
} from "../../../../../packages/coding-agent/src/core/research/prompt-models.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import type {
	ResearchPromptPreset,
	ResearchPromptSettings,
	ResearchPromptsExportResult,
	ResearchPromptsResult,
} from "../../bridge/protocol.ts";
import { researchText } from "./research-copy.ts";

type PromptBridge = Pick<BridgeClient, "request">;
export type ResearchPromptState = {
	connected: boolean;
	ready: boolean;
	busy: boolean;
	draft: ResearchPromptSettings;
	saved?: ResearchPromptSettings;
	defaultPrompt: string;
	selectedId: string | null;
	modelFilter: string;
	searchQuery: string;
	dirty: boolean;
	error?: string;
	exportedPath?: string;
	notice?:
		| "promptSaved"
		| "promptApplied"
		| "promptRestored"
		| "promptImported"
		| "promptImportedFiltered"
		| "promptFiltersReset"
		| "promptExported";
};

export function visibleResearchPrompts(state: ResearchPromptState): ResearchPromptPreset[] {
	return filterResearchPromptPresets(state.draft.presets, {
		modelFamily: state.modelFilter,
		search: state.searchQuery,
	});
}

export function researchPromptModelOptions(presets: ResearchPromptPreset[]): string[] {
	return [
		...new Set([
			...RESEARCH_PROMPT_MODEL_FAMILIES.map((family) => family.id),
			...presets.flatMap(inferResearchPromptModelFamilies),
		]),
	];
}

export const MAX_RESEARCH_PROMPT_COUNT = RESEARCH_PROMPT_LIMITS.presets;
export const MAX_RESEARCH_PROMPT_CONTENT_LENGTH = RESEARCH_PROMPT_LIMITS.contentChars;
export const MAX_RESEARCH_PROMPT_FILE_BYTES = RESEARCH_PROMPT_LIMITS.fileBytes;

export function promptLibraryError(settings: ResearchPromptSettings, applyingId?: string | null): string | undefined {
	if (settings.presets.length > MAX_RESEARCH_PROMPT_COUNT)
		return researchText("promptLimit", { count: MAX_RESEARCH_PROMPT_COUNT });
	for (const preset of settings.presets) {
		if (!preset.name.trim() || preset.name.length > 120) return researchText("promptNameRequired");
		if (preset.content.length > MAX_RESEARCH_PROMPT_CONTENT_LENGTH || (preset.description?.length ?? 0) > 2_000)
			return researchText("promptTooLong", { count: MAX_RESEARCH_PROMPT_CONTENT_LENGTH });
		if (
			preset.modelFamilies !== undefined &&
			(preset.modelFamilies.length === 0 ||
				preset.modelFamilies.length > RESEARCH_PROMPT_LIMITS.modelFamilies ||
				new Set(preset.modelFamilies).size !== preset.modelFamilies.length ||
				preset.modelFamilies.some(
					(family) => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(family) || family.length > 64,
				))
		)
			return researchText("promptModelsInvalid");
		if (preset.sourceUrl) {
			try {
				const url = new URL(preset.sourceUrl);
				if (
					!["http:", "https:"].includes(url.protocol) ||
					url.username ||
					url.password ||
					preset.sourceUrl.length > 2_048
				)
					return researchText("promptSourceInvalid");
			} catch {
				return researchText("promptSourceInvalid");
			}
		}
	}
	if (new TextEncoder().encode(JSON.stringify(settings)).byteLength > MAX_RESEARCH_PROMPT_FILE_BYTES)
		return researchText("promptFileTooLarge", { size: MAX_RESEARCH_PROMPT_FILE_BYTES / 1_000_000 });
	if (settings.enabled && !settings.presets.find((preset) => preset.id === settings.activePresetId)?.content.trim())
		return researchText("promptActiveEmpty");
	if (applyingId !== undefined && !settings.presets.find((preset) => preset.id === applyingId)?.content.trim())
		return researchText("promptContentRequired");
	return undefined;
}

/** Imports only prompt text and metadata. Files cannot enable an override or replace an existing preset. */
export function importedResearchPrompts(
	value: string,
	filename: string,
	createId: () => string,
): ResearchPromptPreset[] {
	const name =
		filename
			.replace(/\.[^.]+$/, "")
			.trim()
			.slice(0, 120) || researchText("promptNewName");
	if (!filename.toLowerCase().endsWith(".json")) return [{ id: createId(), name, content: value }];
	let data: unknown;
	try {
		data = JSON.parse(value);
	} catch {
		throw new Error(researchText("promptImportInvalid"));
	}
	const object =
		data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
	const settings =
		object?.settings && typeof object.settings === "object"
			? (object.settings as Record<string, unknown>)
			: undefined;
	const items = Array.isArray(data)
		? data
		: Array.isArray(object?.presets)
			? object.presets
			: Array.isArray(settings?.presets)
				? settings.presets
				: object
					? [object]
					: [];
	if (items.length === 0 || items.length > MAX_RESEARCH_PROMPT_COUNT)
		throw new Error(researchText("promptImportInvalid"));
	return items.map((item: unknown) => {
		if (!item || typeof item !== "object") throw new Error(researchText("promptImportInvalid"));
		const preset = item as Record<string, unknown>;
		if (
			typeof preset.name !== "string" ||
			typeof preset.content !== "string" ||
			(preset.description !== undefined && typeof preset.description !== "string") ||
			(preset.sourceUrl !== undefined && typeof preset.sourceUrl !== "string") ||
			(preset.modelFamilies !== undefined &&
				(!Array.isArray(preset.modelFamilies) || preset.modelFamilies.some((family) => typeof family !== "string")))
		)
			throw new Error(researchText("promptImportInvalid"));
		return {
			id: createId(),
			name: preset.name,
			content: preset.content,
			...(typeof preset.description === "string" ? { description: preset.description } : {}),
			...(typeof preset.sourceUrl === "string" ? { sourceUrl: preset.sourceUrl } : {}),
			...(Array.isArray(preset.modelFamilies) ? { modelFamilies: preset.modelFamilies as string[] } : {}),
		};
	});
}

export class ResearchPromptController {
	private client: PromptBridge;
	private listeners = new Set<() => void>();
	private revision = 0;
	private state: ResearchPromptState = {
		connected: false,
		ready: false,
		busy: false,
		draft: { version: 1, enabled: false, activePresetId: null, presets: [] },
		defaultPrompt: "",
		selectedId: null,
		modelFilter: "all",
		searchQuery: "",
		dirty: false,
	};
	constructor(client: PromptBridge) {
		this.client = client;
	}
	getSnapshot = (): ResearchPromptState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private update(patch: Partial<ResearchPromptState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	setConnected(connected: boolean): void {
		if (connected === this.state.connected) return;
		if (!connected) this.revision++;
		this.update({ connected, ...(!connected ? { busy: false } : {}) });
	}
	select(id: string): void {
		if (!this.state.busy && visibleResearchPrompts(this.state).some((preset) => preset.id === id))
			this.update({ selectedId: id, error: undefined, notice: undefined });
	}
	setFilters(filters: Partial<Pick<ResearchPromptState, "modelFilter" | "searchQuery">>): void {
		if (this.state.busy) return;
		const next = { ...this.state, ...filters };
		const visible = visibleResearchPrompts(next);
		this.update({
			...filters,
			selectedId: visible.some((preset) => preset.id === next.selectedId)
				? next.selectedId
				: (visible[0]?.id ?? null),
		});
	}
	resetFilters(): void {
		this.setFilters({ modelFilter: "all", searchQuery: "" });
	}
	edit(
		patch: Partial<Pick<ResearchPromptPreset, "name" | "content" | "description" | "sourceUrl" | "modelFamilies">>,
	): void {
		if (!this.state.ready || this.state.busy || !this.state.selectedId) return;
		const draft = {
			...this.state.draft,
			presets: this.state.draft.presets.map((preset) =>
				preset.id === this.state.selectedId ? { ...preset, ...patch } : preset,
			),
		};
		const staysVisible = visibleResearchPrompts({ ...this.state, draft }).some(
			(preset) => preset.id === this.state.selectedId,
		);
		if (!staysVisible) this.update({ modelFilter: "all", searchQuery: "" });
		this.changeDraft(draft);
		if (!staysVisible) this.update({ notice: "promptFiltersReset" });
	}
	add(): void {
		if (!this.state.ready || this.state.busy) return;
		if (this.state.draft.presets.length >= MAX_RESEARCH_PROMPT_COUNT) {
			this.update({ error: researchText("promptLimit", { count: MAX_RESEARCH_PROMPT_COUNT }) });
			return;
		}
		const preset = {
			id: crypto.randomUUID(),
			name: researchText("promptNewName"),
			content: "",
			modelFamilies: [this.state.modelFilter === "all" ? "general" : this.state.modelFilter],
		};
		this.update({ searchQuery: "" });
		this.changeDraft({ ...this.state.draft, presets: [...this.state.draft.presets, preset] }, preset.id);
	}
	removeSelected(): void {
		if (!this.state.ready || this.state.busy || !this.state.selectedId) return;
		const presets = this.state.draft.presets.filter((preset) => preset.id !== this.state.selectedId);
		const removedActive = this.state.draft.activePresetId === this.state.selectedId;
		this.changeDraft(
			{ ...this.state.draft, presets, ...(removedActive ? { enabled: false, activePresetId: null } : {}) },
			presets[0]?.id ?? null,
		);
	}
	import(value: string, filename: string): boolean {
		if (!this.state.ready || this.state.busy) return false;
		try {
			const imported = importedResearchPrompts(value, filename, () => crypto.randomUUID());
			const draft = { ...this.state.draft, presets: [...this.state.draft.presets, ...imported] };
			const error = promptLibraryError(draft);
			if (error) throw new Error(error);
			const visible = visibleResearchPrompts({ ...this.state, draft });
			this.changeDraft(
				draft,
				visible.find((preset) => imported.some((item) => item.id === preset.id))?.id ?? this.state.selectedId,
			);
			this.update({
				notice: imported.some((preset) => !visible.includes(preset)) ? "promptImportedFiltered" : "promptImported",
			});
			return true;
		} catch (error) {
			this.reportError(error);
			return false;
		}
	}
	reportError(error: unknown): void {
		this.update({ error: error instanceof Error ? error.message : String(error), notice: undefined });
	}
	private changeDraft(draft: ResearchPromptSettings, selectedId = this.state.selectedId): void {
		const visible = visibleResearchPrompts({ ...this.state, draft });
		this.update({
			draft,
			selectedId:
				selectedId === null || visible.some((preset) => preset.id === selectedId)
					? selectedId
					: (visible[0]?.id ?? null),
			dirty: JSON.stringify(draft) !== JSON.stringify(this.state.saved),
			error: undefined,
			notice: undefined,
		});
	}
	async load(): Promise<boolean> {
		if (!this.state.connected || this.state.busy) return false;
		const revision = ++this.revision;
		this.update({ busy: true, error: undefined });
		try {
			const result = await this.request({ type: "research.prompts.get" });
			if (revision !== this.revision) return false;
			const draft = this.state.dirty ? this.state.draft : result.settings;
			const visible = visibleResearchPrompts({ ...this.state, draft });
			const selectedId = visible.some((preset) => preset.id === this.state.selectedId)
				? this.state.selectedId
				: (visible.find((preset) => preset.id === draft.activePresetId)?.id ?? visible[0]?.id ?? null);
			this.update({
				saved: result.settings,
				draft,
				defaultPrompt: result.defaultPrompt,
				ready: true,
				selectedId,
				dirty: JSON.stringify(draft) !== JSON.stringify(result.settings),
				error: undefined,
			});
			return true;
		} catch (error) {
			if (revision === this.revision) this.reportError(error);
			return false;
		} finally {
			if (revision === this.revision) this.update({ busy: false });
		}
	}
	async save(): Promise<boolean> {
		return this.mutate("save");
	}
	async apply(): Promise<boolean> {
		return this.mutate("apply");
	}
	async restore(): Promise<boolean> {
		return this.mutate("restore");
	}
	async exportLibrary(): Promise<boolean> {
		if (!this.state.connected || !this.state.ready || this.state.busy) return false;
		const error = promptLibraryError(this.state.draft);
		if (error) {
			this.update({ error, notice: undefined });
			return false;
		}
		const revision = ++this.revision;
		this.update({ busy: true, error: undefined, notice: undefined });
		try {
			const response = await this.client.request<ResearchPromptsExportResult>({
				type: "research.prompts.export",
				settings: this.state.draft,
			});
			if (revision !== this.revision) return false;
			if (!response.ok || !response.result?.savedPath)
				throw new Error(response.error ?? researchText("promptRequestFailed"));
			this.update({ exportedPath: response.result.savedPath, notice: "promptExported" });
			return true;
		} catch (error) {
			if (revision === this.revision) this.reportError(error);
			return false;
		} finally {
			if (revision === this.revision) this.update({ busy: false });
		}
	}
	async revealExport(): Promise<void> {
		if (!this.state.connected || !this.state.exportedPath) return;
		const path = this.state.exportedPath;
		const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
		try {
			const response = await this.client.request({
				type: "open.external",
				action: "reveal",
				target: path.slice(separator + 1),
				cwd: path.slice(0, separator),
			});
			if (!response.ok) throw new Error(response.error ?? researchText("promptRequestFailed"));
		} catch (error) {
			this.reportError(error);
		}
	}
	private async mutate(action: "save" | "apply" | "restore"): Promise<boolean> {
		if (!this.state.connected || !this.state.ready || this.state.busy) return false;
		const selectedId = this.state.selectedId;
		if (action === "apply" && !visibleResearchPrompts(this.state).some((preset) => preset.id === selectedId)) {
			this.update({ error: researchText("promptContentRequired"), notice: undefined });
			return false;
		}
		if (action !== "restore") {
			const error = promptLibraryError(this.state.draft, action === "apply" ? selectedId : undefined);
			if (error) {
				this.update({ error, notice: undefined });
				return false;
			}
		}
		const revision = ++this.revision;
		this.update({ busy: true, error: undefined, notice: undefined });
		try {
			if (action === "save" || (action === "apply" && this.state.dirty)) {
				const result = await this.request({ type: "research.prompts.save", settings: this.state.draft });
				if (revision !== this.revision) return false;
				const visible = visibleResearchPrompts({ ...this.state, draft: result.settings });
				this.update({
					saved: result.settings,
					draft: result.settings,
					selectedId: visible.some((preset) => preset.id === this.state.selectedId) ? this.state.selectedId : null,
					defaultPrompt: result.defaultPrompt,
					dirty: false,
				});
			}
			if (action !== "save") {
				const result = await this.request(
					action === "apply"
						? { type: "research.prompts.apply", presetId: selectedId! }
						: { type: "research.prompts.restore" },
				);
				if (revision !== this.revision) return false;
				const activePresetId = this.state.draft.presets.some(
					(preset) => preset.id === result.settings.activePresetId,
				)
					? result.settings.activePresetId
					: null;
				const draft = this.state.dirty
					? { ...this.state.draft, enabled: result.settings.enabled && activePresetId !== null, activePresetId }
					: result.settings;
				const visible = visibleResearchPrompts({ ...this.state, draft });
				this.update({
					saved: result.settings,
					draft,
					selectedId: visible.some((preset) => preset.id === this.state.selectedId) ? this.state.selectedId : null,
					defaultPrompt: result.defaultPrompt,
					dirty: JSON.stringify(draft) !== JSON.stringify(result.settings),
				});
			}
			this.update({
				notice: action === "save" ? "promptSaved" : action === "apply" ? "promptApplied" : "promptRestored",
			});
			return true;
		} catch (error) {
			if (revision === this.revision) this.reportError(error);
			return false;
		} finally {
			if (revision === this.revision) this.update({ busy: false });
		}
	}
	private async request(request: Parameters<PromptBridge["request"]>[0]): Promise<ResearchPromptsResult> {
		const response = await this.client.request<ResearchPromptsResult>(request);
		if (!response.ok || !response.result) throw new Error(response.error ?? researchText("promptRequestFailed"));
		return response.result;
	}
}
