/**
 * Per-provider model listing for the settings page 「拉取模型」.
 *
 * One export (`listProviderModelIds`) the bridge dynamic-imports from the
 * plugin dist: reads image-gen.json for keys/endpoints/proxy (same config the
 * generation tools use) and calls each provider's models endpoint. Listing is
 * best-effort: failures degrade to an empty list plus a human-readable error,
 * never a throw — the model input stays free-text either way.
 */
import { doFetch, installApiKeys, loadConfig, type OwlImageConfig, resolveApiKey, setAmbientProxy } from "./config.ts";
import { redactSecrets } from "./redact.ts";
import {
	DEFAULT_GOOGLE_ENDPOINT,
	DEFAULT_GOOGLE_SUB_MODEL,
	DEFAULT_OPENAI_BASE_URL,
	DEFAULT_SEEDREAM_BASE_URL,
	DEFAULT_XAI_BASE_URL,
	DEFAULT_ZHIPU_BASE_URL,
	IMAGE_PROVIDERS,
	type ImageProvider,
} from "./shared.ts";

const ERROR_LIMIT = 300;
const LIST_TIMEOUT_MS = 20_000;

export interface ProviderModelList {
	models: string[];
	error?: string;
}

/** Ids that look like image models for each provider; empty regex = keep all. */
const IMAGE_MODEL_PATTERNS: Partial<Record<ImageProvider, RegExp>> = {
	openai: /image|dall/i,
	seedream: /seedream|doubao-seed|image/i,
	zhipu: /image|cogview/i,
	xai: /image|imagine/i,
	dashscope: /image|wanx|qwen-image|flux/i,
};

/** Fetch the selectable model ids for one provider (never throws). */
export async function listProviderModelIds(providerInput: string): Promise<ProviderModelList> {
	if (!(IMAGE_PROVIDERS as readonly string[]).includes(providerInput)) {
		return { models: [], error: `不支持的 provider:${providerInput}` };
	}
	const provider = providerInput as ImageProvider;
	const config = loadConfig();
	installApiKeys(config);
	setAmbientProxy(config.proxy);

	// 订阅通道的模型由桥协议固定;ComfyUI 的"模型"就是工作流名,本地就有。
	if (provider === "google-sub") return { models: [DEFAULT_GOOGLE_SUB_MODEL] };
	if (provider === "comfyui") return { models: (config.comfyuiWorkflows ?? []).map((workflow) => workflow.name) };

	const apiKey = resolveApiKey(provider);
	if (apiKey === undefined) return { models: [], error: "未配置 API key:先在下方 API Keys 保存一把,再回来拉取" };

	try {
		if (provider === "google") return await listGoogleModels(apiKey, config, provider);
		if (provider === "dashscope") return await listDashScopeModels(apiKey, config, provider);
		return await listOpenAIStyleModels(apiKey, config, provider);
	} catch (error) {
		return { models: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Gemini models list: /v1beta/models, prefer entries that look image-capable. */
async function listGoogleModels(
	apiKey: string,
	config: OwlImageConfig,
	provider: ImageProvider,
): Promise<ProviderModelList> {
	const base = (config.googleEndpoint ?? DEFAULT_GOOGLE_ENDPOINT).replace(/\/interactions\/?$/, "");
	const response = await doFetch(
		`${base}/models?pageSize=200`,
		{
			redirect: "error",
			headers: { "x-goog-api-key": apiKey },
			signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
		},
		config.proxy,
	);
	const text = await response.text();
	if (!response.ok)
		return {
			models: [],
			error: `HTTP ${String(response.status)}: ${redactSecrets(text, apiKey).slice(0, ERROR_LIMIT)}`,
		};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { models: [], error: "models 接口返回的不是 JSON" };
	}
	const rows =
		typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { models?: unknown }).models)
			? (parsed as { models: Array<Record<string, unknown>> }).models
			: [];
	const ids: string[] = [];
	const imageCapable = new Set<string>();
	for (const row of rows) {
		const id = typeof row.name === "string" ? row.name.replace(/^models\//, "") : "";
		if (id.length === 0) continue;
		ids.push(id);
		const methods = Array.isArray(row.supportedGenerationMethods) ? row.supportedGenerationMethods.map(String) : [];
		if (methods.some((method) => /image/i.test(method)) || /image|imagen|nano-banana/i.test(id)) imageCapable.add(id);
	}
	// 优先只给图像模型;一个都没有时(判定口径变化)退回全量,让用户自己挑。
	const preferred = ids.filter((id) => imageCapable.has(id));
	return { models: dedupeSort(preferred.length > 0 ? preferred : ids) };
}

/** DashScope: native /models may not exist; try compatible-mode first, then native. */
async function listDashScopeModels(
	apiKey: string,
	config: OwlImageConfig,
	provider: ImageProvider,
): Promise<ProviderModelList> {
	const base = (config.dashscopeEndpoint ?? "https://dashscope.aliyuncs.com/api/v1").replace(/\/+$/, "");
	const compatibleBase = base.replace(/\/api\/v1$/, "/compatible-mode/api/v1");
	const candidates = [`${compatibleBase}/models`, `${base}/models`];
	let lastError = "models 接口不可用";
	for (const url of candidates) {
		const response = await doFetch(
			url,
			{
				redirect: "error",
				headers: { authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
			},
			config.proxy,
		);
		const text = await response.text();
		if (!response.ok) {
			lastError = `HTTP ${String(response.status)}: ${redactSecrets(text, apiKey).slice(0, ERROR_LIMIT)}`;
			continue;
		}
		const ids = parseOpenAIStyleModelIds(text);
		if (ids === undefined) {
			lastError = "models 接口返回的不是 JSON";
			continue;
		}
		if (ids.length === 0) continue;
		return applyImagePreference(provider, ids);
	}
	return { models: [], error: lastError };
}

/** OpenAI-shaped /models: openai / openai-compat / seedream(Ark) / xai / zhipu. */
async function listOpenAIStyleModels(
	apiKey: string,
	config: OwlImageConfig,
	provider: ImageProvider,
): Promise<ProviderModelList> {
	const configured: Partial<Record<ImageProvider, string>> = {
		openai: config.openaiBaseURL,
		"openai-compat": config.openaiCompatBaseURL,
		seedream: config.seedreamBaseURL,
		xai: config.xaiBaseURL,
		zhipu: config.zhipuBaseURL,
	};
	const defaults: Partial<Record<ImageProvider, string>> = {
		openai: DEFAULT_OPENAI_BASE_URL,
		seedream: DEFAULT_SEEDREAM_BASE_URL,
		xai: DEFAULT_XAI_BASE_URL,
		zhipu: DEFAULT_ZHIPU_BASE_URL,
	};
	if (provider === "openai-compat" && (configured["openai-compat"] ?? "").trim().length === 0) {
		return { models: [], error: "先填写 Base URL 并保存,再拉取模型" };
	}
	const base = (configured[provider] ?? defaults[provider] ?? "").replace(/\/+$/, "");
	if (base.length === 0) return { models: [], error: "该 provider 没有可用的 Base URL" };

	const response = await doFetch(
		`${base}/models`,
		{
			redirect: "error",
			headers: { authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
		},
		config.proxy,
	);
	const text = await response.text();
	if (!response.ok)
		return {
			models: [],
			error: `HTTP ${String(response.status)}: ${redactSecrets(text, apiKey).slice(0, ERROR_LIMIT)}`,
		};
	const ids = parseOpenAIStyleModelIds(text);
	if (ids === undefined) return { models: [], error: "models 接口返回的不是 JSON" };
	if (ids.length === 0) return { models: [], error: "models 接口返回空列表" };
	return applyImagePreference(provider, ids);
}

/** Parse `{ data: [{ id }] }` (OpenAI) tolerating `{ models: [...] }` relays. */
function parseOpenAIStyleModelIds(text: string): string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const rows = Array.isArray((parsed as { data?: unknown }).data)
		? (parsed as { data: unknown[] }).data
		: Array.isArray((parsed as { models?: unknown }).models)
			? (parsed as { models: unknown[] }).models
			: undefined;
	if (rows === undefined) return undefined;
	const ids: string[] = [];
	for (const row of rows) {
		const id =
			typeof row === "string"
				? row
				: typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string"
					? (row as { id: string }).id
					: "";
		if (id.length > 0) ids.push(id);
	}
	return ids;
}

/** Prefer image-looking ids; when the filter empties out, hand back everything. */
function applyImagePreference(provider: ImageProvider, ids: string[]): ProviderModelList {
	const pattern = IMAGE_MODEL_PATTERNS[provider];
	if (pattern === undefined) return { models: dedupeSort(ids) };
	const preferred = ids.filter((id) => pattern.test(id));
	return { models: dedupeSort(preferred.length > 0 ? preferred : ids) };
}

function dedupeSort(ids: string[]): string[] {
	return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}
