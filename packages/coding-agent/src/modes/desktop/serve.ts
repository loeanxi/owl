/**
 * owl desktop bridge.
 *
 * JSON over WebSocket between the desktop UI and agent sessions.
 * - Session lifecycle rides on AgentSessionRuntime (same factory pattern as the
 *   CLI: services per cwd, session bound to them).
 * - Wire events are the same JsonAgentSessionEvent stream print mode emits
 *   (partials stripped, tool calls carry id + name).
 * - Tool approvals: approvalMode "confirm" routes every tool_call through a
 *   permission_request round-trip to the UI; "plan" only lets read-only tools
 *   through; "auto" runs everything without asking.
 * - v1 scope: create / prompt / abort / list / models / settings. Resume, fork,
 *   and diff-level approvals land with the desktop UI.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type WebSocket, WebSocketServer } from "ws";
import { getAgentDir, getGlobalSkillsDir } from "../../config.ts";
import {
	type AgentPresetDefinition,
	applyPresetToolModifiers,
	deleteCustomAgentPreset,
	getAgentPreset,
	getSessionPresetId,
	listAgentPresets,
	resolveAgentPreset,
	resolvePresetAppendPrompt,
	saveCustomAgentPreset,
	setSessionPresetEntry,
} from "../../core/agent-presets.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../core/agent-session-services.ts";
import {
	type ContextInsightState,
	findContextInsightByCwd,
	getContextInsight,
	reconstructContextInsight,
} from "../../core/context-insight.ts";
import { setDiffApprovalBroadcaster } from "../../core/diff-approval/registry.ts";
import { EvaluationService, type EvaluationServiceOptions } from "../../core/evaluation/service.ts";
import type { InlineExtension, ToolDefinition } from "../../core/extensions/index.ts";
import { importExtensionRuntimeModule } from "../../core/extensions/loader.ts";
import { installHtmlPlanSkill } from "../../core/html-plan-skill.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import {
	createMailTools,
	getMailAgentContext,
	MAIL_AGENT_CONTEXT_ENTRY,
	mailAgentSystemPrompt,
	validateMailAgentContext,
} from "../../core/mail/agent.ts";
import { MailService, type MailServiceOptions } from "../../core/mail/service.ts";
import type { MailAgentContext } from "../../core/mail/types.ts";
import { connectMcpServers, type McpConnections } from "../../core/mcp-lite.ts";
import type { McpServerConfig } from "../../core/mcp-servers.ts";
import { getMediaBridgeHttpHandler } from "../../core/media-bridge-channel.ts";
import { MEMORY_WRITE_GUIDANCE } from "../../core/memory/write-policy.ts";
import { ModelRegistry } from "../../core/model-registry.ts";
import { NewsService, type NewsServiceOptions } from "../../core/news/service.ts";
import type { NewsRequest } from "../../core/news/types.ts";
import { loadPromptTemplates } from "../../core/prompt-templates.ts";
import {
	cancelAllPendingQuestions,
	cancelPendingQuestionsForSession,
	getAllPendingQuestionRequests,
	getPendingQuestionRequests,
	setQuestionChannel,
} from "../../core/question-channel.ts";
import {
	createResearchExtension,
	getResearchApprovalMode,
	getResearchMode,
	normalizeResearchMode,
	RESEARCH_APPROVAL_ENTRY,
	RESEARCH_MODE_ENTRY,
	RESEARCH_PUBLISH_TOOL,
	updateResearchMode,
} from "../../core/research/agent.ts";
import { listRewindTargets } from "../../core/rewind/engine.ts";
import { disposeSessionRewindTracker, getSessionRewindTracker } from "../../core/rewind/registry.ts";
import {
	buildSessionExportFilename,
	filterEntriesToTurns,
	formatSessionMarkdown,
	listSessionTurns,
	sessionDisplayName,
} from "../../core/session-export.ts";
import type { SessionInfo } from "../../core/session-manager.ts";
import { getDefaultSessionDirPath, SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { loadSkills } from "../../core/skills.ts";
import { buildSystemPromptSections } from "../../core/system-prompt.ts";
import { createAllToolDefinitions } from "../../core/tools/index.ts";
import { subscribeWorkspaceViewers } from "../../core/workspace-viewers.ts";
import { builtInExtensions } from "../../extensions/index.ts";
import { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../../utils/atomic-file.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { type JsonAgentSessionEvent, toJsonEvent } from "../json-event.ts";
import { DESKTOP_AGENT_INSTRUCTIONS, desktopAgentPromptOptions } from "./agent-instructions.ts";
import { saveSessionApprovalMode, sessionApprovalMode } from "./approval-history.ts";
import {
	ARCHIVE_PURGE_INTERVAL_MS,
	archiveRetentionDays,
	DEFAULT_ARCHIVE_RETENTION_DAYS,
	readArchiveMeta,
	writeArchiveMeta,
} from "./archive-meta.ts";
import {
	type BridgeRequest,
	bridgePluginSessionTools,
	bridgeRequestRoutes,
	closeBridgePlugins,
	handleBridgePluginHttp,
	type LoadedBridgePlugin,
	loadBridgePlugins,
} from "./bridge-plugins.ts";
import { BrowserHub } from "./browser-hub.ts";
import { isReadOnlyDesktopTool } from "./browser-permissions.ts";
import { BuildChecker } from "./build-check.ts";
import {
	clearCursorAccounts,
	credentialFromAccount,
	listCursorAccountsPublic,
	removeCursorAccount,
	switchCursorAccount,
	upsertCursorAccount,
} from "./cursor-accounts.ts";
import { DesktopEventFanout } from "./event-fanout.ts";
import { type BrowserHandlerContext, handleIabRequest } from "./handlers/browser.ts";
import { handleMirrorRequest, type MirrorHandlerContext } from "./handlers/mirror.ts";
import { handleTermRequest, type TerminalHandlerContext } from "./handlers/terminal.ts";
import {
	handleDialogRequest,
	handleDiffApprovalRequest,
	handleScheduleRequest,
	type WorkbenchHandlerContext,
} from "./handlers/workbench.ts";
import {
	handleFsRequest,
	handleGitRequest,
	handleProjectRequest,
	handleWatchRequest,
	type WorkspaceHandlerContext,
} from "./handlers/workspace.ts";
import { MirrorFrameDelivery } from "./mirror/frame-delivery.ts";
import { MirrorProjectionAccess } from "./mirror/projection-access.ts";
import { MirrorHub } from "./mirror-hub.ts";
import { handleNewsHttp } from "./news-http.ts";
import { callNewsModel } from "./news-model.ts";
import { createNewsTools } from "./news-tools.ts";
import { DesktopPermissionQueue } from "./permission-queue.ts";
import { createPiBashTool, piResourceLoaderOptions } from "./pi-runtime.ts";
import { streamingBehaviorForPrompt } from "./prompt-delivery.ts";
import type {
	CommandsListResult,
	DiscoveredModel,
	IabFrameMessage,
	IabPageInfo,
	MirrorFrameMessage,
	ModelInfoMessage,
	PermissionRequestMessage,
	RewindExecuteResult,
	RewindImpactFile,
	RewindImpactResult,
	RewindTargetsResult,
	SessionSnapshotPayload,
	SlashCommandEntry,
} from "./protocol.ts";
import { ScheduleService } from "./schedule-service.ts";
import { SidebarError } from "./sidebar-fs.ts";
import { createSidebarOpenTool } from "./sidebar-open-tool.ts";
import type { DirectoryWatchers } from "./sidebar-watch.ts";
import {
	createSkill,
	deleteSkill,
	disabledNamesToPatterns,
	listSkills,
	readSkill,
	SkillCenterError,
	setSkillEnabled,
	updateSkill,
} from "./skills-center.ts";
import { TerminalManager } from "./terminals.ts";
import { isTrustedDesktopOrigin, resolveUiRoot, serveUi } from "./ui-static.ts";

// ---------------------------------------------------------------------------
// models.json — owl 的模型声明（唯一模型来源；不复用 pi 内置目录）
// ---------------------------------------------------------------------------

const SUPPORTED_MODEL_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

/** AgentSession ThinkingLevel 合法值（session.setThinkingLevel 校验用）。 */
const THINKING_LEVEL_VALUES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** plan 模式的系统提示词附录：创建会话时即告知模型只读约束与目标（产出计划）。 */
const PLAN_MODE_ADDENDUM = [
	"<plan_mode>",
	"当前会话处于「计划（plan）模式」：只允许读取文件、观察已有浏览器页面和读取控制台/网络证据。",
	"浏览器标签页只允许 list / select；不能新开、关闭、导航、输入或清空证据。",
	"创建、修改、删除文件或执行有副作用的命令都会被直接拒绝。",
	"请完成调研后给出一份清晰、可执行的实施计划，等用户确认后再动手；不要尝试绕过只读约束。",
	"</plan_mode>",
].join("\n");

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

/** 导出落盘不覆盖同名文件：已存在时追加 " (2)"、" (3)" 序号。 */
function uniqueExportPath(dir: string, filename: string): string {
	const dot = filename.lastIndexOf(".");
	const base = dot > 0 ? filename.slice(0, dot) : filename;
	const ext = dot > 0 ? filename.slice(dot) : "";
	let candidate = join(dir, filename);
	for (let n = 2; existsSync(candidate); n += 1) candidate = join(dir, `${base} (${n})${ext}`);
	return candidate;
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

import type {
	ApprovalMode,
	DesktopClientRequest,
	DesktopServerMessage,
	ProviderModelsMessage,
	SessionCreateRequest,
	SessionResumeRequest,
	SessionStatsResult,
	SystemPromptPreviewResult,
} from "./protocol.ts";

/** 打开系统默认浏览器（OAuth 授权用）。 */
function openInBrowser(url: string): void {
	try {
		spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
	} catch {
		// 打不开就让用户手动复制链接（URL 会通过事件广播给 UI）
	}
}

export type {
	ApprovalMode,
	DesktopClientRequest,
	DesktopServerMessage,
	ModelInfoMessage,
	PermissionRequestMessage,
	ProviderModelsMessage,
	ServerEventMessage,
	ServerResponseMessage,
} from "./protocol.ts";
export { DEFAULT_ARCHIVE_RETENTION_DAYS, isTrustedDesktopOrigin };

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface DesktopServerOptions {
	port?: number;
	host?: string;
	/** Default agent dir (defaults to OWL_CODING_AGENT_DIR / ~/.owl/agent). */
	agentDir?: string;
	/** Default cwd for session.create requests that omit one. */
	cwd?: string;
	/** MCP servers (name → config); when omitted, read from settings.json `mcpServers`. */
	mcpServers?: Record<string, McpServerConfig>;
	/** Called for diagnostics; defaults to console.error. */
	onDiagnostic?: (message: string) => void;
	/** Local mail dependencies for offline bridge regression tests. */
	mail?: Partial<Pick<MailServiceOptions, "fetch" | "now" | "seal" | "unseal">>;
	/** Local dependencies for isolated news integration tests; production uses the Owl model runtime. */
	news?: Partial<
		Pick<
			NewsServiceOptions,
			"callModel" | "listModels" | "fetch" | "resolveHost" | "resolvePublicHost" | "resolveModel"
		>
	>;
	/** Fake evaluation dependencies for isolated local tests; never use paid models in tests. */
	evaluation?: Partial<
		Pick<EvaluationServiceOptions, "listModels" | "invoke" | "check" | "builtinTasks" | "idleTimeoutMs">
	>;
}

export interface DesktopServerHandle {
	port: number;
	close(): Promise<void>;
}

export async function startDesktopServer(options: DesktopServerOptions = {}): Promise<DesktopServerHandle> {
	const onDiagnostic = options.onDiagnostic ?? ((message: string) => console.error(`[owl] ${message}`));
	try {
		installHtmlPlanSkill(options.agentDir ?? getAgentDir());
	} catch (error) {
		onDiagnostic(`html-plan skill install failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	// 桥进程不经过 main.ts，需自行装代理 dispatcher：fetch 只有装了 EnvHttpProxyAgent
	// 才认 HTTP(S)_PROXY，否则 OAuth 设备码请求直连 github.com，直连不通时就地超时——
	// 浏览器永远不弹，UI 停在「正在启动登录流程…」。
	try {
		const settingsManager = await import("../../core/settings-manager.ts").then((m) =>
			m.SettingsManager.create(options.cwd ?? process.cwd(), options.agentDir ?? getAgentDir()),
		);
		applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	} catch (error) {
		// settings 坏了只降级为「仅环境变量」，别拦着桥启动
		onDiagnostic(`settings load failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	configureHttpDispatcher();
	// 预热 rg/fd：二进制装进 ~/.owl/agent/bin 后 getShellEnv 会把它拼在 bash PATH 最前，
	// 模型在 bash 里直接敲 rg 就不再依赖用户 PATH 的好坏（中文用户名被转码毁掉的机器照样可用）。
	// 只在本进程跑一次，fire-and-forget：装不上只记诊断，不拦桥启动。
	void Promise.all([ensureTool("rg"), ensureTool("fd")])
		.then(([rgPath, fdPath]) => {
			if (rgPath) onDiagnostic(`rg ready: ${rgPath}`);
			if (fdPath) onDiagnostic(`fd ready: ${fdPath}`);
		})
		.catch((error) => onDiagnostic(`tool warmup failed: ${error instanceof Error ? error.message : String(error)}`));
	/** sessionId → live runtime + event subscription（approvalMode/preset 为运行时可变的 holder）。 */
	const sessions = new Map<
		string,
		{
			runtime: AgentSessionRuntime;
			unsubscribe: () => void;
			approvalMode: { current: ApprovalMode };
			preset: { current: AgentPresetDefinition };
			runStart: { priorEntryIds?: Set<string> };
		}
	>();
	/** Requests for a session wait until its preset runtime has finished being replaced. */
	const presetTransitions = new Map<string, Promise<void>>();
	const clients = new Set<WebSocket>();
	const clientOrigins = new WeakMap<WebSocket, string | undefined>();
	/**
	 * 历史会话的上下文重建缓存：sessionId → { key, rows }。key 取会话文件
	 * mtime（磁盘）或投影末条 id+消息数（运行中），ContextView 2s 轮询时
	 * 未变化的会话直接命中缓存，不重复读文件/分类。
	 */
	const contextRebuildCache = new Map<
		string,
		{ key: string; rows: Pick<ContextInsightState, "requests" | "events" | "tools"> }
	>();
	/** 注册表无数据时从会话转录重建上下文洞察；会话不存在或没有消息回 undefined。 */
	const contextInsightFromHistory = async (
		sessionId: string,
	): Promise<Pick<ContextInsightState, "requests" | "events" | "tools"> | undefined> => {
		try {
			const running = sessions.get(sessionId)?.runtime.session.sessionManager;
			if (running) {
				const projection = running.buildSessionProjection();
				const lastEntry = projection.entries[projection.entries.length - 1];
				const key = `${lastEntry?.sourceEntry.id ?? ""}:${projection.messages.length}`;
				const cached = contextRebuildCache.get(sessionId);
				if (cached && cached.key === key) return cached.rows;
				const rows = reconstructContextInsight(projection.entries);
				contextRebuildCache.set(sessionId, { key, rows });
				return rows;
			}
			const sessionPath = await findSessionFile(sessionId);
			if (!sessionPath) return undefined;
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(sessionPath).mtimeMs;
			} catch {
				return undefined;
			}
			const key = String(mtimeMs);
			const cached = contextRebuildCache.get(sessionId);
			if (cached && cached.key === key) return cached.rows;
			const rows = reconstructContextInsight(SessionManager.open(sessionPath).buildSessionProjection().entries);
			contextRebuildCache.set(sessionId, { key, rows });
			return rows;
		} catch {
			// 历史重建只是兜底展示：失败就回空，走注册表的正常空态
			return undefined;
		}
	};
	/** 终端会话表（term.* 路由的目标）；termId → 创建它的连接，断线时兜底回收 */
	const terminals = new TerminalManager();
	const wsTerms = new WeakMap<WebSocket, Set<string>>();
	const viewerRequests = new WeakMap<WebSocket, Set<AbortController>>();
	/** IAB 帧流订阅：连接 → 它在看的 pageId 集合（断线兜底回收）。 */
	const iabSubscriptions = new WeakMap<WebSocket, Set<string>>();
	/** 镜像帧流订阅：连接 → 它在看的 windowId 集合（断线兜底回收）。 */
	const mirrorSubscriptions = new WeakMap<WebSocket, Set<string>>();
	const mirrorFrames = new MirrorFrameDelivery();
	/** 窗口镜像 hub：帧流与 UI 输入均按连接限定；不注册 agent 工具。 */
	const mirror = new MirrorHub({
		onFrame: (windowId, data, width, height, geometry) => {
			const message: MirrorFrameMessage = { type: "mirror.frame", windowId, data, width, height, geometry };
			mirrorFrames.publish(message);
		},
		onWindowsChanged: (windows) => broadcast({ type: "mirror.windows", windows }),
		onDiagnostic,
	});
	const mirrorProjectionAccess = new MirrorProjectionAccess(mirror);
	/** 内嵌浏览器 hub：UI 面板与 agent 工具共用的无头浏览器。 */
	const iab = new BrowserHub({
		onFrame: (pageId, data, width, height) => {
			const message: IabFrameMessage = { type: "iab.frame", pageId, data, width, height };
			const payload = JSON.stringify(message);
			for (const client of clients) {
				if (client.readyState === client.OPEN && iabSubscriptions.get(client)?.has(pageId)) {
					client.send(payload);
				}
			}
		},
		onPagesChanged: (pages: IabPageInfo[], origin, originSessionId) =>
			broadcast({ type: "iab.pages", pages, origin, originSessionId }),
		onFileChooser: (pageId: string, multiple: boolean) => broadcast({ type: "iab.filechooser", pageId, multiple }),
		onDiagnostic,
	});
	/** requestId → resolver for tool calls awaiting a user decision */
	const pendingPermissions = new DesktopPermissionQueue(broadcast);
	/** Shared services for non-session queries (models.list); built lazily. */
	let listServices: AgentSessionServices | undefined;
	/** MCP connections established at startup. */
	let mcp: McpConnections | undefined;
	/** 侧边栏文件树 watcher：项目（resolved cwd）→ watcher 集。 */
	const sidebarWatchers = new Map<string, DirectoryWatchers>();
	/** 归档过期巡检定时器（close() 时清理）。 */
	let archiveTimer: ReturnType<typeof setInterval> | undefined;
	let news: NewsService | undefined;
	let closingNews = false;
	let mail: MailService | undefined;
	let closingMail = false;
	let evaluation: EvaluationService | undefined;
	let closingEvaluation = false;

	function getEvaluationService(): EvaluationService {
		if (closingEvaluation) throw new Error("模型测评服务正在关闭");
		evaluation ??= new EvaluationService({ agentDir: defaultAgentDir(), ...options.evaluation });
		return evaluation;
	}

	function getMailService(): MailService {
		if (closingMail) throw new Error("邮箱服务正在关闭");
		mail ??= new MailService({ agentDir: defaultAgentDir(), ...options.mail });
		return mail;
	}

	function getNewsService(): NewsService {
		if (closingNews) throw new Error("资讯服务正在关闭");
		if (!news) {
			news = new NewsService({
				agentDir: defaultAgentDir(),
				...options.news,
				resolveModel:
					options.news?.resolveModel ??
					(async (_capability, configured) => {
						const services = await getListingServices();
						await services.modelRuntime.refresh({ allowNetwork: false });
						const provider = services.settingsManager.getDefaultProvider();
						const id = services.settingsManager.getDefaultModel();
						const fallback = provider && id ? { provider, id } : services.modelRuntime.getAvailableSnapshot()[0];
						const choice = configured ?? fallback;
						if (!choice) throw new Error("资讯模型未配置，请先在 Owl 模型设置中选择模型。");
						const model = services.modelRuntime.getModel(choice.provider, choice.id);
						if (!model) throw new Error(`资讯模型不存在：${choice.provider}/${choice.id}`);
						const registry = new ModelRegistry(services.modelRuntime);
						const auth = await registry.getApiKeyAndHeaders(model);
						if (!auth.ok) throw new Error(auth.error);
						return { provider: String(model.provider), id: model.id };
					}),
				callModel:
					options.news?.callModel ??
					(async (request) => {
						const services = await getListingServices();
						await services.modelRuntime.refresh({ allowNetwork: false });
						const provider = services.settingsManager.getDefaultProvider();
						const id = services.settingsManager.getDefaultModel();
						return callNewsModel(
							{
								registry: new ModelRegistry(services.modelRuntime),
								defaultModel: provider && id ? { provider, id } : undefined,
							},
							request,
						);
					}),
				listModels:
					options.news?.listModels ??
					(async () => {
						const services = await getListingServices();
						await services.modelRuntime.refresh({ allowNetwork: false });
						return services.modelRuntime
							.getAvailableSnapshot()
							.map((model) => ({ provider: String(model.provider), id: model.id, name: model.name }));
					}),
			});
			news.start();
		}
		return news;
	}

	async function closeNews(): Promise<void> {
		closingNews = true;
		await news?.close();
	}

	function newsRequest(request: NewsRequest): Promise<unknown> {
		return getNewsService().handle(request);
	}

	/** sessionId → 路径 + mtime：避免热路径反复扫 Owl-history。 */
	const sessionPathCache = new Map<string, { path: string; mtimeMs: number }>();

	/** 按 id 定位历史会话的 JSONL 文件（只读 header / 文件名，不解析全文）。 */
	async function findSessionFile(sessionId: string): Promise<string | undefined> {
		const cached = sessionPathCache.get(sessionId);
		if (cached) {
			try {
				if (existsSync(cached.path) && statSync(cached.path).mtimeMs === cached.mtimeMs) return cached.path;
			} catch {
				// 缓存失效后重新定位
			}
			sessionPathCache.delete(sessionId);
		}
		const path =
			SessionManager.findPathById(sessionId) ??
			SessionManager.findPathById(sessionId, join(defaultAgentDir(), "mail", "agent-sessions"));
		if (!path) return undefined;
		try {
			sessionPathCache.set(sessionId, { path, mtimeMs: statSync(path).mtimeMs });
		} catch {
			// 定位成功但 stat 失败：仍返回路径，不写缓存
		}
		return path;
	}

	/** 卸载已挂载的会话运行时：停掉进行中的回复、退订事件并移出运行时表。 */
	async function unmountSessionRuntime(sessionId: string): Promise<void> {
		const mounted = sessions.get(sessionId);
		pendingPermissions.cancelSession(sessionId);
		cancelPendingQuestionsForSession(sessionId);
		disposeSessionRewindTracker(sessionId);
		if (mounted) {
			try {
				await mounted.runtime.session.abort();
			} catch {
				// 没有进行中的回复时 abort 可能抛错，卸载流程不受影响
			}
			try {
				await mounted.runtime.dispose();
			} finally {
				mounted.unsubscribe();
				sessions.delete(sessionId);
			}
		}
		// Runtime disposal settles extension shutdown before releasing session browser resources.
		await iab.disposeSession(sessionId);
	}

	/**
	 * 巡检归档：删掉归档超过保留期的会话 JSONL（先卸载运行时），顺带清掉
	 * 文件已不存在的幽灵记录。任何一条失败都留着下轮再试。
	 */
	async function purgeExpiredArchivedSessions(): Promise<number> {
		const agentDir = defaultAgentDir();
		const meta = readArchiveMeta(agentDir);
		const entries = meta.sessions ?? {};
		const cutoff = Date.now() - archiveRetentionDays(meta) * 86_400_000;
		let purged = 0;
		let removedGhosts = 0;
		for (const [sessionId, entry] of Object.entries(entries)) {
			const archivedAt = Date.parse(entry.archivedAt);
			const expired = archivedAt > 0 && archivedAt <= cutoff;
			const path =
				entry.path && existsSync(entry.path) ? entry.path : expired ? await findSessionFile(sessionId) : undefined;
			if (!path) {
				if (!existsSync(entry.path ?? "")) {
					// 文件已不在（手动删过）：无论到期与否，记录清掉
					delete entries[sessionId];
					removedGhosts++;
				}
				continue;
			}
			if (!expired) continue;
			await unmountSessionRuntime(sessionId);
			try {
				unlinkSync(path);
				purged++;
				delete entries[sessionId];
			} catch (error) {
				onDiagnostic(`归档清理失败（${sessionId}）：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (purged > 0 || removedGhosts > 0) {
			meta.sessions = entries;
			writeArchiveMeta(agentDir, meta);
		}
		return purged;
	}

	function startArchivePurgeTimer(): void {
		void purgeExpiredArchivedSessions().catch((error) => onDiagnostic(`归档巡检失败：${String(error)}`));
		archiveTimer = setInterval(() => {
			void purgeExpiredArchivedSessions().catch((error) => onDiagnostic(`归档巡检失败：${String(error)}`));
		}, ARCHIVE_PURGE_INTERVAL_MS);
	}

	function resolveMcpServerConfigs(): Record<string, McpServerConfig> {
		if (options.mcpServers) return options.mcpServers;
		try {
			const raw = JSON.parse(readFileSync(join(defaultAgentDir(), "settings.json"), "utf-8")) as {
				mcpServers?: Record<string, McpServerConfig>;
			};
			return raw.mcpServers ?? {};
		} catch {
			return {};
		}
	}

	async function getMcpTools(): Promise<ToolDefinition[]> {
		if (!mcp) {
			const servers = resolveMcpServerConfigs();
			mcp =
				Object.keys(servers).length > 0
					? await connectMcpServers(servers, onDiagnostic)
					: { tools: [], connections: [], close: async () => {} };
		}
		return mcp.tools;
	}

	/** 进行中的登录（auth.login 长请求）与其待回答的界面提问。 */
	let activeLogin: { controller: AbortController } | null = null;
	let pendingPrompt: {
		ask: { type: string; message?: string; placeholder?: string; options?: readonly { id: string; label: string }[] };
		resolve: (value: string) => void;
		reject: (error: Error) => void;
	} | null = null;

	const eventFanout = new DesktopEventFanout({
		clients: () => clients,
		send: (client, payload) => client.send(payload),
	});

	function broadcast(message: DesktopServerMessage): void {
		eventFanout.broadcast(message);
	}

	/** 同时到达的 session.list 共享同一次扫描；目录不同则分开。 */
	const sessionListInflight = new Map<string, Promise<SessionInfo[]>>();
	async function listSessionsShared(sessionDir: string | undefined): Promise<SessionInfo[]> {
		const key = sessionDir ?? "";
		const existing = sessionListInflight.get(key);
		if (existing) return existing;
		const pending = SessionManager.listAll(sessionDir).finally(() => {
			sessionListInflight.delete(key);
		});
		sessionListInflight.set(key, pending);
		return pending;
	}

	/** ask_user_question 出发前的守卫：一个 UI 都没连着时提问必然无人应答。 */
	function hasConnectedClients(): boolean {
		for (const client of clients) {
			if (client.readyState === client.OPEN) return true;
		}
		return false;
	}

	// 「向用户提问」通道：owl-ask-user 插件经 question-channel 注册表取用这条
	// WebSocket 往返；桥关闭时摘除（之后插件的工具会被每轮 reconcile 摘掉）。
	setQuestionChannel({ broadcast, hasConnectedClients });

	// 改动审批广播：owl-diff-approval 插件每次落库/处理经 diff-approval 注册表
	// 推 diffApproval.changed，工作台 ReviewTab 据此刷新待审清单。
	setDiffApprovalBroadcaster(broadcast);

	// 自动化任务调度：落盘 ~/.owl/agent/schedule，桥进程内跳表；到点把提示词作为
	// 普通跟进消息送回目标会话（同 session.prompt 链路），会话没挂载按错过策略处理。
	// sessionId === "__new__" 表示每次到点新建会话执行（周报这类「一期一会」的任务）：
	// 无界面挂载（HEADLESS_WS 只用于吞掉 reply，事件仍全局 broadcast），默认工作目录、
	// 默认模型、auto 审批——与 mail agent 会话同一套参数。
	const HEADLESS_WS = { readyState: 0 } as unknown as WebSocket;
	const createScheduledSession = async (): Promise<string> => {
		const sessionManager = SessionManager.create(options.cwd ?? process.cwd());
		await mountSession(HEADLESS_WS, "schedule-new", {
			sessionManager,
			agentDir: defaultAgentDir(),
			approvalMode: "auto",
		});
		return sessionManager.getSessionId();
	};
	const schedule = new ScheduleService({
		agentDir: defaultAgentDir(),
		onDiagnostic,
		onChanged: () => broadcast({ type: "schedule.changed" }),
		deliver: async (sessionId, text) => {
			let targetId = sessionId;
			if (sessionId === "__new__") {
				targetId = await createScheduledSession();
				onDiagnostic(`schedule created session ${targetId.slice(0, 8)} for a new-run task`);
			}
			const target = sessions.get(targetId);
			if (!target) return null;
			const behavior = streamingBehaviorForPrompt(target.runtime.session.isStreaming, "followUp");
			await target.runtime.session.prompt(text, { ...(behavior ? { streamingBehavior: behavior } : {}) });
			return targetId;
		},
	});
	schedule.start();

	/** owl-genui：把组件动作格式化成回传给模型的消息（协议见 owl-genui SKILL.md）。 */
	function formatOwlUiActionMessage(action: string, payload: Record<string, unknown>): string {
		return `[owl-ui-action] ${action}。用户刚刚在界面中触发了动作 "${action}"，请根据组件数据执行相应操作，并用 owl-ui 输出更新后的界面。 组件数据: ${JSON.stringify(payload)}`;
	}

	function reply(ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }): void {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify({ type: "response", id, ...result }));
		}
	}

	function defaultAgentDir(): string {
		return options.agentDir ?? getAgentDir();
	}

	function defaultGlobalSkillsDir(): string {
		return options.agentDir ? join(dirname(options.agentDir), "skills") : getGlobalSkillsDir();
	}

	/** cwd 的项目设置管理器（读不出就返回 null，调用方按未信任/默认处理）。 */
	async function getSettingsManagerFor(cwd: string): Promise<SettingsManager | null> {
		try {
			const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
				m.SettingsManager.create(cwd, defaultAgentDir()),
			);
			return settingsManager;
		} catch {
			return null;
		}
	}

	let globalSettingsManagerPromise: Promise<SettingsManager | null> | undefined;
	/** 项目是否已信任（技能中心项目 tab 的读写门槛；读不出设置就当未信任）。 */
	async function isProjectTrustedFor(cwd: string): Promise<boolean> {
		return (await getSettingsManagerFor(cwd))?.isProjectTrusted() ?? false;
	}

	/**
	 * 技能中心的写操作落盘后，让该 cwd 已挂载会话的资源加载器重扫，
	 * 下一条消息即用新目录（无挂载会话时静默跳过 —— 新会话自然生效）。
	 */
	async function reloadMountedSkillSessions(cwd?: string): Promise<void> {
		const resolved = cwd === undefined ? null : resolve(cwd).toLowerCase();
		await Promise.all(
			[...sessions.values()].map(async ({ runtime }) => {
				if (resolved !== null && resolve(runtime.session.sessionManager.getCwd()).toLowerCase() !== resolved)
					return;
				try {
					await runtime.session.reload();
				} catch (error) {
					onDiagnostic(error instanceof Error ? error.message : String(error));
				}
			}),
		);
	}

	/** 全局设置管理器（技能分组存全局；懒创建，进程内复用）。 */
	function getGlobalSettingsManager(): Promise<SettingsManager | null> {
		globalSettingsManagerPromise ??= getSettingsManagerFor(options.cwd ?? process.cwd());
		return globalSettingsManagerPromise;
	}

	// 定时任务启动后就可能建会话，会话工具要等插件就绪；加载失败按"无插件"继续，不能拒绝。
	const bridgePluginsLoading: Promise<LoadedBridgePlugin[]> = (async () =>
		loadBridgePlugins(
			(await getGlobalSettingsManager())?.getGlobalSettings().plugins ?? [],
			{
				agentDir: defaultAgentDir(),
				isTrustedOrigin: (origin) => isTrustedDesktopOrigin(origin, options.host),
				getGlobalSetting: async (key) =>
					((await getGlobalSettingsManager())?.getGlobalSettings() as Record<string, unknown> | undefined)?.[key],
				onDiagnostic,
				broadcast: (message) => broadcast(message as DesktopServerMessage),
				sessionDirFor: (cwd) => getDefaultSessionDirPath(cwd, defaultAgentDir()),
				collectUsageStats: async (filter, dirs) =>
					(await import("./usage-stats.ts")).collectUsageStats(filter, dirs),
				files: { atomicWriteFileSync, backupCorruptFile, withFileLockSync },
			},
			importExtensionRuntimeModule,
		))().catch((error: unknown) => {
		onDiagnostic(`bridge plugins 加载失败：${error instanceof Error ? error.message : String(error)}`);
		return [];
	});

	/** 全局默认预设 id（settings.owlDefaultPreset；缺省或无效时回退 standard）。 */
	async function getDefaultPresetId(): Promise<string> {
		const id = (await getGlobalSettingsManager())?.getGlobalSettings().owlDefaultPreset;
		return typeof id === "string" && id ? id : "standard";
	}

	async function getListingServices(): Promise<AgentSessionServices> {
		if (!listServices) {
			listServices = await createAgentSessionServices({
				cwd: options.cwd ?? process.cwd(),
				agentDir: defaultAgentDir(),
			});
		}
		return listServices;
	}
	void getListingServices;

	/** 有已存凭据（auth.json）的内置供应商 → 「凭据」分组，与 models.json 声明并列出现在模型列表里。 */
	async function credentialedProviderGroups(): Promise<ProviderModelsMessage[]> {
		const services = await getListingServices();
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
	 * 模型列表的完整视图：models.json 声明 ∪ 有凭据的内置供应商（声明优先）。
	 * 供应商增删的落盘操作也用同一视图回包，否则凭据分组会在界面凭空消失/复活。
	 */
	async function mergedProviderGroups(agentDir: string): Promise<ProviderModelsMessage[]> {
		const declared = declaredProviderModels(readModelsFile(agentDir));
		let credentialed: ProviderModelsMessage[] = [];
		try {
			credentialed = await credentialedProviderGroups();
			// 声明里没写 input 的模型沿用内置目录能力；按运行时实际值展示，避免界面与发送行为不一致。
			const runtime = (await getListingServices()).modelRuntime;
			for (const group of declared) {
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
	async function hasStoredCredential(providerId: string): Promise<boolean> {
		try {
			return (await getListingServices()).modelRuntime.getProviderAuthStatus(providerId).source === "stored";
		} catch {
			return false;
		}
	}

	/**
	 * owlSidebar.injectOpenTool 开启时返回 sidebar_open 工具（默认关）。
	 * 每次建会话现读一次设置：改设置后新会话即生效，进行中的会话不受影响。
	 */
	async function sidebarOpenToolFor(agentDir: string, cwd: string): Promise<ToolDefinition[]> {
		try {
			const manager = await import("../../core/settings-manager.ts").then((m) =>
				m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
			);
			if (manager.getGlobalSettings().owlSidebar?.injectOpenTool !== true) return [];
			return [createSidebarOpenTool(cwd, broadcast)];
		} catch (error) {
			onDiagnostic(`sidebar_open tool skipped: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	function buildFactory(
		agentDir: string,
		modelSpec: { provider?: string; model?: string; thinkingLevel?: string } | undefined,
		extensionFactories: InlineExtension[],
		appendSystemPrompt: string[],
		preset: AgentPresetDefinition,
	): CreateAgentSessionRuntimeFactory {
		return async (runtimeOptions) => {
			const sessionId = runtimeOptions.sessionManager.getSessionId();
			const researchMode = getResearchMode(runtimeOptions.sessionManager);
			const services = await createAgentSessionServices({
				cwd: runtimeOptions.cwd,
				agentDir,
				resourceLoaderOptions: {
					extensionFactories: [
						...extensionFactories,
						...(researchMode ? [createResearchExtension(runtimeOptions.sessionManager)] : []),
					],
					...(preset.runtime === "pi"
						? piResourceLoaderOptions(appendSystemPrompt)
						: desktopAgentPromptOptions(appendSystemPrompt)),
				},
			});
			let model: ReturnType<typeof services.modelRuntime.getModel>;
			if (modelSpec?.model) {
				model = modelSpec.provider
					? services.modelRuntime.getModel(modelSpec.provider, modelSpec.model)
					: services.modelRuntime.getModels().find((candidate) => candidate.id === modelSpec.model);
				if (!model) {
					throw new Error(`Model not found: ${[modelSpec.provider, modelSpec.model].filter(Boolean).join("/")}`);
				}
			}
			const session = await createAgentSessionFromServices({
				services,
				sessionManager: runtimeOptions.sessionManager,
				toolActivation: preset.runtime === "pi" ? "eager" : "on-demand",
				...(preset.runtime === "pi"
					? { tools: applyPresetToolModifiers(["read", "bash", "edit", "write"], preset.tools) }
					: {}),
				customTools:
					preset.runtime === "pi"
						? [createPiBashTool(runtimeOptions.cwd, services.settingsManager) as ToolDefinition]
						: [
								...(await getMcpTools()),
								...iab.tools(sessionId),
								...(await sidebarOpenToolFor(agentDir, runtimeOptions.cwd)),
								...createNewsTools(newsRequest, sessionId, broadcast),
								...(await bridgePluginSessionTools(
									await bridgePluginsLoading,
									{ sessionId, cwd: runtimeOptions.cwd },
									onDiagnostic,
								)),
							],
				...(model ? { model } : {}),
				...(modelSpec?.thinkingLevel ? { thinkingLevel: modelSpec.thinkingLevel as ThinkingLevel } : {}),
			});
			return { ...session, services, diagnostics: services.diagnostics };
		};
	}

	/** Mail sessions reuse model/auth settings while excluding code, browser, MCP and extension capabilities. */
	function buildMailFactory(
		agentDir: string,
		context: MailAgentContext,
		modelSpec?: { provider?: string; model?: string; thinkingLevel?: string },
	): CreateAgentSessionRuntimeFactory {
		return async (runtimeOptions) => {
			const sessionId = runtimeOptions.sessionManager.getSessionId();
			if (!getMailAgentContext(runtimeOptions.sessionManager)) {
				runtimeOptions.sessionManager.appendCustomEntry(MAIL_AGENT_CONTEXT_ENTRY, context);
			}
			const services = await createAgentSessionServices({
				cwd: runtimeOptions.cwd,
				agentDir,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					systemPrompt: mailAgentSystemPrompt(context),
					appendSystemPrompt: [],
				},
			});
			const customTools = createMailTools({
				service: getMailService(),
				context,
				onDraft: (draft) => broadcast({ type: "mail.agent.draft", sessionId, draft }),
			});
			let model: ReturnType<typeof services.modelRuntime.getModel>;
			if (modelSpec?.model) {
				model = modelSpec.provider
					? services.modelRuntime.getModel(modelSpec.provider, modelSpec.model)
					: services.modelRuntime.getModels().find((candidate) => candidate.id === modelSpec.model);
				if (!model)
					throw new Error(`Model not found: ${[modelSpec.provider, modelSpec.model].filter(Boolean).join("/")}`);
			}
			const session = await createAgentSessionFromServices({
				services,
				sessionManager: runtimeOptions.sessionManager,
				tools: customTools.map((tool) => tool.name),
				customTools,
				...(model ? { model } : {}),
				...(modelSpec?.thinkingLevel ? { thinkingLevel: modelSpec.thinkingLevel as ThinkingLevel } : {}),
			});
			if (!session.session.model) {
				session.session.dispose();
				throw new Error("请先在 Owl 设置中配置可用模型，然后使用邮箱 Agent");
			}
			return { ...session, services, diagnostics: services.diagnostics };
		};
	}

	/** 会话快照：恢复/创建/回退时回给前端回放用（消息来自事件流投影，续聊上下文同源）。
	 *  messageEntryIds 与 messages 按下标对齐，回退按钮靠它知道每条用户消息的会话条目。 */
	function sessionSnapshot(sessionId: string, sessionManager: SessionManager): SessionSnapshotPayload {
		const projection = sessionManager.buildSessionProjection();
		const mounted = sessions.get(sessionId);
		const running = mounted?.runtime.session.isStreaming ?? false;
		const mailContext = getMailAgentContext(sessionManager);
		const researchMode = getResearchMode(sessionManager);
		const messages: unknown[] = [];
		const messageEntryIds: (string | undefined)[] = [];
		let runStartMessageIndex: number | undefined;
		for (const entry of projection.entries) {
			if (
				running &&
				runStartMessageIndex === undefined &&
				mounted?.runStart.priorEntryIds &&
				!mounted.runStart.priorEntryIds.has(entry.sourceEntry.id) &&
				entry.messages.some((message) => message.role === "assistant")
			) {
				runStartMessageIndex = messages.length;
			}
			for (const message of entry.messages) {
				messages.push(message);
				messageEntryIds.push(entry.sourceEntry.id);
			}
		}
		return {
			sessionId,
			cwd: sessionManager.getCwd(),
			messages,
			running,
			...(running ? { runStartMessageIndex: runStartMessageIndex ?? messages.length } : {}),
			messageEntryIds,
			thinkingLevel: projection.thinkingLevel,
			header: sessionManager.getHeader(),
			name: sessionManager.getSessionName(),
			agentPreset: getSessionPresetId(sessionManager),
			...(mailContext ? { mailContext } : {}),
			...(researchMode ? { researchMode } : {}),
			approvalMode:
				sessions.get(sessionId)?.approvalMode.current ??
				(researchMode ? getResearchApprovalMode(sessionManager) : undefined),
		};
	}

	/** 挂载/恢复后把该会话仍挂起的审批与提问单播给当前连接（普通会话与研究会话一视同仁）。 */
	function replayPendingSessionRequests(ws: WebSocket, sessionId: string): void {
		if (ws.readyState !== ws.OPEN) return;
		for (const pending of pendingPermissions.forSession(sessionId)) ws.send(JSON.stringify(pending));
		for (const request of getPendingQuestionRequests(sessionId)) ws.send(JSON.stringify(request));
	}

	/** 新 UI 连上时重放全部挂起审批/提问，避免刷新后模态丢失、Agent 一直卡在 beforeToolCall。 */
	function replayAllPendingRequests(ws: WebSocket): void {
		if (ws.readyState !== ws.OPEN) return;
		for (const pending of pendingPermissions.pendingMessages()) ws.send(JSON.stringify(pending));
		for (const request of getAllPendingQuestionRequests()) ws.send(JSON.stringify(request));
	}

	/** 回退目标合法性：必须是当前分支上的用户消息条目。 */
	function validateRewindTarget(sessionManager: SessionManager, entryId: string) {
		const entry = sessionManager.getEntry(entryId);
		if (!entry || entry.type !== "message" || entry.message.role !== "user") return null;
		if (!sessionManager.getBranch().some((branchEntry) => branchEntry.id === entryId)) return null;
		return entry;
	}

	/** 工作区相对显示路径（回退影响清单用；解析不出时回退原路径）。 */
	function displayPathOf(absolutePath: string, cwd: string): string {
		const normalizedCwd = resolve(cwd);
		const normalizedPath = resolve(absolutePath);
		if (normalizedPath.toLowerCase().startsWith(normalizedCwd.toLowerCase() + sep)) {
			return normalizedPath
				.slice(normalizedCwd.length + 1)
				.split(sep)
				.join("/");
		}
		return absolutePath;
	}

	/** 单文件备份上限：settings.json 的 owlRewind.maxFileBytes（与扩展侧 pi.getSettings() 同源）。 */
	async function rewindMaxFileBytes(cwd: string): Promise<number | undefined> {
		try {
			const { SettingsManager }: typeof import("../../core/settings-manager.ts") = await import(
				"../../core/settings-manager.ts"
			);
			const settingsManager = await SettingsManager.create(cwd, defaultAgentDir());
			const value = settingsManager.getSettings().owlRewind?.maxFileBytes;
			return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	}

	/** 桌面端内置斜杠命令：都在 UI / 桥本地执行，session.prompt 不认识它们（不能当文本发）。 */
	const DESKTOP_BUILTIN_COMMANDS: SlashCommandEntry[] = [
		{ name: "new", description: "新建会话", kind: "builtin" },
		{ name: "compact", description: "手动压缩上下文", kind: "builtin" },
		{ name: "model", description: "切换模型", kind: "builtin", argumentHint: "<provider/model>" },
		{ name: "thinking", description: "调整思考强度", kind: "builtin", argumentHint: "<level>" },
		{ name: "settings", description: "打开设置页", kind: "builtin" },
	];

	/**
	 * 斜杠命令清单：命令面（扩展命令 / 提示词模板 / 技能）+ 内置命令垫底。
	 * 优先复用该 cwd 已挂载会话的资源加载器与扩展运行器（含插件提供的资源）；
	 * 没有挂载会话时按 cwd 轻量扫描默认位置（全局 + 项目级，缺扩展命令）。
	 * 去重顺序与 session.prompt 的展开顺序一致（扩展命令 → /skill: → 模板 →
	 * 内置），保证菜单里选中的名字与发送后的实际行为一致。
	 */
	async function listSlashCommands(cwd?: string): Promise<CommandsListResult> {
		const resolvedCwd = cwd ?? options.cwd ?? process.cwd();
		const agentDir = defaultAgentDir();
		const commands: SlashCommandEntry[] = [];
		const seen = new Set<string>();
		const add = (entry: SlashCommandEntry): void => {
			if (seen.has(entry.name)) return;
			seen.add(entry.name);
			commands.push(entry);
		};
		const sameCwd = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();
		let mounted: AgentSession | undefined;
		for (const { runtime } of sessions.values()) {
			if (sameCwd(runtime.session.sessionManager.getCwd(), resolvedCwd)) {
				mounted = runtime.session;
				break;
			}
		}
		if (mounted) {
			for (const command of mounted.extensionRunner.getRegisteredCommands()) {
				add({ name: command.invocationName, description: command.description, kind: "extension" });
			}
			for (const template of mounted.promptTemplates) {
				add({
					name: template.name,
					description: template.description,
					kind: "prompt",
					...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
				});
			}
			for (const skill of mounted.resourceLoader.getSkills().skills) {
				add({ name: `skill:${skill.name}`, description: skill.description, kind: "skill" });
			}
		} else {
			const templates = loadPromptTemplates({ cwd: resolvedCwd, agentDir, promptPaths: [], includeDefaults: true });
			for (const template of templates.templates) {
				add({
					name: template.name,
					description: template.description,
					kind: "prompt",
					...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
				});
			}
			// fork 的技能目录（package-manager 的发现规则）：用户级 ~/.owl/agent/skills
			// 与全局 ~/.owl/skills 永远加载；项目级 .owl/skills 需项目已信任。兜底扫描尽量
			// 对齐，挂载会话后以会话的资源加载器为准。
			const skillPaths: string[] = [join(agentDir, "skills"), defaultGlobalSkillsDir()];
			if (await isProjectTrustedFor(resolvedCwd)) {
				skillPaths.push(join(resolvedCwd, ".owl", "skills"));
			}
			const skills = loadSkills({ cwd: resolvedCwd, agentDir, skillPaths, includeDefaults: true });
			for (const skill of skills.skills) {
				add({ name: `skill:${skill.name}`, description: skill.description, kind: "skill" });
			}
		}
		for (const entry of DESKTOP_BUILTIN_COMMANDS) add(entry);
		return { commands };
	}

	/** 会话运行时状态（UI 输入栏的模型/思考/上下文展示与切换依据）。 */
	function sessionStateSnapshot(session: AgentSession): SessionStatsResult {
		const model = session.model;
		const stats = session.getSessionStats();
		const contextUsage = session.getContextUsage();
		return {
			...(model
				? {
						model: {
							provider: String(model.provider),
							id: model.id,
							...(model.name ? { name: model.name } : {}),
						},
					}
				: {}),
			thinkingLevel: session.thinkingLevel,
			availableThinkingLevels: session.getAvailableThinkingLevels(),
			supportsThinking: session.supportsThinking(),
			...(contextUsage ? { contextUsage } : {}),
			stats: {
				userMessages: stats.userMessages,
				assistantMessages: stats.assistantMessages,
				toolCalls: stats.toolCalls,
				tokens: stats.tokens,
				cost: stats.cost,
			},
			queue: {
				steering: [...session.getSteeringMessages()],
				followUp: [...session.getFollowUpMessages()],
			},
		};
	}

	/**
	 * 设置里维护的 Owl 附加提示词：自定义提示词 + 用户印象（含维护指引）。
	 * 挂会话时作为 addendum 注入系统提示词尾部；读取失败只降级不拦会话。
	 */
	async function loadOwlAddenda(): Promise<string[]> {
		try {
			const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
				m.SettingsManager.create(options.cwd ?? process.cwd(), defaultAgentDir()),
			);
			const settings = settingsManager.getGlobalSettings();
			const addenda: string[] = [];
			const custom = settings.owlCustomPrompt?.trim();
			if (custom) addenda.push(custom);
			const impression = settings.owlUserImpression?.trim();
			if (impression) {
				addenda.push(
					[
						"<user_impression>",
						impression,
						"</user_impression>",
						"",
						"以上是此前记录的「对用户的印象」，仅作历史参考。",
						MEMORY_WRITE_GUIDANCE,
					].join("\n"),
				);
			}
			return addenda;
		} catch (error) {
			onDiagnostic(`owl addenda load failed: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/** 挂载会话运行时（session.create 与 session.resume 共用）：权限扩展、事件订阅、登记。 */
	async function mountSession(
		ws: WebSocket,
		requestId: string,
		args: {
			sessionManager: SessionManager;
			agentDir: string;
			provider?: string;
			model?: string;
			thinkingLevel?: string;
			approvalMode?: ApprovalMode;
			/** 显式请求的 Agent 预设 id；缺省按 会话绑定 → 全局默认 → standard 解析。 */
			agentPreset?: string;
			/** 新建会话置 true：把解析后的预设 id 写进 owl-agent-preset 绑定 entry。 */
			persistPreset?: boolean;
		},
	): Promise<void> {
		const { sessionManager } = args;
		const mailContext = getMailAgentContext(sessionManager);
		const researchMode = getResearchMode(sessionManager);
		if (mailContext && researchMode) throw new Error("邮箱会话不能同时作为研究会话");
		const sessionIdHolder: { current: string } = { current: sessionManager.getSessionId() };
		// 预设解析：显式请求 → 会话绑定（恢复/分支走这里）→ 全局默认 → standard。
		// 绑定后预设随会话走：resume 重建它历史运行时的同一组合。
		const defaultPresetId = await getDefaultPresetId();
		const presetHolder: { current: AgentPresetDefinition } = {
			current: resolveAgentPreset(
				args.agentDir,
				args.agentPreset ?? getSessionPresetId(sessionManager),
				() => defaultPresetId,
			),
		};
		// Research conversations require their dedicated tools even when ordinary chats default to Pi.
		if (researchMode && presetHolder.current.runtime === "pi") {
			presetHolder.current = resolveAgentPreset(args.agentDir, "standard");
		}
		if (args.persistPreset) setSessionPresetEntry(sessionManager, presetHolder.current.id);
		// 审批模式挂 holder：session.setApprovalMode 可在会话中途改写，扩展每次 tool_call 现读现判。
		const approvalModeHolder: { current: ApprovalMode } = {
			current:
				args.approvalMode ??
				(!researchMode ? sessionApprovalMode(sessionManager) : undefined) ??
				presetHolder.current.approvalMode ??
				(researchMode ? "confirm" : "auto"),
		};
		if (!researchMode) saveSessionApprovalMode(sessionManager, approvalModeHolder.current);
		const permissionExtension: InlineExtension = {
			name: "owl-permissions",
			factory: (pi) => {
				pi.on("tool_call", async (event) => {
					const mode = approvalModeHolder.current;
					// ask_user_question 本身就是向用户提问，再套权限确认就循环了：全模式放行
					if (event.toolName === "ask_user_question") return {};
					// Publishing existing research material only changes the transcript, like an assistant reply.
					if (researchMode && event.toolName === RESEARCH_PUBLISH_TOOL) return {};
					// plan：只放行只读工具，写类调用直接拒绝（拒绝理由同时是给模型的模式提示）
					if (mode === "plan" && !isReadOnlyDesktopTool(event.toolName, event.input)) {
						return {
							block: true,
							reason:
								`Plan mode: tool "${event.toolName}" was blocked — only read-only tools ` +
								"and browser observation/target selection are allowed. 调研并产出计划，不要修改页面或清空证据。",
						};
					}
					// auto（以及 plan 下的只读工具）：不询问直接放行
					if (mode !== "confirm") return {};
					const requestId = randomUUID();
					const message: PermissionRequestMessage = {
						type: "permission_request",
						requestId,
						sessionId: sessionIdHolder.current,
						toolName: event.toolName,
						input: event.input,
					};
					const approved = await pendingPermissions.request(message);
					return approved ? {} : { block: true, reason: "Denied by user" };
				});
			},
		};
		// Owl 记忆扩展：「用户印象」工具 —— 模型把对用户的长期印象写回全局设置，
		// 设置页同源可改；下次会话挂载时通过 addendum 注入生效。
		const owlMemoryExtension: InlineExtension = {
			name: "owl-memory",
			factory: (pi) => {
				pi.registerTool({
					name: "update_user_impression",
					label: "更新用户印象",
					description:
						"更新长期用户印象：用户本轮明确要求，或你此前在对话里承诺过要更新印象（说过就必须当轮调用本工具兑现）时使用，把偏好、习惯、背景或沟通风格合并写入 Owl 的「用户印象」档案。" +
						"参数传更新后的完整印象文本（保留仍有效的旧内容，不要清空）。不要把待办、功能需求或目标效果写成已完成的事实。",
					promptSnippet: "update_user_impression: 更新长期用户印象（用户明确要求或你已承诺兑现时）",
					promptGuidelines: [MEMORY_WRITE_GUIDANCE],
					parameters: Type.Object({
						impression: Type.String({ description: "更新后的完整用户印象（Markdown 文本）" }),
					}),
					execute: async (_toolCallId, params) => {
						const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
							m.SettingsManager.create(args.sessionManager.getCwd(), args.agentDir),
						);
						settingsManager.applyGlobalOverridesAndSave({ owlUserImpression: params.impression } as never);
						return {
							content: [{ type: "text", text: "已更新「用户印象」，下次会话开始生效。" }],
							details: undefined,
						};
					},
				});
			},
		};
		// 「向用户提问」由插件 owl-ask-user（settings plugins）经 question-channel 通道提供，
		// 不再是内联扩展；插件的启停走设置页插件列表。
		const owlAddenda = mailContext || presetHolder.current.runtime === "pi" ? [] : await loadOwlAddenda();
		if (approvalModeHolder.current === "plan") owlAddenda.push(PLAN_MODE_ADDENDUM);
		const presetAppendPrompt = mailContext
			? undefined
			: resolvePresetAppendPrompt(presetHolder.current, { agentDir: args.agentDir });
		if (presetAppendPrompt) owlAddenda.push(presetAppendPrompt);
		const runtime = await createAgentSessionRuntime(
			mailContext
				? buildMailFactory(args.agentDir, mailContext, {
						provider: args.provider,
						model: args.model,
						thinkingLevel: args.thinkingLevel,
					})
				: buildFactory(
						args.agentDir,
						{ provider: args.provider, model: args.model, thinkingLevel: args.thinkingLevel },
						presetHolder.current.runtime === "pi"
							? [permissionExtension]
							: [...builtInExtensions, permissionExtension, owlMemoryExtension],
						owlAddenda,
						presetHolder.current,
					),
			{ cwd: sessionManager.getCwd(), agentDir: args.agentDir, sessionManager },
		);
		const sessionId = runtime.session.sessionManager.getSessionId();
		sessionIdHolder.current = sessionId;
		// 应用预设工具集（裸名替换/＋-增删；未注册的名字由会话注册表过滤）。
		// 邮箱会话有专属组合，不套预设。
		if (!mailContext && presetHolder.current.tools?.length) {
			runtime.session.setActiveToolsByName(
				applyPresetToolModifiers(runtime.session.getActiveToolNames(), presetHolder.current.tools),
			);
		}
		const runStart: { priorEntryIds?: Set<string> } = {};
		const unsubscribe = runtime.session.subscribe((event) => {
			if (event.type === "agent_start") {
				// Include all raw IDs: compaction may retain old entries absent from today's projection.
				runStart.priorEntryIds = new Set(runtime.session.sessionManager.getEntries().map((entry) => entry.id));
			}
			if (event.type === "agent_settled") runStart.priorEntryIds = undefined;
			broadcast({ type: "event", sessionId, event: toJsonEvent(event) });
		});
		sessions.set(sessionId, {
			runtime,
			unsubscribe,
			approvalMode: approvalModeHolder,
			preset: presetHolder,
			runStart,
		});
		void schedule.onSessionMounted(sessionId);
		reply(ws, requestId, {
			ok: true,
			result: { ...sessionSnapshot(sessionId, sessionManager), ...(mailContext ? { context: mailContext } : {}) },
		});
		replayPendingSessionRequests(ws, sessionId);
	}

	async function createSession(ws: WebSocket, request: SessionCreateRequest): Promise<void> {
		const researchMode = request.researchMode === undefined ? undefined : normalizeResearchMode(request.researchMode);
		const sessionManager = SessionManager.create(request.cwd ?? options.cwd ?? process.cwd());
		if (researchMode) {
			sessionManager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: researchMode });
			const mode = request.approvalMode ?? "confirm";
			if (mode !== "confirm" && mode !== "plan" && mode !== "auto") throw new Error("无效的审批模式");
			sessionManager.appendCustomEntry(RESEARCH_APPROVAL_ENTRY, { mode });
		}
		await mountSession(ws, request.id, {
			sessionManager,
			agentDir: request.agentDir ?? defaultAgentDir(),
			provider: request.provider,
			model: request.model,
			thinkingLevel: request.thinkingLevel,
			approvalMode: request.approvalMode ?? (researchMode ? "confirm" : undefined),
			agentPreset: request.agentPreset,
			persistPreset: true,
		});
	}

	async function resumeSession(ws: WebSocket, request: SessionResumeRequest): Promise<void> {
		// 幂等：已挂载的会话直接回快照（重复点击安全）；顺带同步请求里带的审批模式
		const existing = sessions.get(request.sessionId);
		if (existing) {
			const sessionManager = existing.runtime.session.sessionManager;
			// Selecting research history must not apply the ordinary chat's preferences.
			if (request.approvalMode && !getResearchMode(sessionManager)) {
				existing.approvalMode.current = request.approvalMode;
				saveSessionApprovalMode(sessionManager, request.approvalMode);
				pendingPermissions.changeMode(request.sessionId, request.approvalMode);
			}
			reply(ws, request.id, {
				ok: true,
				result: sessionSnapshot(request.sessionId, sessionManager),
			});
			replayPendingSessionRequests(ws, request.sessionId);
			return;
		}
		// 定位历史文件：header/文件名定位，不扫全文
		const sessionPath = await findSessionFile(request.sessionId);
		if (!sessionPath || !existsSync(sessionPath)) {
			reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
			return;
		}
		try {
			// open() 自行读会话头恢复 cwd（找不到头时回落 process.cwd，与 TUI 行为一致）
			const sessionManager = SessionManager.open(sessionPath);
			const researchMode = getResearchMode(sessionManager);
			await mountSession(ws, request.id, {
				sessionManager,
				agentDir: defaultAgentDir(),
				provider: researchMode ? undefined : request.provider,
				model: researchMode ? undefined : request.model,
				thinkingLevel: researchMode ? undefined : request.thinkingLevel,
				approvalMode: researchMode
					? getResearchApprovalMode(sessionManager)
					: (request.approvalMode ??
						sessionApprovalMode(sessionManager) ??
						request.approvalModeFallback ??
						"auto"),
			});
		} catch (error) {
			reply(ws, request.id, {
				ok: false,
				error: `无法恢复会话：${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	/** Session 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type SessionRequest = Extract<
		DesktopClientRequest,
		{
			type:
				| "session.create"
				| "session.prompt"
				| "session.queue.remove"
				| "session.queue.promote"
				| "owl-ui.action"
				| "session.continue"
				| "session.abort"
				| "session.delete"
				| "session.archive"
				| "session.rename"
				| "session.unarchive"
				| "session.archiveConfig"
				| "session.setModel"
				| "session.setThinkingLevel"
				| "session.setApprovalMode"
				| "session.setPreset";
		}
	>;

	async function handleSessionRequest(ws: WebSocket, request: SessionRequest): Promise<void> {
		switch (request.type) {
			case "session.create": {
				await createSession(ws, request);
				return;
			}
			case "session.prompt": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				if (request.researchMode !== undefined) {
					if (session.runtime.session.isStreaming || session.runtime.session.isCompacting) {
						throw new Error("请先停止当前处理，再调整研究方向");
					}
					updateResearchMode(session.runtime.session.sessionManager, request.researchMode);
				}
				const streamingBehavior = streamingBehaviorForPrompt(
					session.runtime.session.isStreaming,
					request.streamingBehavior,
				);
				reply(ws, request.id, { ok: true });
				try {
					await session.runtime.session.prompt(request.message, {
						...(request.images ? { images: request.images as ImageContent[] } : {}),
						...(request.attachedPaths?.length ? { attachedPaths: request.attachedPaths } : {}),
						...(streamingBehavior ? { streamingBehavior } : {}),
					});
				} catch (error) {
					onDiagnostic(error instanceof Error ? error.message : String(error));
				}
				return;
			}
			case "session.queue.remove": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				const removed = session.runtime.session.removeQueuedMessage(request.lane, request.index);
				reply(ws, request.id, removed ? { ok: true } : { ok: false, error: "这条排队消息已经不在了" });
				return;
			}
			case "session.queue.promote": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				const promoted = session.runtime.session.promoteQueuedFollowUp(request.index);
				reply(ws, request.id, promoted ? { ok: true } : { ok: false, error: "这条排队消息已经不在了" });
				return;
			}
			case "owl-ui.action": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				reply(ws, request.id, { ok: true });
				try {
					await session.runtime.session.prompt(formatOwlUiActionMessage(request.action, request.payload));
				} catch (error) {
					onDiagnostic(error instanceof Error ? error.message : String(error));
				}
				return;
			}
			case "session.continue": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				// 仍在运行/压缩中的会话没有可恢复的暂停态：幂等回 ok，由前端运行态自行收敛。
				if (session.runtime.session.isStreaming || session.runtime.session.isCompacting) {
					reply(ws, request.id, { ok: true });
					return;
				}
				reply(ws, request.id, { ok: true });
				try {
					await session.runtime.session.resumeAfterPause(request.message);
				} catch (error) {
					onDiagnostic(error instanceof Error ? error.message : String(error));
				}
				return;
			}
			case "session.abort": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				pendingPermissions.cancelSession(request.sessionId);
				// 已经空闲的会话不会再有 agent_settled（上一次的可能在断线窗口丢了）：
				// 补发一条合成事件，前端运行态才能解开，否则停止按钮永远"点了没反应"。
				// 非空闲时触发中止后立即回包，不等全量 settle——流式请求挂死时 settle
				// 可能迟迟不来；真正停下由订阅里的 agent_settled 事件收尾。
				if (session.runtime.session.isIdle) {
					reply(ws, request.id, { ok: true });
					broadcast({
						type: "event",
						sessionId: request.sessionId,
						event: { type: "agent_settled", aborted: true },
					});
					return;
				}
				void session.runtime.session.abort().catch((error: unknown) => {
					onDiagnostic(`session.abort: ${error instanceof Error ? error.message : String(error)}`);
				});
				reply(ws, request.id, { ok: true });
				return;
			}
			case "session.delete": {
				// 已挂载的会话先卸载：否则运行时继续 append 会把删掉的 JSONL 重新写出来。
				await unmountSessionRuntime(request.sessionId);
				getSessionRewindTracker(defaultAgentDir(), request.sessionId).destroyAll();
				disposeSessionRewindTracker(request.sessionId);
				const found = await findSessionFile(request.sessionId);
				if (!found) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				try {
					unlinkSync(found);
					// 归档记录里可能有它：一并清掉，避免设置页出现幽灵条目
					const agentDir = defaultAgentDir();
					const meta = readArchiveMeta(agentDir);
					if (meta.sessions && request.sessionId in meta.sessions) {
						delete meta.sessions[request.sessionId];
						writeArchiveMeta(agentDir, meta);
					}
					reply(ws, request.id, { ok: true });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: `无法删除会话文件：${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return;
			}
			case "session.archive": {
				const agentDir = defaultAgentDir();
				const meta = readArchiveMeta(agentDir);
				meta.sessions = meta.sessions ?? {};
				const sessionPath = await findSessionFile(request.sessionId);
				meta.sessions[request.sessionId] = {
					archivedAt: new Date().toISOString(),
					...(sessionPath ? { path: sessionPath } : {}),
				};
				writeArchiveMeta(agentDir, meta);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "session.rename": {
				const name = request.name
					.replace(/[\r\n]+/g, " ")
					.trim()
					.slice(0, 80);
				if (!name) {
					reply(ws, request.id, { ok: false, error: "会话名不能为空" });
					return;
				}
				try {
					const mounted = sessions.get(request.sessionId)?.runtime.session.sessionManager;
					if (mounted) {
						mounted.appendSessionInfo(name);
					} else {
						const found = await findSessionFile(request.sessionId);
						if (!found) {
							reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
							return;
						}
						SessionManager.open(found).appendSessionInfo(name);
					}
					reply(ws, request.id, { ok: true, result: { name } });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: `无法更改会话名：${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return;
			}
			case "session.unarchive": {
				const agentDir = defaultAgentDir();
				const meta = readArchiveMeta(agentDir);
				if (meta.sessions && request.sessionId in meta.sessions) {
					delete meta.sessions[request.sessionId];
					writeArchiveMeta(agentDir, meta);
				}
				reply(ws, request.id, { ok: true });
				return;
			}
			case "session.archiveConfig": {
				const agentDir = defaultAgentDir();
				const meta = readArchiveMeta(agentDir);
				if (request.retentionDays !== undefined) {
					const days = request.retentionDays;
					if (!Number.isInteger(days) || days < 1 || days > 3650) {
						reply(ws, request.id, { ok: false, error: "保留天数必须是 1-3650 的整数" });
						return;
					}
					meta.retentionDays = days;
					writeArchiveMeta(agentDir, meta);
					// 改完立刻巡检一次：新保留期可能立即过期若干会话
					void purgeExpiredArchivedSessions().catch((error) => onDiagnostic(`归档巡检失败：${String(error)}`));
				}
				const sessions = Object.entries(meta.sessions ?? {}).map(([sessionId, entry]) => ({
					sessionId,
					archivedAt: entry.archivedAt,
				}));
				reply(ws, request.id, {
					ok: true,
					result: { retentionDays: archiveRetentionDays(meta), sessions },
				});
				return;
			}
			case "session.setModel": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				try {
					const model = session.runtime.services.modelRuntime.getModel(request.provider, request.model);
					if (!model) {
						reply(ws, request.id, {
							ok: false,
							error: `Model not found: ${request.provider}/${request.model}`,
						});
						return;
					}
					await session.runtime.session.setModel(model);
					reply(ws, request.id, { ok: true, result: sessionStateSnapshot(session.runtime.session) });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			case "session.setThinkingLevel": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				const level = request.level as ThinkingLevel;
				if (!THINKING_LEVEL_VALUES.has(level)) {
					reply(ws, request.id, { ok: false, error: `未知思考强度: ${request.level}` });
					return;
				}
				try {
					session.runtime.session.setThinkingLevel(level);
					reply(ws, request.id, { ok: true, result: sessionStateSnapshot(session.runtime.session) });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			case "session.setApprovalMode": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				if (
					request.approvalMode !== "auto" &&
					request.approvalMode !== "confirm" &&
					request.approvalMode !== "plan"
				) {
					reply(ws, request.id, { ok: false, error: `未知审批模式: ${String(request.approvalMode)}` });
					return;
				}
				session.approvalMode.current = request.approvalMode;
				pendingPermissions.changeMode(request.sessionId, request.approvalMode);
				if (!getResearchMode(session.runtime.session.sessionManager))
					saveSessionApprovalMode(session.runtime.session.sessionManager, request.approvalMode);
				if (getResearchMode(session.runtime.session.sessionManager)) {
					session.runtime.session.sessionManager.appendCustomEntry(RESEARCH_APPROVAL_ENTRY, {
						mode: request.approvalMode,
					});
				}
				reply(ws, request.id, { ok: true, result: { approvalMode: request.approvalMode } });
				return;
			}
			case "session.setPreset": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				const preset = getAgentPreset(defaultAgentDir(), request.agentPreset);
				if (!preset) {
					reply(ws, request.id, { ok: false, error: `预设不存在: ${request.agentPreset}` });
					return;
				}
				const sessionManager = session.runtime.session.sessionManager;
				if (getResearchMode(sessionManager) && preset.runtime === "pi") {
					reply(ws, request.id, { ok: false, error: "研究会话需要专属工具，不能切换到 Pi 模式" });
					return;
				}
				// 空白判定与快照同一投影：跑过第一轮的会话锁定预设（历史是原组合产生的）。
				const projection = sessionManager.buildSessionProjection();
				const messageCount = projection.entries.reduce((count, entry) => count + entry.messages.length, 0);
				if (messageCount > 0 || !session.runtime.session.isIdle) {
					reply(ws, request.id, { ok: false, error: "preset-locked" });
					return;
				}
				setSessionPresetEntry(sessionManager, preset.id);
				// Entering/leaving Pi must replace resources, extensions, tool allowlists and prompt together.
				if (
					!getMailAgentContext(sessionManager) &&
					(preset.runtime === "pi" || session.preset.current.runtime === "pi")
				) {
					const model = session.runtime.session.model;
					const thinkingLevel = session.runtime.session.thinkingLevel;
					const approvalMode = session.approvalMode.current;
					const agentDir = session.runtime.services.agentDir;
					const transition = (async () => {
						await unmountSessionRuntime(request.sessionId);
						await mountSession(HEADLESS_WS, request.id, {
							sessionManager,
							agentDir,
							provider: model?.provider,
							model: model?.id,
							thinkingLevel,
							approvalMode,
							agentPreset: preset.id,
						});
					})();
					presetTransitions.set(request.sessionId, transition);
					try {
						await transition;
					} finally {
						presetTransitions.delete(request.sessionId);
					}
					reply(ws, request.id, { ok: true, result: { agentPreset: preset.id, preset } });
					return;
				}
				session.preset.current = preset;
				if (!getMailAgentContext(sessionManager) && preset.tools?.length) {
					session.runtime.session.setActiveToolsByName(
						applyPresetToolModifiers(session.runtime.session.getActiveToolNames(), preset.tools),
					);
				}
				reply(ws, request.id, { ok: true, result: { agentPreset: preset.id, preset } });
				return;
			}
		}
	}

	/** Preset 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type PresetRequest = Extract<
		DesktopClientRequest,
		{ type: "preset.list" | "preset.setDefault" | "preset.save" | "preset.delete" }
	>;

	async function handlePresetRequest(ws: WebSocket, request: PresetRequest): Promise<void> {
		switch (request.type) {
			case "preset.list": {
				const agentDir = defaultAgentDir();
				reply(ws, request.id, {
					ok: true,
					result: { presets: await listAgentPresets(agentDir), defaultPreset: await getDefaultPresetId() },
				});
				return;
			}
			case "preset.setDefault": {
				const preset = getAgentPreset(defaultAgentDir(), request.agentPreset);
				if (!preset) {
					reply(ws, request.id, { ok: false, error: `预设不存在: ${request.agentPreset}` });
					return;
				}
				(await getGlobalSettingsManager())?.applyGlobalOverridesAndSave({ owlDefaultPreset: preset.id });
				reply(ws, request.id, { ok: true, result: { defaultPreset: preset.id } });
				return;
			}
			case "preset.save": {
				try {
					const preset = saveCustomAgentPreset(defaultAgentDir(), request.preset);
					reply(ws, request.id, {
						ok: true,
						result: { preset, presets: await listAgentPresets(defaultAgentDir()) },
					});
				} catch (error) {
					reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case "preset.delete": {
				try {
					deleteCustomAgentPreset(defaultAgentDir(), request.agentPreset);
					reply(ws, request.id, {
						ok: true,
						result: { presets: await listAgentPresets(defaultAgentDir()) },
					});
				} catch (error) {
					reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
		}
	}

	/** SessionLog 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type SessionLogRequest = Extract<
		DesktopClientRequest,
		{ type: "session.stats" | "session.exportLog" | "session.turns" }
	>;

	async function handleSessionLogRequest(ws: WebSocket, request: SessionLogRequest): Promise<void> {
		switch (request.type) {
			case "session.stats": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				reply(ws, request.id, { ok: true, result: sessionStateSnapshot(session.runtime.session) });
				return;
			}
			// 导出会话日志：jsonl 原样回源文件全文（含全部分支）；markdown 只取当前分支排版成可读转录。
			case "session.exportLog": {
				const mounted = sessions.get(request.sessionId);
				const mountedManager = mounted?.runtime.session.sessionManager;
				try {
					const sourcePath = mountedManager?.getSessionFile() ?? (await findSessionFile(request.sessionId));
					if (!sourcePath || !existsSync(sourcePath)) {
						reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
						return;
					}
					// 未挂载的会话只读不写：SessionManager.open 只解析文件，不产生追加
					const sessionManager = mountedManager ?? SessionManager.open(sourcePath);
					const branch = sessionManager.getBranch();
					const header = sessionManager.getHeader();
					const filename = buildSessionExportFilename({
						sessionId: request.sessionId,
						displayName: sessionDisplayName(branch),
						startedAt: header?.timestamp,
						ext: request.format === "jsonl" ? "jsonl" : "markdown",
					});
					// 勾选历史分享：按所选轮次（用户消息条目 id）过滤分支；只对 markdown 有意义
					const turnEntryIds = request.format === "markdown" ? request.turnEntryIds : undefined;
					if (turnEntryIds && turnEntryIds.length === 0) {
						reply(ws, request.id, { ok: false, error: "未选择要分享的会话历史" });
						return;
					}
					const exportEntries = turnEntryIds ? filterEntriesToTurns(branch, turnEntryIds) : branch;
					if (turnEntryIds && exportEntries.length === 0) {
						reply(ws, request.id, { ok: false, error: "所选会话历史不在当前分支上，请刷新后重试" });
						return;
					}
					const content =
						request.format === "jsonl"
							? await readFile(sourcePath, "utf8")
							: formatSessionMarkdown(
									header ?? { type: "session", id: request.sessionId, timestamp: "", cwd: "" },
									exportEntries,
									{ displayName: sessionDisplayName(branch) },
								);
					// 直接落盘到下载目录（桌面端随后唤起资源管理器定位），不走 webview 的
					// blob 下载——WebView2 会静默丢掉 <a download>，表现为点了没反应。
					// OWL_EXPORT_DIR 仅供测试覆盖目标目录。
					const exportDir = process.env.OWL_EXPORT_DIR ?? join(homedir(), "Downloads");
					mkdirSync(exportDir, { recursive: true });
					const savedPath = uniqueExportPath(exportDir, filename);
					writeFileSync(savedPath, content, "utf8");
					onDiagnostic(
						`session export: ${request.sessionId} ${request.format} -> ${savedPath} (${content.length} bytes)`,
					);
					reply(ws, request.id, { ok: true, result: { filename, content, path: sourcePath, savedPath } });
				} catch (error) {
					onDiagnostic(
						`session export failed (${request.sessionId}): ${error instanceof Error ? error.message : String(error)}`,
					);
					reply(ws, request.id, {
						ok: false,
						error: `导出会话日志失败: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return;
			}
			// 勾选历史分享的第一步：列出当前分支的轮次（用户消息 + 其后条目），供弹窗勾选。
			case "session.turns": {
				const mounted = sessions.get(request.sessionId);
				const mountedManager = mounted?.runtime.session.sessionManager;
				try {
					const sourcePath = mountedManager?.getSessionFile() ?? (await findSessionFile(request.sessionId));
					if (!sourcePath || !existsSync(sourcePath)) {
						reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
						return;
					}
					// 与 session.exportLog 同口径：未挂载会话只读打开，不产生追加
					const sessionManager = mountedManager ?? SessionManager.open(sourcePath);
					reply(ws, request.id, { ok: true, result: { turns: listSessionTurns(sessionManager.getBranch()) } });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: `读取会话历史失败: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return;
			}
		}
	}

	/** Rewind 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type RewindRequest = Extract<DesktopClientRequest, { type: "rewind.targets" | "rewind.impact" | "rewind.execute" }>;

	async function handleRewindRequest(ws: WebSocket, request: RewindRequest): Promise<void> {
		switch (request.type) {
			case "rewind.targets": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				const sessionManager = session.runtime.session.sessionManager;
				const targets = listRewindTargets(
					sessionManager.buildSessionProjection().entries.map((entry) => entry.sourceEntry),
				);
				reply(ws, request.id, { ok: true, result: { targets } satisfies RewindTargetsResult });
				return;
			}
			case "rewind.impact": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				const sessionManager = session.runtime.session.sessionManager;
				const targetEntry = validateRewindTarget(sessionManager, request.entryId);
				if (!targetEntry) {
					reply(ws, request.id, { ok: false, error: "回退目标必须是当前会话分支上的用户消息" });
					return;
				}
				try {
					const tracker = getSessionRewindTracker(defaultAgentDir(), request.sessionId, {
						maxFileBytes: await rewindMaxFileBytes(sessionManager.getCwd()),
					});
					const plan = tracker.planRestore(
						{ entryId: request.entryId, time: targetEntry.timestamp },
						sessionManager,
					);
					const cwd = sessionManager.getCwd();
					const files: RewindImpactFile[] = plan.actions.map((item) => ({
						path: item.path,
						displayPath: displayPathOf(item.path, cwd),
						action: item.action,
						size: item.size,
					}));
					reply(ws, request.id, {
						ok: true,
						result: { files, unchanged: plan.unchanged } satisfies RewindImpactResult,
					});
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			case "rewind.execute": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				const agentSession = session.runtime.session;
				const sessionManager = agentSession.sessionManager;
				const targetEntry = validateRewindTarget(sessionManager, request.entryId);
				if (!targetEntry) {
					reply(ws, request.id, { ok: false, error: "回退目标必须是当前会话分支上的用户消息" });
					return;
				}
				try {
					// 进行中的回合必须先停（abort 内部等 idle），否则 leaf 移动会被在途 append 打架
					if (agentSession.isStreaming || agentSession.isCompacting) {
						await agentSession.abort();
					}
					const tracker = getSessionRewindTracker(defaultAgentDir(), request.sessionId, {
						maxFileBytes: await rewindMaxFileBytes(sessionManager.getCwd()),
					});
					let restored = 0;
					let deleted = 0;
					let skipped: Array<{ path: string; reason: string }> = [];
					if (request.mode === "both") {
						// 先还原文件再移动 leaf：还原失败时原地报错，会话保持原状
						const plan = tracker.planRestore(
							{ entryId: request.entryId, time: targetEntry.timestamp },
							sessionManager,
						);
						const result = tracker.applyRestore(plan);
						restored = result.restored;
						deleted = result.deleted;
						skipped = result.skipped;
					}
					const navigation = await agentSession.navigateTree(request.entryId);
					if (navigation.cancelled) {
						reply(ws, request.id, { ok: false, error: "回退已被取消" });
						return;
					}
					// navigateTree 只改内存 leaf（重启会回落到文件末尾）；追加一条 custom
					// 标记把新分支钉住，顺带留审计记录。custom 条目不进模型上下文、转录不渲染。
					sessionManager.appendCustomEntry("owl-rewind", {
						target: request.entryId,
						mode: request.mode,
						via: "desktop",
						time: new Date().toISOString(),
					});
					tracker.prune();
					const result: RewindExecuteResult = {
						editorText: navigation.editorText,
						snapshot: sessionSnapshot(request.sessionId, sessionManager),
						restored,
						deleted,
						skipped,
					};
					reply(ws, request.id, { ok: true, result });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
		}
	}

	/** Skills 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type SkillsRequest = Extract<DesktopClientRequest, { type: `skills.${string}` }>;

	async function handleSkillsRequest(ws: WebSocket, request: SkillsRequest): Promise<void> {
		switch (request.type) {
			case "skills.list": {
				const cwd = request.cwd ?? options.cwd ?? process.cwd();
				const projectSettings = await getSettingsManagerFor(cwd);
				const globalSettings = await getGlobalSettingsManager();
				reply(ws, request.id, {
					ok: true,
					result: listSkills(cwd, projectSettings?.isProjectTrusted() ?? false, options.agentDir, {
						skillOverrides: projectSettings?.getProjectSettings().skills ?? [],
						groups: globalSettings?.getOwlSkillGroups() ?? [],
						extras: projectSettings?.getProjectSettings().owlSkillExtras ?? [],
					}),
				});
				return;
			}
			case "skills.groups.save": {
				// 全量替换 owlSkillGroups（分组 tab 的编辑弹窗整体保存）
				try {
					const settingsManager = await getGlobalSettingsManager();
					if (!settingsManager) throw new Error("设置管理器不可用");
					settingsManager.setOwlSkillGroups(request.groups);
					await reloadMountedSkillSessions();
					reply(ws, request.id, { ok: true });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: `保存技能分组失败：${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return;
			}
			case "skills.project.addExtras":
			case "skills.project.removeExtras": {
				// 项目内单独添加 / 移除技能（owlSkillExtras，与关联组取并集）
				const settingsManager = await getSettingsManagerFor(request.cwd);
				if (!settingsManager?.isProjectTrusted()) {
					reply(ws, request.id, { ok: false, error: "项目尚未信任，无法修改项目技能" });
					return;
				}
				try {
					const current = new Set(settingsManager.getProjectSettings().owlSkillExtras ?? []);
					for (const name of request.names) {
						if (request.type === "skills.project.addExtras") current.add(name);
						else current.delete(name);
					}
					settingsManager.setProjectOwlSkillExtras([...current]);
					await reloadMountedSkillSessions(request.cwd);
					reply(ws, request.id, { ok: true });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: `保存项目技能失败：${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return;
			}
			case "skills.setProjectSelection": {
				// 生效清单里的行级勾选（opt-out）→ 项目 settings.json 的 skills 覆盖模式
				const settingsManager = await getSettingsManagerFor(request.cwd);
				if (!settingsManager?.isProjectTrusted()) {
					reply(ws, request.id, { ok: false, error: "项目尚未信任，无法修改项目技能选择" });
					return;
				}
				try {
					settingsManager.setProjectSkillPaths(
						request.mode === "clear" ? [] : disabledNamesToPatterns(request.names),
					);
					await reloadMountedSkillSessions(request.cwd);
					reply(ws, request.id, { ok: true });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: `保存项目技能选择失败：${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return;
			}
			case "skills.read":
			case "skills.setEnabled":
			case "skills.create":
			case "skills.update":
			case "skills.delete": {
				const cwd = request.cwd ?? options.cwd ?? process.cwd();
				try {
					let result: unknown;
					switch (request.type) {
						case "skills.read":
							result = readSkill(cwd, request, options.agentDir);
							break;
						case "skills.setEnabled":
							setSkillEnabled(cwd, request, options.agentDir);
							await reloadMountedSkillSessions(cwd);
							break;
						case "skills.create": {
							result = createSkill(cwd, request, await isProjectTrustedFor(cwd), options.agentDir);
							await reloadMountedSkillSessions(cwd);
							break;
						}
						case "skills.update":
							updateSkill(cwd, request, options.agentDir);
							await reloadMountedSkillSessions(cwd);
							break;
						case "skills.delete":
							deleteSkill(cwd, request, options.agentDir);
							await reloadMountedSkillSessions(cwd);
							break;
					}
					reply(ws, request.id, { ok: true, result });
				} catch (error) {
					const message =
						error instanceof SkillCenterError
							? error.message
							: `技能操作失败：${error instanceof Error ? error.message : String(error)}`;
					reply(ws, request.id, { ok: false, error: message });
				}
				return;
			}
		}
	}

	/** Models 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type ModelsRequest = Extract<DesktopClientRequest, { type: `models.${string}` }>;

	async function handleModelsRequest(ws: WebSocket, request: ModelsRequest): Promise<void> {
		switch (request.type) {
			case "models.list": {
				// owl 模型来源 = models.json 声明（自定义接入） ∪ 有凭据的内置供应商（登录/API Key 激活）。
				// 内置目录本身不再直接暴露：只有用户主动配置过凭据的供应商才会带出目录模型。
				const agentDir = defaultAgentDir();
				// owl:动态目录厂商（loean 等，凭据已存但基线目录为空）读表前补一次联网刷新——
				// 启动刷新是 offline，若登录时网关不可达或目录是旧版本登录的，重启后这里自愈，
				// 不用重新登录。PI_OFFLINE 时与全局一致不联网。
				if (!process.env.PI_OFFLINE) {
					try {
						const runtime = (await getListingServices()).modelRuntime;
						const staleDynamic = runtime
							.getProviders()
							.filter(
								(provider) =>
									provider.refreshModels &&
									provider.getModels().length === 0 &&
									runtime.getProviderAuthStatus(provider.id).source === "stored",
							)
							.map((provider) => provider.id);
						for (const providerId of staleDynamic) {
							try {
								await runtime.refresh({ providers: [providerId], allowNetwork: true });
							} catch {
								// 单个厂商拉取失败不挡列表（内部已捕获到 errors）
							}
						}
					} catch {
						// services 不可用时跳过自愈刷新
					}
				}
				reply(ws, request.id, { ok: true, result: await mergedProviderGroups(agentDir) });
				return;
			}
			case "models.putProvider": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				const { key, baseUrl, api } = request.provider;
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
					reply(ws, request.id, { ok: false, error: "供应商 ID 只能包含字母、数字、点、下划线、连字符" });
					return;
				}
				if (!/^https?:\/\//.test(baseUrl)) {
					reply(ws, request.id, { ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" });
					return;
				}
				if (!SUPPORTED_MODEL_APIS.has(api)) {
					reply(ws, request.id, {
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
				reply(ws, request.id, { ok: true, result: await mergedProviderGroups(agentDir) });
				return;
			}
			case "models.putModel": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				let provider = models.providers?.[request.providerKey];
				if (!provider) {
					// 凭据分组（登录过/贴过 Key 的内置供应商）不在 models.json：首次添加模型时落成声明。
					const group = (await credentialedProviderGroups()).find((entry) => entry.id === request.providerKey);
					if (!group) {
						reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
						return;
					}
					provider = {
						...(group.name ? { name: group.name } : {}),
						models: group.models.map(modelFileEntryFrom),
					};
					models.providers = { ...(models.providers ?? {}), [request.providerKey]: provider };
				}
				if (!request.model.id.trim()) {
					reply(ws, request.id, { ok: false, error: "模型 ID 不能为空" });
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
				reply(ws, request.id, { ok: true, result: await mergedProviderGroups(agentDir) });
				return;
			}
			case "models.discover": {
				const agentDir = defaultAgentDir();
				const providerKey = request.providerKey.trim();
				if (!providerKey) {
					reply(ws, request.id, { ok: false, error: "供应商不能为空" });
					return;
				}
				const declared = readModelsFile(agentDir).providers?.[providerKey];
				let runtime: Awaited<ReturnType<typeof getListingServices>>["modelRuntime"] | undefined;
				try {
					runtime = (await getListingServices()).modelRuntime;
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
							reply(ws, request.id, {
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
							reply(ws, request.id, {
								ok: false,
								error: refreshError instanceof Error ? refreshError.message : String(refreshError),
							});
							return;
						}
					} catch (error) {
						const catalog = known();
						if (catalog.length > 0) {
							reply(ws, request.id, {
								ok: true,
								result: {
									models: catalog,
									error: `联网拉取失败，已用本地目录（${error instanceof Error ? error.message : String(error)}）`,
								},
							});
							return;
						}
						reply(ws, request.id, {
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
							const { resolveConfigValue } = await import("../../core/resolve-config-value.ts");
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
							reply(ws, request.id, { ok: true, result: { models } });
							return;
						}
					} catch (error) {
						const catalog = known();
						if (catalog.length > 0) {
							reply(ws, request.id, {
								ok: true,
								result: {
									models: catalog,
									error: `上游 /models 失败，已用本地目录（${error instanceof Error ? error.message : String(error)}）`,
								},
							});
							return;
						}
						reply(ws, request.id, {
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						});
						return;
					}
				}

				// 3) 兜底：本地内置/已声明目录（不能联网或协议不支持时仍给出可选列表）。
				const catalog = known();
				if (catalog.length > 0) {
					reply(ws, request.id, {
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
				reply(ws, request.id, {
					ok: false,
					error: "无法拉取上游模型：请确认已配置 API Key / 登录，且供应商支持模型目录接口",
				});
				return;
			}
			case "models.removeModel": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				const provider = models.providers?.[request.providerKey];
				if (!provider) {
					// 凭据分组（登录过/贴过 Key 的内置供应商）不在 models.json 里。
					// 删单个模型时，把「剩余模型」落成声明：声明优先后凭据分组不再覆盖该供应商，
					// 否则界面会报「未知供应商」且列表不变，表现为删除按钮无响应。
					const group = (await credentialedProviderGroups()).find((entry) => entry.id === request.providerKey);
					if (!group) {
						reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
						return;
					}
					if (!group.models.some((entry) => entry.id === request.modelId)) {
						reply(ws, request.id, { ok: false, error: `未知模型：${request.modelId}` });
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
					reply(ws, request.id, { ok: true, result: await mergedProviderGroups(agentDir) });
					return;
				}
				const before = provider.models?.length ?? 0;
				provider.models = (provider.models ?? []).filter((m) => m.id !== request.modelId);
				if ((provider.models?.length ?? 0) === before) {
					reply(ws, request.id, { ok: false, error: `未知模型：${request.modelId}` });
					return;
				}
				writeModelsFile(agentDir, models);
				reply(ws, request.id, { ok: true, result: await mergedProviderGroups(agentDir) });
				return;
			}
			case "models.removeProvider": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				// 删除供应商 = 移除 models.json 声明 + 注销已存凭据。只删声明的话，
				// 登录过/贴过 Key 的内置供应商仍会凭「凭据分组」出现在 models.list 里，
				// 表现为"删了还在"。只登录过、没写进 models.json 的供应商也走这里删凭据。
				const declared = Boolean(models.providers?.[request.providerKey]);
				const storedCredential = await hasStoredCredential(request.providerKey);
				if (!declared && !storedCredential) {
					reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
					return;
				}
				if (storedCredential) {
					// 先注销凭据再删声明：注销失败时什么都没变，重试即是完整重来。
					await (await getListingServices()).modelRuntime.logout(request.providerKey);
				}
				if (request.providerKey === "cursor") {
					clearCursorAccounts(agentDir);
				}
				if (declared && models.providers) {
					delete models.providers[request.providerKey];
					writeModelsFile(agentDir, models);
				}
				reply(ws, request.id, { ok: true, result: await mergedProviderGroups(agentDir) });
				return;
			}
		}
	}

	/** Auth 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type AuthRequest = Extract<
		DesktopClientRequest,
		{
			type:
				| "auth.providers"
				| "cursor.accounts.list"
				| "cursor.accounts.switch"
				| "cursor.accounts.remove"
				| "auth.login"
				| "auth.prompt.respond"
				| "auth.cancel";
		}
	>;

	async function handleAuthRequest(ws: WebSocket, request: AuthRequest): Promise<void> {
		switch (request.type) {
			case "auth.providers": {
				// 内置厂商目录（供桌面下拉选择）：id / 显示名 / 支持的认证方式
				const services = await getListingServices();
				const result = services.modelRuntime.getProviders().map((provider) => ({
					id: provider.id,
					name: provider.name,
					oauth: Boolean(provider.auth?.oauth),
					apiKey: Boolean(provider.auth?.apiKey),
				}));
				reply(ws, request.id, { ok: true, result });
				return;
			}
			case "cursor.accounts.list": {
				reply(ws, request.id, { ok: true, result: listCursorAccountsPublic(defaultAgentDir()) });
				return;
			}
			case "cursor.accounts.switch": {
				try {
					const agentDir = defaultAgentDir();
					const account = switchCursorAccount(agentDir, request.accountId);
					const credential = credentialFromAccount(account);
					const { AuthStorage } = await import("../../core/auth-storage.ts");
					const storage = AuthStorage.create(join(agentDir, "auth.json"));
					await storage.modify("cursor", async () => credential);
					const services = await getListingServices();
					await services.modelRuntime.refresh({ providers: ["cursor"], allowNetwork: !process.env.PI_OFFLINE });
					reply(ws, request.id, { ok: true, result: listCursorAccountsPublic(agentDir) });
				} catch (error) {
					reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case "cursor.accounts.remove": {
				try {
					const agentDir = defaultAgentDir();
					const next = removeCursorAccount(agentDir, request.accountId);
					const { AuthStorage } = await import("../../core/auth-storage.ts");
					const storage = AuthStorage.create(join(agentDir, "auth.json"));
					if (next.activeId) {
						const account = next.accounts.find((entry) => entry.id === next.activeId);
						if (account) {
							await storage.modify("cursor", async () => credentialFromAccount(account));
						}
					} else {
						await (await getListingServices()).modelRuntime.logout("cursor");
					}
					const services = await getListingServices();
					await services.modelRuntime.refresh({ providers: ["cursor"], allowNetwork: !process.env.PI_OFFLINE });
					reply(ws, request.id, { ok: true, result: listCursorAccountsPublic(agentDir) });
				} catch (error) {
					reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case "auth.login": {
				// pi /login 的桌面版：oauth 走浏览器（notify 里开浏览器 + 广播进度），api_key 直接落 auth.json。
				// 流程中的提问（AuthPrompt）转发到界面，由 auth.prompt.respond 带回答案。
				// 用户换厂商重新登录 = 自动放弃上一个（否则旧回调服务器挂着，新流程会卡死）。
				if (activeLogin) {
					pendingPrompt?.reject(new Error("登录已取消"));
					pendingPrompt = null;
					activeLogin.controller.abort();
				}
				const services = await getListingServices();
				const controller = new AbortController();
				activeLogin = { controller };
				// GitHub Copilot 的第一个提问是「企业域名」：桌面默认替用户答空串（github.com）
				// 直接拉起浏览器；enterprise=true（界面勾选企业版）时才转发给界面。
				const enterpriseMode = request.enterprise === true;
				try {
					const credential = await services.modelRuntime.login(request.provider, request.authType, {
						signal: controller.signal,
						prompt: (ask) => {
							// 快捷接入贴了 API Key（authType=api_key）："Enter xxx key" 这类 secret 提问
							// 直接用贴的 Key 代答，不再转发界面让用户贴第二遍。
							if (request.authType === "api_key" && request.apiKey && ask.type === "secret") {
								return Promise.resolve(request.apiKey);
							}
							if (!enterpriseMode && ask.type === "text" && ask.message.includes("GitHub Enterprise")) {
								return Promise.resolve("");
							}
							// ask.signal 随 interaction.signal 中止：不接上的话，被替换/取消的流程
							// 会永远挂在 prompt 上，堵死 Models 的认证操作队列。
							const answer = new Promise<string>((resolve, reject) => {
								const onAbort = () => reject(new Error("登录已取消"));
								ask.signal?.addEventListener("abort", onAbort, { once: true });
								pendingPrompt = {
									ask,
									resolve: (value) => {
										ask.signal?.removeEventListener("abort", onAbort);
										resolve(value);
									},
									reject: (error) => {
										ask.signal?.removeEventListener("abort", onAbort);
										reject(error);
									},
								};
							});
							const cleanup = () => {
								pendingPrompt = null;
							};
							answer.then(cleanup, cleanup);
							broadcast({
								type: "event",
								sessionId: "",
								event: { type: "auth_prompt", ask },
							});
							return answer;
						},
						notify: (event) => {
							// auth_url（回调流）与 device_code（设备码流）都自动打开对应页面
							if (event.type === "auth_url") openInBrowser(event.url);
							if (event.type === "device_code") openInBrowser(event.verificationUri);
							broadcast({
								type: "event",
								sessionId: "",
								event: { type: "auth_notify", detail: event },
							});
						},
					});
					// Cursor 支持多账号：每次登录 upsert 到账号池，auth.json 的 cursor 槽保持当前活跃。
					if (request.provider === "cursor" && credential.type === "oauth") {
						upsertCursorAccount(defaultAgentDir(), credential);
					}
					reply(ws, request.id, { ok: true, result: { provider: request.provider, authType: request.authType } });
				} catch (error) {
					if (controller.signal.aborted) {
						// 被新登录/取消替换，静默结束，避免旧流程往界面甩报错
						reply(ws, request.id, { ok: false, error: "登录已取消" });
					} else {
						reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
					}
				} finally {
					// 只清理仍归属于本次流程的状态，别误伤替换进来的新登录
					if (activeLogin?.controller === controller) activeLogin = null;
				}
				return;
			}
			case "auth.prompt.respond": {
				if (!pendingPrompt) {
					reply(ws, request.id, { ok: false, error: "当前没有等待回答的登录提问" });
					return;
				}
				pendingPrompt.resolve(request.answer);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "auth.cancel": {
				activeLogin?.controller.abort();
				pendingPrompt?.reject(new Error("登录已取消"));
				pendingPrompt = null;
				reply(ws, request.id, { ok: true });
				return;
			}
		}
	}

	/** Settings 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type SettingsRequest = Extract<
		DesktopClientRequest,
		{
			type:
				| "settings.get"
				| "memory.list"
				| "memory.delete"
				| "memory.clear"
				| "usage.get"
				| "imageConfig.get"
				| "imageConfig.set"
				| "imageSub.login"
				| "imageSub.logout"
				| "imageModels.list"
				| "settings.set"
				| "systemPrompt.preview";
		}
	>;

	async function handleSettingsRequest(ws: WebSocket, request: SettingsRequest): Promise<void> {
		switch (request.type) {
			case "settings.get": {
				const agentDir = defaultAgentDir();
				const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
					m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
				);
				reply(ws, request.id, {
					ok: true,
					result: { agentDir, settings: settingsManager.getGlobalSettings() },
				});
				return;
			}
			case "memory.list":
			case "memory.delete":
			case "memory.clear": {
				// owl 跨会话记忆：设置页「跨会话记忆」卡片的数据面，与 owl-memory 扩展同源
				const agentDir = defaultAgentDir();
				const memory = await import("../../core/memory/store.ts");
				const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
					m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
				);
				if (request.type === "memory.list") {
					reply(ws, request.id, {
						ok: true,
						result: {
							enabled: settingsManager.getOwlMemoryEnabled(),
							entries: memory.readMemoryEntries(agentDir).map((entry) => ({
								id: entry.id,
								content: entry.content,
								...(entry.sourceCwd ? { sourceCwd: entry.sourceCwd } : {}),
								createdAt: entry.createdAt,
							})),
						},
					});
				} else if (request.type === "memory.delete") {
					reply(ws, request.id, { ok: true, result: { ok: memory.deleteMemoryEntry(agentDir, request.entryId) } });
				} else {
					memory.clearMemoryEntries(agentDir);
					reply(ws, request.id, { ok: true, result: { ok: true } });
				}
				return;
			}
			case "usage.get": {
				// owl 使用统计：设置页「使用统计」卡片 + 开始页「使用概览」面板的数据面。
				// 纯文件聚合（见 ./usage-stats.ts），不挂载会话；进行中的会话落盘即计入，
				// 前端短轮询即为实时。mtime+size 增量缓存 + 删除不回吐的累积口径。
				const usageStats = await import("./usage-stats.ts");
				const filter =
					request.days !== undefined || request.cwd !== undefined
						? { days: request.days, cwd: request.cwd }
						: undefined;
				reply(ws, request.id, { ok: true, result: await usageStats.collectUsageStats(filter) });
				return;
			}
		}
	}

	/** Other 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type OtherRequest = Extract<
		DesktopClientRequest,
		{
			type:
				| "ping"
				| "events.subscribe"
				| "commands.list"
				| "project.create"
				| "context.get"
				| "permission.response"
				| "question.response"
				| "settings.get";
		}
	>;

	async function handleOtherRequest(ws: WebSocket, request: OtherRequest): Promise<void> {
		switch (request.type) {
			case "ping": {
				reply(ws, request.id, { ok: true, result: "pong" });
				return;
			}
			case "events.subscribe": {
				eventFanout.subscribe(ws, request.sessionIds === "all" ? "all" : request.sessionIds);
				reply(ws, request.id, { ok: true, result: { ok: true } });
				return;
			}
		}
	}

	/** Hosted 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type HostedRequest = Extract<
		DesktopClientRequest,
		{ type: "evaluation.request" | "mail.request" | "mail.agent.start" | "news.request" }
	>;

	async function handleHostedRequest(ws: WebSocket, request: HostedRequest): Promise<void> {
		switch (request.type) {
			case "evaluation.request": {
				const origin = clientOrigins.get(ws);
				if (
					origin &&
					!["127.0.0.1", "localhost", "[::1]", "tauri.localhost"].includes(new URL(origin).hostname.toLowerCase())
				) {
					throw new Error("模型测评请求只接受本机界面来源");
				}
				reply(ws, request.id, { ok: true, result: await getEvaluationService().handle(request.request) });
				return;
			}
			case "mail.request": {
				reply(ws, request.id, { ok: true, result: await getMailService().handle(request.request) });
				return;
			}
			case "mail.agent.start": {
				const context = await validateMailAgentContext(getMailService(), request.context);
				const agentDir = defaultAgentDir();
				const cwd = request.cwd ?? options.cwd ?? process.cwd();
				const sessionManager = SessionManager.create(cwd, join(agentDir, "mail", "agent-sessions"));
				sessionManager.appendCustomEntry(MAIL_AGENT_CONTEXT_ENTRY, context);
				await mountSession(ws, request.id, {
					sessionManager,
					agentDir,
					approvalMode: "auto",
					provider: request.provider,
					model: request.model,
					thinkingLevel: request.thinkingLevel,
				});
				return;
			}
			case "news.request": {
				const origin = clientOrigins.get(ws);
				if (origin && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname.toLowerCase())) {
					throw new Error("资讯管理请求只接受本机界面来源");
				}
				reply(ws, request.id, { ok: true, result: await newsRequest(request.request) });
				return;
			}
		}
	}

	/** Context 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type ContextRequest = Extract<DesktopClientRequest, { type: "context.get" | "session.compact" }>;

	async function handleContextRequest(ws: WebSocket, request: ContextRequest): Promise<void> {
		switch (request.type) {
			case "context.get": {
				const sessionId = request.sessionId ?? findContextInsightByCwd(request.cwd)?.sessionId;
				let state = sessionId ? getContextInsight(sessionId) : undefined;
				let reconstructed = false;
				if (sessionId && (!state || state.requests.length === 0)) {
					const rows = await contextInsightFromHistory(sessionId);
					if (rows && rows.requests.length > 0) {
						state = { sessionId, cwd: request.cwd, ...rows, lastTs: Date.now() } satisfies ContextInsightState;
						reconstructed = true;
					}
				}
				reply(ws, request.id, {
					ok: true,
					result: {
						sessionId,
						requests: state ? [...state.requests] : [],
						events: state ? [...state.events] : [],
						tools: state ? [...state.tools] : [],
						...(reconstructed ? { reconstructed: true } : {}),
					},
				});
				return;
			}
			case "session.compact": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				try {
					await session.runtime.session.compact();
					reply(ws, request.id, { ok: true, result: sessionStateSnapshot(session.runtime.session) });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
		}
	}

	/** Commands 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type CommandsRequest = Extract<DesktopClientRequest, { type: "commands.list" }>;

	async function handleCommandsRequest(ws: WebSocket, request: CommandsRequest): Promise<void> {
		switch (request.type) {
			case "commands.list": {
				reply(ws, request.id, { ok: true, result: await listSlashCommands(request.cwd) });
				return;
			}
		}
	}

	/** SessionLifecycle 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type SessionLifecycleRequest = Extract<
		DesktopClientRequest,
		{ type: "session.resume" | "session.fork" | "session.list" | "session.running" }
	>;

	async function handleSessionLifecycleRequest(ws: WebSocket, request: SessionLifecycleRequest): Promise<void> {
		switch (request.type) {
			case "session.resume": {
				await resumeSession(ws, request);
				return;
			}
			case "session.fork": {
				// 在新对话中分支：以目标条目为末梢复制新会话文件（createBranchedSession，
				// 头部 parentSession 指回原会话），原会话原封不动；然后按恢复流程全新
				// 挂载分支会话——不复用运行时，权限/事件订阅等闭包里的 sessionId 才不会过期。
				// 响应复用挂载快照（与 session.resume 同构），前端走同一条回放切换路径。
				const existing = sessions.get(request.sessionId);
				if (!existing) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				const sourceManager = existing.runtime.session.sessionManager;
				// 压缩会整文件重写，读盘做副本会读到半截；流式输出只是往尾部追加，历史条目已经落盘。
				if (existing.runtime.session.isCompacting) {
					reply(ws, request.id, { ok: false, error: "会话正在压缩，等压缩完成后再分支" });
					return;
				}
				// 运行中的会话留在后台继续：分支只复制到目标条目为止，不卸载、不中止原运行时。
				const keepSourceRunning = existing.runtime.session.isStreaming;
				const sourceFile = sourceManager.getSessionFile();
				if (!sourceFile || !existsSync(sourceFile)) {
					reply(ws, request.id, { ok: false, error: "会话还没有落盘，先发一条消息再分支" });
					return;
				}
				if (getMailAgentContext(sourceManager) || getResearchMode(sourceManager)) {
					reply(ws, request.id, { ok: false, error: "邮箱/研究会话暂不支持在新对话中分支" });
					return;
				}
				if (!sourceManager.getEntry(request.entryId)) {
					reply(ws, request.id, { ok: false, error: "分支目标消息不存在" });
					return;
				}
				try {
					const branched = SessionManager.open(sourceFile, sourceManager.getSessionDir());
					const branchFile = branched.createBranchedSession(request.entryId);
					if (!branchFile) throw new Error("分支会话创建失败");
					// 分支命名：fork<N> · 来自「<根会话名>」。名字沿 parentSession 链追溯到最初
					// 的来源（fork 链再深也不会越叠越长）；N 取整个家族（根的全部后代）现有
					// 序号的最大值 +1——同一来源的分支按分支时间自然递增、互不撞号。
					const sourceRows = await SessionManager.listAll(sourceManager.getSessionDir());
					const byPath = new Map(sourceRows.map((row) => [resolve(row.path), row]));
					const sourcePath = resolve(sourceFile);
					const visited = new Set<string>([sourcePath]);
					let rootPath = sourcePath;
					for (;;) {
						const row = byPath.get(rootPath);
						const parent = row?.parentSessionPath ? resolve(row.parentSessionPath) : undefined;
						if (!parent || visited.has(parent) || !byPath.has(parent)) break;
						visited.add(rootPath);
						rootPath = parent;
					}
					const children = new Map<string, string[]>();
					for (const row of sourceRows) {
						if (!row.parentSessionPath) continue;
						const parent = resolve(row.parentSessionPath);
						const list = children.get(parent);
						if (list) list.push(resolve(row.path));
						else children.set(parent, [resolve(row.path)]);
					}
					let lastForkNumber = 0;
					const familyQueue = [rootPath];
					const seenFamily = new Set<string>([rootPath]);
					while (familyQueue.length > 0) {
						const current = familyQueue.shift()!;
						for (const child of children.get(current) ?? []) {
							if (seenFamily.has(child)) continue;
							seenFamily.add(child);
							const match = /^fork(\d+) · /.exec(byPath.get(child)?.name ?? "");
							if (match) lastForkNumber = Math.max(lastForkNumber, Number(match[1]));
							familyQueue.push(child);
						}
					}
					// 根会话名：显示名或首条用户消息；万一追溯断在半路（父文件被删），
					// 把残留的 fork 包装层剥掉， nesting 也不会渗回来
					let rootTitle = (byPath.get(rootPath)?.name ?? byPath.get(rootPath)?.firstMessage ?? "")
						.trim()
						.replace(/\s+/g, " ");
					for (;;) {
						const unwrap = /^fork\d+ · 来自「(.+)」$/.exec(rootTitle);
						if (!unwrap) break;
						rootTitle = unwrap[1]!;
					}
					rootTitle = rootTitle.slice(0, 80) || "原会话";
					branched.appendSessionInfo(`fork${lastForkNumber + 1} · 来自「${rootTitle}」`);
					if (!keepSourceRunning) await unmountSessionRuntime(request.sessionId);
					await mountSession(ws, request.id, {
						sessionManager: branched,
						agentDir: defaultAgentDir(),
						provider: request.provider,
						model: request.model,
						thinkingLevel: request.thinkingLevel,
						approvalMode: request.approvalMode ?? existing.approvalMode.current,
					});
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: `分支失败：${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return;
			}
			case "session.list": {
				if (request.scope !== undefined && request.scope !== "chat" && request.scope !== "research") {
					throw new Error("无效的会话目录类型");
				}
				const found = await listSessionsShared(request.sessionDir);
				// 附带归档标记：sidebar 据此把会话放进「归档」分组
				const meta = readArchiveMeta(defaultAgentDir());
				reply(ws, request.id, {
					ok: true,
					result: found
						.map((row) => {
							const scope = row.customTypes?.includes(RESEARCH_MODE_ENTRY) ? "research" : "chat";
							const archived = meta.sessions?.[row.id];
							// allMessagesText 只服务 TUI 搜索；桌面侧栏不用，下发会放大 WS 负载
							const { allMessagesText: _allMessagesText, ...rest } = row;
							return { ...rest, scope, ...(archived ? { archivedAt: archived.archivedAt } : {}) };
						})
						.filter((row) => request.scope === undefined || row.scope === request.scope),
				});
				return;
			}
			case "session.running": {
				// 已挂载且 agent run 活跃的会话 id 列表（UI 刷新后恢复侧边栏绿点状态）
				const running = [...sessions.entries()]
					.filter(([, entry]) => entry.runtime.session.isStreaming)
					.map(([sessionId]) => sessionId);
				reply(ws, request.id, { ok: true, result: { running } });
				return;
			}
		}
	}

	/** ImageSettings 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
	type ImageSettingsRequest = Extract<
		DesktopClientRequest,
		{
			type:
				| "imageConfig.get"
				| "imageConfig.set"
				| "imageSub.login"
				| "imageSub.logout"
				| "imageModels.list"
				| "settings.set"
				| "systemPrompt.preview";
		}
	>;

	async function handleImageSettingsRequest(ws: WebSocket, request: ImageSettingsRequest): Promise<void> {
		switch (request.type) {
			case "imageConfig.get":
			case "imageConfig.set":
			case "imageSub.login":
			case "imageSub.logout":
			case "imageModels.list": {
				// owl-image 图像生成：设置页「图像生成」卡片的数据面（文件操作 + 动态
				// import 插件 dist 做订阅登录），详见 ./owl-image-settings.ts 头注释。
				const agentDir = defaultAgentDir();
				const imageSettings = await import("./owl-image-settings.ts");
				const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
					m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
				);
				const pluginSources = settingsManager.getGlobalSettings().plugins;
				if (request.type === "imageConfig.get") {
					reply(ws, request.id, {
						ok: true,
						result: {
							config: imageSettings.readImageConfigPublic(agentDir),
							keyStatus: imageSettings.apiKeyStatus(agentDir),
							subscription: imageSettings.subscriptionStatus(agentDir),
							configPath: imageSettings.imageConfigPath(agentDir),
							pluginInstalled: imageSettings.findOwlImageDist(pluginSources) !== undefined,
						},
					});
				} else if (request.type === "imageConfig.set") {
					const written = imageSettings.writeImageConfig(agentDir, request.config, request.apiKeys);
					if (!written.ok) {
						reply(ws, request.id, { ok: false, error: written.error });
					} else {
						reply(ws, request.id, { ok: true, result: { ok: true } });
					}
				} else if (request.type === "imageSub.login") {
					const login = await imageSettings.subscriptionLogin(pluginSources);
					if (login.ok) reply(ws, request.id, { ok: true, result: { ok: true, url: login.url } });
					else reply(ws, request.id, { ok: false, error: login.error });
				} else if (request.type === "imageModels.list") {
					const models = await imageSettings.listProviderModels(pluginSources, request.provider);
					reply(ws, request.id, { ok: true, result: models });
				} else {
					imageSettings.subscriptionLogout(agentDir);
					reply(ws, request.id, { ok: true, result: { ok: true } });
				}
				return;
			}
			case "settings.set": {
				const agentDir = defaultAgentDir();
				const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
					m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
				);
				const settings = settingsManager.applyGlobalOverridesAndSave(request.values as never);
				if (Object.hasOwn(request.values, "owlMemory")) {
					await settingsManager.flush();
					await Promise.all([...sessions.values()].map(({ runtime }) => runtime.session.settingsManager.reload()));
				}
				reply(ws, request.id, { ok: true, result: settings });
				return;
			}
			case "systemPrompt.preview": {
				// 设置页「内置提示词」只读展示：与真实会话同一条组装路径（默认工具集）。
				const cwd = options.cwd ?? process.cwd();
				const toolDefs = createAllToolDefinitions(cwd);
				const selectedTools = ["read", "bash", "process", "edit", "write", "todo"] as const;
				const sections = buildSystemPromptSections({
					cwd,
					appendSystemPrompt: DESKTOP_AGENT_INSTRUCTIONS,
					selectedTools: [...selectedTools],
					toolSnippets: Object.fromEntries(
						selectedTools.map((name) => [name, toolDefs[name].promptSnippet ?? ""]),
					),
					toolGuidelines: Object.fromEntries(
						selectedTools.map((name) => [name, toolDefs[name].promptGuidelines ?? []]),
					),
				});
				// 去掉各分区的 <tag> 包裹，前端直接展示正文
				const stripped = Object.fromEntries(
					Object.entries(sections).map(([name, content]) => {
						const open = `<${name}>\n`;
						const close = `\n</${name}>`;
						return [
							name,
							content.startsWith(open) && content.endsWith(close)
								? content.slice(open.length, -close.length)
								: content,
						];
					}),
				);
				reply(ws, request.id, { ok: true, result: { sections: stripped } satisfies SystemPromptPreviewResult });
				return;
			}
		}
	}

	const terminalContext: TerminalHandlerContext = {
		reply,
		terminals,
		wsTerms,
	};
	const browserContext: BrowserHandlerContext = {
		reply,
		iab,
		iabSubscriptions,
	};
	const mirrorContext: MirrorHandlerContext = {
		reply,
		mirror,
		mirrorProjectionAccess,
		mirrorFrames,
		mirrorSubscriptions,
	};
	const workspaceContext: WorkspaceHandlerContext = {
		reply,
		onDiagnostic,
		broadcast,
		sidebarWatchers,
		viewerRequests,
	};

	const workbenchContext: WorkbenchHandlerContext = {
		reply,
		defaultAgentDir,
		pendingPermissions,
		schedule,
	};

	async function handleRequest(ws: WebSocket, request: DesktopClientRequest): Promise<void> {
		if ("sessionId" in request && typeof request.sessionId === "string") {
			const transition = presetTransitions.get(request.sessionId);
			if (transition) await transition;
		}
		switch (request.type) {
			case "evaluation.request":
			case "mail.request":
			case "mail.agent.start":
			case "news.request":
				await handleHostedRequest(ws, request);
				return;
			case "ping":
			case "events.subscribe":
				await handleOtherRequest(ws, request);
				return;
			case "session.create":
			case "session.prompt":
			case "session.queue.remove":
			case "session.queue.promote":
			case "owl-ui.action":
			case "session.continue":
			case "session.abort":
			case "session.delete":
			case "session.archive":
			case "session.rename":
			case "session.unarchive":
			case "session.archiveConfig":
			case "session.setModel":
			case "session.setThinkingLevel":
			case "session.setApprovalMode":
			case "session.setPreset":
				await handleSessionRequest(ws, request);
				return;
			case "preset.list":
			case "preset.setDefault":
			case "preset.save":
			case "preset.delete":
				await handlePresetRequest(ws, request);
				return;
			case "session.stats":
			case "session.exportLog":
			case "session.turns":
				await handleSessionLogRequest(ws, request);
				return;
			// 「上下文洞察」由插件 owl-context 经 context-insight 注册表供数：
			// 按 sessionId 或（缺省）按 cwd 取最近活跃会话。注册表只在插件现采后
			// 才有数据，恢复历史会话时是空的——这时从会话转录重建一份（带
			// reconstructed 标记），让「上下文」页不至于一直空着。
			case "context.get":
			case "session.compact":
				await handleContextRequest(ws, request);
				return;
			// -- 会话回退（owl-rewind） --------------------------------------------------
			case "rewind.targets":
			case "rewind.impact":
			case "rewind.execute":
				await handleRewindRequest(ws, request);
				return;
			// -- 改动审批（owl-diff-approval）------------------------------------------
			// 按 cwd 定位工作区存储（与 fs.*/git.* 同口径），不依赖会话挂载；
			// 插件侧捕获也经同一注册表实例写，broadcast 由注册表的 onChanged 触发。
			case "diffApproval.list":
			case "diffApproval.diff":
			case "diffApproval.resolve":
			case "diffApproval.clear":
				await handleDiffApprovalRequest(ws, request, workbenchContext);
				return;
			case "commands.list":
				await handleCommandsRequest(ws, request);
				return;
			case "skills.list":
			case "skills.groups.save":
			case "skills.project.addExtras":
			case "skills.project.removeExtras":
			case "skills.setProjectSelection":
			case "skills.read":
			case "skills.setEnabled":
			case "skills.create":
			case "skills.update":
			case "skills.delete":
				await handleSkillsRequest(ws, request);
				return;
			case "session.resume":
			case "session.fork":
			case "session.list":
			case "session.running":
				await handleSessionLifecycleRequest(ws, request);
				return;
			case "project.create":
				await handleProjectRequest(ws, request, workspaceContext);
				return;
			case "models.list":
			case "models.putProvider":
			case "models.putModel":
			case "models.removeModel":
			case "models.removeProvider":
			case "models.discover":
				await handleModelsRequest(ws, request);
				return;
			case "auth.providers":
			case "cursor.accounts.list":
			case "cursor.accounts.switch":
			case "cursor.accounts.remove":
			case "auth.login":
			case "auth.prompt.respond":
			case "auth.cancel":
				await handleAuthRequest(ws, request);
				return;
			case "settings.get":
			case "memory.list":
			case "memory.delete":
			case "memory.clear":
			case "usage.get":
				await handleSettingsRequest(ws, request);
				return;
			case "schedule.list":
			case "schedule.create":
			case "schedule.update":
			case "schedule.delete":
			case "schedule.run":
			case "schedule.history":
				await handleScheduleRequest(ws, request, workbenchContext);
				return;
			case "imageConfig.get":
			case "imageConfig.set":
			case "imageSub.login":
			case "imageSub.logout":
			case "imageModels.list":
			case "settings.set":
			case "systemPrompt.preview":
				await handleImageSettingsRequest(ws, request);
				return;
			case "permission.response":
			case "question.response":
				await handleDialogRequest(ws, request, workbenchContext);
				return;
			case "fs.tree":
			case "viewer.list":
			case "viewer.open":
			case "fs.read":
			case "fs.readBin":
			case "fs.write":
			case "fs.mkdir":
			case "fs.rename":
			case "fs.remove":
			case "fs.search":
				await handleFsRequest(ws, request, workspaceContext);
				return;
			case "git.status":
			case "git.diff":
			case "git.stage":
			case "git.unstage":
			case "git.commit":
			case "git.discard":
			case "git.log":
				await handleGitRequest(ws, request, workspaceContext);
				return;
			case "watch.set":
			case "open.external":
				await handleWatchRequest(ws, request, workspaceContext);
				return;
			case "term.create":
			case "term.input":
			case "term.resize":
			case "term.kill":
				await handleTermRequest(ws, request, terminalContext);
				return;
			case "iab.open":
			case "iab.nav":
			case "iab.viewport":
			case "iab.input":
			case "iab.attach":
			case "iab.detach":
			case "iab.close":
			case "iab.state":
			case "iab.fileResponse":
				await handleIabRequest(ws, request, browserContext);
				return;
			case "mirror.list":
			case "mirror.attach":
			case "mirror.detach":
			case "mirror.project":
			case "mirror.input":
			case "mirror.restore":
			case "mirror.launch":
			case "mirror.embed":
			case "mirror.layout":
			case "mirror.fitowl":
			case "mirror.unembed":
				await handleMirrorRequest(ws, request, mirrorContext);
				return;
			case "build.hello":
				reply(ws, request.id, { ok: true, result: await buildChecker.hello(request.ui) });
				return;
			default: {
				const unmatched = request as { id?: string; type?: string };
				const pluginHandler = unmatched.type ? bridgeRoutes.get(unmatched.type) : undefined;
				if (pluginHandler) {
					const result = await pluginHandler(request as unknown as BridgeRequest, {
						origin: clientOrigins.get(ws),
					});
					reply(ws, unmatched.id ?? "?", { ok: true, result });
					return;
				}
				// 不认识的请求必须回错误：否则 UI 的 promise 永远挂起（典型场景 = 桥是旧进程、
				// UI 已是新版，或提供该请求的桥插件没装），界面上表现为"点了没反应"。
				reply(ws, unmatched.id ?? "?", {
					ok: false,
					error: `未知请求类型：${String(unmatched.type)}（UI 与桥版本不匹配，请重启应用）`,
				});
				return;
			}
		}
	}

	const uiRoot = resolveUiRoot();
	const buildChecker = new BuildChecker({
		moduleUrl: import.meta.url,
		uiRoot,
		agentDir: defaultAgentDir(),
		plugins: async () => {
			const settings = (await getGlobalSettingsManager())?.getGlobalSettings();
			return settings
				? [...(settings.plugins ?? []), ...(settings.packages ?? []), ...(settings.extensions ?? [])]
				: [];
		},
		onDiagnostic,
	});
	const bridgePlugins = await bridgePluginsLoading;
	const bridgeRoutes = bridgeRequestRoutes(bridgePlugins, onDiagnostic);
	const httpServer = createServer((request, response) => {
		void handleNewsHttp(request, response, {
			handle: newsRequest,
			authorizeIngest: (token) => getNewsService().authorizeIngest(token),
			shutdown: closeNews,
		})
			.then((handled) => handled || handleBridgePluginHttp(bridgePlugins, request, response, onDiagnostic))
			// 媒体桥（owl-media-bridge 插件）的同源 API；插件未加载时处理器缺位，
			// 直接落到 UI 静态服务——与没有媒体桥时完全一致。
			.then(
				(handled) =>
					handled ||
					(getMediaBridgeHttpHandler()?.(request, response, {
						authorizeOrigin: (origin) => isTrustedDesktopOrigin(origin, options.host),
					}) ??
						false),
			)
			.then((handled) => {
				if (handled) return;
				if (!uiRoot) {
					response.writeHead(426).end("owl desktop bridge: WebSocket only");
					return;
				}
				serveUi(uiRoot, request.url ?? "/", response, request.method === "HEAD");
			})
			.catch((error) => {
				onDiagnostic(`资讯请求失败：${error instanceof Error ? error.message : String(error)}`);
				if (!response.headersSent)
					response
						.writeHead(500, { "Content-Type": "application/json" })
						.end(JSON.stringify({ error: "资讯请求失败" }));
			});
	});
	const wss = new WebSocketServer({
		server: httpServer,
		verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) =>
			isTrustedDesktopOrigin(info.req.headers.origin, options.host),
	});
	wss.on("connection", (ws, upgrade) => {
		clients.add(ws);
		clientOrigins.set(ws, upgrade.headers.origin);
		replayAllPendingRequests(ws);
		ws.on("message", (data) => {
			let request: DesktopClientRequest;
			try {
				request = JSON.parse(String(data)) as DesktopClientRequest;
			} catch {
				reply(ws, "?", { ok: false, error: "Invalid JSON" });
				return;
			}
			void handleRequest(ws, request).catch((error) => {
				// SidebarError 带 code 前缀过线（already-exists 等分支前端用来决定文案）。
				const text =
					error instanceof SidebarError
						? `${error.code}: ${error.message}`
						: error instanceof Error
							? error.message
							: String(error);
				reply(ws, request.id ?? "?", { ok: false, error: text });
			});
		});
		ws.on("close", () => {
			clients.delete(ws);
			eventFanout.disconnect(ws);
			for (const controller of viewerRequests.get(ws) ?? []) controller.abort();
			viewerRequests.delete(ws);
			// 连接断开：回收它名下的终端（UI 关闭时也会主动 kill，这里是兜底）
			const owned = wsTerms.get(ws);
			if (owned) {
				for (const termId of owned) terminals.kill(termId);
				wsTerms.delete(ws);
			}
			iabSubscriptions.delete(ws);
			mirrorFrames.disconnect(ws);
			const mirrorOwned = mirrorSubscriptions.get(ws);
			if (mirrorOwned) {
				for (const windowId of mirrorOwned) mirror.detach(windowId);
				mirrorSubscriptions.delete(ws);
			}
			void mirrorProjectionAccess
				.disconnect(ws)
				.catch((error: unknown) => onDiagnostic(`mirror restore on disconnect: ${String(error)}`));
		});
	});

	const port = options.port ?? 8787;
	const host = options.host ?? "127.0.0.1";
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, host, resolve);
	});
	startArchivePurgeTimer();
	try {
		getNewsService();
	} catch (error) {
		onDiagnostic(`资讯服务初始化失败：${error instanceof Error ? error.message : String(error)}`);
	}
	const unsubscribeViewers = subscribeWorkspaceViewers((viewers) => broadcast({ type: "viewer.changed", viewers }));
	const address = httpServer.address();
	const actualPort = address && typeof address === "object" ? address.port : port;

	return {
		port: actualPort,
		async close() {
			unsubscribeViewers();
			if (archiveTimer) clearInterval(archiveTimer);
			closingEvaluation = true;
			await evaluation?.close();
			await closeNews();
			schedule.stop();
			closingMail = true;
			// 桥关闭：挂起的提问全部按取消处理，并摘除提问通道（插件随后会在
			// 每轮 reconcile 时把工具摘掉）
			cancelAllPendingQuestions();
			pendingPermissions.cancelAll();
			eventFanout.flushAll();
			await Promise.all([...sessions.keys()].map(unmountSessionRuntime));
			await mail?.dispose();
			setQuestionChannel(undefined);
			setDiffApprovalBroadcaster(undefined);
			for (const watchers of sidebarWatchers.values()) watchers.close();
			sidebarWatchers.clear();
			terminals.killAll();
			await iab.dispose();
			mirror.dispose();
			await closeBridgePlugins(bridgePlugins, onDiagnostic);
			for (const client of clients) client.close();
			wss.close();
			await mcp?.close();
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

// ---------------------------------------------------------------------------
// Entry: node dist/modes/desktop/serve.js [--port 8787]
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const portArg = process.argv.indexOf("--port");
	const port = portArg > 0 ? Number(process.argv[portArg + 1]) : Number(process.env.OWL_PORT ?? 8787);
	void startDesktopServer({ port }).then((handle) => {
		console.log(`owl desktop bridge listening on http://127.0.0.1:${handle.port}`);
		let stopping = false;
		const stop = () => {
			if (stopping) return;
			stopping = true;
			void handle.close().then(() => process.exit(0));
		};
		process.on("SIGTERM", stop);
		process.on("SIGINT", stop);
	});
}

export type { JsonAgentSessionEvent };
