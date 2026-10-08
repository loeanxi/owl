import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolInfo } from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createToolSearchToolDefinition, preloadToolsForUserText } from "../src/extensions/tool-search/tool.ts";
import { BrowserHub } from "../src/modes/desktop/browser-hub.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const captured: unknown = JSON.parse(
	readFileSync(new URL("./fixtures/tool-search-captured-ui-index.json", import.meta.url), "utf8"),
);
if (
	!isRecord(captured) ||
	typeof captured.prompt !== "string" ||
	!Array.isArray(captured.active) ||
	!captured.active.every((name): name is string => typeof name === "string") ||
	!Array.isArray(captured.tools)
)
	throw new Error("Invalid captured public tool metadata fixture");
const prompt = captured.prompt;
const actualActive = captured.active;
const capturedTools: ToolInfo[] = captured.tools.map((tool: unknown) => {
	if (
		!isRecord(tool) ||
		typeof tool.name !== "string" ||
		typeof tool.description !== "string" ||
		!isRecord(tool.parameters)
	)
		throw new Error("Invalid captured public tool descriptor");
	return {
		name: tool.name,
		description: tool.description,
		parameters: Type.Unsafe(tool.parameters),
		exposure: tool.name.startsWith("mcp_") ? "deferred" : "direct",
		sourceInfo: createSyntheticSourceInfo(`captured:${tool.name}`, { source: "test" }),
	};
});
const coreActive = actualActive.filter(
	(name) => !name.startsWith("browser_") && !name.startsWith("mcp_") && name !== "univer_execute",
);

function fixture(initial = coreActive) {
	const hub = new BrowserHub({ onPagesChanged() {}, onFrame() {}, onFileChooser() {}, onDiagnostic() {} });
	const native: ToolInfo[] = hub.tools("offline-preload-regression").map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		exposure: "direct",
		sourceInfo: createSyntheticSourceInfo(`builtin:${tool.name}`, { source: "builtin" }),
	}));
	let active = [...initial];
	const tools = {
		getAllTools: () => [...capturedTools, ...native],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
	return { tools, hub };
}

describe("compound UI preload with captured metadata and actual native tools", () => {
	it.each([[actualActive], [coreActive]])(
		"preloads the real D07 navigation/form/observation requirements",
		async (initial) => {
			const { tools, hub } = fixture(initial);
			try {
				const result = preloadToolsForUserText(tools, prompt);
				expect(tools.getActiveTools()).toEqual(
					expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_fill_form", "browser_click"]),
				);
				expect(result?.loaded.some((name) => name.startsWith("mcp_") || name === "univer_execute")).toBe(false);
			} finally {
				await hub.dispose();
			}
		},
	);

	it.each([
		"修改 src/invoice.ts 代码里的金额计算，然后运行本地测试。",
		"修改 src/browser.ts 的 navigate/fill 代码，再运行本地测试。",
		"只读分析 src/browser.ts 的 browser 代码，解释 navigate 和 fill 函数，不执行 UI 操作，不打开浏览器。",
		"修复 src/form.ts 代码，但不要使用 browser 打开页面或填写表单，只运行单元测试。",
		"不要使用 browser 打开页面或填写表单。",
	])("does not preload operations for ordinary code or negated UI: %s", async (text) => {
		const { tools, hub } = fixture();
		try {
			expect(preloadToolsForUserText(tools, text)?.loaded ?? []).toEqual([]);
		} finally {
			await hub.dispose();
		}
	});

	it.each([
		["用原生browser打开页面，不要伪造browser回执。", ["browser_navigate"], ["mcp_playwright_browser_navigate"]],
		["用浏览器打开并读取，不要点击提交。", ["browser_navigate", "browser_snapshot"], ["browser_click"]],
		["用原生browser打开页面，不要读取内容。", ["browser_navigate"], ["browser_snapshot"]],
		["用原生browser打开页面，不要使用 MCP Playwright。", ["browser_navigate"], ["mcp_playwright_browser_navigate"]],
		[
			"只读分析 src/browser.ts 的 browser 代码再实际使用browser打开页面并填写表单。",
			["browser_navigate", "browser_fill_form"],
			["univer_execute"],
		],
		[
			"使用browser打开 https://example.test/playwright，填写邮箱mcp@example.test。",
			["browser_navigate", "browser_fill_form"],
			["mcp_playwright_browser_navigate"],
		],
	])("keeps affirmative actions without expanding negative clauses: %s", async (text, expected, forbidden) => {
		const { tools, hub } = fixture();
		try {
			const result = preloadToolsForUserText(tools, text);
			expect(result?.loaded).toEqual(expect.arrayContaining(expected));
			for (const name of forbidden) expect(result?.loaded).not.toContain(name);
		} finally {
			await hub.dispose();
		}
	});

	it("honors explicit MCP wording and refines the missing captured MCP fill action", async () => {
		const { tools, hub } = fixture();
		try {
			const result = preloadToolsForUserText(tools, "使用 MCP Playwright browser 打开页面并填写表单。");
			expect(result?.loaded).toEqual(["mcp_playwright_browser_navigate"]);
			expect(result?.steps.find((step) => step.intent.action === "fill")?.status).toBe("refine");
		} finally {
			await hub.dispose();
		}
	});

	it("carries pending native declarations within one batch without claiming execution", async () => {
		const { tools, hub } = fixture();
		try {
			const result = await createToolSearchToolDefinition({ tools }).execute(
				"batch",
				{
					steps: [
						{ capability: "browser", action: "read" },
						{ capability: "browser", action: "click", query: "browser click" },
					],
				},
				undefined,
				undefined,
				undefined!,
			);
			expect(result.details.loaded).toEqual(["browser_snapshot", "browser_click"]);
			expect(result.details.steps.every((step) => step.status === "metadata_match")).toBe(true);
		} finally {
			await hub.dispose();
		}
	});

	it("uses explicit MCP target constraints and preserves exact-name lookup", async () => {
		const { tools, hub } = fixture();
		try {
			const search = createToolSearchToolDefinition({ tools });
			const target = await search.execute(
				"target",
				{
					steps: [
						{
							capability: "browser",
							action: "navigate",
							query: "browser navigate",
							target: "Use MCP Playwright browser",
						},
					],
				},
				undefined,
				undefined,
				undefined!,
			);
			expect(target.details.loaded).toEqual(["mcp_playwright_browser_navigate"]);
			const exact = await search.execute(
				"exact",
				{ query: "mcp_playwright_browser_click" },
				undefined,
				undefined,
				undefined!,
			);
			expect(exact.details.loaded).toEqual(["mcp_playwright_browser_click"]);
		} finally {
			await hub.dispose();
		}
	});
});
