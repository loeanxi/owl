/**
 * User configuration (`<agentDir>/image-gen.json`), provider resolution, and
 * API-key resolution. Adapted from dsh-image-gen src/config.ts + src/credentials.ts
 * (Apache-2.0): the DSH settings service and credentials store are replaced by a
 * JSON config file plus env vars, which is how owl plugins take configuration.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import {
	API_KEY_ENV_VARS,
	ARK_BACKGROUND_MODES,
	ARK_OUTPUT_FORMATS,
	type ArkBackgroundMode,
	type ArkOutputFormat,
	type ArkOutputOptions,
	activeComfyUIWorkflow,
	type ComfyUIWorkflowEntry,
	DEFAULT_COMFYUI_TIMEOUT_MS,
	DEFAULT_DASHSCOPE_ENDPOINT,
	DEFAULT_DASHSCOPE_MODEL,
	DEFAULT_GOOGLE_ENDPOINT,
	DEFAULT_GOOGLE_MODEL,
	DEFAULT_GOOGLE_SUB_MODEL,
	DEFAULT_MAX_IMAGE_BYTES,
	DEFAULT_OPENAI_BASE_URL,
	DEFAULT_OPENAI_MODEL,
	DEFAULT_SEEDREAM_BASE_URL,
	DEFAULT_SEEDREAM_MODEL,
	DEFAULT_XAI_BASE_URL,
	DEFAULT_XAI_MODEL,
	DEFAULT_ZHIPU_BASE_URL,
	DEFAULT_ZHIPU_MODEL,
	IMAGE_PROVIDERS,
	type ImageProvider,
	PROVIDER_DISPLAY_NAMES,
} from "./shared.ts";

/** Default workspace subfolder that receives generated image files. */
export const DEFAULT_WORKSPACE_FOLDER = "owl-image";

/** Google tool-level controls. Aligned with gemini-3.1-flash-image's common set. */
export const ASPECT_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "16:9", "9:16", "21:9"] as const;
export const IMAGE_SIZES = ["1K", "2K", "4K"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type ImageSize = (typeof IMAGE_SIZES)[number];

/** Plugin configuration as persisted in `<agentDir>/image-gen.json`. */
export interface OwlImageConfig {
	provider?: ImageProvider;
	/** Per-provider API keys. Env vars win when both are set; file values are plaintext. */
	apiKeys?: Partial<Record<ImageProvider, string>>;
	googleModel?: string;
	googleEndpoint?: string;
	openaiBaseURL?: string;
	openaiModel?: string;
	/** OpenAI-compatible relay settings; independent from the official OpenAI row. */
	openaiCompatBaseURL?: string;
	openaiCompatModel?: string;
	/**
	 * Request shape the relay's images/edits endpoint expects. Most relays take
	 * OpenAI's multipart form; some (e.g. SenseNova) run edits on their own JSON
	 * contract. Defaults to `multipart`.
	 */
	openaiCompatEditFormat?: "multipart" | "jsonImageUrlArray" | "formReferenceImages";
	/** Extra JSON fields merged into the JSON edit body last. Ignored in multipart mode. */
	openaiCompatEditExtra?: Record<string, unknown>;
	seedreamBaseURL?: string;
	seedreamModel?: string;
	/** Ark `output_format`; `png` is lossless and keeps an alpha channel. */
	seedreamOutputFormat?: ArkOutputFormat;
	/** Ark `watermark`; off removes the baked-in "AI generated" mark. */
	seedreamWatermark?: boolean;
	/** Ark `background`; `transparent` needs an alpha-bearing edit reference. */
	seedreamBackground?: ArkBackgroundMode;
	dashscopeEndpoint?: string;
	dashscopeModel?: string;
	xaiBaseURL?: string;
	xaiModel?: string;
	zhipuBaseURL?: string;
	zhipuModel?: string;
	comfyuiBaseURL?: string;
	/** Named ComfyUI workflows (API-format JSON with {{prompt}}). */
	comfyuiWorkflows?: ComfyUIWorkflowEntry[];
	/** Name of the workflow ComfyUI calls use by default. */
	comfyuiActiveWorkflow?: string;
	comfyuiTimeoutMs?: number;
	/** Also write every generated image as a file under the session workspace. */
	saveToWorkspace?: boolean;
	/** Workspace subfolder for generated images; empty means the workspace root. */
	workspaceFolder?: string;
	/** Include the generated image as a content block in the tool result (the model sees it; desktop renders it). */
	attachImageToResult?: boolean;
	/** Hard cap on one generated image in bytes. */
	maxImageBytes?: number;
	/**
	 * http(s) proxy URL for every outbound provider request. Empty honors the
	 * HTTPS_PROXY / HTTP_PROXY environment variables; "off" forces direct access.
	 */
	proxy?: string;
}

/** Normalized per-call provider profile. */
export type ResolvedProvider =
	| { provider: "google"; model: string; endpoint: string; aspectRatio: AspectRatio; imageSize: ImageSize }
	| { provider: "openai"; model: string; baseURL: string; imageSize: string }
	| {
			provider: "openai-compat";
			model: string;
			baseURL: string;
			imageSize: string;
			editFormat: "multipart" | "jsonImageUrlArray" | "formReferenceImages";
			editExtra: Record<string, unknown>;
	  }
	| { provider: "seedream"; model: string; baseURL: string; imageSize: string; arkOptions: ArkOutputOptions }
	| { provider: "dashscope"; model: string; endpoint: string; imageSize: string }
	| { provider: "xai"; model: string; baseURL: string; imageSize: string }
	| { provider: "zhipu"; model: string; baseURL: string; imageSize: string }
	| {
			provider: "comfyui";
			baseURL: string;
			workflows: ComfyUIWorkflowEntry[];
			workflow?: ComfyUIWorkflowEntry;
			timeoutMs: number;
	  }
	| { provider: "google-sub"; model: string };

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

let cachedAgentDir: string | undefined;

/** The owl agent dir (same resolution order as owl-web-access utils.ts). */
export function agentDirOf(): string {
	if (cachedAgentDir !== undefined) return cachedAgentDir;
	const explicit = process.env.OWL_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
	if (explicit !== undefined && explicit.trim().length > 0) return (cachedAgentDir = explicit.trim());
	return (cachedAgentDir = join(homedir(), ".owl", "agent"));
}

/** Absolute path of the plugin config file. */
export function imageConfigPath(): string {
	return join(agentDirOf(), "image-gen.json");
}

/** Blank-slate config: only defaults, no file touched. */
export function defaultConfig(): OwlImageConfig {
	return {
		provider: "google",
		workspaceFolder: DEFAULT_WORKSPACE_FOLDER,
		attachImageToResult: true,
		maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
	};
}

/** Read the config file; a missing or unparsable file yields the defaults. */
export function loadConfig(): OwlImageConfig {
	const path = imageConfigPath();
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaultConfig();
		return { ...defaultConfig(), ...(parsed as OwlImageConfig) };
	} catch {
		return defaultConfig();
	}
}

/** Persist the config file (agent dir created on demand). */
export function saveConfig(config: OwlImageConfig): void {
	const dir = agentDirOf();
	mkdirSync(dir, { recursive: true });
	writeFileSync(imageConfigPath(), `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Provider + key resolution
// ---------------------------------------------------------------------------

/** Resolve exactly one provider profile for a tool call. */
export function resolveProvider(config: OwlImageConfig): ResolvedProvider {
	switch (config.provider ?? "google") {
		case "openai":
			return {
				provider: "openai",
				model: config.openaiModel ?? DEFAULT_OPENAI_MODEL,
				baseURL: config.openaiBaseURL ?? DEFAULT_OPENAI_BASE_URL,
				imageSize: "1024x1024",
			};
		case "openai-compat": {
			const baseURL = config.openaiCompatBaseURL?.trim();
			if (baseURL === undefined || baseURL.length === 0) {
				throw new Error(
					"OpenAI 兼容 provider 需要先在 image-gen.json 配置 openaiCompatBaseURL 与 openaiCompatModel。",
				);
			}
			const model = config.openaiCompatModel?.trim();
			if (model === undefined || model.length === 0) {
				throw new Error("OpenAI 兼容 provider 需要先在 image-gen.json 配置 openaiCompatModel。");
			}
			return {
				provider: "openai-compat",
				model,
				baseURL,
				imageSize: "1024x1024",
				editFormat: config.openaiCompatEditFormat ?? "multipart",
				editExtra: config.openaiCompatEditExtra ?? {},
			};
		}
		case "seedream": {
			const seedreamBackground = config.seedreamBackground ?? "opaque";
			return {
				provider: "seedream",
				model: config.seedreamModel ?? DEFAULT_SEEDREAM_MODEL,
				baseURL: config.seedreamBaseURL ?? DEFAULT_SEEDREAM_BASE_URL,
				imageSize: "2K",
				arkOptions: {
					// Ark rejects `output_format: jpeg` together with `background: transparent`
					// outright — a JPEG cannot carry the alpha channel transparent mode
					// exists to produce. Couple them here rather than letting the
					// combination reach the wire.
					outputFormat: seedreamBackground === "transparent" ? "png" : (config.seedreamOutputFormat ?? "jpeg"),
					watermark: config.seedreamWatermark ?? true,
					background: seedreamBackground,
				},
			};
		}
		case "dashscope":
			return {
				provider: "dashscope",
				model: config.dashscopeModel ?? DEFAULT_DASHSCOPE_MODEL,
				endpoint: config.dashscopeEndpoint ?? DEFAULT_DASHSCOPE_ENDPOINT,
				imageSize: "1024x1024",
			};
		case "xai":
			return {
				provider: "xai",
				model: config.xaiModel ?? DEFAULT_XAI_MODEL,
				baseURL: config.xaiBaseURL ?? DEFAULT_XAI_BASE_URL,
				imageSize: "1024x1024",
			};
		case "zhipu":
			return {
				provider: "zhipu",
				model: config.zhipuModel ?? DEFAULT_ZHIPU_MODEL,
				baseURL: config.zhipuBaseURL ?? DEFAULT_ZHIPU_BASE_URL,
				imageSize: "1024x1024",
			};
		case "comfyui": {
			const workflows = config.comfyuiWorkflows ?? [];
			const workflow = activeComfyUIWorkflow(config);
			return {
				provider: "comfyui",
				baseURL: config.comfyuiBaseURL ?? "http://127.0.0.1:8188",
				workflows,
				...(workflow === undefined ? {} : { workflow }),
				timeoutMs: config.comfyuiTimeoutMs ?? DEFAULT_COMFYUI_TIMEOUT_MS,
			};
		}
		case "google-sub":
			return { provider: "google-sub", model: DEFAULT_GOOGLE_SUB_MODEL };
		case "google":
			return {
				provider: "google",
				model: config.googleModel ?? DEFAULT_GOOGLE_MODEL,
				endpoint: config.googleEndpoint ?? DEFAULT_GOOGLE_ENDPOINT,
				aspectRatio: "1:1",
				imageSize: "1K",
			};
	}
}

/**
 * Apply a per-call provider and/or model override on top of the saved config.
 * `model` is ignored for ComfyUI (whose per-call equivalent is `workflow`) and
 * for the subscription channel (model fixed by the channel).
 */
export function withProviderOverrides(
	config: OwlImageConfig,
	provider?: ImageProvider,
	model?: string,
): OwlImageConfig {
	const base: OwlImageConfig = provider === undefined ? { ...config } : { ...config, provider };
	if (model === undefined) return base;
	const trimmed = model.trim();
	if (trimmed.length === 0) return base;
	switch (base.provider ?? "google") {
		case "google":
			return { ...base, googleModel: trimmed };
		case "openai":
			return { ...base, openaiModel: trimmed };
		case "openai-compat":
			return { ...base, openaiCompatModel: trimmed };
		case "seedream":
			return { ...base, seedreamModel: trimmed };
		case "dashscope":
			return { ...base, dashscopeModel: trimmed };
		case "xai":
			return { ...base, xaiModel: trimmed };
		case "zhipu":
			return { ...base, zhipuModel: trimmed };
		case "google-sub":
		case "comfyui":
			return base;
	}
}

/** Validate an untrusted per-call provider override from tool arguments. */
export function providerOverrideOf(value: unknown): ImageProvider | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !(IMAGE_PROVIDERS as readonly string[]).includes(value)) {
		throw new Error(
			`Unsupported provider ${JSON.stringify(value)}. Supported providers: ${IMAGE_PROVIDERS.join(", ")}.`,
		);
	}
	return value as ImageProvider;
}

/** The config's apiKeys rows, installed at extension init and after each save. */
let installedApiKeys: Partial<Record<ImageProvider, string>> = {};

/** Install the config's apiKeys where resolveApiKey reads them. */
export function installApiKeys(config: OwlImageConfig): void {
	installedApiKeys = config.apiKeys ?? {};
}

/**
 * Resolve one provider's API key: the config `apiKeys` row first, then the
 * provider's env var. Blank values never count as configured.
 */
export function resolveApiKey(provider: ImageProvider): string | undefined {
	if (provider !== "google-sub") {
		const fromFile = installedApiKeys[provider]?.trim() ?? "";
		if (fromFile.length > 0) return fromFile;
	}
	const envName = API_KEY_ENV_VARS[provider];
	if (envName === undefined) return undefined;
	const fromEnv = process.env[envName]?.trim() ?? "";
	return fromEnv.length > 0 ? fromEnv : undefined;
}

/** Resolve one provider's API key or fail with a message that says where to configure it. */
export async function requireApiKey(provider: ImageProvider, tool?: string): Promise<string> {
	const value = resolveApiKey(provider);
	if (value !== undefined) return value;
	const display = PROVIDER_DISPLAY_NAMES[provider];
	const envName = API_KEY_ENV_VARS[provider] ?? "";
	throw new Error(
		`${tool ?? "image generation"} requires the ${display} API key. Set "${envName}" in the environment, or put it under "apiKeys.${provider}" in ${imageConfigPath()}.`,
	);
}

/** The workflow a ComfyUI call runs: the requested name when given, else the active one. */
export function selectComfyUIWorkflow(
	active: { workflows: ComfyUIWorkflowEntry[]; workflow?: ComfyUIWorkflowEntry },
	requested?: string,
): ComfyUIWorkflowEntry {
	if (active.workflow === undefined) {
		throw new Error("ComfyUI 图像生成需要先在 image-gen.json 的 comfyuiWorkflows 里导入工作流。");
	}
	if (typeof requested !== "string" || requested.trim().length === 0) return active.workflow;
	const name = requested.trim();
	const workflow = active.workflows.find((candidate) => candidate.name === name);
	if (workflow === undefined) {
		throw new Error(
			`No ComfyUI workflow named "${name}" is configured. Available workflows: ${active.workflows.map((entry) => entry.name).join(", ")}.`,
		);
	}
	return workflow;
}

// ---------------------------------------------------------------------------
// Proxy-aware fetch
// ---------------------------------------------------------------------------

let ambientProxy: string | undefined;

/** Set the ambient proxy from config; called when the config is loaded. */
export function setAmbientProxy(proxy: string | undefined): void {
	ambientProxy = proxy === undefined || proxy.trim() === "" ? undefined : proxy.trim();
}

let cachedAgent: { key: string; agent: ProxyAgent } | undefined;

function proxyUrlOf(configured: string | undefined): string | undefined {
	const explicit = configured ?? ambientProxy;
	if (explicit === "off") return undefined;
	if (explicit !== undefined && explicit.length > 0) return explicit;
	// Node's global fetch ignores proxy env vars; honor them the way curl does.
	const fromEnv =
		process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
	return fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
}

/**
 * Every outbound provider/CDN request goes through here so a configured or
 * ambient proxy applies uniformly (several providers are unreachable by
 * direct connection on some networks).
 */
export function doFetch(url: string | URL, init: RequestInit = {}, configuredProxy?: string): Promise<Response> {
	const proxyUrl = proxyUrlOf(configuredProxy);
	if (proxyUrl === undefined) return fetch(url, init);
	let agent: ProxyAgent;
	if (cachedAgent !== undefined && cachedAgent.key === proxyUrl) {
		agent = cachedAgent.agent;
	} else {
		agent = new ProxyAgent(proxyUrl);
		cachedAgent = { key: proxyUrl, agent };
	}
	return undiciFetch(url, {
		...(init as Parameters<typeof undiciFetch>[1]),
		dispatcher: agent,
	}) as unknown as Promise<Response>;
}

/** True when the config file exists (used by the status command wording). */
export function configExists(): boolean {
	return existsSync(imageConfigPath());
}
