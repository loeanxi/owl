import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Account,
	AccountPoolRouter,
	ApiKeyService,
	BillingService,
	DEFAULT_OUTPUT,
	MemoryGatewayState,
	type Platform,
	RouteGeneration,
	StickySessionService,
	type UpstreamChatClient,
	UpstreamException,
} from "owl-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayServiceDeps } from "../src/gateway/service.ts";
import { createPoolServer } from "../src/server.ts";
import { SqliteAccountStore } from "../src/store/account-store.ts";
import { SqliteBillingStore } from "../src/store/billing-store.ts";
import { SqliteCheckInRecordStore } from "../src/store/checkin-record-store.ts";
import { dbAlive, openDb } from "../src/store/db.ts";
import { SqliteApiKeyStore, SqliteCallLogStore, SqliteCatalogStore } from "../src/store/gateway-stores.ts";

let workdir: string;
let server: ReturnType<typeof createPoolServer>;
let baseUrl: string;
const callBehavior: Array<(account: Account) => Record<string, unknown>> = [];
const streamBehavior: Array<(account: Account, send: (json: string) => void) => void> = [];
const calledAccounts: string[] = [];

/** Mock 上游：GROK 平台，行为由脚本队列驱动。 */
const mockUpstream: UpstreamChatClient = {
	platform: () => "GROK",
	async chatCompletion(account) {
		calledAccounts.push(account.id);
		const script = callBehavior.shift();
		if (script === undefined) {
			throw new UpstreamException("SERVER", "no script");
		}
		return script(account);
	},
	async chatCompletionStream(account, _payload, onChunk) {
		calledAccounts.push(account.id);
		const script = streamBehavior.shift();
		if (script === undefined) {
			throw new UpstreamException("SERVER", "no script");
		}
		script(account, onChunk);
	},
};

const grokA: Account = {
	id: "acc-a",
	name: "GrokA",
	platform: "GROK",
	credentials: { apiKey: "ka" },
	enabled: true,
	createdAt: 0,
	updatedAt: 0,
	credits: 5,
};
const grokB: Account = {
	id: "acc-b",
	name: "GrokB",
	platform: "GROK",
	credentials: { apiKey: "kb" },
	enabled: true,
	createdAt: 0,
	updatedAt: 0,
	credits: 0,
};

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "owl-pool-gw-"));
	const db = openDb(join(workdir, "pool.db"));
	const accounts = new SqliteAccountStore(db);
	for (const account of [grokA, grokB]) {
		// create 生成自己的 id；回填到常量上，供 mock 脚本与断言使用
		const created = accounts.create(
			{ name: account.name, platform: account.platform, credentials: account.credentials, enabled: true },
			0,
		);
		accounts.patchState(created.id, { credits: account.credits });
		account.id = created.id;
	}
	const records = new SqliteCheckInRecordStore(db);
	const checkin = { countUnsigned: () => 0, catchUpUnsigned: async () => null } as unknown as ConstructorParameters<
		typeof Object
	>[0] &
		Record<string, unknown>;
	const keys = new ApiKeyService({ store: new SqliteApiKeyStore(db) });
	const catalog = new SqliteCatalogStore(db);
	const callLogs = new SqliteCallLogStore(db);
	const billingStore = new SqliteBillingStore(db);
	billingStore.adjust("low-balance-member", 4);
	billingStore.saveRate({
		model: "star-lm",
		promptPer1m: 4_500,
		completionPer1m: 4_000,
		cacheReadPer1m: 4_500,
		cacheWritePer1m: 4_500,
		enabled: true,
	});
	const billing = new BillingService({ store: billingStore });
	const state = new MemoryGatewayState();
	const poolRouter = new AccountPoolRouter({ accounts, accountCooldownMs: 60_000, cooldownState: state });
	const sticky = new StickySessionService({ enabled: true, ttlSeconds: 900 });
	const upstreams = new Map<Platform, UpstreamChatClient>([[mockUpstream.platform(), mockUpstream]]);
	const generation = new RouteGeneration({ accounts, router: poolRouter, sticky, upstreams, maxRotate: 3 });
	const gateway: GatewayServiceDeps = {
		config: {
			enabled: true,
			globalRateLimitPerMinute: 600,
			ipRateLimitPerMinute: 300,
			ipWhitelist: null,
			maxRotate: 3,
			accountCooldownMs: 60_000,
			upstreamTimeoutMs: 120_000,
			stickyEnabled: true,
			stickyTtlSeconds: 900,
		},
		state,
		keys,
		accounts,
		router: poolRouter,
		generation,
		sticky,
		upstreams,
		callLogs,
		billing,
		billingStore,
		catalog,
		listPublishedModels: () => catalog.listModels(),
		trustedProxyCount: 0,
	};
	// 上架模型：star-lm → GROK star-a（优先）/ star-b
	catalog.saveModel({
		id: "m1",
		publicId: "star-lm",
		name: "Star LM",
		description: null,
		modelVersion: null,
		contextWindow: 200_000,
		defaultContextWindow: null,
		defaultReasoningEffort: "medium",
		maxOutputTokens: 32_000,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: ["low", "medium", "high"],
		published: true,
		sortOrder: 0,
		updatedAt: 0,
	});
	catalog.saveRoute({
		id: "r1",
		modelId: "m1",
		platform: "GROK",
		upstreamModel: "star-a",
		priority: 0,
		enabled: true,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: ["low", "medium", "high"],
	});
	catalog.saveRoute({
		id: "r2",
		modelId: "m1",
		platform: "GROK",
		upstreamModel: "star-b",
		priority: 1,
		enabled: true,
		supportsImages: false,
		supportsTools: true,
		reasoningEfforts: ["low", "medium", "high"],
	});
	catalog.saveCapacity({
		platform: "GROK",
		upstreamModel: "star-a",
		available: true,
		contextWindow: 128_000,
		maxOutputTokens: 16_000,
	});
	catalog.saveCapacity({
		platform: "GROK",
		upstreamModel: "star-b",
		available: true,
		contextWindow: 128_000,
		maxOutputTokens: 16_000,
	});
	const createdKey = keys.create({ name: "桌面端" });
	plaintextKey = createdKey.plaintext;
	lowBalanceKey = keys.create({ name: "余额不足回归", ownerMemberId: "low-balance-member" }).plaintext;

	server = createPoolServer({
		accounts,
		records,
		checkin: checkin as never,
		dbPath: join(workdir, "pool.db"),
		isDbAlive: () => dbAlive(db),
		gateway: { gateway, gatewayConfig: gateway.config },
	});
	await new Promise<void>((resolveListen) => {
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

let plaintextKey = "";
let lowBalanceKey = "";
let now2 = 1_700_000_000_000;

afterAll(() => {
	server.close();
	setTimeout(() => {
		try {
			rmSync(workdir, { recursive: true, force: true });
		} catch {
			// Windows 句柄延迟
		}
	}, 200);
});

async function api(
	method: string,
	path: string,
	options: { body?: unknown; key?: string } = {},
): Promise<{ status: number; json: any; headers: Headers }> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			...(options.key === undefined ? {} : { Authorization: `Bearer ${options.key}` }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = { raw: text };
	}
	return { status: response.status, json, headers: response.headers };
}

describe("OpenAI 网关（阶段 3 HTTP 全流程）", () => {
	it("无 Key → 401 missing_api_key（OpenAI 错误体）", async () => {
		const { status, json } = await api("POST", "/v1/chat/completions", { body: { model: "star-lm", messages: [] } });
		expect(status).toBe(401);
		expect(json.error.code).toBe("missing_api_key");
	});

	it("错误 Key → 401 invalid_api_key；带 X-Request-Id", async () => {
		const { status, json, headers } = await api("POST", "/v1/chat/completions", {
			key: "sk-nope",
			body: { model: "star-lm", messages: [] },
		});
		expect(status).toBe(401);
		expect(json.error.code).toBe("invalid_api_key");
		expect(headers.get("x-request-id")).not.toBe("");
	});

	it("/v1/models 列出已上架模型", async () => {
		const { status, json } = await api("GET", "/v1/models", { key: plaintextKey });
		expect(status).toBe(200);
		expect(json.data.map((item: { id: string }) => item.id)).toContain("star-lm");
	});

	it("非流式对话：上游响应 sanitize（model=公开名、id 重写）+ 调用日志", async () => {
		callBehavior.push(() => ({
			id: "upstream-raw-id",
			model: "star-a",
			choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
				prompt_tokens_details: { cached_tokens: 4 },
			},
		}));
		const { status, json } = await api("POST", "/v1/chat/completions", {
			key: plaintextKey,
			body: { model: "star-lm", messages: [{ role: "user", content: "hi" }] },
		});
		expect(status).toBe(200);
		expect(json.model).toBe("star-lm");
		expect(json.id).toMatch(/^chatcmpl_/);
		expect(json.usage.total_tokens).toBe(15);
		expect(calledAccounts[calledAccounts.length - 1]).toBe(grokA.id); // A 积分占优，确定性选号
	});

	it("流式对话：SSE 事件 + [DONE]，末帧 usage", async () => {
		streamBehavior.push((_account, send) => {
			send(JSON.stringify({ id: "u1", model: "star-a", choices: [{ index: 0, delta: { content: "你" } }] }));
			send(JSON.stringify({ id: "u1", model: "star-a", choices: [{ index: 0, delta: { content: "好" } }] }));
			send(
				JSON.stringify({
					id: "u1",
					model: "star-a",
					choices: [],
					usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
				}),
			);
			send("[DONE]");
		});
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintextKey}` },
			body: JSON.stringify({ model: "star-lm", messages: [{ role: "user", content: "hi" }], stream: true }),
		});
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const text = await response.text();
		const events = text
			.split("\n\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice(6));
		expect(events[events.length - 1]).toBe("[DONE]");
		const chunks = events.slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(chunks.every((chunk) => chunk.model === "star-lm")).toBe(true); // sanitize
	});

	it("上游失败自动换号：A 冷却后走 B 成功", async () => {
		callBehavior.push(() => {
			throw new UpstreamException("RATE", "Grok HTTP 429", 1);
		});
		callBehavior.push((account) => ({
			id: "ok",
			model: account.id === "acc-a" ? "star-a" : "star-b",
			choices: [{ index: 0, message: { role: "assistant", content: "from-b" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}));
		const { status, json } = await api("POST", "/v1/chat/completions", {
			key: plaintextKey,
			body: { model: "star-lm", messages: [{ role: "user", content: "hi" }] },
		});
		expect(status).toBe(200);
		expect(json.choices[0].message.content).toBe("from-b");
	});

	it("未上架模型 → 404 model_not_found（OpenAI 错误体）", async () => {
		const { status, json } = await api("POST", "/v1/chat/completions", {
			key: plaintextKey,
			body: { model: "no-such", messages: [] },
		});
		expect(status).toBe(404);
		expect(json.error.code).toBe("model_not_found");
	});

	it("能力超限（max_tokens > 路由容量）→ 400 unsupported_capability", async () => {
		const { status, json } = await api("POST", "/v1/chat/completions", {
			key: plaintextKey,
			body: { model: "star-lm", messages: [], max_tokens: 64_000 },
		});
		expect(status).toBe(400);
		expect(json.error.code).toBe("unsupported_capability");
	});

	it("调用日志已落库（OK 与换号路径）", async () => {
		const { json } = await api("GET", "/api/gateway/logs?limit=10");
		const logs = json.data as Array<Record<string, unknown>>;
		expect(logs.length).toBeGreaterThanOrEqual(2);
		const okLogs = logs.filter((log) => log.status === "OK");
		expect(okLogs.length).toBeGreaterThanOrEqual(2); // 非流式 + 流式 + 换号各一条
		expect(okLogs.every((log) => log.usageSource === "KNOWN" && log.accountId !== null)).toBe(true);
		void DEFAULT_OUTPUT;
	});
});

describe("计费挂钩（阶段 5a：成员 Key 预占/结算/402）", () => {
	it("微请求按输入和输出分别向上取整预占，并发结算不会透支 4 分余额", () => {
		const directory = mkdtempSync(join(tmpdir(), "owl-pool-rounding-"));
		const db = openDb(join(directory, "billing.db"));
		try {
			const store = new SqliteBillingStore(db);
			store.adjust("rounding-member", 4);
			store.saveRate({
				model: "tiny-model",
				promptPer1m: 200,
				completionPer1m: 800,
				cacheReadPer1m: 4,
				cacheWritePer1m: 200,
				enabled: true,
			});
			const billing = new BillingService({ store });
			const payload = { messages: [{ role: "user", content: "1234567890123456789012345678901234" }], max_tokens: 1 };
			const first = billing.reserve("rounding-member", "key", "tiny-model", payload);
			expect(first.reserved).toBe(2);
			const second = billing.reserve("rounding-member", "key", "tiny-model", payload);
			expect(second.reserved).toBe(2);
			expect(billing.balance("rounding-member")).toBe(0);
			billing.settle(first.entryId, { promptTokens: 9, completionTokens: 1 }, null);
			billing.settle(second.entryId, { promptTokens: 9, completionTokens: 1 }, null);
			expect(billing.balance("rounding-member")).toBe(0);
			expect(() => billing.reserve("rounding-member", "key", "tiny-model", payload)).toThrow(/余额不足/);
			expect(billing.balance("rounding-member")).toBe(0);
		} finally {
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(["/v1/chat/completions", "/v1/responses"])(
		"%s 将真实余额不足业务错误返回为 402，保留预占和可用金额",
		async (path) => {
			const callsBefore = calledAccounts.length;
			const { status, json } = await api("POST", path, {
				key: lowBalanceKey,
				body: { model: "star-lm", messages: [{ role: "user", content: "hi" }], input: "hi" },
			});
			expect(status).toBe(402);
			expect(json.error.code).toBe("insufficient_balance");
			expect(json.error.type).toBe("insufficient_balance");
			expect(json.error.message).toBe("余额不足：预估 10 分，可用 4 分");
			expect(json.error.request_id).toMatch(/^[a-f0-9]{32}$/);
			expect(calledAccounts).toHaveLength(callsBefore);
		},
	);

	it.each(["/v1/chat/completions", "/v1/responses"])(
		"%s 的 SSE 余额拒绝使用 insufficient_balance，保持具体金额",
		async (path) => {
			const callsBefore = calledAccounts.length;
			const response = await fetch(`${baseUrl}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${lowBalanceKey}` },
				body: JSON.stringify({
					model: "star-lm",
					messages: [{ role: "user", content: "hi" }],
					input: "hi",
					stream: true,
				}),
			});
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const text = await response.text();
			expect(text).toContain('"code":"insufficient_balance"');
			expect(text).toContain("余额不足：预估 10 分，可用 4 分");
			expect(text).not.toContain("网关内部错误");
			expect(text).not.toContain('"code":"upstream_error"');
			expect(calledAccounts).toHaveLength(callsBefore);
		},
	);

	it("成员 Key 余额不足 → 402 insufficient_balance；管理 Key 不扣费", async () => {
		// 现有测试服务未装配 billing → 仅验证管理 Key 不受影响由其余用例覆盖
		// 这里直接用 billing 服务单元验证核心口径
		const { BillingService } = await import("owl-pool");
		const { openDb } = await import("../src/store/db.ts");
		const { SqliteBillingStore } = await import("../src/store/billing-store.ts");
		const dir2 = mkdtempSync(join(tmpdir(), "owl-pool-billing-"));
		const db = openDb(join(dir2, "b.db"));
		const store = new SqliteBillingStore(db);
		store.adjust("m1", 100);
		store.saveRate({
			model: "star-lm",
			promptPer1m: 10_000,
			completionPer1m: 20_000,
			cacheReadPer1m: 1_000,
			cacheWritePer1m: 1_000,
			enabled: true,
		});
		const billing = new BillingService({ store, nowMs: () => now2 });

		// 预占：输入 2 tokens → ceil(2*10000/1e6)=1，输出 2048 → ceil(2048*20000/1e6)=41，共 42 分
		const { entryId, reserved } = billing.reserve("m1", "k1", "star-lm", {
			messages: [{ role: "user", content: "hi" }],
		});
		expect(reserved).toBe(42);
		expect(billing.balance("m1")).toBe(58);

		// 结算：实际 prompt=10/completion=5 → 输入 1、输出 1 → 2 分，退 40
		billing.settle(entryId, { promptTokens: 10, completionTokens: 5 }, null);
		expect(billing.balance("m1")).toBe(98);

		// 超额：余额 98，预占 999999 分 → 402 语义
		expect(() =>
			billing.reserve("m1", "k1", "star-lm", { messages: [{ role: "user", content: "x".repeat(400_000_000) }] }),
		).toThrowError(/余额不足/);

		// 失败退还
		const r2 = billing.reserve("m1", "k1", "star-lm", { messages: [{ role: "user", content: "hi" }] });
		billing.voidPending(r2.entryId);
		expect(billing.balance("m1")).toBe(98); // 预占 42 → 退 42

		// 未知用量 → REVIEW
		const r3 = billing.reserve("m1", "k1", "star-lm", { messages: [{ role: "user", content: "hi" }] });
		billing.settle(r3.entryId, null, null);
		const entry = store.getLedger(r3.entryId);
		expect(entry?.status).toBe("REVIEW");

		// Legacy/unlinked PENDING cannot prove no upstream billing; reconcile to REVIEW without credit.
		billing.reserve("m1", "k1", "star-lm", { messages: [{ role: "user", content: "hi" }] });
		expect(billing.balance("m1")).toBe(14); // r3 与 r4 各预占 42
		now2 = 1_700_000_000_000 + 16 * 60_000;
		expect(billing.sweepStale()).toBe(1); // 只扫 r4（PENDING），r3（REVIEW）不动
		expect(billing.balance("m1")).toBe(14);
		db.close();
		setTimeout(() => {
			try {
				rmSync(dir2, { recursive: true, force: true });
			} catch {
				// Windows 句柄延迟
			}
		}, 200);
	});
});
