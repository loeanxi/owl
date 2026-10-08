import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type Account,
	AccountPoolRouter,
	ApiKeyService,
	BillingService,
	GatewayFault,
	MemoryGatewayState,
	RouteGeneration,
	StickySessionService,
	type UpstreamChatClient,
} from "owl-pool";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAI } from "../../../packages/ai/src/api/openai-completions.ts";
import { isRetryableAssistantError } from "../../../packages/ai/src/utils/retry.ts";
import { normalizeContext } from "../../../packages/ai/src/utils/transcript.ts";
import { loadConfig } from "../src/config.ts";
import { chatCompletionStream, type GatewayServiceDeps } from "../src/gateway/service.ts";
import { WorkBuddyChatClient } from "../src/gateway/workbuddy-client.ts";
import { registerGatewayRoutes } from "../src/http/gateway-api.ts";
import { Router } from "../src/http/router.ts";
import { SqliteAccountStore } from "../src/store/account-store.ts";
import { SqliteBillingStore } from "../src/store/billing-store.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteApiKeyStore, SqliteCallLogStore, SqliteCatalogStore } from "../src/store/gateway-stores.ts";

const account: Account = {
	id: "faux-workbuddy",
	name: "Faux",
	platform: "WORKBUDDY",
	credentials: { accessToken: "faux-only" },
	enabled: true,
	createdAt: 0,
	updatedAt: 0,
};
const defaults = {
	baseUrl: "http://faux.invalid",
	chatPath: "/chat",
	userAgent: "faux",
	origin: "http://faux.invalid",
	referer: "http://faux.invalid",
};
const payload = { model: "faux-model", messages: [{ role: "user", content: "faux" }] };
const partial =
	'data: {"choices":[{"index":0,"delta":{"reasoning_content":"faux thinking"},"finish_reason":null}]}\n\n';
const final =
	'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n';

function fakeTransport(frames: Array<{ at: number; text: string }>, closeAt?: number) {
	let signal: AbortSignal | null | undefined;
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	const timers: Array<ReturnType<typeof setTimeout>> = [];
	const stop = () => {
		if (closed) return;
		closed = true;
		for (const timer of timers) clearTimeout(timer);
		controller?.error(signal?.reason ?? new Error("faux cleanup"));
		signal?.removeEventListener("abort", stop);
	};
	const fetchImpl: typeof fetch = async (_url, init) => {
		signal = init?.signal;
		const body = new ReadableStream<Uint8Array>({
			start(next) {
				controller = next;
				for (const frame of frames)
					timers.push(
						setTimeout(() => {
							if (!closed) next.enqueue(new TextEncoder().encode(frame.text));
						}, frame.at),
					);
				if (closeAt !== undefined)
					timers.push(
						setTimeout(() => {
							if (!closed) {
								closed = true;
								signal?.removeEventListener("abort", stop);
								next.close();
							}
						}, closeAt),
					);
			},
			cancel() {
				stop();
			},
		});
		signal?.addEventListener("abort", stop, { once: true });
		if (signal?.aborted) stop();
		return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
	};
	return { fetchImpl, cleanup: stop, signal: () => signal };
}

describe("WorkBuddy bounded stream deadlines", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Drive the real old deadline seam without waiting two minutes for Node's internal timer.
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(
				() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
				ms,
			);
			return controller.signal;
		});
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("keeps a default stream active beyond 120 seconds, including heartbeat-only activity", async () => {
		const transport = fakeTransport(
			[
				{ at: 1, text: partial },
				{ at: 90000, text: ": heartbeat\n\n" },
				{ at: 150000, text: final },
			],
			150001,
		);
		const client = new WorkBuddyChatClient({ config: defaults, fetchImpl: transport.fetchImpl });
		const chunks: string[] = [];
		const running = client
			.chatCompletionStream(account, payload, (chunk) => chunks.push(chunk))
			.then(
				() => "completed",
				() => "failed",
			);
		try {
			await vi.advanceTimersByTimeAsync(150002);
			expect(await running).toBe("completed");
			expect(chunks.some((chunk) => chunk.includes('"finish_reason":"stop"'))).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			transport.cleanup();
			await running;
		}
	});

	it("honors an explicitly short absolute hard cap despite continuing output", async () => {
		const transport = fakeTransport(
			[
				{ at: 1, text: partial },
				{ at: 15, text: ": heartbeat\n\n" },
				{ at: 30, text: final },
			],
			31,
		);
		const client = new WorkBuddyChatClient({
			config: { ...defaults, timeoutMs: 20 },
			fetchImpl: transport.fetchImpl,
		});
		const running = client
			.chatCompletionStream(account, payload, () => {})
			.then(
				() => null,
				(error) => error,
			);
		try {
			await vi.advanceTimersByTimeAsync(32);
			expect(await running).toBeInstanceOf(Error);
			expect(transport.signal()?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			transport.cleanup();
			await running;
		}
	});

	it("aborts an idle body and cleans the total timer", async () => {
		const transport = fakeTransport([{ at: 1, text: partial }]);
		const config = { ...defaults, streamIdleTimeoutMs: 20, streamMaxDurationMs: 100 };
		const client = new WorkBuddyChatClient({ config, fetchImpl: transport.fetchImpl });
		let outcome: unknown = "pending";
		const running = client
			.chatCompletionStream(account, payload, () => {})
			.then(
				() => {
					outcome = "completed";
				},
				(error) => {
					outcome = error;
				},
			);
		try {
			await vi.advanceTimersByTimeAsync(25);
			expect(outcome).toBeInstanceOf(Error);
			expect(transport.signal()?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			transport.cleanup();
			await running;
		}
	});

	it("enforces the default 600-second total bound even with steady activity", async () => {
		const frames = Array.from({ length: 7 }, (_, index) => ({
			at: index * 90000 + 1,
			text: index ? ": heartbeat\n\n" : partial,
		}));
		const transport = fakeTransport(frames);
		const client = new WorkBuddyChatClient({ config: defaults, fetchImpl: transport.fetchImpl });
		let outcome: unknown = "pending";
		const running = client
			.chatCompletionStream(account, payload, () => {})
			.then(
				() => {
					outcome = "completed";
				},
				(error) => {
					outcome = error;
				},
			);
		try {
			await vi.advanceTimersByTimeAsync(599999);
			expect(outcome).toBe("pending");
			await vi.advanceTimersByTimeAsync(2);
			expect(outcome).toBeInstanceOf(Error);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			transport.cleanup();
			await running;
		}
	});

	it("caller cancellation aborts the actual transport and removes listeners/timers", async () => {
		const transport = fakeTransport([{ at: 1, text: partial }]);
		const client: UpstreamChatClient = new WorkBuddyChatClient({ config: defaults, fetchImpl: transport.fetchImpl });
		const abort = new AbortController();
		const running = client
			.chatCompletionStream(account, payload, () => {}, abort.signal)
			.then(
				() => null,
				(error) => error,
			);
		try {
			await vi.advanceTimersByTimeAsync(2);
			abort.abort(new Error("faux caller cancelled"));
			await vi.advanceTimersByTimeAsync(1);
			expect(transport.signal()?.aborted).toBe(true);
			expect(await running).toMatchObject({ message: "faux caller cancelled" });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			transport.cleanup();
			await running;
		}
	});
	it("config distinguishes default WorkBuddy policy from explicit generic hard cap", () => {
		const defaultConfig = loadConfig({});
		const explicit = loadConfig({ OWL_POOL_GATEWAY_UPSTREAM_TIMEOUT_MS: "120000" });
		expect(defaultConfig.gateway.workbuddy).toMatchObject({
			streamIdleTimeoutMs: 120000,
			streamMaxDurationMs: 600000,
		});
		expect(defaultConfig.gateway.workbuddy).not.toHaveProperty("timeoutMs", 120000);
		expect(explicit.gateway.workbuddy).toMatchObject({ timeoutMs: 120000 });
	});
	it("bounds a fetch that ignores AbortSignal before delivering headers", async () => {
		let deliver: (response: Response) => void = () => {};
		const pending = new Promise<Response>((resolve) => {
			deliver = resolve;
		});
		const config = { ...defaults, streamIdleTimeoutMs: 20, streamMaxDurationMs: 100 };
		const client = new WorkBuddyChatClient({ config, fetchImpl: async () => pending });
		let outcome: unknown = "pending";
		const running = client
			.chatCompletionStream(account, payload, () => {})
			.then(
				() => {
					outcome = "completed";
				},
				(error) => {
					outcome = error;
				},
			);
		try {
			await vi.advanceTimersByTimeAsync(21);
			expect(outcome).toMatchObject({ code: "upstream_stream_idle_timeout" });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			deliver(new Response(""));
			await running;
		}
	});
	it("interrupts a non-cooperative pending body read and releases its lock even if cancel never settles", async () => {
		let finishCancel: () => void = () => {};
		const cancelling = new Promise<void>((resolve) => {
			finishCancel = resolve;
		});
		const cancel = vi.fn(() => cancelling);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(partial));
			},
			cancel,
		});
		const config = { ...defaults, streamIdleTimeoutMs: 20, streamMaxDurationMs: 100 };
		const client = new WorkBuddyChatClient({ config, fetchImpl: async () => new Response(body) });
		let outcome: unknown = "pending";
		const running = client
			.chatCompletionStream(account, payload, () => {})
			.then(
				() => {
					outcome = "completed";
				},
				(error) => {
					outcome = error;
				},
			);
		try {
			await vi.advanceTimersByTimeAsync(21);
			expect(outcome).toMatchObject({ code: "upstream_stream_idle_timeout" });
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			finishCancel();
			await running;
		}
	});
	it("rejects a pre-aborted caller without starting a transport", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response(final));
		const client: UpstreamChatClient = new WorkBuddyChatClient({ config: defaults, fetchImpl });
		const abort = new AbortController();
		abort.abort(new Error("faux before dispatch"));
		await expect(client.chatCompletionStream(account, payload, () => {}, abort.signal)).rejects.toThrow(
			/before dispatch/,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cleans a non-cooperative HTTP error body when its deadline expires", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("faux rate limited"));
			},
			cancel,
		});
		const client = new WorkBuddyChatClient({
			config: { ...defaults, timeoutMs: 40 },
			fetchImpl: async () => new Response(body, { status: 429 }),
		});
		let outcome: unknown = "pending";
		const running = client
			.chatCompletionStream(account, payload, () => {})
			.then(
				() => {
					outcome = "completed";
				},
				(error) => {
					outcome = error;
				},
			);
		await vi.advanceTimersByTimeAsync(41);
		await running;
		expect(outcome).toMatchObject({ code: "upstream_timeout" });
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("removes caller forwarding after successful EOF", async () => {
		const transport = fakeTransport([{ at: 1, text: final }], 2);
		const client: UpstreamChatClient = new WorkBuddyChatClient({ config: defaults, fetchImpl: transport.fetchImpl });
		const abort = new AbortController();
		const running = client.chatCompletionStream(account, payload, () => {}, abort.signal);
		await vi.advanceTimersByTimeAsync(3);
		await running;
		abort.abort(new Error("faux later cancellation"));
		expect(transport.signal()?.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});

function gatewayFixture(upstream: UpstreamChatClient) {
	const db = openDb(":memory:");
	const accounts = new SqliteAccountStore(db),
		store = new SqliteBillingStore(db),
		catalog = new SqliteCatalogStore(db);
	accounts.create(account, 0);
	store.adjust("faux-sdk-member", 100);
	store.saveRate({
		model: "faux-model",
		promptPer1m: 100,
		completionPer1m: 100,
		cacheReadPer1m: 100,
		cacheWritePer1m: 100,
		enabled: true,
	});
	const state = new MemoryGatewayState(),
		router = new AccountPoolRouter({ accounts, accountCooldownMs: 1000, cooldownState: state }),
		sticky = new StickySessionService({ enabled: false, ttlSeconds: 60 });
	const upstreams = new Map([[upstream.platform(), upstream]]),
		keys = new ApiKeyService({ store: new SqliteApiKeyStore(db) }),
		billing = new BillingService({ store });
	const key = keys.create({ name: "faux-sdk", ownerMemberId: "faux-sdk-member" });
	catalog.saveModel({
		id: "faux-model",
		publicId: "faux-model",
		name: "Faux",
		description: null,
		modelVersion: null,
		contextWindow: 200000,
		defaultContextWindow: null,
		defaultReasoningEffort: null,
		maxOutputTokens: 32000,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: [],
		published: true,
		sortOrder: 0,
		updatedAt: 0,
	});
	catalog.saveRoute({
		id: "faux-route",
		modelId: "faux-model",
		platform: "WORKBUDDY",
		upstreamModel: "faux-model",
		priority: 0,
		enabled: true,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: [],
	});
	catalog.saveCapacity({
		platform: "WORKBUDDY",
		upstreamModel: "faux-model",
		available: true,
		contextWindow: 200000,
		maxOutputTokens: 32000,
	});
	const deps: GatewayServiceDeps = {
		config: {
			enabled: true,
			globalRateLimitPerMinute: 100,
			ipRateLimitPerMinute: 100,
			ipWhitelist: null,
			maxRotate: 1,
			accountCooldownMs: 1000,
			upstreamTimeoutMs: 1000,
			stickyEnabled: false,
			stickyTtlSeconds: 60,
		},
		state,
		keys,
		accounts,
		router,
		sticky,
		upstreams,
		generation: new RouteGeneration({ accounts, router, sticky, upstreams, maxRotate: 1 }),
		callLogs: new SqliteCallLogStore(db),
		billing,
		billingStore: store,
		catalog,
		listPublishedModels: () => catalog.listModels(),
		trustedProxyCount: 0,
	};
	return {
		db,
		deps,
		key,
		billing,
		accounts,
		auth: { key: keys.authenticate(key.plaintext)!, requestId: "faux-request", clientIp: "127.0.0.1" },
	};
}

it.each([
	{ code: "upstream_stream_idle_timeout", message: "WorkBuddy 流连续 120000ms 未收到数据，已中止等待" },
	{ code: "upstream_timeout", message: "WorkBuddy 流总时长上限 600000ms 已到，已中止等待" },
	{ code: "upstream_stream_interrupted", message: "WorkBuddy 流中断，费用待核对: WorkBuddy SSE 解析失败: terminated" },
	{ code: "upstream_timeout", message: "WorkBuddy 显式绝对期限 150000ms 已到，已中止等待" },
])("the actual local SDK preserves controlled cause and does not replay UNKNOWN: $code $message", async (failure) => {
	let calls = 0;
	const { db, deps, key, billing } = gatewayFixture({
		platform: () => "WORKBUDDY",
		chatCompletion: async () => ({}),
		chatCompletionStream: async (_account, _payload, chunk) => {
			calls++;
			chunk(
				JSON.stringify({
					choices: [{ index: 0, delta: { reasoning_content: "faux partial" }, finish_reason: null }],
				}),
			);
			throw new GatewayFault(504, failure.code, failure.message);
		},
	});
	const routes = new Router();
	registerGatewayRoutes(routes, { gateway: deps, gatewayConfig: deps.config });
	const server = createServer((request, response) => {
		void routes
			.handle(request, response, new URL(request.url ?? "/", "http://127.0.0.1"), async <T>() => {
				let text = "";
				for await (const chunk of request) text += String(chunk);
				return JSON.parse(text) as T;
			})
			.catch(() => response.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const result = await streamOpenAI(
			{
				api: "openai-completions",
				id: "faux-model",
				name: "Faux",
				provider: "faux-local",
				baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
			},
			normalizeContext({ messages: [{ role: "user", content: "faux", timestamp: Date.now() }] }),
			{ apiKey: key.plaintext, maxTokens: 1, maxRetries: 0 },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(failure.message);
		expect(result.errorMessage).not.toContain("Stream ended without finish_reason");
		expect(isRetryableAssistantError(result), result.errorMessage).toBe(false);
		expect(result.rawStopReason).toBeUndefined();
		expect(calls).toBe(1);
		expect(db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
		expect(billing.balance("faux-sdk-member")).toBe(98);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		db.close();
	}
});

it("an accepted but incomplete WorkBuddy stream is not dispatched to another account", async () => {
	let calls = 0;
	const client = new WorkBuddyChatClient({
		config: defaults,
		fetchImpl: async () => {
			calls++;
			return new Response("");
		},
	});
	const f = gatewayFixture(client);
	f.accounts.create({ ...account, name: "second-faux" }, 0);
	f.deps.generation = new RouteGeneration({
		accounts: f.accounts,
		router: f.deps.router,
		sticky: f.deps.sticky,
		upstreams: f.deps.upstreams,
		maxRotate: 2,
	});
	try {
		await expect(
			chatCompletionStream(f.deps, f.auth, { ...payload, max_tokens: 1, stream: true }, () => {}),
		).rejects.toMatchObject({ code: "upstream_stream_interrupted" });
		expect(calls).toBe(1);
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
		expect(f.billing.balance("faux-sdk-member")).toBe(98);
	} finally {
		f.db.close();
	}
});

it("a proven connection refusal may still rotate before the upstream accepts a request", async () => {
	let calls = 0;
	const client = new WorkBuddyChatClient({
		config: defaults,
		fetchImpl: async () => {
			calls++;
			if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
			return new Response(final);
		},
	});
	const f = gatewayFixture(client);
	f.accounts.create({ ...account, name: "second-faux" }, 0);
	f.deps.generation = new RouteGeneration({
		accounts: f.accounts,
		router: f.deps.router,
		sticky: f.deps.sticky,
		upstreams: f.deps.upstreams,
		maxRotate: 2,
	});
	try {
		await chatCompletionStream(f.deps, f.auth, { ...payload, max_tokens: 1, stream: true }, () => {});
		expect(calls).toBe(2);
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("POSTED");
		expect(f.billing.balance("faux-sdk-member")).toBe(98);
	} finally {
		f.db.close();
	}
});
