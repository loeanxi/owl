/**
 * 成员并发租约 —— 移植自 manager `MemberConcurrencyService`。
 * 0 表示不限。未配置时用默认上限。排队超过等待时间或队列长度则 429。
 */
import { BusinessError, GatewayFault } from "owl-pool";
import type { SqliteMemberStore } from "../store/member-store.ts";

export interface ConcurrencyView {
	configured: number | null;
	effective: number;
	active: number;
	waiting: number;
}

export interface MemberLease {
	close(): void;
}

export class MemberConcurrencyService {
	readonly #members: SqliteMemberStore;
	readonly #defaultLimit: number;
	readonly #maxWaiting: number;
	readonly #waitMillis: number;
	readonly #active = new Map<string, number>();
	readonly #waiting = new Map<string, number>();

	constructor(
		members: SqliteMemberStore,
		options?: { defaultLimit?: number; maxWaiting?: number; waitMillis?: number },
	) {
		this.#members = members;
		this.#defaultLimit = options?.defaultLimit ?? 2;
		this.#maxWaiting = options?.maxWaiting ?? 8;
		this.#waitMillis = options?.waitMillis ?? 2000;
	}

	view(memberId: string): ConcurrencyView {
		const member = this.#members.findById(memberId);
		if (member === undefined) {
			throw BusinessError.of("member.notFound", "成员不存在");
		}
		const configured = member.maxConcurrentRequests;
		return {
			configured,
			effective: configured ?? this.#defaultLimit,
			active: this.#active.get(memberId) ?? 0,
			waiting: this.#waiting.get(memberId) ?? 0,
		};
	}

	update(memberId: string, limit: number | null): ConcurrencyView {
		if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 1000)) {
			throw BusinessError.of("member_concurrency_invalid", "并发上限必须是 0 到 1000 的整数，或留空使用默认值");
		}
		const member = this.#members.findById(memberId);
		if (member === undefined) {
			throw BusinessError.of("member.notFound", "成员不存在");
		}
		member.maxConcurrentRequests = limit;
		member.updatedAt = Date.now();
		this.#members.save(member);
		return this.view(memberId);
	}

	async acquire(memberId: string | null): Promise<MemberLease> {
		if (memberId === null || memberId.trim().length === 0) {
			return { close() {} };
		}
		const member = this.#members.findById(memberId);
		if (member === undefined || !member.enabled) {
			throw new GatewayFault(403, "member_disabled", "成员已停用");
		}
		const limit = member.maxConcurrentRequests ?? this.#defaultLimit;
		if (limit === 0) {
			return { close() {} };
		}
		const deadline = Date.now() + this.#waitMillis;
		let queued = false;
		try {
			for (;;) {
				const active = this.#active.get(memberId) ?? 0;
				if (active < limit) {
					this.#active.set(memberId, active + 1);
					let closed = false;
					return {
						close: () => {
							if (closed) {
								return;
							}
							closed = true;
							this.#active.set(memberId, Math.max(0, (this.#active.get(memberId) ?? 1) - 1));
						},
					};
				}
				const waiting = this.#waiting.get(memberId) ?? 0;
				if (
					this.#waitMillis === 0 ||
					this.#maxWaiting === 0 ||
					waiting >= this.#maxWaiting ||
					Date.now() >= deadline
				) {
					throw new GatewayFault(429, "member_concurrency_limit", "成员并发已满");
				}
				if (!queued) {
					this.#waiting.set(memberId, waiting + 1);
					queued = true;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		} finally {
			if (queued) {
				this.#waiting.set(memberId, Math.max(0, (this.#waiting.get(memberId) ?? 1) - 1));
			}
		}
	}
}
