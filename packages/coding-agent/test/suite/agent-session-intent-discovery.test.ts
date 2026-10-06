import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { registerOfficeTools } from "../../../owl-univer-office/src/tools.ts";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import type { ToolSearchToolDetails } from "../../src/extensions/tool-search/tool.ts";
import { createNewsTools } from "../../src/modes/desktop/news-tools.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

function tool(name: string, description: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		label: name,
		description,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "simulated" }], details: undefined };
		},
		...extra,
	};
}

function registerCapabilities(pi: ExtensionAPI): void {
	// Use the real Office declarations: creating a container is not creating Sheet content.
	registerOfficeTools(pi, { call: async () => ({}) });
	// The media actions mirror the real bridge's enum, including its toggle-only pause operation.
	pi.registerTool(
		tool(
			"media_bridge_control",
			"Control the explicitly configured local media player. Use media_bridge_status first and only call operations listed as available in capabilities.",
			{
				parameters: Type.Object({
					action: Type.Union([Type.Literal("play-pause"), Type.Literal("next"), Type.Literal("set-volume")]),
				}),
			},
		),
	);
	pi.registerTool(
		tool(
			"media_bridge_status",
			"Read the current status of the explicitly configured local media player. Read-only.",
		),
	);
	pi.registerTool(
		tool(
			"media_bridge_memory",
			"Read local music listening history and favorites. Read-only; never writes back to a music player.",
		),
	);
	pi.registerTool(
		tool("edit_image", "Edit, combine, or restyle existing images with the configured provider.", {
			parameters: Type.Object({
				prompt: Type.String({ description: "Describe the changes to make while preserving everything else." }),
				source_path: Type.Optional(Type.String({ description: "Path of an existing workspace image." })),
			}),
		}),
	);
	pi.registerTool(tool("generate_image", "Generate a new image from a prompt."));
	pi.registerTool(tool("update_user_impression", "Update user background and preferences in memory."));
	pi.registerTool(
		tool("web_search", "Search the web and return source-linked search results.", {
			parameters: Type.Object({ query: Type.String() }),
		}),
	);
	pi.registerTool(
		tool("fetch_content", "Fetch full text content from a web page URL.", {
			// These are the web-access fetch output modes, not the operation performed.
			parameters: Type.Object({
				url: Type.String(),
				mode: Type.Optional(Type.Union([Type.Literal("readable"), Type.Literal("raw"), Type.Literal("answer")])),
			}),
		}),
	);
	pi.registerTool(
		tool("lsp_navigation", "Navigate source code with the Language Server Protocol.", {
			parameters: Type.Object({
				operation: Type.Union([
					Type.Literal("references"),
					Type.Literal("incomingCalls"),
					Type.Literal("definition"),
				]),
			}),
		}),
	);
	for (const definition of createNewsTools(
		async () => ({}),
		"discovery-test",
		() => {},
	)) {
		pi.registerTool(definition);
	}
}

function result(harness: Harness): ToolSearchToolDetails {
	const message = getToolResult(harness, "tool_search");
	expect(message.isError, getMessageText(message)).toBe(false);
	return JSON.parse(getMessageText(message)) as ToolSearchToolDetails;
}

describe("intent-aware tool discovery through a real agent session", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	async function makeHarness(): Promise<Harness> {
		const harness = await createHarness({
			initialActiveToolNames: ["tool_search"],
			toolActivation: "on-demand",
			extensionFactories: [createToolSearchExtension(), registerCapabilities],
		});
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("uses action enums to discover media control without claiming its runtime state changed", async () => {
		const harness = await makeHarness();
		let nextRequestTools: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tool_search", {
					steps: [{ capability: "media", action: "pause", target: "music" }],
					limit: 1,
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				nextRequestTools = getCurrentTools(context.messages).map((entry) => entry.name);
				return fauxAssistantMessage("已找到控制入口，执行前还需要检查当前播放器状态。");
			},
		]);
		await harness.session.prompt("继续");
		expect(result(harness).loaded).toEqual(["media_bridge_control"]);
		expect(result(harness).steps[0].status).toBe("metadata_match");
		expect(nextRequestTools).toContain("media_bridge_control");
		expect(nextRequestTools).not.toContain("media_bridge_memory");
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	});

	it("allocates a discovery budget across research, source reading, and Office creation", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tool_search", {
					steps: [
						{ capability: "web", action: "search", target: "industry research" },
						{ capability: "web", action: "fetch", target: "article content" },
						{ capability: "spreadsheet", action: "create", target: "Sheet" },
					],
					limit: 3,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已分步找到工具。"),
		]);
		await harness.session.prompt("继续");
		const found = result(harness);
		expect(found.loaded).toHaveLength(3);
		expect(found.steps).toHaveLength(3);
		expect(found.steps.map((step) => step.status)).toEqual(["metadata_match", "metadata_match", "metadata_match"]);
		expect(found.steps[0].tools.map((entry) => entry.name)).toEqual(["web_search"]);
		expect(found.steps[1].tools.map((entry) => entry.name)).toEqual(["fetch_content"]);
		expect(found.steps[2].tools.some((entry) => ["univer_new", "univer_unit"].includes(entry.name))).toBe(true);
		expect(found.loaded).not.toContain("univer_status");
		expect(found.loaded).not.toContain("univer_api");
	});

	it("rejects a same-domain candidate when the requested delete action is unsupported", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tool_search", { steps: [{ capability: "media", action: "delete", target: "favorites" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("当前工具没有声明删除收藏能力。"),
		]);
		await harness.session.prompt("继续");
		const found = result(harness);
		expect(found.loaded).toEqual([]);
		expect(found.steps[0].status).not.toBe("metadata_match");
		expect(found.steps[0].tools).toEqual([]);
		expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
	});

	it("keeps image constraints visible instead of treating generic editing as proof of transparent output", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tool_search", {
					steps: [
						{
							capability: "image",
							action: "edit",
							target: "existing image",
							constraints: ["transparent alpha background"],
						},
					],
					limit: 1,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("需要继续确认透明输出能力。"),
		]);
		await harness.session.prompt("把这张图的背景变透明");
		const found = result(harness);
		expect(found.steps[0].uncheckedConstraints).toContain("transparent alpha background");
		expect(found.loaded).not.toContain("update_user_impression");
		expect(found.loaded).not.toContain("generate_image");
	});

	it("keeps code references separate from generic news search", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tool_search", {
					steps: [{ capability: "code", action: "references", target: "function callers" }],
					limit: 1,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已找到代码引用查询入口。"),
		]);
		await harness.session.prompt("继续");
		expect(result(harness).loaded).toEqual(["lsp_navigation"]);
		expect(harness.session.getActiveToolNames()).not.toContain("news_hot");
	});

	it("does not treat source-linked web results as a source-code search capability", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tool_search", {
					steps: [{ capability: "code", action: "search", target: "workspace symbols" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("需要进一步定位代码搜索能力。"),
		]);
		await harness.session.prompt("搜索项目代码中的符号");
		expect(result(harness).loaded).not.toContain("web_search");
	});

	it("reports a budget shortage separately from unavailable capabilities", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("tool_search", {
					steps: [
						{ capability: "web", action: "search" },
						{ capability: "web", action: "fetch" },
					],
					limit: 1,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("下一步再加载读取正文的工具。"),
		]);
		await harness.session.prompt("继续");
		const found = result(harness);
		expect(found.loaded).toHaveLength(1);
		expect(found.steps[1].status).toBe("budget_limited");
	});

	it("preloads a metadata match onto the first model request", async () => {
		const harness = await makeHarness();
		let firstTools: string[] = [];
		harness.setResponses([
			(context) => {
				firstTools = getCurrentTools(context.messages).map((entry) => entry.name);
				return fauxAssistantMessage("已准备播放控制。");
			},
		]);
		await harness.session.prompt("把歌暂停一下");
		expect(firstTools).toContain("media_bridge_control");
		expect(firstTools).not.toContain("media_bridge_memory");
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
	});

	it("returns an already active match so discovery does not falsely report a missing capability", async () => {
		const harness = await makeHarness();
		const request = {
			steps: [{ capability: "web", action: "search" }],
			limit: 1,
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", request), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("tool_search", request), { stopReason: "toolUse" }),
			fauxAssistantMessage("搜索工具已加载，可以继续使用。"),
		]);
		await harness.session.prompt("找到网页搜索工具并确认它可用");
		const found = result(harness);
		expect(found.steps[0].status).toBe("metadata_match");
		expect(found.steps[0].tools).toContainEqual(expect.objectContaining({ name: "web_search", alreadyActive: true }));
		expect(harness.session.getActiveToolNames().filter((name) => name === "web_search")).toHaveLength(1);
	});
});
