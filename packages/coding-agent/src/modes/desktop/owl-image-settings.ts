/**
 * owl-image 设置页数据面（桥端）。
 *
 * 配置读写直接落在 `<agentDir>/image-gen.json`——纯文件操作，与插件运行时
 * 解耦（插件每次工具调用现读同一文件，改动即时生效，两边不需要共享实例）。
 * apiKeys 明文只存在于文件里；下发 UI 的只有存在性（keyStatus），永不含密钥。
 *
 * 唯一需要插件代码的是 Google 订阅（Antigravity）登录：PKCE + 本机回环 +
 * 令牌交换。这里按 settings.json 的 plugins 找到 owl-image 包目录，动态
 * import 其 dist 暴露的 `beginGoogleSubscriptionLogin`（与 /image-login 命令
 * 同一实现，单一事实源）；插件未安装/未构建时返回可读错误。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OwlImageConfigPublic, OwlImageProvider } from "./protocol.ts";

/** 与 packages/owl-image/src/shared.ts 的 IMAGE_PROVIDERS 对齐。 */
const IMAGE_PROVIDERS: readonly OwlImageProvider[] = [
	"google",
	"openai",
	"openai-compat",
	"seedream",
	"dashscope",
	"xai",
	"zhipu",
	"comfyui",
	"google-sub",
];

/** BYOK provider → 凭据环境变量（与 packages/owl-image/src/shared.ts 的 API_KEY_ENV_VARS 对齐）。 */
const BYOK_ENV_VARS: Record<string, string> = {
	google: "GEMINI_API_KEY",
	openai: "OPENAI_API_KEY",
	"openai-compat": "OWL_IMAGE_OPENAI_COMPAT_KEY",
	seedream: "ARK_API_KEY",
	dashscope: "DASHSCOPE_API_KEY",
	xai: "XAI_API_KEY",
	zhipu: "ZHIPUAI_API_KEY",
};

const EDIT_FORMATS = ["multipart", "jsonImageUrlArray", "formReferenceImages"];
const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024;

export function imageConfigPath(agentDir: string): string {
	return join(agentDir, "image-gen.json");
}

function imageAuthPath(agentDir: string): string {
	return join(agentDir, "image-gen-auth.json");
}

/** 原样读取配置 JSON；缺失/损坏时返回空对象（写入时未知键也会保留）。 */
function readImageConfigRaw(agentDir: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(imageConfigPath(agentDir), "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** 配置的公开投影（剥离 apiKeys）。 */
export function readImageConfigPublic(agentDir: string): OwlImageConfigPublic {
	const { apiKeys: _apiKeys, ...rest } = readImageConfigRaw(agentDir) as { apiKeys?: unknown };
	return rest as OwlImageConfigPublic;
}

/** 各 BYOK provider 的 key 状态：config 行优先，其次环境变量。 */
export function apiKeyStatus(
	agentDir: string,
): Record<string, { configured: boolean; source: "config" | "env" | undefined }> {
	const raw = readImageConfigRaw(agentDir);
	const rows = (typeof raw.apiKeys === "object" && raw.apiKeys !== null ? raw.apiKeys : {}) as Record<string, unknown>;
	const status: Record<string, { configured: boolean; source: "config" | "env" | undefined }> = {};
	for (const [provider, envVar] of Object.entries(BYOK_ENV_VARS)) {
		const fromFile = typeof rows[provider] === "string" ? rows[provider].trim() : "";
		if (fromFile.length > 0) {
			status[provider] = { configured: true, source: "config" };
			continue;
		}
		const fromEnv = process.env[envVar]?.trim() ?? "";
		status[provider] = { configured: fromEnv.length > 0, source: fromEnv.length > 0 ? "env" : undefined };
	}
	return status;
}

/** Google 订阅登录状态：解析本机 auth blob（读 email 展示，令牌永不出进程）。 */
export function subscriptionStatus(agentDir: string): { loggedIn: boolean; email?: string } {
	try {
		const parsed: unknown = JSON.parse(readFileSync(imageAuthPath(agentDir), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return { loggedIn: false };
		const row = parsed as Record<string, unknown>;
		const hasToken =
			(typeof row.accessToken === "string" && row.accessToken.length > 0) ||
			(typeof row.refreshToken === "string" && row.refreshToken.length > 0);
		if (!hasToken) return { loggedIn: false };
		return { loggedIn: true, ...(typeof row.email === "string" && row.email.length > 0 ? { email: row.email } : {}) };
	} catch {
		return { loggedIn: false };
	}
}

function asTrimmedString(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim().slice(0, max);
}

function asBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asClampedInt(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * 白名单式合并写入：patch 只接受已知公开字段（字符串裁剪、数字夹紧、枚举
 * 校验），未知字段原样保留；apiKeys 非空写入对应行、空串删除该行。
 * comfyuiWorkflows 的 json 要求能 JSON.parse 且带 {{prompt}} 占位符。
 */
export function writeImageConfig(
	agentDir: string,
	patch: OwlImageConfigPublic,
	apiKeys?: Partial<Record<string, string>>,
): { ok: true } | { ok: false; error: string } {
	const raw = readImageConfigRaw(agentDir);
	const next: Record<string, unknown> = { ...raw };

	if (patch.provider !== undefined) {
		if (!(IMAGE_PROVIDERS as readonly string[]).includes(patch.provider))
			return { ok: false, error: `不支持的 provider:${patch.provider}` };
		next.provider = patch.provider;
	}
	const stringFields: Array<[keyof OwlImageConfigPublic, number]> = [
		["googleModel", 200],
		["googleEndpoint", 2000],
		["openaiBaseURL", 2000],
		["openaiModel", 200],
		["openaiCompatBaseURL", 2000],
		["openaiCompatModel", 200],
		["seedreamBaseURL", 2000],
		["seedreamModel", 200],
		["dashscopeEndpoint", 2000],
		["dashscopeModel", 200],
		["xaiBaseURL", 2000],
		["xaiModel", 200],
		["zhipuBaseURL", 2000],
		["zhipuModel", 200],
		["comfyuiBaseURL", 2000],
		["comfyuiActiveWorkflow", 200],
		["workspaceFolder", 400],
		["proxy", 500],
	];
	for (const [field, max] of stringFields) {
		if (patch[field] === undefined) continue;
		next[field] = asTrimmedString(patch[field], max) ?? "";
	}
	if (patch.openaiCompatEditFormat !== undefined) {
		if (!EDIT_FORMATS.includes(patch.openaiCompatEditFormat))
			return { ok: false, error: `不支持的 edits 请求形态:${String(patch.openaiCompatEditFormat)}` };
		next.openaiCompatEditFormat = patch.openaiCompatEditFormat;
	}
	for (const field of ["seedreamWatermark", "saveToWorkspace", "attachImageToResult"] as const) {
		if (patch[field] === undefined) continue;
		const value = asBool(patch[field]);
		if (value !== undefined) next[field] = value;
	}
	if (patch.seedreamOutputFormat !== undefined) {
		if (patch.seedreamOutputFormat !== "png" && patch.seedreamOutputFormat !== "jpeg")
			return { ok: false, error: "seedreamOutputFormat 只接受 png / jpeg" };
		next.seedreamOutputFormat = patch.seedreamOutputFormat;
	}
	if (patch.seedreamBackground !== undefined) {
		if (patch.seedreamBackground !== "opaque" && patch.seedreamBackground !== "transparent")
			return { ok: false, error: "seedreamBackground 只接受 opaque / transparent" };
		next.seedreamBackground = patch.seedreamBackground;
	}
	if (patch.maxImageBytes !== undefined) {
		const clamped = asClampedInt(patch.maxImageBytes, 1024 * 1024, 64 * 1024 * 1024);
		if (clamped === undefined) return { ok: false, error: "maxImageBytes 必须是 1MB-64MB 的整数" };
		next.maxImageBytes = clamped;
	}
	if (patch.comfyuiTimeoutMs !== undefined) {
		const clamped = asClampedInt(patch.comfyuiTimeoutMs, 1_000, 3_600_000);
		if (clamped === undefined) return { ok: false, error: "comfyuiTimeoutMs 必须是 1s-3600s 的整数" };
		next.comfyuiTimeoutMs = clamped;
	}
	if (patch.comfyuiWorkflows !== undefined) {
		if (!Array.isArray(patch.comfyuiWorkflows)) return { ok: false, error: "comfyuiWorkflows 必须是数组" };
		const workflows: Array<{ name: string; json: string; presetPrompt?: string }> = [];
		for (const entry of patch.comfyuiWorkflows.slice(0, 20)) {
			const name = asTrimmedString((entry as { name?: unknown })?.name, 120) ?? "";
			const json = asTrimmedString((entry as { json?: unknown })?.json, MAX_WORKFLOW_BYTES) ?? "";
			const presetPrompt = asTrimmedString((entry as { presetPrompt?: unknown })?.presetPrompt, 4000) ?? "";
			if (name.length === 0 && json.length === 0) continue;
			if (name.length === 0 || json.length === 0)
				return { ok: false, error: "ComfyUI 工作流的 name 与 json 必须同时填写" };
			try {
				JSON.parse(json);
			} catch {
				return { ok: false, error: `ComfyUI 工作流「${name}」的 json 不是合法 JSON` };
			}
			if (!json.includes("{{prompt}}") && !json.includes("%prompt%")) {
				return { ok: false, error: `ComfyUI 工作流「${name}」缺少 {{prompt}} 占位符` };
			}
			workflows.push(presetPrompt.length > 0 ? { name, json, presetPrompt } : { name, json });
		}
		next.comfyuiWorkflows = workflows;
	}

	if (apiKeys !== undefined) {
		const rows = (
			typeof raw.apiKeys === "object" && raw.apiKeys !== null ? { ...(raw.apiKeys as Record<string, unknown>) } : {}
		) as Record<string, unknown>;
		for (const [provider, value] of Object.entries(apiKeys)) {
			if (!(provider in BYOK_ENV_VARS)) continue;
			if (typeof value !== "string") continue;
			const trimmed = value.trim();
			if (trimmed.length === 0) delete rows[provider];
			else if (trimmed.length <= 500) rows[provider] = trimmed;
		}
		if (Object.keys(rows).length > 0) next.apiKeys = rows;
		else delete next.apiKeys;
	}

	mkdirSync(agentDir, { recursive: true });
	writeFileSync(imageConfigPath(agentDir), `${JSON.stringify(next, null, "\t")}\n`, "utf8");
	return { ok: true };
}

/** 退出 Google 订阅：删除本机 auth blob（下次读取即未登录）。 */
export function subscriptionLogout(agentDir: string): void {
	try {
		rmSync(imageAuthPath(agentDir), { force: true });
	} catch {
		// already gone
	}
}

/** owl-image 插件在 settings.plugins 里的 dist 产物路径；未安装返回 undefined。 */
export function findOwlImageDist(pluginSources: unknown): string | undefined {
	if (!Array.isArray(pluginSources)) return undefined;
	for (const entry of pluginSources) {
		const source =
			typeof entry === "string"
				? entry
				: typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string"
					? (entry as { source: string; disabled?: boolean }).source
					: undefined;
		if (source === undefined || source.length === 0) continue;
		if (typeof entry === "object" && entry !== null && (entry as { disabled?: unknown }).disabled === true) continue;
		// 模式条目（+/-/! 前缀）与远程源不是本地目录插件
		if (/^[+!-]/.test(source) || /^(npm:|git\+|https?:)/.test(source)) continue;
		try {
			const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { name?: unknown };
			if (manifest.name !== "owl-image") continue;
		} catch {
			continue;
		}
		const dist = join(source, "dist", "index.js");
		if (existsSync(dist)) return dist;
	}
	return undefined;
}

interface OwlImageLoginExports {
	beginGoogleSubscriptionLogin?: () => Promise<string>;
}

/**
 * 开始 Google 订阅登录：动态 import 插件 dist 的 beginGoogleSubscriptionLogin
 * （内部起回环服务器并自动开浏览器）。结果页面/状态以本机 auth blob 为准，
 * UI 拿到 URL 仅用于展示兜底。
 *
 * 每次 login 都带时间戳查询参数强制从盘上重新加载插件 dist（Node ESM 把不同
 * URL 视为不同模块）：插件重构建后无需重启桥，下一次点登录就是新代码——登录
 * 是低频操作，重复 import 的内存开销可以忽略；换来的确定性是"点登录 = 盘上最新"。
 */
export async function subscriptionLogin(
	pluginSources: unknown,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
	const distPath = findOwlImageDist(pluginSources);
	if (distPath === undefined) {
		return {
			ok: false,
			error: "未在 settings.json 的 plugins 里找到已构建的 owl-image 包（本地目录源 + dist/index.js）",
		};
	}
	try {
		const mod = (await import(`${pathToFileURL(distPath).href}?login=${Date.now()}`)) as OwlImageLoginExports;
		if (typeof mod.beginGoogleSubscriptionLogin !== "function") {
			return {
				ok: false,
				error: "owl-image dist 缺少 beginGoogleSubscriptionLogin 导出，请重新构建插件（npm run build）",
			};
		}
		const url = await mod.beginGoogleSubscriptionLogin();
		return { ok: true, url };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

interface OwlImageModelsExports {
	listProviderModelIds?: (provider: string) => Promise<{ models: string[]; error?: string }>;
}

/**
 * 拉取某 provider 的可选模型 id（设置页「拉取模型」）。与登录同一套约定：
 * 每次带时间戳查询参数强制加载盘上最新插件 dist（插件自己知道各家的
 * models 接口、key 解析与代理），失败降级为空列表 + 可读错误，不阻断手填。
 */
export async function listProviderModels(
	pluginSources: unknown,
	provider: string,
): Promise<{ models: string[]; error?: string }> {
	const distPath = findOwlImageDist(pluginSources);
	if (distPath === undefined) {
		return { models: [], error: "未在 settings.json 的 plugins 里找到已构建的 owl-image 包（本地目录源 + dist/index.js）" };
	}
	try {
		const mod = (await import(`${pathToFileURL(distPath).href}?models=${Date.now()}`)) as OwlImageModelsExports;
		if (typeof mod.listProviderModelIds !== "function") {
			return { models: [], error: "owl-image dist 缺少 listProviderModelIds 导出，请重新构建插件（npm run build）" };
		}
		return await mod.listProviderModelIds(provider);
	} catch (error) {
		return { models: [], error: error instanceof Error ? error.message : String(error) };
	}
}
