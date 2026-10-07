/**
 * ApiKeyStore / CatalogData / 调用日志的 SQLite 实现 ——
 * 表结构沿用 manager（api_keys / published_models / published_model_routes / discovered_models / gateway_call_logs）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
	ApiKey,
	DiscoveredCapacity,
	ApiKeyStore as DomainApiKeyStore,
	ModelRoute,
	Platform,
	PublishedModel,
} from "owl-pool";
import { type ParsedEffortPolicy, parseEffortPolicy, serializeEffortPolicy } from "owl-pool";

export class SqliteApiKeyStore implements DomainApiKeyStore {
	readonly #db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	findByHash(hash: string): ApiKey | undefined {
		const row = this.#db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hash);
		return row === undefined ? undefined : rowToKey(row);
	}

	findById(id: string): ApiKey | undefined {
		const row = this.#db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id);
		return row === undefined ? undefined : rowToKey(row);
	}

	list(): ApiKey[] {
		return this.#db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all().map(rowToKey);
	}

	save(key: ApiKey): void {
		this.#db
			.prepare(`
			INSERT INTO api_keys (id, name, key_prefix, key_suffix, key_hash, owner_member_id, parent_key_id,
				revoked_at, bound_platform, allowed_models, effort_policy, allowed_ips, rate_limit_per_minute,
				enabled, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name, key_prefix = excluded.key_prefix, key_suffix = excluded.key_suffix,
				key_hash = excluded.key_hash, owner_member_id = excluded.owner_member_id,
				parent_key_id = excluded.parent_key_id, revoked_at = excluded.revoked_at,
				bound_platform = excluded.bound_platform, allowed_models = excluded.allowed_models,
				effort_policy = excluded.effort_policy, allowed_ips = excluded.allowed_ips,
				rate_limit_per_minute = excluded.rate_limit_per_minute, enabled = excluded.enabled,
				expires_at = excluded.expires_at
		`)
			.run(
				key.id,
				key.name,
				key.keyPrefix,
				key.keySuffix,
				key.keyHash,
				key.ownerMemberId,
				key.parentKeyId,
				key.revokedAt,
				key.boundPlatform,
				key.allowedModels === null ? null : JSON.stringify(key.allowedModels),
				key.effortPolicy === null ? null : serializeEffortPolicy(key.effortPolicy),
				key.allowedIps,
				key.rateLimitPerMinute,
				key.enabled ? 1 : 0,
				key.createdAt,
				key.expiresAt,
			);
	}

	delete(id: string): void {
		this.#db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
	}
}

function rowToKey(row: Record<string, unknown>): ApiKey {
	let effortPolicy: ParsedEffortPolicy | null = null;
	const rawPolicy = row.effort_policy;
	if (typeof rawPolicy === "string" && rawPolicy.length > 0) {
		try {
			effortPolicy = parseEffortPolicy(rawPolicy);
		} catch {
			effortPolicy = null;
		}
	}
	let allowedModels: string[] | null = null;
	const rawModels = row.allowed_models;
	if (typeof rawModels === "string" && rawModels.length > 0) {
		try {
			const parsed: unknown = JSON.parse(rawModels);
			if (Array.isArray(parsed)) {
				allowedModels = parsed.map(String);
			}
		} catch {
			allowedModels = null;
		}
	}
	return {
		id: String(row.id),
		name: String(row.name),
		keyPrefix: String(row.key_prefix),
		keySuffix: row.key_suffix === null || row.key_suffix === undefined ? null : String(row.key_suffix),
		keyHash: String(row.key_hash),
		ownerMemberId: textOrNull(row.owner_member_id),
		parentKeyId: textOrNull(row.parent_key_id),
		revokedAt: numberOrNull(row.revoked_at),
		boundPlatform: textOrNull(row.bound_platform),
		allowedModels,
		effortPolicy,
		allowedIps: textOrNull(row.allowed_ips),
		rateLimitPerMinute: numberOrNull(row.rate_limit_per_minute),
		enabled: Number(row.enabled) === 1,
		createdAt: Number(row.created_at),
		expiresAt: numberOrNull(row.expires_at),
	};
}

export class SqliteCatalogStore {
	readonly #db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	findPublishedByPublicId(publicId: string): PublishedModel | undefined {
		const row = this.#db.prepare("SELECT * FROM published_models WHERE public_id = ?").get(publicId);
		return row === undefined ? undefined : rowToModel(row);
	}

	listModels(): PublishedModel[] {
		return this.#db.prepare("SELECT * FROM published_models ORDER BY sort_order, public_id").all().map(rowToModel);
	}

	saveModel(model: PublishedModel): void {
		this.#db
			.prepare(`
			INSERT INTO published_models (id, public_id, name, description, model_version, context_window,
				default_context_window, default_reasoning_effort, max_output_tokens, supports_images,
				supports_tools, reasoning_efforts, published, sort_order, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				public_id = excluded.public_id, name = excluded.name, description = excluded.description,
				model_version = excluded.model_version, context_window = excluded.context_window,
				default_context_window = excluded.default_context_window,
				default_reasoning_effort = excluded.default_reasoning_effort,
				max_output_tokens = excluded.max_output_tokens, supports_images = excluded.supports_images,
				supports_tools = excluded.supports_tools, reasoning_efforts = excluded.reasoning_efforts,
				published = excluded.published, sort_order = excluded.sort_order, updated_at = excluded.updated_at
		`)
			.run(
				model.id,
				model.publicId,
				model.name,
				model.description,
				model.modelVersion,
				model.contextWindow,
				model.defaultContextWindow,
				model.defaultReasoningEffort,
				model.maxOutputTokens,
				model.supportsImages ? 1 : 0,
				model.supportsTools ? 1 : 0,
				JSON.stringify(model.reasoningEfforts),
				model.published ? 1 : 0,
				model.sortOrder,
				model.updatedAt,
			);
	}

	deleteModel(id: string): void {
		this.#db.prepare("DELETE FROM published_model_routes WHERE model_id = ?").run(id);
		this.#db.prepare("DELETE FROM published_models WHERE id = ?").run(id);
	}

	routesOf(modelId: string): ModelRoute[] {
		return this.#db
			.prepare("SELECT * FROM published_model_routes WHERE model_id = ? ORDER BY priority")
			.all(modelId)
			.map(rowToRoute);
	}

	allRoutes(): ModelRoute[] {
		return this.#db.prepare("SELECT * FROM published_model_routes ORDER BY priority").all().map(rowToRoute);
	}

	saveRoute(route: ModelRoute): void {
		this.#db
			.prepare(`
			INSERT INTO published_model_routes (id, model_id, platform, upstream_model, priority, enabled, supports_images, supports_tools, reasoning_efforts)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				model_id = excluded.model_id, platform = excluded.platform, upstream_model = excluded.upstream_model,
				priority = excluded.priority, enabled = excluded.enabled, supports_images = excluded.supports_images,
				supports_tools = excluded.supports_tools, reasoning_efforts = excluded.reasoning_efforts
		`)
			.run(
				route.id,
				route.modelId,
				route.platform,
				route.upstreamModel,
				route.priority,
				route.enabled ? 1 : 0,
				route.supportsImages ? 1 : 0,
				route.supportsTools ? 1 : 0,
				JSON.stringify(route.reasoningEfforts),
			);
	}

	deleteRoute(id: string): void {
		this.#db.prepare("DELETE FROM published_model_routes WHERE id = ?").run(id);
	}

	findCapacity(platform: Platform, upstreamModel: string): DiscoveredCapacity | undefined {
		const row = this.#db
			.prepare("SELECT * FROM discovered_models WHERE platform = ? AND upstream_model = ?")
			.get(platform, upstreamModel);
		if (row === undefined) {
			return undefined;
		}
		return {
			platform,
			upstreamModel: String(row.upstream_model),
			available: Number(row.available) === 1,
			contextWindow: numberOrNull(row.context_window),
			maxOutputTokens: numberOrNull(row.max_output_tokens),
		};
	}

	saveCapacity(capacity: DiscoveredCapacity): void {
		this.#db
			.prepare(`
			INSERT INTO discovered_models (platform, upstream_model, available, context_window, max_output_tokens, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(platform, upstream_model) DO UPDATE SET
				available = excluded.available, context_window = excluded.context_window,
				max_output_tokens = excluded.max_output_tokens, updated_at = excluded.updated_at
		`)
			.run(
				capacity.platform,
				capacity.upstreamModel,
				capacity.available ? 1 : 0,
				capacity.contextWindow,
				capacity.maxOutputTokens,
				Date.now(),
			);
	}

	/** 供 CatalogData 快照使用（避免每请求多次查询）。 */
	snapshotCatalog(): {
		findPublishedByPublicId(publicId: string): PublishedModel | undefined;
		routesOf(modelId: string): ModelRoute[];
		findCapacity(platform: Platform, upstreamModel: string): DiscoveredCapacity | undefined;
	} {
		return {
			findPublishedByPublicId: (publicId) => this.findPublishedByPublicId(publicId),
			routesOf: (modelId) => this.routesOf(modelId),
			findCapacity: (platform, upstreamModel) => this.findCapacity(platform, upstreamModel),
		};
	}
}

export interface GatewayCallLogRecord {
	id: string;
	keyId: string | null;
	accountId: string | null;
	platform: string | null;
	model: string | null;
	effectiveModel: string | null;
	promptTokens: number | null;
	completionTokens: number | null;
	totalTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	latencyMs: number;
	status: string;
	message: string | null;
	clientIp: string | null;
	requestId: string | null;
	usageSource: string | null;
	errorCategory: string | null;
	occurredAt: number;
}

export class SqliteCallLogStore {
	readonly #db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	save(record: GatewayCallLogRecord): void {
		this.#db
			.prepare(`
			INSERT INTO gateway_call_logs (id, key_id, account_id, platform, model, effective_model,
				prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
				latency_ms, status, message, client_ip, request_id, usage_source, error_category, occurred_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
			.run(
				record.id,
				record.keyId,
				record.accountId,
				record.platform,
				record.model,
				record.effectiveModel,
				record.promptTokens,
				record.completionTokens,
				record.totalTokens,
				record.cacheReadTokens,
				record.cacheWriteTokens,
				record.latencyMs,
				record.status,
				record.message,
				record.clientIp,
				record.requestId,
				record.usageSource,
				record.errorCategory,
				record.occurredAt,
			);
	}

	recent(limit: number): GatewayCallLogRecord[] {
		return this.#db
			.prepare("SELECT * FROM gateway_call_logs ORDER BY occurred_at DESC LIMIT ?")
			.all(limit)
			.map(rowToLog);
	}

	/** 成员用量：只看这名成员自己的 Key，时间窗左闭右开。 */
	forKeys(keyIds: string[], fromMs: number, toMs: number, limit: number): GatewayCallLogRecord[] {
		if (keyIds.length === 0) {
			return [];
		}
		const marks = keyIds.map(() => "?").join(", ");
		return this.#db
			.prepare(
				`SELECT * FROM gateway_call_logs WHERE key_id IN (${marks}) AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC LIMIT ?`,
			)
			.all(...keyIds, fromMs, toMs, limit)
			.map(rowToLog);
	}
}

function rowToLog(row: Record<string, unknown>): GatewayCallLogRecord {
	return {
		id: String(row.id),
		keyId: textOrNull(row.key_id),
		accountId: textOrNull(row.account_id),
		platform: textOrNull(row.platform),
		model: textOrNull(row.model),
		effectiveModel: textOrNull(row.effective_model),
		promptTokens: numberOrNull(row.prompt_tokens),
		completionTokens: numberOrNull(row.completion_tokens),
		totalTokens: numberOrNull(row.total_tokens),
		cacheReadTokens: numberOrNull(row.cache_read_tokens),
		cacheWriteTokens: numberOrNull(row.cache_write_tokens),
		latencyMs: Number(row.latency_ms ?? 0),
		status: String(row.status),
		message: textOrNull(row.message),
		clientIp: textOrNull(row.client_ip),
		requestId: textOrNull(row.request_id),
		usageSource: textOrNull(row.usage_source),
		errorCategory: textOrNull(row.error_category),
		occurredAt: Number(row.occurred_at),
	};
}

export function newCallLogId(): string {
	return randomUUID();
}

function rowToModel(row: Record<string, unknown>): PublishedModel {
	return {
		id: String(row.id),
		publicId: String(row.public_id),
		name: String(row.name),
		description: textOrNull(row.description),
		modelVersion: textOrNull(row.model_version),
		contextWindow: numberOrNull(row.context_window),
		defaultContextWindow: numberOrNull(row.default_context_window),
		defaultReasoningEffort: textOrNull(row.default_reasoning_effort),
		maxOutputTokens: numberOrNull(row.max_output_tokens),
		supportsImages: Number(row.supports_images) === 1,
		supportsTools: Number(row.supports_tools) === 1,
		reasoningEfforts: parseStringArray(row.reasoning_efforts),
		published: Number(row.published) === 1,
		sortOrder: Number(row.sort_order ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
	};
}

function rowToRoute(row: Record<string, unknown>): ModelRoute {
	return {
		id: String(row.id),
		modelId: String(row.model_id),
		platform: String(row.platform) as Platform,
		upstreamModel: String(row.upstream_model),
		priority: Number(row.priority ?? 0),
		enabled: Number(row.enabled) === 1,
		supportsImages: Number(row.supports_images) === 1,
		supportsTools: Number(row.supports_tools) === 1,
		reasoningEfforts: parseStringArray(row.reasoning_efforts),
	};
}

function parseStringArray(raw: unknown): string[] {
	if (typeof raw !== "string" || raw.length === 0) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

function textOrNull(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const parsed = Number(value);
	return Number.isNaN(parsed) ? null : parsed;
}
