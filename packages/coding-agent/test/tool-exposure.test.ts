import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolDefinition, ToolExposure } from "../src/core/extensions/index.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	isActivatedOnRegistration,
	isAllowedToolName,
	isCallableExposure,
	isDeclarableExposure,
	isIndirectExposure,
	type ToolDefinitionEntry,
	toolExposureOf,
} from "../src/core/tool-exposure.ts";

function entry(exposure: ToolExposure, defaultActive?: boolean): ToolDefinitionEntry {
	return {
		definition: {
			name: "probe",
			label: "Probe",
			description: "probe tool",
			parameters: Type.Object({}),
			exposure,
			execute: async () => ({ content: [{ type: "text", text: "probe" }], details: undefined }),
			...(defaultActive === undefined ? {} : { defaultActive }),
		},
		sourceInfo: createSyntheticSourceInfo("<test:probe>", { source: "builtin" }),
	};
}

describe("tool exposure predicates", () => {
	it.each([
		["direct", true],
		["model-only", true],
		["codemode", false],
		["deferred", false],
		["hidden", false],
	] as const)("declarability of %s exposure is %s", (exposure, expected) => {
		expect(isDeclarableExposure(exposure)).toBe(expected);
	});

	it.each([
		["codemode", true],
		["deferred", true],
		["direct", false],
		["model-only", false],
		["hidden", false],
	] as const)("indirect reachability of %s exposure is %s", (exposure, expected) => {
		expect(isIndirectExposure(exposure)).toBe(expected);
	});

	it("reads exposure from the registry and falls back to direct for unregistered names", () => {
		const tools = new Map<string, ToolDefinitionEntry>([
			["visible", entry("deferred")],
			["hidden", entry("hidden")],
		]);
		expect(toolExposureOf(tools, "visible")).toBe("deferred");
		expect(toolExposureOf(tools, "hidden")).toBe("hidden");
		expect(toolExposureOf(tools, "never-registered")).toBe("direct");
	});

	describe("allow/deny configuration", () => {
		it("allows everything when no allow list is configured", () => {
			expect(isAllowedToolName("probe", undefined, undefined)).toBe(true);
		});

		it("allows only listed names when an allow list is configured", () => {
			const allowed = new Set(["a"]);
			expect(isAllowedToolName("a", allowed, undefined)).toBe(true);
			expect(isAllowedToolName("b", allowed, undefined)).toBe(false);
		});

		it("drops excluded names even when the allow list contains them", () => {
			const allowed = new Set(["a", "b"]);
			const excluded = new Set(["b"]);
			expect(isAllowedToolName("a", allowed, excluded)).toBe(true);
			expect(isAllowedToolName("b", allowed, excluded)).toBe(false);
		});

		it("drops an excluded name when no allow list is configured", () => {
			expect(isAllowedToolName("a", undefined, new Set(["a"]))).toBe(false);
		});
	});

	describe("callability through ctx.executeTool()", () => {
		it("exposes indirect tools regardless of the active set", () => {
			const active = new Set<string>();
			expect(isCallableExposure("mcp", "codemode", active)).toBe(true);
			expect(isCallableExposure("mcp", "deferred", active)).toBe(true);
		});

		it("exposes active direct tools only", () => {
			const active = new Set(["plain"]);
			expect(isCallableExposure("plain", "direct", active)).toBe(true);
			expect(isCallableExposure("other", "direct", active)).toBe(false);
		});

		it("never exposes model-only or hidden tools", () => {
			const active = new Set(["a", "b"]);
			expect(isCallableExposure("a", "model-only", active)).toBe(false);
			expect(isCallableExposure("b", "hidden", active)).toBe(false);
		});
	});

	describe("activation on registration", () => {
		it.each(["codemode", "deferred", "hidden"] as const)("never activates %s exposure tools", (exposure) => {
			expect(
				isActivatedOnRegistration({
					name: "probe",
					activation: "eager",
					exposure,
					initialActiveToolNames: ["probe"],
					defaultActive: true,
				}),
			).toBe(false);
		});

		it("activates startup tools under on-demand and ignores the definition's own default", () => {
			const input = {
				name: "probe",
				activation: "on-demand" as const,
				initialActiveToolNames: ["probe"],
				defaultActive: false,
			};
			expect(isActivatedOnRegistration({ ...input, exposure: "direct" })).toBe(true);
			expect(isActivatedOnRegistration({ ...input, exposure: "model-only" })).toBe(true);
		});

		it("leaves non-startup tools inactive under on-demand even when defaultActive is true", () => {
			expect(
				isActivatedOnRegistration({
					name: "late",
					activation: "on-demand",
					exposure: "direct",
					initialActiveToolNames: ["probe"],
					defaultActive: true,
				}),
			).toBe(false);
		});

		it.each([
			[undefined, true],
			[true, true],
			[false, false],
		] as const)("activates eager tools when defaultActive is %s", (defaultActive, expected) => {
			expect(
				isActivatedOnRegistration({
					name: "probe",
					activation: "eager",
					exposure: "direct",
					initialActiveToolNames: [],
					defaultActive,
				}),
			).toBe(expected);
		});
	});
});

// Compile-time guard: the test fixture must stay assignable to the real definition type.
const _fixtureTypeCheck: ToolDefinition = entry("direct").definition;
void _fixtureTypeCheck;
