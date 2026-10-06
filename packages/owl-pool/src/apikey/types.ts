/**
 * API Key 实体与有效性 —— 移植自 manager `apikey/ApiKey` + `EffectiveKeyPolicy`。
 * 密钥本体只在创建时返回一次，库中仅存 SHA-256 哈希；
 * revokedAt（永久吊销）与 enabled（可逆停用）分离。
 */
import { BusinessError } from "../common/error.ts";
import type { Platform } from "../platform.ts";
import type { ParsedEffortPolicy } from "./effort-policy.ts";
import { intersectIps, validateIpRules } from "./key-ip-policy.ts";

export interface ApiKey {
	id: string;
	name: string;
	/** 前缀展示用，如 wbk_a1b2 */
	keyPrefix: string;
	/** 尾号仅供成员端核对身份，绝不能从哈希反推。 */
	keySuffix: string | null;
	keyHash: string;
	/** null = 管理员自用；成员域（阶段 5）启用。 */
	ownerMemberId: string | null;
	/** 成员子 Key 指向的稳定根 Key。 */
	parentKeyId: string | null;
	revokedAt: number | null;
	/** 绑定平台；null 表示任意。 */
	boundPlatform: string | null;
	/** null 继承全部公开模型；空数组表示无模型可用。 */
	allowedModels: string[] | null;
	/** Key 级思考强度策略（SQLite 存 JSON 文本）。 */
	effortPolicy: ParsedEffortPolicy | null;
	/** 允许来源 IP（逗号分隔 CIDR）；null/空不限。 */
	allowedIps: string | null;
	rateLimitPerMinute: number | null;
	enabled: boolean;
	createdAt: number;
	expiresAt: number | null;
}

export interface ApiKeyInput {
	name: string;
	boundPlatform?: string | null;
	allowedModels?: string[] | null;
	allowedIps?: string | null;
	rateLimitPerMinute?: number | null;
	expiresAt?: number | null;
	effortPolicy?: ParsedEffortPolicy | null;
	/** 成员子 Key 指向的根 Key（继承合并见 resolveEffectiveKey）。 */
	parentKeyId?: string | null;
}

/** Key 处于可用态：未停用、未吊销、未过期。 */
export function isActive(key: ApiKey | null | undefined, nowMs: number): boolean {
	return (
		key !== null &&
		key !== undefined &&
		key.enabled &&
		key.revokedAt === null &&
		(key.expiresAt === null || key.expiresAt > nowMs)
	);
}

/**
 * 有效 Key 视图 —— 移植自 EffectiveKeyPolicy.resolve：
 * 成员子 Key 继承根 Key 的平台绑定/模型交集/IP 交集/限流下限/过期上限/思考策略。
 * 根 Key 无效或归属不一致 → 整体无效。产出脱离存储的副本，不回写继承限制。
 */
export function resolveEffectiveKey(
	stored: ApiKey,
	rootLookup: (id: string) => ApiKey | undefined,
	nowMs: number,
): ApiKey | null {
	if (!isActive(stored, nowMs)) {
		return null;
	}
	if (stored.parentKeyId === null) {
		return { ...stored };
	}
	const parent = rootLookup(stored.parentKeyId);
	if (parent === undefined || !isActive(parent, nowMs) || parent.parentKeyId !== null) {
		return null;
	}
	if (parent.ownerMemberId === null || parent.ownerMemberId !== stored.ownerMemberId) {
		return null;
	}
	const models = intersectModels(stored.allowedModels, parent.allowedModels);
	const ips = intersectIps(stored.allowedIps, parent.allowedIps);
	return {
		...stored,
		boundPlatform: parent.boundPlatform,
		allowedModels: models,
		allowedIps: ips,
		rateLimitPerMinute: minLimit(stored.rateLimitPerMinute, parent.rateLimitPerMinute),
		expiresAt: minTime(stored.expiresAt, parent.expiresAt),
		// 成员不能自写思考改写规则，管理员根 Key 保持权威
		effortPolicy: parent.effortPolicy,
	};
}

/** 入口即校验；库里永远是规范化后的允许清单（对齐 setAllowedModels）。 */
export function normalizeAllowedModels(models: string[] | null | undefined): string[] | null {
	if (models === null || models === undefined) {
		return null;
	}
	if (
		models.length > 1000 ||
		models.some(
			(model) =>
				model === null ||
				model.trim().length === 0 ||
				model.length > 128 ||
				model.includes("/") ||
				model.includes("@"),
		)
	) {
		throw BusinessError.of("apikey.invalidAllowedModels", "模型允许清单必须是公开模型标识数组");
	}
	return [...new Set(models.map((model) => model.trim()))];
}

/** 规范化允许 IP；非法抛错（对齐 KeyIpPolicy.validate）。 */
export function normalizeAllowedIps(ips: string | null | undefined): string | null {
	return validateIpRules(ips);
}

function intersectModels(child: string[] | null, parent: string[] | null): string[] | null {
	if (parent === null) {
		return child;
	}
	if (child === null) {
		return parent;
	}
	const lowerParent = parent.map((model) => model.toLowerCase());
	return child.filter((model) => lowerParent.includes(model.toLowerCase()));
}

function minLimit(child: number | null, parent: number | null): number | null {
	if (parent === null || parent <= 0) {
		return child;
	}
	if (child === null || child <= 0) {
		return parent;
	}
	return Math.min(child, parent);
}

function minTime(child: number | null, parent: number | null): number | null {
	if (parent === null) {
		return child;
	}
	if (child === null || parent < child) {
		return parent;
	}
	return child;
}

/** 平台绑定判断（空字符串统一按 null 语义）。 */
export function boundPlatformOf(key: ApiKey): Platform | null {
	return key.boundPlatform === null || key.boundPlatform.trim().length === 0 ? null : (key.boundPlatform as Platform);
}
