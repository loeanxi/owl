/**
 * 账号积分刷新 —— 移植自 manager `CreditService` 与各平台 CreditProvider。
 * 查询结果写回账号行。停用账号不打上游。同一账号的刷新串行。
 */
import type { Account, AccountStore } from "owl-pool";
import { parseCredentials, UpstreamException } from "owl-pool";
import { workBuddyToken } from "../catalog/workbuddy-catalog.ts";

export const UNLIMITED_NOTE = "积分池不限量";

export interface CreditBucket {
	key: string;
	label: string;
	used: number | null;
	total: number | null;
	remaining: number | null;
	remainingPercent: number | null;
	unit: string;
	resetsAt: string | null;
	note: string | null;
	unlimited?: boolean;
	unavailable?: boolean;
}

export interface CreditSnapshot {
	ok: boolean;
	credits: number | null;
	label: string | null;
	message: string;
	buckets: CreditBucket[];
	authRejected?: boolean;
}

export interface CreditHooks {
	fetchImpl?: typeof fetch;
	workbuddyBaseUrl: string;
	workbuddyAuthRoots: string[];
	exchangeTraeToken(session: string): Promise<string>;
	codexQuota?(account: Account): Promise<CreditSnapshot>;
	mimoPing?(account: Account): Promise<string>;
	sdkQuota?(account: Account): Promise<Record<string, unknown>>;
	claudeUsage?(account: Account): Promise<Record<string, unknown> | null>;
	probe?(account: Account): Promise<{ ok: boolean; message: string }>;
}

const inflight = new Map<string, Promise<Account>>();

export function refreshCredit(accounts: AccountStore, account: Account, hooks: CreditHooks): Promise<Account> {
	const existing = inflight.get(account.id);
	if (existing !== undefined) {
		return existing;
	}
	const job = refreshOne(accounts, account, hooks).finally(() => {
		inflight.delete(account.id);
	});
	inflight.set(account.id, job);
	return job;
}

async function refreshOne(accounts: AccountStore, account: Account, hooks: CreditHooks): Promise<Account> {
	if (!account.enabled) {
		return persist(accounts, account, fail("账号已停用"));
	}
	const beforeSession = sessionOf(account);
	let snapshot: CreditSnapshot;
	try {
		snapshot = await withTimeout(query(account, hooks), 30_000);
	} catch (error) {
		snapshot = fail(error instanceof Error && error.message.length > 0 ? error.message : "积分查询失败");
	}
	const current = accounts.get(account.id) ?? account;
	if (account.platform === "TRAE" && beforeSession !== null && sessionOf(current) !== beforeSession) {
		return persist(accounts, current, fail("登录信息在查询期间更新，已忽略旧结果"));
	}
	return persist(accounts, current, snapshot);
}

export async function query(account: Account, hooks: CreditHooks): Promise<CreditSnapshot> {
	switch (account.platform) {
		case "TRAE":
			return queryTrae(account, hooks);
		case "WORKBUDDY":
			return queryWorkBuddy(account, hooks);
		case "CODEX":
			return hooks.codexQuota !== undefined ? hooks.codexQuota(account) : fail("Codex 额度查询尚未接入");
		case "MIMO":
			return queryMimo(account, hooks);
		case "CURSOR":
		case "COPILOT":
		case "QODER":
			return querySdk(account, hooks);
		case "CLAUDE":
			return queryClaude(account, hooks);
		default:
			return queryByProbe(account, hooks, "订阅套餐");
	}
}

function persist(accounts: AccountStore, account: Account, snapshot: CreditSnapshot): Account {
	const message = snapshot.message.slice(0, 255);
	return accounts.patchState(account.id, {
		credits: snapshot.credits,
		creditsLabel: snapshot.label,
		creditsStatus: snapshot.ok ? "OK" : "FAIL",
		creditsMessage: message,
		creditsDetails: snapshot.buckets.length > 0 ? JSON.stringify(snapshot.buckets) : null,
		creditsUpdatedAt: Date.now(),
		...(snapshot.authRejected
			? { credentialStatus: "EXPIRED" as const, credentialMessage: message, credentialCheckedAt: Date.now() }
			: {}),
	});
}

async function queryTrae(account: Account, hooks: CreditHooks): Promise<CreditSnapshot> {
	const credentials = parseCredentials(account);
	const session = text(credentials.session);
	if (session === null) {
		return fail("Trae 尚未登录，请点击「登录」完成授权");
	}
	const deviceId = text(credentials.deviceId) ?? randomDeviceId();
	let jwt: string;
	try {
		jwt = await hooks.exchangeTraeToken(session);
	} catch (error) {
		if (error instanceof UpstreamException && error.kind === "AUTH") {
			return authRejected("Trae 登录已失效，请点击「重新登录」完成授权");
		}
		return fail(`Trae 会话换 JWT 失败: ${error instanceof Error ? error.message : "unknown"}`);
	}
	const fetchImpl = hooks.fetchImpl ?? fetch;
	let last = "未返回积分包数据";
	for (const path of ["/trae/api/v2/pay/ide_user_ent_usage", "/trae/api/v2/pay/web_user_ent_usage"]) {
		try {
			const response = await fetchImpl(`https://api.trae.cn${path}`, {
				method: "POST",
				headers: {
					Authorization: `Cloud-IDE-JWT ${jwt}`,
					"X-User-Region": "cn",
					"x-device-id": deviceId,
					"Content-Type": "application/json",
					Accept: "application/json",
					"User-Agent": "ManagerCheckIn/0.1",
				},
				body: '{"require_usage":true,"req_source":2}',
				signal: AbortSignal.timeout(20_000),
			});
			if (response.status === 401 || response.status === 403) {
				return authRejected("Trae 登录已失效，请点击「重新登录」完成授权");
			}
			const body: unknown = await response.json();
			const snapshot = extractEntitlementUsage(body);
			if (snapshot.ok) {
				return snapshot;
			}
			last = snapshot.message;
		} catch (error) {
			last = error instanceof Error ? error.name : "Error";
		}
	}
	return fail(`Trae 积分查询失败: ${last.slice(0, 200)}`);
}

async function queryWorkBuddy(account: Account, hooks: CreditHooks): Promise<CreditSnapshot> {
	let token: string;
	try {
		token = workBuddyToken(account, hooks.workbuddyAuthRoots);
	} catch (error) {
		return fail(error instanceof Error ? error.message : "无法解析 accessToken");
	}
	const fetchImpl = hooks.fetchImpl ?? fetch;
	const base = hooks.workbuddyBaseUrl.replace(/\/+$/, "");
	try {
		const summary = extractResourceSummary(
			await postWorkBuddy(fetchImpl, base, "/billing/meter/get-user-resource-summary", token),
		);
		if (summary.ok) {
			return summary;
		}
		return extractUserResource(await postWorkBuddy(fetchImpl, base, "/v2/billing/meter/get-user-resource", token));
	} catch (error) {
		return fail(`WorkBuddy 积分查询失败: ${error instanceof Error ? error.message : "unknown"}`);
	}
}

async function queryMimo(account: Account, hooks: CreditHooks): Promise<CreditSnapshot> {
	if (hooks.mimoPing === undefined) {
		return fail("MiMo 连通性检查尚未接入");
	}
	try {
		await hooks.mimoPing(account);
		return ok(null, "订阅套餐");
	} catch (error) {
		return fail(error instanceof Error ? error.message : "MiMo 连通失败");
	}
}

async function querySdk(account: Account, hooks: CreditHooks): Promise<CreditSnapshot> {
	if (hooks.sdkQuota === undefined) {
		return fail("官方额度查询尚未接入");
	}
	try {
		const response = await hooks.sdkQuota(account);
		if (account.platform === "CURSOR") {
			return cursorQuota(response);
		}
		if (account.platform === "COPILOT") {
			return copilotQuota(response);
		}
		return qoderQuota(response);
	} catch (error) {
		return fail(error instanceof Error ? error.message : "额度查询失败");
	}
}

async function queryClaude(account: Account, hooks: CreditHooks): Promise<CreditSnapshot> {
	if (hooks.claudeUsage !== undefined) {
		try {
			const usage = await hooks.claudeUsage(account);
			if (usage !== null) {
				const buckets = claudeUsageBuckets(usage);
				if (buckets.length > 0) {
					return { ok: true, credits: null, label: "Claude 订阅额度", message: "", buckets };
				}
			}
		} catch (error) {
			if (error instanceof UpstreamException && error.kind === "AUTH") {
				return fail(error.message);
			}
		}
	}
	const oauth = String(parseCredentials(account).authType ?? "").toLowerCase() === "oauth";
	return queryByProbe(account, hooks, oauth ? "订阅套餐" : "API Key");
}

async function queryByProbe(account: Account, hooks: CreditHooks, label: string): Promise<CreditSnapshot> {
	if (hooks.probe === undefined) {
		return fail("该平台积分查询尚未接入");
	}
	const probed = await hooks.probe(account);
	return probed.ok ? ok(null, label) : fail(probed.message);
}

export function extractEntitlementUsage(node: unknown): CreditSnapshot {
	if (!isRecord(node)) {
		return fail("空响应");
	}
	const code = node.code;
	if (typeof code === "number" && code !== 0 && code !== 200) {
		return fail(`上游返回 code=${code}`);
	}
	const packs = findKey(node, "user_entitlement_pack_list");
	if (!Array.isArray(packs)) {
		return fail("响应中无 user_entitlement_pack_list");
	}
	let balance = 0;
	let known = 0;
	for (const pack of packs) {
		if (!isRecord(pack)) {
			continue;
		}
		const base = isRecord(pack.entitlement_base_info) ? pack.entitlement_base_info : {};
		const quota = isRecord(base.quota) ? base.quota : {};
		const limit = numberOf(quota.credits_limit) ?? numberOf(pack.credits_limit);
		if (limit === null) {
			continue;
		}
		known += 1;
		const product = numberOf(base.product_type) ?? numberOf(pack.product_type) ?? -1;
		if (product === 3 || pack.is_hide === true || numberOf(pack.status) === 3 || expired(pack)) {
			continue;
		}
		if (limit < 0) {
			return ok(null, "Trae Credits", UNLIMITED_NOTE);
		}
		const usage = isRecord(pack.usage) ? pack.usage : {};
		const spent = numberOf(usage.credits_amount) ?? numberOf(pack.credits_amount) ?? 0;
		balance += Math.max(0, limit - spent);
	}
	if (known === 0) {
		return fail("积分包中缺少 credits_limit，无法确认余额");
	}
	return ok(balance, "Trae Credits");
}

export function extractResourceSummary(node: unknown): CreditSnapshot {
	if (!isRecord(node)) {
		return fail("空响应");
	}
	const code = numberOf(node.code);
	if (code !== null && code !== 0 && code !== 200) {
		return fail(text(node.msg) ?? text(node.message) ?? `上游返回 code=${code}`);
	}
	const data = isRecord(node.data) ? node.data : node;
	const packages = findKeyLoose(data, "Packages") ?? findKey(data, "packages");
	if (!Array.isArray(packages)) {
		return fail("summary 无 Packages");
	}
	let sum = 0;
	let counted = 0;
	for (const item of packages) {
		if (!isRecord(item)) {
			continue;
		}
		const remain =
			numberOf(item.CycleRemainCapacity) ??
			numberOf(item.cycleRemainCapacity) ??
			numberOf(item.cycle_remain_capacity) ??
			numberOf(item.CapacityRemainPrecise) ??
			numberOf(item.CycleCapacityRemainPrecise);
		if (remain !== null) {
			sum += remain;
			counted += 1;
		}
	}
	if (counted === 0) {
		return fail("Packages 无 CycleRemainCapacity");
	}
	return ok(sum, `CycleRemainCapacity×${counted}`);
}

export function extractUserResource(node: unknown): CreditSnapshot {
	if (!isRecord(node)) {
		return fail("空响应");
	}
	const code = numberOf(node.code);
	if (code !== null && code !== 0 && code !== 200) {
		return fail(text(node.msg) ?? text(node.message) ?? `上游返回 code=${code}`);
	}
	const data = isRecord(node.data) ? node.data : node;
	const accounts = findKeyLoose(data, "Accounts");
	if (Array.isArray(accounts)) {
		let sum = 0;
		let counted = 0;
		for (const item of accounts) {
			if (!isRecord(item)) {
				continue;
			}
			const remain =
				numberOf(item.CapacityRemainPrecise) ??
				numberOf(item.CycleCapacityRemainPrecise) ??
				numberOf(item.CycleRemainCapacity) ??
				numberOf(item.CapacityRemain);
			if (remain !== null) {
				sum += remain;
				counted += 1;
			}
		}
		if (counted > 0) {
			return ok(sum, `CapacityRemain×${counted}`);
		}
	}
	const total = numberOf(data.TotalDosage) ?? numberOf(data.totalDosage);
	if (total !== null) {
		return ok(total, "TotalDosage");
	}
	return fail("响应中无 TotalDosage/CapacityRemain");
}

export function cursorQuota(response: Record<string, unknown>): CreditSnapshot {
	const source = text(response.source);
	const plan = isRecord(response.plan) ? response.plan : null;
	if (source === "CURSOR_USAGE_SUMMARY" && plan !== null && Object.keys(plan).length > 0) {
		const used = numberOf(plan.used);
		const breakdown = isRecord(plan.breakdown) ? plan.breakdown : null;
		const totalPool = breakdown !== null ? (numberOf(breakdown.total) ?? numberOf(plan.limit)) : numberOf(plan.limit);
		const remaining = totalPool === null || used === null ? numberOf(plan.remaining) : Math.max(0, totalPool - used);
		const totalPercent = numberOf(plan.totalPercentUsed);
		const remainingPercent = totalPercent === null ? null : Math.max(0, 100 - totalPercent);
		const membership = text(response.membershipType)?.toUpperCase() ?? "";
		const auto = numberOf(plan.autoPercentUsed);
		const note = `${membership.length > 0 ? `${membership} 订阅额度` : "订阅额度"}${auto === null ? "" : ` · Auto 已用 ${auto}%`}`;
		const buckets: CreditBucket[] = [
			bucket(
				"cursor_plan",
				"订阅额度",
				used,
				totalPool,
				remaining,
				remainingPercent,
				"",
				text(response.billingCycleEnd),
				note,
			),
		];
		const onDemand = isRecord(response.onDemand) ? response.onDemand : null;
		if (onDemand?.enabled === true) {
			const odTotal = numberOf(onDemand.limit);
			const odUsed = numberOf(onDemand.used);
			buckets.push(
				bucket(
					"cursor_on_demand",
					"按需付费",
					odUsed,
					odTotal,
					odTotal === null || odUsed === null ? numberOf(onDemand.remaining) : Math.max(0, odTotal - odUsed),
					null,
					"USD",
					null,
					"按需付费（用量计费）",
				),
			);
		}
		return {
			ok: true,
			credits: null,
			label: membership.length > 0 ? `Cursor ${membership} 额度` : "Cursor 订阅额度",
			message: "",
			buckets,
		};
	}
	if (source !== "CURSOR_DASHBOARD_ONLY") {
		return fail("Cursor 未返回额度来源");
	}
	const note = "未找到可用的 Cursor 会话：重新登录桌面端，或在账号凭证中粘贴 sessionToken；也可在 Spending 页面查看";
	return {
		ok: true,
		credits: null,
		label: "Cursor 双池额度",
		message: note,
		buckets: [
			bucket("cursor_models", "Cursor Models", null, null, null, null, "USD", null, note),
			bucket("other_models", "Other Models", null, null, null, null, "USD", null, note),
		],
	};
}

export function copilotQuota(response: Record<string, unknown>): CreditSnapshot {
	const snapshots = isRecord(response.quotaSnapshots) ? response.quotaSnapshots : null;
	if (snapshots === null || Object.keys(snapshots).length === 0) {
		return fail("Copilot 未返回账户额度；请检查账号授权");
	}
	const buckets: CreditBucket[] = [];
	for (const [key, value] of Object.entries(snapshots)) {
		if (!isRecord(value)) {
			continue;
		}
		let total = numberOf(value.entitlementRequests);
		const unlimited = value.isUnlimitedEntitlement === true || (total !== null && total < 0);
		if (unlimited) {
			total = null;
		}
		const used = numberOf(value.usedRequests);
		const label =
			key === "premium_interactions"
				? "Premium requests"
				: key === "chat"
					? "Chat"
					: key === "completions"
						? "Completions"
						: key === "ai_credits"
							? "AI credits"
							: key;
		buckets.push(
			bucket(
				key,
				label,
				used,
				total,
				total === null || used === null ? null : Math.max(0, total - used),
				numberOf(value.remainingPercentage),
				"次",
				null,
				unlimited ? "不限量" : null,
				unlimited,
			),
		);
	}
	return buckets.length === 0
		? fail("Copilot 额度数据为空")
		: { ok: true, credits: null, label: "Copilot 账户额度", message: "", buckets };
}

export function qoderQuota(response: Record<string, unknown>): CreditSnapshot {
	const buckets: CreditBucket[] = [];
	addQoder(buckets, "plan", "套餐 Credits", response.userQuota, "total");
	addQoder(buckets, "addon", "加购 Credits", response.addOnQuota, "total");
	addQoder(buckets, "organization", "组织 Credits", response.orgResourcePackage, "cap");
	return buckets.length === 0
		? fail("Qoder CN 未返回账户额度；当前可能只有会话用量")
		: { ok: true, credits: null, label: "Qoder CN Credits", message: "", buckets };
}

export function claudeUsageBuckets(root: Record<string, unknown>): CreditBucket[] {
	const buckets: CreditBucket[] = [];
	addClaudeWindow(buckets, "hour5", "5 小时窗口", root.five_hour);
	addClaudeWindow(buckets, "weekly", "周窗口", root.seven_day);
	return buckets;
}

export function codexQuotaFromResponse(response: Record<string, unknown>): CreditSnapshot {
	let limits = isRecord(response.rateLimits) ? response.rateLimits : null;
	if (limits === null) {
		const byId = isRecord(response.rateLimitsByLimitId) ? response.rateLimitsByLimitId : null;
		const first = byId === null ? undefined : Object.values(byId)[0];
		limits = isRecord(first) ? first : null;
	}
	if (limits === null) {
		return fail("Codex 订阅额度窗口暂不可用");
	}
	const buckets: CreditBucket[] = [];
	const notes: string[] = [];
	for (const [key, label] of [
		["primary", "主窗口"],
		["secondary", "次窗口"],
	] as const) {
		const window = isRecord(limits[key]) ? limits[key] : null;
		const used = window === null ? null : numberOf(window.usedPercent);
		if (window === null || used === null) {
			continue;
		}
		const reset = numberOf(window.resetsAt);
		const resetsAt = reset === null ? null : new Date(reset * 1000).toISOString();
		notes.push(`${label}已用 ${Math.trunc(used)}%${resetsAt === null ? "" : `，重置于 ${resetsAt}`}`);
		buckets.push(
			bucket(key, label, used, 100, Math.max(0, 100 - used), Math.max(0, 100 - used), "%", resetsAt, null),
		);
	}
	if (buckets.length === 0) {
		return fail("Codex 订阅额度窗口暂不可用");
	}
	return { ok: true, credits: null, label: "Codex 订阅额度", message: notes.join("；"), buckets };
}

function addQoder(buckets: CreditBucket[], key: string, label: string, raw: unknown, totalKey: string): void {
	if (!isRecord(raw)) {
		return;
	}
	const remaining = numberOf(raw.remaining);
	const total = numberOf(raw[totalKey]);
	const used = numberOf(raw.used);
	if (remaining === null && total === null && used === null) {
		return;
	}
	const unavailable = typeof raw.available === "boolean" && !raw.available;
	buckets.push(
		bucket(
			key,
			label,
			used,
			total,
			remaining,
			null,
			text(raw.unit) ?? "Credits",
			null,
			unavailable ? "当前不可用" : null,
			false,
			unavailable,
		),
	);
}

function addClaudeWindow(buckets: CreditBucket[], key: string, label: string, raw: unknown): void {
	if (!isRecord(raw)) {
		return;
	}
	const utilization = numberOf(raw.utilization);
	if (utilization === null) {
		return;
	}
	const percent = Math.min(100, Math.max(0, utilization <= 1 ? utilization * 100 : utilization));
	const reset = numberOf(raw.resets_at);
	buckets.push(
		bucket(
			key,
			label,
			percent,
			100,
			null,
			Math.max(0, 100 - percent),
			"%",
			reset === null ? null : new Date(reset * 1000).toISOString(),
			null,
		),
	);
}

async function postWorkBuddy(fetchImpl: typeof fetch, base: string, path: string, token: string): Promise<unknown> {
	const response = await fetchImpl(`${base}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": "ManagerCheckIn/0.1",
		},
		body: "{}",
		signal: AbortSignal.timeout(20_000),
	});
	const body: unknown = await response.json().catch(() => null);
	if (body === null) {
		throw new Error(`WorkBuddy HTTP ${response.status}`);
	}
	return body;
}

function ok(credits: number | null, label: string, message = ""): CreditSnapshot {
	return { ok: true, credits, label, message, buckets: [] };
}

function fail(message: string): CreditSnapshot {
	return { ok: false, credits: null, label: null, message, buckets: [] };
}

function authRejected(message: string): CreditSnapshot {
	return { ...fail(message), authRejected: true };
}

function bucket(
	key: string,
	label: string,
	used: number | null,
	total: number | null,
	remaining: number | null,
	remainingPercent: number | null,
	unit: string,
	resetsAt: string | null,
	note: string | null,
	unlimited = false,
	unavailable = false,
): CreditBucket {
	return { key, label, used, total, remaining, remainingPercent, unit, resetsAt, note, unlimited, unavailable };
}

function sessionOf(account: Account): string | null {
	return text(parseCredentials(account).session);
}

function randomDeviceId(): string {
	let value = "";
	for (let i = 0; i < 16; i++) {
		value += Math.floor(Math.random() * 10).toString();
	}
	return value;
}

function expired(pack: Record<string, unknown>): boolean {
	for (const key of ["expire_time", "expired_at", "end_time"]) {
		const value = pack[key];
		const stamp = numberOf(value);
		if (stamp !== null && stamp > 0) {
			const ms = stamp > 10_000_000_000 ? stamp : stamp * 1000;
			if (ms < Date.now()) {
				return true;
			}
		} else if (typeof value === "string") {
			const parsed = Date.parse(value);
			if (!Number.isNaN(parsed) && parsed < Date.now()) {
				return true;
			}
		}
	}
	return false;
}

function findKey(node: unknown, key: string): unknown {
	if (!isRecord(node) && !Array.isArray(node)) {
		return undefined;
	}
	if (isRecord(node) && key in node) {
		return node[key];
	}
	const children = isRecord(node) ? Object.values(node) : node;
	for (const child of children) {
		const found = findKey(child, key);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

function findKeyLoose(node: unknown, key: string): unknown {
	if (!isRecord(node)) {
		return undefined;
	}
	const target = key.toLowerCase();
	for (const [name, value] of Object.entries(node)) {
		if (name.toLowerCase() === target) {
			return value;
		}
	}
	return undefined;
}

function numberOf(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function text(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("积分查询超时")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
