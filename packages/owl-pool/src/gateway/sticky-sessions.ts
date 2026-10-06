/**
 * 会话亲和（sticky）—— 移植自 manager `gateway/StickySessionService`。
 * 键 = SHA-256(keyId|模型|平台|上游模型|sessionId)，值 = accountId，TTL 内复用同号。
 * 亲和缓存故障绝不能重放上一次已计费的上游调用：写入失败仅告警。
 */
import { createHash } from "node:crypto";

export interface StickyBinding {
	storageKey: string;
	accountId: string;
}

export interface StickyStateStore {
	get(key: string): string | null;
	put(key: string, value: string, ttlMs: number): void;
	removeIfValue(key: string, value: string): void;
}

export interface StickySessionOptions {
	enabled: boolean;
	/** TTL 秒（manager 默认 900）。 */
	ttlSeconds: number;
	state?: StickyStateStore;
}

export class StickySessionService {
	readonly #options: StickySessionOptions;
	readonly #state: StickyStateStore;

	constructor(options: StickySessionOptions) {
		this.#options = options;
		// 默认内存态；团队部署可换 Redis 实现
		this.#state =
			options.state ??
			new (class implements StickyStateStore {
				readonly #entries = new Map<string, { value: string; expiresAt: number }>();
				get(key: string): string | null {
					const entry = this.#entries.get(key);
					if (entry === undefined) {
						return null;
					}
					if (entry.expiresAt <= Date.now()) {
						this.#entries.delete(key);
						return null;
					}
					return entry.value;
				}
				put(key: string, value: string, ttlMs: number): void {
					this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
				}
				removeIfValue(key: string, value: string): void {
					if (this.#entries.get(key)?.value === value) {
						this.#entries.delete(key);
					}
				}
			})();
	}

	find(
		keyId: string,
		publicModel: string,
		platform: string,
		upstreamModel: string,
		sessionId: string | null,
	): StickyBinding | null {
		if (!this.#options.enabled || sessionId === null) {
			return null;
		}
		const storageKey = this.storageKey(keyId, publicModel, platform, upstreamModel, sessionId);
		const accountId = this.#state.get(storageKey);
		return accountId === null ? null : { storageKey, accountId };
	}

	forget(binding: StickyBinding | null, accountId: string): void {
		if (binding !== null && binding.accountId === accountId) {
			this.#state.removeIfValue(binding.storageKey, binding.accountId);
		}
	}

	bindSuccessful(
		keyId: string,
		publicModel: string,
		platform: string,
		upstreamModel: string,
		sessionId: string | null,
		accountId: string,
	): void {
		if (!this.#options.enabled || sessionId === null) {
			return;
		}
		try {
			this.#state.put(
				this.storageKey(keyId, publicModel, platform, upstreamModel, sessionId),
				accountId,
				this.#options.ttlSeconds * 1000,
			);
		} catch {
			// 亲和写入失败绝不能重放已付费调用，仅吞掉
		}
	}

	storageKey(keyId: string, publicModel: string, platform: string, upstreamModel: string, sessionId: string): string {
		const digest = createHash("sha256");
		for (const part of [keyId, publicModel, platform, upstreamModel, sessionId]) {
			const bytes = Buffer.from(part, "utf8");
			digest.update(Buffer.from(String(bytes.length), "ascii"));
			digest.update(Buffer.from([0x3a]));
			digest.update(bytes);
		}
		return `sticky:${digest.digest("hex")}`;
	}
}

/** 从请求里解析会话 id：X-Session-Id 头 → session_id → conversation_id → metadata 同名。 */
export function stickySessionId(payload: Record<string, unknown>, header: string | null | undefined): string | null {
	const valid = (value: unknown): string | null => {
		if (typeof value !== "string") {
			return null;
		}
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	};
	const fromHeader = valid(header);
	if (fromHeader !== null) {
		return fromHeader;
	}
	const session = valid(payload.session_id);
	if (session !== null) {
		return session;
	}
	const conversation = valid(payload.conversation_id);
	if (conversation !== null) {
		return conversation;
	}
	const metadata = payload.metadata;
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		const record = metadata as Record<string, unknown>;
		return valid(record.session_id) ?? valid(record.conversation_id);
	}
	return null;
}

/** 转发前剥掉亲和字段（上游不认识 session_id/conversation_id 的 sticky 语义）。 */
export function stripStickyFields(forwarded: Record<string, unknown>): void {
	delete forwarded.session_id;
	delete forwarded.conversation_id;
	const metadata = forwarded.metadata;
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		const original = metadata as Record<string, unknown>;
		if ("session_id" in original || "conversation_id" in original) {
			const next: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(original)) {
				if (name !== "session_id" && name !== "conversation_id") {
					next[name] = value;
				}
			}
			if (Object.keys(next).length === 0) {
				delete forwarded.metadata;
			} else {
				forwarded.metadata = next;
			}
		}
	}
}
