import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	DesktopClientRequestWithoutId,
	ResearchPromptSettings,
	ResearchPromptsExportResult,
	ResearchPromptsResult,
} from "../../bridge/protocol.ts";
import {
	importedResearchPrompts,
	ResearchPromptController,
	researchPromptModelOptions,
	visibleResearchPrompts,
} from "./research-prompts.ts";

type Response = { ok: boolean; result?: ResearchPromptsResult | ResearchPromptsExportResult; error?: string };
class PromptBridge {
	requests: DesktopClientRequestWithoutId[] = [];
	settings: ResearchPromptSettings = {
		version: 1,
		enabled: false,
		activePresetId: null,
		presets: [
			{ id: "first", name: "First", content: "Original research prompt" },
			{ id: "second", name: "Second", content: "Second research prompt" },
		],
	};
	respond?: (request: DesktopClientRequestWithoutId) => Response | Promise<Response>;
	async request<T>(request: DesktopClientRequestWithoutId): Promise<{ ok: boolean; result?: T; error?: string }> {
		this.requests.push(structuredClone(request));
		if (this.respond) {
			const result = await this.respond(request);
			return { ...result, result: result.result as T | undefined };
		}
		if (request.type === "research.prompts.save") {
			if (
				request.settings.activePresetId &&
				!request.settings.presets.some((preset) => preset.id === request.settings.activePresetId)
			)
				return { ok: false, error: "active id missing" };
			this.settings = structuredClone(request.settings);
		}
		if (request.type === "research.prompts.apply")
			this.settings = { ...this.settings, enabled: true, activePresetId: request.presetId };
		if (request.type === "research.prompts.restore") this.settings = { ...this.settings, enabled: false };
		return {
			ok: true,
			result: { settings: structuredClone(this.settings), defaultPrompt: "Default research role" } as T,
		};
	}
}

async function fresh(): Promise<{ bridge: PromptBridge; controller: ResearchPromptController }> {
	const bridge = new PromptBridge();
	const controller = new ResearchPromptController(bridge);
	controller.setConnected(true);
	assert.equal(await controller.load(), true);
	bridge.requests = [];
	return { bridge, controller };
}

async function modelLibrary(): Promise<{ bridge: PromptBridge; controller: ResearchPromptController }> {
	const result = await fresh();
	result.bridge.settings.presets = [
		{ id: "first", name: "Claude example", content: "Claude content", modelFamilies: ["claude"] },
		{
			id: "second",
			name: "Multi model",
			content: "Shared content",
			description: "Older sample",
			sourceUrl: "https://github.com/example/prompts/blob/main/shared.md",
			modelFamilies: ["deepseek", "gpt"],
		},
		{ id: "legacy", name: "DeepSeek R1 sample", content: "Legacy content" },
		{ id: "generic", name: "Evidence first", content: "General content" },
	];
	await result.controller.load();
	result.bridge.requests = [];
	return result;
}

test("one-click override waits for the edited library to save before applying the selected preset", async () => {
	const { bridge, controller } = await fresh();
	controller.select("second");
	controller.edit({ content: "Edited prompt" });
	let finishSave: ((response: Response) => void) | undefined;
	bridge.respond = (request) => {
		if (request.type === "research.prompts.save")
			return new Promise((resolve) => {
				finishSave = resolve;
			});
		if (request.type !== "research.prompts.apply") throw new Error("unexpected request");
		assert.equal(request.presetId, "second");
		return {
			ok: true,
			result: {
				settings: { ...controller.getSnapshot().draft, enabled: true, activePresetId: "second" },
				defaultPrompt: "Default research role",
			},
		};
	};
	const applying = controller.apply();
	assert.deepEqual(
		bridge.requests.map((request) => request.type),
		["research.prompts.save"],
	);
	assert.equal(controller.getSnapshot().saved?.enabled, false);
	assert.equal(controller.getSnapshot().busy, true);
	controller.edit({ content: "Edits during save must not race the payload" });
	finishSave?.({
		ok: true,
		result: { settings: structuredClone(controller.getSnapshot().draft), defaultPrompt: "Default research role" },
	});
	assert.equal(await applying, true);
	assert.deepEqual(
		bridge.requests.map((request) => request.type),
		["research.prompts.save", "research.prompts.apply"],
	);
	assert.equal(controller.getSnapshot().saved?.presets[1].content, "Edited prompt");
	assert.equal(controller.getSnapshot().saved?.enabled, true);
	assert.equal(controller.getSnapshot().saved?.activePresetId, "second");
	assert.equal(controller.getSnapshot().dirty, false);
	assert.equal(controller.getSnapshot().notice, "promptApplied");
});

test("failed save keeps the edit and never applies an older saved prompt", async () => {
	const { bridge, controller } = await fresh();
	controller.edit({ content: "Unpersisted edit" });
	bridge.respond = () => ({ ok: false, error: "disk unavailable" });
	assert.equal(await controller.apply(), false);
	assert.equal(controller.getSnapshot().draft.presets[0].content, "Unpersisted edit");
	assert.equal(controller.getSnapshot().saved?.presets[0].content, "Original research prompt");
	assert.equal(controller.getSnapshot().dirty, true);
	assert.equal(controller.getSnapshot().error, "disk unavailable");
	assert.equal(controller.getSnapshot().notice, undefined);
	assert.deepEqual(
		bridge.requests.map((request) => request.type),
		["research.prompts.save"],
	);
});

test("save success followed by apply failure reports the real persisted library without claiming activation", async () => {
	const { bridge, controller } = await fresh();
	controller.edit({ content: "Saved but not activated" });
	bridge.respond = (request) =>
		request.type === "research.prompts.save"
			? {
					ok: true,
					result: {
						settings: structuredClone(controller.getSnapshot().draft),
						defaultPrompt: "Default research role",
					},
				}
			: { ok: false, error: "activation rejected" };
	assert.equal(await controller.apply(), false);
	assert.equal(controller.getSnapshot().draft.presets[0].content, "Saved but not activated");
	assert.equal(controller.getSnapshot().saved?.presets[0].content, "Saved but not activated");
	assert.equal(controller.getSnapshot().dirty, false);
	assert.equal(controller.getSnapshot().saved?.enabled, false);
	assert.equal(controller.getSnapshot().notice, undefined);
	assert.equal(controller.getSnapshot().error, "activation rejected");
});

test("restore disables the override while preserving the saved library and unsaved local edits", async () => {
	const { bridge, controller } = await fresh();
	assert.equal(await controller.apply(), true);
	controller.edit({ content: "Keep this unsaved draft" });
	bridge.requests = [];
	assert.equal(await controller.restore(), true);
	assert.deepEqual(
		bridge.requests.map((request) => request.type),
		["research.prompts.restore"],
	);
	assert.equal(controller.getSnapshot().saved?.enabled, false);
	assert.equal(controller.getSnapshot().saved?.presets.length, 2);
	assert.equal(controller.getSnapshot().saved?.presets[0].content, "Original research prompt");
	assert.equal(controller.getSnapshot().draft.presets[0].content, "Keep this unsaved draft");
	assert.equal(controller.getSnapshot().dirty, true);
	assert.equal(await controller.save(), true);
	assert.equal(bridge.settings.presets[0].content, "Keep this unsaved draft");
	assert.equal(bridge.settings.enabled, false);
});

test("restoring after a local deletion cannot reintroduce an active id missing from the draft", async () => {
	const { bridge, controller } = await fresh();
	await controller.apply();
	controller.removeSelected();
	assert.equal(controller.getSnapshot().draft.activePresetId, null);
	assert.equal(await controller.restore(), true);
	assert.equal(controller.getSnapshot().draft.activePresetId, null);
	assert.equal(controller.getSnapshot().draft.presets.length, 1);
	assert.equal(await controller.save(), true);
	assert.equal(bridge.settings.activePresetId, null);
	assert.equal(bridge.settings.enabled, false);
});

test("empty prompt text may be saved but cannot enable an override", async () => {
	const { bridge, controller } = await fresh();
	controller.edit({ content: "  \n " });
	assert.equal(await controller.apply(), false);
	assert.equal(bridge.requests.length, 0);
	assert.equal(await controller.save(), true);
	assert.equal(bridge.settings.enabled, false);
});

test("reconnect and retry refresh the server state while preserving edits and selection", async () => {
	const { bridge, controller } = await fresh();
	controller.select("second");
	controller.edit({ content: "Offline edit" });
	controller.setConnected(false);
	assert.equal(await controller.save(), false);
	assert.equal(bridge.requests.length, 0);
	controller.setConnected(true);
	bridge.respond = () => {
		throw new Error("bridge timed out");
	};
	assert.equal(await controller.load(), false);
	assert.equal(controller.getSnapshot().draft.presets[1].content, "Offline edit");
	assert.equal(controller.getSnapshot().busy, false);
	bridge.respond = undefined;
	assert.equal(await controller.load(), true);
	assert.equal(controller.getSnapshot().selectedId, "second");
	assert.equal(controller.getSnapshot().draft.presets[1].content, "Offline edit");
	assert.equal(controller.getSnapshot().dirty, true);
	assert.equal(controller.getSnapshot().error, undefined);
});

test("a load response arriving after disconnection cannot replace the retained draft", async () => {
	const { bridge, controller } = await fresh();
	let finish: ((response: Response) => void) | undefined;
	bridge.respond = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const loading = controller.load();
	controller.setConnected(false);
	controller.edit({ content: "Edit after connection loss" });
	finish?.({ ok: true, result: { settings: bridge.settings, defaultPrompt: "Late default" } });
	assert.equal(await loading, false);
	assert.equal(controller.getSnapshot().draft.presets[0].content, "Edit after connection loss");
	assert.equal(controller.getSnapshot().defaultPrompt, "Default research role");
	assert.equal(controller.getSnapshot().busy, false);
});

test("JSON imports regenerate ids and cannot enable or overwrite an existing prompt", async () => {
	const { bridge, controller } = await fresh();
	assert.equal(
		controller.import(
			JSON.stringify({
				version: 1,
				enabled: true,
				activePresetId: "first",
				presets: [
					{ id: "first", name: "Imported", content: "Imported text", sourceUrl: "https://example.org/source" },
				],
			}),
			"prompts.json",
		),
		true,
	);
	assert.equal(controller.getSnapshot().draft.presets.length, 3);
	assert.equal(controller.getSnapshot().draft.presets[0].content, "Original research prompt");
	assert.notEqual(controller.getSnapshot().draft.presets[2].id, "first");
	assert.equal(controller.getSnapshot().draft.enabled, false);
	assert.equal(controller.getSnapshot().draft.activePresetId, null);
	assert.equal(controller.getSnapshot().dirty, true);
	assert.equal(bridge.requests.length, 0);
});

test("invalid imports and credential-bearing source URLs keep the library intact", async () => {
	const { controller } = await fresh();
	const previous = controller.getSnapshot().draft;
	assert.equal(
		controller.import('{"name":"Bad","content":"text","sourceUrl":"https://user:pass@example.org"}', "bad.json"),
		false,
	);
	assert.equal(controller.getSnapshot().draft, previous);
	assert.equal(controller.import("invalid json", "bad.json"), false);
	assert.equal(controller.getSnapshot().draft, previous);
	const imported = importedResearchPrompts("Markdown prompt", "research.mkd", () => "new-id");
	assert.deepEqual(imported, [{ id: "new-id", name: "research", content: "Markdown prompt" }]);
});

test("clearing an enabled prompt requires restoring the default before saving the empty draft", async () => {
	const { bridge, controller } = await fresh();
	await controller.apply();
	controller.edit({ content: "" });
	bridge.requests = [];
	assert.equal(await controller.save(), false);
	assert.equal(bridge.requests.length, 0);
	assert.ok(controller.getSnapshot().error);
	assert.equal(await controller.restore(), true);
	assert.equal(await controller.save(), true);
	assert.equal(bridge.settings.presets[0].content, "");
	assert.equal(bridge.settings.enabled, false);
});

test("desktop export writes the current draft through the bridge without persisting or activating it", async () => {
	const { bridge, controller } = await fresh();
	controller.edit({ content: "Export this unsaved edit" });
	bridge.respond = () => ({
		ok: true,
		result: { savedPath: "C:\\Users\\Test\\Downloads\\owl-research-prompts.json" },
	});
	assert.equal(await controller.exportLibrary(), true);
	assert.equal(bridge.requests.length, 1);
	const request = bridge.requests[0];
	assert.equal(request.type, "research.prompts.export");
	assert.equal(
		request.type === "research.prompts.export" && request.settings.presets[0].content,
		"Export this unsaved edit",
	);
	assert.equal(controller.getSnapshot().dirty, true);
	assert.equal(controller.getSnapshot().saved?.presets[0].content, "Original research prompt");
	assert.equal(controller.getSnapshot().saved?.enabled, false);
	assert.equal(controller.getSnapshot().notice, "promptExported");
	await controller.revealExport();
	assert.deepEqual(bridge.requests[1], {
		type: "open.external",
		action: "reveal",
		cwd: "C:\\Users\\Test\\Downloads",
		target: "owl-research-prompts.json",
	});
});

test("export failure reports an error and preserves edits and activation state for retry", async () => {
	const { bridge, controller } = await fresh();
	await controller.apply();
	controller.edit({ description: "Unsaved description" });
	bridge.respond = () => ({ ok: false, error: "Downloads cannot be written" });
	assert.equal(await controller.exportLibrary(), false);
	assert.equal(controller.getSnapshot().error, "Downloads cannot be written");
	assert.equal(controller.getSnapshot().notice, undefined);
	assert.equal(controller.getSnapshot().exportedPath, undefined);
	assert.equal(controller.getSnapshot().draft.presets[0].description, "Unsaved description");
	assert.equal(controller.getSnapshot().saved?.enabled, true);
	assert.equal(controller.getSnapshot().dirty, true);
	assert.equal(controller.getSnapshot().busy, false);
});

test("model and search filters preserve activation, hidden presets and unsaved edits without server writes", async () => {
	const { bridge, controller } = await modelLibrary();
	await controller.apply();
	controller.select("second");
	controller.edit({ content: "Keep this draft while filtering" });
	const draft = controller.getSnapshot().draft;
	const saved = controller.getSnapshot().saved;
	bridge.requests = [];
	controller.setFilters({ modelFilter: "deepseek" });
	assert.deepEqual(
		visibleResearchPrompts(controller.getSnapshot()).map((preset) => preset.id),
		["second", "legacy"],
	);
	assert.equal(controller.getSnapshot().selectedId, "second");
	controller.setFilters({ searchQuery: "does not exist" });
	assert.equal(controller.getSnapshot().selectedId, null);
	assert.equal(controller.getSnapshot().draft, draft);
	assert.equal(controller.getSnapshot().saved, saved);
	assert.equal(controller.getSnapshot().saved?.enabled, true);
	assert.equal(controller.getSnapshot().saved?.activePresetId, "first");
	assert.equal(controller.getSnapshot().dirty, true);
	controller.select("first");
	assert.equal(controller.getSnapshot().selectedId, null);
	assert.equal(await controller.apply(), false);
	assert.equal(bridge.requests.length, 0);
	controller.resetFilters();
	assert.equal(controller.getSnapshot().selectedId, "first");
	assert.equal(controller.getSnapshot().draft.presets[1].content, "Keep this draft while filtering");
	assert.equal(controller.getSnapshot().draft.presets.length, 4);
});

test("one preset matches each explicit model category and legacy categories are inferred without mutating data", async () => {
	const { controller } = await modelLibrary();
	const before = JSON.stringify(controller.getSnapshot().draft);
	controller.setFilters({ modelFilter: "gpt" });
	assert.deepEqual(
		visibleResearchPrompts(controller.getSnapshot()).map((preset) => preset.id),
		["second"],
	);
	controller.setFilters({ modelFilter: "deepseek" });
	assert.deepEqual(
		visibleResearchPrompts(controller.getSnapshot()).map((preset) => preset.id),
		["second", "legacy"],
	);
	controller.setFilters({ modelFilter: "general" });
	assert.deepEqual(
		visibleResearchPrompts(controller.getSnapshot()).map((preset) => preset.id),
		["generic"],
	);
	assert.equal(JSON.stringify(controller.getSnapshot().draft), before);
	assert.equal(controller.getSnapshot().dirty, false);
});

test("search matches names, descriptions and source URLs while retaining the current model category", async () => {
	const { controller } = await modelLibrary();
	for (const query of ["  MULTI MODEL  ", "older sample", "example/prompts"]) {
		controller.setFilters({ searchQuery: query });
		assert.deepEqual(
			visibleResearchPrompts(controller.getSnapshot()).map((preset) => preset.id),
			["second"],
		);
	}
	controller.setFilters({ modelFilter: "claude" });
	assert.equal(visibleResearchPrompts(controller.getSnapshot()).length, 0);
	assert.equal(controller.getSnapshot().selectedId, null);
	controller.setFilters({ searchQuery: "claude" });
	assert.equal(controller.getSnapshot().selectedId, "first");
});

test("new prompts inherit their model category and clear search to stay visible", async () => {
	const { bridge, controller } = await modelLibrary();
	controller.setFilters({ modelFilter: "claude", searchQuery: "missing" });
	controller.add();
	const state = controller.getSnapshot();
	const added = state.draft.presets.find((preset) => preset.id === state.selectedId);
	assert.equal(state.searchQuery, "");
	assert.equal(state.modelFilter, "claude");
	assert.deepEqual(added?.modelFamilies, ["claude"]);
	assert.ok(visibleResearchPrompts(state).some((preset) => preset.id === added?.id));
	assert.equal(await controller.save(), true);
	assert.equal(bridge.settings.presets.length, 5);
	assert.equal(bridge.settings.enabled, false);
	controller.resetFilters();
	controller.add();
	assert.deepEqual(controller.getSnapshot().draft.presets.at(-1)?.modelFamilies, ["general"]);
});

test("editing model tags resets conflicting filters while preserving selection and the full library", async () => {
	const { bridge, controller } = await modelLibrary();
	controller.setFilters({ modelFilter: "claude" });
	controller.edit({ modelFamilies: ["deepseek", "gpt"] });
	assert.equal(controller.getSnapshot().selectedId, "first");
	assert.equal(controller.getSnapshot().modelFilter, "all");
	assert.equal(controller.getSnapshot().notice, "promptFiltersReset");
	assert.equal(controller.getSnapshot().draft.presets[0].name, "Claude example");
	assert.deepEqual(controller.getSnapshot().draft.presets[0].modelFamilies, ["deepseek", "gpt"]);
	assert.equal(await controller.save(), true);
	assert.equal(bridge.settings.presets.length, 4);
	assert.deepEqual(bridge.settings.presets[0].modelFamilies, ["deepseek", "gpt"]);
	assert.equal(bridge.settings.enabled, false);
});

test("tagged JSON imports and exports preserve multiple model categories without activating or filtering the payload", async () => {
	const { bridge, controller } = await modelLibrary();
	controller.setFilters({ modelFilter: "deepseek" });
	assert.equal(
		controller.import(
			JSON.stringify({
				enabled: true,
				activePresetId: "external-id",
				presets: [
					{
						id: "external-id",
						name: "Imported tagged",
						content: "Import content",
						modelFamilies: ["deepseek", "gemini"],
					},
				],
			}),
			"models.json",
		),
		true,
	);
	const imported = controller.getSnapshot().draft.presets.at(-1);
	assert.notEqual(imported?.id, "external-id");
	assert.deepEqual(imported?.modelFamilies, ["deepseek", "gemini"]);
	assert.equal(controller.getSnapshot().selectedId, imported?.id);
	assert.equal(controller.getSnapshot().draft.enabled, false);
	assert.equal(controller.getSnapshot().draft.activePresetId, null);
	bridge.respond = () => ({ ok: true, result: { savedPath: "C:\\Exports\\prompts.json" } });
	assert.equal(await controller.exportLibrary(), true);
	const exported = bridge.requests[0];
	assert.equal(exported.type, "research.prompts.export");
	if (exported.type !== "research.prompts.export") throw new Error("missing export payload");
	assert.equal(exported.settings.presets.length, 5);
	assert.deepEqual(exported.settings.presets.at(-1)?.modelFamilies, ["deepseek", "gemini"]);
	assert.equal(exported.settings.enabled, false);
	bridge.respond = undefined;
	assert.equal(await controller.save(), true);
	assert.equal(bridge.settings.presets.length, 5);
	assert.equal(bridge.settings.enabled, false);
});

test("unknown valid categories remain filterable while malformed category imports leave the draft intact", async () => {
	const { controller } = await fresh();
	assert.equal(
		controller.import(
			JSON.stringify({ name: "Future sample", content: "content", modelFamilies: ["future-model"] }),
			"future.json",
		),
		true,
	);
	assert.ok(researchPromptModelOptions(controller.getSnapshot().draft.presets).includes("future-model"));
	controller.setFilters({ modelFilter: "future-model" });
	assert.equal(visibleResearchPrompts(controller.getSnapshot()).length, 1);
	const before = controller.getSnapshot().draft;
	for (const modelFamilies of [["GPT"], ["gpt", "gpt"], [], [42]]) {
		assert.equal(
			controller.import(JSON.stringify({ name: "Bad tags", content: "content", modelFamilies }), "bad.json"),
			false,
		);
		assert.equal(controller.getSnapshot().draft, before);
	}
});

test("restoring with zero matches keeps the full saved library and unsaved draft", async () => {
	const { bridge, controller } = await modelLibrary();
	await controller.apply();
	controller.edit({ description: "Keep edited metadata" });
	controller.setFilters({ modelFilter: "gemini", searchQuery: "missing" });
	bridge.requests = [];
	assert.equal(await controller.restore(), true);
	assert.deepEqual(
		bridge.requests.map((request) => request.type),
		["research.prompts.restore"],
	);
	assert.equal(controller.getSnapshot().selectedId, null);
	assert.equal(controller.getSnapshot().saved?.enabled, false);
	assert.equal(controller.getSnapshot().saved?.presets.length, 4);
	assert.equal(controller.getSnapshot().draft.presets[0].description, "Keep edited metadata");
	assert.equal(controller.getSnapshot().dirty, true);
	assert.equal(await controller.save(), true);
	assert.equal(bridge.settings.presets.length, 4);
});

test("an edit that stops matching search preserves selection so continued edits affect the same prompt", async () => {
	const { controller } = await fresh();
	controller.edit({ name: "Common first", modelFamilies: ["gpt"] });
	controller.select("second");
	controller.edit({ name: "Common second", modelFamilies: ["gpt"] });
	controller.select("first");
	controller.setFilters({ searchQuery: "common" });
	controller.edit({ name: "Renamed first" });
	assert.equal(controller.getSnapshot().selectedId, "first");
	assert.equal(controller.getSnapshot().searchQuery, "");
	assert.equal(controller.getSnapshot().notice, "promptFiltersReset");
	assert.deepEqual(
		visibleResearchPrompts(controller.getSnapshot()).map((preset) => preset.id),
		["first", "second"],
	);
	controller.edit({ content: "Continue changing the first prompt" });
	assert.equal(controller.getSnapshot().draft.presets[0].name, "Renamed first");
	assert.equal(controller.getSnapshot().draft.presets[0].content, "Continue changing the first prompt");
	assert.equal(controller.getSnapshot().draft.presets[1].content, "Second research prompt");
	controller.resetFilters();
	assert.equal(controller.getSnapshot().draft.presets[0].name, "Renamed first");
});

test("imports outside current filters give a specific notice and preserve the existing selection", async () => {
	const { bridge, controller } = await modelLibrary();
	controller.setFilters({ modelFilter: "claude" });
	assert.equal(
		controller.import(
			JSON.stringify({ name: "Gemini sample", content: "Imported content", modelFamilies: ["gemini"] }),
			"gemini.json",
		),
		true,
	);
	assert.equal(controller.getSnapshot().modelFilter, "claude");
	assert.equal(controller.getSnapshot().selectedId, "first");
	assert.equal(controller.getSnapshot().notice, "promptImportedFiltered");
	assert.equal(controller.getSnapshot().draft.presets.length, 5);
	assert.equal(controller.getSnapshot().draft.enabled, false);
	assert.equal(bridge.requests.length, 0);
});
