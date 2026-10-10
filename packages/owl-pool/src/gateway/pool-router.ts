/**
 * 账号池路由 —— 移植自 manager `gateway/DefaultAccountPoolRouter`。
 * enabled 账号中先在「窗口内有临期积分」的账号里按临期积分量加权选号，
 * 没有可用临期账号时按剩余积分加权选号（未知积分按权重 1；已知 ≤0 且池内有正积分则跳过），
 * EXPIRED 凭证一律不参与；失败冷却（网络瞬断 5s / 认证 10min / 额度 12h / 默认 60s），
 * 冷却同时落库：重启后仍未过期的冷却自动恢复。
 */

import type { AccountStore } from "../account/store.ts";
import type { Account } from "../account/types.ts";
import type { Platform } from "../platform.ts";
import type { UpstreamException } from "./upstream.ts";

/** 与网关换号路径一致的失效凭证标记。 */
const EXPIRED = "EXPIRED";
const UNKNOWN_CREDIT_WEIGHT = 1.0;
/** Retry-After 参与冷却的上限秒数。 */
const MAX_RETRY_AFTER_SECONDS = 3600;
const DEFAULT_EXPIRING_WINDOW_MS = 72 * 3_600_000;
const DEFAULT_EXPIRY_FRESHNESS_MS = 2 * 3_600_000;

/** 单个积分包的到期时间（epoch 毫秒）与剩余量。 */
export interface CreditExpiry {
	at: number;
	remaining: number;
}

export interface PoolRouterOptions {
	accounts: AccountStore;
	/** 默认冷却毫秒（manager: account-cooldown-ms=60000）。 */
	accountCooldownMs: number;
	/** 多久内到期算「临期」；0 关闭临期优先。默认 72 小时。 */
	expiringWindowMs?: number;
	/** 积分快照超过这么久没刷新就不信它的到期信息。默认 2 小时。 */
	expiryFreshnessMs?: number;
	nowMs?(): number;
	/** 冷却内存态（测试可注入）；生产用 MemoryGatewayState。 */
	cooldownState: {
		get(key: string, nowMs?: number): string | null;
		extendTtl(key: string, value: string, ttlMs: number, nowMs?: number): void;
	};
}

export class AccountPoolRouter {
	readonly #accounts: AccountStore;
	readonly #accountCooldownMs: number;
	readonly #expiringWindowMs: number;
	readonly #expiryFreshnessMs: number;
	readonly #nowMs: () => number;
	readonly #cooldownState: PoolRouterOptions["cooldownState"];

	constructor(options: PoolRouterOptions) {
		this.#accounts = options.accounts;
		this.#accountCooldownMs = options.accountCooldownMs;
		this.#expiringWindowMs = options.expiringWindowMs ?? DEFAULT_EXPIRING_WINDOW_MS;
		this.#expiryFreshnessMs = options.expiryFreshnessMs ?? DEFAULT_EXPIRY_FRESHNESS_MS;
		this.#nowMs = options.nowMs ?? (() => Date.now());
		this.#cooldownState = options.cooldownState;
		// 启动时把仍在冷却期内的账号恢复进内存
		for (const account of this.#accounts.list()) {
			if (hasPersistedCooldown(account, this.#nowMs())) {
				const remaining = account.cooldownUntil! - this.#nowMs();
				this.#cooldownState.extendTtl(
					cooldownKey(account.id),
					new Date(account.cooldownUntil!).toISOString(),
					remaining,
					this.#nowMs(),
				);
			}
		}
	}

	/** 选号：平台启用账号 → 过滤冷却/失效凭证/已试过 → 临期积分加权 → 积分加权随机。 */
	pick(platform: Platform, exclude?: ReadonlySet<string>): Account | null {
		const now = this.#nowMs();
		const candidates = this.#accounts
			.list(platform)
			.filter((account) => account.enabled)
			.filter((account) => !exclude?.has(account.id))
			.filter((account) => !hasPersistedCooldown(account, now))
			.filter((account) => account.credentialStatus !== EXPIRED);
		const isCooling = (account: Account) => this.isCooling(account.id);
		if (this.#expiringWindowMs > 0) {
			const expiring = pickWeighted(
				candidates,
				(account) => expiringCredits(account, now, this.#expiringWindowMs, this.#expiryFreshnessMs),
				isCooling,
			);
			if (expiring !== null) {
				return expiring;
			}
		}
		return pickHealthyByCreditWeight(candidates, now, isCooling);
	}

	markFailure(accountId: string, reason: string, retryAfterSeconds: number | null = null): void {
		let millis = cooldownMillis(reason, this.#accountCooldownMs);
		if (retryAfterSeconds !== null) {
			millis = Math.max(1, Math.min(MAX_RETRY_AFTER_SECONDS, retryAfterSeconds)) * 1000;
		}
		const until = this.#nowMs() + millis;
		// 先进内存冷却再落库：落库失败不影响本次内存冷却生效
		this.#cooldownState.extendTtl(
			cooldownKey(accountId),
			new Date(until).toISOString(),
			Math.max(1, until - this.#nowMs()),
			this.#nowMs(),
		);
		try {
			const account = this.#accounts.get(accountId);
			if (account !== undefined) {
				this.#accounts.patchState(accountId, { cooldownUntil: until });
			}
		} catch {
			// 账号已删除等写库失败只影响下次重启后的恢复
		}
	}

	markUpstreamFailure(accountId: string, failure: UpstreamException): void {
		const reason =
			failure.kind === "AUTH"
				? "401"
				: failure.kind === "QUOTA"
					? "额度耗尽"
					: failure.kind === "RATE"
						? "429"
						: failure.message;
		const retryAfter = failure.kind === "RATE" || failure.kind === "SERVER" ? failure.retryAfterSeconds : null;
		this.markFailure(accountId, reason, retryAfter);
	}

	markSuccess(_accountId: string): void {
		// 较早的成功不能抹掉另一个请求刚写入的失败冷却；由 TTL 自然恢复（对齐 Java）
	}

	isCooling(accountId: string): boolean {
		return this.#cooldownState.get(cooldownKey(accountId), this.#nowMs()) !== null;
	}
}

export function hasPersistedCooldown(account: Account, nowMs: number): boolean {
	return account.cooldownUntil !== null && account.cooldownUntil !== undefined && account.cooldownUntil > nowMs;
}

/** 数据库冷却仍是权威：Redis/内存失败时失败记录已落库。 */
export function pickHealthyByCreditWeight(
	candidates: Account[],
	_nowMs: number,
	isCooling: (account: Account) => boolean,
): Account | null {
	const remaining = [...candidates];
	while (remaining.length > 0) {
		const selected = pickByCreditWeight(remaining);
		if (selected === null) {
			return null;
		}
		if (!isCooling(selected)) {
			return selected;
		}
		remaining.splice(remaining.indexOf(selected), 1);
	}
	return null;
}

/**
 * now 到 now+windowMs 之间会作废的积分量。
 * 快照过旧或解析不了时返回 0：不参与临期优先，回到普通加权。
 */
export function expiringCredits(account: Account, nowMs: number, windowMs: number, freshnessMs: number): number {
	const raw = account.creditsExpiry;
	if (raw === null || raw === undefined || raw.length === 0) {
		return 0;
	}
	const updatedAt = account.creditsUpdatedAt;
	if (updatedAt === null || updatedAt === undefined || nowMs - updatedAt > freshnessMs) {
		return 0;
	}
	let entries: unknown;
	try {
		entries = JSON.parse(raw);
	} catch {
		return 0;
	}
	if (!Array.isArray(entries)) {
		return 0;
	}
	let sum = 0;
	for (const entry of entries) {
		const { at, remaining } = (entry ?? {}) as Partial<CreditExpiry>;
		if (
			typeof at === "number" &&
			typeof remaining === "number" &&
			remaining > 0 &&
			at > nowMs &&
			at <= nowMs + windowMs
		) {
			sum += remaining;
		}
	}
	return sum;
}

/** 只在权重 > 0 的账号里加权抽签，抽中冷却中的就剔除重抽。 */
function pickWeighted(
	candidates: Account[],
	weightOf: (account: Account) => number,
	isCooling: (account: Account) => boolean,
): Account | null {
	const pool = candidates
		.map((account) => ({ account, weight: weightOf(account) }))
		.filter((entry) => entry.weight > 0);
	while (pool.length > 0) {
		const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
		let roll = Math.random() * total;
		let index = pool.length - 1;
		for (let i = 0; i < pool.length; i++) {
			roll -= pool[i]!.weight;
			if (roll < 0) {
				index = i;
				break;
			}
		}
		const selected = pool[index]!.account;
		if (!isCooling(selected)) {
			return selected;
		}
		pool.splice(index, 1);
	}
	return null;
}

/** 剩余积分越高，被选中概率越大。 */
export function pickByCreditWeight(candidates: Account[]): Account | null {
	if (candidates.length === 0) {
		return null;
	}
	const hasPositive = candidates.some(
		(account) => account.credits !== null && account.credits !== undefined && account.credits > 0,
	);
	const pool = hasPositive
		? candidates.filter((account) => account.credits === null || account.credits === undefined || account.credits > 0)
		: candidates;
	if (pool.length === 0) {
		return null;
	}
	const weights = pool.map((account) =>
		account.credits !== null && account.credits !== undefined && account.credits > 0
			? account.credits
			: UNKNOWN_CREDIT_WEIGHT,
	);
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let roll = Math.random() * total;
	for (let i = 0; i < pool.length; i++) {
		roll -= weights[i]!;
		if (roll < 0) {
			return pool[i]!;
		}
	}
	return pool[pool.length - 1]!;
}

/**
 * 冷却策略：网络瞬断短冷却（尽快换号），认证失败中等，额度耗尽长冷却。
 */
export function cooldownMillis(reason: string, defaultMs: number): number {
	if (isNetworkBlip(reason)) {
		return Math.min(defaultMs, 5_000);
	}
	let ms = defaultMs;
	if (isAuthFailure(reason)) {
		ms = Math.max(ms, 10 * 60_000);
	}
	if (isQuotaFailure(reason)) {
		ms = Math.max(ms, 12 * 3_600_000);
	}
	return ms;
}

/** 可重试 IO：连接拒绝/超时/DNS 瞬断（对齐 GatewayHttpClients.isRetryableIo 的常用面）。 */
export function isNetworkBlip(reason: string): boolean {
	const lower = reason.toLowerCase();
	return (
		lower.includes("econnrefused") ||
		lower.includes("econnreset") ||
		lower.includes("etimedout") ||
		lower.includes("timeout") ||
		lower.includes("enotfound") ||
		lower.includes("eai_again") ||
		lower.includes("socket hang up")
	);
}

function isAuthFailure(reason: string): boolean {
	if (reason === null) {
		return false;
	}
	const lower = reason.toLowerCase();
	return (
		reason.includes("401") ||
		lower.includes("unauthorized") ||
		reason.includes("SessionDead") ||
		reason.includes("会话无效") ||
		reason.includes("accessToken") ||
		reason.includes("token 无效") ||
		reason.includes("token失效") ||
		reason.includes("token 失效")
	);
}

function isQuotaFailure(reason: string): boolean {
	if (reason === null) {
		return false;
	}
	return reason.includes("1005") || reason.includes("PlanLimit") || reason.includes("额度") || reason.includes("积分");
}

function cooldownKey(accountId: string): string {
	return `cooldown:${accountId}`;
}
