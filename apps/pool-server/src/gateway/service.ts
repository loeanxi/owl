/**
 * 网关服务 —— 组装 manager `ApiKeyAuthFilter`（认证链）与
 * `GatewayExecutionService`/`GatewayChatDispatcher`（执行与记账）的等价物。
 * 对外形状：/v1/* 错误一律 OpenAI 协议体（/v1/messages 为 Anthropic 体，阶段 4）。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
	type AccountPoolRouter,
	type AccountStore,
	type ApiKey,
	type ApiKeyService,
	BillingService,
	estimateTextPromptTokens,
	GatewayFault,
	ipAllowed,
	isActive,
	type MemoryGatewayState,
	ModelAccessException,
	type Platform,
	type PublishedModel,
	type ResolvedModel,
	type RouteGeneration,
	resolveModel,
	type StickySessionService,
	stickySessionId,
	type UpstreamChatClient,
} from "owl-pool";
import { resolveClientIp } from "../security/client-ip.ts";
import type { SqliteBillingStore } from "../store/billing-store.ts";
import type { GatewayCallLogRecord, SqliteCallLogStore, SqliteCatalogStore } from "../store/gateway-stores.ts";
import { newCallLogId } from "../store/gateway-stores.ts";

export interface GatewayConfig {
	enabled: boolean;
	/** 全局限流（manager: 600/min）。 */
	globalRateLimitPerMinute: number;
	/** 单 IP 限流（manager: 300/min）。 */
	ipRateLimitPerMinute: number;
	/** 网关级 IP 白名单（逗号分隔 CIDR；空不限）。 */
	ipWhitelist: string | null;
	maxRotate: number;
	/** 换号上限（manager: 3）。 */
	accountCooldownMs: number;
	upstreamTimeoutMs: number;
	stickyEnabled: boolean;
	stickyTtlSeconds: number;
}

export interface GatewayServiceDeps {
	config: GatewayConfig;
	state: MemoryGatewayState;
	keys: ApiKeyService;
	accounts: AccountStore;
	router: AccountPoolRouter;
	generation: RouteGeneration;
	sticky: StickySessionService;
	upstreams: Map<Platform, UpstreamChatClient>;
	callLogs: SqliteCallLogStore;
	billing?: BillingService;
	billingStore?: SqliteBillingStore;
	backupDb?: import("node:sqlite").DatabaseSync;
	backupDir?: string;
	catalog: SqliteCatalogStore;
	listPublishedModels(): PublishedModel[];
	trustedProxyCount: number;
	nowMs?(): number;
}

export interface GatewayRejection {
	status: number;
	code: string;
	message: string;
}

export interface AuthenticatedGatewayRequest {
	key: ApiKey;
	requestId: string;
	clientIp: string;
}

/** /v1/* 认证链：请求标识 → 网关开关 → 全局限流 → IP 白名单 → Key 鉴权 → Key 策略 → 单 IP 限流。 */
export function authenticateGatewayRequest(
	deps: GatewayServiceDeps,
	request: IncomingMessage,
): { ok: true; auth: AuthenticatedGatewayRequest } | { ok: false; reject: GatewayRejection } {
	const requestId = randomUUID().replaceAll("-", "");
	if (!deps.config.enabled) {
		return { ok: false, reject: { status: 503, code: "gateway_disabled", message: "API 网关未启用" } };
	}
	const clientIp = resolveClientIp(request, deps.trustedProxyCount);
	// 全局限流：被拒请求也带请求标识（排障链路第一步）
	if (!deps.state.tryAcquireRateLimit("rate:global", deps.config.globalRateLimitPerMinute)) {
		return { ok: false, reject: { status: 429, code: "rate_limit_exceeded", message: "全局限流：请稍后重试" } };
	}
	if (!ipAllowed(deps.config.ipWhitelist, clientIp)) {
		return { ok: false, reject: { status: 403, code: "ip_not_allowed", message: "来源 IP 不在白名单" } };
	}
	const presented = extractKey(request);
	if (presented === null || presented.length === 0) {
		return {
			ok: false,
			reject: { status: 401, code: "missing_api_key", message: "缺少 Authorization: Bearer sk-... 或 x-api-key" },
		};
	}
	const key = deps.keys.authenticate(presented);
	if (key === null) {
		return { ok: false, reject: { status: 401, code: "invalid_api_key", message: "API Key 无效、已吊销或过期" } };
	}
	// Key 级来源白名单
	if (!ipAllowed(key.allowedIps, clientIp)) {
		return { ok: false, reject: { status: 403, code: "ip_not_allowed", message: "来源 IP 不在该 Key 白名单" } };
	}
	// Key 级限流
	if (
		key.rateLimitPerMinute !== null &&
		!deps.state.tryAcquireRateLimit(`rate:key:${key.id}`, key.rateLimitPerMinute)
	) {
		return { ok: false, reject: { status: 429, code: "rate_limit_exceeded", message: "该 Key 触发限流" } };
	}
	// 单 IP 限流
	if (!deps.state.tryAcquireRateLimit(`rate:ip:${clientIp}`, deps.config.ipRateLimitPerMinute)) {
		return { ok: false, reject: { status: 429, code: "rate_limit_exceeded", message: "来源 IP 触发限流" } };
	}
	return { ok: true, auth: { key, requestId, clientIp } };
}

function extractKey(request: IncomingMessage): string | null {
	const auth = request.headers.authorization;
	if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
		return auth.slice(7).trim();
	}
	const xKey = request.headers["x-api-key"];
	if (typeof xKey === "string" && xKey.trim().length > 0) {
		return xKey.trim();
	}
	return null;
}

export interface ChatOutcome {
	body: Record<string, unknown>;
	accountId: string | null;
	platform: string | null;
	usage: [number, number, number] | null;
	usageSource: string;
	produced: boolean;
}

export interface StreamChunk {
	json: string;
}

/** 非流式对话：resolve → 换号执行 → sanitize + 用量记账 + 调用日志。 */
export async function chatCompletion(
	deps: GatewayServiceDeps,
	auth: AuthenticatedGatewayRequest,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const run = new Run(deps, auth, payload);
	// 成员 Key 预占（resolve 之后：模型未上架不扣费）
	const charge = reserveOf(deps, auth, run, payload);
	try {
		const resolution = resolveOf(deps, auth, payload);
		charge.open(resolution.publicId);
		const result = await deps.generation.route(
			{ key: auth.key, payload, resolution, sessionId: run.sessionId },
			async (account, _target, forwarded) => {
				const client = upstreamOf(deps, account.platform);
				const body = await client.chatCompletion(account, forwarded);
				deps.generation.upstreamCompleted = true;
				return { body, accountId: account.id, platform: account.platform };
			},
		);
		run.accountId = result.accountId;
		run.platform = result.platform;
		run.observe(result.body, false);
		const sanitizedBody = sanitizeBody(deps, result.body, run);
		run.produced = true;
		charge.settle(
			run.usageSource === "KNOWN"
				? { promptTokens: run.usage?.[0] ?? -1, completionTokens: run.usage?.[1] ?? -1 }
				: null,
		);
		run.finishOk();
		return sanitizedBody;
	} catch (error) {
		charge.void();
		run.finishFail(error);
		throw error;
	}
}

/** 流式对话：resolve → 换号执行 → chunk 逐段 sanitize 回调（由 HTTP 层写 SSE 帧）。 */
export async function chatCompletionStream(
	deps: GatewayServiceDeps,
	auth: AuthenticatedGatewayRequest,
	payload: Record<string, unknown>,
	onChunk: (chunkJson: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	const run = new Run(deps, auth, payload);
	const charge = reserveOf(deps, auth, run, payload);
	try {
		const resolution = resolveOf(deps, auth, payload);
		charge.open(resolution.publicId);
		await deps.generation.route(
			{ key: auth.key, payload, resolution, sessionId: run.sessionId },
			async (account, _target, forwarded) => {
				const client = upstreamOf(deps, account.platform);
				await client.chatCompletionStream(account, forwarded, (chunkJson) => {
					deps.generation.emitted = true;
					// 上游的 [DONE] 丢弃：流终止符由 HTTP 层统一写（对齐 manager dispatcher 回调）
					if (chunkJson === "[DONE]") {
						return;
					}
					run.observeChunk(chunkJson);
					onChunk(JSON.stringify(sanitizeChunk(deps, chunkJson, run)));
				});
				deps.generation.upstreamCompleted = true;
				run.accountId = account.id;
				run.platform = account.platform;
			},
		);
		run.produced = run.produced || run.sawContent;
		charge.settle(
			run.usageSource === "KNOWN"
				? { promptTokens: run.usage?.[0] ?? -1, completionTokens: run.usage?.[1] ?? -1 }
				: null,
		);
		run.finishOk();
	} catch (error) {
		charge.void();
		run.finishFail(error);
		throw error;
	}
	void signal;
}

/**
 * 成员 Key 计费挂钩：预占 → 结算/退还三段。管理员自用 Key 直通。
 * 预占失败（余额不足）抛 402；resolve 之前不产生任何扣费。
 */
function reserveOf(
	deps: GatewayServiceDeps,
	auth: AuthenticatedGatewayRequest,
	run: Run,
	payload: Record<string, unknown>,
): {
	open(publicModel: string): void;
	settle(usage: { promptTokens: number; completionTokens: number } | null): void;
	void(): void;
} {
	if (deps.billing === undefined || !BillingService.chargeable(auth.key)) {
		return { open() {}, settle() {}, void() {} };
	}
	const pending: { entryId: string; model: string } | null = null;
	void pending;
	const state: { entryId: string | null; publicModel: string | null } = { entryId: null, publicModel: null };
	return {
		open(publicModel: string): void {
			const entry = deps.billing!.reserve(auth.key.ownerMemberId!, auth.key.id, publicModel, payload);
			state.entryId = entry.entryId;
			state.publicModel = publicModel;
			run.billingEntryId = entry.entryId;
		},
		settle(usage): void {
			if (state.entryId !== null) {
				deps.billing!.settle(state.entryId, usage, state.publicModel);
			}
		},
		void(): void {
			if (state.entryId !== null) {
				deps.billing!.voidPending(state.entryId);
			}
		},
	};
}

/** /v1/models：已上架模型按 Key 允许清单过滤。 */
export function listModelsForKey(deps: GatewayServiceDeps, key: ApiKey): Array<Record<string, unknown>> {
	return deps
		.listPublishedModels()
		.filter((model) => model.published)
		.filter(
			(model) =>
				key.allowedModels === null ||
				key.allowedModels.some((allowed) => allowed.toLowerCase() === model.publicId.toLowerCase()),
		)
		.map((model) => ({ id: model.publicId, object: "model", owned_by: "owl-pool" }));
}

function resolveOf(
	deps: GatewayServiceDeps,
	auth: AuthenticatedGatewayRequest,
	payload: Record<string, unknown>,
): ResolvedModel {
	const model = typeof payload.model === "string" ? payload.model : "";
	return resolveModel(auth.key, model, payload, deps.catalog.snapshotCatalog(), {
		effortPolicy: auth.key.effortPolicy,
	});
}

function upstreamOf(deps: GatewayServiceDeps, platform: Platform): UpstreamChatClient {
	const client = deps.upstreams.get(platform);
	if (client === undefined) {
		throw new GatewayFault(503, "platform_unavailable", `平台 ${platform} 的上游通道未接入`);
	}
	return client;
}

/** 统一响应形状：重写 id/model，剥内部字段（对齐 sanitize）。 */
function sanitizeBody(deps: GatewayServiceDeps, body: Record<string, unknown>, run: Run): Record<string, unknown> {
	const sanitized: Record<string, unknown> = { ...body };
	sanitized.id = run.completionId;
	sanitized.model = run.model;
	for (const name of Object.keys(sanitized)) {
		if (name.startsWith("_") || name === "usage_source") {
			delete sanitized[name];
		}
	}
	void deps;
	return sanitized;
}

function sanitizeChunk(deps: GatewayServiceDeps, chunkJson: string, run: Run): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(chunkJson) as unknown;
	} catch {
		throw new GatewayFault(502, "invalid_response", "服务返回了无效响应");
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new GatewayFault(502, "invalid_response", "服务返回了无效响应");
	}
	return sanitizeBody(deps, parsed as Record<string, unknown>, run);
}

/** 单次调用的记账状态（对齐 GatewayExecutionService.Run 的核心面）。 */
class Run {
	readonly completionId = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
	readonly model: string;
	readonly sessionId: string | null;
	readonly startedAt: number;
	accountId: string | null = null;
	platform: string | null = null;
	produced = false;
	sawContent = false;
	usage: [number, number, number] | null = null;
	usageSource = "UNKNOWN";
	cacheReadTokens: number | null = null;
	cacheWriteTokens: number | null = null;
	billingEntryId: string | null = null;

	readonly #deps: GatewayServiceDeps;
	readonly #auth: AuthenticatedGatewayRequest;
	readonly #payload: Record<string, unknown>;

	constructor(deps: GatewayServiceDeps, auth: AuthenticatedGatewayRequest, payload: Record<string, unknown>) {
		this.#deps = deps;
		this.#auth = auth;
		this.#payload = payload;
		this.model = typeof payload.model === "string" ? payload.model : "";
		this.sessionId = stickySessionId(payload, null);
		this.startedAt = deps.nowMs?.() ?? Date.now();
	}

	/** 观察完整响应或 chunk 的 usage/产出（对齐 Run.observe）。 */
	observe(body: Record<string, unknown>, streaming: boolean): void {
		const usage = body.usage;
		if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
			const record = usage as Record<string, unknown>;
			const prompt = signed(record.prompt_tokens);
			const completion = signed(record.completion_tokens);
			const total = signed(record.total_tokens);
			this.usage = [prompt, completion, total];
			this.usageSource = "KNOWN";
			this.cacheReadTokens = signedNested(record.prompt_tokens_details, "cached_tokens");
			this.cacheWriteTokens = signed(record.cache_creation_input_tokens);
		}
		const source = body.usage_source;
		if (typeof source === "string") {
			this.usageSource = source;
		}
		const choices = body.choices;
		if (Array.isArray(choices)) {
			for (const item of choices) {
				if (item === null || typeof item !== "object") {
					continue;
				}
				const choice = item as Record<string, unknown>;
				const message = streaming ? choice.delta : choice.message;
				if (message === null || typeof message !== "object") {
					continue;
				}
				const content = (message as Record<string, unknown>).content;
				if (typeof content === "string" && content.length > 0) {
					this.produced = true;
					this.sawContent = true;
				}
				const reasoning = (message as Record<string, unknown>).reasoning_content;
				if (typeof reasoning === "string" && reasoning.length > 0) {
					this.produced = true;
					this.sawContent = true;
				}
			}
		}
	}

	observeChunk(chunkJson: string): void {
		if (chunkJson === "[DONE]") {
			return;
		}
		try {
			this.observe(JSON.parse(chunkJson) as Record<string, unknown>, true);
		} catch {
			// 非法 chunk 由 sanitize 层报 502
		}
	}

	finishOk(): void {
		this.#write("OK", null, null);
	}

	finishFail(error: unknown): void {
		if (error instanceof ModelAccessException) {
			this.#write("FAIL", error.code, error.message);
			return;
		}
		if (error instanceof GatewayFault) {
			this.#write(this.produced ? "ABORTED" : "FAIL", error.code, error.message);
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		this.#write(this.produced ? "ABORTED" : "FAIL", "upstream_error", message.slice(0, 200));
	}

	#write(status: string, errorCategory: string | null, message: string | null): void {
		const now = this.#deps.nowMs?.() ?? Date.now();
		const [prompt, completion, total] = this.usage ?? [-1, -1, -1];
		const record: GatewayCallLogRecord = {
			id: newCallLogId(),
			keyId: this.#auth.key.id,
			accountId: this.accountId,
			platform: this.platform,
			model: this.model,
			effectiveModel: this.model,
			promptTokens: prompt,
			completionTokens: completion,
			totalTokens: total,
			cacheReadTokens: this.cacheReadTokens,
			cacheWriteTokens: this.cacheWriteTokens,
			latencyMs: now - this.startedAt,
			status,
			message,
			clientIp: this.#auth.clientIp,
			requestId: this.#auth.requestId,
			usageSource: this.usageSource,
			errorCategory,
			occurredAt: now,
		};
		try {
			this.#deps.callLogs.save(record);
		} catch {
			// 日志失败不影响主流程
		}
	}
}

function signed(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : -1;
}

function signedNested(container: unknown, field: string): number | null {
	if (container === null || typeof container !== "object") {
		return null;
	}
	const value = (container as Record<string, unknown>)[field];
	const parsed = signed(value);
	return parsed < 0 ? null : parsed;
}

// isActive 供后续 Key 并发准入使用（阶段 3 范围外）；estimateTextPromptTokens 保留导出面
void isActive;
