import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import {
	AccountPoolRouter,
	AnthropicUpstreamMapper,
	ApiKeyService,
	BillingService,
	MemoryGatewayState,
	RouteGeneration,
	StickySessionService,
	type UpstreamChatClient,
} from "owl-pool";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamOpenAI } from "../../../packages/ai/src/api/openai-completions.ts";
import { normalizeContext } from "../../../packages/ai/src/utils/transcript.ts";
import { chatCompletionStream, type GatewayServiceDeps } from "../src/gateway/service.ts";
import { registerGatewayRoutes } from "../src/http/gateway-api.ts";
import { Router } from "../src/http/router.ts";
import { SqliteAccountStore } from "../src/store/account-store.ts";
import { SqliteBillingStore } from "../src/store/billing-store.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteApiKeyStore, SqliteCallLogStore, SqliteCatalogStore } from "../src/store/gateway-stores.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const db = openDb(":memory:");
	databases.push(db);
	const store = new SqliteBillingStore(db);
	store.adjust("faux-member", 10000);
	store.saveRate({
		model: "faux-model",
		promptPer1m: 200,
		completionPer1m: 800,
		cacheReadPer1m: 4,
		cacheWritePer1m: 200,
		enabled: true,
	});
	const billing = new BillingService({ store });
	const reserve = () =>
		billing.reserve("faux-member", "faux-key", "faux-model", {
			messages: [{ role: "user", content: "faux" }],
			max_tokens: 32768,
		});
	return { db, store, billing, reserve };
}

// Immutable numeric captures from six same-key read-only calls; no live database or credentials.
const snapshots = [
	{ promptTokens: 12504, cacheReadTokens: 3712, completionTokens: 32770, expectedCents: 29 },
	{ promptTokens: 12386, cacheReadTokens: 12160, completionTokens: 16384, expectedCents: 15 },
	{ promptTokens: 12217, cacheReadTokens: 11392, completionTokens: 83, expectedCents: 2 },
	{ promptTokens: 11477, cacheReadTokens: 3712, completionTokens: 269, expectedCents: 3 },
	{ promptTokens: 24797, cacheReadTokens: 24576, completionTokens: 329, expectedCents: 2 },
	{ promptTokens: 24625, cacheReadTokens: 24064, completionTokens: 274, expectedCents: 2 },
];

describe("verified cache components settle at their configured price", () => {
	it.each(snapshots)(
		"settles recorded prompt $promptTokens/read $cacheReadTokens/output $completionTokens",
		(sample) => {
			const f = fixture(),
				{ entryId } = f.reserve();
			const usage = { ...sample, cacheWriteTokens: 0 };
			f.billing.settle(entryId, usage, "faux-model");
			const row = f.db
				.prepare(
					"SELECT amount,status,prompt_tokens,cache_read_tokens,cache_write_tokens FROM billing_ledger_entries WHERE id=?",
				)
				.get(entryId);
			expect(row?.status).toBe("POSTED");
			expect(row?.amount).toBe(-sample.expectedCents);
			expect(row?.prompt_tokens).toBe(sample.promptTokens);
			expect(row?.cache_read_tokens).toBe(sample.cacheReadTokens);
			expect(row?.cache_write_tokens).toBe(0);
			expect(f.billing.balance("faux-member")).toBe(10000 - sample.expectedCents);
		},
	);
	it("preserves conservative reservation but uses ordinary input when no cache metrics exist", () => {
		const f = fixture();
		f.store.saveRate({
			model: "faux-model",
			promptPer1m: 200,
			completionPer1m: 800,
			cacheReadPer1m: 4,
			cacheWritePer1m: 1000,
			enabled: true,
		});
		const { entryId, reserved } = f.billing.reserve("faux-member", "faux-key", "faux-model", {
			messages: [{ role: "user", content: "x".repeat(400000) }],
			max_tokens: 1,
		});
		expect(reserved).toBeGreaterThanOrEqual(100);
		f.billing.settle(entryId, { promptTokens: 10000, completionTokens: 0 }, "faux-model");
		expect(f.store.getLedger(entryId)?.amount).toBe(-2);
		expect(f.billing.balance("faux-member")).toBe(9998);
	});
	it("prices verified cache writes independently and rounds aggregate input once", () => {
		const f = fixture();
		f.store.saveRate({
			model: "faux-model",
			promptPer1m: 200,
			completionPer1m: 800,
			cacheReadPer1m: 4,
			cacheWritePer1m: 1000,
			enabled: true,
		});
		const { entryId } = f.reserve();
		const usage = { promptTokens: 300000, completionTokens: 2000, cacheReadTokens: 100000, cacheWriteTokens: 100000 };
		f.billing.settle(entryId, usage, "faux-model");
		expect(f.store.getLedger(entryId)?.amount).toBe(-123);
		expect(f.billing.balance("faux-member")).toBe(9877);
	});
	it("accepts zero cache components without pretending they were absent", () => {
		const f = fixture(),
			{ entryId } = f.reserve();
		const usage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
		f.billing.settle(entryId, usage, "faux-model");
		expect(
			f.db
				.prepare("SELECT status,amount,cache_read_tokens,cache_write_tokens FROM billing_ledger_entries WHERE id=?")
				.get(entryId),
		).toMatchObject({ status: "POSTED", amount: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
		expect(f.billing.balance("faux-member")).toBe(10000);
	});
	it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "12", null])(
		"retains REVIEW for explicitly invalid cache quantity %s",
		(invalid) => {
			const f = fixture(),
				{ entryId } = f.reserve(),
				before = f.billing.balance("faux-member");
			const usage = {
				promptTokens: 100,
				completionTokens: 10,
				cacheReadTokens: invalid,
				cacheWriteTokens: 0,
			} as unknown as Parameters<BillingService["settle"]>[1];
			f.billing.settle(entryId, usage, "faux-model");
			expect(f.store.getLedger(entryId)?.status).toBe("REVIEW");
			expect(f.billing.balance("faux-member")).toBe(before);
		},
	);
	it.each([
		{ promptTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 50 },
		{ promptTokens: 100, cacheReadTokens: 101, cacheWriteTokens: 0 },
		{ promptTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 },
		{ promptTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: Number.MAX_SAFE_INTEGER, cacheWriteTokens: 1 },
	])("does not guess or discount overlapping input components %j", (input) => {
		const f = fixture(),
			{ entryId } = f.reserve(),
			before = f.billing.balance("faux-member");
		const usage = { ...input, completionTokens: 0 };
		f.billing.settle(entryId, usage, "faux-model");
		expect(f.store.getLedger(entryId)?.status).toBe("REVIEW");
		expect(f.billing.balance("faux-member")).toBe(before);
	});
	it("cache settlement is idempotent and refunds roll back with ledger failure", () => {
		const f = fixture(),
			{ entryId } = f.reserve(),
			before = f.billing.balance("faux-member");
		const usage = { promptTokens: 12217, completionTokens: 83, cacheReadTokens: 11392, cacheWriteTokens: 0 };
		f.db.exec(
			"CREATE TRIGGER reject_faux_cache BEFORE UPDATE ON billing_ledger_entries BEGIN SELECT RAISE(ABORT,'faux cache update failure'); END",
		);
		expect(() => f.billing.settle(entryId, usage, "faux-model")).toThrow();
		expect(f.billing.balance("faux-member")).toBe(before);
		expect(f.store.getLedger(entryId)?.status).toBe("PENDING");
		f.db.exec("DROP TRIGGER reject_faux_cache");
		f.billing.settle(entryId, usage, "faux-model");
		f.billing.settle(entryId, usage, "faux-model");
		expect(f.billing.balance("faux-member")).toBe(9998);
	});
});

function gatewayFixture(usage: Record<string, unknown>) {
	const f = fixture();
	const accounts = new SqliteAccountStore(f.db);
	accounts.create({ name: "faux", platform: "GROK", credentials: { apiKey: "faux-only" }, enabled: true }, 0);
	const client: UpstreamChatClient = {
		platform: () => "GROK",
		chatCompletion: async () => ({}),
		chatCompletionStream: async (_account, _payload, chunk) => chunk(JSON.stringify({ choices: [], usage })),
	};
	const upstreams = new Map([[client.platform(), client]]),
		state = new MemoryGatewayState(),
		router = new AccountPoolRouter({ accounts, accountCooldownMs: 1000, cooldownState: state }),
		sticky = new StickySessionService({ enabled: false, ttlSeconds: 60 });
	const keys = new ApiKeyService({ store: new SqliteApiKeyStore(f.db) }),
		key = keys.authenticate(keys.create({ name: "faux", ownerMemberId: "faux-member" }).plaintext)!;
	const catalog = new SqliteCatalogStore(f.db);
	catalog.saveModel({
		id: "faux-model",
		publicId: "faux-model",
		name: "Faux",
		description: null,
		modelVersion: null,
		contextWindow: 1000000,
		defaultContextWindow: null,
		defaultReasoningEffort: null,
		maxOutputTokens: 32768,
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
		platform: "GROK",
		upstreamModel: "faux-model",
		priority: 0,
		enabled: true,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: [],
	});
	catalog.saveCapacity({
		platform: "GROK",
		upstreamModel: "faux-model",
		available: true,
		contextWindow: 1000000,
		maxOutputTokens: 32768,
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
		callLogs: new SqliteCallLogStore(f.db),
		billing: f.billing,
		billingStore: f.store,
		catalog,
		listPublishedModels: () => catalog.listModels(),
		trustedProxyCount: 0,
	};
	return { ...f, deps, auth: { key, requestId: "faux-cache-request", clientIp: "127.0.0.1" } };
}

describe("gateway passes only trustworthy upstream cache metrics", () => {
	it.each([
		{ label: "nullable canonical field", cached: null, alias: 11648 },
		{ label: "nullable fallback alias", cached: 11648, alias: null },
	])("the actual local SDK and ledger agree on a verified count beside $label", async (sample) => {
		const f = gatewayFixture({
			prompt_tokens: 12387,
			completion_tokens: 718,
			total_tokens: 13105,
			prompt_tokens_details: { cached_tokens: sample.cached },
			prompt_cache_hit_tokens: sample.alias,
			cache_creation_input_tokens: 0,
		});
		f.deps.upstreams.get("GROK")!.chatCompletionStream = async (_account, _payload, chunk) => {
			chunk(JSON.stringify({ choices: [{ index: 0, delta: { content: "faux" }, finish_reason: "stop" }] }));
			chunk(
				JSON.stringify({
					choices: [],
					usage: {
						prompt_tokens: 12387,
						completion_tokens: 718,
						total_tokens: 13105,
						prompt_tokens_details: { cached_tokens: sample.cached },
						prompt_cache_hit_tokens: sample.alias,
						cache_creation_input_tokens: 0,
					},
				}),
			);
		};
		const apiKey = f.deps.keys.create({ name: "faux-local-sdk", ownerMemberId: "faux-member" });
		const router = new Router();
		registerGatewayRoutes(router, { gateway: f.deps, gatewayConfig: f.deps.config });
		const server = createServer((request, response) => {
			void router
				.handle(request, response, new URL(request.url ?? "/", "http://127.0.0.1"), async <T>() => {
					let body = "";
					for await (const chunk of request) body += String(chunk);
					return JSON.parse(body) as T;
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
					maxTokens: 32768,
				},
				normalizeContext({ messages: [{ role: "user", content: "faux", timestamp: Date.now() }] }),
				{
					apiKey: apiKey.plaintext,
					maxTokens: 1,
					maxRetries: 0,
				},
			).result();
			expect(result.stopReason).toBe("stop");
			expect(typeof result.usage.cacheRead).toBe("number");
			expect(Number.isSafeInteger(result.usage.cacheRead)).toBe(true);
			expect(result.usage).toMatchObject({ input: 739, output: 718, cacheRead: 11648, totalTokens: 13105 });
			expect(f.db.prepare("SELECT status,amount,cache_read_tokens FROM billing_ledger_entries").get()).toMatchObject(
				{ status: "POSTED", amount: -2, cache_read_tokens: 11648 },
			);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	it("missing native basic usage reaches the ledger as REVIEW", async () => {
		const f = gatewayFixture({});
		const mapper = new AnthropicUpstreamMapper({ label: "faux", foldCacheTokens: true });
		const normalized = mapper.toOpenAiCompletion({
			model: "faux-model",
			content: [],
			stop_reason: "end_turn",
			usage: null,
		});
		f.deps.upstreams.get("GROK")!.chatCompletionStream = async (_account, _payload, chunk) =>
			chunk(JSON.stringify(normalized));
		await chatCompletionStream(f.deps, f.auth, { model: "faux-model", messages: [], max_tokens: 1 }, () => {});
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
	});
	it("an absent cached child in optional details:null is ordinary input, not malformed cache usage", async () => {
		const f = gatewayFixture({
			prompt_tokens: 10000,
			completion_tokens: 0,
			total_tokens: 10000,
			prompt_tokens_details: null,
		});
		await chatCompletionStream(f.deps, f.auth, { model: "faux-model", messages: [], max_tokens: 1 }, () => {});
		expect(
			f.db.prepare("SELECT status,amount,cache_read_tokens,cache_write_tokens FROM billing_ledger_entries").get(),
		).toMatchObject({ status: "POSTED", amount: -2, cache_read_tokens: null, cache_write_tokens: null });
	});
	it("contradictory cache aliases cannot produce an unverified discount", async () => {
		const f = gatewayFixture({
			prompt_tokens: 100,
			completion_tokens: 0,
			total_tokens: 100,
			prompt_tokens_details: { cached_tokens: 50 },
			prompt_cache_hit_tokens: 60,
		});
		await chatCompletionStream(f.deps, f.auth, { model: "faux-model", messages: [], max_tokens: 1 }, () => {});
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
	});
	it("invalid cache usage is retained even if a later chunk contains valid numbers", async () => {
		const f = gatewayFixture({});
		const client = f.deps.upstreams.get("GROK")!;
		client.chatCompletionStream = async (_account, _payload, chunk) => {
			for (const cached of [50, null, 50])
				chunk(
					JSON.stringify({
						choices: [],
						usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: cached } },
					}),
				);
		};
		await chatCompletionStream(f.deps, f.auth, { model: "faux-model", messages: [], max_tokens: 1 }, () => {});
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
	});
	it("uses response cache metrics, ignoring request-side usage hints", async () => {
		const f = gatewayFixture({
			prompt_tokens: 12217,
			completion_tokens: 83,
			total_tokens: 12300,
			prompt_tokens_details: { cached_tokens: 11392 },
			cache_creation_input_tokens: 0,
		});
		await chatCompletionStream(
			f.deps,
			f.auth,
			{
				model: "faux-model",
				messages: [{ role: "user", content: "faux" }],
				max_tokens: 32768,
				metadata: { cacheReadTokens: 12217 },
				usage: { prompt_tokens_details: { cached_tokens: 12217 } },
			},
			() => {},
		);
		expect(
			f.db.prepare("SELECT amount,status,cache_read_tokens,cache_write_tokens FROM billing_ledger_entries").get(),
		).toMatchObject({ amount: -2, status: "POSTED", cache_read_tokens: 11392, cache_write_tokens: 0 });
	});
	it.each([-1, 0.5, "10", null, Number.MAX_SAFE_INTEGER + 1])(
		"does not turn explicit invalid raw cached_tokens %s into missing metadata",
		async (cached) => {
			const f = gatewayFixture({
				prompt_tokens: 100,
				completion_tokens: 1,
				total_tokens: 101,
				prompt_tokens_details: { cached_tokens: cached },
				cache_creation_input_tokens: 0,
			});
			await chatCompletionStream(f.deps, f.auth, { model: "faux-model", messages: [], max_tokens: 1 }, () => {});
			expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
		},
	);
});
