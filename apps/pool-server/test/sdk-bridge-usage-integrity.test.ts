import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AccountPoolRouter,
	ApiKeyService,
	BillingService,
	MemoryGatewayState,
	type Platform,
	RouteGeneration,
	StickySessionService,
	type UpstreamChatClient,
} from "owl-pool";
import { describe, expect, it } from "vitest";
import { SdkBridgeChatClient, SdkBridgeManager } from "../src/gateway/sdk-bridge.ts";
import { chatCompletion, chatCompletionStream, type GatewayServiceDeps } from "../src/gateway/service.ts";
import { SqliteAccountStore } from "../src/store/account-store.ts";
import { SqliteBillingStore } from "../src/store/billing-store.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteApiKeyStore, SqliteCallLogStore, SqliteCatalogStore } from "../src/store/gateway-stores.ts";

function fixture(mode: "overlap" | "missing") {
	const directory = mkdtempSync(join(tmpdir(), "owl-bridge-usage-"));
	const script = join(directory, "fixture.mjs");
	// The child imports the actual bridge; only its platform provider is replaced.
	const protocol = new URL("../bridge/protocol.mjs", import.meta.url).href;
	writeFileSync(
		script,
		`import {createInterface} from 'node:readline';
import {BridgeProtocol} from ${JSON.stringify(protocol)};
const protocol = new BridgeProtocol({platform:'CURSOR',runtime:{env:{},cwd:process.cwd()},
  emit:event=>process.stdout.write(JSON.stringify(event)+'\\n'),
  providerFactory:async()=>({async chat(_request,ctx){
    ctx.text('fixture');ctx.usage(1000,10,true,{cacheReadTokens:600,cacheWriteTokens:100});
    ${mode === "overlap" ? "ctx.usage(1000,10,true,{cacheReadTokens:900,cacheWriteTokens:200});" : "ctx.usage(null,null);"}
    return {stopReason:'end_turn'};
  },async close(){}})});
createInterface({input:process.stdin}).on('line',line=>void protocol.dispatch(JSON.parse(line)));
`,
	);
	const db = openDb(":memory:");
	const accounts = new SqliteAccountStore(db);
	accounts.create(
		{ name: "Faux", platform: "CURSOR", credentials: { apiKey: "offline-fixture-only" }, enabled: true },
		0,
	);
	const store = new SqliteBillingStore(db);
	store.adjust("faux-member", 100);
	store.saveRate({
		model: "faux-model",
		promptPer1m: 200,
		completionPer1m: 800,
		cacheReadPer1m: 4,
		cacheWritePer1m: 200,
		enabled: true,
	});
	const config = {
		nodeExecutable: process.execPath,
		script,
		homeRoot: join(directory, "accounts"),
		requestTimeoutMs: 2000,
		idleRecycleMs: 30000,
		userHome: directory,
	};
	const manager = new SdkBridgeManager(config, accounts);
	const upstream = new SdkBridgeChatClient(manager, accounts, "CURSOR", config);
	const state = new MemoryGatewayState(),
		router = new AccountPoolRouter({ accounts, accountCooldownMs: 1000, cooldownState: state });
	const sticky = new StickySessionService({ enabled: false, ttlSeconds: 60 });
	const upstreams = new Map<Platform, UpstreamChatClient>([["CURSOR", upstream]]);
	const keys = new ApiKeyService({ store: new SqliteApiKeyStore(db) });
	const key = keys.authenticate(keys.create({ name: "Faux", ownerMemberId: "faux-member" }).plaintext)!;
	const catalog = new SqliteCatalogStore(db);
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
		platform: "CURSOR",
		upstreamModel: "faux-model",
		priority: 0,
		enabled: true,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: [],
	});
	catalog.saveCapacity({
		platform: "CURSOR",
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
			upstreamTimeoutMs: 2000,
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
		billing: new BillingService({ store }),
		billingStore: store,
		catalog,
		listPublishedModels: () => catalog.listModels(),
		trustedProxyCount: 0,
	};
	return {
		db,
		deps,
		auth: { key, requestId: "faux-bridge-usage", clientIp: "127.0.0.1" },
		close() {
			manager.stop();
			db.close();
			if (!directory.startsWith(join(tmpdir(), "owl-bridge-usage-")))
				throw new Error("Unexpected fixture directory");
			try {
				rmSync(directory, { recursive: true, force: true });
			} catch {
				/* Windows child handle release can be delayed. */
			}
		},
	};
}

describe("actual bridge usage integrity reaches gateway settlement", () => {
	it.each([true, false])("invalid final metrics retain REVIEW (stream=%s)", async (stream) => {
		const f = fixture("overlap");
		try {
			const payload = {
				model: "faux-model",
				stream,
				max_tokens: 10,
				messages: [{ role: "user", content: "offline" }],
			};
			if (stream) await chatCompletionStream(f.deps, f.auth, payload, () => {});
			else await chatCompletion(f.deps, f.auth, payload);
			expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("REVIEW");
			expect(
				f.db.prepare("SELECT usage_source,prompt_tokens,completion_tokens FROM gateway_call_logs").get(),
			).toMatchObject({ usage_source: "UNKNOWN", prompt_tokens: -1, completion_tokens: -1 });
		} finally {
			f.close();
		}
	});
	it("an empty usage notification preserves earlier valid metrics", async () => {
		const f = fixture("missing");
		try {
			await chatCompletionStream(
				f.deps,
				f.auth,
				{ model: "faux-model", max_tokens: 10, messages: [{ role: "user", content: "offline" }] },
				() => {},
			);
			expect(f.db.prepare("SELECT status FROM billing_ledger_entries").get()?.status).toBe("POSTED");
			expect(
				f.db.prepare("SELECT usage_source,prompt_tokens,completion_tokens FROM gateway_call_logs").get(),
			).toMatchObject({ usage_source: "KNOWN", prompt_tokens: 1000, completion_tokens: 10 });
		} finally {
			f.close();
		}
	});
});
