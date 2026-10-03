/**
 * owl desktop wire protocol — shared between the bridge (serve.ts) and the
 * desktop UI. Types only: import from the UI with `import type` so nothing
 * server-side leaks into the browser bundle.
 */

import type { ContextEventRow, ContextRequestRow, ContextToolRef } from "../../core/context-insight.ts";
import type { MapResultsMessage } from "../../core/maps/types.ts";
export type { MapResultsMessage } from "../../core/maps/types.ts";
import type { MailAgentContext, MailDraft, MailRequest } from "../../core/mail/types.ts";
import type { NewsRequest } from "../../core/news/types.ts";
import type { WorkspaceViewerInfo } from "../../core/workspace-viewers.ts";

export type * from "../../core/mail/types.ts";
export type { WorkspaceViewerInfo, WorkspaceViewerOpenResult } from "../../core/workspace-viewers.ts";

export interface MailClientRequest {
	type: "mail.request";
	id: string;
	request: MailRequest;
}

export interface MailAgentStartRequest {
	type: "mail.agent.start";
	id: string;
	context: MailAgentContext;
	cwd?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
}

export interface MailAgentDraftMessage {
	type: "mail.agent.draft";
	sessionId: string;
	draft: MailDraft;
}

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

// -- 会话回退（owl-rewind） ----------------------------------------------------
// 回退本体 = AgentSession.navigateTree（leaf 指针前移，被撤回内容留在日志里），
// 文件还原 = owl-rewind 扩展的写前备份。快照存储在 <agentDir>/rewind-snapshots/。

/** 一条可回退的用户消息（当前分支、当前可见上下文内的）。 */
export interface RewindTarget {
	entryId: string;
	text: string;
	timestamp: string;
}

export interface RewindTargetsRequest {
	type: "rewind.targets";
	id: string;
	sessionId: string;
}

export interface RewindTargetsResult {
	targets: RewindTarget[];
}

/** 回退前的影响清单：对照真实磁盘算出的差量（只算不动盘）。 */
export interface RewindImpactRequest {
	type: "rewind.impact";
	id: string;
	sessionId: string;
	entryId: string;
}

export interface RewindImpactFile {
	path: string;
	/** 工作区相对显示路径（解析不出时回退绝对路径） */
	displayPath: string;
	action: "restore" | "delete";
	size: number;
}

export interface RewindImpactResult {
	files: RewindImpactFile[];
	/** 已追踪但内容与目标状态一致、无需改动的文件数 */
	unchanged: number;
}

/** 执行回退。mode=both 时先按备份还原文件再移动会话 leaf。 */
export interface RewindExecuteRequest {
	type: "rewind.execute";
	id: string;
	sessionId: string;
	entryId: string;
	mode: "conversation" | "both";
}

export interface RewindExecuteResult {
	/** 被回退的目标消息文本（UI 回填输入框） */
	editorText?: string;
	snapshot: SessionSnapshotPayload;
	restored: number;
	deleted: number;
	/** 单文件跳过/失败清单（目录被移走、符号链接等） */
	skipped: Array<{ path: string; reason: string }>;
}

// -- 改动审批（owl-diff-approval） ----------------------------------------------
// AI 编辑的逐文件「保留/回滚」：捕获在 owl-diff-approval 插件（settings plugins），
// 存储 <agentDir>/diff-approval/workspaces/<工作区哈希>.json，桥经 core 注册表
// 单例读改。全部按 cwd 定位工作区（与 fs.*/git.* 同口径），不依赖会话挂载。

export type DiffApprovalStatus = "pending" | "kept" | "reverted";

/** 待审清单里的一条文件记录。 */
export interface DiffApprovalFileSummary {
	id: string;
	/** 绝对路径。 */
	path: string;
	/** 工作区相对显示路径（工作区外回退绝对路径）。 */
	displayPath: string;
	status: DiffApprovalStatus;
	/** AI 编辑前文件是否已存在（false = AI 新建，回滚即删除）。 */
	originalExisted: boolean;
	/** 当前磁盘上是否还存在（被外部删掉时 false，回滚可恢复）。 */
	currentExists: boolean;
	/** 相对基线的 +/− 行数；过大/二进制/基线缺失时为 null。 */
	added: number | null;
	removed: number | null;
	/** 当前磁盘字节数（文件不在时 0）。 */
	size: number;
	baselineAt: string;
	resolvedAt: string | null;
}

export interface DiffApprovalListRequest {
	type: "diffApproval.list";
	id: string;
	/** 工作区目录（决定读哪份存储）。 */
	cwd: string;
}

export interface DiffApprovalListResult {
	files: DiffApprovalFileSummary[];
}

export interface DiffApprovalDiffRequest {
	type: "diffApproval.diff";
	id: string;
	cwd: string;
	entryId: string;
}

export interface DiffApprovalDiffResult {
	/** 基线 vs 当前磁盘的 unified diff（已补 diff --git 头）。 */
	diff: string;
	/** 超过输出上限被截断时 true。 */
	truncated: boolean;
}

/** action=keep 接受改动（不动盘）；revert 还原基线（新建文件删除）。 */
export interface DiffApprovalResolveRequest {
	type: "diffApproval.resolve";
	id: string;
	cwd: string;
	entryIds: string[];
	action: "keep" | "revert";
}

export interface DiffApprovalResolveResult {
	resolved: number;
	failed: Array<{ path: string; reason: string }>;
}

export interface DiffApprovalClearRequest {
	type: "diffApproval.clear";
	id: string;
	cwd: string;
}

export interface DiffApprovalClearResult {
	removed: number;
}

/** 服务端推送：某工作区的待审清单变化（捕获/保留/回滚/清除后）。 */
export interface DiffApprovalChangedMessage {
	type: "diffApproval.changed";
	cwd: string;
}

/** 会话快照（session.create/resume/rewind 共用）：消息 + 对齐的会话条目 id。 */
export interface SessionSnapshotPayload {
	sessionId: string;
	cwd: string;
	messages: unknown[];
	/** 与 messages 按下标对齐的会话条目 id（回退按钮需要；无条目来源的消息为 undefined） */
	messageEntryIds: (string | undefined)[];
	thinkingLevel?: unknown;
	header: unknown;
	/** Persisted mailbox scope; these sessions keep only mailbox tools when resumed. */
	mailContext?: MailAgentContext;
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
	/** 对 skills.list 传入的项目是否启用（按项目 settings.skills 覆盖模式计算；未配置恒 true）。 */
	projectEnabled: boolean;
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
	/** 项目目录；缺省用桥的默认 cwd（决定项目 tab 的根与 projectEnabled 的计算对象）。 */
	cwd?: string;
}

export interface SkillsListResult {
	roots: SkillCenterRoots;
	skills: SkillCenterEntry[];
	/** 当前项目是否已信任（未信任时项目 tab 只读并提示）。 */
	projectTrusted: boolean;
	/** 该项目 settings.json 的 skills 覆盖模式原样带回（UI 判断勾选形态用）。 */
	projectSkillPatterns: string[];
	/** 项目内单独添加的技能（owlSkillExtras）。 */
	projectExtras: string[];
	/** 全局技能分组（owlSkillGroups）。 */
	skillGroups: SkillGroupInfo[];
}

/** 技能分组（owlSkillGroups 的线上形态）：关联项目后组内技能对该项目生效。 */
export interface SkillGroupInfo {
	name: string;
	skills: string[];
	projects: string[];
}

export interface SkillsGroupsSaveRequest {
	type: "skills.groups.save";
	id: string;
	/** 全量替换 owlSkillGroups（UI 在本地编辑组列表后整体保存）。 */
	groups: SkillGroupInfo[];
}

export interface SkillsProjectExtrasRequest {
	type: "skills.project.addExtras" | "skills.project.removeExtras";
	id: string;
	cwd: string;
	/** 单独添加 / 移除的技能名。 */
	names: string[];
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

/**
 * 勾选本项目需要的技能：写项目 settings.json 的 skills 覆盖模式（opt-out 语义）。
 * - mode "set"：names = 取消勾选（项目内禁用）的技能名，逐个写成 `!名字`；
 *   空数组 = 全部启用（清空覆盖）。
 * - mode "clear"：等价于空数组的显式说法。
 * 写操作需项目已信任；落盘后桥端热刷新挂载会话。
 */
export interface SkillsSetProjectSelectionRequest {
	type: "skills.setProjectSelection";
	id: string;
	cwd: string;
	mode: "set" | "clear";
	names: string[];
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

/** 查询上下文洞察（owl-context 插件经 core/context-insight 注册表供数）。 */
export interface ContextGetRequest {
	type: "context.get";
	id: string;
	/** 项目目录；不带 sessionId 时按 cwd 取最近活跃的会话。 */
	cwd: string;
	sessionId?: string;
}

export interface ContextGetResult {
	sessionId?: string;
	requests: ContextRequestRow[];
	events: ContextEventRow[];
	tools: ContextToolRef[];
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

export interface NewsClientRequest {
	type: "news.request";
	id: string;
	request: NewsRequest;
}

export interface NewsOpenMessage {
	type: "news.open";
	sessionId: string;
	kind: "item" | "story";
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
// owl 使用统计（usage.get）—— 设置页「使用统计」卡片同源数据。
//
// 扫描 <agentDir>/Owl-history 下全部会话 JSONL，聚合其中的 usage 记录
// （assistant 消息、usage 条目、工具摘要/压缩）。纯文件操作，不挂载会话，
// 因此正在进行的会话写入落盘后下一次请求即可看到（前端 5s 轮询 = 实时）。
// ---------------------------------------------------------------------------

/** 一组用量合计（token 数 + 费用 + 带用量记录的请求次数）。 */
export interface UsageStatsTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 推理 token（output 的子集，部分供应商不上报）。 */
	reasoning: number;
	totalTokens: number;
	cost: number;
	requests: number;
}

/** 单日用量（date 为本机时区的 YYYY-MM-DD）。 */
export interface UsageStatsDay {
	date: string;
	totalTokens: number;
	cost: number;
	requests: number;
}

/** 单模型用量（key 为 provider/model，与会话记录里的口径一致）。 */
export interface UsageStatsModel {
	key: string;
	totalTokens: number;
	cost: number;
	requests: number;
}

/** 单项目用量（cwd 为会话所属工作区）。 */
export interface UsageStatsProject {
	cwd: string;
	totalTokens: number;
	cost: number;
	requests: number;
	sessions: number;
}

/** 单会话用量（按 Token 排序后截断，见 UsageStatsResult.topSessions）。 */
export interface UsageStatsSession {
	sessionId: string;
	cwd: string;
	name?: string;
	firstMessage?: string;
	/** 会话开始时间（session 头的 ISO 时间）。 */
	startedAt: string;
	/** 最近一次写入时间（文件 mtime）。 */
	lastActiveAt: string;
	totalTokens: number;
	cost: number;
	requests: number;
}

export interface UsageGetRequest {
	type: "usage.get";
	id: string;
}

export interface UsageGetResult {
	totals: UsageStatsTotals;
	/** 本机时区的「今天」。 */
	today: { totalTokens: number; cost: number; requests: number };
	/** 升序的最近 30 天（无记录的日期也占位，方便直接画柱状图）。 */
	byDay: UsageStatsDay[];
	/** 按累计费用降序，费用相同按 Token 降序。 */
	byModel: UsageStatsModel[];
	/** 按 Token 降序。 */
	byProject: UsageStatsProject[];
	/** 按 Token 降序的前 12 个会话。 */
	topSessions: UsageStatsSession[];
	sessionCount: number;
	firstRecordedAt?: string;
	/** 本次统计的生成时间（ISO），前端据此显示「更新于」。 */
	generatedAt: string;
}

// ---------------------------------------------------------------------------
// owl-image 图像生成（owl-image 插件）—— 设置页「图像生成」卡片同源数据。
//
// 配置面（get/set）直接读写 <agentDir>/image-gen.json，与插件解耦——桥进程
// 纯文件操作，不 import 插件代码；密钥永不下发明文（keyStatus 只给存在性）。
// 订阅登录需要 PKCE+回环服务器+令牌交换，这部分动态调用 owl-image dist 暴露
// 的导出函数（单一事实源），插件缺失时返回可读错误。
// ---------------------------------------------------------------------------

/** owl-image 支持的 provider（与 packages/owl-image/src/shared.ts 的 IMAGE_PROVIDERS 对齐）。 */
export type OwlImageProvider =
	| "google"
	| "openai"
	| "openai-compat"
	| "seedream"
	| "dashscope"
	| "xai"
	| "zhipu"
	| "comfyui"
	| "google-sub";

/** BYOK provider（google-sub 走订阅不在内），apiKeys/env 的键集。 */
export const OWL_IMAGE_BYOK_PROVIDERS = [
	"google",
	"openai",
	"openai-compat",
	"seedream",
	"dashscope",
	"xai",
	"zhipu",
] as const satisfies readonly OwlImageProvider[];

/** image-gen.json 的公开投影：不含 apiKeys 明文。 */
export interface OwlImageConfigPublic {
	provider?: OwlImageProvider;
	googleModel?: string;
	googleEndpoint?: string;
	openaiBaseURL?: string;
	openaiModel?: string;
	openaiCompatBaseURL?: string;
	openaiCompatModel?: string;
	openaiCompatEditFormat?: "multipart" | "jsonImageUrlArray" | "formReferenceImages";
	seedreamBaseURL?: string;
	seedreamModel?: string;
	seedreamOutputFormat?: "png" | "jpeg";
	seedreamWatermark?: boolean;
	seedreamBackground?: "opaque" | "transparent";
	dashscopeEndpoint?: string;
	dashscopeModel?: string;
	xaiBaseURL?: string;
	xaiModel?: string;
	zhipuBaseURL?: string;
	zhipuModel?: string;
	comfyuiBaseURL?: string;
	comfyuiWorkflows?: { name: string; json: string; presetPrompt?: string }[];
	comfyuiActiveWorkflow?: string;
	comfyuiTimeoutMs?: number;
	saveToWorkspace?: boolean;
	workspaceFolder?: string;
	attachImageToResult?: boolean;
	maxImageBytes?: number;
	proxy?: string;
}

export interface ImageConfigGetRequest {
	type: "imageConfig.get";
	id: string;
}

export interface ImageConfigGetResult {
	/** 当前配置（apiKeys 不含明文）。 */
	config: OwlImageConfigPublic;
	/** 各 BYOK provider 的 key 状态：configured=可用（config 或 env），source=来自哪一层。 */
	keyStatus: Record<string, { configured: boolean; source: "config" | "env" | undefined }>;
	/** Google 订阅（Antigravity）登录状态。 */
	subscription: { loggedIn: boolean; email?: string };
	/** 配置文件路径（空提示用）。 */
	configPath: string;
	/** owl-image 插件是否已安装（settings.plugins 里能解析到 dist）。 */
	pluginInstalled: boolean;
}

export interface ImageConfigSetRequest {
	type: "imageConfig.set";
	id: string;
	/** 覆盖到 image-gen.json 的公开配置字段（浅合并）。 */
	config: OwlImageConfigPublic;
	/**
	 * 要更新的 API key：非空=写入该 provider 的 apiKeys 行；空串=删除该行；
	 * 不出现的 provider 保持原值。
	 */
	apiKeys?: Partial<Record<(typeof OWL_IMAGE_BYOK_PROVIDERS)[number], string>>;
}

export interface ImageConfigSetResult {
	ok: boolean;
}

export interface ImageSubLoginRequest {
	type: "imageSub.login";
	id: string;
}

export interface ImageSubLoginResult {
	ok: boolean;
	/** 授权 URL（桥端已尝试自动开浏览器；UI 可再兜底打开/展示）。 */
	url?: string;
	error?: string;
}

export interface ImageSubLogoutRequest {
	type: "imageSub.logout";
	id: string;
}

export interface ImageSubLogoutResult {
	ok: boolean;
}

export interface ImageModelsListRequest {
	type: "imageModels.list";
	id: string;
	/** owl-image 的 provider id（google/openai/…/google-sub/comfyui）。 */
	provider: string;
}

export interface ImageModelsListResult {
	/** 可选模型 id（google-sub 固定一个；comfyui 是工作流名；拉取失败为空）。 */
	models: string[];
	/** 拉取失败原因（模型输入框保持手填，不阻断配置）。 */
	error?: string;
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
	/** 拥有该页面的聊天；未绑定聊天的手动页面可由聊天显式认领。 */
	sessionId?: string;
	url: string;
	title: string;
	/** 当前 CSS 视口（用户可由 iab.viewport 调整）。 */
	viewport: { width: number; height: number };
	/** 该聊天内 agent 最近操作/导航的页面，供 UI 高亮与自动开 tab。 */
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
	/** 触发 agent 操作的聊天；页面清单始终包含全部聊天的页面。 */
	originSessionId?: string;
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
	/** 新建/认领页面的聊天；已有页面不能由其他聊天认领。 */
	sessionId?: string;
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

/** Discover file viewers registered by active Owl plugins. */
export interface ViewerListRequest {
	type: "viewer.list";
	id: string;
}

export interface ViewerListResult {
	viewers: WorkspaceViewerInfo[];
}

export interface ViewerOpenRequest {
	type: "viewer.open";
	id: string;
	viewerId: string;
	cwd: string;
	path: string;
}

export interface ViewerChangedMessage extends ViewerListResult {
	type: "viewer.changed";
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
	| MailClientRequest
	| MailAgentStartRequest
	| NewsClientRequest
	| SessionCreateRequest
	| SessionPromptRequest
	| ContextGetRequest
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
	| RewindTargetsRequest
	| RewindImpactRequest
	| RewindExecuteRequest
	| DiffApprovalListRequest
	| DiffApprovalDiffRequest
	| DiffApprovalResolveRequest
	| DiffApprovalClearRequest
	| SessionStatsRequest
	| CommandsListRequest
	| SkillsListRequest
	| SkillsReadRequest
	| SkillsSetEnabledRequest
	| SkillsCreateRequest
	| SkillsUpdateRequest
	| SkillsDeleteRequest
	| SkillsSetProjectSelectionRequest
	| SkillsGroupsSaveRequest
	| SkillsProjectExtrasRequest
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
	| UsageGetRequest
	| ImageConfigGetRequest
	| ImageConfigSetRequest
	| ImageSubLoginRequest
	| ImageSubLogoutRequest
	| ImageModelsListRequest
	| PingRequest
	| PermissionResponseRequest
	| ViewerListRequest
	| ViewerOpenRequest
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
	| MapResultsMessage
	| MailAgentDraftMessage
	| NewsOpenMessage
	| ServerEventMessage
	| ServerResponseMessage
	| PermissionRequestMessage
	| QuestionRequestMessage
	| TermDataMessage
	| TermExitMessage
	| IabServerMessage
	| ViewerChangedMessage
	| SidebarOpenMessage
	| DiffApprovalChangedMessage;

/** Omit that distributes over unions (so each request variant keeps its fields). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DesktopClientRequestWithoutId = DistributiveOmit<DesktopClientRequest, "id">;
