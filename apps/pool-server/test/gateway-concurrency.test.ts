import type { Platform, UpstreamChatClient } from "owl-pool";
import {
	AccountPoolRouter,
	ApiKeyService,
	BillingService,
	MemoryGatewayState,
	RouteGeneration,
	StickySessionService,
	UpstreamException,
} from "owl-pool";
import { describe, expect, it } from "vitest";
import { chatCompletionStream, type GatewayServiceDeps } from "../src/gateway/service.ts";
import { SqliteAccountStore } from "../src/store/account-store.ts";
import { SqliteBillingStore } from "../src/store/billing-store.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteApiKeyStore, SqliteCallLogStore, SqliteCatalogStore } from "../src/store/gateway-stores.ts";

function barrier() {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function scenario(options: {
	overlap: boolean;
	failA: boolean;
	partial?: boolean;
	finishBFirst?: boolean;
	pinned?: boolean;
}) {
	const db = openDb(":memory:");
	try {
		const accounts = new SqliteAccountStore(db);
		const aPrimary = accounts.create(
			{ name: "faux-a-primary", platform: "GROK", credentials: { apiKey: "faux" }, enabled: true },
			0,
		);
		const aFallback = accounts.create(
			{ name: "faux-a-fallback", platform: "GROK", credentials: { apiKey: "faux" }, enabled: true },
			0,
		);
		const bAccount = accounts.create(
			{
				name: "faux-b",
				platform: options.pinned ? "GROK" : "ZCODE",
				credentials: { apiKey: "faux" },
				enabled: true,
			},
			0,
		);
		accounts.patchState(aPrimary.id, { credits: 2 });
		accounts.patchState(aFallback.id, { credits: 0 });
		accounts.patchState(bAccount.id, { credits: 0 });
		const aReady = barrier(),
			bReady = barrier(),
			releaseA = barrier(),
			releaseB = barrier();
		const callsA: string[] = [],
			callsB: string[] = [];
		const behavior: UpstreamChatClient["chatCompletionStream"] = async (account, payload, chunk) => {
			if (payload.model === "faux-model-a") {
				callsA.push(account.id);
				if (callsA.length === 1) {
					if (options.partial !== false)
						chunk(JSON.stringify({ choices: [{ delta: { content: "faux partial A" } }] }));
					aReady.release();
					await releaseA.promise;
					if (options.failA) {
						accounts.patchState(aFallback.id, { credits: 2 });
						throw new UpstreamException("SERVER", "faux A interruption");
					}
				} else chunk(JSON.stringify({ choices: [{ delta: { content: "faux retry A" } }] }));
			} else {
				callsB.push(account.id);
				bReady.release();
				await releaseB.promise;
				chunk(JSON.stringify({ choices: [{ delta: { content: "faux B" } }] }));
			}
			chunk(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
		};
		const upstreams = new Map<Platform, UpstreamChatClient>([
			["GROK", { platform: () => "GROK", chatCompletion: async () => ({}), chatCompletionStream: behavior }],
			["ZCODE", { platform: () => "ZCODE", chatCompletion: async () => ({}), chatCompletionStream: behavior }],
		]);
		const store = new SqliteBillingStore(db),
			billing = new BillingService({ store }),
			catalog = new SqliteCatalogStore(db);
		const state = new MemoryGatewayState(),
			router = new AccountPoolRouter({ accounts, accountCooldownMs: 1000, cooldownState: state }),
			sticky = new StickySessionService({ enabled: false, ttlSeconds: 60 });
		const keys = new ApiKeyService({ store: new SqliteApiKeyStore(db) });
		function caller(suffix: string, platform: Platform) {
			const model = `faux-model-${suffix}`,
				member = `faux-member-${suffix}`;
			store.adjust(member, 100);
			store.saveRate({
				model,
				promptPer1m: 100,
				completionPer1m: 100,
				cacheReadPer1m: 100,
				cacheWritePer1m: 100,
				enabled: true,
			});
			const key = keys.authenticate(keys.create({ name: suffix, ownerMemberId: member }).plaintext);
			if (!key) throw new Error("faux authentication failed");
			catalog.saveModel({
				id: model,
				publicId: model,
				name: model,
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
				id: `faux-route-${suffix}`,
				modelId: model,
				platform,
				upstreamModel: model,
				priority: 0,
				enabled: true,
				supportsImages: false,
				supportsTools: true,
				reasoningEfforts: [],
			});
			catalog.saveCapacity({
				platform,
				upstreamModel: model,
				available: true,
				contextWindow: 200000,
				maxOutputTokens: 32000,
			});
			return {
				auth: { key, requestId: `faux-request-${suffix}`, clientIp: "127.0.0.1" },
				payload: { model, messages: [{ role: "user", content: "faux only" }], max_tokens: 1, stream: true },
			};
		}
		const aCaller = caller("a", "GROK"),
			bCaller = caller("b", options.pinned ? "GROK" : "ZCODE");
		const deps: GatewayServiceDeps = {
			config: {
				enabled: true,
				globalRateLimitPerMinute: 100,
				ipRateLimitPerMinute: 100,
				ipWhitelist: null,
				maxRotate: 2,
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
			generation: new RouteGeneration({ accounts, router, sticky, upstreams, maxRotate: 2 }),
			callLogs: new SqliteCallLogStore(db),
			billing,
			billingStore: store,
			catalog,
			listPublishedModels: () => catalog.listModels(),
			trustedProxyCount: 0,
		};
		if (options.pinned)
			deps.continuation = {
				find: (key) => ({ accountId: key.id === aCaller.auth.key.id ? aPrimary.id : bAccount.id }),
				consume: () => {},
				bind: () => {},
			};
		const a = chatCompletionStream(deps, aCaller.auth, aCaller.payload, () => {}).then(
			() => "completed",
			() => "rejected",
		);
		await aReady.promise;
		let b: Promise<string> | undefined;
		if (options.overlap) {
			b = chatCompletionStream(deps, bCaller.auth, bCaller.payload, () => {}).then(
				() => "completed",
				() => "rejected",
			);
			await bReady.promise;
			if (options.finishBFirst) {
				releaseB.release();
				await b;
			}
		}
		releaseA.release();
		const aOutcome = await a;
		if (!b) {
			b = chatCompletionStream(deps, bCaller.auth, bCaller.payload, () => {}).then(
				() => "completed",
				() => "rejected",
			);
			await bReady.promise;
		}
		releaseB.release();
		const bOutcome = await b;
		const rows = db
			.prepare("SELECT request_id,call_log_id,status FROM billing_ledger_entries ORDER BY request_id")
			.all();
		return {
			callsA,
			callsB,
			aOutcome,
			bOutcome,
			rows,
			aFallbackId: aFallback.id,
			bAccountId: bAccount.id,
			balances: { a: billing.balance("faux-member-a"), b: billing.balance("faux-member-b") },
		};
	} finally {
		db.close();
	}
}

describe("gateway route state is owned by one request", () => {
	it("serial partial interruption never retries and keeps REVIEW", async () => {
		const result = await scenario({ overlap: false, failA: true });
		expect(result.callsA).toHaveLength(1);
		expect(result.aOutcome).toBe("rejected");
		expect(result.rows.map((row) => row.status)).toEqual(["REVIEW", "POSTED"]);
	});
	it("another in-flight request cannot clear partial-output retry protection", async () => {
		const result = await scenario({ overlap: true, failA: true });
		expect(result.callsA).toHaveLength(1);
		expect(result.callsB).toHaveLength(1);
		expect(result.aOutcome).toBe("rejected");
		expect(result.rows.map((row) => row.status)).toEqual(["REVIEW", "POSTED"]);
	});
	it("normal overlapping calls retain independent call identities and wallets", async () => {
		const result = await scenario({ overlap: true, failA: false });
		expect(result.callsA).toHaveLength(1);
		expect(result.callsB).toHaveLength(1);
		expect(result.aOutcome).toBe("completed");
		expect(result.bOutcome).toBe("completed");
		expect(result.rows.map((row) => row.status)).toEqual(["POSTED", "POSTED"]);
		expect(result.rows[0]?.call_log_id).not.toBe(result.rows[1]?.call_log_id);
		expect(result.balances).toEqual({ a: 98, b: 98 });
	});
	it("another completed request cannot prohibit a valid retry before output", async () => {
		const result = await scenario({ overlap: true, failA: true, partial: false, finishBFirst: true });
		expect(result.callsA).toHaveLength(2);
		expect(result.aOutcome).toBe("completed");
		expect(result.rows.map((row) => row.status)).toEqual(["POSTED", "POSTED"]);
	});
	it("an overlapping continuation pin cannot choose the other request's account", async () => {
		const result = await scenario({ overlap: true, failA: true, partial: false, pinned: true });
		expect(result.callsA).toHaveLength(2);
		expect(result.callsA[1]).toBe(result.aFallbackId);
		expect(result.callsB).toEqual([result.bAccountId]);
		expect(result.aOutcome).toBe("completed");
	});
});
