import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolInfo } from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	Bm25Ranker,
	createToolSearchDocument,
	createToolSearchToolDefinition,
	MAX_TOOL_SEARCH_LIMIT,
	tokenize,
} from "../src/extensions/tool-search/tool.ts";

describe("tool discovery ranking", () => {
	const documents = [
		createToolSearchDocument({ name: "univer_new", description: "创建空白表格或文档", parameters: Type.Object({}) }),
		createToolSearchDocument({
			name: "browser_screenshot",
			description: "Capture a screenshot of the current browser page",
			parameters: Type.Object({}),
		}),
		createToolSearchDocument({
			name: "media_bridge_control",
			description: "Control music playback",
			parameters: Type.Object({}),
		}),
	];

	it("finds Chinese metadata and English tool metadata from Chinese requests", () => {
		expect(tokenize("创建表格")).toContain("表格");
		const ranker = new Bm25Ranker();
		expect(ranker.rank("创建表格", documents, 1)[0]?.name).toBe("univer_new");
		expect(ranker.rank("浏览器截图", documents, 1)[0]?.name).toBe("browser_screenshot");
		expect(ranker.rank("播放音乐", documents, 1)[0]?.name).toBe("media_bridge_control");
		expect(ranker.rank("瀏覽器截圖", documents, 1)[0]?.name).toBe("browser_screenshot");
	});

	it("prioritizes exact names and does not load arbitrary tools for an unrelated query", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("browser_screenshot", documents, 1)[0]?.name).toBe("browser_screenshot");
		expect(ranker.rank("unrelated-galaxy", documents, 4)).toEqual([]);
		expect(ranker.rank("！？", documents, 4)).toEqual([]);
	});

	it("caps discovery batches even when execution bypasses schema validation", async () => {
		const search = createToolSearchToolDefinition();
		await expect(
			search.execute(
				"search",
				{ query: "browser", limit: MAX_TOOL_SEARCH_LIMIT + 1 },
				undefined,
				undefined,
				undefined!,
			),
		).rejects.toThrow("limit");
	});
});

describe("tool discovery intent validation", () => {
	function discovery(
		definitions: Array<Pick<ToolInfo, "name" | "description" | "parameters">>,
		initial: string[] = [],
	) {
		let active = [...initial];
		const tools: ToolInfo[] = definitions.map((tool) => ({
			...tool,
			exposure: "direct",
			sourceInfo: createSyntheticSourceInfo(tool.name, { source: "test" }),
		}));
		return {
			active: () => active,
			search: createToolSearchToolDefinition({
				tools: {
					getAllTools: () => tools,
					getActiveTools: () => active,
					setActiveTools: (names) => {
						active = names;
					},
				},
			}),
		};
	}

	it("does not activate a weak word collision as an image-editing capability", async () => {
		const { search, active } = discovery([
			{
				name: "update_user_impression",
				description: "更新用户背景和偏好。",
				parameters: Type.Object({ impression: Type.String() }),
			},
		]);
		await search.execute("probe", { query: "把背景变透明" }, undefined, undefined, undefined!);
		expect(active()).toEqual([]);
	});

	it("recovers an informal pause request using the tool's declared action", async () => {
		const { search, active } = discovery([
			{ name: "media_status", description: "Read music playback status", parameters: Type.Object({}) },
			{
				name: "media_control",
				description: "Control media playback",
				parameters: Type.Object({ action: Type.Union([Type.Literal("play-pause"), Type.Literal("next")]) }),
			},
		]);
		await search.execute("probe", { query: "把歌暂停一下" }, undefined, undefined, undefined!);
		expect(active()).toEqual(["media_control"]);
	});

	it("returns an already active exact tool without loading unrelated alternatives", async () => {
		const { search, active } = discovery(
			[
				{ name: "browser_screenshot", description: "Capture browser screenshot", parameters: Type.Object({}) },
				{ name: "browser_click", description: "Click a browser element", parameters: Type.Object({}) },
			],
			["browser_screenshot"],
		);
		const result = await search.execute("probe", { query: "browser_screenshot" }, undefined, undefined, undefined!);
		expect(active()).toEqual(["browser_screenshot"]);
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("browser_screenshot") }),
		]);
	});

	it("does not treat an accessibility snapshot's screenshot comparison as a screenshot capability", async () => {
		const { search, active } = discovery([
			{
				name: "mcp_playwright_browser_snapshot",
				description:
					"[MCP:playwright] Capture accessibility snapshot of the current page, this is better than screenshot",
				parameters: Type.Object({}),
			},
			{
				name: "mcp_playwright_browser_take_screenshot",
				description: "Take a screenshot of the current page",
				parameters: Type.Object({}),
			},
		]);
		await search.execute("probe", { query: "浏览器截图" }, undefined, undefined, undefined!);
		expect(active()).toEqual(["mcp_playwright_browser_take_screenshot"]);
	});

	it("does not mistake retrieving previous search results for initiating a web search", async () => {
		const { search, active } = discovery([
			{
				name: "get_search_content",
				description:
					"Retrieve bounded pages of full stored search results or fetched content, or find matching passages, from a previous web_search, source_check, or fetch_content call.",
				parameters: Type.Object({ responseId: Type.String() }),
			},
			{
				name: "web_search",
				description: "Search the web and return source-linked search results.",
				parameters: Type.Object({ query: Type.String() }),
			},
		]);
		await search.execute(
			"probe",
			{ steps: [{ capability: "web", action: "search", target: "new industry research" }] },
			undefined,
			undefined,
			undefined!,
		);
		expect(active()).toEqual(["web_search"]);
	});

	it("keeps unknown third-party domains discoverable when their own metadata proves the operation", async () => {
		const { search, active } = discovery([
			{
				name: "vendor_archive_record",
				description: "Archive CRM contacts.",
				parameters: Type.Object({ operation: Type.Union([Type.Literal("archive"), Type.Literal("restore")]) }),
			},
		]);
		await search.execute(
			"probe",
			{ steps: [{ capability: "crm", action: "archive", target: "contact" }] },
			undefined,
			undefined,
			undefined!,
		);
		expect(active()).toEqual(["vendor_archive_record"]);
	});

	it("rejects an oversized step batch before mutating the tool set", async () => {
		const { search, active } = discovery([]);
		await expect(
			search.execute(
				"probe",
				{
					steps: Array.from({ length: 5 }, () => ({ capability: "web", action: "read" })),
				},
				undefined,
				undefined,
				undefined!,
			),
		).rejects.toThrow("4");
		expect(active()).toEqual([]);
	});

	it("uses an already active supported alternative when another step consumed the loading budget", async () => {
		const { search, active } = discovery(
			[
				{ name: "web_search", description: "Search the web.", parameters: Type.Object({}) },
				{ name: "browser_take_screenshot", description: "Take a browser screenshot.", parameters: Type.Object({}) },
				{
					name: "legacy_browser_screenshot",
					description: "Take a browser screenshot.",
					parameters: Type.Object({}),
				},
			],
			["legacy_browser_screenshot"],
		);
		const result = await search.execute(
			"probe",
			{
				steps: [
					{ capability: "web", action: "search" },
					{ capability: "browser", action: "screenshot", query: "browser_take_screenshot" },
				],
				limit: 1,
			},
			undefined,
			undefined,
			undefined!,
		);
		expect(result.details.steps[1].status).toBe("metadata_match");
		expect(result.details.steps[1].tools[0]).toMatchObject({
			name: "legacy_browser_screenshot",
			alreadyActive: true,
		});
		expect(active()).toEqual(["legacy_browser_screenshot", "web_search"]);
	});
});
