/**
 * owl desktop wire protocol — shared between the bridge (serve.ts) and the
 * desktop UI. Types only: import from the UI with `import type` so nothing
 * server-side leaks into the browser bundle.
 */

export interface SessionCreateRequest {
	type: "session.create";
	id: string;
	cwd?: string;
	provider?: string;
	model?: string;
	agentDir?: string;
	/** "confirm" routes tool calls to the UI as permission_request messages; default "auto". */
	approvalMode?: "auto" | "confirm";
	/** 初始思考强度（ThinkingLevel，服务端按模型能力收敛）。 */
	thinkingLevel?: string;
}

export interface SessionPromptRequest {
	type: "session.prompt";
	id: string;
	sessionId: string;
	message: string;
	images?: unknown[];
}

export interface SessionAbortRequest {
	type: "session.abort";
	id: string;
	sessionId: string;
}

/** 删除历史会话：卸载运行时（若已挂载）并删掉 Owl-history 里的 JSONL 文件。 */
export interface SessionDeleteRequest {
	type: "session.delete";
	id: string;
	sessionId: string;
}

/** 归档历史会话：归档状态由桥端持久化（Owl-history/archive.json），不写进会话文件。 */
export interface SessionArchiveRequest {
	type: "session.archive";
	id: string;
	sessionId: string;
}

/** 取消归档。 */
export interface SessionUnarchiveRequest {
	type: "session.unarchive";
	id: string;
	sessionId: string;
}

/**
 * 读取/修改归档自动清理配置。带 retentionDays = 设置（并立即巡检一次），
 * 缺省 = 仅读取。归档超过保留期的会话由桥端定时任务自动删除。
 */
export interface SessionArchiveConfigRequest {
	type: "session.archiveConfig";
	id: string;
	retentionDays?: number;
}

export interface SessionArchiveEntry {
	sessionId: string;
	archivedAt: string;
}

export interface SessionArchiveConfigResult {
	retentionDays: number;
	sessions: SessionArchiveEntry[];
}

/**
 * 恢复历史会话：定位 Owl-history 里的 JSONL、以续聊方式挂载运行时，
 * 响应带消息快照（rebuild 用）与会话 cwd（前端切项目视图用）。
 * 已挂载的会话幂等返回快照；后续 session.prompt 直接续聊。
 */
export interface SessionResumeRequest {
	type: "session.resume";
	id: string;
	sessionId: string;
	provider?: string;
	model?: string;
	approvalMode?: "auto" | "confirm";
	thinkingLevel?: string;
}

export interface SessionListRequest {
	type: "session.list";
	id: string;
	sessionDir?: string;
}

/** 查询当前 agent run 活跃的已挂载会话 id：UI 刷新后据此恢复侧边栏的运行状态点。 */
export interface SessionRunningRequest {
	type: "session.running";
	id: string;
}

export interface SessionRunningResult {
	running: string[];
}

/** 会话进行中切换模型（对应 AgentSession.setModel，含鉴权检查与思考级别自适应）。 */
export interface SessionSetModelRequest {
	type: "session.setModel";
	id: string;
	sessionId: string;
	provider: string;
	model: string;
}

/** 会话进行中调整思考强度（对应 AgentSession.setThinkingLevel）。 */
export interface SessionSetThinkingLevelRequest {
	type: "session.setThinkingLevel";
	id: string;
	sessionId: string;
	level: string;
}

/** 查询会话当前状态：模型、思考强度、上下文用量、累计统计。 */
export interface SessionStatsRequest {
	type: "session.stats";
	id: string;
	sessionId: string;
}

export interface SessionStatsResult {
	model?: { provider: string; id: string; name?: string };
	thinkingLevel: string;
	availableThinkingLevels: string[];
	supportsThinking: boolean;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	stats?: {
		userMessages: number;
		assistantMessages: number;
		toolCalls: number;
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		cost: number;
	};
}

export interface ProjectCreateRequest {
	type: "project.create";
	id: string;
	/**
	 * Absolute project directory (支持 ~ 前缀). Created recursively when missing,
	 * so this doubles as "open existing project" (mkdir on an existing dir is a no-op).
	 */
	path: string;
}

export interface ProjectCreateResult {
	/** Resolved absolute path (backslashes on Windows) — use as session.create cwd. */
	path: string;
}

export interface ModelsListRequest {
	type: "models.list";
	id: string;
}

export interface SettingsGetRequest {
	type: "settings.get";
	id: string;
}

export interface ModelsPutProviderRequest {
	type: "models.putProvider";
	id: string;
	provider: {
		key: string;
		name?: string;
		baseUrl: string;
		api: string;
		apiKey?: string;
	};
}

export interface ModelsPutModelRequest {
	type: "models.putModel";
	id: string;
	providerKey: string;
	model: { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean };
}

export interface ModelsRemoveModelRequest {
	type: "models.removeModel";
	id: string;
	providerKey: string;
	modelId: string;
}

export interface ModelsRemoveProviderRequest {
	type: "models.removeProvider";
	id: string;
	providerKey: string;
}

export interface SettingsSetRequest {
	type: "settings.set";
	id: string;
	values: Record<string, unknown>;
}

export interface PingRequest {
	type: "ping";
	id: string;
}

// ---------------------------------------------------------------------------
// 侧边栏工作台（owl workbench）— fs / git / watch / open.external
//
// 路径约定：所有 path/dir 都是 workspace 相对路径（POSIX 分隔符，客户端从
// 文件树拿到什么就发什么），服务端在 `cwd` 下解析并强制围栏（realpath 规范
// 化后必须仍在 cwd 内）。cwd 是前端显式跟踪的项目目录，与 DSH 插件按
// sessionId 解析 cwd 的设计不同——owl 在未建会话时也要能浏览项目文件。
// ---------------------------------------------------------------------------

/** 文件树一行（资源管理器行语义：目录优先排序在服务端做，行本身只带事实）。 */
export interface FsEntry {
	/** 基名。 */
	name: string;
	/** workspace 相对路径（POSIX 分隔符，目录行不带尾斜杠）。 */
	path: string;
	isDir: boolean;
	/** POSIX 隐藏项（`.` 开头），前端置灰。 */
	hidden: boolean;
	/** 该行是软链接；isDir 描述的是链接目标的类型。 */
	isSymlink: boolean;
	/** 软链接目标缺失或不可读（stat 失败）。 */
	broken: boolean;
}

/** 一层目录列表。truncated 表示超出单层行数上限。 */
export interface FsListing {
	path: string;
	entries: FsEntry[];
	truncated: boolean;
}

/** 文本/二进制通吃的读取结果。二进制只回 4KB base64 头（嗅探用）。 */
export interface FsReadResult {
	kind: "text" | "binary";
	content: string;
	truncated: boolean;
	size: number;
	/** 二进制时的 base64 头（≤4096 字节）。 */
	head?: string;
}

/** 图片等媒体预览的整文件读取（base64，受 mediaLimit 限制）。 */
export interface FsReadBinResult {
	base64: string;
	size: number;
	truncated: boolean;
	mediaType: string;
}

/** git status 一行：X=暂存区状态，Y=工作树状态（porcelain 字母，见 git-status(1)）。 */
export interface GitStatusEntry {
	path: string;
	x: string;
	y: string;
	/** 重命名/复制时的新旧名（旧名仅提示用）。 */
	origPath?: string;
}

export interface GitStatusResult {
	branch?: string;
	upstream?: string;
	entries: GitStatusEntry[];
	/** cwd 不是 git 仓库时为 false，entries 为空（前端显示"非 Git 仓库"空态）。 */
	repo: boolean;
}

export interface GitLogEntry {
	hash: string;
	short: string;
	subject: string;
	author: string;
	time: number;
}

/** 全局文件名搜索的命中行。 */
export interface FsSearchHit {
	path: string;
	isDir: boolean;
}

export interface FsTreeRequest {
	type: "fs.tree";
	id: string;
	cwd: string;
	/** 相对 cwd 的目录；缺省 = cwd 本身（根层）。 */
	path?: string;
}

export interface FsReadRequest {
	type: "fs.read";
	id: string;
	cwd: string;
	path: string;
}

/** 整文件 base64 读取（图片预览用，默认 8MB 上限）。 */
export interface FsReadBinRequest {
	type: "fs.readBin";
	id: string;
	cwd: string;
	path: string;
}

export interface FsWriteRequest {
	type: "fs.write";
	id: string;
	cwd: string;
	path: string;
	content: string;
}

export interface FsMkdirRequest {
	type: "fs.mkdir";
	id: string;
	cwd: string;
	/** 父目录（workspace 相对，须已存在）。 */
	path: string;
	/** 新目录名（单段，不得已存在）。 */
	name: string;
}

export interface FsRenameRequest {
	type: "fs.rename";
	id: string;
	cwd: string;
	path: string;
	/** 新基名（单段 = 重命名而非移动）。 */
	name: string;
}

export interface FsRemoveRequest {
	type: "fs.remove";
	id: string;
	cwd: string;
	path: string;
}

/** 全局文件名搜索（服务端预算内 BFS，不设 caller 可控边界）。 */
export interface FsSearchRequest {
	type: "fs.search";
	id: string;
	cwd: string;
	query: string;
}

export interface GitStatusRequest {
	type: "git.status";
	id: string;
	cwd: string;
}

export interface GitDiffRequest {
	type: "git.diff";
	id: string;
	cwd: string;
	/** 缺省 = 整个仓库的 diff。 */
	path?: string;
	staged?: boolean;
}

export interface GitStageRequest {
	type: "git.stage";
	id: string;
	cwd: string;
	paths: string[];
}

export interface GitUnstageRequest {
	type: "git.unstage";
	id: string;
	cwd: string;
	paths: string[];
}

export interface GitCommitRequest {
	type: "git.commit";
	id: string;
	cwd: string;
	message: string;
}

export interface GitDiscardRequest {
	type: "git.discard";
	id: string;
	cwd: string;
	path: string;
}

export interface GitLogRequest {
	type: "git.log";
	id: string;
	cwd: string;
	count?: number;
}

/**
 * 替换某项目当前被 watch 的目录集（replace 语义：服务端按需增删 watcher）。
 * 客户端在展开/收起目录后发全集；变更通过 fs_changed 事件广播。
 */
export interface WatchSetRequest {
	type: "watch.set";
	id: string;
	cwd: string;
	/** workspace 相对目录（POSIX 分隔符）。 */
	dirs: string[];
}

/** 在系统里打开一个路径（资源管理器定位）或自定义协议 URL（vscode:// 等）。 */
export interface OpenExternalRequest {
	type: "open.external";
	id: string;
	action: "reveal" | "url";
	/** reveal = workspace 相对路径；url = 完整自定义协议 URL。 */
	target: string;
	cwd?: string;
}

/** 服务端广播：被 watch 的目录内容变了（客户端按 cwd 过滤、增量重列）。 */
export interface FsChangedEvent {
	type: "fs_changed";
	cwd: string;
	/** 发生变更的目录（workspace 相对，POSIX 分隔符）。 */
	dirs: string[];
}

export interface PermissionResponseRequest {
	type: "permission.response";
	id: string;
	requestId: string;
	approved: boolean;
}

export interface ProviderModelsMessage {
	id: string;
	name?: string;
	/** owl 固定为 "models_json"：模型只来自声明文件，不复用内置目录 */
	authSource?: string;
	models: ModelInfoMessage[];
}

export type DesktopClientRequest =
	| SessionCreateRequest
	| SessionPromptRequest
	| SessionAbortRequest
	| SessionDeleteRequest
	| SessionArchiveRequest
	| SessionUnarchiveRequest
	| SessionArchiveConfigRequest
	| SessionResumeRequest
	| SessionSetModelRequest
	| SessionSetThinkingLevelRequest
	| SessionStatsRequest
	| SessionListRequest
	| SessionRunningRequest
	| ProjectCreateRequest
	| ModelsListRequest
	| ModelsPutProviderRequest
	| ModelsPutModelRequest
	| ModelsRemoveModelRequest
	| ModelsRemoveProviderRequest
	| AuthProvidersRequest
	| AuthLoginRequest
	| AuthPromptRespondRequest
	| AuthCancelRequest
	| SettingsGetRequest
	| SettingsSetRequest
	| PingRequest
	| PermissionResponseRequest
	| FsTreeRequest
	| FsReadRequest
	| FsReadBinRequest
	| FsWriteRequest
	| FsMkdirRequest
	| FsRenameRequest
	| FsRemoveRequest
	| FsSearchRequest
	| GitStatusRequest
	| GitDiffRequest
	| GitStageRequest
	| GitUnstageRequest
	| GitCommitRequest
	| GitDiscardRequest
	| GitLogRequest
	| WatchSetRequest
	| OpenExternalRequest;

/** 内置厂商目录（供桌面端下拉选择，非模型列表）。 */
export interface AuthProvidersRequest {
	type: "auth.providers";
	id: string;
}

/**
 * 登录/存 key（对应 pi 的 /login）。
 * - authType "oauth"：桥会打开浏览器，进度通过 auth_notify 事件广播，长请求。
 *   GitHub Copilot 默认跳过「企业域名」提问直接用 github.com 拉起浏览器；
 *   enterprise=true 时才把该提问转发给界面（GitHub 企业版用户用）。
 * - authType "api_key"：apiKey 随请求带上，写入 auth.json。
 */
export interface AuthLoginRequest {
	type: "auth.login";
	id: string;
	provider: string;
	authType: "api_key" | "oauth";
	apiKey?: string;
	enterprise?: boolean;
}

/** 回答登录流程的提问（AuthPrompt：text/secret 填字符串，select 填 option id）。 */
export interface AuthPromptRespondRequest {
	type: "auth.prompt.respond";
	id: string;
	answer: string;
}

/** 取消进行中的登录流程。 */
export interface AuthCancelRequest {
	type: "auth.cancel";
	id: string;
}

export interface ModelInfoMessage {
	id: string;
	name: string;
	contextWindow?: number;
	reasoning?: boolean;
}

/**
 * One provider's slice of the model selector, mirroring the pi TUI ModelSelector's
 * data source: only providers with configured credentials (the runtime's available
 * snapshot), grouped and annotated with where the credentials come from.
 */
export interface ProviderModelsMessage {
	id: string;
	name?: string;
	/** pi AuthStatus.source: "stored" | "runtime" | "environment" | "models_json_key" | … */
	authSource?: string;
	models: ModelInfoMessage[];
}

export type ServerEventMessage = {
	type: "event";
	sessionId: string;
	event: unknown; // JsonAgentSessionEvent, kept loose so the UI can render forward-compat payloads
};

export type PermissionRequestMessage = {
	type: "permission_request";
	requestId: string;
	sessionId: string;
	toolName: string;
	input: unknown;
};

export type ServerResponseMessage = {
	type: "response";
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

export type DesktopServerMessage = ServerEventMessage | ServerResponseMessage | PermissionRequestMessage;

/** Omit that distributes over unions (so each request variant keeps its fields). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DesktopClientRequestWithoutId = DistributiveOmit<DesktopClientRequest, "id">;
