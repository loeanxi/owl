import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, OpenAICompletionsCompat, ThinkingLevelMap } from "../types.ts";

/**
 * owl:loean 厂商——对接本仓 pool-server 号池网关（OpenAI 兼容：
 * GET /v1/models、POST /v1/chat/completions，Bearer 网关 Key 鉴权）。
 *
 * 模型目录是动态的：管理端「发现 → 核验 → 上架」公开模型后，这里 refresh 时拉
 * /v1/models 生成条目，避免手工在 models.json 抄能力值导致的上架值漂移 400。
 */

/** 默认网关：本机 pool-server（apps/pool-server，默认 127.0.0.1:8790）。 */
export const DEFAULT_LOEAN_BASE_URL = "http://127.0.0.1:8790/v1";

/** 网关未公布能力值时的保守缺省。 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 32_768;

/** 网关 reasoning_effort 的思考强度排序（rank 越大思考越重；xhigh 为 GLM/Qoder 系公布档）。 */
const EFFORT_RANK: Readonly<Record<string, number>> = {
	none: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "max"] as const;

/** 归一化网关地址：补协议、缺路径时补 /v1、去尾斜杠；解析失败回退默认网关。 */
export function normalizeLoeanBaseUrl(value: string): string {
	const fallback = (): string => DEFAULT_LOEAN_BASE_URL;
	const trimmed = value.trim();
	if (!trimmed) return fallback();
	const withScheme = /^https?:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return fallback();
	}
	if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1";
	return url.toString().replace(/\/+$/u, "");
}

/** 网关地址：LOEAN_BASE_URL 覆盖默认值（浏览器环境无 process，退回默认）。 */
export function resolveLoeanBaseUrl(): string {
	if (
		typeof process !== "undefined" &&
		typeof process.env?.LOEAN_BASE_URL === "string" &&
		process.env.LOEAN_BASE_URL.trim()
	) {
		return normalizeLoeanBaseUrl(process.env.LOEAN_BASE_URL);
	}
	return DEFAULT_LOEAN_BASE_URL;
}

/** /v1/models 行里我们关心的字段（OpenAI 基础形状 + Manager 公布的能力值与协议方言）。 */
export interface LoeanCatalogRow {
	id?: unknown;
	context_window?: unknown;
	max_output_tokens?: unknown;
	reasoning_efforts?: unknown;
	input_modalities?: unknown;
	/** 该模型上游的 OpenAI 兼容方言。缺省时仍发最朴素的 completions 请求。 */
	compat?: unknown;
}

const THINKING_FORMATS = [
	"openai",
	"openrouter",
	"deepseek",
	"together",
	"baseten",
	"zai",
	"qwen",
	"chat-template",
	"qwen-chat-template",
	"string-thinking",
	"ant-ling",
] as const satisfies readonly NonNullable<OpenAICompletionsCompat["thinkingFormat"]>[];

function catalogField(record: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

function catalogBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
	const value = catalogField(record, ...keys);
	return typeof value === "boolean" ? value : undefined;
}

/**
 * 网关按模型公布的方言盖过「最朴素 OpenAI」缺省。未公布的字段留给 URL 自动探测。
 * camelCase 与 snake_case 都认，避免目录序列化风格把回放格式丢掉。
 */
export function loeanCompatFromCatalog(value: unknown, reasoning: boolean): OpenAICompletionsCompat {
	const compat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		maxTokensField: "max_tokens",
		...(reasoning ? { supportsReasoningEffort: true } : {}),
	};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return compat;
	const record = value as Record<string, unknown>;
	const assignBoolean = (key: keyof OpenAICompletionsCompat, ...names: string[]) => {
		const parsed = catalogBoolean(record, ...names);
		if (parsed !== undefined) (compat as Record<string, unknown>)[key] = parsed;
	};
	assignBoolean("supportsStore", "supportsStore", "supports_store");
	assignBoolean("supportsDeveloperRole", "supportsDeveloperRole", "supports_developer_role");
	assignBoolean("supportsReasoningEffort", "supportsReasoningEffort", "supports_reasoning_effort");
	assignBoolean("supportsUsageInStreaming", "supportsUsageInStreaming", "supports_usage_in_streaming");
	assignBoolean("supportsFinishReason", "supportsFinishReason", "supports_finish_reason");
	assignBoolean("requiresToolResultName", "requiresToolResultName", "requires_tool_result_name");
	assignBoolean(
		"requiresAssistantAfterToolResult",
		"requiresAssistantAfterToolResult",
		"requires_assistant_after_tool_result",
	);
	assignBoolean("requiresThinkingAsText", "requiresThinkingAsText", "requires_thinking_as_text");
	assignBoolean(
		"requiresReasoningContentOnAssistantMessages",
		"requiresReasoningContentOnAssistantMessages",
		"requires_reasoning_content",
	);
	const maxTokensField = catalogField(record, "maxTokensField", "max_tokens_field");
	if (maxTokensField === "max_tokens" || maxTokensField === "max_completion_tokens") {
		compat.maxTokensField = maxTokensField;
	}
	const thinkingFormat = catalogField(record, "thinkingFormat", "thinking_format");
	if (typeof thinkingFormat === "string" && THINKING_FORMATS.some((format) => format === thinkingFormat)) {
		compat.thinkingFormat = thinkingFormat as (typeof THINKING_FORMATS)[number];
	}
	return compat;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseEfforts(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

const INPUT_MODALITIES = ["text", "image"] as const;
type InputModality = (typeof INPUT_MODALITIES)[number];

function parseInputModalities(value: unknown): InputModality[] {
	if (!Array.isArray(value)) return [];
	const allowed = new Set<string>(INPUT_MODALITIES);
	return value.filter((entry): entry is InputModality => typeof entry === "string" && allowed.has(entry));
}

/**
 * 网关未公布 input_modalities 时的兜底：按模型 id 关键词保守判断图像能力。
 * deepseek-v4.1-flash 等多模态变体通常命中 flash / vl / vision；其余纯文本模型保持 text。
 */
const VISION_ID_PATTERN = /\b(vision|vl|flash|vlite)\b/iu;

/**
 * pi 思考档位 → 网关 reasoning_effort：精确命中用之；否则按 manager 方针
 * 「先向上取整（只多不少），无更高才向下」，两侧都没有则标记该档不支持（null）。
 */
export function thinkingLevelMapFromEfforts(efforts: string[]): ThinkingLevelMap {
	const known = efforts
		.filter((effort) => EFFORT_RANK[effort] !== undefined)
		.map((effort) => ({ effort, rank: EFFORT_RANK[effort]! }));
	const map: ThinkingLevelMap = {};
	for (const level of PI_THINKING_LEVELS) {
		const target = EFFORT_RANK[level]!;
		const exact = known.find((entry) => entry.rank === target);
		if (exact) {
			map[level] = exact.effort;
			continue;
		}
		const upward = known.filter((entry) => entry.rank > target).sort((a, b) => a.rank - b.rank)[0];
		map[level] =
			upward?.effort ??
			known.filter((entry) => entry.rank < target).sort((a, b) => b.rank - a.rank)[0]?.effort ??
			null;
	}
	return map;
}

/** 把 /v1/models 响应（{data:[…]} 或裸数组）映射为 openai-completions 模型条目，按 id 稳定排序。 */
export function loeanModelsFromCatalog(
	providerId: string,
	baseUrl: string,
	payload: unknown,
): Model<"openai-completions">[] {
	const rows = Array.isArray(payload) ? payload : ((payload as { data?: unknown } | null)?.data ?? []);
	if (!Array.isArray(rows)) throw new Error("Loean gateway /models: unexpected payload shape");
	const models: Model<"openai-completions">[] = [];
	for (const row of rows as LoeanCatalogRow[]) {
		if (typeof row?.id !== "string" || row.id.length === 0) continue;
		const efforts = parseEfforts(row.reasoning_efforts);
		const reasoning = efforts.some((effort) => effort !== "none");
		const modalities = parseInputModalities(row.input_modalities);
		const input: InputModality[] =
			modalities.includes("image") || VISION_ID_PATTERN.test(row.id) ? ["text", "image"] : ["text"];
		const publishedWindow = positiveInt(row.context_window);
		models.push({
			id: row.id,
			name: row.id,
			api: "openai-completions",
			provider: providerId,
			baseUrl,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: publishedWindow ?? FALLBACK_CONTEXT_WINDOW,
			contextWindowConfirmed: publishedWindow !== undefined,
			maxTokens: positiveInt(row.max_output_tokens) ?? FALLBACK_MAX_TOKENS,
			reasoning,
			...(reasoning ? { thinkingLevelMap: thinkingLevelMapFromEfforts(efforts) } : {}),
			type: "chat",
			// 缺省仍是最朴素的 completions 请求；网关若公布 thinking_format 等方言则按条覆盖。
			compat: loeanCompatFromCatalog(row.compat, reasoning),
		});
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchLoeanModels(context: RefreshModelsContext): Promise<Model<"openai-completions">[]> {
	if (!context.allowNetwork || context.signal.aborted) return [];
	const credential = context.credential;
	const apiKey =
		credential?.type === "api_key" ? credential.key : credential?.type === "oauth" ? credential.access : undefined;
	if (!apiKey) return []; // 未配网关 Key：保持空目录，不发无名请求
	const baseUrl = resolveLoeanBaseUrl();
	const response = await fetch(new URL("models", `${baseUrl}/`), {
		headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (context.signal.aborted) return [];
	if (!response.ok) {
		const body = (await response.text().catch(() => "")).trim().slice(0, 512);
		throw new Error(`Loean gateway /models ${response.status}${body ? `: ${body}` : ""}`);
	}
	const payload: unknown = await response.json();
	return loeanModelsFromCatalog("loean", baseUrl, payload);
}

/** Loean：本仓 pool-server 号池（OpenAI 兼容），目录从网关 /v1/models 动态刷新。 */
export function loeanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "loean",
		name: "Loean",
		baseUrl: resolveLoeanBaseUrl(),
		auth: { apiKey: envApiKeyAuth("Loean API key", ["LOEAN_API_KEY"]) },
		models: [],
		fetchModels: fetchLoeanModels,
		api: openAICompletionsApi(),
	});
}
