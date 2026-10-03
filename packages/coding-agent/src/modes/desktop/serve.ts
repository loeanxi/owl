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
import { createServer, type ServerResponse } from "node:http";
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
import { findContextInsightByCwd, getContextInsight } from "../../core/context-insight.ts";
import type { InlineExtension, ToolDefinition } from "../../core/extensions/index.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { connectMcpServers, type McpConnections } from "../../core/mcp-lite.ts";
import type { McpServerConfig } from "../../core/mcp-servers.ts";
import { loadPromptTemplates } from "../../core/prompt-templates.ts";
import {
	cancelAllPendingQuestions,
	cancelPendingQuestionsForSession,
	resolveQuestion,
	setQuestionChannel,
} from "../../core/question-channel.ts";
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
import type {
	CommandsListResult,
	IabFrameMessage,
	IabOpenResult,
	IabPageInfo,
	IabStateResult,
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
}

export interface DesktopServerHandle {
	port: number;
	close(): Promise<void>;
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
	const pendingPermissions = new Map<string, { sessionId: string; resolve: (approved: boolean) => void }>();
	/** Shared services for non-session queries (models.list); built lazily. */
	let listServices: AgentSessionServices | undefined;
	/** MCP connections established at startup. */
	let mcp: McpConnections | undefined;
	/** 侧边栏文件树 watcher：项目（resolved cwd）→ watcher 集。 */
	const sidebarWatchers = new Map<string, DirectoryWatchers>();
	/** 归档过期巡检定时器（close() 时清理）。 */
	let archiveTimer: ReturnType<typeof setInterval> | undefined;

	/** 按 id 定位历史会话的 JSONL 文件。 */
	async function findSessionFile(sessionId: string): Promise<string | undefined> {
		return (await SessionManager.listAll()).find((row) => row.id === sessionId)?.path;
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

	/** 项目是否已信任（技能中心项目 tab 的读写门槛；读不出设置就当未信任）。 */
	async function isProjectTrustedFor(cwd: string): Promise<boolean> {
		return (await getSettingsManagerFor(cwd))?.isProjectTrusted() ?? false;
	}

	/**
	 * 技能中心的写操作落盘后，让该 cwd 已挂载会话的资源加载器重扫，
	 * 下一条消息即用新目录（无挂载会话时静默跳过 —— 新会话自然生效）。
	 */
	async function reloadMountedSkillSessions(cwd: string): Promise<void> {
		const resolved = resolve(cwd).toLowerCase();
		await Promise.all(
			[...sessions.values()].map(async ({ runtime }) => {
				if (resolve(runtime.session.sessionManager.getCwd()).toLowerCase() !== resolved) return;
				try {
					await runtime.session.reload();
				} catch (error) {
					onDiagnostic(error instanceof Error ? error.message : String(error));
				}
			}),
		);
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
			const services = await createAgentSessionServices({
				cwd: runtimeOptions.cwd,
				agentDir,
				resourceLoaderOptions: {
					extensionFactories,
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
				],
				...(model ? { model } : {}),
				...(modelSpec?.thinkingLevel ? { thinkingLevel: modelSpec.thinkingLevel as ThinkingLevel } : {}),
			});
			return { ...session, services, diagnostics: services.diagnostics };
		};
	}

	/** 会话快照：恢复/创建时回给前端回放用（消息来自事件流投影，续聊上下文同源）。 */
	function sessionSnapshot(
		sessionId: string,
		sessionManager: SessionManager,
	): { sessionId: string; cwd: string; messages: unknown[]; thinkingLevel?: unknown; header: unknown } {
		const projection = sessionManager.buildSessionProjection();
		return {
			sessionId,
			cwd: sessionManager.getCwd(),
			messages: projection.messages,
			thinkingLevel: projection.thinkingLevel,
			header: sessionManager.getHeader(),
		};
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
						"以上是当前记录的「对用户的印象」。当互动中了解到值得长期记住的新信息（偏好、习惯、背景等）时，用 update_user_impression 工具保存更新后的完整印象；没有值得记住的新信息就不要调用。",
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
					const approved = await new Promise<boolean>((resolve) => {
						pendingPermissions.set(requestId, {
							sessionId: sessionIdHolder.current,
							resolve,
						});
						broadcast({
							type: "permission_request",
							requestId,
							sessionId: sessionIdHolder.current,
							toolName: event.toolName,
							input: event.input,
						});
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
						"把对用户的长期印象（偏好、习惯、背景、沟通风格等）合并写入 Owl 的「用户印象」档案。" +
						"参数传更新后的完整印象文本（保留仍有效的旧内容，不要清空）。只在了解到值得长期记住的新信息时调用。",
					promptSnippet: "update_user_impression: 把对用户的长期印象保存到 Owl 的「用户印象」档案",
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
		const owlAddenda = await loadOwlAddenda();
		if (approvalModeHolder.current === "plan") owlAddenda.push(PLAN_MODE_ADDENDUM);
		const runtime = await createAgentSessionRuntime(
			buildFactory(
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
		reply(ws, requestId, { ok: true, result: sessionSnapshot(sessionId, sessionManager) });
	}

	async function createSession(ws: WebSocket, request: SessionCreateRequest): Promise<void> {
		const sessionManager = SessionManager.create(request.cwd ?? options.cwd ?? process.cwd());
		await mountSession(ws, request.id, {
			sessionManager,
			agentDir: request.agentDir ?? defaultAgentDir(),
			provider: request.provider,
			model: request.model,
			thinkingLevel: request.thinkingLevel,
			approvalMode: request.approvalMode ?? "auto",
		});
	}

	async function resumeSession(ws: WebSocket, request: SessionResumeRequest): Promise<void> {
		// 幂等：已挂载的会话直接回快照（重复点击安全）；顺带同步请求里带的审批模式
		const existing = sessions.get(request.sessionId);
		if (existing) {
			if (request.approvalMode) existing.approvalMode.current = request.approvalMode;
			const sessionManager = existing.runtime.session.sessionManager;
			reply(ws, request.id, {
				ok: true,
				result: sessionSnapshot(request.sessionId, sessionManager),
			});
			return;
		}
		// 定位历史文件：listAll 返回的 SessionInfo 带 path 与原 cwd
		const found = (await SessionManager.listAll()).find((row) => row.id === request.sessionId);
		if (!found?.path || !existsSync(found.path)) {
			reply(ws, request.id, { ok: false, error: `Unknown session: ${request.sessionId}` });
			return;
		}
		try {
			// open() 自行读会话头恢复 cwd（找不到头时回落 process.cwd，与 TUI 行为一致）
			const sessionManager = SessionManager.open(found.path);
			await mountSession(ws, request.id, {
				sessionManager,
				agentDir: defaultAgentDir(),
				provider: request.provider,
				model: request.model,
				thinkingLevel: request.thinkingLevel,
				approvalMode: request.approvalMode ?? "auto",
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
			// 按 sessionId 或（缺省）按 cwd 取最近活跃会话；无数据也照常回空
			case "context.get": {
				const sessionId = request.sessionId ?? findContextInsightByCwd(request.cwd)?.sessionId;
				const state = sessionId ? getContextInsight(sessionId) : undefined;
				reply(ws, request.id, {
					ok: true,
					result: {
						sessionId,
						requests: state ? [...state.requests] : [],
						events: state ? [...state.events] : [],
						tools: state ? [...state.tools] : [],
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
			case "commands.list": {
				reply(ws, request.id, { ok: true, result: await listSlashCommands(request.cwd) });
				return;
			}
			case "skills.list": {
				const cwd = request.cwd ?? options.cwd ?? process.cwd();
				const projectSettings = await getSettingsManagerFor(cwd);
				reply(ws, request.id, {
					ok: true,
					result: listSkills(
						cwd,
						projectSettings?.isProjectTrusted() ?? false,
						options.agentDir,
						projectSettings?.getProjectSettings().skills ?? [],
					),
				});
				return;
			}
			case "skills.setProjectSelection": {
				// 勾选本项目需要的技能（opt-out）→ 项目 settings.json 的 skills 覆盖模式
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
			case "session.list": {
				const found = await SessionManager.listAll(request.sessionDir);
				// 附带归档标记：sidebar 据此把会话放进「归档」分组
				const meta = readArchiveMeta(defaultAgentDir());
				reply(ws, request.id, {
					ok: true,
					result: found.map((row) => {
						const archived = meta.sessions?.[row.id];
						return archived ? { ...row, archivedAt: archived.archivedAt } : row;
					}),
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
			case "settings.set": {
				const agentDir = defaultAgentDir();
				const settingsManager: SettingsManager = await import("../../core/settings-manager.ts").then((m) =>
					m.SettingsManager.create(options.cwd ?? process.cwd(), agentDir),
				);
				const settings = settingsManager.applyGlobalOverridesAndSave(request.values as never);
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
		if (!uiRoot) {
			response.writeHead(426).end("owl desktop bridge: WebSocket only");
			return;
		}
		serveUi(uiRoot, request.url ?? "/", response, request.method === "HEAD");
	});
	const wss = new WebSocketServer({ server: httpServer });
	wss.on("connection", (ws) => {
		clients.add(ws);
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
	const unsubscribeViewers = subscribeWorkspaceViewers((viewers) => broadcast({ type: "viewer.changed", viewers }));

	return {
		port,
		async close() {
			unsubscribeViewers();
			if (archiveTimer) clearInterval(archiveTimer);
			// 桥关闭：挂起的提问全部按取消处理，并摘除提问通道（插件随后会在
			// 每轮 reconcile 时把工具摘掉）
			cancelAllPendingQuestions();
			await Promise.all([...sessions.keys()].map(unmountSessionRuntime));
			setQuestionChannel(undefined);
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
	});
}

export type { JsonAgentSessionEvent };
