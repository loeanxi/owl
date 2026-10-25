import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

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

async function collectFinalAssistant(
	prompts: AgentMessage[],
	config: AgentLoopConfig,
	streamFn: Parameters<typeof agentLoop>[4],
	signal?: AbortSignal,
): Promise<{ final: AssistantMessage | undefined; events: AgentEvent[] }> {
	const context: AgentContext = { messages: [], tools: [] };
	const stream = agentLoop(prompts, context, config, signal, streamFn);
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	const messages = await stream.result();
	const final = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
	return { final, events };
}

describe("agent loop first-packet watchdog", () => {
	it("synthesizes a model error when the stream never emits any event", async () => {
		const hangingStream = new MockAssistantStream(); // 永不 push、也不响应 abort
		const { final, events } = await collectFinalAssistant(
			[createUserMessage("hello")],
			{ model: createModel(), convertToLlm: identityConverter, firstPacketTimeoutMs: 60 },
			() => hangingStream,
		);
		expect(final?.stopReason).toBe("error");
		expect(final?.errorMessage ?? "").toContain("没有返回任何流事件");
		const ended = events.find((e) => e.type === "message_end" && "message" in e && e.message.role === "assistant");
		const endedMessage =
			ended?.type === "message_end" && ended.message.role === "assistant" ? ended.message : undefined;
		expect(endedMessage?.stopReason).toBe("error");
	});

	it("synthesizes a model error when streamFunction itself never resolves", async () => {
		const { final } = await collectFinalAssistant(
			[createUserMessage("hello")],
			{ model: createModel(), convertToLlm: identityConverter, firstPacketTimeoutMs: 60 },
			() => new Promise<MockAssistantStream>(() => {}),
		);
		expect(final?.stopReason).toBe("error");
		expect(final?.errorMessage ?? "").toContain("没有返回任何流事件");
	});

	it("does not interfere with a stream that starts in time", async () => {
		const { final } = await collectFinalAssistant(
			[createUserMessage("hello")],
			{ model: createModel(), convertToLlm: identityConverter, firstPacketTimeoutMs: 60 },
			() => {
				const stream = new MockAssistantStream();
				setTimeout(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "hi there" }]),
					});
				}, 10);
				return stream;
			},
		);
		expect(final?.stopReason).toBe("stop");
		expect(final?.content[0]).toMatchObject({ type: "text", text: "hi there" });
	});

	it("keeps user abort reported as aborted, not rewritten to error", async () => {
		const { final } = await collectFinalAssistant(
			[createUserMessage("hello")],
			{ model: createModel(), convertToLlm: identityConverter, firstPacketTimeoutMs: 60_000 },
			(_model, _context, options) => {
				const stream = new MockAssistantStream();
				options?.signal?.addEventListener("abort", () => {
					stream.push({
						type: "error",
						reason: "aborted",
						error: createAssistantMessage([], "aborted"),
					});
				});
				return stream;
			},
			AbortSignal.timeout(80),
		);
		expect(final?.stopReason).toBe("aborted");
	});
});
