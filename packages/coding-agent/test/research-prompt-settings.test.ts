import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RESEARCH_PROMPT_LIMITS } from "../src/core/research/prompt-models.ts";
import {
	applyResearchPromptPreset,
	createDefaultResearchPromptSettings,
	exportResearchPromptSettings,
	getActiveResearchPrompt,
	loadResearchPromptSettings,
	MAX_RESEARCH_PROMPT_CONTENT_LENGTH,
	MAX_RESEARCH_PROMPT_FILE_BYTES,
	normalizeResearchPromptSettings,
	RESEARCH_PROMPTS_FILE,
	restoreResearchPromptDefaults,
	saveResearchPromptSettings,
} from "../src/core/research/prompt-settings.ts";

describe("research prompt settings", () => {
	const roots: string[] = [];
	const profile = () => {
		const root = mkdtempSync(join(tmpdir(), "owl-research-prompts-"));
		if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("owl-research-prompts-")) {
			throw new Error("Unsafe research prompt test root");
		}
		roots.push(root);
		return root;
	};

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("returns independent, disabled defaults without writing to a profile on read", () => {
		const root = profile();
		const defaults = loadResearchPromptSettings(root);
		expect(defaults).toMatchObject({ version: 1, enabled: false, activePresetId: null });
		expect(defaults.presets.map((preset) => preset.id)).toEqual([
			"evidence-first",
			"reproducible-analysis",
			"source-tracing",
		]);
		defaults.presets[0].content = "changed only in this response";
		expect(loadResearchPromptSettings(root).presets[0].content).not.toBe(defaults.presets[0].content);
		expect(existsSync(join(root, RESEARCH_PROMPTS_FILE))).toBe(false);
	});

	it("persists full replacement, applies one preset and restores defaults while retaining the library", () => {
		const root = profile();
		const secondProfile = profile();
		const settings = createDefaultResearchPromptSettings();
		settings.presets.push({
			id: "custom",
			name: "我自己的研究方法",
			content: "从实际输入建立最小复现，逐项保留证据。",
			description: "本地方法",
			sourceUrl: "https://example.test/research",
		});
		expect(saveResearchPromptSettings(root, settings)).toEqual(settings);
		expect(loadResearchPromptSettings(root)).toEqual(settings);
		expect(loadResearchPromptSettings(secondProfile)).toEqual(createDefaultResearchPromptSettings());
		const applied = applyResearchPromptPreset(root, "custom");
		expect(applied).toMatchObject({ enabled: true, activePresetId: "custom" });
		expect(getActiveResearchPrompt(applied)).toBe(settings.presets.at(-1)?.content);
		expect(loadResearchPromptSettings(root)).toEqual(applied);
		const restored = restoreResearchPromptDefaults(root);
		expect(restored).toEqual({ ...applied, enabled: false });
		expect(getActiveResearchPrompt(restored)).toBeUndefined();
		expect(loadResearchPromptSettings(root)).toEqual(restored);
		expect(readdirSync(root)).toEqual([RESEARCH_PROMPTS_FILE]);
	});

	it("allows disabled empty drafts, but rejects missing or blank active presets without altering persisted settings", () => {
		const root = profile();
		const settings = createDefaultResearchPromptSettings();
		settings.presets.push({ id: "draft", name: "待完善", content: " \n\t" });
		saveResearchPromptSettings(root, settings);
		const saved = readFileSync(join(root, RESEARCH_PROMPTS_FILE), "utf8");
		expect(() => applyResearchPromptPreset(root, "missing")).toThrow("不存在");
		expect(() => applyResearchPromptPreset(root, "draft")).toThrow("非空");
		expect(() => applyResearchPromptPreset(root, null)).toThrow("请选择");
		expect(() => saveResearchPromptSettings(root, { ...settings, enabled: true })).toThrow("非空");
		expect(readFileSync(join(root, RESEARCH_PROMPTS_FILE), "utf8")).toBe(saved);
		expect(readdirSync(root)).toEqual([RESEARCH_PROMPTS_FILE]);
	});

	it("rejects malformed, duplicate and oversized settings, executable URLs and embedded credentials", () => {
		const settings = createDefaultResearchPromptSettings();
		for (const input of [null, [], {}, { ...settings, version: 2 }, { ...settings, extra: true }]) {
			expect(() => normalizeResearchPromptSettings(input)).toThrow("格式无效");
		}
		expect(() =>
			normalizeResearchPromptSettings({ ...settings, presets: [settings.presets[0], settings.presets[0]] }),
		).toThrow("不能重复");
		for (const preset of [
			{ ...settings.presets[0], id: "../escape" },
			{ ...settings.presets[0], name: " " },
			{ ...settings.presets[0], content: "x".repeat(MAX_RESEARCH_PROMPT_CONTENT_LENGTH + 1) },
			{ ...settings.presets[0], sourceUrl: "javascript:alert(1)" },
			{ ...settings.presets[0], sourceUrl: "https://user:secret@example.test" },
			{ ...settings.presets[0], sourceUrl: "not-a-url" },
		]) {
			expect(() => normalizeResearchPromptSettings({ ...settings, presets: [preset] })).toThrow();
		}
		const presets = Array.from(
			{ length: Math.floor(MAX_RESEARCH_PROMPT_FILE_BYTES / (MAX_RESEARCH_PROMPT_CONTENT_LENGTH * 3)) + 1 },
			(_, index) => ({
				id: `large-${index}`,
				name: "大内容",
				content: "中".repeat(MAX_RESEARCH_PROMPT_CONTENT_LENGTH),
			}),
		);
		expect(() => normalizeResearchPromptSettings({ ...settings, presets })).toThrow("过大");
		expect(() =>
			normalizeResearchPromptSettings({
				...settings,
				presets: Array.from({ length: RESEARCH_PROMPT_LIMITS.presets + 1 }, (_, index) => ({
					id: `many-${index}`,
					name: "预设",
					content: "",
				})),
			}),
		).toThrow("格式无效");
	});

	it("retains multi-model metadata through persistence, export and restore without activating it", () => {
		const root = profile();
		const settings = createDefaultResearchPromptSettings();
		settings.presets.push({
			id: "multi-model",
			name: "多个模型的研究样本",
			content: "观察真实回答并保留证据。",
			modelFamilies: ["claude", "gemini", "future-model"],
		});
		saveResearchPromptSettings(root, settings);
		expect(loadResearchPromptSettings(root)).toEqual(settings);
		const exported = exportResearchPromptSettings(settings, join(root, "exports"));
		expect(normalizeResearchPromptSettings(JSON.parse(readFileSync(exported.savedPath, "utf8")))).toEqual(settings);
		expect(restoreResearchPromptDefaults(root)).toEqual(settings);
		expect(getActiveResearchPrompt(loadResearchPromptSettings(root))).toBeUndefined();
		for (const tags of [
			[],
			["claude", "claude"],
			["Claude"],
			["../escape"],
			["future-"],
			[""],
			Array.from({ length: RESEARCH_PROMPT_LIMITS.modelFamilies + 1 }, (_, index) => `model-${index}`),
		]) {
			expect(() =>
				saveResearchPromptSettings(root, {
					...settings,
					presets: [{ ...settings.presets[0], modelFamilies: tags }],
				}),
			).toThrow();
			expect(loadResearchPromptSettings(root)).toEqual(settings);
		}
	});

	it("accepts the existing untagged library and libraries larger than the original 50-preset limit", () => {
		const settings = createDefaultResearchPromptSettings();
		const untagged = { ...settings, presets: settings.presets.map(({ modelFamilies: _tags, ...preset }) => preset) };
		expect(normalizeResearchPromptSettings(untagged)).toEqual(untagged);
		const presets = Array.from({ length: 75 }, (_, index) => ({
			id: `catalog-${index}`,
			name: `模型样本 ${index}`,
			content: "研究资料",
			modelFamilies: ["claude"],
		}));
		expect(normalizeResearchPromptSettings({ ...settings, presets }).presets).toHaveLength(75);
	});

	it("reports invalid persisted data and file size before accepting a new override", () => {
		const root = profile();
		const path = join(root, RESEARCH_PROMPTS_FILE);
		writeFileSync(path, "{");
		expect(() => loadResearchPromptSettings(root)).toThrow("有效的 JSON");
		writeFileSync(path, JSON.stringify({ ...createDefaultResearchPromptSettings(), activePresetId: "deleted" }));
		expect(() => loadResearchPromptSettings(root)).toThrow("不存在");
		writeFileSync(path, " ".repeat(MAX_RESEARCH_PROMPT_FILE_BYTES + 1));
		expect(() => loadResearchPromptSettings(root)).toThrow("文件过大");
	});

	it("exports unique, validated snapshots without saving edited content or changing active profile settings", () => {
		const root = profile();
		const active = applyResearchPromptPreset(root, "evidence-first");
		const snapshot = createDefaultResearchPromptSettings();
		snapshot.presets.push({ id: "unsaved", name: "尚未保存的方法", content: "只用于导出的编辑草稿。" });
		const destination = join(root, "exports");
		const first = exportResearchPromptSettings(snapshot, destination);
		const second = exportResearchPromptSettings(snapshot, destination);
		expect(first.savedPath).not.toBe(second.savedPath);
		for (const result of [first, second]) {
			expect(dirname(result.savedPath)).toBe(resolve(destination));
			expect(basename(result.savedPath)).toMatch(/^owl-research-prompts-[A-Za-z0-9_-]+\.json$/);
			expect(JSON.parse(readFileSync(result.savedPath, "utf8"))).toEqual(snapshot);
		}
		expect(readdirSync(destination)).toHaveLength(2);
		expect(loadResearchPromptSettings(root)).toEqual(active);
	});

	it("rejects invalid exports before touching their destination and reports write failures", () => {
		const root = profile();
		const active = applyResearchPromptPreset(root, "source-tracing");
		const destination = join(root, "invalid-export");
		expect(() => exportResearchPromptSettings({}, destination)).toThrow("格式无效");
		expect(existsSync(destination)).toBe(false);
		const blocked = join(root, "blocked");
		writeFileSync(blocked, "existing file must stay intact");
		expect(() => exportResearchPromptSettings(active, blocked)).toThrow();
		expect(readFileSync(blocked, "utf8")).toBe("existing file must stay intact");
		expect(loadResearchPromptSettings(root)).toEqual(active);
	});
});
