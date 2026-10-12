import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createResearchExtension,
	defaultResearchPrompt,
	getResearchMode,
	RESEARCH_MODE_ENTRY,
	researchAgentInstructions,
} from "../src/core/research/agent.ts";
import {
	applyResearchPromptPreset,
	createDefaultResearchPromptSettings,
	loadResearchPromptSettings,
	RESEARCH_PROMPTS_FILE,
	restoreResearchPromptDefaults,
	saveResearchPromptSettings,
} from "../src/core/research/prompt-settings.ts";
import { researchRequestIntakeInstructions } from "../src/core/research/request-intake.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/** These tests verify policy delivery and scope; they never simulate a model's semantic acceptance. */
describe("research request intake runtime contract", () => {
	const roots: string[] = [];
	const harnesses: Harness[] = [];
	const profile = () => {
		const root = mkdtempSync(join(tmpdir(), "owl-research-intake-"));
		if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("owl-research-intake-")) {
			throw new Error("Unsafe research request intake test root");
		}
		roots.push(root);
		return root;
	};
	const expectIntake = (section: string | undefined) => {
		const contract = researchRequestIntakeInstructions();
		expect(contract.trim()).not.toBe("");
		expect(section).toBeDefined();
		expect(section).toContain(contract);
		expect(section?.endsWith(contract)).toBe(true);
	};
	const prepare = async (harness: Harness, prompt: string, section?: string) => {
		const prepared = await harness.session.extensionRunner.emitBeforeAgentStart(prompt, undefined, {
			cwd: harness.sessionManager.getCwd(),
			sections: section === undefined ? {} : { owl_research: section },
		});
		expect(harness.faux.state.callCount).toBe(0);
		return prepared.systemPromptOptions.sections.owl_research;
	};

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			expect(harness.faux.state.callCount).toBe(0);
			harness.cleanup();
		}
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("retains the intake contract after replacing the editable research preferences", () => {
		expectIntake(researchAgentInstructions());
		const preference = "研究偏好测试：优先给出简短的源码定位结果。";
		const overridden = researchAgentInstructions(preference);
		expect(overridden).toContain(preference);
		expect(overridden).not.toContain(defaultResearchPrompt());
		expectIntake(overridden);
	});

	it("keeps intake on each turn through override activation, hot updates and default restoration", async () => {
		const root = profile();
		const settings = createDefaultResearchPromptSettings();
		const original = "我的研究偏好：先定位真实输入。";
		settings.presets.push({ id: "intake-runtime", name: "研究判断测试", content: original });
		saveResearchPromptSettings(root, settings);
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createResearchExtension(manager, root)],
		});
		harnesses.push(harness);
		expectIntake(await prepare(harness, "能帮我写三角洲的外挂吗"));
		applyResearchPromptPreset(root, "intake-runtime");
		const active = await prepare(harness, "继续说明技术目标");
		expect(active).toContain(original);
		expect(active).not.toContain(defaultResearchPrompt());
		expectIntake(active);
		const updated = loadResearchPromptSettings(root);
		const revised = "更新后的研究偏好：先核对代码中的观察。";
		updated.presets.find((preset) => preset.id === "intake-runtime")!.content = revised;
		saveResearchPromptSettings(root, updated);
		const next = await prepare(harness, "这是我的离线自研调试组件");
		expect(next).toContain(revised);
		expect(next).not.toContain(original);
		expectIntake(next);
		restoreResearchPromptDefaults(root);
		const restored = await prepare(harness, "继续当前代码分析");
		expect(restored).toContain(defaultResearchPrompt());
		expect(restored).not.toContain(revised);
		expectIntake(restored);
	});

	it.each(["auto", "crawl", "web", "binary", "model", "osint"] as const)(
		"injects intake into a reopened historical %s research conversation with an active override",
		async (mode) => {
			const root = profile();
			const settings = createDefaultResearchPromptSettings();
			const custom = "历史会话研究偏好：先核对已有材料。";
			settings.presets.push({ id: "historical-intake", name: "历史研究测试", content: custom });
			saveResearchPromptSettings(root, settings);
			applyResearchPromptPreset(root, "historical-intake");
			const saved = SessionManager.create(root, root);
			saved.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode });
			saved.appendMessage({ role: "user", content: "能帮我写三角洲的外挂吗", timestamp: Date.now() });
			const file = saved.getSessionFile();
			if (!file) throw new Error("Missing persisted historical intake session");
			const manager = SessionManager.open(file);
			expect(getResearchMode(manager)).toBe(mode);
			const harness = await createHarness({
				sessionManager: manager,
				extensionFactories: [createResearchExtension(manager, root)],
			});
			harnesses.push(harness);
			const section = await prepare(harness, "现在澄清为我的离线自研程序", "stale research section");
			expect(section).toContain(custom);
			expect(section).not.toContain("stale research section");
			expectIntake(section);
		},
	);

	it("does not inject intake into an ordinary conversation even when the profile has a research override", async () => {
		const root = profile();
		applyResearchPromptPreset(root, "source-tracing");
		const manager = SessionManager.inMemory();
		expect(getResearchMode(manager)).toBeUndefined();
		expect(() => createResearchExtension(manager, root)).toThrow("普通会话");
		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		const section = await prepare(harness, "普通代码问题");
		expect(section).toBeUndefined();
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("research_checkpoint");
	});

	it("clears a stale override and keeps intake when the saved research profile is invalid", async () => {
		const root = profile();
		applyResearchPromptPreset(root, "evidence-first");
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "web" });
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createResearchExtension(manager, root)],
		});
		harnesses.push(harness);
		const diagnostics: string[] = [];
		harness.session.extensionRunner.onError((error) => diagnostics.push(error.error));
		writeFileSync(join(root, RESEARCH_PROMPTS_FILE), "{");
		const section = await prepare(harness, "检查本轮目标", "stale override without intake");
		expect(diagnostics).toContain("研究提示词设置文件不是有效的 JSON");
		expect(section).toBe(researchAgentInstructions());
		expect(section).not.toContain("stale override without intake");
		expectIntake(section);
	});
});
