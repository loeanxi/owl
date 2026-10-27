import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const browserTool: AgentTool = {
	name: "browser_navigate",
	label: "Browser navigate",
	description: "Open a page in the in-app browser",
	parameters: Type.Object({ url: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "已打开 https://example.com" }], details: {} }),
};

const grepTool: AgentTool = {
	name: "grep",
	label: "Grep",
	description: "Search file contents",
	parameters: Type.Object({ pattern: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "src/index.html:1" }], details: {} }),
};

describe("browser tool batch headings", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("gives a browser batch a fixed heading without spending a model round trip", async () => {
		const harness = await createHarness({ tools: [browserTool], toolBatchLabels: true });
		harnesses.push(harness);
		// 三步脚本：如果多出一次「只问一句 Label:」的模型请求，它会吃掉第二条，
		// 组标题就会变成模型写的那句。固定文案说明那次请求根本没发生。
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("browser_navigate", { url: "https://example.com" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Model wrote heading"),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("打开 example.com");

		const summaries = harness.eventsOfType("tool_use_summary");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]!.summary).toBe("Used the browser");
		// 正文那一轮只吃掉了第二条，第三条还留着 —— 没有额外的模型往返。
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("still asks the model when the batch mixes browser actions with other tools", async () => {
		const harness = await createHarness({ tools: [browserTool, grepTool], toolBatchLabels: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("browser_navigate", { url: "https://example.com" }), fauxToolCall("grep", { pattern: "brand" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Model wrote heading"),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("打开 example.com 并找 brand");

		const summaries = harness.eventsOfType("tool_use_summary");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]!.summary).toBe("Model wrote heading");
		// 标签请求吃掉了第二条，正文吃掉第三条。
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
