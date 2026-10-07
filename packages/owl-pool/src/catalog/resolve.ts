/**
 * 模型解析 —— 移植自 manager `catalog/PublishedModelService.resolve` +
 * `CapabilityRequest` + `ModelAccessException`。
 *
 * 能力请求支持 `模型ID@档位` 后缀、reasoning_effort、reasoning.effort（二者不得冲突）、
 * capability_mode（strict/compatible）、max_tokens/max_completion_tokens、context_window。
 * 解析产出按优先级排序的 RouteTarget 列表；主路由按档位精确匹配，
 * 档位集合为主路由子集的备用路由附在末尾并收敛到最近档。
 *
 * 与 manager 的差异（阶段 3 范围）：
 * - withinRouteLimits 的账号级模型快照过滤（WorkBuddy/Trae 快照、SDK bridge 能力）
 *   随阶段 4 的模型快照域接入，此处先做目录级容量判定（discovered 容量表）。
 * - 工具调用续接（ContinuationRegistry）随阶段 4。
 */

import type { EffortApplied, ParsedEffortPolicy } from "../apikey/effort-policy.ts";
import { applyEffortPolicy } from "../apikey/effort-policy.ts";
import {
	convergeEffort,
	EFFORT_ORDER,
	effortRank,
	isKnownEffort,
	nearestEffort,
	normalizeEffort,
} from "../apikey/reasoning-effort-scale.ts";
import type { ApiKey } from "../apikey/types.ts";
import { boundPlatformOf } from "../apikey/types.ts";
import { estimateMaxOutputTokens, estimateTextPromptTokens } from "../gateway/token-estimator.ts";
import type { Platform } from "../platform.ts";
import type { DiscoveredCapacity, ModelRoute, PublishedModel } from "./types.ts";

/** 模型访问异常：带 HTTP 状态与机器码（对齐 ModelAccessException）。 */
export class ModelAccessException extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ModelAccessException";
		this.status = status;
		this.code = code;
	}
}

export interface ResolvedRouteTarget {
	platform: Platform;
	upstreamModel: string;
	priority: number;
	supportsImages: boolean;
	supportsTools: boolean;
	reasoningEfforts: string[];
	/** 兜底路由转发前收敛到的档位；主路由为 null（沿用解析档位）。 */
	effectiveEffort: string | null;
}

export interface ResolvedModel {
	publicId: string;
	routes: ResolvedRouteTarget[];
	modelVersion: string | null;
	defaultReasoningEffort: string | null;
	defaultContextWindow: number | null;
	requestedReasoningEffort: string | null;
	effectiveReasoningEffort: string | null;
	requestedContextWindow: number | null;
	compatible: boolean;
	policyAction: string | null;
	policyRule: string | null;
}

export interface CatalogData {
	findPublishedByPublicId(publicId: string): PublishedModel | undefined;
	routesOf(modelId: string): ModelRoute[];
	findCapacity(platform: Platform, upstreamModel: string): DiscoveredCapacity | undefined;
}

function unsupported(): ModelAccessException {
	return new ModelAccessException(
		400,
		"unsupported_capability",
		"当前模型通道不支持请求的思考、图片、工具、上下文或输出限制",
	);
}

/** 占位模型/路由（如 "placeholder"）不参与解析与上架语义。 */
export function isPlaceholder(value: string): boolean {
	return value.trim().length === 0 || value === "placeholder";
}

export interface ResolveOptions {
	/** Key 级思考策略（null = passthrough）。 */
	effortPolicy?: ParsedEffortPolicy | null;
	nowMs?: number;
}

export function resolveModel(
	key: ApiKey,
	publicModel: string,
	payload: Record<string, unknown>,
	data: CatalogData,
	options: ResolveOptions = {},
): ResolvedModel {
	const capabilities = parseCapabilityRequest(publicModel, payload);
	// Key 级思考策略：映射改写 → 天花板 downgrade/deny；denied 走 403
	const policy: EffortApplied = applyEffortPolicy(
		options.effortPolicy ?? null,
		capabilities.requestedEffort,
		capabilities.publicModel,
	);
	if (policy.denied) {
		throw new ModelAccessException(403, "effort_denied_by_policy", policy.denialReason ?? "思考等级被策略拒绝");
	}
	const model = data.findPublishedByPublicId(capabilities.publicModel);
	if (model === undefined || !model.published || isPlaceholder(model.publicId)) {
		throw new ModelAccessException(404, "model_not_found", "请求的模型未上架");
	}
	if (
		!modelAllowed(key, model.publicId) ||
		(hasPlatformBinding(key) &&
			data.routesOf(model.id).some((route) => route.enabled && routeAllowed(key, route)) === false)
	) {
		throw new ModelAccessException(403, "model_not_allowed", "该 Key 无权使用请求的模型");
	}
	const images =
		containsType(payload.messages, ["image", "image_url", "input_image"]) ||
		containsType(payload.input, ["image", "image_url", "input_image"]);
	const tools =
		isNonEmptyCollection(payload.tools) ||
		isNonEmptyCollection(payload.functions) ||
		containsToolResult(payload.messages) ||
		containsToolResult(payload.input);

	const requestedEffort = capabilities.requestedEffort;
	const policyEffort = policy.effort;
	// 校验与路由匹配都用策略改写后的档位
	const effort = convergeEffort(policyEffort, model.reasoningEfforts, capabilities.compatible);
	const contextWindow = capabilities.contextWindow;
	if (
		(images && !model.supportsImages) ||
		(tools && !model.supportsTools) ||
		(policyEffort !== null && effort === null) ||
		(contextWindow !== null && model.contextWindow !== null && contextWindow > model.contextWindow) ||
		(capabilities.maxOutputTokens !== null &&
			model.maxOutputTokens !== null &&
			capabilities.maxOutputTokens > model.maxOutputTokens)
	) {
		throw unsupported();
	}

	const enabled = data
		.routesOf(model.id)
		.filter((route) => route.enabled)
		.filter((route) => !isPlaceholder(route.upstreamModel))
		.filter((route) => routeAllowed(key, route));
	const base = enabled
		.filter((route) => !images || route.supportsImages)
		.filter((route) => !tools || route.supportsTools)
		.filter((route) => withinRouteLimits(route, capabilities, model.defaultContextWindow, payload, data));
	if (enabled.length > 0 && base.length === 0) {
		throw unsupported();
	}

	// 思考档位是弹性能力：优先走声明了该档位的路由；子集备用路由附在末尾并收敛最近档
	const matched = base.filter((route) => effort === null || route.reasoningEfforts.includes(effort));
	const matchedUnion = [...new Set(matched.flatMap((route) => route.reasoningEfforts))];
	const order = (a: ModelRoute, b: ModelRoute): number =>
		a.priority - b.priority || a.platform.localeCompare(b.platform) || a.upstreamModel.localeCompare(b.upstreamModel);

	const routes: ResolvedRouteTarget[] = matched
		.map((route) => toTarget(route, null))
		.sort(
			(a, b) =>
				a.priority - b.priority ||
				a.platform.localeCompare(b.platform) ||
				a.upstreamModel.localeCompare(b.upstreamModel),
		);
	const matchedIds = new Set(matched.map((route) => route.id));
	for (const route of base.filter((candidate) => !matchedIds.has(candidate.id)).sort(order)) {
		if (matched.length > 0 && !route.reasoningEfforts.every((candidate) => matchedUnion.includes(candidate))) {
			// 档位互斥的专用路由互不兜底
			continue;
		}
		const target = toTarget(route, effort === null ? null : nearestEffort(effort, route.reasoningEfforts));
		if (effort === null || target.effectiveEffort !== null) {
			routes.push(target);
		}
	}
	if (routes.length === 0) {
		throw new ModelAccessException(503, "model_unavailable", "请求的模型暂时无可用路由");
	}
	return {
		publicId: model.publicId,
		routes,
		modelVersion: model.modelVersion,
		defaultReasoningEffort: model.defaultReasoningEffort,
		defaultContextWindow: model.defaultContextWindow,
		requestedReasoningEffort: requestedEffort,
		effectiveReasoningEffort: effort,
		requestedContextWindow: contextWindow,
		compatible: capabilities.compatible,
		policyAction: policy.actions.length === 0 ? null : policy.actions.join(","),
		policyRule: policy.rule,
	};
}

function toTarget(route: ModelRoute, effectiveEffort: string | null): ResolvedRouteTarget {
	return {
		platform: route.platform,
		upstreamModel: route.upstreamModel,
		priority: route.priority,
		supportsImages: route.supportsImages,
		supportsTools: route.supportsTools,
		reasoningEfforts: route.reasoningEfforts,
		effectiveEffort,
	};
}

/** Key 允许清单与平台绑定（对齐 PublishedModelService.allowed/routeAllowed）。 */
export function modelAllowed(key: ApiKey, model: string): boolean {
	if (key.allowedModels === null) {
		return true;
	}
	return key.allowedModels.some((candidate) => candidate.toLowerCase() === model.toLowerCase());
}

function hasPlatformBinding(key: ApiKey): boolean {
	return boundPlatformOf(key) !== null;
}

function routeAllowed(key: ApiKey, route: ModelRoute): boolean {
	const binding = boundPlatformOf(key);
	return binding === null || binding === route.platform;
}

/** 目录级容量判定（账号级快照过滤随阶段 4 接入）。 */
function withinRouteLimits(
	route: ModelRoute,
	capabilities: CapabilityRequest,
	defaultContextWindow: number | null,
	payload: Record<string, unknown>,
	data: CatalogData,
): boolean {
	if (
		capabilities.maxOutputTokens !== null &&
		!capabilities.compatible &&
		(route.platform === "CODEX" || route.platform === "TRAE")
	) {
		// 这些适配器无法执行调用方指定的输出上限
		return false;
	}
	const found = data.findCapacity(route.platform, route.upstreamModel);
	if (found === undefined || !found.available) {
		return false;
	}
	const requestedWindow = capabilities.contextWindow;
	const actualWindow = found.contextWindow;
	if (requestedWindow !== null && (actualWindow === null || actualWindow < requestedWindow)) {
		return false;
	}
	const output = capabilities.maxOutputTokens;
	if (output !== null && found.maxOutputTokens !== null && output > found.maxOutputTokens) {
		return false;
	}
	// 保守准入估算：输入文本 + 输出预留必须装进实际窗口
	if (actualWindow !== null) {
		const estimatedInput = estimateTextPromptTokens(payload);
		const reservedOutput = output ?? estimateMaxOutputTokens(payload);
		if (estimatedInput > actualWindow || reservedOutput > actualWindow - estimatedInput) {
			return false;
		}
	}
	void defaultContextWindow;
	return true;
}

/** 含图片/工具的探测（对齐 containsType/containsToolResult）。 */
function containsType(value: unknown, types: string[]): boolean {
	if (value === null || value === undefined) {
		return false;
	}
	if (Array.isArray(value)) {
		return value.some((item) => containsType(item, types));
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.type === "string" && types.includes(record.type)) {
			return true;
		}
		return Object.values(record).some((child) => containsType(child, types));
	}
	return false;
}

function containsToolResult(value: unknown): boolean {
	if (value === null || value === undefined) {
		return false;
	}
	if (Array.isArray(value)) {
		return value.some((item) => containsToolResult(item));
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.type === "string" && ["tool_result", "tool_call", "function_call"].includes(record.type)) {
			return true;
		}
		return Object.values(record).some((child) => containsToolResult(child));
	}
	return false;
}

function isNonEmptyCollection(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

export interface CapabilityRequest {
	publicModel: string;
	requestedEffort: string | null;
	contextWindow: number | null;
	maxOutputTokens: number | null;
	compatible: boolean;
}

/** 能力请求解析：@档位 后缀、reasoning_effort、reasoning.effort、capability_mode、token 上限。 */
export function parseCapabilityRequest(model: string, payload: Record<string, unknown>): CapabilityRequest {
	let name = (model ?? "").trim();
	let suffixEffort: string | null = null;
	const at = name.lastIndexOf("@");
	if (at >= 0) {
		suffixEffort = effortSuffix(name.slice(at + 1), "模型等级后缀");
		name = name.slice(0, at);
		if (name.length === 0 || name.includes("@")) {
			throw invalidCapability("模型等级后缀格式应为 模型ID@等级");
		}
	}
	const top = effortSuffix(asString(payload.reasoning_effort), "reasoning_effort");
	const reasoning = payload.reasoning;
	if (reasoning !== null && reasoning !== undefined && (typeof reasoning !== "object" || Array.isArray(reasoning))) {
		throw invalidCapability("reasoning 必须是包含 effort 的对象");
	}
	let nested: string | null = null;
	if (typeof reasoning === "object" && reasoning !== null && !Array.isArray(reasoning)) {
		const details = reasoning as Record<string, unknown>;
		nested = effortSuffix(asString(details.effort), "reasoning.effort");
		if (Object.keys(details).some((keyName) => keyName !== "effort")) {
			throw invalidCapability("当前网关仅支持 reasoning.effort，其他思考参数尚无已验证的上游映射");
		}
	}
	if ("thinking" in payload) {
		throw invalidCapability("当前网关不支持直接转发 thinking 参数，请使用已公布的 reasoning_effort");
	}
	if (top !== null && nested !== null && top !== nested) {
		throw invalidCapability("reasoning_effort 与 reasoning.effort 不能冲突");
	}
	const body = top ?? nested;
	if (suffixEffort !== null && body !== null && suffixEffort !== body) {
		throw invalidCapability("模型等级后缀与请求体的思考等级不能冲突");
	}
	const rawMode = payload.capability_mode;
	const mode = rawMode === null || rawMode === undefined ? "strict" : String(rawMode);
	if (rawMode !== null && rawMode !== undefined && typeof rawMode !== "string") {
		throw invalidCapability("capability_mode 只能是 strict 或 compatible");
	}
	if (mode !== "strict" && mode !== "compatible") {
		throw invalidCapability("capability_mode 只能是 strict 或 compatible");
	}
	const maxTokens = positiveLong(payload.max_tokens, "max_tokens");
	const maxCompletion = positiveLong(payload.max_completion_tokens, "max_completion_tokens");
	if (maxTokens !== null && maxCompletion !== null && maxTokens !== maxCompletion) {
		throw invalidCapability("max_tokens 与 max_completion_tokens 不能冲突");
	}
	return {
		publicModel: name,
		requestedEffort: suffixEffort ?? body,
		contextWindow: positiveLong(payload.context_window, "context_window"),
		maxOutputTokens: maxCompletion ?? maxTokens,
		compatible: mode === "compatible",
	};
}

function effortSuffix(value: string | null, field: string): string | null {
	if (value === null) {
		return null;
	}
	if (/^[a-z]{2,32}$/.test(value)) {
		return value;
	}
	throw invalidCapability(`${field} 必须是非空的小写思考等级`);
}

function positiveLong(value: unknown, field: string): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw invalidCapability(`${field} 必须是 JSON 正整数 Token 数`);
	}
	return value;
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function invalidCapability(message: string): ModelAccessException {
	return new ModelAccessException(400, "invalid_capability_request", message);
}

// 刻度导出供调用方审计使用
export { EFFORT_ORDER, effortRank, normalizeEffort, isKnownEffort };
