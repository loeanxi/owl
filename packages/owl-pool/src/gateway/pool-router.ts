/**
 * 账号池路由 —— 移植自 manager `gateway/DefaultAccountPoolRouter`。
 * enabled 账号中按剩余积分加权选号（未知积分按权重 1；已知 ≤0 且池内有正积分则跳过），
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

export interface PoolRouterOptions {
	accounts: AccountStore;
	/** 默认冷却毫秒（manager: account-cooldown-ms=60000）。 */
	accountCooldownMs: number;
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
	readonly #nowMs: () => number;
	readonly #cooldownState: PoolRouterOptions["cooldownState"];

	constructor(options: PoolRouterOptions) {
		this.#accounts = options.accounts;
		this.#accountCooldownMs = options.accountCooldownMs;
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

	/** 选号：平台启用账号 → 过滤冷却/失效凭证 → 积分加权随机。 */
	pick(platform: Platform): Account | null {
		const now = this.#nowMs();
		const candidates = this.#accounts
			.list(platform)
			.filter((account) => account.enabled)
			.filter((account) => !hasPersistedCooldown(account, now))
			.filter((account) => account.credentialStatus !== EXPIRED);
		return pickHealthyByCreditWeight(candidates, now, (account) => this.isCooling(account.id));
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
	nowMs: number,
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
