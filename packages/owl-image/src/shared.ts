/** Values shared across the owl-image plugin. Ported from dsh-image-gen src/shared.ts (Apache-2.0). */

/** Supported providers. `google-sub` talks to a logged-in Antigravity account; the other
 * subscription channels of the upstream (chatgpt-sub / grok-sub) were deliberately not ported. */
export const IMAGE_PROVIDERS = [
	"google",
	"openai",
	"openai-compat",
	"seedream",
	"dashscope",
	"xai",
	"zhipu",
	"comfyui",
	"google-sub",
] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

/** True when the provider generates through a logged-in subscription account. */
export function isSubscriptionProvider(provider: ImageProvider): provider is "google-sub" {
	return provider === "google-sub";
}

/** Locale-neutral provider names for user-facing errors and status lines. */
export const PROVIDER_DISPLAY_NAMES: Record<ImageProvider, string> = {
	google: "Google Gemini",
	openai: "OpenAI",
	"openai-compat": "OpenAI 兼容",
	seedream: "Seedream",
	dashscope: "DashScope",
	xai: "xAI Grok",
	zhipu: "智谱 GLM",
	comfyui: "ComfyUI",
	"google-sub": "Google 订阅 (Antigravity)",
};

/** Environment variable each cloud provider's API key is read from (config `apiKeys` takes precedence). */
export const GOOGLE_API_KEY_ENV = "GEMINI_API_KEY";
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
/** Deliberately distinct from OPENAI_API_KEY so an official key and a relay key can coexist. */
export const OPENAI_COMPAT_API_KEY_ENV = "OWL_IMAGE_OPENAI_COMPAT_KEY";
export const SEEDREAM_API_KEY_ENV = "ARK_API_KEY";
export const DASHSCOPE_API_KEY_ENV = "DASHSCOPE_API_KEY";
export const XAI_API_KEY_ENV = "XAI_API_KEY";
export const ZHIPU_API_KEY_ENV = "ZHIPUAI_API_KEY";

/** The env var name storing this provider's API key, when it uses one. */
export const API_KEY_ENV_VARS: Record<string, string> = {
	google: GOOGLE_API_KEY_ENV,
	openai: OPENAI_API_KEY_ENV,
	"openai-compat": OPENAI_COMPAT_API_KEY_ENV,
	seedream: SEEDREAM_API_KEY_ENV,
	dashscope: DASHSCOPE_API_KEY_ENV,
	xai: XAI_API_KEY_ENV,
	zhipu: ZHIPU_API_KEY_ENV,
};

/** Default endpoints and base URLs. */
export const DEFAULT_GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_SEEDREAM_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_DASHSCOPE_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1";
export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const DEFAULT_COMFYUI_BASE_URL = "http://127.0.0.1:8188";
export const DEFAULT_COMFYUI_TIMEOUT_MS = 300_000;
export const DEFAULT_COMFYUI_WORKFLOW_LABEL = "API workflow";
export const MAX_COMFYUI_WORKFLOW_BYTES = 5 * 1024 * 1024;

/** Hard cap on one generated image, matching the upstream bundle's protection intent. */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Content types Ark's Seedream endpoint can return. */
export const ARK_OUTPUT_FORMATS = ["png", "jpeg"] as const;
/** Whether Ark stamps an "AI generated" watermark on the result. */
export const ARK_BACKGROUND_MODES = ["opaque", "transparent"] as const;
export type ArkOutputFormat = (typeof ARK_OUTPUT_FORMATS)[number];
export type ArkBackgroundMode = (typeof ARK_BACKGROUND_MODES)[number];

/**
 * Ark (Seedream) output controls, shared by the generate and edit paths.
 * Every field mirrors an Ark request-body field of the same meaning, and every
 * default reproduces Ark's own default — an untouched config sends exactly
 * what it sent before these options existed.
 */
export interface ArkOutputOptions {
	/** `output_format`. Ark defaults to `jpeg`; `png` is lossless and keeps an alpha channel. */
	outputFormat?: ArkOutputFormat;
	/** `watermark`. Ark defaults to `true`, which bakes an "AI generated" mark into the image. */
	watermark?: boolean;
	/** `background`. Ark defaults to `opaque`. */
	background?: ArkBackgroundMode;
}

/**
 * Map the Ark output controls onto request-body fields.
 *
 * `background` is opt-in per call site because Ark restricts `transparent` to
 * image-to-image with a single alpha-bearing reference and rejects the whole
 * request otherwise (text-to-image + transparent → 400 InvalidParameter).
 */
export function arkOutputBody(
	options: ArkOutputOptions | undefined,
	{ background = true }: { background?: boolean } = {},
): Record<string, unknown> {
	if (options === undefined) return {};
	const body: Record<string, unknown> = {};
	if (options.outputFormat !== undefined) body.output_format = options.outputFormat;
	if (options.watermark !== undefined) body.watermark = options.watermark;
	if (background && options.background === "transparent") body.background = "transparent";
	return body;
}

/** Default model names. */
export const DEFAULT_GOOGLE_MODEL = "gemini-3.1-flash-image";
export const DEFAULT_OPENAI_MODEL = "gpt-image-2";
export const DEFAULT_SEEDREAM_MODEL = "doubao-seedream-5-0-260128";
export const DEFAULT_DASHSCOPE_MODEL = "qwen-image-3.0";
export const DEFAULT_XAI_MODEL = "grok-imagine-image";
export const DEFAULT_ZHIPU_MODEL = "glm-image";
/** The model served through the Antigravity subscription channel (Nano Banana 2). */
export const DEFAULT_GOOGLE_SUB_MODEL = "gemini-3.1-flash-image";

export const DEFAULT_MODELS: Record<ImageProvider, string> = {
	google: DEFAULT_GOOGLE_MODEL,
	openai: DEFAULT_OPENAI_MODEL,
	// Relays expose arbitrary model ids; there is no sensible default to offer.
	"openai-compat": "",
	seedream: DEFAULT_SEEDREAM_MODEL,
	dashscope: DEFAULT_DASHSCOPE_MODEL,
	xai: DEFAULT_XAI_MODEL,
	zhipu: DEFAULT_ZHIPU_MODEL,
	comfyui: DEFAULT_COMFYUI_WORKFLOW_LABEL,
	"google-sub": DEFAULT_GOOGLE_SUB_MODEL,
};

export const DEFAULT_BASE_URLS: Record<ImageProvider, string> = {
	google: DEFAULT_GOOGLE_ENDPOINT,
	openai: DEFAULT_OPENAI_BASE_URL,
	// Relay addresses are user-specific; empty until the compat row is filled in.
	"openai-compat": "",
	seedream: DEFAULT_SEEDREAM_BASE_URL,
	dashscope: DEFAULT_DASHSCOPE_ENDPOINT,
	xai: DEFAULT_XAI_BASE_URL,
	zhipu: DEFAULT_ZHIPU_BASE_URL,
	comfyui: DEFAULT_COMFYUI_BASE_URL,
	// The subscription channel calls a hosted service after login, never a configured URL.
	"google-sub": "",
};

/** One named ComfyUI API-format workflow in the config file. */
export interface ComfyUIWorkflowEntry {
	/** Unique human-readable label; used as the result model and by tool calls. */
	name: string;
	/** API-format workflow JSON with {{prompt}} / {{seed}} and optional {{image}} placeholders. */
	json: string;
	/** Optional preset prepended to the user prompt on every call of this workflow. */
	presetPrompt?: string;
}

/** Named workflows from the config, tolerating blank entries. */
export function resolveComfyUIWorkflows(source: {
	comfyuiWorkflows?: readonly ComfyUIWorkflowEntry[];
}): ComfyUIWorkflowEntry[] {
	const named: ComfyUIWorkflowEntry[] = [];
	for (const entry of source.comfyuiWorkflows ?? []) {
		const name = typeof entry?.name === "string" ? entry.name.trim() : "";
		const json = typeof entry?.json === "string" ? entry.json : "";
		if (name.length > 0 && json.trim().length > 0) {
			const presetPrompt = typeof entry.presetPrompt === "string" ? entry.presetPrompt.trim() : "";
			named.push(presetPrompt.length > 0 ? { name, json, presetPrompt } : { name, json });
		}
	}
	return named;
}

/** The workflow ComfyUI calls use by default: the configured active name, else the first entry. */
export function activeComfyUIWorkflow(source: {
	comfyuiWorkflows?: readonly ComfyUIWorkflowEntry[];
	comfyuiActiveWorkflow?: string;
}): ComfyUIWorkflowEntry | undefined {
	const workflows = resolveComfyUIWorkflows(source);
	if (workflows.length === 0) return undefined;
	const activeName = typeof source.comfyuiActiveWorkflow === "string" ? source.comfyuiActiveWorkflow.trim() : "";
	return workflows.find((workflow) => workflow.name === activeName) ?? workflows[0];
}

/** Derive a workflow label that does not collide with the given existing names. */
export function uniqueComfyUIWorkflowName(name: string, existing: readonly string[]): string {
	const base = name.trim().length > 0 ? name.trim() : DEFAULT_COMFYUI_WORKFLOW_LABEL;
	if (!existing.includes(base)) return base;
	for (let index = 2; ; index += 1) {
		const candidate = `${base} (${index})`;
		if (!existing.includes(candidate)) return candidate;
	}
}

/**
 * Combine a workflow's preset with the user prompt: preset first, user second,
 * joined by one comma — never doubled when the preset already ends in a
 * separator, and reduced to the non-empty side when the other is blank.
 */
export function mergeComfyUIPrompt(preset: string | undefined, user: string): string {
	const presetText = typeof preset === "string" ? preset.trim().replace(/[,;\s]+$/, "") : "";
	const userText = user.trim();
	if (presetText.length === 0) return userText;
	if (userText.length === 0) return presetText;
	return `${presetText}, ${userText}`;
}

/** Timeout for one subscription image call, shared by every google-sub path. */
export const SUBSCRIPTION_TIMEOUT_MS = 300_000;
