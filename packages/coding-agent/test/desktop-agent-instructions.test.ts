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

	it("keeps the entity-verification and honesty rules in the defaults", () => {
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("分不清闲聊还是指代就按指代处理");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("不用生成内容冒充检索结果");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("先落盘再承诺");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("只有当前已声明 tool_search 时");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("不能自行转成 Bash 查实现、读取自身日志或编写替代脚本");
		expect(DESKTOP_AGENT_INSTRUCTIONS).not.toContain("专项能力尚未声明时，先用 tool_search");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("搜文件内容用 grep，按名字找文件用 find，列目录用 ls");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("bash 只用来执行必须跑的命令");
		expect(DESKTOP_AGENT_INSTRUCTIONS).not.toContain("搜代码内容用 bash");
	});

	it("keeps the UI quality discipline in the defaults", () => {
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("至多穿过一层闭合边框");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("严禁边框套边框");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("外层圆角等于内层圆角加内边距");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("动效单次不超过 300ms");
	});

	it("keeps the final-answer ordering discipline in the defaults", () => {
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("先完成全部工具调用（含执行异常补报）再作答");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("owl-ui 界面围栏这类交付物尤其要写在最终回答里");
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain(
			"这只约束最终答复，不禁止在执行工具前或执行中发送简短的公开进展说明",
		);
		expect(DESKTOP_AGENT_INSTRUCTIONS).toContain("进展说明之后继续执行已授权的工具操作");
		expect(DESKTOP_AGENT_INSTRUCTIONS).not.toContain("用户在正文里看不到");
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
