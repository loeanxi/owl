/**
 * 成员自建 Key —— 移植自 manager `MemberKeyService` 的创建/修改/轮换/撤销。
 * 根 Key 仍由管理员发放；成员只能在根 Key 的权限范围内增删子 Key。
 */
import {
	type ApiKey,
	type ApiKeyService,
	BusinessError,
	isActive,
	isIpSubset,
	resolveEffectiveKey,
	validateIpRules,
} from "owl-pool";
import type { SqliteCatalogStore } from "../store/gateway-stores.ts";
import type { MemberRecord } from "../store/member-store.ts";

const MAX_KEYS = 20;
const EDIT_FIELDS = new Set(["name", "allowedModels", "allowedIps", "rateLimitPerMinute", "expiresAt", "enabled"]);

export interface MemberKeyMutationDeps {
	keys: ApiKeyService;
	catalog: SqliteCatalogStore;
}

export function createMemberKey(
	deps: MemberKeyMutationDeps,
	member: MemberRecord,
	body: Record<string, unknown>,
): { key: ApiKey; plaintext: string } {
	requireEnabled(member);
	assertFields(body, true);
	const owned = ownedKeys(deps.keys, member.id);
	if (owned.filter((key) => key.revokedAt === null).length >= MAX_KEYS) {
		throw BusinessError.of("member.keyLimit", `当前最多保留 ${MAX_KEYS} 把未撤销 Key，请先撤销不用的 Key`);
	}
	const parentId = typeof body.parentKeyId === "string" ? body.parentKeyId : null;
	const root = parentId === null ? defaultRoot(owned) : ownedRoot(owned, parentId);
	const draft = readDraft(body, root, deps.catalog, true);
	const created = deps.keys.create({
		name: draft.name,
		ownerMemberId: member.id,
		parentKeyId: root.id,
		boundPlatform: root.boundPlatform,
		allowedModels: draft.allowedModels,
		allowedIps: draft.allowedIps,
		rateLimitPerMinute: draft.rateLimitPerMinute,
		expiresAt: draft.expiresAt,
	});
	if (!draft.enabled) {
		deps.keys.update(created.key.id, { enabled: false });
	}
	return { key: deps.keys.require(created.key.id), plaintext: created.plaintext };
}

export function updateMemberKey(
	deps: MemberKeyMutationDeps,
	member: MemberRecord,
	keyId: string,
	body: Record<string, unknown>,
): ApiKey {
	requireEnabled(member);
	assertFields(body, false);
	const child = mutableChild(deps.keys, member.id, keyId);
	const root = ownedRoot(ownedKeys(deps.keys, member.id), child.parentKeyId ?? "");
	const draft = readDraft(body, root, deps.catalog, false);
	return deps.keys.update(child.id, {
		name: draft.name,
		allowedModels: body.allowedModels === undefined ? undefined : draft.allowedModels,
		allowedIps: body.allowedIps === undefined ? undefined : draft.allowedIps,
		rateLimitPerMinute: body.rateLimitPerMinute === undefined ? undefined : draft.rateLimitPerMinute,
		expiresAt: body.expiresAt === undefined ? undefined : draft.expiresAt,
		enabled: body.enabled === undefined ? undefined : draft.enabled,
	});
}

export function rotateMemberKey(
	deps: MemberKeyMutationDeps,
	member: MemberRecord,
	keyId: string,
): {
	key: ApiKey;
	plaintext: string;
} {
	requireEnabled(member);
	const child = mutableChild(deps.keys, member.id, keyId);
	const rotated = deps.keys.rotateCredential(child.id);
	return { key: rotated.key, plaintext: rotated.plaintext };
}

export function revokeMemberKey(deps: MemberKeyMutationDeps, member: MemberRecord, keyId: string): void {
	requireEnabled(member);
	const key = ownedKey(deps.keys, member.id, keyId);
	if (key.parentKeyId === null) {
		throw BusinessError.of("member.keyRootManaged", "授权 Key 由管理员维护");
	}
	deps.keys.revoke(key.id);
}

export function usableMemberKey(keys: ApiKeyService, memberId: string, keyId: string | null): ApiKey {
	const owned = ownedKeys(keys, memberId);
	const lookup = (id: string) => owned.find((key) => key.id === id) ?? keys.list().find((key) => key.id === id);
	const now = Date.now();
	if (keyId !== null && keyId.length > 0) {
		const key = owned.find((item) => item.id === keyId);
		if (key === undefined) {
			throw BusinessError.of("member.keyNotFound", "Key 不存在");
		}
		const effective = resolveEffectiveKey(key, lookup, now);
		if (effective === null) {
			throw BusinessError.of("member.keyUnavailable", "所选 Key 已停用、撤销或过期");
		}
		return effective;
	}
	for (const wantRoot of [true, false]) {
		for (const key of owned) {
			if ((key.parentKeyId === null) === wantRoot) {
				const effective = resolveEffectiveKey(key, lookup, now);
				if (effective !== null) {
					return effective;
				}
			}
		}
	}
	throw BusinessError.of("member.noApiKey", "暂无可用 Key，请联系管理员");
}

interface Draft {
	name: string;
	allowedModels: string[] | null;
	allowedIps: string | null;
	rateLimitPerMinute: number | null;
	expiresAt: number | null;
	enabled: boolean;
}

function readDraft(body: Record<string, unknown>, root: ApiKey, catalog: SqliteCatalogStore, creating: boolean): Draft {
	const name = readName(body, creating);
	return {
		name,
		allowedModels: body.allowedModels === undefined ? null : readModels(body.allowedModels, root, catalog),
		allowedIps: body.allowedIps === undefined ? null : readIps(body.allowedIps, root),
		rateLimitPerMinute: body.rateLimitPerMinute === undefined ? null : readRpm(body.rateLimitPerMinute, root),
		expiresAt: body.expiresAt === undefined ? null : readExpiry(body.expiresAt, root),
		enabled: body.enabled === undefined ? true : readEnabled(body.enabled),
	};
}

function readName(body: Record<string, unknown>, creating: boolean): string {
	if (!creating && body.name === undefined) {
		return "";
	}
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (name.length < 1 || name.length > 64) {
		throw BusinessError.of("member.keyInvalidName", "Key 名称需为 1–64 个字符");
	}
	return name;
}

function readModels(value: unknown, root: ApiKey, catalog: SqliteCatalogStore): string[] | null {
	if (value === null) {
		return null;
	}
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw BusinessError.of("member.keyInvalidModels", "请选择公开模型");
	}
	const models = value.map((item) => item.trim()).filter((item) => item.length > 0);
	const published = new Set(
		catalog
			.listModels()
			.filter((model) => model.published)
			.map((model) => model.publicId.toLowerCase()),
	);
	const ceiling = root.allowedModels?.map((model) => model.toLowerCase()) ?? null;
	for (const model of models) {
		const id = model.toLowerCase();
		if ((ceiling !== null && !ceiling.includes(id)) || (published.size > 0 && !published.has(id))) {
			throw BusinessError.of("member.keyPermissionExceeded", "模型权限不能超出管理员授权范围");
		}
	}
	return models;
}

function readIps(value: unknown, root: ApiKey): string | null {
	if (value !== null && typeof value !== "string") {
		throw BusinessError.of("member.keyInvalidIps", "IP 限制格式无效");
	}
	const ips = validateIpRules(typeof value === "string" ? value : null);
	if (!isIpSubset(ips, root.allowedIps)) {
		throw BusinessError.of("member.keyPermissionExceeded", "来源限制不能超出管理员授权范围");
	}
	return ips;
}

function readRpm(value: unknown, root: ApiKey): number | null {
	if (value === null) {
		return null;
	}
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw BusinessError.of("member.keyInvalidRate", "每分钟请求数必须是正整数");
	}
	if (root.rateLimitPerMinute !== null && root.rateLimitPerMinute > 0 && value > root.rateLimitPerMinute) {
		throw BusinessError.of("member.keyPermissionExceeded", "请求频率不能超出管理员授权范围");
	}
	return value;
}

function readExpiry(value: unknown, root: ApiKey): number | null {
	if (value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw BusinessError.of("member.keyInvalidExpiry", "请填写有效的到期时间");
	}
	const expiry = Date.parse(value);
	if (Number.isNaN(expiry) || expiry <= Date.now()) {
		throw BusinessError.of("member.keyInvalidExpiry", "到期时间必须晚于当前时间");
	}
	if (root.expiresAt !== null && expiry > root.expiresAt) {
		throw BusinessError.of("member.keyPermissionExceeded", "到期时间不能晚于管理员授权时间");
	}
	return expiry;
}

function readEnabled(value: unknown): boolean {
	if (typeof value !== "boolean") {
		throw BusinessError.of("member.keyInvalidRequest", "启用状态格式无效");
	}
	return value;
}

function assertFields(body: Record<string, unknown>, creating: boolean): void {
	for (const field of Object.keys(body)) {
		if (!EDIT_FIELDS.has(field) && !(creating && field === "parentKeyId")) {
			throw BusinessError.of("member.keyInvalidRequest", "包含不可修改的 Key 设置");
		}
	}
}

function requireEnabled(member: MemberRecord): void {
	if (!member.enabled) {
		throw BusinessError.of("member.disabled", "成员账号已停用");
	}
}

function ownedKeys(keys: ApiKeyService, memberId: string): ApiKey[] {
	return keys.list().filter((key) => key.ownerMemberId === memberId);
}

function defaultRoot(owned: ApiKey[]): ApiKey {
	const now = Date.now();
	const root = owned.find((key) => key.parentKeyId === null && isActive(key, now));
	if (root === undefined) {
		throw BusinessError.of("member.keyRootUnavailable", "暂无可用授权 Key，请联系管理员");
	}
	return root;
}

function ownedRoot(owned: ApiKey[], id: string): ApiKey {
	const root = owned.find((key) => key.id === id && key.parentKeyId === null);
	if (root === undefined || !isActive(root, Date.now())) {
		throw BusinessError.of("member.keyRootUnavailable", "当前授权 Key 不可用，请联系管理员");
	}
	return root;
}

function ownedKey(keys: ApiKeyService, memberId: string, id: string): ApiKey {
	const key = keys.list().find((item) => item.id === id);
	if (key === undefined || key.ownerMemberId !== memberId) {
		throw BusinessError.of("member.keyNotFound", "Key 不存在");
	}
	return key;
}

function mutableChild(keys: ApiKeyService, memberId: string, id: string): ApiKey {
	const key = ownedKey(keys, memberId, id);
	if (key.parentKeyId === null) {
		throw BusinessError.of("member.keyRootManaged", "授权 Key 由管理员维护");
	}
	if (key.revokedAt !== null) {
		throw BusinessError.of("member.keyRevoked", "已撤销的 Key 不能恢复，请新建 Key");
	}
	return key;
}
