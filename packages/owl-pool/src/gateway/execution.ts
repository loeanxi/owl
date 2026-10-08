/**
 * 网关换号执行 —— 移植自 manager `gateway/GatewayChatDispatcher.route` 的核心语义。
 * 逐 RouteTarget：sticky 优先 → 积分加权选号（单目标最多换 maxRotate 次）→
 * 转发规范化（剥 sticky/能力内部字段、模型改上游名、档位收敛写回）→ 调上游。
 * 失败：AUTH/BAD_REQUEST 不换号直接抛；其余冷却落库 + 换号；
 * gateway_busy 不耗换号预算（本地槽位未打上游）；已产出 chunk 后失败不重试。
 */

import type { AccountStore } from "../account/store.ts";
import type { Account } from "../account/types.ts";
import type { ApiKey } from "../apikey/types.ts";
import type { ResolvedModel, ResolvedRouteTarget } from "../catalog/resolve.ts";
import type { Platform } from "../platform.ts";
import type { AccountPoolRouter } from "./pool-router.ts";
import type { StickyBinding, StickySessionService } from "./sticky-sessions.ts";
import { stripStickyFields } from "./sticky-sessions.ts";
import { GatewayFault, type UpstreamChatClient, UpstreamException } from "./upstream.ts";

export interface RouteGenerationDeps {
	accounts: AccountStore;
	router: AccountPoolRouter;
	sticky: StickySessionService;
	upstreams: Map<Platform, UpstreamChatClient>;
	maxRotate: number;
}

export interface GenerationRequest {
	key: ApiKey;
	payload: Record<string, unknown>;
	resolution: ResolvedModel;
	sessionId: string | null;
	/** 工具续接钉住的账号。只在平台一致时优先于 sticky。 */
	pinnedAccountId?: string | null;
	signal?: AbortSignal;
}

/** Output/completion and continuation routing belong to one request, including its retries. */
export interface GenerationAttemptContext {
	emitted: boolean;
	upstreamCompleted: boolean;
	readonly pinnedAccountId: string | null;
}

/** 上游调用尝试；抛错即按换号语义处理。 */
export type GenerationAttempt<T> = (
	account: Account,
	target: ResolvedRouteTarget,
	forwarded: Record<string, unknown>,
	context: GenerationAttemptContext,
) => Promise<T>;

export class RouteGeneration {
	readonly #deps: RouteGenerationDeps;

	constructor(deps: RouteGenerationDeps) {
		this.#deps = deps;
	}

	async route<T>(request: GenerationRequest, attempt: GenerationAttempt<T>): Promise<T> {
		const context: GenerationAttemptContext = {
			emitted: false,
			upstreamCompleted: false,
			pinnedAccountId: request.pinnedAccountId ?? null,
		};
		request.signal?.throwIfAborted();
		const { key, resolution, sessionId } = request;
		let last: Error | null = null;
		let capacityRejected = false;
		for (const target of resolution.routes) {
			const sticky = this.#deps.sticky.find(
				key.id,
				resolution.publicId,
				target.platform,
				target.upstreamModel,
				sessionId,
			);
			const seen = new Set<string>();
			let index = 0;
			while (index < Math.max(1, this.#deps.maxRotate)) {
				request.signal?.throwIfAborted();
				const selection = this.#pickFor(target, seen, sticky, context);
				const selected = selection.account;
				if (selection.capacityBlocked) {
					capacityRejected = true;
				}
				if (selected === null) {
					break;
				}
				const account = selected;
				if (!account.enabled || account.platform !== target.platform) {
					this.#deps.sticky.forget(sticky, account.id);
					seen.add(account.id);
					continue;
				}
				seen.add(account.id);
				index++;
				const forwarded = this.forwardedPayload(request.payload, target, resolution);
				try {
					const result = await attempt(account, target, forwarded, context);
					request.signal?.throwIfAborted();
					this.#deps.sticky.bindSuccessful(
						key.id,
						resolution.publicId,
						target.platform,
						target.upstreamModel,
						sessionId,
						account.id,
					);
					return result;
				} catch (failure) {
					request.signal?.throwIfAborted();
					if (!(failure instanceof Error)) {
						throw failure;
					}
					// 已产出内容或上游已完成：失败不得变成另一次付费尝试
					if (context.emitted || context.upstreamCompleted) {
						throw failure;
					}
					if (isRequestFailure(failure)) {
						throw failure;
					}
					const busy = failure instanceof GatewayFault && failure.code === "gateway_busy";
					if (!busy) {
						if (failure instanceof UpstreamException) {
							this.#deps.router.markUpstreamFailure(account.id, failure);
						} else {
							this.#deps.router.markFailure(account.id, failureCategory(failure));
						}
						this.#deps.sticky.forget(sticky, account.id);
					}
					last = failure;
					// busy 不耗换号预算
					if (busy) {
						index--;
					}
				}
			}
		}
		if (capacityRejected && last === null) {
			throw new GatewayFault(
				400,
				"unsupported_capability",
				"当前模型通道不支持请求的思考、图片、工具、上下文或输出限制",
			);
		}
		throw last ?? new GatewayFault(503, "model_unavailable", "请求的模型暂时无可用账号");
	}

	#pickFor = (
		target: ResolvedRouteTarget,
		seen: Set<string>,
		sticky: StickyBinding | null,
		context: GenerationAttemptContext,
	): { account: Account | null; capacityBlocked: boolean } => {
		const pinnedId = context.pinnedAccountId;
		if (pinnedId !== null && !seen.has(pinnedId)) {
			const pinned = this.#deps.accounts.get(pinnedId);
			if (pinned?.enabled && pinned.platform === target.platform) {
				return { account: pinned, capacityBlocked: false };
			}
		}
		// sticky 绑定优先
		if (sticky !== null && !seen.has(sticky.accountId)) {
			const bound = this.#deps.accounts.get(sticky.accountId);
			if (bound !== undefined) {
				return { account: bound, capacityBlocked: false };
			}
			this.#deps.sticky.forget(sticky, sticky.accountId);
		}
		const client = this.#deps.upstreams.get(target.platform);
		if (client === undefined) {
			return { account: null, capacityBlocked: false };
		}
		const candidate = this.#deps.router.pick(target.platform);
		if (candidate === null) {
			return { account: null, capacityBlocked: false };
		}
		if (seen.has(candidate.id)) {
			// 池内唯一候选已试过：直接终止本目标，避免死循环
			return { account: null, capacityBlocked: false };
		}
		return { account: candidate, capacityBlocked: false };
	};

	/** 转发规范化：剥 sticky/能力字段、模型改上游名、档位收敛写回、剥内部键。 */
	forwardedPayload(
		original: Record<string, unknown>,
		target: ResolvedRouteTarget,
		resolution: ResolvedModel,
	): Record<string, unknown> {
		const forwarded: Record<string, unknown> = { ...original };
		stripStickyFields(forwarded);
		forwarded.model = target.upstreamModel;
		delete forwarded.capability_mode;
		const effort = target.effectiveEffort ?? resolution.effectiveReasoningEffort;
		if (effort !== null) {
			forwarded.reasoning_effort = effort;
			if (
				forwarded.reasoning !== null &&
				typeof forwarded.reasoning === "object" &&
				!Array.isArray(forwarded.reasoning)
			) {
				forwarded.reasoning = { ...(forwarded.reasoning as Record<string, unknown>), effort };
			}
		}
		// 固定窗口路由上 context_window 是准入语义，不是上游旋钮
		delete forwarded.context_window;
		// 内部键（_managerRequestId 等）不出网
		for (const name of Object.keys(forwarded)) {
			if (name.startsWith("_")) {
				delete forwarded[name];
			}
		}
		return forwarded;
	}
}

/** AUTH/BAD_REQUEST 属于请求性失败：换号无意义，直接抛给客户端。 */
function isRequestFailure(failure: Error): boolean {
	if (
		failure instanceof GatewayFault &&
		["upstream_timeout", "upstream_stream_idle_timeout", "upstream_stream_interrupted"].includes(failure.code)
	)
		return true;
	if (failure instanceof UpstreamException) {
		return failure.kind === "AUTH" || failure.kind === "BAD_REQUEST";
	}
	return false;
}

function failureCategory(failure: Error): string {
	return failure.message.length > 0 ? failure.message.slice(0, 200) : "unknown";
}
