import { readFileSync } from "node:fs";
import { fauxAssistantMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ComputerUseRuntime } from "../../../owl-computer-use/src/plugin/runtime.ts";
import { createComputerTools } from "../../../owl-computer-use/src/plugin/tools-v2.ts";
import type { ExtensionAPI, ToolDefinition, ToolInfo } from "../../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { preloadToolsForUserText } from "../../src/extensions/tool-search/tool.ts";
import { createHarness } from "./harness.ts";

const computerTask = readFileSync(new URL("../fixtures/computer-use-user-task.txt", import.meta.url), "utf8");
const computerNames = ["computer_observe", "computer_act", "computer_release"];

function computerTools() {
	const unexpected = async (): Promise<never> => {
		throw new Error("Metadata preload must not operate the desktop");
	};
	return createComputerTools(
		new ComputerUseRuntime({ windows: unexpected, observe: unexpected, act: unexpected, release: unexpected }),
	);
}

function fixture(
	definitions: readonly Pick<
		ToolDefinition,
		"name" | "description" | "parameters" | "promptGuidelines" | "exposure"
	>[],
	initial: string[] = ["read", "bash", "edit"],
) {
	let active = [...initial];
	const registered: ToolInfo[] = definitions.map((definition) => ({
		...definition,
		exposure: definition.exposure ?? "direct",
		sourceInfo: createSyntheticSourceInfo(`named-preload:${definition.name}`, { source: "test" }),
	}));
	return {
		getAllTools: () => registered,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
}

function tool(name: string, exposure: ToolDefinition["exposure"] = "model-only"): ToolDefinition {
	return {
		name,
		label: name,
		description: "A registered optional tool",
		parameters: Type.Object({}),
		exposure,
		defaultActive: false,
		async execute() {
			throw new Error("Preloading must not execute tools");
		},
	};
}

describe("explicit tool names in user-task preloading", () => {
	it("loads the real computer declarations for the complete captured user request", () => {
		const tools = fixture(computerTools());
		expect(preloadToolsForUserText(tools, computerTask)?.loaded).toEqual(computerNames);
		expect(tools.getActiveTools()).toEqual(["read", "bash", "edit", ...computerNames]);
	});

	it("declares all three real model-only tools on the first faux provider request", async () => {
		const register = (pi: ExtensionAPI): void => {
			for (const definition of computerTools()) pi.registerTool(definition);
		};
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "tool_search"],
			toolActivation: "on-demand",
			extensionFactories: [createToolSearchExtension(), register],
		});
		try {
			await harness.session.bindExtensions({});
			let firstTools: string[] = [];
			harness.setResponses([
				(context) => {
					firstTools = getCurrentTools(context.messages).map((entry) => entry.name);
					return fauxAssistantMessage("工具已准备，尚未操作桌面。");
				},
			]);
			await harness.session.prompt(computerTask);
			expect(firstTools).toEqual(expect.arrayContaining(computerNames));
			for (const name of computerNames) expect(harness.session.getCallableToolNames()).not.toContain(name);
			expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});

	it("uses registered names generically, ignoring unknown and hidden names", () => {
		const tools = fixture([tool("custom_one"), tool("custom_two", "direct"), tool("secret_hidden", "hidden")]);
		expect(
			preloadToolsForUserText(tools, "请加载 custom_one、custom_two、secret_hidden、unknown_tool。")?.loaded,
		).toEqual(["custom_one", "custom_two"]);
	});

	it("shares the new-tool budget and does not charge already active matches", () => {
		const tools = fixture([tool("custom_one"), tool("custom_two"), tool("custom_three")], ["custom_one"]);
		const result = preloadToolsForUserText(tools, "Use custom_one, custom_two and custom_three.", 1);
		expect(result?.loaded).toEqual(["custom_two"]);
		expect(tools.getActiveTools()).toEqual(["custom_one", "custom_two"]);
	});

	it.each([
		"不要使用 computer_act 点击窗口。",
		"Do not call computer_act to click a window.",
		"只读分析 computer_act 的源码，解释它如何点击窗口，不执行桌面操作。",
		"查看 computer_act 的源码中如何点击窗口。",
		"Explain the source code that calls computer_act to click a window.",
		"分析提示词：使用 computer_act 点击窗口。",
	])("does not load operations for negative or source-only mentions: %s", (text) => {
		const tools = fixture(computerTools());
		expect(preloadToolsForUserText(tools, text)?.loaded ?? []).toEqual([]);
	});

	it("keeps a later affirmative request separate from source discussion and a forbidden tool", () => {
		const tools = fixture(computerTools());
		const result = preloadToolsForUserText(
			tools,
			"只读分析 computer_act 的源码，然后实际使用 computer_observe 观察窗口，不要调用 computer_act。",
		);
		expect(result?.loaded).toEqual(["computer_observe"]);
	});

	it("treats an explicitly requested read-only window observation as an operation", () => {
		const tools = fixture(computerTools());
		expect(preloadToolsForUserText(tools, "只使用 computer_observe 查看当前窗口。")?.loaded).toEqual([
			"computer_observe",
		]);
	});

	it.each(["不要调用 old_tool，改用 new_tool。", "Do not call old_tool, use new_tool instead."])(
		"separates a forbidden name from an affirmative alternative: %s",
		(text) => {
			const tools = fixture([tool("old_tool"), tool("new_tool")]);
			expect(preloadToolsForUserText(tools, text)?.loaded).toEqual(["new_tool"]);
		},
	);

	it("accepts an exact registered tool name as the whole request", () => {
		const tools = fixture([tool("custom_one")]);
		expect(preloadToolsForUserText(tools, "custom_one")?.loaded).toEqual(["custom_one"]);
	});

	it("cannot expand a session allowlist through explicit names", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "tool_search"],
			allowedToolNames: ["read", "tool_search"],
			toolActivation: "on-demand",
			extensionFactories: [
				createToolSearchExtension(),
				(pi) => {
					for (const definition of computerTools()) pi.registerTool(definition);
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			harness.setResponses([fauxAssistantMessage("此会话未启用桌面工具。")]);
			await harness.session.prompt(computerTask);
			expect(harness.session.getActiveToolNames()).toEqual(["read", "tool_search"]);
		} finally {
			harness.cleanup();
		}
	});
});
