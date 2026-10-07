/**
 * 成员空间 API —— 移植自 manager 成员登录、自建 Key、预算和模拟调用。
 * 模拟调用走真实网关（计费、日志与 /v1 同一条链路），只是由网页代发。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import {
	type ApiKey,
	type ApiKeyService,
	BusinessError,
	GatewayFault,
	ipAllowed,
	type PublishedModel,
	resolveEffectiveKey,
	UpstreamException,
} from "owl-pool";
import { resolveClientIp } from "../security/client-ip.ts";
import { MEMBER_COOKIE, MemberAuthService, normalizeUsername } from "../security/member-auth.ts";
import type { SqliteBillingStore } from "../store/billing-store.ts";
import type { GatewayCallLogRecord, SqliteCallLogStore, SqliteCatalogStore } from "../store/gateway-stores.ts";
import { memberBudgetView, saveMemberBudget } from "../store/key-budget.ts";
import { type MemberRecord, SqliteMemberStore } from "../store/member-store.ts";
import { readCookie, writeSessionCookie } from "./cookies.ts";
import {
	createMemberKey,
	revokeMemberKey,
	rotateMemberKey,
	updateMemberKey,
	usableMemberKey,
} from "./member-self-keys.ts";
import { jsonRespond } from "./respond.ts";
import type { RequestContext, Router } from "./router.ts";

const MAX_KEYS = 20;

export interface MemberRoutesDeps {
	db: DatabaseSync;
	keys: ApiKeyService;
	catalog: SqliteCatalogStore;
	billingStore?: SqliteBillingStore;
	callLogs?: SqliteCallLogStore;
	dataDir: string;
	trustedProxyCount: number;
	/** 用成员 Key 走真实网关。缺省时模拟调用返回未启用。 */
	completeChat?(
		auth: { key: ApiKey; requestId: string; clientIp: string },
		payload: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	tryRateLimit?(bucket: string, perMinute: number): boolean;
	concurrency?: {
		view(memberId: string): { configured: number | null; effective: number; active: number; waiting: number };
		update(
			memberId: string,
			limit: number | null,
		): { configured: number | null; effective: number; active: number; waiting: number };
	};
}

export function registerMemberRoutes(router: Router, deps: MemberRoutesDeps): void {
	const store = new SqliteMemberStore(deps.db);
	const auth = new MemberAuthService({
		members: store,
		sessionFile: `${deps.dataDir}/member-sessions.json`,
		failureFile: `${deps.dataDir}/member-login-failures.json`,
	});
	const clientIpOf = (request: IncomingMessage) => resolveClientIp(request, deps.trustedProxyCount);
	const secureOf = (request: IncomingMessage) =>
		String(request.headers["x-forwarded-proto"] ?? "").toLowerCase() === "https";

	const requireMember = (ctx: RequestContext): MemberRecord | undefined => {
		const session = auth.authenticate(readCookie(ctx.request, MEMBER_COOKIE));
		const member = session === null ? undefined : store.findById(session.memberId);
		if (member === undefined || !member.enabled) {
			jsonRespond(ctx.response, 401, {
				ok: false,
				error: "登录已失效，请重新登录",
				code: "member.unauthenticated",
			});
			return undefined;
		}
		return member;
	};

	router.get("/api/member/session", async (ctx) => {
		const session = auth.authenticate(readCookie(ctx.request, MEMBER_COOKIE));
		const member = session === null ? undefined : store.findById(session.memberId);
		if (session === null || member === undefined || !member.enabled) {
			return { enabled: true, authenticated: false };
		}
		return sessionBody(member, session.expiresAt);
	});

	router.post("/api/member/login", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		const username = typeof body.username === "string" ? body.username : "";
		const password = typeof body.password === "string" ? body.password : "";
		if (username.trim().length === 0 || password.length === 0) {
			fail(ctx.response, 200, "member.credentialsRequired", "请填写成员账号与密码");
			return;
		}
		const issued = auth.login(username, password, clientIpOf(ctx.request));
		if (issued === null) {
			fail(ctx.response, 401, "member.loginFailed", "成员账号或密码错误，账号可能已停用或被临时锁定");
			return;
		}
		writeSessionCookie(ctx.response, MEMBER_COOKIE, issued.token, auth.ttlSeconds(), secureOf(ctx.request));
		return sessionBody(issued.member, issued.session.expiresAt);
	});

	router.post("/api/member/logout", async (ctx) => {
		auth.logout(readCookie(ctx.request, MEMBER_COOKIE));
		writeSessionCookie(ctx.response, MEMBER_COOKIE, "", 0, secureOf(ctx.request));
		return { authenticated: false };
	});

	router.get("/api/member/overview", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		const owned = ownedKeys(deps.keys, member.id);
		const key = preferredKey(owned);
		const today = shanghaiDayRange(shanghaiToday());
		const logs =
			deps.callLogs?.forKeys(
				owned.map((item) => item.id),
				today.from,
				today.to,
				200,
			) ?? [];
		return {
			member: { username: member.username, displayName: member.displayName },
			key: key === undefined ? null : portalKeyRow(key),
			wallet: walletView(deps.billingStore, member.id),
			today: summarize(logs),
			range: {
				from: new Date(today.from).toISOString(),
				to: new Date(today.to).toISOString(),
				day: shanghaiToday(),
			},
			recent: logs.slice(0, 5).map(safeLog),
			lowBalanceThreshold: "10",
		};
	});

	router.get("/api/member/keys", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		const owned = ownedKeys(deps.keys, member.id);
		const lookup = keyLookup(deps.keys.list());
		const now = Date.now();
		const root = owned.find((key) => key.parentKeyId === null && resolveEffectiveKey(key, lookup, now) !== null);
		return {
			items: owned.map((key) => memberKeyView(key, lookup, now)),
			maxKeys: MAX_KEYS,
			rootKeyId: root?.id ?? null,
		};
	});

	router.get("/api/member/key", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		const key = preferredKey(ownedKeys(deps.keys, member.id));
		if (key === undefined) {
			fail(ctx.response, 404, "member.noApiKey", "暂无可用 Key，请联系管理员");
			return;
		}
		return { ...portalKeyRow(key), wallet: walletView(deps.billingStore, member.id) };
	});

	router.get("/api/member/models", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		return modelsBody(deps, preferredKey(ownedKeys(deps.keys, member.id)));
	});

	router.get("/api/member/trend", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		const days = clampDays(ctx.query.get("days"));
		const today = shanghaiToday();
		const ownedIds = ownedKeys(deps.keys, member.id).map((key) => key.id);
		const points = [];
		for (let offset = days - 1; offset >= 0; offset--) {
			const day = shiftShanghaiDay(today, -offset);
			const range = shanghaiDayRange(day);
			const logs = deps.callLogs?.forKeys(ownedIds, range.from, range.to, 500) ?? [];
			const summary = summarize(logs);
			points.push({
				date: day,
				calls: summary.calls,
				fails: summary.fails,
				totalTokens: summary.totalTokens,
			});
		}
		return { days, zoneId: "Asia/Shanghai", points };
	});

	router.get("/api/member/concurrency", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		if (deps.concurrency !== undefined) {
			const view = deps.concurrency.view(member.id);
			return { configured: view.configured, effective: view.effective, active: view.active, waiting: view.waiting };
		}
		return { effective: member.maxConcurrentRequests ?? 0, active: 0, waiting: 0 };
	});

	router.get("/api/member/billing", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		const ledger = (deps.billingStore?.recentLedger(100) ?? [])
			.filter((entry) => entry.memberId === member.id)
			.slice(0, 20)
			.map(ledgerView);
		return {
			wallet: walletView(deps.billingStore, member.id),
			status: { enabled: true, currency: "CNY", rateUnit: "PER_1M_TOKENS" },
			rates: (deps.billingStore?.listRates() ?? []).filter((rate) => rate.enabled).map(rateYuan),
			ledger,
			ledgerHasMore: false,
		};
	});

	router.get("/api/member/billing/ledger", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		const entries = (deps.billingStore?.recentLedger(100) ?? [])
			.filter((entry) => entry.memberId === member.id)
			.slice(0, 20)
			.map(ledgerView);
		return { entries, hasMore: false, nextBefore: null, nextLastId: null };
	});

	router.get("/api/member/connect", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		const models = modelsBody(deps, preferredKey(ownedKeys(deps.keys, member.id)));
		const origin = originOf(ctx.request);
		return {
			models: models.models,
			recommendedModel: models.models[0]?.publicId ?? "",
			openAiBaseUrl: `${origin}/v1`,
			anthropicBaseUrl: origin,
		};
	});

	router.get("/api/member/usage", async (ctx) => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		const day = ctx.query.get("date") || shanghaiToday();
		const range = shanghaiDayRange(day);
		const page = Math.max(0, Number.parseInt(ctx.query.get("page") ?? "0", 10) || 0);
		const size = Math.max(1, Math.min(100, Number.parseInt(ctx.query.get("limit") ?? "50", 10) || 50));
		const status = normalizeStatus(ctx.query.get("status"));
		const keyId = ctx.query.get("keyId");
		const owned = ownedKeys(deps.keys, member.id);
		const selected = keyId === null || keyId.length === 0 ? owned : owned.filter((key) => key.id === keyId);
		const logs =
			deps.callLogs?.forKeys(
				selected.map((key) => key.id),
				range.from,
				range.to,
				500,
			) ?? [];
		const filtered = logs.filter((log) => matchesStatus(log.status, status));
		const start = page * size;
		const items = filtered.slice(start, start + size).map(safeLog);
		const totalItems = filtered.length;
		const totalPages = Math.max(1, Math.ceil(totalItems / size));
		return {
			summary: summarize(filtered),
			keyId: keyId ?? null,
			items,
			range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), day },
			pagination: {
				page,
				size,
				totalItems,
				totalPages,
				hasPrevious: page > 0,
				hasNext: start + size < totalItems,
				status,
			},
		};
	});

	const keyDeps = { keys: deps.keys, catalog: deps.catalog };
	const guardMember = (ctx: RequestContext, run: (member: MemberRecord) => Promise<unknown> | unknown) => async () => {
		const member = requireMember(ctx);
		if (member === undefined) {
			return;
		}
		try {
			return await run(member);
		} catch (error) {
			if (!writeMemberError(ctx.response, error)) {
				throw error;
			}
		}
	};

	router.post("/api/member/keys", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		return guardMember(ctx, (member) => {
			const created = createMemberKey(keyDeps, member, body ?? {});
			const lookup = keyLookup(deps.keys.list());
			return { key: memberKeyView(created.key, lookup, Date.now()), plaintext: created.plaintext };
		})();
	});

	router.patch("/api/member/keys/:id", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		return guardMember(ctx, (member) => {
			const updated = updateMemberKey(keyDeps, member, ctx.params.id ?? "", body ?? {});
			return memberKeyView(updated, keyLookup(deps.keys.list()), Date.now());
		})();
	});

	router.post("/api/member/keys/:id/rotate", async (ctx) =>
		guardMember(ctx, (member) => {
			const rotated = rotateMemberKey(keyDeps, member, ctx.params.id ?? "");
			return {
				key: memberKeyView(rotated.key, keyLookup(deps.keys.list()), Date.now()),
				plaintext: rotated.plaintext,
			};
		})(),
	);

	router.delete("/api/member/keys/:id", async (ctx) =>
		guardMember(ctx, (member) => {
			revokeMemberKey(keyDeps, member, ctx.params.id ?? "");
			return null;
		})(),
	);

	router.get("/api/member/keys/:id/budget", async (ctx) =>
		guardMember(ctx, (member) => {
			const target = budgetTarget(deps.keys, member.id, ctx.params.id ?? "");
			return memberBudgetView(
				deps.db,
				member.id,
				target.key,
				target.root,
				deps.billingStore?.getWallet(member.id) !== undefined,
			);
		})(),
	);

	router.put("/api/member/keys/:id/budget", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		return guardMember(ctx, (member) => {
			const target = budgetTarget(deps.keys, member.id, ctx.params.id ?? "");
			return saveMemberBudget(
				deps.db,
				member.id,
				target.key,
				target.root,
				deps.billingStore?.getWallet(member.id) !== undefined,
				{
					total: amountField(body.total),
					daily: amountField(body.daily),
					weekly: amountField(body.weekly),
				},
			);
		})();
	});

	router.post("/api/member/playground", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		return guardMember(ctx, async (member) => playground(deps, ctx, member, body ?? {}))();
	});

	router.post("/api/members", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		try {
			return provisionMember(deps, store, auth, body ?? {});
		} catch (error) {
			if (!writeMemberError(ctx.response, error)) {
				throw error;
			}
		}
	});

	router.patch("/api/members/:id", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		try {
			return updateAdminMember(deps, store, auth, ctx.params.id ?? "", body ?? {});
		} catch (error) {
			if (!writeMemberError(ctx.response, error)) {
				throw error;
			}
		}
	});

	router.get("/api/members/:id/concurrency", async (ctx) => {
		if (deps.concurrency === undefined) {
			throw BusinessError.of("member.concurrencyUnavailable", "成员并发尚未接入");
		}
		return deps.concurrency.view(ctx.params.id ?? "");
	});

	router.put("/api/members/:id/concurrency", async (ctx) => {
		if (deps.concurrency === undefined) {
			throw BusinessError.of("member.concurrencyUnavailable", "成员并发尚未接入");
		}
		const body = await ctx.readBody<Record<string, unknown>>();
		const raw = body.maxConcurrentRequests;
		const limit = raw === null || raw === undefined || raw === "" ? null : Number(raw);
		return deps.concurrency.update(ctx.params.id ?? "", limit);
	});

	router.delete("/api/members/:id", async (ctx) => {
		try {
			deleteAdminMember(deps, store, auth, ctx.params.id ?? "");
			return null;
		} catch (error) {
			if (!writeMemberError(ctx.response, error)) {
				throw error;
			}
		}
	});

	router.post("/api/members/:id/rotate-key", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		try {
			return rotateAdminRoot(deps, store, auth, ctx.params.id ?? "", body ?? {});
		} catch (error) {
			if (!writeMemberError(ctx.response, error)) {
				throw error;
			}
		}
	});
}

function provisionMember(
	deps: MemberRoutesDeps,
	store: SqliteMemberStore,
	auth: MemberAuthService,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const username = normalizeUsername(typeof body.username === "string" ? body.username : null);
	if (username === null) {
		throw BusinessError.of("member.usernameFormat", "成员账号需为 3-64 位字母、数字、点、短横线或下划线");
	}
	if (store.findByUsername(username) !== undefined) {
		throw BusinessError.of("member.usernameTaken", "成员账号已存在");
	}
	const displayName = requireDisplayName(body.displayName);
	const now = Date.now();
	const draft: MemberRecord = {
		id: randomUUID(),
		username,
		displayName,
		passwordSalt: "",
		passwordHash: "",
		enabled: body.enabled !== false,
		maxConcurrentRequests: null,
		createdAt: now,
		updatedAt: now,
	};
	store.save(draft);
	let saved: MemberRecord;
	try {
		saved = auth.setPassword(draft, typeof body.password === "string" ? body.password : "");
	} catch (error) {
		store.delete(draft.id);
		throw error;
	}
	const created = deps.keys.create({
		name: blankToNull(body.keyName) ?? `${displayName} 的 Key`,
		ownerMemberId: saved.id,
		boundPlatform: blankToNull(body.boundPlatform),
		allowedIps: blankToNull(body.allowedIps),
		rateLimitPerMinute: positiveIntOrNull(body.rateLimitPerMinute),
		expiresAt: isoToMillis(body.expiresAt),
	});
	return { member: adminMemberRow(saved, deps.keys), key: adminKeyView(created.key), plaintext: created.plaintext };
}

function updateAdminMember(
	deps: MemberRoutesDeps,
	store: SqliteMemberStore,
	auth: MemberAuthService,
	memberId: string,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const existing = store.findById(memberId);
	if (existing === undefined) {
		throw BusinessError.of("member.notFound", "成员不存在");
	}
	let next = existing;
	let invalidate = false;
	if (body.displayName !== undefined && body.displayName !== null) {
		next = { ...next, displayName: requireDisplayName(body.displayName), updatedAt: Date.now() };
		store.save(next);
	}
	if (typeof body.password === "string" && body.password.trim().length > 0) {
		next = auth.setPassword(next, body.password);
		invalidate = true;
	}
	if (typeof body.enabled === "boolean" && body.enabled !== next.enabled) {
		next = { ...next, enabled: body.enabled, updatedAt: Date.now() };
		store.save(next);
		invalidate = true;
	}
	if (invalidate) {
		auth.invalidateMember(memberId);
	}
	return adminMemberRow(next, deps.keys);
}

function deleteAdminMember(
	deps: MemberRoutesDeps,
	store: SqliteMemberStore,
	auth: MemberAuthService,
	memberId: string,
): void {
	if (store.findById(memberId) === undefined) {
		throw BusinessError.of("member.notFound", "成员不存在");
	}
	deps.db
		.prepare("DELETE FROM key_budgets WHERE key_id IN (SELECT id FROM api_keys WHERE owner_member_id = ?)")
		.run(memberId);
	deps.db.prepare("DELETE FROM api_keys WHERE owner_member_id = ?").run(memberId);
	auth.invalidateMember(memberId);
	store.delete(memberId);
}

function rotateAdminRoot(
	deps: MemberRoutesDeps,
	store: SqliteMemberStore,
	auth: MemberAuthService,
	memberId: string,
	body: Record<string, unknown>,
): Record<string, unknown> {
	void auth;
	const member = store.findById(memberId);
	if (member === undefined) {
		throw BusinessError.of("member.notFound", "成员不存在");
	}
	if (!member.enabled) {
		throw BusinessError.of("member.disabled", "成员已停用，请先恢复成员账号再轮换 Key");
	}
	const owned = deps.keys.list().filter((key) => key.ownerMemberId === memberId);
	const root = owned.find((key) => key.parentKeyId === null);
	if (root === undefined) {
		const created = deps.keys.create({
			name: blankToNull(body.keyName) ?? `${member.displayName} 的 Key`,
			ownerMemberId: memberId,
			boundPlatform: blankToNull(body.boundPlatform),
			allowedIps: blankToNull(body.allowedIps),
			rateLimitPerMinute: positiveIntOrNull(body.rateLimitPerMinute),
			expiresAt: isoToMillis(body.expiresAt),
		});
		return { key: adminKeyView(created.key), plaintext: created.plaintext };
	}
	for (const key of owned) {
		if (key.id !== root.id && key.revokedAt === null) {
			deps.keys.revoke(key.id);
		}
	}
	deps.keys.update(root.id, {
		name: body.keyName === undefined || body.keyName === null ? undefined : (blankToNull(body.keyName) ?? root.name),
		boundPlatform:
			body.boundPlatform === undefined || body.boundPlatform === null ? undefined : blankToNull(body.boundPlatform),
		allowedIps: body.allowedIps === undefined || body.allowedIps === null ? undefined : blankToNull(body.allowedIps),
		rateLimitPerMinute:
			body.rateLimitPerMinute === undefined || body.rateLimitPerMinute === null
				? undefined
				: positiveIntOrNull(body.rateLimitPerMinute),
		expiresAt: body.expiresAt === undefined || body.expiresAt === null ? undefined : isoToMillis(body.expiresAt),
		enabled: true,
	});
	const rotated = deps.keys.rotateCredential(root.id);
	return { key: adminKeyView(rotated.key), plaintext: rotated.plaintext };
}

function adminMemberRow(member: MemberRecord, keys: ApiKeyService): Record<string, unknown> {
	const owned = keys.list().filter((key) => key.ownerMemberId === member.id);
	const root = owned.find((key) => key.parentKeyId === null) ?? owned[0];
	return {
		id: member.id,
		username: member.username,
		displayName: member.displayName,
		enabled: member.enabled,
		maxConcurrentRequests: member.maxConcurrentRequests,
		createdAt: new Date(member.createdAt).toISOString(),
		updatedAt: new Date(member.updatedAt).toISOString(),
		key: root === undefined ? null : adminKeyView(root),
	};
}

function requireDisplayName(value: unknown): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (text.length < 1 || text.length > 64) {
		throw BusinessError.of("member.displayNameFormat", "成员名称需为 1-64 个字符");
	}
	return text;
}

function blankToNull(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const text = value.trim();
	return text.length === 0 ? null : text;
}

function positiveIntOrNull(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return null;
	}
	return value;
}

function isoToMillis(value: unknown): number | null {
	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

/** 管理台成员列表：不带口令，附一把根 Key 的展示信息。 */
export function listAdminMembers(store: SqliteMemberStore, keys: ApiKeyService): unknown[] {
	return store.list().map((member) => adminMemberRow(member, keys));
}

function sessionBody(member: MemberRecord, expiresAt: number): Record<string, unknown> {
	return {
		enabled: true,
		authenticated: true,
		username: member.username,
		displayName: member.displayName,
		expiresAt: new Date(expiresAt).toISOString(),
	};
}

function fail(response: ServerResponse, status: number, code: string, error: string): void {
	jsonRespond(response, status, { ok: false, error, code });
}

function writeMemberError(response: ServerResponse, error: unknown): boolean {
	if (error instanceof GatewayFault) {
		fail(response, error.status, error.code, error.message);
		return true;
	}
	if (error instanceof BusinessError) {
		const status =
			error.code === "billing.usageInsufficientBalance" || error.code === "key_budget_exceeded"
				? 402
				: error.code.endsWith("notFound")
					? 404
					: 400;
		fail(response, status, error.code, error.message);
		return true;
	}
	if (error instanceof UpstreamException) {
		fail(response, 502, "playground.failed", error.message);
		return true;
	}
	return false;
}

function budgetTarget(keys: ApiKeyService, memberId: string, keyId: string): { key: ApiKey; root: ApiKey } {
	const owned = keys.list().filter((key) => key.ownerMemberId === memberId);
	const key = owned.find((item) => item.id === keyId);
	if (key === undefined) {
		throw BusinessError.of("member.keyNotFound", "Key 不存在");
	}
	const root = key.parentKeyId === null ? key : owned.find((item) => item.id === key.parentKeyId);
	if (root === undefined || root.parentKeyId !== null) {
		throw BusinessError.of("member.keyRootUnavailable", "当前授权 Key 不可用，请联系管理员");
	}
	return { key, root };
}

function amountField(value: unknown): string | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	return typeof value === "string" ? value.trim() : null;
}

async function playground(
	deps: MemberRoutesDeps,
	ctx: RequestContext,
	member: MemberRecord,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const payload = playgroundPayload(body);
	const requested = typeof body.keyId === "string" ? body.keyId : null;
	const key = usableMemberKey(deps.keys, member.id, requested);
	const stored = deps.keys.list().find((item) => item.id === key.id) ?? key;
	const clientIp = resolveClientIp(ctx.request, deps.trustedProxyCount);
	if (!ipAllowed(key.allowedIps, clientIp)) {
		throw new GatewayFault(403, "ip_not_allowed", "来源 IP 不在该 Key 的允许范围内");
	}
	if (hitRateLimit(deps, stored.id, stored.rateLimitPerMinute)) {
		throw new GatewayFault(429, "rate_limit_exceeded", "该 Key 已触发每分钟请求限制");
	}
	if (stored.parentKeyId !== null) {
		const parent = deps.keys.list().find((item) => item.id === stored.parentKeyId);
		if (parent !== undefined && hitRateLimit(deps, parent.id, parent.rateLimitPerMinute)) {
			throw new GatewayFault(429, "rate_limit_exceeded", "当前授权范围已触发每分钟请求限制");
		}
	}
	if (deps.completeChat === undefined) {
		throw new GatewayFault(503, "gateway_disabled", "API 网关未启用");
	}
	const requestId = randomUUID().replaceAll("-", "");
	const started = Date.now();
	const result = await deps.completeChat({ key, requestId, clientIp }, payload);
	return projectPlayground(result, String(payload.model), requestId, Date.now() - started, deps.billingStore);
}

function playgroundPayload(body: Record<string, unknown>): Record<string, unknown> {
	const model = typeof body.model === "string" ? body.model.trim() : "";
	if (model.length === 0 || model.length > 128) {
		throw BusinessError.of("playground.modelRequired", "请先选择模型");
	}
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		throw BusinessError.of("playground.messagesRequired", "对话内容不能为空");
	}
	if (body.messages.length > 40) {
		throw BusinessError.of("playground.tooManyMessages", "对话轮数过多，请清空后重试");
	}
	const messages = body.messages.map((raw) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			throw BusinessError.of("playground.invalidMessage", "对话消息格式无效");
		}
		const row = raw as Record<string, unknown>;
		const role = typeof row.role === "string" ? row.role.trim().toLowerCase() : "";
		if (role !== "system" && role !== "user" && role !== "assistant") {
			throw BusinessError.of("playground.invalidRole", "对话包含不支持的角色");
		}
		if (typeof row.content !== "string" || row.content.trim().length === 0) {
			throw BusinessError.of("playground.invalidMessage", "对话消息内容不能为空");
		}
		if (row.content.length > 8000) {
			throw BusinessError.of("playground.contentTooLong", "单条消息过长，请拆分后重试");
		}
		return { role, content: row.content.trim() };
	});
	const payload: Record<string, unknown> = { model, messages, stream: false };
	if (body.session_id !== undefined) {
		payload.session_id = body.session_id;
	}
	return payload;
}

function projectPlayground(
	body: Record<string, unknown>,
	model: string,
	requestId: string,
	latencyMs: number,
	billing: SqliteBillingStore | undefined,
): Record<string, unknown> {
	let content = "";
	if (Array.isArray(body.choices) && body.choices[0] !== null && typeof body.choices[0] === "object") {
		const message = (body.choices[0] as { message?: { content?: unknown } }).message;
		if (typeof message?.content === "string") {
			content = message.content;
		}
	}
	const usage = body.usage !== null && typeof body.usage === "object" ? (body.usage as Record<string, unknown>) : {};
	const prompt = numberField(usage.prompt_tokens);
	const completion = numberField(usage.completion_tokens);
	return {
		requestId,
		model,
		content,
		usage: { promptTokens: prompt, completionTokens: completion, totalTokens: numberField(usage.total_tokens) },
		estimatedCost: quoteYuan(billing, model, prompt, completion),
		latencyMs,
	};
}

function hitRateLimit(deps: MemberRoutesDeps, keyId: string, perMinute: number | null): boolean {
	return perMinute !== null && perMinute > 0 && deps.tryRateLimit?.(`rate:key:${keyId}`, perMinute) === false;
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function quoteYuan(billing: SqliteBillingStore | undefined, model: string, prompt: number, completion: number): string {
	const rate = billing?.findRate(model);
	if (rate === undefined || !rate.enabled) {
		return "0.00";
	}
	const cents = Math.round((prompt * rate.promptPer1m + completion * rate.completionPer1m) / 1_000_000);
	const abs = Math.abs(cents);
	return `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function ownedKeys(keys: ApiKeyService, memberId: string): ApiKey[] {
	return keys.list().filter((key) => key.ownerMemberId === memberId);
}

function preferredKey(owned: ApiKey[]): ApiKey | undefined {
	const now = Date.now();
	const lookup = keyLookup(owned);
	for (const root of [true, false]) {
		for (const key of owned) {
			if ((key.parentKeyId === null) === root && resolveEffectiveKey(key, lookup, now) !== null) {
				return key;
			}
		}
	}
	return owned.find((key) => key.parentKeyId === null) ?? owned[0];
}

function keyLookup(keys: ApiKey[]): (id: string) => ApiKey | undefined {
	const byId = new Map(keys.map((key) => [key.id, key]));
	return (id) => byId.get(id);
}

function portalKeyRow(key: ApiKey): Record<string, unknown> {
	const expired = key.expiresAt !== null && key.expiresAt <= Date.now();
	let status = "ACTIVE";
	if (!key.enabled) {
		status = "DISABLED";
	} else if (key.revokedAt !== null) {
		status = "DISABLED";
	} else if (expired) {
		status = "EXPIRED";
	}
	return {
		id: key.id,
		parentKeyId: key.parentKeyId,
		isRoot: key.parentKeyId === null,
		name: key.name,
		keyPrefix: key.keyPrefix,
		keySuffix: key.keySuffix ?? "",
		identifier: identifierOf(key),
		ownerMemberId: key.ownerMemberId,
		allowedModels: key.allowedModels,
		rateLimitPerMinute: key.rateLimitPerMinute ?? -1,
		enabled: key.enabled,
		expired,
		expiresAt: key.expiresAt === null ? "" : new Date(key.expiresAt).toISOString(),
		status,
	};
}

function memberKeyView(key: ApiKey, lookup: (id: string) => ApiKey | undefined, now: number): Record<string, unknown> {
	const effective = resolveEffectiveKey(key, lookup, now);
	const policy = effective ?? key;
	const expired = policy.expiresAt !== null && policy.expiresAt <= now;
	return {
		id: key.id,
		parentKeyId: key.parentKeyId,
		isRoot: key.parentKeyId === null,
		name: key.name,
		keyPrefix: key.keyPrefix,
		keySuffix: key.keySuffix,
		identifier: identifierOf(key),
		enabled: key.enabled,
		usable: effective !== null,
		revoked: key.revokedAt !== null,
		expired,
		allowedModels: policy.allowedModels,
		allowedIps: policy.allowedIps,
		rateLimitPerMinute: policy.rateLimitPerMinute ?? -1,
		expiresAt: policy.expiresAt === null ? null : new Date(policy.expiresAt).toISOString(),
		createdAt: new Date(key.createdAt).toISOString(),
		requestedAllowedModels: key.allowedModels,
		requestedAllowedIps: key.allowedIps,
		requestedRateLimitPerMinute: key.rateLimitPerMinute,
		requestedExpiresAt: key.expiresAt === null ? null : new Date(key.expiresAt).toISOString(),
	};
}

function adminKeyView(key: ApiKey): Record<string, unknown> {
	const expired = key.expiresAt !== null && key.expiresAt <= Date.now();
	return {
		id: key.id,
		name: key.name,
		identifier: identifierOf(key),
		enabled: key.enabled && key.revokedAt === null,
		expired,
		boundPlatform: key.boundPlatform,
		ownerMemberId: key.ownerMemberId,
		rateLimitPerMinute: key.rateLimitPerMinute ?? -1,
		expiresAt: key.expiresAt === null ? "" : new Date(key.expiresAt).toISOString(),
	};
}

function identifierOf(key: ApiKey): string {
	const prefix = key.keyPrefix.length === 0 ? "sk-" : key.keyPrefix;
	const suffix = key.keySuffix ?? "";
	return suffix.length === 0 ? `${prefix}…` : `${prefix}••••${suffix}`;
}

function modelsBody(
	deps: MemberRoutesDeps,
	key: ApiKey | undefined,
): {
	models: Array<Record<string, unknown>>;
	count: number;
	pricingEnabled: boolean;
	currency: string;
	rateUnit: string;
} {
	const rates = new Map((deps.billingStore?.listRates() ?? []).map((rate) => [rate.model.toLowerCase(), rate]));
	let models = deps.catalog.listModels().filter((model) => model.published);
	if (key?.allowedModels !== null && key?.allowedModels !== undefined) {
		const allowed = new Set(key.allowedModels.map((id) => id.toLowerCase()));
		models = models.filter(
			(model) => allowed.has(model.publicId.toLowerCase()) || allowed.has(model.id.toLowerCase()),
		);
	}
	const rows = models.map((model) => modelRow(model, rates.get(model.publicId.toLowerCase())));
	return {
		models: rows,
		count: rows.length,
		pricingEnabled: true,
		currency: "CNY",
		rateUnit: "PER_1M_TOKENS",
	};
}

function modelRow(
	model: PublishedModel,
	rate: { promptPer1m: number; completionPer1m: number; cacheReadPer1m: number; cacheWritePer1m: number } | undefined,
): Record<string, unknown> {
	return {
		id: model.publicId,
		publicId: model.publicId,
		name: model.name,
		description: model.description,
		supportsImages: model.supportsImages,
		supportsTools: model.supportsTools,
		pricing:
			rate === undefined
				? null
				: {
						promptPer1m: centsToYuan(rate.promptPer1m),
						completionPer1m: centsToYuan(rate.completionPer1m),
						cacheReadPer1m: centsToYuan(rate.cacheReadPer1m),
						cacheWritePer1m: centsToYuan(rate.cacheWritePer1m),
					},
	};
}

function walletView(store: SqliteBillingStore | undefined, memberId: string): Record<string, unknown> {
	const wallet = store?.getWallet(memberId);
	if (wallet === undefined) {
		return { hasWallet: false, balance: "0.00", currency: "CNY", billingEnabled: true };
	}
	return {
		hasWallet: true,
		balance: centsToYuan(wallet.balance),
		currency: "CNY",
		billingEnabled: true,
	};
}

function ledgerView(entry: {
	id: string;
	memberId: string;
	model: string;
	amount: number;
	balanceAfter: number;
	entryType: string;
	status: string;
	occurredAt: number;
}): Record<string, unknown> {
	return {
		id: entry.id,
		model: entry.model,
		amount: centsToYuan(entry.amount),
		balanceAfter: centsToYuan(entry.balanceAfter),
		entryType: entry.entryType,
		status: entry.status,
		currency: "CNY",
		occurredAt: new Date(entry.occurredAt).toISOString(),
	};
}

function rateYuan(rate: {
	model: string;
	promptPer1m: number;
	completionPer1m: number;
	cacheReadPer1m: number;
	cacheWritePer1m: number;
	enabled: boolean;
}): Record<string, unknown> {
	return {
		model: rate.model,
		promptPer1m: centsToYuan(rate.promptPer1m),
		completionPer1m: centsToYuan(rate.completionPer1m),
		cacheReadPer1m: centsToYuan(rate.cacheReadPer1m),
		cacheWritePer1m: centsToYuan(rate.cacheWritePer1m),
		enabled: rate.enabled,
	};
}

function summarize(logs: GatewayCallLogRecord[]): Record<string, number> {
	let fails = 0;
	let promptTokens = 0;
	let completionTokens = 0;
	let totalTokens = 0;
	for (const log of logs) {
		if (!isOk(log.status)) {
			fails++;
		}
		promptTokens += log.promptTokens ?? 0;
		completionTokens += log.completionTokens ?? 0;
		totalTokens += log.totalTokens ?? (log.promptTokens ?? 0) + (log.completionTokens ?? 0);
	}
	return { calls: logs.length, fails, promptTokens, completionTokens, totalTokens };
}

function safeLog(log: GatewayCallLogRecord): Record<string, unknown> {
	const ok = isOk(log.status);
	return {
		requestId: log.requestId ?? "",
		model: log.model ?? "",
		status: log.status,
		promptTokens: log.promptTokens ?? 0,
		completionTokens: log.completionTokens ?? 0,
		totalTokens: log.totalTokens ?? 0,
		latencyMs: log.latencyMs,
		errorCategory: ok ? "" : (log.errorCategory ?? ""),
		occurredAt: new Date(log.occurredAt).toISOString(),
	};
}

function isOk(status: string): boolean {
	const value = status.toUpperCase();
	return value === "OK" || value === "SUCCESS";
}

function matchesStatus(status: string, filter: string): boolean {
	if (filter === "OK") {
		return isOk(status);
	}
	if (filter === "OTHER") {
		return !isOk(status);
	}
	return true;
}

function normalizeStatus(raw: string | null): string {
	const value = (raw ?? "ALL").trim().toUpperCase();
	return value === "OK" || value === "OTHER" ? value : "ALL";
}

function centsToYuan(cents: number): string {
	const negative = cents < 0;
	const abs = Math.abs(Math.trunc(cents));
	const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
	return negative ? `-${text}` : text;
}

function shanghaiToday(now = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
}

function shiftShanghaiDay(day: string, delta: number): string {
	const start = Date.parse(`${day}T00:00:00+08:00`);
	return shanghaiToday(new Date(start + delta * 86_400_000));
}

function shanghaiDayRange(day: string): { from: number; to: number } {
	const from = Date.parse(`${day}T00:00:00+08:00`);
	if (Number.isNaN(from)) {
		const today = shanghaiToday();
		const fallback = Date.parse(`${today}T00:00:00+08:00`);
		return { from: fallback, to: fallback + 86_400_000 };
	}
	return { from, to: from + 86_400_000 };
}

function clampDays(raw: string | null): number {
	const parsed = Number.parseInt(raw ?? "7", 10);
	if (Number.isNaN(parsed)) {
		return 7;
	}
	return Math.max(1, Math.min(parsed, 30));
}

function originOf(request: IncomingMessage): string {
	const forwarded = String(request.headers["x-forwarded-proto"] ?? "").toLowerCase();
	const proto = forwarded === "https" ? "https" : "http";
	const host = request.headers.host ?? "127.0.0.1:8790";
	return `${proto}://${host}`;
}
