import { type Account, GatewayFault } from "owl-pool";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { GrokUpstreamClient } from "../src/gateway/grok-client.ts";
import { TraeChatClient } from "../src/gateway/trae-client.ts";

const traeAccount: Account = {
	id: "faux-trae",
	name: "Faux",
	platform: "TRAE",
	credentials: {},
	enabled: true,
	createdAt: 0,
	updatedAt: 0,
};
const grokAccount: Account = { ...traeAccount, id: "faux-grok", platform: "GROK", credentials: { apiKey: "faux" } };
const traeConfig = {
	chatBaseUrl: "http://faux.invalid",
	chatPath: "/chat",
	appId: "faux",
	ideVersion: "0",
	ideVersionCode: "0",
};
const payload = { model: "faux-model", messages: [{ role: "user", content: "faux" }] };
const soloThinking = 'event: output\ndata: {"reasoning_content":"faux thinking"}\n\n';
const soloAnswer = 'event: output\ndata: {"response":"faux answer"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n';
const openAiThinking =
	'data: {"choices":[{"index":0,"delta":{"reasoning_content":"faux thinking"},"finish_reason":null}]}\n\n';
const openAiAnswer = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

function fakeTransport(frames: Array<{ at: number; text: string }>, closeAt?: number) {
	let signal: AbortSignal | null | undefined;
	let closed = false;
	const timers: Array<ReturnType<typeof setTimeout>> = [];
	const fetchImpl: typeof fetch = async (_url, init) => {
		signal = init?.signal;
		const body = new ReadableStream<Uint8Array>({
			start(next) {
				for (const frame of frames)
					timers.push(
						setTimeout(() => {
							if (!closed) next.enqueue(new TextEncoder().encode(frame.text));
						}, frame.at),
					);
				if (closeAt !== undefined)
					timers.push(
						setTimeout(() => {
							if (closed) return;
							closed = true;
							next.close();
						}, closeAt),
					);
			},
			cancel() {
				closed = true;
				for (const timer of timers) clearTimeout(timer);
			},
		});
		return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
	};
	const cleanup = () => {
		closed = true;
		for (const timer of timers) clearTimeout(timer);
	};
	return { fetchImpl, cleanup, signal: () => signal };
}

function settle(promise: Promise<void>): Promise<unknown> {
	return promise.then(
		() => "completed",
		(error: unknown) => error,
	);
}

describe("direct upstream stream deadlines", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("lets a Trae stream that keeps producing output run past the old 120-second cap", async () => {
		const frames = Array.from({ length: 6 }, (_, index) => ({ at: index * 60_000 + 1, text: soloThinking }));
		const transport = fakeTransport([...frames, { at: 360_002, text: soloAnswer }], 360_003);
		const client = new TraeChatClient({
			config: traeConfig,
			fetchImpl: transport.fetchImpl,
			resolveJwt: async () => "faux-jwt",
		});
		const chunks: string[] = [];
		const running = settle(client.chatCompletionStream(traeAccount, payload, (chunk) => chunks.push(chunk)));
		try {
			await vi.advanceTimersByTimeAsync(360_010);
			expect(await running).toBe("completed");
			expect(chunks.some((chunk) => chunk.includes("faux answer"))).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			transport.cleanup();
			await running;
		}
	});

	it("stops a Trae stream that goes silent with an idle-timeout fault", async () => {
		const transport = fakeTransport([{ at: 1, text: soloThinking }]);
		const client = new TraeChatClient({
			config: { ...traeConfig, streamIdleTimeoutMs: 20, streamMaxDurationMs: 1000 },
			fetchImpl: transport.fetchImpl,
			resolveJwt: async () => "faux-jwt",
		});
		const running = settle(client.chatCompletionStream(traeAccount, payload, () => {}));
		try {
			await vi.advanceTimersByTimeAsync(30);
			const outcome = await running;
			expect(outcome).toBeInstanceOf(GatewayFault);
			expect(outcome).toMatchObject({ code: "upstream_stream_idle_timeout" });
			expect(transport.signal()?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			transport.cleanup();
			await running;
		}
	});

	it("keeps an explicit Trae timeout as an absolute cap", async () => {
		const frames = Array.from({ length: 5 }, (_, index) => ({ at: index * 10 + 1, text: soloThinking }));
		const transport = fakeTransport(frames);
		const client = new TraeChatClient({
			config: { ...traeConfig, timeoutMs: 25 },
			fetchImpl: transport.fetchImpl,
			resolveJwt: async () => "faux-jwt",
		});
		const running = settle(client.chatCompletionStream(traeAccount, payload, () => {}));
		try {
			await vi.advanceTimersByTimeAsync(30);
			expect(await running).toMatchObject({ code: "upstream_timeout" });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			transport.cleanup();
			await running;
		}
	});

	it("lets a Grok stream run past 120 seconds and passes caller cancellation through", async () => {
		const frames = Array.from({ length: 4 }, (_, index) => ({ at: index * 60_000 + 1, text: openAiThinking }));
		const longRun = fakeTransport([...frames, { at: 240_002, text: openAiAnswer }], 240_003);
		const client = new GrokUpstreamClient({ fetchImpl: longRun.fetchImpl });
		const running = settle(client.chatCompletionStream(grokAccount, payload, () => {}));
		await vi.advanceTimersByTimeAsync(240_010);
		expect(await running).toBe("completed");
		expect(vi.getTimerCount()).toBe(0);

		const stalled = fakeTransport([{ at: 1, text: openAiThinking }]);
		const cancelled = new GrokUpstreamClient({ fetchImpl: stalled.fetchImpl });
		const abort = new AbortController();
		const pending = settle(cancelled.chatCompletionStream(grokAccount, payload, () => {}, abort.signal));
		await vi.advanceTimersByTimeAsync(5);
		abort.abort(new Error("faux caller cancelled"));
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toMatchObject({ message: "faux caller cancelled" });
		expect(stalled.signal()?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		stalled.cleanup();
	});

	it("config applies idle and total bounds unless the generic hard cap is set explicitly", () => {
		expect(loadConfig({}).gateway.upstreamDeadline).toEqual({
			timeoutMs: undefined,
			streamIdleTimeoutMs: 120_000,
			streamMaxDurationMs: 1_800_000,
		});
		expect(loadConfig({ OWL_POOL_GATEWAY_UPSTREAM_TIMEOUT_MS: "90000" }).gateway.upstreamDeadline).toMatchObject({
			timeoutMs: 90_000,
		});
	});
});
