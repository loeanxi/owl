import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type { ToolInfo } from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createToolSearchToolDefinition } from "../src/extensions/tool-search/tool.ts";

async function discovery() {
	const path = fileURLToPath(new URL("../../owl-computer-use/index.ts", import.meta.url));
	const loaded = await loadExtensions([path], process.cwd());
	expect(loaded.errors).toEqual([]);
	const definitions = [...loaded.extensions[0]!.tools.values()].map(({ definition }) => definition);
	const tools: ToolInfo[] = definitions.map((definition) => ({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		exposure: "model-only",
		sourceInfo: createSyntheticSourceInfo(definition.name, { source: "test" }),
	}));
	let active = ["computer_observe"];
	return createToolSearchToolDefinition({
		tools: {
			getAllTools: () => tools,
			getActiveTools: () => active,
			setActiveTools: (names) => {
				active = names;
			},
		},
	});
}

describe("computer use discovery from the actual registered metadata", () => {
	it("loads all three explicitly requested tools in one lookup", async () => {
		const search = await discovery();
		const result = await search.execute(
			"discover",
			{ query: "computer_observe computer_act computer_release" },
			undefined,
			undefined,
			undefined!,
		);
		expect(result.details.steps.flatMap((step) => step.tools.map((tool) => tool.name))).toEqual([
			"computer_observe",
			"computer_act",
			"computer_release",
		]);
		expect(result.details.loaded).toEqual(["computer_act", "computer_release"]);
	});

	it("does not substitute the already-active observe tool for a named act step", async () => {
		const search = await discovery();
		const result = await search.execute(
			"discover",
			{ steps: [{ capability: "computer", action: "act", query: "computer_act 键盘输入 点击 快捷键" }] },
			undefined,
			undefined,
			undefined!,
		);
		expect(result.details.loaded).toEqual(["computer_act"]);
		expect(result.details.steps[0]!.tools.map((tool) => tool.name)).toEqual(["computer_act"]);
	});

	it("still checks a concrete unsupported operation against the named tool", async () => {
		const search = await discovery();
		const result = await search.execute(
			"discover",
			{ steps: [{ capability: "computer", action: "fly", query: "computer_act" }] },
			undefined,
			undefined,
			undefined!,
		);
		expect(result.details.loaded).toEqual([]);
		expect(result.details.steps[0]!.status).toBe("refine");
	});

	it("does not treat a tool name prefix as an explicit name", async () => {
		const search = await discovery();
		const result = await search.execute("discover", { query: "computer_actuator" }, undefined, undefined, undefined!);
		expect(result.details.loaded).toEqual([]);
	});
});
