import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	getCurrentSystemPrompt,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_AGENT_INSTRUCTIONS } from "../../src/modes/desktop/agent-instructions.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

// Public tool sequence from the reported project-inspection task. No private thinking,
// credentials, live provider, or machine-specific file contents belong in this fixture.
const inspectionBatches = [
	["ls", "find"],
	["ls", "ls", "ls"],
	["read", "ls", "ls"],
	["bash", "read"],
	["bash", "read"],
];

describe("AgentSession public progress contract", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function inspectionHarness(): Promise<Harness> {
		const tools: AgentTool[] = ["ls", "find", "read", "bash"].map((name) => ({
			name,
			label: name,
			description: "Offline inspection fixture",
			parameters: Type.Object({ target: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "fixture result" }], details: {} }),
		}));
		const harness = await createHarness({
			tools,
			resourceLoader: {
				...createTestResourceLoader(),
				getAppendSystemPrompt: () => [DESKTOP_AGENT_INSTRUCTIONS],
			},
		});
		harnesses.push(harness);
		return harness;
	}

	it("preserves actual text before tools without an extra model round or a changed user message", async () => {
		const harness = await inspectionHarness();
		const requests: TranscriptContext[] = [];
		const progress = ["先查看项目结构。", "", "已定位到实际工程目录，继续查看入口。", "", ""];
		harness.setResponses([
			...inspectionBatches.map((names, batch) => (context: TranscriptContext) => {
				requests.push(context);
				return fauxAssistantMessage(
					[
						...(progress[batch] ? [fauxText(progress[batch]!)] : []),
						...names.map((name, index) => fauxToolCall(name, { target: `${batch}/${index}` })),
					],
					{ stopReason: "toolUse" },
				);
			}),
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("查看完成。");
			},
		]);

		await harness.session.prompt("查看当前项目");

		expect(requests).toHaveLength(6);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getUserTexts(harness)).toEqual(["查看当前项目"]);
		expect(getAssistantTexts(harness)).toEqual([...progress, "查看完成。"]);
		const assistantEnds = harness.eventsOfType("message_end").filter((event) => event.message.role === "assistant");
		const firstAssistant = assistantEnds[0]?.message;
		if (firstAssistant?.role !== "assistant") throw new Error("expected an assistant response");
		expect(firstAssistant.content.map((part) => part.type)).toEqual(["text", "toolCall", "toolCall"]);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(12);
		const prompt = getCurrentSystemPrompt(requests[0]!.messages);
		expect(prompt).toContain("公开说明与这些工具调用放在同一条助手回复中");
		expect(prompt).toContain("默认最终回答控制在 10 行以内");
		expect(prompt).toContain("这只约束最终答复，不禁止");
		expect(prompt).not.toContain("用户在正文里看不到");
	});

	it("does not invent progress or retry the silent five-batch inspection sequence", async () => {
		const harness = await inspectionHarness();
		let requests = 0;
		harness.setResponses([
			...inspectionBatches.map((names, batch) => () => {
				requests++;
				return fauxAssistantMessage(
					names.map((name, index) => fauxToolCall(name, { target: `${batch}/${index}` })),
					{ stopReason: "toolUse" },
				);
			}),
			() => {
				requests++;
				return fauxAssistantMessage("查看完成。");
			},
		]);

		await harness.session.prompt("查看当前项目");

		expect(requests).toBe(6);
		expect(getAssistantTexts(harness)).toEqual(["", "", "", "", "", "查看完成。"]);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(12);
	});

	it.each([
		["只输出 JSON", '{"ok":true}'],
		["只输出代码", "const ok = true;"],
	])("preserves strict output and input without a runtime preface for %s", async (input, output) => {
		const harness = await inspectionHarness();
		let requests = 0;
		harness.setResponses([
			(context) => {
				requests++;
				expect(getCurrentSystemPrompt(context.messages)).toContain("优先满足用户指定的格式");
				return fauxAssistantMessage(output);
			},
		]);

		await harness.session.prompt(input);

		expect(requests).toBe(1);
		expect(getUserTexts(harness)).toEqual([input]);
		expect(getAssistantTexts(harness)).toEqual([output]);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
	});

	it("leaves a custom system prefix free of default communication rules at the provider boundary", async () => {
		const custom = "Custom exact prefix. Emit only the requested output.";
		const harness = await createHarness({
			resourceLoader: { ...createTestResourceLoader(), getSystemPrompt: () => custom },
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				const prompt = getCurrentSystemPrompt(context.messages);
				expect(prompt).toContain(custom);
				expect(prompt).not.toContain("公开说明");
				expect(prompt).not.toContain("过程说明");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("go");
		expect(getUserTexts(harness)).toEqual(["go"]);
		expect(getAssistantTexts(harness)).toEqual(["ok"]);
	});

	it("preserves an extension's exact forced prompt at the provider boundary", async () => {
		const forced = "  Exact force override.\nNo extra instructions.  ";
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({ systemPrompt: forced }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				expect(getCurrentSystemPrompt(context.messages)).toBe(forced);
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("go");
		expect(getUserTexts(harness)).toEqual(["go"]);
		expect(getAssistantTexts(harness)).toEqual(["ok"]);
	});
});
