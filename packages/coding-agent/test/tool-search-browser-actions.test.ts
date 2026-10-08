import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolInfo } from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { assessToolForIntent } from "../src/extensions/tool-search/intent.ts";
import { createToolSearchToolDefinition } from "../src/extensions/tool-search/tool.ts";
import { BrowserHub } from "../src/modes/desktop/browser-hub.ts";
import { createHarness } from "./suite/harness.ts";

function createBrowserDiscovery(includePlaywright = false) {
	const hub = new BrowserHub({
		onPagesChanged: () => {},
		onFrame: () => {},
		onFileChooser: () => {},
		onDiagnostic: () => {},
	});
	const tools: ToolInfo[] = hub.tools("discovery-fixture").map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		exposure: "direct",
		sourceInfo: createSyntheticSourceInfo(`builtin:${tool.name}`, { source: "builtin" }),
	}));
	if (includePlaywright) {
		for (const [name, description] of [
			["mcp_playwright_browser_click", "[MCP:playwright] Perform click on a web page"],
			["mcp_playwright_browser_type", "[MCP:playwright] Type text into editable element"],
			["mcp_playwright_browser_fill_form", "[MCP:playwright] Fill multiple form fields"],
			["mcp_playwright_browser_select_option", "[MCP:playwright] Select an option in a dropdown"],
			["mcp_playwright_browser_evaluate", "[MCP:playwright] Evaluate JavaScript expression on page or element"],
		]) {
			tools.push({
				name,
				description,
				parameters: Type.Object({}),
				exposure: "deferred",
				sourceInfo: createSyntheticSourceInfo(`<mcp:${name}>`, { source: "test" }),
			});
		}
	}
	let active = ["browser_navigate", "browser_snapshot"];
	const search = createToolSearchToolDefinition({
		tools: {
			getAllTools: () => tools,
			getActiveTools: () => active,
			setActiveTools: (names) => {
				active = names;
			},
		},
	});
	return { search, active: () => active };
}

describe("browser form discovery with the actual BrowserHub metadata", () => {
	it.each([
		["browser fill input", "browser_fill", "fill"],
		["browser select option combobox", "browser_select", "select"],
		["浏览器填写表单", "browser_fill", "fill"],
		["浏览器选择下拉选项", "browser_select", "select"],
	])("discovers %s without an unknown-action loop", async (query, expected, action) => {
		const { search, active } = createBrowserDiscovery();
		const result = await search.execute("discovery", { query }, undefined, undefined, undefined!);
		expect(result.details.steps[0]).toMatchObject({ intent: { action }, status: "metadata_match" });
		expect(active()).toContain(expected);
	});

	it.each([
		["playwright fill form", "mcp_playwright_browser_fill_form", "fill"],
		["mcp playwright select_option", "mcp_playwright_browser_select_option", "select"],
		["browser evaluate javascript", "mcp_playwright_browser_evaluate", "evaluate"],
	])("recognizes the real failed query %s against installed metadata", async (query, expected, action) => {
		const { search, active } = createBrowserDiscovery(true);
		const result = await search.execute("discovery", { query }, undefined, undefined, undefined!);
		expect(result.details.steps[0]).toMatchObject({ intent: { action }, status: "metadata_match" });
		expect(active()).toContain(expected);
	});

	it.each([
		["browser click type", "browser_click"],
		["browser type fill input", "browser_type"],
	])("keeps the currently used browser backend for %s", async (query, expected) => {
		const { search, active } = createBrowserDiscovery(true);
		await search.execute("discovery", { query }, undefined, undefined, undefined!);
		expect(active()).toContain(expected);
		expect(active().some((name) => name.startsWith("mcp_playwright"))).toBe(false);
	});

	it.each(["playwright click", "mcp playwright browser type", "mcp_playwright_browser_click"])(
		"keeps the explicitly requested backend for %s",
		async (query) => {
			const { search, active } = createBrowserDiscovery(true);
			await search.execute("discovery", { query }, undefined, undefined, undefined!);
			expect(active().some((name) => name.startsWith("mcp_playwright"))).toBe(true);
		},
	);

	it("keeps unknown browser operations unresolved instead of loading a nearby tool", async () => {
		const { search, active } = createBrowserDiscovery(true);
		const result = await search.execute(
			"discovery",
			{ query: "browser transmogrify" },
			undefined,
			undefined,
			undefined!,
		);
		expect(result.details.loaded).toEqual([]);
		expect(result.details.steps[0].intent.action).toBe("unknown");
		expect(active()).toEqual(["browser_navigate", "browser_snapshot"]);
	});

	it("requires operation evidence and respects an authoritative action enum", () => {
		expect(
			assessToolForIntent(
				{ capability: "browser", action: "fill" },
				{ name: "browser_form_state", description: "Read browser input fields and form state." },
			).status,
		).toBe("refine");
		expect(
			assessToolForIntent(
				{ capability: "browser", action: "fill" },
				{
					name: "browser_act",
					description: "Click and fill browser elements.",
					parameters: Type.Object({ action: Type.Literal("click") }),
				},
			).status,
		).toBe("refine");
	});

	it("loads fill, select and click in one actual session discovery batch", async () => {
		const hub = new BrowserHub({
			onPagesChanged: () => {},
			onFrame: () => {},
			onFileChooser: () => {},
			onDiagnostic: () => {},
		});
		const harness = await createHarness({
			toolActivation: "on-demand",
			initialActiveToolNames: ["tool_search", "browser_navigate", "browser_snapshot"],
			extensionFactories: [
				createToolSearchExtension(),
				(pi) => {
					for (const definition of hub.tools("session-discovery-fixture")) pi.registerTool(definition);
				},
			],
		});
		let declared: string[] = [];
		try {
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("tool_search", {
						steps: [
							{ capability: "browser", action: "fill" },
							{ capability: "browser", action: "select", target: "下拉选项" },
							{ capability: "browser", action: "click" },
						],
						limit: 3,
					}),
					{ stopReason: "toolUse" },
				),
				(context) => {
					declared = getCurrentTools(context.messages).map((tool) => tool.name);
					return fauxAssistantMessage("ready");
				},
			]);
			await harness.session.prompt("Load the current browser controls.");
			expect(declared).toEqual(expect.arrayContaining(["browser_fill", "browser_select", "browser_click"]));
		} finally {
			harness.cleanup();
			await hub.dispose();
		}
	});

	it.each([false, true])("keeps the last successfully used backend; failed MCP navigation: %s", async (failed) => {
		const hub = new BrowserHub({
			onPagesChanged: () => {},
			onFrame: () => {},
			onFileChooser: () => {},
			onDiagnostic: () => {},
		});
		const harness = await createHarness({
			toolActivation: "on-demand",
			initialActiveToolNames: [
				"tool_search",
				"browser_navigate",
				"browser_snapshot",
				"mcp_playwright_browser_navigate",
			],
			extensionFactories: [
				createToolSearchExtension(),
				(pi) => {
					for (const definition of hub.tools("browser-affinity-fixture")) pi.registerTool(definition);
					pi.registerTool({
						name: "mcp_playwright_browser_navigate",
						label: "MCP navigation",
						description: "[MCP:playwright] Navigate to a URL",
						parameters: Type.Object({ url: Type.String() }),
						async execute() {
							return {
								content: [{ type: "text", text: failed ? "Navigation failed" : "MCP page opened" }],
								details: undefined,
								isError: failed,
							};
						},
					});
					pi.registerTool({
						name: "mcp_playwright_browser_click",
						label: "MCP click",
						description: "[MCP:playwright] Perform click on a web page",
						parameters: Type.Object({ ref: Type.String() }),
						defaultActive: false,
						async execute() {
							throw new Error("Discovery test must not execute browser clicks");
						},
					});
				},
			],
		});
		const declaredByTurn: string[][] = [];
		try {
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("mcp_playwright_browser_navigate", { url: "https://example.invalid/fixture" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "browser click" }), { stopReason: "toolUse" }),
				(context) => {
					declaredByTurn.push(getCurrentTools(context.messages).map((tool) => tool.name));
					return fauxAssistantMessage("ready");
				},
			]);
			await harness.session.prompt("Use the already declared navigation tool, then discover a click.");
			expect(declaredByTurn).toHaveLength(1);
			expect(declaredByTurn[0]).toContain(failed ? "browser_click" : "mcp_playwright_browser_click");
			expect(declaredByTurn[0]).not.toContain(failed ? "mcp_playwright_browser_click" : "browser_click");
			if (!failed) {
				harness.setResponses([
					(context) => {
						declaredByTurn.push(getCurrentTools(context.messages).map((tool) => tool.name));
						return fauxAssistantMessage("ready");
					},
				]);
				await harness.session.prompt("在浏览器点击按钮");
				expect(declaredByTurn).toHaveLength(2);
				expect(declaredByTurn[1]).not.toContain("browser_click");
			}
		} finally {
			harness.cleanup();
			await hub.dispose();
		}
	});
});
