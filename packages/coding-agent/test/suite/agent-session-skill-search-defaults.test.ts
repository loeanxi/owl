import { fauxAssistantMessage, fauxToolCall, type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createSkillSearchExtension } from "../../src/extensions/skill-search/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

function skill(name: string, description: string, filePath = `/skills/${name}/SKILL.md`): Skill {
	return {
		name,
		description,
		filePath,
		baseDir: "/skills",
		disableModelInvocation: false,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		requiresMetadataTracking: false,
	};
}

describe("skill search default browsing contract", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	async function setupCatalog(catalog: Skill[]): Promise<Harness> {
		harness = await createHarness({
			initialActiveToolNames: ["skill_search"],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.skills = catalog;
					});
				},
				createSkillSearchExtension(),
			],
		});
		return harness;
	}

	it("validates omitted query as a bounded browse request", async () => {
		const current = await setupCatalog([]);
		const tool = current.session.agent.state.tools.find((entry) => entry.name === "skill_search");
		if (!tool) throw new Error("skill_search was not registered");
		expect(validateToolArguments(tool, fauxToolCall("skill_search", {}))).toEqual({});
	});

	it("dispatches the recorded empty arguments as bounded browsing without exposing hidden skills", async () => {
		const current = await setupCatalog([
			{ ...skill("manual-only", "Hidden workflow"), disableModelInvocation: true },
			...Array.from({ length: 80 }, (_, index) => skill(`entry-${index}`, `Workflow ${index}`)),
		]);
		current.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_search", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Browse complete."),
		]);
		await current.session.prompt("浏览可供模型调用的技能");
		const result = getToolResult(current, "skill_search");
		expect(result.isError).not.toBe(true);
		const found = JSON.parse(getMessageText(result));
		expect(found).toMatchObject({ offset: 0, returned: 5, catalogSize: 80 });
		expect(found.skills.map((entry: { name: string }) => entry.name)).toEqual([
			"entry-0",
			"entry-1",
			"entry-2",
			"entry-3",
			"entry-4",
		]);
		expect(current.getPendingResponseCount()).toBe(0);
	});

	it.each([
		{ offset: 2, limit: 8, expected: Array.from({ length: 8 }, (_, index) => `entry-${index + 2}`) },
		{ offset: 80, limit: 8, expected: [] },
	])("browses without query using offset=$offset and limit=$limit", async ({ offset, limit, expected }) => {
		const current = await setupCatalog([
			{ ...skill("manual-only", "Hidden workflow"), disableModelInvocation: true },
			...Array.from({ length: 80 }, (_, index) => skill(`entry-${index}`, `Workflow ${index}`)),
		]);
		current.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_search", { offset, limit }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Page inspected."),
		]);
		await current.session.prompt("浏览当前技能的指定页");
		const result = getToolResult(current, "skill_search");
		expect(result.isError).not.toBe(true);
		const found = JSON.parse(getMessageText(result));
		expect(found).toMatchObject({ offset, returned: expected.length, catalogSize: 80 });
		expect(found.skills.map((entry: { name: string }) => entry.name)).toEqual(expected);
	});

	const invalidInputs: { input: JsonObject; field: string }[] = [
		{ input: { query: [] }, field: "query" },
		{ input: { query: {} }, field: "query" },
		{ input: { offset: -1 }, field: "offset" },
		{ input: { offset: "invalid" }, field: "offset" },
		{ input: { limit: 0 }, field: "limit" },
		{ input: { limit: 9 }, field: "limit" },
		{ input: { limit: "invalid" }, field: "limit" },
	];
	it.each(invalidInputs)("rejects invalid $field input $input before browsing", async ({ input, field }) => {
		const current = await setupCatalog([skill("entry", "Visible workflow")]);
		const tool = current.session.agent.state.tools.find((entry) => entry.name === "skill_search");
		if (!tool) throw new Error("skill_search was not registered");
		expect(() => validateToolArguments(tool, fauxToolCall("skill_search", input))).toThrow(field);
		current.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_search", input), { stopReason: "toolUse" }),
			fauxAssistantMessage("The supplied field is invalid."),
		]);
		await current.session.prompt("检查技能参数");
		const result = getToolResult(current, "skill_search");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain(`${field}:`);
	});

	it.each([
		{ query: 42, normalized: { query: "42" }, names: ["42"] },
		{ query: false, normalized: { query: "false" }, names: ["false"] },
		{ query: null, normalized: {}, names: ["42", "false", "entry"] },
	])("retains framework normalization for query=$query", async ({ query, normalized, names }) => {
		const current = await setupCatalog([
			skill("42", "Numeric name"),
			skill("false", "Boolean name"),
			skill("entry", "Another workflow"),
		]);
		const tool = current.session.agent.state.tools.find((entry) => entry.name === "skill_search");
		if (!tool) throw new Error("skill_search was not registered");
		expect(validateToolArguments(tool, fauxToolCall("skill_search", { query }))).toEqual(normalized);
		current.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_search", { query }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Normalized search inspected."),
		]);
		await current.session.prompt("按框架既有参数规范化查找技能");
		const result = getToolResult(current, "skill_search");
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(getMessageText(result)).skills.map((entry: { name: string }) => entry.name)).toEqual(names);
	});

	const normalizedPagination: { input: JsonObject; normalized: JsonObject; names: string[] }[] = [
		{ input: { offset: 1.5 }, normalized: { offset: 1 }, names: ["entry-1", "entry-2"] },
		{ input: { limit: 1.5 }, normalized: { limit: 1 }, names: ["entry-0"] },
	];
	it.each(normalizedPagination)(
		"retains framework integer normalization for $input",
		async ({ input, normalized, names }) => {
			const current = await setupCatalog(
				Array.from({ length: 3 }, (_, index) => skill(`entry-${index}`, "Workflow")),
			);
			const tool = current.session.agent.state.tools.find((entry) => entry.name === "skill_search");
			if (!tool) throw new Error("skill_search was not registered");
			expect(validateToolArguments(tool, fauxToolCall("skill_search", input))).toEqual(normalized);
			current.setResponses([
				fauxAssistantMessage(fauxToolCall("skill_search", input), { stopReason: "toolUse" }),
				fauxAssistantMessage("Normalized page inspected."),
			]);
			await current.session.prompt("按框架既有整数规范化浏览技能");
			const result = getToolResult(current, "skill_search");
			expect(result.isError).not.toBe(true);
			expect(JSON.parse(getMessageText(result)).skills.map((entry: { name: string }) => entry.name)).toEqual(names);
		},
	);

	it("keeps an explicit nonempty query as a search instead of browsing", async () => {
		const current = await setupCatalog([
			skill("first-workflow", "Unrelated recipe"),
			skill("spreadsheet", "创建表格并验证公式"),
		]);
		current.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_search", { query: "SPREADSHEET" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Exact skill found."),
		]);
		await current.session.prompt("查找 spreadsheet 技能");
		const result = getToolResult(current, "skill_search");
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(getMessageText(result)).skills.map((entry: { name: string }) => entry.name)).toEqual([
			"spreadsheet",
		]);
	});
});
