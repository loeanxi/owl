/**
 * 工具续接登记 —— 移植自 manager `ContinuationRegistry`。
 * 只记路由标识（key、模型、账号、tool_call id），不记提示词和工具结果。
 * 找不到、过期、模型不一致或一次请求钉住两个账号时，退回普通选号，不把请求打失败。
 */
import type { ApiKey } from "owl-pool";
import { GatewayFault } from "owl-pool";

export interface ContinuationPin {
	keyId: string;
	model: string;
	accountId: string;
	expiresAt: number;
	claimed: boolean;
}

const DEFAULT_TTL_SECONDS = 900;
const DEFAULT_MAX_PENDING = 100;

export class ContinuationRegistry {
	readonly #pending = new Map<string, ContinuationPin>();
	readonly #ttlMs: number;
	readonly #maxPending: number;

	constructor(options?: { ttlSeconds?: number; maxPendingTurns?: number }) {
		this.#ttlMs = Math.max(30, options?.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
		this.#maxPending = Math.max(1, options?.maxPendingTurns ?? DEFAULT_MAX_PENDING);
	}

	bind(key: ApiKey, model: string, accountId: string, callIds: string[]): void {
		this.#sweep();
		const ids = callIds.filter((id) => id.trim().length > 0);
		if (ids.length === 0) {
			return;
		}
		if (this.#pending.size + ids.length > this.#maxPending * 32) {
			throw new GatewayFault(503, "gateway_busy", "工具续接队列已满");
		}
		const keyId = requireKeyId(key);
		for (const id of ids) {
			if (this.#pending.has(`${keyId}:${id}`)) {
				throw new GatewayFault(502, "duplicate_tool_identifier", "模型返回了重复的工具标识，请重试");
			}
		}
		const pin: ContinuationPin = {
			keyId,
			model,
			accountId,
			expiresAt: Date.now() + this.#ttlMs,
			claimed: false,
		};
		for (const id of ids) {
			this.#pending.set(`${keyId}:${id}`, pin);
		}
	}

	/** 最近一串 tool 结果都能对上同一根针时返回它，并立刻占住，避免两个请求抢同一回合。 */
	find(key: ApiKey, model: string, payload: Record<string, unknown>): ContinuationPin | null {
		const results = latestToolResults(payload);
		const ids = Object.keys(results);
		if (ids.length === 0) {
			return null;
		}
		const keyId = requireKeyId(key);
		let selected: ContinuationPin | null = null;
		for (const id of ids) {
			const pin = this.#pending.get(`${keyId}:${id}`);
			if (pin === undefined || pin.expiresAt <= Date.now() || pin.model !== model) {
				return null;
			}
			if (selected !== null && selected !== pin) {
				return null;
			}
			selected = pin;
		}
		if (selected === null || selected.claimed) {
			return null;
		}
		selected.claimed = true;
		return selected;
	}

	consume(key: ApiKey, payload: Record<string, unknown>): void {
		const keyId = requireKeyId(key);
		for (const id of Object.keys(latestToolResults(payload))) {
			this.#pending.delete(`${keyId}:${id}`);
		}
	}

	#sweep(): void {
		const now = Date.now();
		for (const [id, pin] of this.#pending) {
			if (pin.expiresAt <= now) {
				this.#pending.delete(id);
			}
		}
	}
}

export function assistantToolCallIds(body: Record<string, unknown>): string[] {
	const choices = body.choices;
	if (!Array.isArray(choices)) {
		return [];
	}
	const ids: string[] = [];
	for (const choice of choices) {
		if (choice === null || typeof choice !== "object") {
			continue;
		}
		const message = (choice as Record<string, unknown>).message;
		if (message === null || typeof message !== "object") {
			continue;
		}
		const calls = (message as Record<string, unknown>).tool_calls;
		if (!Array.isArray(calls)) {
			continue;
		}
		for (const call of calls) {
			if (call !== null && typeof call === "object") {
				const id = (call as Record<string, unknown>).id;
				if (typeof id === "string" && id.length > 0) {
					ids.push(id);
				}
			}
		}
	}
	return ids;
}

/** 从消息尾部收集尚未被下一条 assistant 覆盖的 tool 结果。历史里已经闭合的工具交换不算续接。 */
export function latestToolResults(payload: Record<string, unknown>): Record<string, unknown> {
	const messages = payload.messages;
	if (!Array.isArray(messages)) {
		return {};
	}
	const results: Record<string, unknown> = {};
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === null || typeof message !== "object") {
			continue;
		}
		const record = message as Record<string, unknown>;
		const role = String(record.role ?? "");
		if (role === "assistant") {
			const calls = record.tool_calls;
			if (!Array.isArray(calls) || calls.length === 0) {
				return {};
			}
			const declared = new Set<string>();
			for (const call of calls) {
				if (call !== null && typeof call === "object") {
					const id = (call as Record<string, unknown>).id;
					if (typeof id === "string") {
						declared.add(id);
					}
				}
			}
			for (const id of Object.keys(results)) {
				if (!declared.has(id)) {
					throw new GatewayFault(400, "invalid_tool_result", "工具结果与最近的工具调用不匹配");
				}
			}
			return results;
		}
		if (role === "tool") {
			const id = record.tool_call_id;
			if (typeof id !== "string" || id.trim().length === 0) {
				throw new GatewayFault(400, "invalid_tool_result", "工具结果缺少调用标识");
			}
			if (id in results) {
				throw new GatewayFault(400, "duplicate_tool_result", "工具结果中存在重复调用标识");
			}
			results[id] = record.content ?? null;
		}
	}
	return results;
}

function requireKeyId(key: ApiKey): string {
	if (key.id.trim().length === 0) {
		throw new GatewayFault(401, "invalid_api_key", "调用凭证无效");
	}
	return key.id;
}
