import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";
import { DESKTOP_AGENT_INSTRUCTIONS, desktopAgentPromptOptions } from "../src/modes/desktop/agent-instructions.ts";

describe("desktop agent instructions", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "owl-desktop-prompt-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir);
		mkdirSync(cwd);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("preserves custom SYSTEM.md and APPEND_SYSTEM.md alongside desktop and user addenda", async () => {
		writeFileSync(join(agentDir, "SYSTEM.md"), "User-defined exact identity.");
		writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Existing appended instructions.");
		const userPrompt = "User preferences from desktop settings.";
		const planPrompt = "Current session permits only read-only tools.";
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			...desktopAgentPromptOptions([userPrompt, planPrompt]),
		});
		await loader.reload();

		expect(loader.getSystemPrompt()).toBe("User-defined exact identity.");
		expect(loader.getAppendSystemPrompt()).toEqual([
			DESKTOP_AGENT_INSTRUCTIONS,
			"Existing appended instructions.",
			userPrompt,
			planPrompt,
		]);
		expect(loader.getAppendSystemPromptSources()).toEqual([{ path: join(agentDir, "APPEND_SYSTEM.md") }]);
		const sections = buildSystemPromptSections({
			cwd,
			customPrompt: loader.getSystemPrompt(),
			appendSystemPrompt: loader.getAppendSystemPrompt().join("\n\n"),
		});
		expect(sections.preamble).toBe("User-defined exact identity.");
		expect(sections.addendum).toContain(userPrompt);
		expect(sections.addendum).toContain(planPrompt);
	});

	it("discovers updated project append instructions on reload without duplicating defaults", async () => {
		mkdirSync(join(cwd, ".owl"));
		const appendPath = join(cwd, ".owl", "APPEND_SYSTEM.md");
		writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Global instructions.");
		writeFileSync(appendPath, "Project instructions.");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			...desktopAgentPromptOptions(),
		});
		await loader.reload();
		expect(loader.getAppendSystemPrompt()).toEqual([DESKTOP_AGENT_INSTRUCTIONS, "Project instructions."]);

		writeFileSync(appendPath, "Updated project instructions.");
		await loader.reload();
		expect(loader.getAppendSystemPrompt()).toEqual([DESKTOP_AGENT_INSTRUCTIONS, "Updated project instructions."]);
		expect(loader.getSystemPrompt()).toBeUndefined();
	});
});
