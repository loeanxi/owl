/**
 * 请求侧 Token 估算 —— 移植自 manager `gateway/TokenEstimator`（请求侧部分）。
 * 只用于并发准入与容量预检，不是上游 tokenizer 的证明；
 * 上下文预检用纯文本估算，不把图片 base64 传输体当可见文本。
 */

/** 与 Anthropic 协议映射保持一致的经验值。 */
const CHARS_PER_TOKEN = 4.0;
/** 单次请求最多预占的输出 token（防客户端声明超大 max_tokens 独占额度）。 */
export const MAX_RESERVE_OUTPUT = 32_768;
/** 默认输出上限（未声明 max_tokens 时）。 */
export const DEFAULT_OUTPUT = 2_048;

/** 估算输入 token（system/prompt/messages/tools 字符数 / 4，含 base64 媒体）。 */
export function estimatePromptTokens(payload: Record<string, unknown> | null): number {
	if (payload === null) {
		return 0;
	}
	const chars =
		textLength(payload.system) +
		textLength(payload.prompt) +
		textLength(payload.messages) +
		textLength(payload.tools);
	return chars <= 0 ? 0 : Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

/** 纯文本准入估算：messages 内的 image_url 等 media 字段不计入。 */
export function estimateTextPromptTokens(payload: Record<string, unknown> | null): number {
	if (payload === null) {
		return 0;
	}
	const chars =
		textLengthForContext(payload.system) +
		textLengthForContext(payload.prompt) +
		textLengthForContext(payload.messages) +
		textLengthForContext(payload.tools);
	return chars <= 0 ? 0 : Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

/** 输出上限：max_tokens / max_completion_tokens 优先，兜底 DEFAULT_OUTPUT，封顶 32k。 */
export function estimateMaxOutputTokens(payload: Record<string, unknown> | null): number {
	let declared = asLong(payload === null ? null : payload.max_tokens);
	if (declared <= 0) {
		declared = asLong(payload === null ? null : payload.max_completion_tokens);
	}
	if (declared <= 0) {
		declared = DEFAULT_OUTPUT;
	}
	return Math.min(declared, MAX_RESERVE_OUTPUT);
}

function textLength(value: unknown): number {
	if (typeof value === "string") {
		return value.length;
	}
	if (Array.isArray(value)) {
		return value.reduce((sum: number, item) => sum + textLength(item), 0);
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value as Record<string, unknown>).reduce((sum: number, item) => sum + textLength(item), 0);
	}
	return 0;
}

/** 纯文本长度：跳过 image_url / input_image / file 类 content part 的传输体。 */
function textLengthForContext(value: unknown): number {
	if (typeof value === "string") {
		return value.length;
	}
	if (Array.isArray(value)) {
		return value.reduce((sum: number, item) => sum + textLengthForContext(item), 0);
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const type = record.type;
		if (typeof type === "string" && ["image_url", "input_image", "image", "file", "input_audio"].includes(type)) {
			return 0;
		}
		return Object.values(record).reduce((sum: number, item) => sum + textLengthForContext(item), 0);
	}
	return 0;
}

function asLong(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	return 0;
}
