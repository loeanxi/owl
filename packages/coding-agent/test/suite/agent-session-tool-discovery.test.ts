import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type Tool,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { DEFAULT_TOOL_NAMES, SettingsManager } from "../../src/core/settings-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const INITIAL_TOOLS = [...DEFAULT_TOOL_NAMES, "tool_search", "skill_search", "ask_user_question"];
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

function tool(name: string, description: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		label: name,
		description,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
		...extra,
	};
}

function registerCapabilities(pi: ExtensionAPI): void {
	pi.registerTool(tool("skill_search", "Find skills", { exposure: "model-only", defaultActive: false }));
	pi.registerTool(tool("ask_user_question", "Ask the user"));
	pi.registerTool(
		tool("univer_new", "创建空白表格", { namespace: { name: "univer", description: "Office 表格与文档" } }),
	);
	pi.registerTool(
		tool("browser_screenshot", "Capture a browser screenshot", {
			async execute() {
				return { content: [{ type: "image", data: PIXEL, mimeType: "image/png" }], details: undefined };
			},
		}),
	);
	pi.registerTool(tool("secret_hidden", "Secret hidden capability", { exposure: "hidden" }));
	pi.registerTool(tool("subagent", "Delegate to a subagent", { exposure: "model-only", defaultActive: false }));
	for (let index = 0; index < 100; index++) {
		pi.registerTool(
			tool(`catalog_${index}`, `Unrelated installed capability ${index}. ${"Detailed instructions. ".repeat(30)}`),
		);
	}
	// A third-party startup hook that eagerly requests all its tools, as web auto mode can do.
	pi.on("session_start", () => {
		pi.registerTool(tool("late_registered", "A tool registered during startup"));
		pi.setActiveTools([...pi.getActiveTools(), "univer_new", "browser_screenshot", "late_registered"]);
	});
	pi.on("before_agent_start", (event) => {
		pi.registerTool(tool("late_turn_tool", "A tool registered during a turn"));
		pi.setActiveTools([...pi.getActiveTools(), "late_turn_tool"]);
		event.systemPromptOptions.selectedTools.push("late_turn_tool");
	});
}

function names(context: TranscriptContext): string[] {
	return getCurrentTools(context.messages).map((entry) => entry.name);
}

describe("on-demand desktop tool loadout", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	async function makeHarness(extra: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness({
			initialActiveToolNames: INITIAL_TOOLS,
			toolActivation: "on-demand",
			extensionFactories: [createToolSearchExtension(), registerCapabilities],
			...extra,
		});
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("sends only the base loadout for a greeting despite over 100 registered tools and eager startup hooks", async () => {
		const harness = await makeHarness();
		expect(harness.session.getAllTools().length).toBeGreaterThan(100);
		let declared: Tool[] = [];
		harness.setResponses([
			(context) => {
				declared = getCurrentTools(context.messages);
				return fauxAssistantMessage("你好，有什么需要帮助的？");
			},
		]);
		await harness.session.prompt("你好");
		expect(declared.map((entry) => entry.name).sort()).toEqual([...INITIAL_TOOLS].sort());
		expect(JSON.stringify(declared).length).toBeLessThan(22000);
		expect(declared.find((entry) => entry.name === "tool_search")?.description).toContain("univer");
		expect(declared.find((entry) => entry.name === "tool_search")?.description).not.toContain("secret_hidden");
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
	});

	it("loads a Chinese match for the next model request and preserves native image results", async () => {
		const harness = await makeHarness();
		let activated: string[] = [];
		let imageContent: unknown;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "浏览器截图", limit: 1 }), {
				stopReason: "toolUse",
			}),
			(context) => {
				activated = names(context);
				return fauxAssistantMessage(fauxToolCall("browser_screenshot", {}), { stopReason: "toolUse" });
			},
			(context) => {
				const result = context.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "browser_screenshot",
				);
				imageContent = result?.content;
				return fauxAssistantMessage("已查看截图。");
			},
		]);
		await harness.session.prompt("看一下浏览器截图");
		expect(activated).toContain("browser_screenshot");
		expect(activated).not.toContain("univer_new");
		expect(imageContent).toContainEqual(expect.objectContaining({ type: "image", mimeType: "image/png" }));
	});

	it("discovers inactive model-only tools without exposing them to codemode", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "子代理", limit: 1 }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("使用子代理");
		expect(harness.session.getActiveToolNames()).toContain("subagent");
		expect(harness.session.getCallableToolNames()).not.toContain("subagent");
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolName: "subagent", isError: false }),
		);
	});

	it.each([{ tools: ["read"] }, { tools: [] }])(
		"respects a complete defaultTools replacement $tools",
		async ({ tools: configured }) => {
			const harness = await makeHarness();
			const { session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				model: harness.getModel(),
				settingsManager: SettingsManager.inMemory({ defaultTools: configured }),
				resourceLoader: harness.session.resourceLoader,
				sessionManager: SessionManager.inMemory(harness.tempDir),
				toolActivation: "on-demand",
			});
			cleanups.push(() => session.dispose());
			await session.bindExtensions({});
			harness.setResponses([fauxAssistantMessage("你好")]);
			await session.prompt("你好");
			expect(session.getActiveToolNames()).toEqual(configured);
		},
	);

	it("does not discover excluded or hidden tools and still runs the normal permission hook", async () => {
		let executed = false;
		const permissions: ExtensionFactory = (pi) => {
			pi.registerTool(
				tool("browser_screenshot", "Capture browser screenshot", {
					async execute() {
						executed = true;
						return { content: [{ type: "text", text: "unexpected" }], details: undefined };
					},
				}),
			);
			pi.on("tool_call", (event) =>
				event.toolName === "browser_screenshot" ? { block: true, reason: "Permission denied" } : undefined,
			);
		};
		const harness = await makeHarness({
			excludedToolNames: ["univer_new"],
			extensionFactories: [createToolSearchExtension(), registerCapabilities, permissions],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "univer_new", limit: 1 }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(names(context)).not.toContain("univer_new");
				expect(names(context)).not.toContain("secret_hidden");
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "browser_screenshot", limit: 1 }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(fauxToolCall("browser_screenshot", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("操作未获授权。"),
		]);
		await harness.session.prompt("查看截图");
		expect(executed).toBe(false);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolName: "browser_screenshot", isError: true }),
		);
	});

	it("keeps searched tools on SDK resume and restores the smaller set on a pre-search branch", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage("你好"),
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "创建表格", limit: 1 }), { stopReason: "toolUse" }),
			fauxAssistantMessage("表格工具已准备好"),
		]);
		await harness.session.prompt("你好");
		const beforeSearch = harness.sessionManager.getLeafId()!;
		await harness.session.prompt("创建表格");
		const afterSearch = harness.sessionManager.getLeafId()!;
		expect(harness.session.getActiveToolNames()).toContain("univer_new");

		const { session: resumed } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			model: harness.getModel(),
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: harness.sessionManager,
			toolActivation: "on-demand",
		});
		cleanups.push(() => resumed.dispose());
		await resumed.bindExtensions({});
		expect(resumed.getActiveToolNames()).toContain("univer_new");
		expect(resumed.getActiveToolNames()).not.toContain("late_registered");
		await resumed.navigateTree(beforeSearch);
		expect(resumed.getActiveToolNames()).not.toContain("univer_new");
		await resumed.navigateTree(afterSearch);
		expect(resumed.getActiveToolNames()).toContain("univer_new");

		const forkManager = SessionManager.inMemory(harness.tempDir, undefined, [
			harness.sessionManager.getHeader()!,
			...harness.sessionManager.getEntries(),
		]);
		forkManager.createBranchedSession(afterSearch);
		const { session: forked } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			model: harness.getModel(),
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: forkManager,
			toolActivation: "on-demand",
		});
		cleanups.push(() => forked.dispose());
		await forked.bindExtensions({});
		expect(forked.sessionId).not.toBe(resumed.sessionId);
		expect(forked.getActiveToolNames()).toContain("univer_new");
		expect(forked.getActiveToolNames()).not.toContain("late_registered");
	});

	it("the SDK keeps explicitly configured codemode and an allowlist cannot be expanded by discovery", async () => {
		const harness = await makeHarness({
			extensionFactories: [createToolSearchExtension(), createCodemodeExtension(), registerCapabilities],
		});
		const settings = SettingsManager.inMemory({ defaultTools: ["+codemode"] });
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			model: harness.getModel(),
			settingsManager: settings,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			toolActivation: "on-demand",
		});
		cleanups.push(() => session.dispose());
		await session.bindExtensions({});
		expect(session.getActiveToolNames()).toContain("codemode");
		expect(session.getActiveToolNames()).not.toContain("browser_screenshot");
		const restricted = await makeHarness({ allowedToolNames: ["read", "tool_search"] });
		expect(
			restricted.session
				.getAllTools()
				.map((entry) => entry.name)
				.sort(),
		).toEqual(["read", "tool_search"]);
	});
});
