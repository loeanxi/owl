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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type WebSocket, WebSocketServer } from "ws";
import { expandTildePath, getAgentDir, getGlobalSkillsDir } from "../../config.ts";
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
import { getWorkspaceDiffApprovalStore, setDiffApprovalBroadcaster } from "../../core/diff-approval/registry.ts";
import { EvaluationService, type EvaluationServiceOptions } from "../../core/evaluation/service.ts";
import type { InlineExtension, ToolDefinition } from "../../core/extensions/index.ts";
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
	getPendingQuestionRequests,
	resolveQuestion,
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
import { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { loadSkills } from "../../core/skills.ts";
import { buildSystemPromptSections } from "../../core/system-prompt.ts";
import { createAllToolDefinitions } from "../../core/tools/index.ts";
import { listWorkspaceViewers, openWorkspaceViewer, subscribeWorkspaceViewers } from "../../core/workspace-viewers.ts";
import { builtInExtensions } from "../../extensions/index.ts";
import { type JsonAgentSessionEvent, toJsonEvent } from "../json-event.ts";
import { DESKTOP_AGENT_INSTRUCTIONS, desktopAgentPromptOptions } from "./agent-instructions.ts";
import { BrowserHub } from "./browser-hub.ts";
import { isReadOnlyDesktopTool } from "./browser-permissions.ts";
import { handleMapHttp } from "./map-http.ts";
import { RealMapService, type RealMapServiceOptions } from "./map-service.ts";
import { createMapTools } from "./map-tools.ts";
import { handleNewsHttp } from "./news-http.ts";
import { callNewsModel } from "./news-model.ts";
import { createNewsTools } from "./news-tools.ts";
import type {
	CommandsListResult,
	DiffApprovalClearResult,
	DiffApprovalDiffResult,
	DiffApprovalListResult,
	DiffApprovalResolveResult,
	IabFrameMessage,
	IabOpenResult,
	IabPageInfo,
	IabStateResult,
	PermissionRequestMessage,
	RewindExecuteResult,
	RewindImpactFile,
	RewindImpactResult,
	RewindTargetsResult,
	SessionSnapshotPayload,
	SlashCommandEntry,
} from "./protocol.ts";
import {
	listWorkspaceDirectory,
	mkdirWorkspaceEntry,
	readWorkspaceFile,
	readWorkspaceFileBinary,
	removeWorkspaceEntry,
	renameWorkspaceEntry,
	resolveUnderWorkspace,
	SidebarError,
	searchWorkspaceFiles,
	toWirePath,
	writeWorkspaceFile,
} from "./sidebar-fs.ts";
import { gitCommit, gitDiff, gitDiscard, gitLog, gitStage, gitStatus, gitUnstage } from "./sidebar-git.ts";
import { createSidebarOpenTool } from "./sidebar-open-tool.ts";
import { createDirectoryWatchers, type DirectoryWatchers } from "./sidebar-watch.ts";
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
import { handleWallpaperHttp } from "./wallpaper-http.ts";

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
				...(model.reasoning ? { reasoning: model.reasoning } : {}),
			})),
		});
	}
	return result;
}

function readModelsFile(agentDir: string): ModelsFile {
	try {
		return JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8")) as ModelsFile;
	} catch {
		return {};
	}
}

function writeModelsFile(agentDir: string, models: ModelsFile): void {
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`);
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
	TermDataMessage,
	TermExitMessage,
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static UI — single-port mode: the bridge also serves the built desktop UI,
// so `node serve.js` alone is the whole app. Override with OWL_UI_DIR.
// ---------------------------------------------------------------------------

const UI_CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json",
};

function resolveUiRoot(): string | null {
	const explicit = process.env.OWL_UI_DIR;
	if (explicit && existsSync(join(explicit, "index.html"))) return explicit;
	// 从本文件位置向上找仓库根的 apps/desktop/dist，不依赖固定层级
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "apps", "desktop", "dist");
		if (existsSync(join(candidate, "index.html"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function serveUi(uiRoot: string, requestPath: string, response: ServerResponse, headOnly: boolean): void {
	let relative = "/";
	try {
		relative = normalize(decodeURIComponent(requestPath.split("?")[0] ?? "/"));
	} catch {
		// 非法编码按 "/" 处理
	}
	let filePath = join(uiRoot, relative.replace(/^[/\\]+/, ""));
	// 目录穿越防护：逃出 uiRoot 一律回退 SPA 入口
	if (filePath !== uiRoot && !filePath.startsWith(uiRoot + sep)) filePath = join(uiRoot, "index.html");
	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		filePath = join(uiRoot, "index.html"); // SPA fallback
	}
	try {
		const body = readFileSync(filePath);
		const isHtml = extname(filePath).toLowerCase() === ".html";
		response.writeHead(200, {
			"Content-Type": UI_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
			// 入口 HTML 不许缓存：dist 重建后已打开的窗口刷新/重开必须拿到新 bundle
			//（资源文件本身带内容哈希，可安全缓存）。
			...(isHtml ? { "Cache-Control": "no-cache" } : {}),
		});
		response.end(headOnly ? undefined : body);
	} catch {
		response.writeHead(500).end();
	}
}

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
	/** Real geographic sources, injectable for offline map regression checks. */
	maps?: RealMapServiceOptions;
	/** Fake evaluation dependencies for isolated local tests; never use paid models in tests. */
	evaluation?: Partial<
		Pick<EvaluationServiceOptions, "listModels" | "invoke" | "check" | "builtinTasks" | "idleTimeoutMs">
	>;
}

export interface DesktopServerHandle {
	port: number;
	close(): Promise<void>;
}

/** Only local desktop/browser surfaces may subscribe to private agent and mailbox events. */
export function isTrustedDesktopOrigin(origin: string | undefined, bindingHost?: string): boolean {
	if (origin === undefined) return true;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
		return false;
	if (url.protocol === "tauri:") return url.hostname === "localhost";
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (["localhost", "127.0.0.1", "[::1]", "tauri.localhost"].includes(url.hostname)) return true;
	if (!bindingHost || ["0.0.0.0", "::", "[::]"].includes(bindingHost)) return false;
	return url.hostname === bindingHost.toLowerCase();
}

// ---------------------------------------------------------------------------
// 会话归档：归档是侧边栏元数据，不写进会话文件，统一记在
// <agentDir>/Owl-history/archive.json —— { retentionDays, sessions: {id: {archivedAt, path?}} }。
// 桥端定时巡检：归档超过 retentionDays（默认 15 天）的会话自动删除 JSONL。
// ---------------------------------------------------------------------------

interface ArchiveMetaEntry {
	archivedAt: string;
	/** 归档时定位到的 JSONL 路径（巡检优先用它，找不到再按 id 全盘搜索）。 */
	path?: string;
}

interface ArchiveMetaFile {
	retentionDays?: number;
	sessions?: Record<string, ArchiveMetaEntry>;
}

export const DEFAULT_ARCHIVE_RETENTION_DAYS = 15;
/** 巡检间隔：1 小时（保留期以天为单位，小时级精度足够）。 */
const ARCHIVE_PURGE_INTERVAL_MS = 60 * 60 * 1000;

function archiveMetaPath(agentDir: string): string {
	return join(agentDir, "Owl-history", "archive.json");
}

function readArchiveMeta(agentDir: string): ArchiveMetaFile {
	try {
		const parsed = JSON.parse(readFileSync(archiveMetaPath(agentDir), "utf-8")) as ArchiveMetaFile;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeArchiveMeta(agentDir: string, meta: ArchiveMetaFile): void {
	const path = archiveMetaPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
}

function archiveRetentionDays(meta: ArchiveMetaFile): number {
	const value = meta.retentionDays;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_ARCHIVE_RETENTION_DAYS;
}

export async function startDesktopServer(options: DesktopServerOptions = {}): Promise<DesktopServerHandle> {
	const onDiagnostic = options.onDiagnostic ?? ((message: string) => console.error(`[owl] ${message}`));
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
	/** sessionId → live runtime + event subscription（approvalMode 为运行时可变的审批模式 holder）。 */
	const sessions = new Map<
		string,
		{ runtime: AgentSessionRuntime; unsubscribe: () => void; approvalMode: { current: ApprovalMode } }
	>();
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
			const info = (await SessionManager.listAll()).find((row) => row.id === sessionId);
			if (!info) return undefined;
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(info.path).mtimeMs;
			} catch {
				return undefined;
			}
			const key = String(mtimeMs);
			const cached = contextRebuildCache.get(sessionId);
			if (cached && cached.key === key) return cached.rows;
			const rows = reconstructContextInsight(SessionManager.open(info.path).buildSessionProjection().entries);
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
	const pendingPermissions = new Map<
		string,
		{ sessionId: string; message: PermissionRequestMessage; resolve: (approved: boolean) => void }
	>();
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
	const maps = new RealMapService(options.maps);
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

	/** 按 id 定位历史会话的 JSONL 文件。 */
	async function findSessionFile(sessionId: string): Promise<string | undefined> {
		const ordinary = (await SessionManager.listAll()).find((row) => row.id === sessionId)?.path;
		return (
			ordinary ??
			(await SessionManager.listAll(join(defaultAgentDir(), "mail", "agent-sessions"))).find(
				(row) => row.id === sessionId,
			)?.path
		);
	}

	/** 卸载已挂载的会话运行时：停掉进行中的回复、退订事件并移出运行时表。 */
	async function unmountSessionRuntime(sessionId: string): Promise<void> {
		const mounted = sessions.get(sessionId);
		for (const [requestId, pending] of pendingPermissions) {
			if (pending.sessionId !== sessionId) continue;
			pendingPermissions.delete(requestId);
			pending.resolve(false);
		}
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

	function broadcast(message: DesktopServerMessage): void {
		const payload = JSON.stringify(message);
		for (const client of clients) {
			if (client.readyState === client.OPEN) {
				client.send(payload);
			}
		}
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

	/** 读全局设置里的 owlWallpaper 字段（桌面端动态壁纸；字段由 UI 写入，桥只读）。 */
	function owlWallpaperField(key: "customDir" | "customPath"): Promise<string> {
		return getGlobalSettingsManager().then((manager) => {
			const wallpaper = (manager?.getGlobalSettings() as { owlWallpaper?: unknown } | undefined)?.owlWallpaper;
			if (typeof wallpaper !== "object" || wallpaper === null) return "";
			const value = (wallpaper as Record<string, unknown>)[key];
			return typeof value === "string" ? value : "";
		});
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
	void getListingServices; // owl: models.list 已改为只读 models.json，保留 getter 备后续声明式扩展

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
					...desktopAgentPromptOptions(appendSystemPrompt),
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
				customTools: [
					...(await getMcpTools()),
					...iab.tools(sessionId),
					...(await sidebarOpenToolFor(agentDir, runtimeOptions.cwd)),
					...createNewsTools(newsRequest, sessionId, broadcast),
					...createMapTools(maps, sessionId, broadcast),
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
		const mailContext = getMailAgentContext(sessionManager);
		const researchMode = getResearchMode(sessionManager);
		const messages: unknown[] = [];
		const messageEntryIds: (string | undefined)[] = [];
		for (const entry of projection.entries) {
			for (const message of entry.messages) {
				messages.push(message);
				messageEntryIds.push(entry.sourceEntry.id);
			}
		}
		return {
			sessionId,
			cwd: sessionManager.getCwd(),
			messages,
			messageEntryIds,
			thinkingLevel: projection.thinkingLevel,
			header: sessionManager.getHeader(),
			name: sessionManager.getSessionName(),
			...(mailContext ? { mailContext } : {}),
			...(researchMode ? { researchMode, approvalMode: getResearchApprovalMode(sessionManager) } : {}),
		};
	}

	function replayResearchRequests(ws: WebSocket, sessionId: string, sessionManager: SessionManager): void {
		if (!getResearchMode(sessionManager) || ws.readyState !== ws.OPEN) return;
		for (const pending of pendingPermissions.values()) {
			if (pending.sessionId === sessionId) ws.send(JSON.stringify(pending.message));
		}
		for (const request of getPendingQuestionRequests(sessionId)) ws.send(JSON.stringify(request));
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
			approvalMode: ApprovalMode;
		},
	): Promise<void> {
		const { sessionManager } = args;
		const mailContext = getMailAgentContext(sessionManager);
		const researchMode = getResearchMode(sessionManager);
		if (mailContext && researchMode) throw new Error("邮箱会话不能同时作为研究会话");
		const sessionIdHolder: { current: string } = { current: sessionManager.getSessionId() };
		// 审批模式挂 holder：session.setApprovalMode 可在会话中途改写，扩展每次 tool_call 现读现判。
		const approvalModeHolder: { current: ApprovalMode } = { current: args.approvalMode };
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
					const approved = await new Promise<boolean>((resolve) => {
						pendingPermissions.set(requestId, {
							sessionId: sessionIdHolder.current,
							message,
							resolve,
						});
						broadcast(message);
					});
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
						"仅在用户本轮明确要求更新长期用户印象时，把偏好、习惯、背景或沟通风格合并写入 Owl 的「用户印象」档案。" +
						"参数传更新后的完整印象文本（保留仍有效的旧内容，不要清空）。不要把待办、功能需求或目标效果写成已完成的事实。",
					promptSnippet: "update_user_impression: 按用户本轮明确要求更新长期用户印象",
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
		const owlAddenda = mailContext ? [] : await loadOwlAddenda();
		if (approvalModeHolder.current === "plan") owlAddenda.push(PLAN_MODE_ADDENDUM);
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
						[...builtInExtensions, permissionExtension, owlMemoryExtension],
						owlAddenda,
					),
			{ cwd: sessionManager.getCwd(), agentDir: args.agentDir, sessionManager },
		);
		const sessionId = runtime.session.sessionManager.getSessionId();
		sessionIdHolder.current = sessionId;
		const unsubscribe = runtime.session.subscribe((event) => {
			broadcast({ type: "event", sessionId, event: toJsonEvent(event) });
		});
		sessions.set(sessionId, { runtime, unsubscribe, approvalMode: approvalModeHolder });
		reply(ws, requestId, {
			ok: true,
			result: { ...sessionSnapshot(sessionId, sessionManager), ...(mailContext ? { context: mailContext } : {}) },
		});
		replayResearchRequests(ws, sessionId, sessionManager);
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
			approvalMode: request.approvalMode ?? (researchMode ? "confirm" : "auto"),
		});
	}

	async function resumeSession(ws: WebSocket, request: SessionResumeRequest): Promise<void> {
		// 幂等：已挂载的会话直接回快照（重复点击安全）；顺带同步请求里带的审批模式
		const existing = sessions.get(request.sessionId);
		if (existing) {
			const sessionManager = existing.runtime.session.sessionManager;
			// Selecting research history must not apply the ordinary chat's preferences.
			if (request.approvalMode && !getResearchMode(sessionManager))
				existing.approvalMode.current = request.approvalMode;
			reply(ws, request.id, {
				ok: true,
				result: sessionSnapshot(request.sessionId, sessionManager),
			});
			replayResearchRequests(ws, request.sessionId, sessionManager);
			return;
		}
		// 定位历史文件：listAll 返回的 SessionInfo 带 path 与原 cwd
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
				approvalMode: researchMode ? getResearchApprovalMode(sessionManager) : (request.approvalMode ?? "auto"),
			});
		} catch (error) {
			reply(ws, request.id, {
				ok: false,
				error: `无法恢复会话：${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	async function handleRequest(ws: WebSocket, request: DesktopClientRequest): Promise<void> {
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
			case "ping": {
				reply(ws, request.id, { ok: true, result: "pong" });
				return;
			}
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
				reply(ws, request.id, { ok: true });
				try {
					await session.runtime.session.prompt(request.message, {
						...(request.images ? { images: request.images as ImageContent[] } : {}),
					});
				} catch (error) {
					onDiagnostic(error instanceof Error ? error.message : String(error));
				}
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
			case "session.abort": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				await session.runtime.session.abort();
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
				if (getResearchMode(session.runtime.session.sessionManager)) {
					session.runtime.session.sessionManager.appendCustomEntry(RESEARCH_APPROVAL_ENTRY, {
						mode: request.approvalMode,
					});
				}
				reply(ws, request.id, { ok: true, result: { approvalMode: request.approvalMode } });
				return;
			}
			case "session.stats": {
				const session = sessions.get(request.sessionId);
				if (!session) {
					reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
					return;
				}
				reply(ws, request.id, { ok: true, result: sessionStateSnapshot(session.runtime.session) });
				return;
			}
			// 「上下文洞察」由插件 owl-context 经 context-insight 注册表供数：
			// 按 sessionId 或（缺省）按 cwd 取最近活跃会话。注册表只在插件现采后
			// 才有数据，恢复历史会话时是空的——这时从会话转录重建一份（带
			// reconstructed 标记），让「上下文」页不至于一直空着。
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
			// -- 会话回退（owl-rewind） --------------------------------------------------
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
			// -- 改动审批（owl-diff-approval）------------------------------------------
			// 按 cwd 定位工作区存储（与 fs.*/git.* 同口径），不依赖会话挂载；
			// 插件侧捕获也经同一注册表实例写，broadcast 由注册表的 onChanged 触发。
			case "diffApproval.list": {
				try {
					const store = getWorkspaceDiffApprovalStore(defaultAgentDir(), request.cwd);
					const files = store.list(request.cwd);
					reply(ws, request.id, { ok: true, result: { files } satisfies DiffApprovalListResult });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			case "diffApproval.diff": {
				try {
					const store = getWorkspaceDiffApprovalStore(defaultAgentDir(), request.cwd);
					const result: DiffApprovalDiffResult = store.diff(request.entryId);
					reply(ws, request.id, { ok: true, result });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			case "diffApproval.resolve": {
				try {
					const store = getWorkspaceDiffApprovalStore(defaultAgentDir(), request.cwd);
					const result: DiffApprovalResolveResult = store.resolve(request.entryIds, request.action);
					reply(ws, request.id, { ok: true, result });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			case "diffApproval.clear": {
				try {
					const store = getWorkspaceDiffApprovalStore(defaultAgentDir(), request.cwd);
					const result: DiffApprovalClearResult = { removed: store.clearResolved() };
					reply(ws, request.id, { ok: true, result });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			case "commands.list": {
				reply(ws, request.id, { ok: true, result: await listSlashCommands(request.cwd) });
				return;
			}
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
				if (existing.runtime.session.isStreaming) {
					reply(ws, request.id, { ok: false, error: "会话正在运行，等回答完成后再分支" });
					return;
				}
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
				// 分支命名：fork<N> · 来自「<源会话全名>」。N 取同源分支现有序号的最大值 +1
				//（删过中间分支也不会撞号）；源会话全名 = 它的显示名，没有则用首条用户消息。
				const sourceRows = await SessionManager.listAll(sourceManager.getSessionDir());
				const sourcePath = resolve(sourceFile);
				const siblings = sourceRows.filter(
					(row) => row.parentSessionPath && resolve(row.parentSessionPath) === sourcePath,
				);
				let lastForkNumber = 0;
				for (const sibling of siblings) {
					const match = /^fork(\d+) · /.exec(sibling.name ?? "");
					if (match) lastForkNumber = Math.max(lastForkNumber, Number(match[1]));
				}
				const parent = sourceRows.find((row) => resolve(row.path) === sourcePath);
				const parentTitle =
					(parent?.name ?? parent?.firstMessage ?? "").trim().replace(/\s+/g, " ").slice(0, 80) || "原会话";
				branched.appendSessionInfo(`fork${lastForkNumber + 1} · 来自「${parentTitle}」`);
				await unmountSessionRuntime(request.sessionId);
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
				const found = await SessionManager.listAll(request.sessionDir);
				// 附带归档标记：sidebar 据此把会话放进「归档」分组
				const meta = readArchiveMeta(defaultAgentDir());
				reply(ws, request.id, {
					ok: true,
					result: found
						.map((row) => {
							const scope = row.customTypes?.includes(RESEARCH_MODE_ENTRY) ? "research" : "chat";
							const archived = meta.sessions?.[row.id];
							return { ...row, scope, ...(archived ? { archivedAt: archived.archivedAt } : {}) };
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
			case "project.create": {
				// 新建/打开项目目录：mkdir -p 后返回规范绝对路径，前端拿它当 session.create 的 cwd。
				const raw = request.path?.trim();
				if (!raw || !isAbsolute(expandTildePath(raw))) {
					reply(ws, request.id, {
						ok: false,
						error: "需要绝对路径，例如 D:\\mycode\\new-project（支持 ~ 前缀）",
					});
					return;
				}
				try {
					const path = resolve(expandTildePath(raw));
					mkdirSync(path, { recursive: true });
					reply(ws, request.id, { ok: true, result: { path } });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: `无法创建目录：${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return;
			}
			case "models.list": {
				// owl 模型来源 = models.json 声明（自定义接入） ∪ 有凭据的内置供应商（登录/API Key 激活）。
				// 内置目录本身不再直接暴露：只有用户主动配置过凭据的供应商才会带出目录模型。
				const agentDir = defaultAgentDir();
				const declared = declaredProviderModels(readModelsFile(agentDir));
				const credentialed: ProviderModelsMessage[] = [];
				try {
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
								...(model.reasoning ? { reasoning: model.reasoning } : {}),
							});
						}
					}
					credentialed.push(...byProvider.values());
				} catch {
					// services 不可用时跳过凭据部分
				}
				const declaredIds = new Set(declared.map((group) => group.id));
				reply(ws, request.id, {
					ok: true,
					result: [...declared, ...credentialed.filter((group) => !declaredIds.has(group.id))],
				});
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
				reply(ws, request.id, { ok: true, result: declaredProviderModels(readModelsFile(agentDir)) });
				return;
			}
			case "models.putModel": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				const provider = models.providers?.[request.providerKey];
				if (!provider) {
					reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
					return;
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
				const rest = (provider.models ?? []).filter((m) => m.id !== entry.id);
				provider.models = [...rest, entry];
				writeModelsFile(agentDir, models);
				reply(ws, request.id, { ok: true, result: declaredProviderModels(readModelsFile(agentDir)) });
				return;
			}
			case "models.removeModel": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				const provider = models.providers?.[request.providerKey];
				if (!provider) {
					reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
					return;
				}
				provider.models = (provider.models ?? []).filter((m) => m.id !== request.modelId);
				writeModelsFile(agentDir, models);
				reply(ws, request.id, { ok: true, result: declaredProviderModels(readModelsFile(agentDir)) });
				return;
			}
			case "models.removeProvider": {
				const agentDir = defaultAgentDir();
				const models = readModelsFile(agentDir);
				if (!models.providers?.[request.providerKey]) {
					reply(ws, request.id, { ok: false, error: `未知供应商：${request.providerKey}` });
					return;
				}
				delete models.providers[request.providerKey];
				writeModelsFile(agentDir, models);
				reply(ws, request.id, { ok: true, result: declaredProviderModels(readModelsFile(agentDir)) });
				return;
			}
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
					await services.modelRuntime.login(request.provider, request.authType, {
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
			case "permission.response": {
				const pending = pendingPermissions.get(request.requestId);
				if (!pending) {
					reply(ws, request.id, { ok: false, error: `Unknown permission request: ${request.requestId}` });
					return;
				}
				pendingPermissions.delete(request.requestId);
				pending.resolve(request.approved);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "question.response": {
				const resolved = resolveQuestion(request.requestId, {
					cancelled: request.cancelled === true,
					answers: request.answers ?? [],
				});
				if (!resolved) {
					reply(ws, request.id, { ok: false, error: `Unknown question request: ${request.requestId}` });
					return;
				}
				reply(ws, request.id, { ok: true });
				return;
			}
			case "fs.tree": {
				reply(ws, request.id, { ok: true, result: await listWorkspaceDirectory(request.cwd, request.path ?? "") });
				return;
			}
			case "viewer.list": {
				reply(ws, request.id, { ok: true, result: { viewers: listWorkspaceViewers() } });
				return;
			}
			case "viewer.open": {
				const controller = new AbortController();
				const pending = viewerRequests.get(ws) ?? new Set<AbortController>();
				viewerRequests.set(ws, pending);
				pending.add(controller);
				try {
					const result = await openWorkspaceViewer(request.viewerId, {
						cwd: request.cwd,
						path: request.path,
						signal: controller.signal,
					});
					reply(ws, request.id, { ok: true, result });
				} finally {
					pending.delete(controller);
				}
				return;
			}
			case "fs.read": {
				reply(ws, request.id, { ok: true, result: await readWorkspaceFile(request.cwd, request.path) });
				return;
			}
			case "fs.readBin": {
				reply(ws, request.id, { ok: true, result: await readWorkspaceFileBinary(request.cwd, request.path) });
				return;
			}
			case "fs.write": {
				reply(ws, request.id, {
					ok: true,
					result: await writeWorkspaceFile(request.cwd, request.path, request.content),
				});
				return;
			}
			case "fs.mkdir": {
				reply(ws, request.id, {
					ok: true,
					result: await mkdirWorkspaceEntry(request.cwd, request.path, request.name),
				});
				return;
			}
			case "fs.rename": {
				reply(ws, request.id, {
					ok: true,
					result: await renameWorkspaceEntry(request.cwd, request.path, request.name),
				});
				return;
			}
			case "fs.remove": {
				reply(ws, request.id, { ok: true, result: await removeWorkspaceEntry(request.cwd, request.path) });
				return;
			}
			case "fs.search": {
				reply(ws, request.id, { ok: true, result: await searchWorkspaceFiles(request.cwd, request.query) });
				return;
			}
			case "git.status": {
				reply(ws, request.id, { ok: true, result: await gitStatus(request.cwd) });
				return;
			}
			case "git.diff": {
				reply(ws, request.id, {
					ok: true,
					result: { diff: await gitDiff(request.cwd, request.path, request.staged === true) },
				});
				return;
			}
			case "git.stage": {
				await gitStage(request.cwd, request.paths);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "git.unstage": {
				await gitUnstage(request.cwd, request.paths);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "git.commit": {
				await gitCommit(request.cwd, request.message);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "git.discard": {
				await gitDiscard(request.cwd, request.path);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "git.log": {
				reply(ws, request.id, { ok: true, result: await gitLog(request.cwd, request.count) });
				return;
			}
			case "watch.set": {
				// watcher 集按项目归一（resolve 后的绝对路径做 key）；replace 语义
				// 由 add/remove 差分实现，避免每次展开/收起都重建全部句柄。
				const key = resolve(request.cwd);
				let watchers = sidebarWatchers.get(key);
				if (watchers === undefined) {
					watchers = createDirectoryWatchers(
						(dir) => {
							broadcast({
								type: "event",
								sessionId: "",
								event: { type: "fs_changed", cwd: key, dirs: [toWirePath(key, dir)] },
							});
						},
						(dir, error) => {
							onDiagnostic(`sidebar watch ${dir}: ${error instanceof Error ? error.message : String(error)}`);
						},
					);
					sidebarWatchers.set(key, watchers);
				}
				const wanted = new Set<string>();
				for (const relativeDir of request.dirs.slice(0, 64)) {
					await resolveUnderWorkspace(request.cwd, relativeDir)
						.then((absolute) => wanted.add(absolute))
						.catch(() => {});
				}
				for (const dir of watchers.dirs()) {
					if (!wanted.has(dir)) watchers.remove(dir);
				}
				for (const dir of wanted) {
					watchers.add(dir);
				}
				reply(ws, request.id, { ok: true });
				return;
			}
			case "open.external": {
				if (request.action === "reveal") {
					// workspace 相对路径 → 围栏解析成绝对路径，文件管理器定位。
					const base = request.cwd ?? process.cwd();
					const absolute = await resolveUnderWorkspace(base, request.target);
					if (process.platform === "darwin") {
						spawn("open", ["-R", absolute], { detached: true, stdio: "ignore" }).unref();
					} else if (process.platform === "win32") {
						spawn("explorer", [`/select,${absolute}`], { detached: true, stdio: "ignore" }).unref();
					} else {
						spawn("xdg-open", [absolute], { detached: true, stdio: "ignore" }).unref();
					}
				} else {
					// 自定义协议（vscode:// 等）白名单后交给系统处理器；argv 直传不落 shell。
					const allowed = new Set(["vscode:", "cursor:", "zed:", "file:", "http:", "https:"]);
					const parsed = new URL(request.target);
					if (!allowed.has(parsed.protocol)) {
						throw new SidebarError("bad-request", `不允许的协议：${parsed.protocol}`);
					}
					spawn("rundll32", ["url.dll,FileProtocolHandler", request.target], {
						detached: true,
						stdio: "ignore",
					}).unref();
				}
				reply(ws, request.id, { ok: true });
				return;
			}
			case "term.create": {
				// 输出定向回创建它的连接（不广播）；连接记账，断线时统一回收
				const owned = wsTerms.get(ws) ?? new Set<string>();
				wsTerms.set(ws, owned);
				const { termId, shell } = terminals.create(request.cwd, request.cols, request.rows, {
					onData: (id, data) => {
						if (ws.readyState !== ws.OPEN) return;
						const message: TermDataMessage = { type: "term.data", termId: id, data };
						ws.send(JSON.stringify(message));
					},
					onExit: (id, exitCode) => {
						owned.delete(id);
						if (ws.readyState !== ws.OPEN) return;
						const message: TermExitMessage = { type: "term.exit", termId: id, exitCode };
						ws.send(JSON.stringify(message));
					},
				});
				owned.add(termId);
				reply(ws, request.id, { ok: true, result: { termId, shell } });
				return;
			}
			case "term.input": {
				terminals.write(request.termId, request.data);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "term.resize": {
				terminals.resize(request.termId, request.cols, request.rows);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "term.kill": {
				wsTerms.get(ws)?.delete(request.termId);
				terminals.kill(request.termId);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "iab.open": {
				// 绑定/打开页面：pageId 只绑定，url 按 URL 复用或新建，双给 = 导航既有页
				try {
					const page = await iab.open({
						...(request.pageId !== undefined ? { pageId: request.pageId } : {}),
						...(request.url !== undefined ? { url: request.url } : {}),
						...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
					});
					reply(ws, request.id, { ok: true, result: { page } satisfies IabOpenResult });
				} catch (error) {
					reply(ws, request.id, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			case "iab.nav": {
				try {
					await iab.nav(request.pageId, request.action);
					reply(ws, request.id, { ok: true });
				} catch (error) {
					reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case "iab.viewport": {
				try {
					await iab.setViewport(request.pageId, request.width, request.height);
					reply(ws, request.id, { ok: true });
				} catch (error) {
					reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case "iab.input": {
				try {
					await iab.input(request.pageId, request.input);
					reply(ws, request.id, { ok: true });
				} catch (error) {
					reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			case "iab.attach": {
				// 先记账再抓首帧：保证首帧一定送到这条连接（screencast 只推增量）
				const owned = iabSubscriptions.get(ws) ?? new Set<string>();
				owned.add(request.pageId);
				iabSubscriptions.set(ws, owned);
				await iab.captureFrame(request.pageId);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "iab.detach": {
				iabSubscriptions.get(ws)?.delete(request.pageId);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "iab.close": {
				await iab.closePage(request.pageId);
				reply(ws, request.id, { ok: true });
				return;
			}
			case "iab.state": {
				reply(ws, request.id, { ok: true, result: { pages: iab.listPages() } satisfies IabStateResult });
				return;
			}
			case "iab.fileResponse": {
				try {
					await iab.fileResponse(request.pageId, request.paths);
					reply(ws, request.id, { ok: true });
				} catch (error) {
					reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			default: {
				// 不认识的请求必须回错误：否则 UI 的 promise 永远挂起（典型场景 = 桥是旧进程、
				// UI 已是新版），界面上表现为"点了没反应"。switch 已穷尽已知类型，这里必是 never。
				const unmatched = request as { id?: string; type?: string };
				reply(ws, unmatched.id ?? "?", {
					ok: false,
					error: `未知请求类型：${String(unmatched.type)}（UI 与桥版本不匹配，请重启应用）`,
				});
				return;
			}
		}
	}

	const uiRoot = resolveUiRoot();
	const httpServer = createServer((request, response) => {
		void handleMapHttp(request, response, {
			service: maps,
			authorizeOrigin: (origin) => isTrustedDesktopOrigin(origin, options.host),
		})
			.then(
				(handled) =>
					handled ||
					handleNewsHttp(request, response, {
						handle: newsRequest,
						authorizeIngest: (token) => getNewsService().authorizeIngest(token),
						shutdown: closeNews,
					}),
			)
			.then(
				(handled) =>
					handled ||
					handleWallpaperHttp(request, response, {
						authorizeOrigin: (origin) => isTrustedDesktopOrigin(origin, options.host),
						getCustomDir: () => owlWallpaperField("customDir"),
						getCustomPath: () => owlWallpaperField("customPath"),
					}),
			)
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
			for (const controller of viewerRequests.get(ws) ?? []) controller.abort();
			viewerRequests.delete(ws);
			// 连接断开：回收它名下的终端（UI 关闭时也会主动 kill，这里是兜底）
			const owned = wsTerms.get(ws);
			if (owned) {
				for (const termId of owned) terminals.kill(termId);
				wsTerms.delete(ws);
			}
			iabSubscriptions.delete(ws);
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
			closingMail = true;
			// 桥关闭：挂起的提问全部按取消处理，并摘除提问通道（插件随后会在
			// 每轮 reconcile 时把工具摘掉）
			cancelAllPendingQuestions();
			await Promise.all([...sessions.keys()].map(unmountSessionRuntime));
			await mail?.dispose();
			setQuestionChannel(undefined);
			setDiffApprovalBroadcaster(undefined);
			for (const watchers of sidebarWatchers.values()) watchers.close();
			sidebarWatchers.clear();
			terminals.killAll();
			await iab.dispose();
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
