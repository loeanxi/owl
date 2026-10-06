/**
 * API Key 服务 —— 移植自 manager `apikey/DefaultApiKeyService` + `ApiKeyService`。
 * 明文 `sk-` + 32 位随机串只出现一次；库存 SHA-256、前缀（11 位展示）与尾号（4 位核对）。
 */
import { randomBytes } from "node:crypto";
import { BusinessError } from "../common/error.ts";
import { sha256Hex } from "../gateway/crypto-lite.ts";
import type { Platform } from "../platform.ts";
import type { ParsedEffortPolicy } from "./effort-policy.ts";
import {
	type ApiKey,
	type ApiKeyInput,
	normalizeAllowedIps,
	normalizeAllowedModels,
	resolveEffectiveKey,
} from "./types.ts";

export interface ApiKeyStore {
	findByHash(hash: string): ApiKey | undefined;
	findById(id: string): ApiKey | undefined;
	list(): ApiKey[];
	save(key: ApiKey): void;
	delete(id: string): void;
}

export interface CreatedKey {
	key: ApiKey;
	/** 明文，只在创建/轮换时返回一次。 */
	plaintext: string;
}

const KEY_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface ApiKeyServiceOptions {
	store: ApiKeyStore;
	/** 成员有效性检查（成员域阶段 5 接入）；返回 false 时该成员的 Key 全部无效。 */
	memberEnabled?(memberId: string): boolean;
	nowMs?(): number;
}

export class ApiKeyService {
	readonly #store: ApiKeyStore;
	readonly #memberEnabled?: (memberId: string) => boolean;
	readonly #nowMs: () => number;

	constructor(options: ApiKeyServiceOptions) {
		this.#store = options.store;
		this.#memberEnabled = options.memberEnabled;
		this.#nowMs = options.nowMs ?? (() => Date.now());
	}

	/** 创建 Key；返回的 plaintext 只出现一次。 */
	create(input: ApiKeyInput & { ownerMemberId?: string | null }): CreatedKey {
		const plaintext = `sk-${randomToken(32)}`;
		const now = this.#nowMs();
		const key: ApiKey = {
			id: crypto.randomUUID(),
			name: input.name,
			keyPrefix: plaintext.slice(0, 11),
			keySuffix: plaintext.slice(-4),
			keyHash: sha256Hex(plaintext),
			ownerMemberId: input.ownerMemberId ?? null,
			parentKeyId: input.parentKeyId ?? null,
			revokedAt: null,
			boundPlatform: input.boundPlatform ?? null,
			allowedModels: normalizeAllowedModels(input.allowedModels),
			effortPolicy: input.effortPolicy ?? null,
			allowedIps: normalizeAllowedIps(input.allowedIps),
			rateLimitPerMinute: input.rateLimitPerMinute ?? null,
			enabled: true,
			createdAt: now,
			expiresAt: input.expiresAt ?? null,
		};
		this.#store.save(key);
		return { key, plaintext };
	}

	/** 用明文鉴权：哈希查表 → 有效性 → 成员子 Key 继承合并。 */
	authenticate(presentedKey: string | null | undefined): ApiKey | null {
		if (presentedKey === null || presentedKey === undefined || presentedKey.trim().length === 0) {
			return null;
		}
		const hash = sha256Hex(presentedKey.trim());
		const stored = this.#store.findByHash(hash);
		if (stored === undefined) {
			return null;
		}
		return this.effective(stored);
	}

	/** 有效性判定 + 子 Key 继承合并（rootLookup 走本服务存储）。 */
	effective(stored: ApiKey): ApiKey | null {
		if (
			stored.ownerMemberId !== null &&
			this.#memberEnabled !== undefined &&
			!this.#memberEnabled(stored.ownerMemberId)
		) {
			return null;
		}
		return resolveEffectiveKey(stored, (id) => this.#store.findById(id), this.#nowMs());
	}

	list(): ApiKey[] {
		return this.#store.list();
	}

	require(id: string): ApiKey {
		const key = this.#store.findById(id);
		if (key === undefined) {
			throw BusinessError.of("apikey.notFound", `API Key 不存在: ${id}`, { id });
		}
		return key;
	}

	/** 永久吊销（区别于可逆停用）。 */
	revoke(id: string): void {
		const key = this.require(id);
		this.#store.save({ ...key, enabled: false, revokedAt: this.#nowMs() });
	}

	/** 物理删除；成员专属 Key 需走成员管理（成员域阶段 5 接入）。 */
	delete(id: string): void {
		const key = this.require(id);
		if (key.ownerMemberId !== null && key.ownerMemberId.trim().length > 0) {
			throw BusinessError.of("apikey.memberKeyNotDeletable", "成员专属 Key 不能直接删除，请通过成员管理处理");
		}
		this.#store.delete(id);
	}

	/** 局部更新；clear* 语义由 HTTP 层用显式字段表达。 */
	update(
		id: string,
		patch: Partial<{
			name: string;
			boundPlatform: string | null;
			allowedModels: string[] | null;
			allowedIps: string | null;
			rateLimitPerMinute: number | null;
			expiresAt: number | null;
			effortPolicy: ParsedEffortPolicy | null;
			enabled: boolean;
		}>,
	): ApiKey {
		const key = this.require(id);
		const next: ApiKey = { ...key };
		if (patch.name !== undefined && patch.name.trim().length > 0) {
			next.name = patch.name.trim();
		}
		if (patch.boundPlatform !== undefined) {
			next.boundPlatform =
				patch.boundPlatform === null || patch.boundPlatform.trim().length === 0 ? null : patch.boundPlatform.trim();
		}
		if (patch.allowedModels !== undefined) {
			next.allowedModels = normalizeAllowedModels(patch.allowedModels);
		}
		if (patch.allowedIps !== undefined) {
			next.allowedIps = normalizeAllowedIps(patch.allowedIps);
		}
		if (patch.rateLimitPerMinute !== undefined) {
			next.rateLimitPerMinute =
				patch.rateLimitPerMinute !== null && patch.rateLimitPerMinute > 0 ? patch.rateLimitPerMinute : null;
		}
		if (patch.expiresAt !== undefined) {
			next.expiresAt = patch.expiresAt;
		}
		if (patch.effortPolicy !== undefined) {
			next.effortPolicy = patch.effortPolicy;
		}
		if (patch.enabled !== undefined) {
			next.enabled = patch.enabled;
			// 管理员显式恢复时才清吊销标记
			if (patch.enabled) {
				next.revokedAt = null;
			}
		}
		this.#store.save(next);
		return next;
	}

	/** 轮换凭据：换明文/哈希/前缀尾号，其余策略保留；返回新明文。 */
	rotateCredential(id: string): CreatedKey {
		const key = this.require(id);
		const plaintext = `sk-${randomToken(32)}`;
		this.#store.save({
			...key,
			keyHash: sha256Hex(plaintext),
			keyPrefix: plaintext.slice(0, 11),
			keySuffix: plaintext.slice(-4),
		});
		return { key: this.require(id), plaintext };
	}
}

/** 平台绑定（网关路由用）。 */
export function keyBoundPlatform(key: ApiKey): Platform | null {
	return key.boundPlatform === null || key.boundPlatform.trim().length === 0 ? null : (key.boundPlatform as Platform);
}

function randomToken(length: number): string {
	const charset = KEY_CHARSET;
	let out = "";
	const bytes = randomBytes(length);
	for (let i = 0; i < length; i++) {
		out += charset[bytes[i]! % charset.length];
	}
	return out;
}
