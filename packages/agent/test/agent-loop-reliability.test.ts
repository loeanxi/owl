import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, AgentToolCall } from "../src/types.ts";

const schema = Type.Object({ value: Type.String() });
const model: Model<"openai-responses"> = {
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

function call(id: string, name = "operation", value = id): AgentToolCall {
	return { type: "toolCall", id, name, arguments: { value } };
}

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function tool(execute: AgentTool<typeof schema>["execute"]): AgentTool<typeof schema> {
	return { name: "operation", label: "Operation", description: "Offline operation", parameters: schema, execute };
}

async function replay(
	steps: AssistantMessage[],
	tools: AgentTool<typeof schema>[],
	options: Partial<AgentLoopConfig> = {},
): Promise<AgentMessage[]> {
	let index = 0;
	return runAgentLoop(
		[{ role: "user", content: "Complete the authorized task and verify it.", timestamp: 0 }],
		{ messages: [], tools },
		{
			model,
			convertToLlm: (messages) =>
				messages.filter((message) =>
					["system", "user", "assistant", "toolResult"].includes(message.role),
				) as Message[],
			...options,
		},
		() => {},
		undefined,
		() => {
			const stream = createAssistantMessageEventStream();
			const message = steps[index++] ?? response([{ type: "text", text: "done" }], "stop");
			stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
			stream.end(message);
			return stream;
		},
	);
}

describe("agent loop reliability regressions", () => {
	it("gives a user steer arriving during preparation its own explicit budget", async () => {
		let preparing = false;
		let delivered = false;
		let executed = 0;
		await replay(
			[response([call("first")], "toolUse"), response([call("second")], "toolUse")],
			[
				tool(async () => {
					executed++;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				}),
			],
			{
				maxToolExecutions: 1,
				prepareNextTurn: () => {
					preparing = true;
					return undefined;
				},
				getSteeringMessages: async () => {
					if (!preparing || delivered) return [];
					delivered = true;
					return [{ role: "user", content: "Now do the next operation.", timestamp: 1 }];
				},
			},
		);
		expect(executed).toBe(2);
	});

	it("does not let an extension continuation override a guarded stop", async () => {
		let rounds = 0;
		const messages = await replay(
			Array.from({ length: 4 }, (_, index) => response([call(String(index), "operation", "check")], "toolUse")),
			[tool(async () => ({ content: [{ type: "text", text: "failed" }], details: {}, isError: true }))],
			{ finishTurn: () => (++rounds < 10 ? { action: "continue" } : { action: "end" }) },
		);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(5);
	});

	it("does not multiply a known failing call through a parallel batch", async () => {
		let attempts = 0;
		await replay(
			[
				response([call("one", "operation", "check")], "toolUse"),
				response([call("two", "operation", "check")], "toolUse"),
				response([call("three", "operation", "check"), call("four", "operation", "check")], "toolUse"),
			],
			[
				tool(async () => {
					attempts++;
					return { content: [{ type: "text", text: "failed" }], details: {}, isError: true };
				}),
			],
		);
		expect(attempts).toBe(2);
	});

	it("starts a new failure window after a successful file repair", async () => {
		let attempts = 0;
		const repair = {
			...tool(async () => ({ content: [{ type: "text" as const, text: "changed" }], details: {} })),
			name: "edit",
		};
		await replay(
			[
				...Array.from({ length: 3 }, (_, index) =>
					response([call(`before-${index}`, "operation", "check")], "toolUse"),
				),
				response([call("repair", "edit")], "toolUse"),
				...Array.from({ length: 2 }, (_, index) =>
					response([call(`after-${index}`, "operation", "check")], "toolUse"),
				),
			],
			[
				tool(async () => {
					attempts++;
					return { content: [{ type: "text", text: "failed" }], details: {}, isError: true };
				}),
				repair,
			],
		);
		expect(attempts).toBe(5);
	});

	it("bounds repeated failures even when successful reads are interleaved", async () => {
		let attempts = 0;
		await replay(
			Array.from({ length: 8 }, (_, index) =>
				response([call(String(index), "operation", index % 2 === 0 ? "check" : "read")], "toolUse"),
			),
			[
				tool(async (_id, args) => {
					if (args.value === "check") attempts++;
					return {
						content: [{ type: "text", text: args.value === "check" ? "unchanged failure" : "file content" }],
						details: {},
						isError: args.value === "check",
					};
				}),
			],
		);
		expect(attempts).toBe(3);
	});

	it("bounds consecutive truncated tool responses without executing partial calls", async () => {
		let executed = 0;
		const messages = await replay(
			Array.from({ length: 8 }, (_, index) => response([call(String(index))], "length")),
			[
				tool(async () => {
					executed++;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				}),
			],
		);
		expect(executed).toBe(0);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(4);
		expect(JSON.stringify(messages)).toContain("连续 3 次");
	});

	it.each([undefined, 0])(
		"finishes 48 successful operations without an implicit cap (%s)",
		async (maxToolExecutions) => {
			const executed: string[] = [];
			const messages = await replay(
				Array.from({ length: 48 }, (_, index) => response([call(String(index))], "toolUse")),
				[
					tool(async (_id, args) => {
						executed.push(args.value);
						return { content: [{ type: "text", text: "ok" }], details: {} };
					}),
				],
				{ maxToolExecutions },
			);
			expect(executed).toHaveLength(48);
			expect(messages.filter((message) => message.role === "toolResult" && message.isError)).toEqual([]);
		},
	);

	it("retries the same failed operation after a successful repair", async () => {
		let repaired = false;
		let attempts = 0;
		const messages = await replay(
			[
				response([call("check-1", "operation", "check")], "toolUse"),
				response([call("repair", "operation", "repair")], "toolUse"),
				response([call("check-2", "operation", "check")], "toolUse"),
			],
			[
				tool(async (_id, args) => {
					if (args.value === "repair") repaired = true;
					else attempts++;
					return {
						content: [{ type: "text", text: repaired ? "ok" : "test failed" }],
						details: {},
						isError: !repaired,
					};
				}),
			],
		);
		expect(attempts).toBe(2);
		expect(messages.filter((message) => message.role === "toolResult").map((message) => message.isError)).toEqual([
			true,
			false,
			false,
		]);
	});

	it("allows an unexecuted truncated call to be reissued with complete arguments", async () => {
		let executed = 0;
		const messages = await replay(
			[
				response([call("cut", "operation", "same")], "length"),
				response([call("complete", "operation", "same")], "toolUse"),
			],
			[
				tool(async () => {
					executed++;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				}),
			],
		);
		expect(executed).toBe(1);
		expect(messages.filter((message) => message.role === "toolResult").map((message) => message.isError)).toEqual([
			true,
			false,
		]);
	});

	it("accepts a previously missing tool after it becomes available", async () => {
		let executed = 0;
		const loaded = tool(async () => {
			executed++;
			return { content: [{ type: "text", text: "ok" }], details: {} };
		});
		const messages = await replay(
			[
				response([call("missing", "operation", "same")], "toolUse"),
				response([call("loaded", "operation", "same")], "toolUse"),
			],
			[],
			{ prepareNextTurn: ({ context }) => ({ context: { ...context, tools: [loaded] } satisfies AgentContext }) },
		);
		expect(executed).toBe(1);
		expect(messages.filter((message) => message.role === "toolResult").map((message) => message.isError)).toEqual([
			true,
			false,
		]);
	});

	it("does not exceed an explicit budget with a parallel batch", async () => {
		let executed = 0;
		const messages = await replay(
			[response([call("first")], "toolUse"), response([call("second"), call("third")], "toolUse")],
			[
				tool(async () => {
					executed++;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				}),
			],
			{ maxToolExecutions: 2 },
		);
		expect(executed).toBe(1);
		expect(messages.filter((message) => message.role === "toolResult" && message.isError)).toHaveLength(2);
	});
});
