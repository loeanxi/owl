import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import {
	AccountPoolRouter,
	ApiKeyService,
	BillingService,
	MemoryGatewayState,
	RouteGeneration,
	StickySessionService,
	type UpstreamChatClient,
	UpstreamException,
} from "owl-pool";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayLifecycle } from "../src/gateway/lifecycle.ts";
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

function fixture(behavior: UpstreamChatClient["chatCompletionStream"]) {
	const db = openDb(":memory:");
	databases.push(db);
	const store = new SqliteBillingStore(db);
	store.adjust("faux-member", 100);
	store.saveRate({
		model: "faux-model",
		promptPer1m: 100,
		completionPer1m: 100,
		cacheReadPer1m: 100,
		cacheWritePer1m: 100,
		enabled: true,
	});
	const billing = new BillingService({ store });
	const accounts = new SqliteAccountStore(db);
	accounts.create({ name: "faux", platform: "GROK", credentials: { apiKey: "faux-only" }, enabled: true }, 0);
	const client: UpstreamChatClient = {
		platform: () => "GROK",
		chatCompletion: async () => ({}),
		chatCompletionStream: behavior,
	};
	const upstreams = new Map([[client.platform(), client]]);
	const state = new MemoryGatewayState();
	const router = new AccountPoolRouter({ accounts, accountCooldownMs: 1000, cooldownState: state });
	const sticky = new StickySessionService({ enabled: false, ttlSeconds: 60 });
	const keys = new ApiKeyService({ store: new SqliteApiKeyStore(db) });
	const created = keys.create({ name: "faux", ownerMemberId: "faux-member" });
	const key = keys.authenticate(created.plaintext);
	if (!key) throw new Error("faux key setup failed");
	const catalog = new SqliteCatalogStore(db);
	catalog.saveModel({
		id: "faux-public",
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
		modelId: "faux-public",
		platform: "GROK",
		upstreamModel: "faux-upstream",
		priority: 0,
		enabled: true,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: [],
	});
	catalog.saveCapacity({
		platform: "GROK",
		upstreamModel: "faux-upstream",
		available: true,
		contextWindow: 200000,
		maxOutputTokens: 32000,
	});
	const callLogs = new SqliteCallLogStore(db);
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
		callLogs,
		billing,
		billingStore: store,
		catalog,
		listPublishedModels: () => catalog.listModels(),
		trustedProxyCount: 0,
	};
	const auth = { key, requestId: "faux-request", clientIp: "127.0.0.1" };
	const payload = { model: "faux-model", messages: [{ role: "user", content: "faux" }], max_tokens: 1, stream: true };
	return { db, store, billing, deps, auth, payload, plaintextKey: created.plaintext };
}

async function serveFixture(f: ReturnType<typeof fixture>) {
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
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

describe("preventive billing lifecycle with isolated SQLite and faux upstream", () => {
	it("rolls back a debit when ledger insertion fails", () => {
		const f = fixture(async () => {});
		f.db.exec(
			"CREATE TRIGGER reject_faux_ledger BEFORE INSERT ON billing_ledger_entries BEGIN SELECT RAISE(ABORT, 'faux insertion failure'); END",
		);
		expect(() => f.billing.reserve("faux-member", "faux-key", "faux-model", f.payload)).toThrow();
		expect(f.billing.balance("faux-member")).toBe(100);
		expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_ledger_entries").get()?.n).toBe(0);
	});

	it("persists request/call identity before any upstream dispatch", async () => {
		let linkedAtDispatch = false;
		const f = fixture(async () => {
			const ledger = f.db.prepare("SELECT request_id,call_log_id FROM billing_ledger_entries").get();
			const log = f.db.prepare("SELECT id,request_id,status FROM gateway_call_logs").get();
			linkedAtDispatch =
				ledger?.request_id === f.auth.requestId && ledger.call_log_id === log?.id && log?.status === "DISPATCHED";
		});
		await chatCompletionStream(f.deps, f.auth, f.payload, () => {});
		expect(linkedAtDispatch).toBe(true);
		expect(f.db.prepare("SELECT COUNT(*) n FROM gateway_call_logs").get()?.n).toBe(1);
	});

	it("does not dispatch a request whose signal is already aborted", async () => {
		let calls = 0;
		const f = fixture(async () => {
			calls++;
		});
		const abort = new AbortController();
		abort.abort();
		await expect(chatCompletionStream(f.deps, f.auth, f.payload, () => {}, abort.signal)).rejects.toThrow();
		expect(calls).toBe(0);
		expect(f.billing.balance("faux-member")).toBe(100);
	});

	it("cannot dispatch if the durable prepared call cannot be saved", async () => {
		let calls = 0;
		const f = fixture(async () => {
			calls++;
		});
		f.db.exec(
			"CREATE TRIGGER reject_faux_call BEFORE INSERT ON gateway_call_logs BEGIN SELECT RAISE(ABORT, 'faux call persistence failure'); END",
		);
		await expect(chatCompletionStream(f.deps, f.auth, f.payload, () => {})).rejects.toThrow(/persistence/);
		expect(calls).toBe(0);
		expect(f.billing.balance("faux-member")).toBe(100);
		expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_ledger_entries").get()?.n).toBe(0);
	});

	it("a deterministic pre-dispatch route failure releases the reservation", async () => {
		const f = fixture(async () => {
			throw new Error("must not dispatch");
		});
		f.db.exec("UPDATE accounts SET enabled=0");
		await expect(chatCompletionStream(f.deps, f.auth, f.payload, () => {})).rejects.toThrow(/无可用账号/);
		expect(f.billing.balance("faux-member")).toBe(100);
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("VOIDED");
	});

	it("retains unknown billing after output and interruption", async () => {
		const f = fixture(async (_account, _payload, chunk) => {
			chunk(JSON.stringify({ choices: [{ delta: { content: "faux output" } }] }));
			throw new UpstreamException("SERVER", "faux interruption");
		});
		await expect(chatCompletionStream(f.deps, f.auth, f.payload, () => {})).rejects.toThrow();
		const ledger = f.db.prepare("SELECT status,reserved_amount FROM billing_ledger_entries").get();
		expect(ledger?.status).toBe("REVIEW");
		expect(f.billing.balance("faux-member")).toBe(100 - Number(ledger?.reserved_amount));
	});

	it("preserves a legacy stale unlinked hold without a refund", () => {
		const f = fixture(async () => {});
		const { entryId } = f.billing.reserve("faux-member", "faux-key", "faux-model", f.payload);
		f.db.prepare("UPDATE billing_ledger_entries SET occurred_at=0 WHERE id=?").run(entryId);
		const before = f.billing.balance("faux-member");
		expect(f.billing.sweepStale()).toBe(1);
		expect(f.store.getLedger(entryId)?.status).toBe("REVIEW");
		expect(f.billing.balance("faux-member")).toBe(before);
	});

	it("keeps known completion settlement idempotent", async () => {
		const f = fixture(async (_account, _payload, chunk) =>
			chunk(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })),
		);
		await chatCompletionStream(f.deps, f.auth, f.payload, () => {});
		const entry = f.db.prepare("SELECT id,status FROM billing_ledger_entries").get();
		expect(entry?.status).toBe("POSTED");
		const before = f.billing.balance("faux-member");
		f.billing.settle(String(entry?.id), { promptTokens: 10, completionTokens: 2 }, "faux-model");
		expect(f.billing.balance("faux-member")).toBe(before);
	});

	it("rolls back a settlement refund when the ledger update fails", () => {
		const f = fixture(async () => {});
		const { entryId } = f.billing.reserve("faux-member", "faux-key", "faux-model", {
			...f.payload,
			max_tokens: 32000,
		});
		const before = f.billing.balance("faux-member");
		f.db.exec(
			"CREATE TRIGGER reject_faux_update BEFORE UPDATE ON billing_ledger_entries BEGIN SELECT RAISE(ABORT, 'faux update failure'); END",
		);
		expect(() => f.billing.settle(entryId, { promptTokens: 10, completionTokens: 2 }, "faux-model")).toThrow();
		expect(f.billing.balance("faux-member")).toBe(before);
		expect(f.store.getLedger(entryId)?.status).toBe("PENDING");
	});

	it("rolls back a pre-dispatch refund when its ledger update fails", () => {
		const f = fixture(async () => {});
		const { entryId } = f.billing.reserve("faux-member", "faux-key", "faux-model", f.payload);
		const before = f.billing.balance("faux-member");
		f.db.exec(
			"CREATE TRIGGER reject_faux_void BEFORE UPDATE ON billing_ledger_entries BEGIN SELECT RAISE(ABORT, 'faux void failure'); END",
		);
		expect(() => f.billing.voidPending(entryId)).toThrow();
		expect(f.billing.balance("faux-member")).toBe(before);
		expect(f.store.getLedger(entryId)?.status).toBe("PENDING");
	});

	it.each([NaN, Infinity, -Infinity, 0.5, -1, Number.MAX_SAFE_INTEGER + 1, "10"])(
		"retains the hold for invalid usage %s",
		(invalid) => {
			const f = fixture(async () => {});
			const { entryId } = f.billing.reserve("faux-member", "faux-key", "faux-model", f.payload);
			const before = f.billing.balance("faux-member");
			const usage = { promptTokens: invalid, completionTokens: 0 } as unknown as Parameters<
				BillingService["settle"]
			>[1];
			f.billing.settle(entryId, usage, "faux-model");
			expect(f.store.getLedger(entryId)?.status).toBe("REVIEW");
			expect(f.billing.balance("faux-member")).toBe(before);
		},
	);

	it("accepts integer zero usage and closes the reservation only once", () => {
		const f = fixture(async () => {});
		const { entryId } = f.billing.reserve("faux-member", "faux-key", "faux-model", f.payload);
		f.billing.settle(entryId, { promptTokens: 0, completionTokens: 0 }, "faux-model");
		f.billing.voidPending(entryId);
		f.billing.settle(entryId, { promptTokens: 0, completionTokens: 0 }, "faux-model");
		expect(f.store.getLedger(entryId)?.status).toBe("POSTED");
		expect(f.billing.balance("faux-member")).toBe(100);
	});

	it.each([
		'{"choices":[],"usage":{"prompt_tokens":0.5,"completion_tokens":0,"total_tokens":0.5}}',
		'{"choices":[],"usage":{"prompt_tokens":1e400,"completion_tokens":0,"total_tokens":1e400}}',
	])("does not normalize invalid raw JSON usage into a valid charge", async (frame) => {
		const f = fixture(async (_account, _payload, chunk) => chunk(frame));
		await chatCompletionStream(f.deps, f.auth, f.payload, () => {});
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
		expect(f.billing.balance("faux-member")).toBe(98);
	});

	it("a stale durable PREPARED release prevents later dispatch", () => {
		const f = fixture(async () => {});
		const { entryId } = f.billing.reserve("faux-member", "faux-key", "faux-model", f.payload, {
			requestId: "owned-request",
			callLogId: "billing-v1_owned-call",
		});
		f.db
			.prepare(
				"INSERT INTO gateway_call_logs(id,request_id,status,occurred_at) VALUES('billing-v1_owned-call','owned-request','PREPARED',0)",
			)
			.run();
		f.db.prepare("UPDATE billing_ledger_entries SET occurred_at=0 WHERE id=?").run(entryId);
		expect(f.billing.sweepStale()).toBe(1);
		expect(f.store.getLedger(entryId)?.status).toBe("VOIDED");
		expect(f.billing.balance("faux-member")).toBe(100);
		expect(f.billing.claimDispatch(entryId, "owned-request")).toBe(false);
	});

	it("stale dispatched holds become REVIEW; active calls are not reconciled", () => {
		const f = fixture(async () => {});
		const { entryId } = f.billing.reserve("faux-member", "faux-key", "faux-model", f.payload, {
			requestId: "owned-request",
			callLogId: "billing-v1_owned-call",
		});
		f.db
			.prepare(
				"INSERT INTO gateway_call_logs(id,request_id,status,occurred_at) VALUES('billing-v1_owned-call','owned-request','PREPARED',0)",
			)
			.run();
		expect(f.billing.claimDispatch(entryId, "owned-request")).toBe(true);
		expect(f.billing.claimDispatch(entryId, "owned-request")).toBe(false);
		f.db.prepare("UPDATE billing_ledger_entries SET occurred_at=0 WHERE id=?").run(entryId);
		const before = f.billing.balance("faux-member");
		expect(f.billing.sweepStale(new Set(["billing-v1_owned-call"]))).toBe(0);
		expect(f.billing.sweepStale()).toBe(1);
		expect(f.store.getLedger(entryId)?.status).toBe("REVIEW");
		expect(f.billing.balance("faux-member")).toBe(before);
	});

	it("a legacy linked PREPARED row is not proof of this dispatch lifecycle", () => {
		const f = fixture(async () => {});
		const { entryId } = f.billing.reserve("faux-member", "faux-key", "faux-model", f.payload, {
			requestId: "legacy-request",
			callLogId: "legacy-call",
		});
		f.db
			.prepare(
				"INSERT INTO gateway_call_logs(id,request_id,status,occurred_at) VALUES('legacy-call','legacy-request','PREPARED',0)",
			)
			.run();
		f.db.prepare("UPDATE billing_ledger_entries SET occurred_at=0 WHERE id=?").run(entryId);
		const before = f.billing.balance("faux-member");
		expect(f.billing.sweepStale()).toBe(1);
		expect(f.store.getLedger(entryId)?.status).toBe("REVIEW");
		expect(f.billing.balance("faux-member")).toBe(before);
	});

	it("bounded shutdown abort reaches upstream and preserves the unknown hold", async () => {
		let started: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let observed: AbortSignal | undefined;
		const f = fixture(async (_account, _payload, chunk, signal) => {
			observed = signal;
			chunk(JSON.stringify({ choices: [{ delta: { content: "faux partial" } }] }));
			started();
			if (!signal) throw new Error("missing upstream cancellation signal");
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		});
		const lifecycle = new GatewayLifecycle();
		f.deps.lifecycle = lifecycle;
		const running = chatCompletionStream(f.deps, f.auth, f.payload, () => {});
		const rejected = expect(running).rejects.toThrow();
		await ready;
		expect(await lifecycle.drain(250)).toBe(true);
		await rejected;
		expect(observed?.aborted).toBe(true);
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
		expect(f.billing.balance("faux-member")).toBe(98);
		expect(() => lifecycle.enter("next")).toThrow(/停止/);
	});

	it("shutdown stops waiting within its bound even if an adapter ignores cancellation", async () => {
		let started: () => void = () => {};
		let release: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = fixture(async () => {
			started();
			await wait;
		});
		const lifecycle = new GatewayLifecycle();
		f.deps.lifecycle = lifecycle;
		const running = chatCompletionStream(f.deps, f.auth, f.payload, () => {});
		const rejected = expect(running).rejects.toThrow();
		await ready;
		expect(await lifecycle.drain(20)).toBe(false);
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
		expect(f.billing.balance("faux-member")).toBe(98);
		release();
		await rejected;
		expect(lifecycle.activeCallIds().size).toBe(0);
	});

	it("cancellation does not rotate to a second upstream account", async () => {
		const abort = new AbortController();
		let calls = 0;
		const f = fixture(async () => {
			calls++;
			abort.abort(new Error("faux cancellation"));
			throw new UpstreamException("SERVER", "faux after cancellation");
		});
		f.deps.accounts.create(
			{ name: "second-faux", platform: "GROK", credentials: { apiKey: "faux-only" }, enabled: true },
			0,
		);
		f.deps.generation = new RouteGeneration({
			accounts: f.deps.accounts,
			router: f.deps.router,
			sticky: f.deps.sticky,
			upstreams: f.deps.upstreams,
			maxRotate: 2,
		});
		await expect(chatCompletionStream(f.deps, f.auth, f.payload, () => {}, abort.signal)).rejects.toThrow(
			/cancellation/,
		);
		expect(calls).toBe(1);
		expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
	});

	it("a completed HTTP request body does not cancel an in-flight response", async () => {
		const f = fixture(async () => {});
		let observed: AbortSignal | undefined;
		const client = f.deps.upstreams.get("GROK")!;
		client.chatCompletion = async (_account, _payload, signal) => {
			observed = signal;
			await new Promise((resolve) => setTimeout(resolve, 30));
			signal?.throwIfAborted();
			return { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
		};
		const server = await serveFixture(f);
		try {
			const response = await fetch(server.url, {
				method: "POST",
				headers: { Authorization: `Bearer ${f.plaintextKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ ...f.payload, stream: false }),
			});
			expect(response.status).toBe(200);
			await response.json();
			expect(observed?.aborted).toBe(false);
			expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("POSTED");
		} finally {
			await server.close();
		}
	});

	it("HTTP stream reader cancellation reaches upstream and retains its hold", async () => {
		let observed: AbortSignal | undefined;
		const f = fixture(async (_account, _payload, chunk, signal) => {
			observed = signal;
			chunk(JSON.stringify({ choices: [{ delta: { content: "faux partial" } }] }));
			if (!signal) throw new Error("missing HTTP cancellation signal");
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		});
		const server = await serveFixture(f);
		try {
			const response = await fetch(server.url, {
				method: "POST",
				headers: { Authorization: `Bearer ${f.plaintextKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(f.payload),
			});
			const reader = response.body!.getReader();
			await reader.read();
			await reader.cancel();
			await expect.poll(() => observed?.aborted, { timeout: 1000 }).toBe(true);
			await expect
				.poll(() => f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status)
				.toBe("REVIEW");
			expect(f.billing.balance("faux-member")).toBe(98);
		} finally {
			await server.close();
		}
	});
});
