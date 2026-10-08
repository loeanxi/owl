/**
 * 上游 Chat 转发 SPI —— 移植自 manager `gateway/UpstreamChatClient` + `UpstreamException`。
 * 输入输出保持 OpenAI 兼容 JSON 形状；流式实现须把上游 SSE 转成 OpenAI chunk
 * （data: {...}\n\n + data: [DONE]），JSON 字符串不含 data: 前缀回调。
 */
import type { Account } from "../account/types.ts";
import type { Platform } from "../platform.ts";

/** 上游异常分类，驱动冷却时长与是否可换号。 */
export type UpstreamErrorKind = "BAD_REQUEST" | "RATE" | "AUTH" | "QUOTA" | "SERVER";

export class UpstreamException extends Error {
	readonly kind: UpstreamErrorKind;
	/** 上游 Retry-After 秒数（RATE/SERVER 时参与冷却计算）。 */
	readonly retryAfterSeconds: number | null;

	constructor(kind: UpstreamErrorKind, message: string, retryAfterSeconds: number | null = null) {
		super(message);
		this.name = "UpstreamException";
		this.kind = kind;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** 网关层受控错误（HTTP 状态 + 机器码），对齐 manager GatewayFault。 */
export class GatewayFault extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "GatewayFault";
		this.status = status;
		this.code = code;
	}
}

export interface UpstreamChatClient {
	/** 本客户端支持的平台。 */
	platform(): Platform;

	/** 非流式对话；上游只回 SSE 时实现侧本地聚合。 */
	chatCompletion(
		account: Account,
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;

	/** 流式对话；OpenAI chunk JSON 字符串逐段回调（不含 data: 前缀，以 [DONE] 结束）。 */
	chatCompletionStream(
		account: Account,
		payload: Record<string, unknown>,
		onChunk: (openAiChunkJson: string) => void,
		signal?: AbortSignal,
	): Promise<void>;
}

/** 网关可直连的平台集合（bridge/codex 类在阶段 4 以各自运行时接入）。 */
export function isDirectChatPlatform(platform: Platform): boolean {
	return ["WORKBUDDY", "TRAE", "ZCODE", "MIMO", "CLAUDE", "GEMINI", "GROK"].includes(platform);
}
