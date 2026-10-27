import type { AgentToolBatch } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	buildToolBatchLabelPrompt,
	generateToolBatchLabel,
	normalizeToolBatchLabel,
	TOOL_BATCH_LABEL_SYSTEM_PROMPT,
} from "../src/core/tool-batch-label.ts";

function batch(overrides: Partial<AgentToolBatch> = {}): AgentToolBatch {
	return {
		toolCalls: [
			{
				id: "tool-1",
				name: "grep",
				input: { pattern: "loean-{mark|word}" },
				output: [{ type: "text", text: "src/index.html:1" }],
			},
		],
		lastAssistantText: "find the brand markup",
		...overrides,
	};
}

describe("tool batch label prompt", () => {
	it("keeps Claude's system prompt wording", () => {
		// 照搬 Claude Code 的原文：过去时 + 最有辨识度的名词 + 砍掉冗长路径。
		expect(TOOL_BATCH_LABEL_SYSTEM_PROMPT).toContain("Keep the verb in past tense and the most distinctive noun");
		expect(TOOL_BATCH_LABEL_SYSTEM_PROMPT).toContain("git-commit-subject, not sentence");
		expect(TOOL_BATCH_LABEL_SYSTEM_PROMPT).toContain("- Searched in auth/");
	});

	it("asks for the intent, the tools and a single label", () => {
		const prompt = buildToolBatchLabelPrompt(batch());
		expect(prompt).toContain("User's intent (from assistant's last message): find the brand markup");
		expect(prompt).toContain("Tools completed:");
		expect(prompt).toContain("Tool: grep");
		expect(prompt).toContain('"pattern":"loean-{mark|word}"');
		expect(prompt.trimEnd().endsWith("Label:")).toBe(true);
	});

	it("drops the intent line when the assistant said nothing", () => {
		const prompt = buildToolBatchLabelPrompt(batch({ lastAssistantText: undefined }));
		expect(prompt).not.toContain("User's intent");
		expect(prompt).toContain("Tools completed:");
	});

	it("truncates long inputs like Claude does", () => {
		const prompt = buildToolBatchLabelPrompt(
			batch({ toolCalls: [{ id: "t", name: "bash", input: { command: "x".repeat(5000) }, output: [] }] }),
		);
		expect(prompt).toContain("...");
		expect(prompt.length).toBeLessThan(2000);
	});
});

describe("tool batch label normalization", () => {
	it("keeps the first line only", () => {
		expect(normalizeToolBatchLabel("Searched code\n\nbecause I wanted to")).toBe("Searched code");
	});

	it("drops wrapping quotes", () => {
		expect(normalizeToolBatchLabel('"Searched code"')).toBe("Searched code");
		expect(normalizeToolBatchLabel("`Searched code`")).toBe("Searched code");
	});

	it("rejects an empty answer", () => {
		expect(normalizeToolBatchLabel("   \n  ")).toBeUndefined();
	});
});

describe("generateToolBatchLabel", () => {
	const model = {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	} as never;

	it("returns the model's label", async () => {
		const label = await generateToolBatchLabel(batch(), {
			model,
			streamFn: (async () => ({
				result: async () => ({
					role: "assistant",
					content: [{ type: "text", text: "Searched code" }],
					api: "openai-responses",
					provider: "openai",
					model: "mock",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				}),
			})) as never,
		});
		expect(label).toBe("Searched code");
	});

	it("gives up quietly when the model call fails", async () => {
		const label = await generateToolBatchLabel(batch(), {
			model,
			streamFn: (async () => {
				throw new Error("network down");
			}) as never,
		});
		expect(label).toBeUndefined();
	});
});
