import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const grepTool: AgentTool = {
	name: "grep",
	label: "Grep",
	description: "Search file contents",
	parameters: Type.Object({ pattern: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "src/index.html:1" }], details: {} }),
};

describe("AgentSession tool batch labels", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("gives the batch a model-written label and publishes it as tool_use_summary", async () => {
		const harness = await createHarness({ tools: [grepTool], toolBatchLabels: true });
		harnesses.push(harness);
		// 顺序：工具调用 → 标签请求（无工具）→ 下一轮正文。
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "brand" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Searched code"),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("find the brand markup");

		const summaries = harness.eventsOfType("tool_use_summary");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]!.summary).toBe("Searched code");
		expect(summaries[0]!.toolCallIds).toHaveLength(1);
	});

	it("does not ask the model for a label when the host did not opt in", async () => {
		const harness = await createHarness({ tools: [grepTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "brand" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("find the brand markup");

		// 没有额外请求：脚本里的 "done" 仍然留给正文那一轮。
		expect(harness.eventsOfType("tool_use_summary")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
