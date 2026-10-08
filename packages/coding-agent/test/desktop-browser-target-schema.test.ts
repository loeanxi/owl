import { runToolCall } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { BrowserHub } from "../src/modes/desktop/browser-hub.ts";

const required: readonly [string, JsonObject][] = [
	["browser_click", {}],
	["browser_type", { text: "fixture" }],
	["browser_fill", { text: "fixture" }],
	["browser_select", { values: ["calibration"] }],
	["browser_hover", {}],
	["browser_focus", { action: "focus" }],
];
const invalidTargets: JsonObject[] = [
	{},
	{ ref: 1, selector: "#name" },
	{ recipient: 13 },
	{ reff: "13" },
	{ ref: 1, recipient: 13 },
	{ selector: "#name", reff: "13" },
];

function createHub() {
	return new BrowserHub({
		onPagesChanged: () => {},
		onFrame: () => {},
		onFileChooser: () => {},
		onDiagnostic: () => {},
	});
}

describe("native browser target schemas through the real core validator", () => {
	it.each(required)("requires exactly one target and rejects wrong field names for %s", (name, input) => {
		const definition = createHub()
			.tools("schema-fixture")
			.find((tool) => tool.name === name)!;
		const validate = (args: JsonObject) =>
			validateToolArguments(definition, { type: "toolCall", id: "schema", name, arguments: args });
		for (const invalid of invalidTargets) {
			expect(() => validate({ ...input, ...invalid })).toThrow("Validation failed");
		}
		expect(validate({ ...input, ref: 1 })).toEqual({ ...input, ref: 1 });
		expect(validate({ ...input, selector: "#name" })).toEqual({ ...input, selector: "#name" });
		if (name === "browser_click") expect(() => validate({ ref: 1, clickCount: 1.5 })).toThrow("Validation failed");
		expect(() => validate({ ...input, ref: 1.5 })).toThrow("Validation failed");
		expect(() => validate({ ...input, ref: "13xyz" })).toThrow("Validation failed");
	});

	it("applies the same validator constraints to each bulk field and preserves targetless key/scroll operations", () => {
		const definitions = createHub().tools("schema-fixture");
		const bulk = definitions.find((tool) => tool.name === "browser_fill_form")!;
		for (const target of invalidTargets.slice(0, 4)) {
			expect(() =>
				validateToolArguments(bulk, {
					type: "toolCall",
					id: "schema",
					name: bulk.name,
					arguments: { fields: [{ kind: "fill", value: "fixture", ...target }] },
				}),
			).toThrow("Validation failed");
		}
		for (const [name, args] of [
			["browser_press_key", { key: "Enter" }],
			["browser_scroll", { direction: "down" }],
		] as const) {
			const definition = definitions.find((tool) => tool.name === name)!;
			expect(validateToolArguments(definition, { type: "toolCall", id: "schema", name, arguments: args })).toEqual(
				args,
			);
		}
	});

	it.each([
		["browser_fill", { recipient: 13, text: "2026-10-15" }],
		["browser_type", { reff: "13", text: "传感器例行校准，仅用于本地评测" }],
		["browser_click", { ref: true }],
	])("rejects the observed %s payload before its browser executor can start", async (name, args) => {
		const hub = createHub();
		const definition = hub.tools("schema-fixture").find((tool) => tool.name === name)!;
		const tool = wrapToolDefinition(definition);
		const execute = vi.spyOn(tool, "execute").mockResolvedValue({ content: [], details: undefined });
		try {
			const outcome = await runToolCall(
				{ type: "toolCall", id: "observed", name, arguments: args },
				{
					tools: [tool],
					assistantMessage: fauxAssistantMessage("fixture"),
					context: { messages: [], tools: [tool] },
				},
			);
			expect(outcome.isError).toBe(true);
			expect(execute).not.toHaveBeenCalled();
			expect(hub.listPages()).toEqual([]);
		} finally {
			await hub.dispose();
		}
	});
});
