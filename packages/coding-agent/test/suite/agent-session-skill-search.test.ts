import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRequestMessages, estimateToolDeclarations } from "../../src/core/context-insight.ts";
import { DEFAULT_TOOL_NAMES } from "../../src/core/settings-manager.ts";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createSkillSearchExtension, searchSkills } from "../../src/extensions/skill-search/index.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

function skill(name: string, description: string, filePath = `/skills/${name}/SKILL.md`): Skill {
	return {
		name,
		description,
		filePath,
		baseDir: "/skills",
		disableModelInvocation: false,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
	};
}

describe("skill discovery in a real agent session", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it("keeps greetings small and retrieves Chinese skill metadata before reading the real file", async () => {
		let catalog: Skill[] = [];
		harness = await createHarness({
			toolActivation: "on-demand",
			initialActiveToolNames: [...DEFAULT_TOOL_NAMES, "codemode", "skill_search", "tool_search"],
			extensionFactories: [
				(pi) => {
					for (let index = 0; index < 100; index++) {
						pi.registerTool({
							name: `specialized_${index}`,
							label: "Specialized capability",
							description: "Detailed specialized instructions. ".repeat(40),
							parameters: Type.Object({}),
							async execute() {
								throw new Error("A greeting must not execute specialized tools");
							},
						});
					}
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.skills = catalog;
					});
				},
				createCodemodeExtension(),
				createToolSearchExtension(),
				createSkillSearchExtension(),
			],
		});
		const path = join(harness.tempDir, "spreadsheet-SKILL.md");
		writeFileSync(path, "# 表格处理\n完成后验证单元格计算结果。");
		catalog = [
			skill("spreadsheet", "创建表格并验证公式", path),
			...Array.from({ length: 59 }, (_, i) => skill(`workflow-${i}`, "Long specialized instructions. ".repeat(30))),
		];
		let greetingContext: TranscriptContext | undefined;
		harness.setResponses([
			(context) => {
				greetingContext = context;
				return fauxAssistantMessage("你好。");
			},
		]);
		await harness.session.prompt("你好");
		expect(greetingContext).toBeDefined();
		if (!greetingContext) throw new Error("The greeting never reached the provider");
		const declared = getCurrentTools(greetingContext.messages);
		const composition = classifyRequestMessages(greetingContext.messages);
		composition.toolSchemas = estimateToolDeclarations(declared).total;
		expect(declared).toHaveLength(DEFAULT_TOOL_NAMES.length + 3);
		expect(Object.values(composition).reduce((sum, value) => sum + value, 0)).toBeLessThan(8000);
		expect(harness.session.systemPrompt.length).toBeLessThan(8000);
		expect(harness.session.systemPrompt).not.toContain("Long specialized instructions.");
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_search", { query: "创建表格" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
			fauxAssistantMessage("已读取表格处理说明。"),
		]);
		await harness.session.prompt("创建表格并核对公式");
		const found = JSON.parse(getMessageText(getToolResult(harness, "skill_search")));
		expect(found.skills[0]).toMatchObject({ name: "spreadsheet", path });
		expect(getMessageText(getToolResult(harness, "read"))).toContain("完成后验证单元格计算结果");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps explicit-only skills hidden and supports bounded browsing beyond the index", () => {
		const catalog = Array.from({ length: 80 }, (_, i) => skill(`entry-${i}`, `Workflow ${i}`));
		catalog.unshift({ ...skill("manual-only", "Secret manual workflow"), disableModelInvocation: true });
		expect(searchSkills(catalog, "manual-only")).toEqual([]);
		expect(searchSkills(catalog, "", 75, 5).map((entry) => entry.name)).toEqual([
			"entry-75",
			"entry-76",
			"entry-77",
			"entry-78",
			"entry-79",
		]);
		expect(searchSkills(catalog, "ENTRY-79", 0, 1)[0]?.name).toBe("entry-79");
		expect(searchSkills(catalog, "unmatchedqzxw")).toEqual([]);
	});

	it("refreshes the catalog after a resource change without retaining removed skills", async () => {
		let catalog = [skill("old-workflow", "Old recipe")];
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.skills = catalog;
					});
				},
				createSkillSearchExtension(),
			],
		});
		for (const name of ["old-workflow", "new-workflow"]) {
			catalog = [skill(name, "Current recipe")];
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("skill_search", { query: "" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Found."),
			]);
			await harness.session.prompt("列出当前技能");
			const result = JSON.parse(getMessageText(getToolResult(harness, "skill_search")));
			expect(result.skills.map((entry: { name: string }) => entry.name)).toEqual([name]);
		}
	});
});
