/**
 * owl desktop bridge — 模型域 handler（models.list / putProvider / putModel / discover / remove*）。
 *
 * 从 serve.ts 原样搬迁：models.json 读写与上游 /models 发现随域外移，
 * 共享闭包（reply / defaultAgentDir / getListingServices）改为显式上下文注入，逻辑零改动。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { AgentSessionServices } from "../../../core/agent-session-services.ts";
import { resolveConfigValue } from "../../../core/resolve-config-value.ts";
import { atomicWriteFileSync } from "../../../utils/atomic-file.ts";
import { clearCursorAccounts } from "../cursor-accounts.ts";
import type { DesktopClientRequest, DiscoveredModel, ModelInfoMessage, ProviderModelsMessage } from "../protocol.ts";

type Reply = (ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }) => void;

export interface ModelsHandlerContext {
	reply: Reply;
	defaultAgentDir: () => string;
	getListingServices: () => Promise<AgentSessionServices>;
}

// ---------------------------------------------------------------------------
// models.json — owl 的模型声明（唯一模型来源；不复用 pi 内置目录）
// ---------------------------------------------------------------------------

const SUPPORTED_MODEL_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const LOEAN_CATALOG_REFRESH_INTERVAL_MS = 60_000;
const dynamicCatalogRefreshAt = new Map<string, number>();

interface ModelFileEntry {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

interface ProviderFileEntry {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: ModelFileEntry[];
}

interface ModelsFile {
	providers?: Record<string, ProviderFileEntry>;
}

function declaredProviderModels(models: ModelsFile): ProviderModelsMessage[] {
	const result: ProviderModelsMessage[] = [];
	for (const [id, provider] of Object.entries(models.providers ?? {})) {
		result.push({
			id,
			...(provider.name ? { name: provider.name } : {}),
			authSource: "models_json",
			models: (provider.models ?? []).map((model) => ({
				id: model.id,
				name: model.name ?? model.id,
				...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
				...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
				...(model.reasoning ? { reasoning: model.reasoning } : {}),
				...(model.input ? { input: model.input } : {}),
			})),
		});
	}
	return result;
}

/** 内置/凭据分组的模型落成 models.json 声明时保留能力字段，避免识图等能力被降级成纯文本。 */
function modelFileEntryFrom(model: ModelInfoMessage): ModelFileEntry {
	const entry: ModelFileEntry = { id: model.id };
	if (model.name && model.name !== model.id) entry.name = model.name;
	if (model.contextWindow) entry.contextWindow = model.contextWindow;
	if (model.maxTokens) entry.maxTokens = model.maxTokens;
	if (model.reasoning) entry.reasoning = model.reasoning;
	if (model.input) entry.input = model.input;
	return entry;
}

/** 上游 /models 行公布的输入模态；未公布返回 undefined（不猜）。兼容 OpenRouter architecture.input_modalities。 */
function upstreamInputModalities(row: Record<string, unknown>): ("text" | "image")[] | undefined {
	const architecture = row.architecture as Record<string, unknown> | undefined;
	const modalities = [row.input_modalities, row.modalities, architecture?.input_modalities].find(Array.isArray) as
		| unknown[]
		| undefined;
	const flag = [row.supports_images, row.supportsImages, row.supports_vision, row.vision].find(
		(value) => typeof value === "boolean",
	);
	if (modalities?.includes("image") || flag === true) return ["text", "image"];
	if (modalities || flag === false) return ["text"];
	return undefined;
}

function readModelsFile(agentDir: string): ModelsFile {
	try {
		return JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8")) as ModelsFile;
	} catch {
		return {};
	}
}

function writeModelsFile(agentDir: string, models: ModelsFile): void {
	atomicWriteFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`);
}

/** OpenAI 兼容目录接口可用的协议（Anthropic Messages 没有标准 /models）。 */
const OPENAI_COMPAT_APIS = new Set(["openai-completions", "openai-responses"]);

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** 把上游 /models 行（或运行时 Model）压成设置页下拉用的精简条目。 */
function toDiscoveredModel(row: {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
}): DiscoveredModel {
	return {
		id: row.id,
		...(row.name && row.name !== row.id ? { name: row.name } : {}),
		...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
		...(row.maxTokens ? { maxTokens: row.maxTokens } : {}),
		...(row.reasoning ? { reasoning: true } : {}),
		...(row.input ? { input: row.input } : {}),
	};
}

/**
 * 调上游 OpenAI 兼容的 GET {baseUrl}/models，解析成发现列表。
 * baseUrl 通常已带 /v1；用 URL 相对解析避免重复或漏斜杠。
 */
async function fetchOpenAiCompatibleModels(
	baseUrl: string,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
	const response = await fetch(new URL("models", `${baseUrl.replace(/\/?$/, "/")}`), {
		headers: {
			accept: "application/json",
			...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		},
		signal,
	});
	if (!response.ok) {
		const body = (await response.text().catch(() => "")).trim().slice(0, 512);
		throw new Error(`/models ${response.status}${body ? `: ${body}` : ""}`);
	}
	const payload: unknown = await response.json();
	const rows = Array.isArray(payload) ? payload : ((payload as { data?: unknown } | null)?.data ?? []);
	if (!Array.isArray(rows)) throw new Error("/models 响应格式无法识别");
	const models: DiscoveredModel[] = [];
	for (const raw of rows) {
		const row = raw as Record<string, unknown>;
		const id = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : "";
		if (!id) continue;
		const contextWindow =
			positiveInt(row.context_window) ??
			positiveInt(row.context_length) ??
			positiveInt(row.max_model_len) ??
			positiveInt(row.contextWindow);
		const maxTokens = positiveInt(row.max_output_tokens) ?? positiveInt(row.max_tokens) ?? positiveInt(row.maxTokens);
		const reasoning =
			row.reasoning === true ||
			row.supports_reasoning === true ||
			(typeof row.id === "string" && /reason|think|r1|o[1-9]/i.test(row.id));
		const input = upstreamInputModalities(row);
		models.push(
			toDiscoveredModel({
				id,
				name:
					typeof row.display_name === "string" ? row.display_name : typeof row.name === "string" ? row.name : id,
				...(contextWindow ? { contextWindow } : {}),
				...(maxTokens ? { maxTokens } : {}),
				reasoning,
				...(input ? { input } : {}),
			}),
		);
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** 有已存凭据（auth.json）的内置供应商 → 「凭据」分组，与 models.json 声明并列出现在模型列表里。 */
async function credentialedProviderGroups(ctx: ModelsHandlerContext): Promise<ProviderModelsMessage[]> {
	const services = await ctx.getListingServices();
	const byProvider = new Map<string, ProviderModelsMessage>();
	const available = services.modelRuntime
		.getAvailableSnapshot()
		.filter((model) => services.modelRuntime.getProviderAuthStatus(model.provider).source === "stored");
	for (const model of available) {
		let group = byProvider.get(model.provider);
		if (!group) {
			group = { id: model.provider, models: [] };
			byProvider.set(model.provider, group);
		}
		if (!group.models.some((entry) => entry.id === model.id)) {
			group.models.push({
				id: model.id,
				name: model.name,
				...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
				...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
				...(model.reasoning ? { reasoning: model.reasoning } : {}),
				input: model.input,
			});
		}
	}
	return [...byProvider.values()];
}

/**
 * 模型列表的完整视图：models.json 声明 ∪ 有凭据的内置供应商；动态目录限制已声明能力。
 * 供应商增删的落盘操作也用同一视图回包，否则凭据分组会在界面凭空消失/复活。
 */
async function mergedProviderGroups(ctx: ModelsHandlerContext, agentDir: string): Promise<ProviderModelsMessage[]> {
	const declared = declaredProviderModels(readModelsFile(agentDir));
	let credentialed: ProviderModelsMessage[] = [];
	try {
		credentialed = await credentialedProviderGroups(ctx);
		// 声明里没写 input 的模型沿用内置目录能力；按运行时实际值展示，避免界面与发送行为不一致。
		const runtime = (await ctx.getListingServices()).modelRuntime;
		for (const group of declared) {
			const provider = runtime.getProvider(group.id);
			const liveGroup = credentialed.find((candidate) => candidate.id === group.id);
			if (provider?.refreshModels && liveGroup) {
				for (const liveModel of liveGroup.models) {
					const declaredModel = group.models.find((model) => model.id === liveModel.id);
					if (!declaredModel) {
						group.models.push(liveModel);
					} else if (liveModel.contextWindow) {
						declaredModel.contextWindow = declaredModel.contextWindow
							? Math.min(declaredModel.contextWindow, liveModel.contextWindow)
							: liveModel.contextWindow;
					}
				}
			}
			for (const model of group.models) {
				model.input ??= runtime.getModels(group.id).find((entry) => entry.id === model.id)?.input;
			}
		}
	} catch {
		// services 不可用时跳过凭据部分
	}
	const declaredIds = new Set(declared.map((group) => group.id));
	return [...declared, ...credentialed.filter((group) => !declaredIds.has(group.id))];
}

/** 供应商是否有已落盘凭据（登录 / 快捷接入贴的 API Key）。services 不可用时视为没有。 */
async function hasStoredCredential(ctx: ModelsHandlerContext, providerId: string): Promise<boolean> {
	try {
		return (await ctx.getListingServices()).modelRuntime.getProviderAuthStatus(providerId).source === "stored";
	} catch {
		return false;
	}
}

/** Models 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type ModelsRequest = Extract<DesktopClientRequest, { type: `models.${string}` }>;

export async function handleModelsRequest(
	ws: WebSocket,
	request: ModelsRequest,
	ctx: ModelsHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "models.list": {
			// owl 模型来源 = models.json 声明（自定义接入） ∪ 有凭据的内置供应商（登录/API Key 激活）。
			// 内置目录本身不再直接暴露：只有用户主动配置过凭据的供应商才会带出目录模型。
			const agentDir = ctx.defaultAgentDir();
			// owl:动态目录厂商（loean 等，凭据已存但基线目录为空）读表前补一次联网刷新——
			// 启动刷新是 offline，若登录时网关不可达或目录是旧版本登录的，重启后这里自愈，
			// 不用重新登录。PI_OFFLINE 时与全局一致不联网。
			if (!process.env.PI_OFFLINE) {
				try {
					const runtime = (await ctx.getListingServices()).modelRuntime;
					const staleDynamic = runtime
						.getProviders()
						.filter((provider) => {
							if (!provider.refreshModels || runtime.getProviderAuthStatus(provider.id).source !== "stored") {
								return false;
							}
							if (provider.id === "loean") {
								return (
									Date.now() - (dynamicCatalogRefreshAt.get(provider.id) ?? 0) >=
									LOEAN_CATALOG_REFRESH_INTERVAL_MS
								);
							}
							return provider.getModels().length === 0;
						})
						.map((provider) => provider.id);
					for (const providerId of staleDynamic) {
						try {
							const refresh = await runtime.refresh({
								providers: [providerId],
								allowNetwork: true,
								...(providerId === "loean" ? { force: true } : {}),
							});
							if (!refresh.aborted && !refresh.errors.has(providerId)) {
								dynamicCatalogRefreshAt.set(providerId, Date.now());
							}
						} catch {
							// 单个厂商拉取失败不挡列表（内部已捕获到 errors）
						}
					}
				} catch {
					// services 不可用时跳过自愈刷新
				}
			}
			ctx.reply(ws, request.id, { ok: true, result: await mergedProviderGroups(ctx, agentDir) });
			return;
		}
		case "models.putProvider": {
			const agentDir = ctx.defaultAgentDir();
			const models = readModelsFile(agentDir);
			const { key, baseUrl, api } = request.provider;
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
				ctx.reply(ws, request.id, { ok: false, error: "供应商 ID 只能包含字母、数字、点、下划线、连字符" });
				return;
			}
			if (!/^https?:\/\//.test(baseUrl)) {
				ctx.reply(ws, request.id, { ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" });
				return;
			}
			if (!SUPPORTED_MODEL_APIS.has(api)) {
				ctx.reply(ws, request.id, {
					ok: false,
					error: `api 必须是：${[...SUPPORTED_MODEL_APIS].join(" / ")}`,
				});
				return;
			}
			const existing = models.providers?.[key];
			models.providers = {
				...(models.providers ?? {}),
				[key]: {
					...existing,
					...(request.provider.name ? { name: request.provider.name } : {}),
					baseUrl,
					api,
					...(request.provider.apiKey ? { apiKey: request.provider.apiKey } : {}),
					models: existing?.models ?? [],
				},
			};
			writeModelsFile(agentDir, models);
			ctx.reply(ws, request.id, { ok: true, result: await mergedProviderGroups(ctx, agentDir) });
			return;
		}
		case "models.putModel": {
			const agentDir = ctx.defaultAgentDir();
			const models = readModelsFile(agentDir);
			let provider = models.providers?.[request.providerKey];
			if (!provider) {
				// 凭据分组（登录过/贴过 Key 的内置供应商）不在 models.json：首次添加模型时落成声明。
				const group = (await credentialedProviderGroups(ctx)).find((entry) => entry.id === request.providerKey);
				if (!group) {
					ctx.reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
					return;
				}
				provider = {
					...(group.name ? { name: group.name } : {}),
					models: group.models.map(modelFileEntryFrom),
				};
				models.providers = { ...(models.providers ?? {}), [request.providerKey]: provider };
			}
			if (!request.model.id.trim()) {
				ctx.reply(ws, request.id, { ok: false, error: "模型 ID 不能为空" });
				return;
			}
			const entry: ModelFileEntry = { id: request.model.id.trim() };
			if (request.model.name) entry.name = request.model.name;
			if (request.model.contextWindow) entry.contextWindow = request.model.contextWindow;
			if (request.model.maxTokens) entry.maxTokens = request.model.maxTokens;
			if (request.model.reasoning != null) entry.reasoning = request.model.reasoning;
			if (request.model.input?.length) entry.input = request.model.input;
			const rest = (provider.models ?? []).filter((m) => m.id !== entry.id);
			provider.models = [...rest, entry];
			writeModelsFile(agentDir, models);
			ctx.reply(ws, request.id, { ok: true, result: await mergedProviderGroups(ctx, agentDir) });
			return;
		}
		case "models.discover": {
			const agentDir = ctx.defaultAgentDir();
			const providerKey = request.providerKey.trim();
			if (!providerKey) {
				ctx.reply(ws, request.id, { ok: false, error: "供应商不能为空" });
				return;
			}
			const declared = readModelsFile(agentDir).providers?.[providerKey];
			let runtime: AgentSessionServices["modelRuntime"] | undefined;
			try {
				runtime = (await ctx.getListingServices()).modelRuntime;
			} catch {
				runtime = undefined;
			}
			const provider = runtime?.getProvider(providerKey);
			const known = (): DiscoveredModel[] =>
				(runtime?.getModels(providerKey) ?? []).map((model) =>
					toDiscoveredModel({
						id: model.id,
						name: model.name,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						reasoning: model.reasoning,
						input: model.input,
					}),
				);

			// 1) 内置动态目录（loean / cursor 等）：联网 refresh 后读运行时目录。
			if (provider?.refreshModels && !process.env.PI_OFFLINE && runtime) {
				try {
					const refreshed = await runtime.refresh({
						providers: [providerKey],
						allowNetwork: true,
						signal: AbortSignal.timeout(25_000),
					});
					const refreshError = refreshed.errors.get(providerKey);
					const models = known();
					if (models.length > 0) {
						ctx.reply(ws, request.id, {
							ok: true,
							result: {
								models,
								...(refreshError
									? { error: refreshError instanceof Error ? refreshError.message : String(refreshError) }
									: {}),
							},
						});
						return;
					}
					if (refreshError) {
						ctx.reply(ws, request.id, {
							ok: false,
							error: refreshError instanceof Error ? refreshError.message : String(refreshError),
						});
						return;
					}
				} catch (error) {
					const catalog = known();
					if (catalog.length > 0) {
						ctx.reply(ws, request.id, {
							ok: true,
							result: {
								models: catalog,
								error: `联网拉取失败，已用本地目录（${error instanceof Error ? error.message : String(error)}）`,
							},
						});
						return;
					}
					ctx.reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}

			// 2) OpenAI 兼容：直接打上游 GET /models（自定义供应商或内置 openai-completions）。
			const baseUrl = declared?.baseUrl ?? provider?.baseUrl;
			const api = declared?.api ?? provider?.getModels()[0]?.api;
			if (baseUrl && (!api || OPENAI_COMPAT_APIS.has(api))) {
				let apiKey: string | undefined;
				if (declared?.apiKey) {
					try {
						apiKey = resolveConfigValue(declared.apiKey);
					} catch {
						apiKey = declared.apiKey.startsWith("$") ? undefined : declared.apiKey;
					}
				}
				if (!apiKey && runtime) {
					try {
						apiKey = (await runtime.getAuth(providerKey))?.auth.apiKey;
					} catch {
						// 没凭据就匿名试一下（部分本地网关不需要 Key）
					}
				}
				try {
					const models = await fetchOpenAiCompatibleModels(baseUrl, apiKey, AbortSignal.timeout(25_000));
					if (models.length > 0) {
						ctx.reply(ws, request.id, { ok: true, result: { models } });
						return;
					}
				} catch (error) {
					const catalog = known();
					if (catalog.length > 0) {
						ctx.reply(ws, request.id, {
							ok: true,
							result: {
								models: catalog,
								error: `上游 /models 失败，已用本地目录（${error instanceof Error ? error.message : String(error)}）`,
							},
						});
						return;
					}
					ctx.reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}

			// 3) 兜底：本地内置/已声明目录（不能联网或协议不支持时仍给出可选列表）。
			const catalog = known();
			if (catalog.length > 0) {
				ctx.reply(ws, request.id, {
					ok: true,
					result: {
						models: catalog,
						error:
							provider?.refreshModels || (baseUrl && OPENAI_COMPAT_APIS.has(api ?? ""))
								? undefined
								: "该供应商没有上游目录接口，以下是本地已知模型",
					},
				});
				return;
			}
			ctx.reply(ws, request.id, {
				ok: false,
				error: "无法拉取上游模型：请确认已配置 API Key / 登录，且供应商支持模型目录接口",
			});
			return;
		}
		case "models.removeModel": {
			const agentDir = ctx.defaultAgentDir();
			const models = readModelsFile(agentDir);
			const provider = models.providers?.[request.providerKey];
			if (!provider) {
				// 凭据分组（登录过/贴过 Key 的内置供应商）不在 models.json 里。
				// 删单个模型时，把「剩余模型」落成声明：声明优先后凭据分组不再覆盖该供应商，
				// 否则界面会报「未知供应商」且列表不变，表现为删除按钮无响应。
				const group = (await credentialedProviderGroups(ctx)).find((entry) => entry.id === request.providerKey);
				if (!group) {
					ctx.reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
					return;
				}
				if (!group.models.some((entry) => entry.id === request.modelId)) {
					ctx.reply(ws, request.id, { ok: false, error: `未知模型：${request.modelId}` });
					return;
				}
				models.providers = {
					...(models.providers ?? {}),
					[request.providerKey]: {
						...(group.name ? { name: group.name } : {}),
						models: group.models.filter((entry) => entry.id !== request.modelId).map(modelFileEntryFrom),
					},
				};
				writeModelsFile(agentDir, models);
				ctx.reply(ws, request.id, { ok: true, result: await mergedProviderGroups(ctx, agentDir) });
				return;
			}
			const before = provider.models?.length ?? 0;
			provider.models = (provider.models ?? []).filter((m) => m.id !== request.modelId);
			if ((provider.models?.length ?? 0) === before) {
				ctx.reply(ws, request.id, { ok: false, error: `未知模型：${request.modelId}` });
				return;
			}
			writeModelsFile(agentDir, models);
			ctx.reply(ws, request.id, { ok: true, result: await mergedProviderGroups(ctx, agentDir) });
			return;
		}
		case "models.removeProvider": {
			const agentDir = ctx.defaultAgentDir();
			const models = readModelsFile(agentDir);
			// 删除供应商 = 移除 models.json 声明 + 注销已存凭据。只删声明的话，
			// 登录过/贴过 Key 的内置供应商仍会凭「凭据分组」出现在 models.list 里，
			// 表现为"删了还在"。只登录过、没写进 models.json 的供应商也走这里删凭据。
			const declared = Boolean(models.providers?.[request.providerKey]);
			const storedCredential = await hasStoredCredential(ctx, request.providerKey);
			if (!declared && !storedCredential) {
				ctx.reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
				return;
			}
			if (storedCredential) {
				// 先注销凭据再删声明：注销失败时什么都没变，重试即是完整重来。
				await (await ctx.getListingServices()).modelRuntime.logout(request.providerKey);
			}
			if (request.providerKey === "cursor") {
				clearCursorAccounts(agentDir);
			}
			if (declared && models.providers) {
				delete models.providers[request.providerKey];
				writeModelsFile(agentDir, models);
			}
			ctx.reply(ws, request.id, { ok: true, result: await mergedProviderGroups(ctx, agentDir) });
			return;
		}
	}
}
