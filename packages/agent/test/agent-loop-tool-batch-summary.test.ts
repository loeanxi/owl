import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolBatch,
} from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
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
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

const echoSchema = Type.Object({ value: Type.String() });

function echoTool(): AgentTool<typeof echoSchema> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: echoSchema,
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
		},
	};
}

/** One assistant turn that calls two tools, then a final text turn. */
function twoToolBatchStream() {
	let callIndex = 0;
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			if (callIndex === 0) {
				stream.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						[
							{ type: "text", text: "let me look" },
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "one" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "two" } },
						],
						"toolUse",
					),
				});
			} else {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			}
			callIndex++;
		});
		return stream;
	};
}

async function runWithBatchHook(afterToolBatch: AgentLoopConfig["afterToolBatch"]): Promise<AgentEvent[]> {
	const context: AgentContext = { messages: [], tools: [echoTool()] };
	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm: identityConverter,
		...(afterToolBatch ? { afterToolBatch } : {}),
	};
	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, twoToolBatchStream());
	for await (const event of stream) events.push(event);
	return events;
}

describe("tool batch summary", () => {
	it("emits the model-written label with the batch's tool call ids", async () => {
		const events = await runWithBatchHook(async () => "Searched code");
		const summaries = events.filter((event) => event.type === "tool_use_summary");
		expect(summaries).toEqual([
			{ type: "tool_use_summary", summary: "Searched code", toolCallIds: ["tool-1", "tool-2"] },
		]);
	});

	it("hands the batch's calls and the assistant's last text to the hook", async () => {
		let seen: AgentToolBatch | undefined;
		await runWithBatchHook(async (batch) => {
			seen = batch;
			return "Searched code";
		});
		expect(seen).toBeDefined();
		expect(seen!.lastAssistantText).toBe("let me look");
		expect(seen!.toolCalls.map((call) => call.id)).toEqual(["tool-1", "tool-2"]);
		expect(seen!.toolCalls[0]!.name).toBe("echo");
		expect(seen!.toolCalls[0]!.input).toEqual({ value: "one" });
		expect(seen!.toolCalls[1]!.input).toEqual({ value: "two" });
		// The tool output is handed over too — Claude's label prompt shows it.
		expect(JSON.stringify(seen!.toolCalls[0]!.output)).toContain("echoed: one");
	});

	it("stays silent when the hook declines to write a label", async () => {
		const events = await runWithBatchHook(async () => undefined);
		expect(events.some((event) => event.type === "tool_use_summary")).toBe(false);
	});

	it("never lets a failing label break the run", async () => {
		const events = await runWithBatchHook(async () => {
			throw new Error("model unavailable");
		});
		expect(events.some((event) => event.type === "tool_use_summary")).toBe(false);
		// The run still reached the final assistant turn.
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
	});

	it("does not label a batch that never ran", async () => {
		// The tool budget refuses the whole batch, so there is nothing to summarize.
		let called = false;
		const context: AgentContext = { messages: [], tools: [echoTool()] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxToolExecutions: 1,
			afterToolBatch: async () => {
				called = true;
				return "Searched code";
			},
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, twoToolBatchStream());
		for await (const event of stream) events.push(event);
		expect(called).toBe(false);
		expect(events.some((event) => event.type === "tool_use_summary")).toBe(false);
	});
});
