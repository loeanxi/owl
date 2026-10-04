import { describe, expect, it } from "vitest";
import { wrapToolDefinition } from "../../coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { createRenderUiTool } from "../src/plugin/tool.ts";

describe("render_ui result contract", () => {
	it("reports an invalid spec as a tool failure so the agent can recover", async () => {
		const result = await wrapToolDefinition(createRenderUiTool()).execute("invalid", { spec: {} });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("error=invalid_spec") }),
		]);
		expect(result.details).toMatchObject({ genuiSpec: null });
	});

	it("keeps a valid one-component answer successful", async () => {
		const result = await wrapToolDefinition(createRenderUiTool()).execute("valid", {
			spec: { items: [{ type: "list", items: ["One", "Two", "Three"] }] },
		});
		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ genuiSpec: { items: [{ type: "list" }] } });
	});
});
