/**
 * owl desktop wire protocol — shared between the bridge (serve.ts) and the
 * desktop UI. Types only: import from the UI with `import type` so nothing
 * server-side leaks into the browser bundle.
 */

/**
 * 工具审批模式：
 * - "confirm"（标准）：每次工具调用都经 permission_request 送 UI 确认；
 * - "plan"（计划）：只放行只读工具（read/ls/find/grep），写类调用直接拦截，供调研与制定计划；
 * - "auto"（自动）：全部放行，不再询问。
 * 缺省为 "auto"（桥端独用/脚本场景的旧行为）。
 */
export type ApprovalMode = "auto" | "confirm" | "plan";

export interface SessionCreateRequest {
	type: "session.create";
	id: string;
	cwd?: string;
	provider?: string;
	model?: string;
	agentDir?: string;
	approvalMode?: ApprovalMode;
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
	approvalMode?: ApprovalMode;
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

/** 会话进行中切换审批模式（标准/计划/自动），下次工具调用即生效。 */
export interface SessionSetApprovalModeRequest {
	type: "session.setApprovalMode";
	id: string;
	sessionId: string;
	approvalMode: ApprovalMode;
}

/** 会话进行中手动压缩上下文（对应 AgentSession.compact，事件照常走事件流）。 */
export interface SessionCompactRequest {
	type: "session.compact";
	id: string;
	sessionId: string;
}

/** 斜杠命令一览的一行（commands.list 返回，UI 输入框 "/" 自动补全用）。 */
export interface SlashCommandEntry {
	/** 触发名（不含前导斜杠）：内置命令名 / 模板名 / 扩展命令名 / skill:<name>。 */
	name: string;
	description?: string;
	/** 来源分类：内置（UI 本地执行）/ skill / 提示词模板 / 扩展命令。 */
	kind: "builtin" | "skill" | "prompt" | "extension";
	/** 参数提示（如 <provider/model>），仅展示用。 */
	argumentHint?: string;
}

/**
 * 列出当前项目可用的斜杠命令：桌面内置命令 +（已挂载会话的）扩展命令、
 * 提示词模板与技能。未挂载会话时按 cwd 轻量扫描技能与模板（缺扩展命令）。
 */
export interface CommandsListRequest {
	type: "commands.list";
	id: string;
	/** 项目目录；缺省用桥的默认 cwd。 */
	cwd?: string;
}

export interface CommandsListResult {
	commands: SlashCommandEntry[];
}

// ---------------------------------------------------------------------------
// 技能中心（skills.*）：设置页技能面板的三级浏览与 CRUD。
// 目录统一为 .owl：个人 = ~/.owl/agent/skills，全局 = ~/.owl/skills，
// 项目 = <cwd>/.owl/skills。写操作由桥端 skills-center 模块执行。
// ---------------------------------------------------------------------------

/** 技能中心的来源分级（一个 tab 一个根目录）。 */
export type SkillCenterTab = "personal" | "global" | "project";

/** 技能列表的一行：元数据 only，正文走 skills.read。 */
export interface SkillCenterEntry {
	name: string;
	description: string;
	/** SKILL.md 绝对路径（写操作的身份凭据，需与最新扫描一致）。 */
	path: string;
	/** 技能目录（单文件技能 = 所在目录）。 */
	dir: string;
	tab: SkillCenterTab;
	/** true = disable-model-invocation，模型不自动调用（/skill: 手动仍可用）。 */
	disabled: boolean;
	/** SKILL.md 是符号链接：可列表/启停，禁止编辑与删除。 */
	isSymlink: boolean;
}

/** 三个 tab 的根目录（绝对路径，UI 展示用）。 */
export interface SkillCenterRoots {
	personal: string;
	global: string;
	project: string;
}

export interface SkillsListRequest {
	type: "skills.list";
	id: string;
	/** 项目目录；缺省用桥的默认 cwd（决定项目 tab 的根）。 */
	cwd?: string;
}

export interface SkillsListResult {
	roots: SkillCenterRoots;
	skills: SkillCenterEntry[];
	/** 当前项目是否已信任（未信任时项目 tab 只读并提示）。 */
	projectTrusted: boolean;
}

export interface SkillsReadRequest {
	type: "skills.read";
	id: string;
	name: string;
	/** 必须与最新扫描解析到的路径完全一致（防过期同名回退）。 */
	path: string;
	tab: SkillCenterTab;
	cwd?: string;
}

export interface SkillsReadResult {
	name: string;
	description: string;
	/** frontmatter 之后的正文。 */
	body: string;
	disabled: boolean;
	isSymlink: boolean;
}

export interface SkillsSetEnabledRequest {
	type: "skills.setEnabled";
	id: string;
	name: string;
	path: string;
	tab: SkillCenterTab;
	/** true = 启用模型调用；false = 写入 disable-model-invocation: true。 */
	enabled: boolean;
	cwd?: string;
}

export interface SkillsCreateRequest {
	type: "skills.create";
	id: string;
	/** 新技能写入哪个根：个人 / 全局 / 项目（项目根需已信任）。 */
	tab: SkillCenterTab;
	/** 技能名（目录名 + frontmatter name），按 Agent Skills 规范校验。 */
	name: string;
	description: string;
	body: string;
	cwd?: string;
}

export interface SkillsUpdateRequest {
	type: "skills.update";
	id: string;
	name: string;
	path: string;
	tab: SkillCenterTab;
	description: string;
	body: string;
	cwd?: string;
}

export interface SkillsDeleteRequest {
	type: "skills.delete";
	id: string;
	name: string;
	path: string;
	tab: SkillCenterTab;
	cwd?: string;
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

/** 内置系统提示词预览：按默认工具集现组各分区，设置页「提示词」只读展示（不含用户自定义部分）。 */
export interface SystemPromptPreviewRequest {
	type: "systemPrompt.preview";
	id: string;
}

export interface SystemPromptPreviewResult {
	/** 分区名 → 正文。preamble 为无标签文本；其余分区已去掉包裹用的 <tag>。 */
	sections: Record<string, string>;
}

export interface PingRequest {
	type: "ping";
	id: string;
}

// ---------------------------------------------------------------------------
// owl 跨会话记忆（owl-memory）—— 设置页「跨会话记忆」卡片同源数据
// ---------------------------------------------------------------------------

/** 单条跨会话记忆（<agentDir>/memories/entries.json 的投影）。 */
export interface OwlMemoryItem {
	id: string;
	content: string;
	/** 记录来源项目 cwd（模型 remember 工具手工保存的条目可能没有）。 */
	sourceCwd?: string;
	/** ISO 时间。 */
	createdAt: string;
}

export interface MemoryListRequest {
	type: "memory.list";
	id: string;
}

export interface MemoryListResult {
	/** 是否启用（settings.owlMemory.enabled，默认 true）。 */
	enabled: boolean;
	entries: OwlMemoryItem[];
}

export interface MemoryDeleteRequest {
	type: "memory.delete";
	id: string;
	entryId: string;
}

export interface MemoryDeleteResult {
	ok: boolean;
}

export interface MemoryClearRequest {
	type: "memory.clear";
	id: string;
}

export interface MemoryClearResult {
	ok: boolean;
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

// ---------------------------------------------------------------------------
// 终端：UI ↔ 桥的 PTY 会话（宿主 node-pty，一个终端 tab = 一个会话）。
// 输出走独立的服务端消息、定向推给拥有它的连接：不进会话事件流、不广播。
// ---------------------------------------------------------------------------

/** 新建终端（cwd 绝对路径；行列数由前端 fit addon 算好后带上）。 */
export interface TermCreateRequest {
	type: "term.create";
	id: string;
	cwd: string;
	cols: number;
	rows: number;
}

export interface TermCreateResult {
	termId: string;
	/** 实际使用的 shell（展示用）。 */
	shell: string;
}

/** 向终端写入按键（xterm onData 原样透传）。 */
export interface TermInputRequest {
	type: "term.input";
	id: string;
	termId: string;
	data: string;
}

/** 前端容器尺寸变化后同步行列数。 */
export interface TermResizeRequest {
	type: "term.resize";
	id: string;
	termId: string;
	cols: number;
	rows: number;
}

/** 关闭终端（tab 关闭 / 连接断开时宿主也会兜底回收）。 */
export interface TermKillRequest {
	type: "term.kill";
	id: string;
	termId: string;
}

/** 终端输出（pty 已解码的 UTF-8 字符串，含 ANSI 序列，xterm 原样 write）。 */
export interface TermDataMessage {
	type: "term.data";
	termId: string;
	data: string;
}

/** 终端进程退出。 */
export interface TermExitMessage {
	type: "term.exit";
	termId: string;
	exitCode: number | undefined;
}

// ---------------------------------------------------------------------------
// 内嵌浏览器（owl IAB）—— 桥进程托管的私有无头浏览器（playwright-core + 系统
// Edge/Chrome），UI 通过 screencast 帧流显示，agent 通过 browser_* 工具驱动，
// 双方看到的是同一批页面。帧流与终端同策略：只推给订阅它的那条连接，不广播；
// 页面清单变化（导航/开关页）才广播。
// ---------------------------------------------------------------------------

/** IAB 里的一个页面（= 无头浏览器的一个 tab）。 */
export interface IabPageInfo {
	pageId: string;
	url: string;
	title: string;
	/** 当前 CSS 视口（用户可由 iab.viewport 调整）。 */
	viewport: { width: number; height: number };
	/** agent 最近操作/导航的页面（每连接至多一个，供 UI 高亮与自动开 tab）。 */
	active: boolean;
}

/**
 * 页面清单广播。origin 标记触发方：agent 工具触发的变化带 "agent"，
 * UI 据此自动开一个绑定该页面的浏览器 tab（ZCode IAB「agent 开页 = 面板自动可见」的对应实现）。
 */
export interface IabPagesMessage {
	type: "iab.pages";
	pages: IabPageInfo[];
	origin: "agent" | "ui";
}

/** 页面弹出了文件选择框（无头浏览器弹不出系统对话框）：UI 提示横幅，agent 可用 browser_set_file_chooser 提供路径。 */
export interface IabFileChooserMessage {
	type: "iab.filechooser";
	pageId: string;
	multiple: boolean;
}

/** screencast 帧（JPEG base64，尺寸 = 页面视口）。 */
export interface IabFrameMessage {
	type: "iab.frame";
	pageId: string;
	data: string;
	width: number;
	height: number;
}

export type IabServerMessage = IabPagesMessage | IabFrameMessage | IabFileChooserMessage;

/** 打开/绑定一个页面：带 url 找不到就新建，带 pageId 直接复用（不存在则报错）。 */
export interface IabOpenRequest {
	type: "iab.open";
	id: string;
	url?: string;
	pageId?: string;
}

export interface IabOpenResult {
	page: IabPageInfo;
}

/** 页面级导航（工具条后退/前进/刷新）。 */
export interface IabNavRequest {
	type: "iab.nav";
	id: string;
	pageId: string;
	action: "back" | "forward" | "reload";
}

/** 调整页面视口（CSS 像素；前端「适应窗口」按缩放显示，不改这个值）。 */
export interface IabViewportRequest {
	type: "iab.viewport";
	id: string;
	pageId: string;
	width: number;
	height: number;
}

/** 输入转发：坐标均为页面视口坐标（前端按画布缩放换算）。 */
export type IabInputPayload =
	| { kind: "mouse"; action: "move" | "down" | "up"; x: number; y: number; button?: "left" | "right" | "middle" }
	| { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
	| { kind: "key"; key: string; down: boolean; text?: string; modifiers?: string[] };

export interface IabInputRequest {
	type: "iab.input";
	id: string;
	pageId: string;
	input: IabInputPayload;
}

/** 订阅/退订某页面的帧流（按连接记账，断线兜底回收，与 term.* 同策略）。 */
export interface IabAttachRequest {
	type: "iab.attach";
	id: string;
	pageId: string;
}

export interface IabDetachRequest {
	type: "iab.detach";
	id: string;
	pageId: string;
}

/** 关闭一个页面；关掉最后一个页面时无头浏览器保留待复用。 */
export interface IabCloseRequest {
	type: "iab.close";
	id: string;
	pageId: string;
}

/** 应答页面的文件选择框：paths 为本机绝对路径（通常由 agent 的 browser_set_file_chooser 下发）。 */
export interface IabFileResponseRequest {
	type: "iab.fileResponse";
	id: string;
	pageId: string;
	paths: string[];
}

/** 当前全部页面（连接/重连后拉一次初始状态）。 */
export interface IabStateRequest {
	type: "iab.state";
	id: string;
}

export interface IabStateResult {
	pages: IabPageInfo[];
}

/** 服务端广播：被 watch 的目录内容变了（客户端按 cwd 过滤、增量重列）。 */
export interface FsChangedEvent {
	type: "fs_changed";
	cwd: string;
	/** 发生变更的目录（workspace 相对，POSIX 分隔符）。 */
	dirs: string[];
}

/**
 * sidebar_open 工具触发：模型请求在侧边工作台打开一个文件。path 是相对
 * cwd 的 workspace 相对 POSIX 路径（与 fs 层同一围栏：越出工作区的路径在
 * 工具侧就拒绝，不会过线）。UI 只在当前项目与 cwd 一致时处理。
 */
export interface SidebarOpenMessage {
	type: "sidebar.open";
	cwd: string;
	path: string;
}

export interface PermissionResponseRequest {
	type: "permission.response";
	id: string;
	requestId: string;
	approved: boolean;
}

/** 提问选项：label 是答案的唯一标识（回传按 label 对账），preview 为可选 markdown 对比材料。 */
export interface QuestionOptionPayload {
	label: string;
	description?: string;
	preview?: string;
}

/** 单个问题：多选时 selectedLabels 可含多个；customText 是"其他"自由文本答案。 */
export interface QuestionPayload {
	question: string;
	/** 侧栏/卡片短标题（≤16 字符）。 */
	header: string;
	multiSelect: boolean;
	options: QuestionOptionPayload[];
}

/** 一题的答案：selectedLabels 命中 option.label；customText 表示选了"其他"并自填；note 为附加备注。 */
export interface QuestionAnswerPayload {
	index: number;
	selectedLabels?: string[];
	customText?: string;
	note?: string;
}

/** UI 应答提问：cancelled=true 表示用户放弃整套问卷，answers 为空。 */
export interface QuestionResponseRequest {
	type: "question.response";
	id: string;
	requestId: string;
	cancelled?: boolean;
	answers: QuestionAnswerPayload[];
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
	| SessionSetApprovalModeRequest
	| SessionCompactRequest
	| SessionStatsRequest
	| CommandsListRequest
	| SkillsListRequest
	| SkillsReadRequest
	| SkillsSetEnabledRequest
	| SkillsCreateRequest
	| SkillsUpdateRequest
	| SkillsDeleteRequest
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
	| SystemPromptPreviewRequest
	| MemoryListRequest
	| MemoryDeleteRequest
	| MemoryClearRequest
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
	| OpenExternalRequest
	| TermCreateRequest
	| TermInputRequest
	| TermResizeRequest
	| TermKillRequest
	| IabOpenRequest
	| IabNavRequest
	| IabViewportRequest
	| IabInputRequest
	| IabAttachRequest
	| IabDetachRequest
	| IabCloseRequest
	| IabFileResponseRequest
	| IabStateRequest
	| QuestionResponseRequest;

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

/** 服务端广播：agent 的 ask_user_question 工具在等用户作答（question.response 应答）。 */
export type QuestionRequestMessage = {
	type: "question_request";
	requestId: string;
	sessionId: string;
	toolCallId: string;
	questions: QuestionPayload[];
};

export type ServerResponseMessage = {
	type: "response";
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

export type DesktopServerMessage =
	| ServerEventMessage
	| ServerResponseMessage
	| PermissionRequestMessage
	| QuestionRequestMessage
	| TermDataMessage
	| TermExitMessage
	| IabServerMessage
	| SidebarOpenMessage;

/** Omit that distributes over unions (so each request variant keeps its fields). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DesktopClientRequestWithoutId = DistributiveOmit<DesktopClientRequest, "id">;
