import {
	type Account,
	AccountPoolRouter,
	type AccountStore,
	type ApiKey,
	ApiKeyService,
	type ApiKeyStore,
	applyEffortPolicy,
	cooldownMillis,
	type DiscoveredCapacity,
	FixedWindowRateLimiter,
	InMemoryAccountStore,
	ipAllowed,
	MemoryGatewayState,
	ModelAccessException,
	type ModelRoute,
	type Platform,
	type PublishedModel,
	parseEffortPolicy,
	resolveModel,
} from "owl-pool";
import { describe, expect, it } from "vitest";

let now = 1_700_000_000_000;
const tick = (): number => now;

const plaintextById = new Map<string, string>();

function findPlaintext(_store: { map: Map<string, ApiKey> }, key: ApiKey): string | undefined {
	return plaintextById.get(key.id);
}

function memKeyStore(): ApiKeyStore & { map: Map<string, ApiKey> } {
	const map = new Map<string, ApiKey>();
	return {
		map,
		findByHash: (hash) => [...map.values()].find((key) => key.keyHash === hash),
		findById: (id) => map.get(id),
		list: () => [...map.values()],
		save: (key) => map.set(key.id, key),
		delete: (id) => map.delete(id),
	};
}

describe("ApiKeyService", () => {
	it("创建 → 明文只出现一次；哈希鉴权可用", () => {
		const service = new ApiKeyService({ store: memKeyStore(), nowMs: tick });
		const created = service.create({ name: "桌面端" });
		expect(created.plaintext).toMatch(/^sk-[a-zA-Z0-9]{32}$/);
		expect(created.key.keyPrefix).toBe(created.plaintext.slice(0, 11));
		expect(created.key.keySuffix).toBe(created.plaintext.slice(-4));

		const authed = service.authenticate(created.plaintext);
		expect(authed?.id).toBe(created.key.id);
		expect(service.authenticate("sk-wrong")).toBeNull();
		expect(service.authenticate(created.plaintext + "x")).toBeNull();
	});

	it("吊销/停用/过期 三态", () => {
		const store = memKeyStore();
		const service = new ApiKeyService({ store, nowMs: tick });
		const created0 = service.create({ name: "k" });
		plaintextById.set(created0.key.id, created0.plaintext);
		const key = created0.key;

		service.update(key.id, { enabled: false });
		expect(service.authenticate(findPlaintext(store, key))).toBeNull(); // 停用失效
		service.update(key.id, { enabled: true });
		expect(service.authenticate(findPlaintext(store, key))).not.toBeNull();

		service.revoke(key.id);
		expect(service.authenticate(findPlaintext(store, key))).toBeNull(); // 吊销失效
		service.update(key.id, { enabled: true }); // 显式恢复清吊销
		expect(service.authenticate(findPlaintext(store, key))).not.toBeNull();

		service.update(key.id, { expiresAt: now - 1 });
		expect(service.authenticate(findPlaintext(store, key))).toBeNull(); // 过期失效
	});

	it("成员子 Key 继承根 Key 的策略合并（模型交集/IP 交集/限流下限）", () => {
		const store = memKeyStore();
		const service = new ApiKeyService({ store, nowMs: tick });
		const root = service.create({
			name: "root",
			ownerMemberId: "m1",
			allowedModels: ["gpt-a", "gpt-b"],
			allowedIps: "10.0.0.0/24",
			rateLimitPerMinute: 100,
		});
		plaintextById.set(root.key.id, root.plaintext);
		const child = service.create({
			name: "child",
			ownerMemberId: "m1",
			parentKeyId: root.key.id,
			allowedModels: ["gpt-b", "gpt-c"],
			allowedIps: "10.0.0.7",
			rateLimitPerMinute: 30,
		});
		plaintextById.set(child.key.id, child.plaintext);
		const effective = service.authenticate(findPlaintext(store, child.key));
		expect(effective?.allowedModels).toEqual(["gpt-b"]);
		expect(effective?.allowedIps).toBe("10.0.0.7"); // /32 ∩ /24 = /32，保留子集原文（Java 同语义）
		expect(effective?.rateLimitPerMinute).toBe(30);
		// 归属不一致的根 → 无效
		const stranger = service.create({ name: "s", ownerMemberId: "m2", parentKeyId: root.key.id });
		plaintextById.set(stranger.key.id, stranger.plaintext);
		expect(service.authenticate(findPlaintext(store, stranger.key))).toBeNull();
	});

	it("来源 IP 校验：非法规则入口即拒", () => {
		const store = memKeyStore();
		const service = new ApiKeyService({ store, nowMs: tick });
		expect(() => service.create({ name: "x", allowedIps: "not-an-ip" })).toThrow(/来源限制/);
		expect(() => service.create({ name: "x", allowedModels: ["bad/model"] })).toThrow(/公开模型标识/);
	});
});

describe("KeyIpPolicy / EffortPolicy / 限流", () => {
	it("IP 规则：字面量、CIDR、通配、deny-all", () => {
		expect(ipAllowed(null, "1.2.3.4")).toBe(true);
		expect(ipAllowed("10.0.0.7", "10.0.0.7")).toBe(true);
		expect(ipAllowed("10.0.0.0/24", "10.0.0.99")).toBe(true);
		expect(ipAllowed("10.0.0.0/24", "10.0.1.1")).toBe(false);
		expect(ipAllowed("*", "8.8.8.8")).toBe(true);
		expect(ipAllowed("!deny-all", "127.0.0.1")).toBe(false);
	});

	it("思考策略：映射 → 天花板降档 → 超限拒绝", () => {
		const policy = parseEffortPolicy(
			JSON.stringify({ maxEffort: "high", overLimit: "downgrade", mappings: [{ from: "xhigh", to: "low" }] }),
		);
		expect(applyEffortPolicy(policy, "xhigh", "m")?.effort).toBe("low"); // 命中映射
		expect(applyEffortPolicy(policy, "ultra", "m")?.effort).toBe("high"); // 天花板降档
		expect(applyEffortPolicy(policy, "medium", "m")?.effort).toBe("medium"); // 不动
		const deny = parseEffortPolicy(JSON.stringify({ maxEffort: "low", overLimit: "deny" }));
		expect(applyEffortPolicy(deny, "high", "m")?.denied).toBe(true);
		// 未知档位透传
		expect(applyEffortPolicy(policy, "megahigh", "m")?.effort).toBe("megahigh");
		// 非法配置入口即拒
		expect(() => parseEffortPolicy(JSON.stringify({ maxEffort: "nope" }))).toThrow(/已知档位/);
	});

	it("固定窗口限流：窗口推进清零", () => {
		const limiter = new FixedWindowRateLimiter(2);
		expect(limiter.tryAcquire(1000)).toBe(true);
		expect(limiter.tryAcquire(1001)).toBe(true);
		expect(limiter.tryAcquire(1002)).toBe(false);
		expect(limiter.tryAcquire(61_000)).toBe(true); // 新窗口
	});
});

describe("模型解析 resolveModel", () => {
	function catalog(overrides?: {
		routes?: ModelRoute[];
		capacity?: DiscoveredCapacity;
		model?: Partial<PublishedModel>;
	}): {
		findPublishedByPublicId(publicId: string): PublishedModel | undefined;
		routesOf(modelId: string): ModelRoute[];
		findCapacity(platform: Platform, upstreamModel: string): DiscoveredCapacity | undefined;
	} {
		const model: PublishedModel = {
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
			...overrides?.model,
		};
		const routes: ModelRoute[] = overrides?.routes ?? [
			{
				id: "r1",
				modelId: "m1",
				platform: "GROK",
				upstreamModel: "star-a",
				priority: 0,
				enabled: true,
				supportsImages: false,
				supportsTools: true,
				reasoningEfforts: ["low", "medium", "high"],
			},
			{
				id: "r2",
				modelId: "m1",
				platform: "ZCODE",
				upstreamModel: "star-b",
				priority: 1,
				enabled: true,
				supportsImages: false,
				supportsTools: true,
				reasoningEfforts: ["low", "medium", "high"],
			},
		];
		const capacities: DiscoveredCapacity[] =
			overrides?.capacity === undefined
				? [
						{
							platform: "GROK",
							upstreamModel: "star-a",
							available: true,
							contextWindow: 128_000,
							maxOutputTokens: 16_000,
						},
						{
							platform: "ZCODE",
							upstreamModel: "star-b",
							available: true,
							contextWindow: 128_000,
							maxOutputTokens: 16_000,
						},
					]
				: [overrides.capacity];
		return {
			findPublishedByPublicId: (publicId) => (publicId === model.publicId ? model : undefined),
			routesOf: () => routes,
			findCapacity: (platform, upstreamModel) =>
				capacities.find((item) => item.platform === platform && item.upstreamModel === upstreamModel),
		};
	}

	function adminKey(overrides?: Partial<ApiKey>): ApiKey {
		return {
			id: "k1",
			name: "k",
			keyPrefix: "sk_x",
			keySuffix: null,
			keyHash: "h",
			ownerMemberId: null,
			parentKeyId: null,
			revokedAt: null,
			boundPlatform: null,
			allowedModels: null,
			effortPolicy: null,
			allowedIps: null,
			rateLimitPerMinute: null,
			enabled: true,
			createdAt: 0,
			expiresAt: null,
			...overrides,
		};
	}

	it("按优先级出路由；档位写入解析结果", () => {
		const resolved = resolveModel(
			adminKey(),
			"star-lm",
			{ messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
			catalog(),
		);
		expect(resolved.routes.map((route) => route.platform)).toEqual(["GROK", "ZCODE"]);
		expect(resolved.effectiveReasoningEffort).toBe("high");
	});

	it("未上架 → 404 model_not_found；Key 模型清单外 → 403", () => {
		expect(() => resolveModel(adminKey(), "nope", {}, catalog())).toThrowError(ModelAccessException);
		try {
			resolveModel(adminKey({ allowedModels: ["other"] }), "star-lm", {}, catalog());
			throw new Error("should throw");
		} catch (error) {
			expect((error as ModelAccessException).code).toBe("model_not_allowed");
		}
	});

	it("输出上限超路由容量：strict 与 compatible 都是 unsupported（对齐 Java：base 全淘汰）", () => {
		// r1 容量 16k，请求 20k → strict 直接 unsupported
		expect(() => resolveModel(adminKey(), "star-lm", { messages: [], max_tokens: 20_000 }, catalog())).toThrowError(
			ModelAccessException,
		);
		// compatible：r1 被淘汰，r2 无容量记录也淘汰；enabled 非空而 base 为空 → unsupported
		try {
			resolveModel(
				adminKey(),
				"star-lm",
				{ messages: [], max_tokens: 20_000, capability_mode: "compatible" },
				catalog(),
			);
			throw new Error("should throw");
		} catch (error) {
			expect((error as ModelAccessException).code).toBe("unsupported_capability");
		}
	});

	it("输入文本 + 输出预留装不进窗口 → 路由淘汰（对齐 Java：unsupported）", () => {
		const longText = "x".repeat(127_000 * 4); // ≈127k tokens，容量 128k，预留 2048 装不下
		try {
			resolveModel(adminKey(), "star-lm", { messages: [{ role: "user", content: longText }] }, catalog());
			throw new Error("should throw");
		} catch (error) {
			expect((error as ModelAccessException).code).toBe("unsupported_capability");
		}
	});
});

describe("AccountPoolRouter", () => {
	const idByAlias = new Map<string, string>();
	const alias = (id: string): string => idByAlias.get(id) ?? id;
	function account(id: string, credits: number | null, enabled = true): Account {
		return {
			id,
			name: id,
			platform: "GROK",
			credentials: { apiKey: "k" },
			enabled,
			createdAt: 0,
			updatedAt: 0,
			credits,
		};
	}

	function routerStore(accounts: Account[]): { store: AccountStore; router: AccountPoolRouter } {
		const store = new InMemoryAccountStore();
		for (const item of accounts) {
			// create 生成自己的 id；按返回值登记，测试里用原 id 断言前先映射
			const created = store.create(
				{ name: item.name, platform: item.platform, credentials: item.credentials, enabled: item.enabled },
				now,
			);
			store.patchState(created.id, { credits: item.credits });
			idByAlias.set(item.id, created.id);
		}
		const state = new MemoryGatewayState();
		const router = new AccountPoolRouter({
			accounts: store,
			accountCooldownMs: 60_000,
			cooldownState: state,
			nowMs: tick,
		});
		return { store, router };
	}

	it("积分加权：负积分账号在池内有正积分时被跳过", () => {
		const { router } = routerStore([account("a", 5), account("b", -1)]);
		for (let i = 0; i < 20; i++) {
			const picked = router.pick("GROK");
			expect(picked?.id).toBe(alias("a"));
		}
	});

	it("失败冷却：分级 + 落库 + 过期恢复（注入时钟）", () => {
		const { store, router } = routerStore([account("a", null)]);
		expect(cooldownMillis("连接被拒 ECONNREFUSED", 60_000)).toBe(5_000);
		expect(cooldownMillis("401", 60_000)).toBe(600_000);
		expect(cooldownMillis("额度耗尽", 60_000)).toBe(12 * 3_600_000);

		router.markFailure(alias("a"), "429");
		expect(router.isCooling(alias("a"))).toBe(true);
		expect(store.get(alias("a"))?.cooldownUntil).not.toBeNull();

		now += 60_000 + 1;
		expect(router.isCooling(alias("a"))).toBe(false);
		expect(router.pick("GROK")?.id).toBe(alias("a"));
	});
});
