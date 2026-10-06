/**
 * 固定窗口限流 + 进程内共享状态 —— 移植自 manager
 * `gateway/FixedWindowRateLimiter` + `state/MemorySchedulerStateStore`。
 *
 * 窗口推进与计数清零必须同一步完成（先清零再加数会有窗口边界超发竞态）。
 * Redis 共享态在团队部署需要时再加（接口面保持一致）。
 */

/** 固定窗口限流器：每个 Key/IP 一个实例。 */
export class FixedWindowRateLimiter {
	static readonly WINDOW_MS = 60_000;

	readonly #limitPerMinute: number;
	#windowStartMs = 0;
	#count = 0;

	constructor(limitPerMinute: number) {
		this.#limitPerMinute = limitPerMinute;
	}

	get limitPerMinute(): number {
		return this.#limitPerMinute;
	}

	tryAcquire(nowMs: number = Date.now()): boolean {
		if (this.#limitPerMinute <= 0) {
			return true;
		}
		if (nowMs - this.#windowStartMs >= FixedWindowRateLimiter.WINDOW_MS) {
			this.#windowStartMs = nowMs;
			this.#count = 0;
		}
		this.#count++;
		return this.#count <= this.#limitPerMinute;
	}
}

/**
 * 网关共享键值态（限流计数、账号冷却、sticky 绑定）。
 * 值带可选过期时间；get 过期即删。冷却/绑定跨重启恢复由 SQLite 落库补齐。
 */
export class MemoryGatewayState {
	readonly #entries = new Map<string, { value: string; expiresAt: number | null }>();

	get(key: string, nowMs: number = Date.now()): string | null {
		const entry = this.#entries.get(key);
		if (entry === undefined) {
			return null;
		}
		if (entry.expiresAt !== null && entry.expiresAt <= nowMs) {
			this.#entries.delete(key);
			return null;
		}
		return entry.value;
	}

	put(key: string, value: string, ttlMs: number | null = null, nowMs: number = Date.now()): void {
		this.#entries.set(key, { value, expiresAt: ttlMs === null ? null : nowMs + Math.max(1, ttlMs) });
	}

	extendTtl(key: string, value: string, ttlMs: number, nowMs: number = Date.now()): void {
		this.put(key, value, ttlMs, nowMs);
	}

	remove(key: string): void {
		this.#entries.delete(key);
	}

	/** 仅当值匹配时删除（sticky forget 防误删他人绑定）。 */
	removeIfValue(key: string, value: string): void {
		if (this.#entries.get(key)?.value === value) {
			this.#entries.delete(key);
		}
	}

	/** 限流原子操作：窗口推进与清零同步完成（对齐 tryAcquireRateLimit 语义）。 */
	tryAcquireRateLimit(key: string, limitPerMinute: number, nowMs: number = Date.now()): boolean {
		const limiter = this.#limiters.get(key) ?? this.#newLimiter(key, limitPerMinute);
		return limiter.tryAcquire(nowMs);
	}

	#limiters = new Map<string, FixedWindowRateLimiter>();

	#newLimiter(key: string, limitPerMinute: number): FixedWindowRateLimiter {
		// 已有限流器但配置变化时重建（保守：以新限额为准）
		const existing = this.#limiters.get(key);
		if (existing !== undefined && existing.limitPerMinute === limitPerMinute) {
			return existing;
		}
		const limiter = new FixedWindowRateLimiter(limitPerMinute);
		this.#limiters.set(key, limiter);
		return limiter;
	}
}
