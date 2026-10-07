/**
 * API Key / 模型目录的管理端 REST —— 移植自 manager
 * `ApiKeyController` + `PublishedModelController`（阶段 3 子集）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
	type ApiKeyService,
	BusinessError,
	isPlatform,
	type ModelRoute,
	type PublishedModel,
	parseEffortPolicy,
} from "owl-pool";
import type { SqliteCallLogStore, SqliteCatalogStore } from "../store/gateway-stores.ts";
import { adminBudgetView, saveAdminBudget } from "../store/key-budget.ts";
import type { Router } from "./router.ts";

export interface KeyAdminRoutesDeps {
	keys: ApiKeyService;
	db?: DatabaseSync;
}

function adminBudgetOf(deps: KeyAdminRoutesDeps, keyId: string): Record<string, unknown> {
	const key = rootOf(deps, keyId);
	return adminBudgetView(requireBudgetDb(deps), key.key, key.root);
}

function rootOf(
	deps: KeyAdminRoutesDeps,
	keyId: string,
): { key: ReturnType<ApiKeyService["require"]>; root: ReturnType<ApiKeyService["require"]> } {
	const key = deps.keys.require(keyId);
	const root = key.parentKeyId === null ? key : deps.keys.require(key.parentKeyId);
	return { key, root };
}

function requireBudgetDb(deps: KeyAdminRoutesDeps): DatabaseSync {
	if (deps.db === undefined) {
		throw BusinessError.of("billing.budgetUnavailable", "预算存储未启用");
	}
	return deps.db;
}

function amountOrNull(value: unknown): string | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	return String(value);
}

function keyView(key: ReturnType<ApiKeyService["list"]>[number]): Record<string, unknown> {
	return {
		id: key.id,
		name: key.name,
		keyPrefix: key.keyPrefix,
		keySuffix: key.keySuffix,
		ownerMemberId: key.ownerMemberId,
		boundPlatform: key.boundPlatform,
		allowedModels: key.allowedModels,
		allowedIps: key.allowedIps,
		rateLimitPerMinute: key.rateLimitPerMinute ?? -1,
		enabled: key.enabled,
		revokedAt: key.revokedAt,
		createdAt: key.createdAt,
		expiresAt: key.expiresAt,
	};
}

export function registerKeyAdminRoutes(router: Router, deps: KeyAdminRoutesDeps): void {
	router.get("/api/keys/:id/budget", async (ctx) => adminBudgetOf(deps, ctx.params.id ?? ""));

	router.put("/api/keys/:id/budget", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		const key = rootOf(deps, ctx.params.id ?? "");
		return saveAdminBudget(requireBudgetDb(deps), key.key, key.root, {
			total: amountOrNull(body.total),
			daily: amountOrNull(body.daily),
			weekly: amountOrNull(body.weekly),
		});
	});

	router.get("/api/keys", async () => deps.keys.list().map(keyView));

	router.post("/api/keys", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		const name = asString(body.name)?.trim() ?? "";
		if (name.length === 0) {
			throw BusinessError.of("apikey.nameRequired", "Key 名称不能为空");
		}
		const created = deps.keys.create({
			name,
			boundPlatform: asString(body.boundPlatform) ?? null,
			allowedModels: stringArray(body.allowedModels),
			allowedIps: asString(body.allowedIps) ?? null,
			rateLimitPerMinute: intOrNull(body.rateLimitPerMinute),
			expiresAt: intOrNull(body.expiresAt),
			effortPolicy: parseEffortPolicyBody(body.effort_policy ?? body.effortPolicy),
		});
		// 明文只出现一次
		return { ...keyView(created.key), plaintext: created.plaintext };
	});

	router.get("/api/keys/:id", async (ctx) => keyView(deps.keys.require(ctx.params.id!)));

	router.patch("/api/keys/:id", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		return keyView(
			deps.keys.update(ctx.params.id!, {
				name: asString(body.name) ?? undefined,
				boundPlatform:
					body.bound_platform === undefined
						? body.boundPlatform === undefined
							? undefined
							: (body.boundPlatform as string | null)
						: (body.bound_platform as string | null),
				allowedModels: body.allowed_models === undefined ? undefined : (body.allowed_models as string[] | null),
				allowedIps: body.allowed_ips === undefined ? undefined : (body.allowed_ips as string | null),
				rateLimitPerMinute:
					body.rate_limit_per_minute === undefined ? undefined : (body.rate_limit_per_minute as number | null),
				expiresAt: body.expires_at === undefined ? undefined : (body.expires_at as number | null),
				enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
			}),
		);
	});

	router.patch("/api/keys/:id/enabled", async (ctx) => {
		const raw = ctx.query.get("enabled") ?? String((await ctx.readBody<Record<string, unknown>>()).enabled ?? "");
		if (raw !== "true" && raw !== "false") {
			throw BusinessError.of("apikey.badEnabled", "enabled 参数只接受 true/false");
		}
		return keyView(deps.keys.update(ctx.params.id!, { enabled: raw === "true" }));
	});

	// 软禁用（对齐 DELETE /api/keys/{id} 的 manager 语义：吊销）
	router.delete("/api/keys/:id", async (ctx) => {
		deps.keys.revoke(ctx.params.id!);
		return { revoked: true };
	});

	// 物理删除
	router.delete("/api/keys/:id/permanent", async (ctx) => {
		deps.keys.delete(ctx.params.id!);
		return { deleted: true };
	});
}

export interface ModelAdminRoutesDeps {
	catalog: SqliteCatalogStore;
}

export function registerModelAdminRoutes(router: Router, deps: ModelAdminRoutesDeps): void {
	router.get("/api/models", async () =>
		deps.catalog.listModels().map((model) => ({
			...modelView(model),
			routes: deps.catalog.routesOf(model.id).map(routeView),
		})),
	);

	router.post("/api/models", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		const model = modelFromBody(body, randomUUID());
		deps.catalog.saveModel(model);
		const routes = routesFromBody(body, model.id);
		for (const route of routes) {
			deps.catalog.saveRoute(route);
		}
		return { ...modelView(model), routes: deps.catalog.routesOf(model.id).map(routeView) };
	});

	router.get("/api/models/:id", async (ctx) => {
		const model = requireModel(deps, ctx.params.id!);
		return { ...modelView(model), routes: deps.catalog.routesOf(model.id).map(routeView) };
	});

	router.put("/api/models/:id", async (ctx) => {
		const existing = requireModel(deps, ctx.params.id!);
		const body = await ctx.readBody<Record<string, unknown>>();
		const model = modelFromBody(body, existing.id, existing);
		deps.catalog.saveModel(model);
		return { ...modelView(model), routes: deps.catalog.routesOf(model.id).map(routeView) };
	});

	router.delete("/api/models/:id", async (ctx) => {
		requireModel(deps, ctx.params.id!);
		deps.catalog.deleteModel(ctx.params.id!);
		return { deleted: true };
	});

	router.post("/api/models/:id/routes", async (ctx) => {
		const model = requireModel(deps, ctx.params.id!);
		const body = await ctx.readBody<Record<string, unknown>>();
		const route: ModelRoute = {
			id: randomUUID(),
			modelId: model.id,
			platform: parsePlatform(body.platform),
			upstreamModel: asString(body.upstreamModel)?.trim() ?? "",
			priority: intOrNull(body.priority) ?? 0,
			enabled: body.enabled === undefined ? true : body.enabled === true,
			supportsImages: body.supportsImages === true,
			supportsTools: body.supportsTools === true,
			reasoningEfforts: stringArray(body.reasoningEfforts) ?? [],
		};
		if (route.upstreamModel.length === 0) {
			throw BusinessError.of("catalog.upstreamModelRequired", "上游模型名不能为空");
		}
		deps.catalog.saveRoute(route);
		return routeView(route);
	});

	router.delete("/api/models/:id/routes/:routeId", async (ctx) => {
		deps.catalog.deleteRoute(ctx.params.routeId!);
		return { deleted: true };
	});

	// 上架/下架
	router.patch("/api/models/:id/published", async (ctx) => {
		const model = requireModel(deps, ctx.params.id!);
		const raw = ctx.query.get("published") ?? String((await ctx.readBody<Record<string, unknown>>()).published ?? "");
		if (raw !== "true" && raw !== "false") {
			throw BusinessError.of("catalog.badPublished", "published 参数只接受 true/false");
		}
		const next = { ...model, published: raw === "true" };
		deps.catalog.saveModel(next);
		return modelView(next);
	});
}

function requireModel(deps: ModelAdminRoutesDeps, id: string): PublishedModel {
	const model = deps.catalog.listModels().find((candidate) => candidate.id === id);
	if (model === undefined) {
		throw BusinessError.of("catalog.notFound", `模型不存在: ${id}`);
	}
	return model;
}

function modelFromBody(body: Record<string, unknown>, id: string, existing?: PublishedModel): PublishedModel {
	const publicId = (asString(body.publicId) ?? existing?.publicId ?? "").trim();
	if (publicId.length === 0 || publicId.includes("/") || publicId.includes("@")) {
		throw BusinessError.of("catalog.invalidPublicId", "公开模型标识不能为空，且不能含 / 或 @");
	}
	return {
		id,
		publicId,
		name: asString(body.name)?.trim() || publicId,
		description: asString(body.description) ?? existing?.description ?? null,
		modelVersion: asString(body.modelVersion) ?? existing?.modelVersion ?? null,
		contextWindow: intOrNull(body.contextWindow) ?? existing?.contextWindow ?? null,
		defaultContextWindow: intOrNull(body.defaultContextWindow) ?? existing?.defaultContextWindow ?? null,
		defaultReasoningEffort: asString(body.defaultReasoningEffort) ?? existing?.defaultReasoningEffort ?? null,
		maxOutputTokens: intOrNull(body.maxOutputTokens) ?? existing?.maxOutputTokens ?? null,
		supportsImages:
			body.supportsImages === undefined ? (existing?.supportsImages ?? false) : body.supportsImages === true,
		supportsTools:
			body.supportsTools === undefined ? (existing?.supportsTools ?? false) : body.supportsTools === true,
		reasoningEfforts: stringArray(body.reasoningEfforts) ?? existing?.reasoningEfforts ?? [],
		published: body.published === undefined ? (existing?.published ?? false) : body.published === true,
		sortOrder: intOrNull(body.sortOrder) ?? existing?.sortOrder ?? 0,
		updatedAt: Date.now(),
	};
}

function routesFromBody(body: Record<string, unknown>, modelId: string): ModelRoute[] {
	const raw = body.routes;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map((item) => {
		const record = (item ?? {}) as Record<string, unknown>;
		return {
			id: randomUUID(),
			modelId,
			platform: parsePlatform(record.platform),
			upstreamModel: asString(record.upstreamModel)?.trim() ?? "",
			priority: intOrNull(record.priority) ?? 0,
			enabled: record.enabled === undefined ? true : record.enabled === true,
			supportsImages: record.supportsImages === true,
			supportsTools: record.supportsTools === true,
			reasoningEfforts: stringArray(record.reasoningEfforts) ?? [],
		};
	});
}

function modelView(model: PublishedModel): Record<string, unknown> {
	return {
		id: model.id,
		publicId: model.publicId,
		name: model.name,
		description: model.description,
		modelVersion: model.modelVersion,
		contextWindow: model.contextWindow,
		defaultContextWindow: model.defaultContextWindow,
		defaultReasoningEffort: model.defaultReasoningEffort,
		maxOutputTokens: model.maxOutputTokens,
		supportsImages: model.supportsImages,
		supportsTools: model.supportsTools,
		reasoningEfforts: model.reasoningEfforts,
		published: model.published,
		sortOrder: model.sortOrder,
	};
}

function routeView(route: ModelRoute): Record<string, unknown> {
	return {
		id: route.id,
		modelId: route.modelId,
		platform: route.platform,
		upstreamModel: route.upstreamModel,
		priority: route.priority,
		enabled: route.enabled,
		supportsImages: route.supportsImages,
		supportsTools: route.supportsTools,
		reasoningEfforts: route.reasoningEfforts,
	};
}

export function registerGatewayAdminRoutes(
	router: Router,
	deps: { callLogs: SqliteCallLogStore; catalog: SqliteCatalogStore },
): void {
	router.get("/api/gateway/logs", async (ctx) => {
		const limit = Number.parseInt(ctx.query.get("limit") ?? "50", 10);
		return deps.callLogs.recent(Number.isNaN(limit) ? 50 : limit);
	});
}

function parsePlatform(value: unknown): ModelRoute["platform"] {
	if (!isPlatform(value)) {
		throw BusinessError.of("catalog.badPlatform", `未知平台: ${String(value)}`);
	}
	return value;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function intOrNull(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number.parseInt(value, 10);
		if (!Number.isNaN(parsed)) {
			return parsed;
		}
	}
	return null;
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	return value.map(String);
}

/** effort_policy 接受对象或 JSON 字符串；解析失败抛业务错误。 */
function parseEffortPolicyBody(value: unknown): ReturnType<typeof parseEffortPolicy> {
	if (value === null || value === undefined) {
		return null;
	}
	const json = typeof value === "string" ? value : JSON.stringify(value);
	return parseEffortPolicy(json);
}
