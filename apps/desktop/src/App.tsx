import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BridgeClient } from "./bridge/client.ts";
import { closeMainWindow, hasTauri, isWindowFullscreen, quitDesktopApp, revealInFileManager, setWebviewZoom, setWindowFullscreen } from "./bridge/native.ts";
import type { AgentPresetDefinition, ApprovalMode, CommandsListResult, FsSearchHit, PermissionRequest, ProviderModelsMessage, QuestionRequest, ResearchMode, RewindExecuteResult, RewindImpactFile, ServerEventMessage, SessionExportLogResult, SessionRunningResult, SessionStatsResult, SlashCommandEntry } from "./bridge/protocol.ts";
import { applyEvent, applyRetryEvent, rebuild, type ChatEntry, type RetryBannerState } from "./hooks/transcript.ts";
import { ActivityRail, type RailView } from "./components/ActivityRail.tsx";
import { MapWorkspace } from "./map/MapWorkspace.tsx";
import { NewsPage } from "./features/news/NewsPage.tsx";
import type { NewsTarget } from "./features/news/NewsReading.tsx";
import { MailPage } from "./features/mail/MailPage.tsx";
import { EvaluationPage } from "./features/evaluation/EvaluationPage.tsx";
import { ResearchPage } from "./features/research/ResearchPage.tsx";
import { ManagerTab } from "./sidebar/tabs/ManagerTab.tsx";
import { useResearchEntryText } from "./features/research/research-entry-copy.ts";
import { MediaView } from "./features/media/MediaView.tsx";
import { ProjectsPage } from "./features/projects/ProjectsPage.tsx";
import { GuidePanel } from "./features/guide/GuidePanel.tsx";
import { TokenCareerPage } from "./features/token-career/TokenCareerPage.tsx";
import { AutomationPage } from "./features/automation/AutomationPage.tsx";
import { SchedulePin } from "./features/automation/SchedulePin.tsx";
import { MyselfPanel } from "./features/myself/MyselfPanel.tsx";
import { ExpertPanel } from "./features/expert/ExpertPanel.tsx";
import { BaguPage } from "./features/bagu/BaguPage.tsx";
import { MarketPage } from "./features/market/MarketPage.tsx";
import { LifeMonitorPage } from "./features/life-monitor/LifeMonitorPage.tsx";
import { presentLife } from "./features/life-monitor/present.ts";
import { useLifeProbe } from "./features/life-monitor/use-life-probe.ts";
import { MediaOverlays } from "./features/media/MediaOverlays.tsx";
import { ChatStream, type ChatActivity } from "./components/ChatStream.tsx";
import { GenuiSessionProvider } from "./components/Genui.tsx";
import { ContextView } from "./components/ContextView.tsx";
import { TrajectoryView } from "./features/trajectory/TrajectoryView.tsx";
import { ConversationHeader, type ConversationView, type SessionExportFormat } from "./components/ConversationHeader.tsx";
import { conversationTitleOf } from "./components/conversation-title.ts";
import { Composer, type ComposerImage } from "./components/Composer.tsx";
import { useSessionOwlPose } from "./components/OwlMascot.tsx";
import { TurnArtifacts } from "./components/ReviewChangesCard.tsx";
import { collectArtifacts, workspaceArtifactPath } from "./hooks/artifacts.ts";
import { PermissionDialog } from "./components/PermissionDialog.tsx";
import { QuestionDock } from "./components/QuestionDock.tsx";
import { RewindDialog } from "./components/RewindDialog.tsx";
import { SessionShareDialog } from "./components/SessionShareDialog.tsx";
import { SessionSidebar } from "./components/SessionSidebar.tsx";
import { loadSidebarStrings, matchesSessionScope, sidebarStorageKeys } from "./components/sidebar-scope.ts";
import { DesktopTitlebar } from "./components/DesktopTitlebar.tsx";
import { DynamicIsland } from "./components/DynamicIsland.tsx";
import { islandQuestionChoices, islandSessionTitle, islandWhisper, type IslandOutcome } from "./components/dynamic-island-model.ts";
import { useAppHistory } from "./use-app-history.ts";
import type { AppPlace } from "./app-history.ts";
import { ShortcutsDialog, type HelpSection } from "./components/ShortcutsDialog.tsx";
import { FindBar } from "./components/FindBar.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { SettingsPage, type SettingsInitialTab } from "./components/SettingsPage.tsx";
import { TodoPin } from "./components/TodoPin.tsx";
import { RetryPin } from "./components/RetryPin.tsx";
import { isThemePreference, setThemePreference } from "./theme.ts";
import { applyOwlAppearance, parseOwlAppearance } from "./owl-appearance.ts";
import { applyChatAppearance, parseChatAppearance } from "./chat-appearance.ts";
import { applyOwlWallpaper, parseOwlWallpaper, type OwlWallpaperSettings } from "./wallpaper.ts";
import { fetchInventory, passesRating, WallpaperLayer } from "./components/WallpaperLayer.tsx";
import { parseUiLanguageSetting, setUiLanguageSetting, t, useT, type UiLanguageSetting } from "./i18n/index.ts";
import { normPath, samePath, DEFAULT_WORKSPACE_DIR, isReservedDir } from "./utils/paths.ts";
import { isProjectHidden, restoreProject, setProjectAlias, useProjectSidebarRevision } from "./project-sidebar-model.ts";
import { Workbench } from "./sidebar/Workbench.tsx";
import { SidebarStore, normProjectKey } from "./sidebar/store.ts";
import { openQuickAction } from "./sidebar/quick.tsx";
import { openDeveloperWorkbench } from "./sidebar/developer.ts";
import { getSidebarConfig, isTabKindEnabled, parseSidebarSettings, setSidebarConfig, viewerKindForPath } from "./sidebar/config.ts";
import { fileUrlOf } from "./sidebar/api.ts";
import { isIabPageBound, boundTabIdFor, encodeIabPath, parseIabPath, agentPageForSession } from "./sidebar/iab-bound.ts";
import { BrowserSessionContext } from "./sidebar/registry.ts";
import { setSessionFeed } from "./sidebar/feed.ts";
import { focusReviewEntry } from "./sidebar/review-focus.ts";
import { notifyAgentStatus } from "./utils/notification.ts";
import { parseNotificationPrefs, setNotificationPrefs } from "./utils/notification-prefs.ts";
import { downloadTextFile } from "./utils/download.ts";
import "./desktop-shell.css";

const WORKSPACE_KEY = "owl.workspaceDir";
/** 是否选择了对话目录（"0" = 已叉掉，不选目录）：不选时会话进 DEFAULT_WORKSPACE_DIR。 */
const WORKSPACE_SELECTED_KEY = "owl.workspaceSelected";
const MODEL_KEY = "owl.model";
const THINKING_KEY = "owl.thinkingLevel";
const APPROVAL_KEY = "owl.approvalMode";
/** 暂存的 Agent 预设 id：新会话创建时带上（DSH 的 staged-selection 语义）。 */
const PRESET_KEY = "owl.agentPreset";
const SIDEBAR_MINIMIZED_KEY = "owl.sidebar.minimized";
const NEWS_SIDEBAR_MINIMIZED_KEY = "owl.news.sidebar.minimized";

/** localStorage 里记录的审批模式是否合法（防旧值/手改值落到未知档位）。 */
function isApprovalMode(value: string | null): value is ApprovalMode {
	return value === "auto" || value === "confirm" || value === "plan";
}
const WORKBENCH_OPEN_KEY = "owl.workbench.open";
/** 旧版「工作台停靠位」key：拆分后只读一次做迁移，不再写入。 */
const WORKBENCH_DOCK_KEY = "owl.workbench.dock";
const TERMINAL_OPEN_KEY = "owl.terminal.open";
const WORKBENCH_LAYOUT_KEY = "owl.workbench.layout";
const CONVERSATION_VIEW_KEY = "owl.conversation.view";
const RESEARCH_CONVERSATION_VIEW_KEY = "owl.research.conversation.view";
const ZOOM_KEY = "owl.ui.zoom";
/** 缩放挡位（对照浏览器 Ctrl+- / Ctrl+Shift+= / Ctrl+0），实际大小 = 1。 */
const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** session.list 返回行的最小字段（完整形状见桥端 SessionInfo）。 */
type SessionRowLite = {
	id?: string;
	name?: string;
	firstMessage?: string;
	parentSessionPath?: string;
	cwd?: string;
	modified?: string;
	created?: string;
	messageCount?: number;
	archivedAt?: string;
	scope?: "chat" | "research";
	[key: string]: unknown;
};

function rowTime(row: SessionRowLite): string {
	return String(row.modified ?? row.created ?? "");
}

export default function App(): React.JSX.Element {
	const t = useT();
	const projectSidebarRevision = useProjectSidebarRevision();
	const researchTitle = useResearchEntryText();
	const client = useMemo(() => new BridgeClient(), []);
	const [connected, setConnected] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsInitialTab>("general");
	const [settingsMountKey, setSettingsMountKey] = useState(0);
	// 动态壁纸（owlWallpaper）：设置页保存时同步到这里，WallpaperLayer 随之重渲。
	const [wallpaper, setWallpaper] = useState<OwlWallpaperSettings>(() => parseOwlWallpaper(undefined));
	const [showProjectDialog, setShowProjectDialog] = useState(false);
	// 项目页「创建」：创建后留在项目页（不切走）；顶栏/快捷键入口仍是创建即进入。
	const [projectDialogStay, setProjectDialogStay] = useState(false);
	// 设置页改动会话（恢复/删除归档）时递增，驱动侧边栏重拉列表
	const [sidebarRev, setSidebarRev] = useState(0);
	const [newsTarget, setNewsTarget] = useState<NewsTarget & { revision: number }>();
	const [railView, setRailView] = useState<RailView>(() => {
		const view = new URLSearchParams(window.location.search).get("view");
		return view === "manager" || view === "mail" || view === "map" || view === "evaluation" || view === "media" || view === "projects" || view === "research" || view === "guide" || view === "career" || view === "monitor" || view === "myself" || view === "expert" || view === "bagu" || view === "market" ? view : "chat";
	});
	const sessionScope = railView === "research" ? "research" : "chat";
	const [mailMounted, setMailMounted] = useState(railView === "mail");
	const [evaluationMounted, setEvaluationMounted] = useState(railView === "evaluation");
	const [researchMounted, setResearchMounted] = useState(railView === "research");
	// 号池 Manager 懒挂载：首次点开 Rail 才渲染 iframe，之后保活。
	const [managerMounted, setManagerMounted] = useState(railView === "manager");
	if (railView === "manager") setManagerMounted(true);
	const [researchSessionId, setResearchSessionId] = useState<string>();
	const researchSessionIdRef = useRef(researchSessionId);
	researchSessionIdRef.current = researchSessionId;
	const [researchConversationTitle, setResearchConversationTitle] = useState<string>();
	const [researchResumeRequest, setResearchResumeRequest] = useState<{ id: string; revision: number }>();
	const [researchNewConversationRequest, setResearchNewConversationRequest] = useState(0);
	const researchActionSequence = useRef(0);
	const railViewRef = useRef(railView);
	railViewRef.current = railView;
	// 媒体桥视图懒挂载：首次点开 Rail「音乐」才渲染，之后保活（保留 tab/滚动位置）。
	const [mediaMounted, setMediaMounted] = useState(railView === "media");
	// 「人生指南」同样懒挂载保活：内容抓一次就留在内存与 localStorage。
	const [guideMounted, setGuideMounted] = useState(railView === "guide");
	// 「我的 Token 生涯」看板：懒挂载保活，扫描结果留在内存，重开不重扫（后端另有 mtime 缓存）。
	const [careerMounted, setCareerMounted] = useState(railView === "career");
	const [automationMounted, setAutomationMounted] = useState(railView === "automation");
	/** 跳自动化任务页（会话内任务卡 / 下次运行常驻条共用）。 */
	const openAutomation = (): void => {
		setShowSettings(false);
		setAutomationMounted(true);
		setRailView("automation");
	};
	const [monitorMounted, setMonitorMounted] = useState(railView === "monitor");
	// 「我的助理」同样懒挂载保活：owl-myself 的天文件读一次留在内存，勾选即时回写。
	const [myselfMounted, setMyselfMounted] = useState(railView === "myself");
	// 「专家顾问」懒挂载保活：owl-expert 的人格目录与群清单留在内存。
	const [expertMounted, setExpertMounted] = useState(railView === "expert");
	// 「八股对练」懒挂载保活：题库与面试线程留在内存，切走再回来不丢进度。
	const [baguMounted, setBaguMounted] = useState(railView === "bagu");
	const [marketMounted, setMarketMounted] = useState(railView === "market");
	// owl agent 数据目录（settings.get 带出）：我的助理的兜底数据根。
	const [agentDir, setAgentDir] = useState<string>();
	const [sidebarMinimized, setSidebarMinimized] = useState(
		() => localStorage.getItem(SIDEBAR_MINIMIZED_KEY) === "1",
	);
	const [newsSidebarMinimized, setNewsSidebarMinimized] = useState(
		() => localStorage.getItem(NEWS_SIDEBAR_MINIMIZED_KEY) === "1",
	);
	const sidebarToggleRef = useRef<HTMLButtonElement>(null);
	const toggleSessionSidebar = (): void => {
		setSidebarMinimized((current) => {
			const next = !current;
			localStorage.setItem(SIDEBAR_MINIMIZED_KEY, next ? "1" : "0");
			return next;
		});
		sidebarToggleRef.current?.focus({ preventScroll: true });
	};
	const [entries, setEntries] = useState<ChatEntry[]>([]);
	// 自动重试横幅（auto_retry_start/end 事件驱动）：与转录条目分开放，agent_end 重建不牵连
	const [retryStatus, setRetryStatus] = useState<RetryBannerState | null>(null);
	const [todoPinVisible, setTodoPinVisible] = useState(false);
	const [draftRequest, setDraftRequest] = useState<{ id: number; text: string; replace?: boolean }>();
	const draftSequence = useRef(0);
	const [submitting, setSubmitting] = useState(false);
	const submitInFlight = useRef(false);
	const [pendingPrompts, setPendingPrompts] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [promptQueues, setPromptQueues] = useState<Record<string, { steering: string[]; followUp: string[] }>>({});
	/** agent run 活跃的会话 id（含切走后的后台会话与旁路会话）：侧边栏运行状态点依据。 */
	const [runningSessions, setRunningSessions] = useState<ReadonlySet<string>>(() => new Set<string>());
	const runningSessionsRef = useRef(runningSessions);
	runningSessionsRef.current = runningSessions;
	/** 每个正在跑的会话最近一次有动静的时间。只在「谁排第一」变化时写进 state。 */
	const activityAtRef = useRef(new Map<string, number>());
	const startedAtRef = useRef(new Map<string, number>());
	const stepRef = useRef(new Map<string, string>());
	const [stepRev, setStepRev] = useState(0);
	const noteStepRef = useRef<(id: string, step: string) => void>(() => {});
	noteStepRef.current = (id, step) => {
		if (stepRef.current.get(id) === step) return;
		stepRef.current.set(id, step);
		setStepRev((current) => current + 1);
	};
	const activityLeaderRef = useRef<string | null>(null);
	const [activityOrder, setActivityOrder] = useState<readonly string[]>([]);
	const [doneNotice, setDoneNotice] = useState<{ seq: number; id: string; outcome: IslandOutcome } | null>(null);
	const doneSeqRef = useRef(0);
	const outcomeRef = useRef(new Map<string, IslandOutcome>());
	const islandJumpRef = useRef<(() => void) | null>(null);
	const [listedTitles, setListedTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
	const titleForRef = useRef<(id: string) => string>((id) => id);
	const publishActivityRef = useRef<(ids: ReadonlySet<string>) => void>(() => {});
	publishActivityRef.current = (ids) => {
		const order = [...ids].sort((a, b) => (activityAtRef.current.get(b) ?? 0) - (activityAtRef.current.get(a) ?? 0) || a.localeCompare(b));
		activityLeaderRef.current = order[0] ?? null;
		setActivityOrder((current) => current.length === order.length && current.every((id, index) => id === order[index]) ? current : order);
	};
	/** 被用户主动暂停的会话：这些会话的输入框按钮显示「继续」，点击即从断点续跑。 */
	const [pausedSessions, setPausedSessions] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [sessionId, setSessionId] = useState<string | undefined>(undefined);
	const running = Boolean(sessionId && (runningSessions.has(sessionId) || pendingPrompts.has(sessionId)));
	const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
	const permission = permissions.find((request) => request.sessionId === (railView === "research" ? researchSessionId : sessionId)) ?? permissions[0];
	/** agent 提问队列：按到达顺序在所属会话的输入框上方显示。 */
	const [questions, setQuestions] = useState<QuestionRequest[]>([]);
	const activeQuestion = questions.find((question) => question.sessionId === sessionId);
	// 应答审批/提问用的实时镜像：Toast 监听器等一次性注册的闭包拿不到新 state
	const permissionsRef = useRef(permissions);
	permissionsRef.current = permissions;
	const questionsRef = useRef(questions);
	questionsRef.current = questions;
	// 审批/提问应答统一走这里：先乐观出队；失败（断线窗口、桥重启中）把请求放回
	// 队列——否则 agent 永远停在等待应答，而 UI 上已经没有任何可点的东西
	const answerAndRestore = <T extends { requestId: string }>(
		requestId: string,
		listRef: { current: T[] },
		setList: (update: (current: T[]) => T[]) => void,
		respond: () => Promise<unknown>,
	): void => {
		const entry = listRef.current.find((item) => item.requestId === requestId);
		setList((current) => current.filter((item) => item.requestId !== requestId));
		respond().catch(() => {
			setList((current) => (entry !== undefined && !current.some((item) => item.requestId === requestId) ? [...current, entry] : current));
		});
	};
	/** 会话回退（owl-rewind）：待确认的目标用户消息，弹 RewindDialog */
	const [rewindTarget, setRewindTarget] = useState<{ entryId: string; text: string } | undefined>(undefined);
	const [providers, setProviders] = useState<ProviderModelsMessage[]>([]);
	const [modelValue, setModelValue] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
	const [thinkingLevel, setThinkingLevel] = useState(() => localStorage.getItem(THINKING_KEY) ?? "medium");
	// 审批模式（标准 confirm / 计划 plan / 自动 auto）：输入栏切换，会话中可即时下发
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>(() => {
		const stored = localStorage.getItem(APPROVAL_KEY);
		return isApprovalMode(stored) ? stored : "confirm";
	});
	// Agent 预设：花名册 + 新任务默认（桥端）+ 暂存选择 + 当前会话绑定。
	// 显示优先级：打开的会话显示它的绑定；空白/新会话显示暂存选择。
	const [agentPresets, setAgentPresets] = useState<AgentPresetDefinition[]>([]);
	const [defaultPresetId, setDefaultPresetId] = useState("standard");
	const [stagedPreset, setStagedPreset] = useState(() => localStorage.getItem(PRESET_KEY) ?? "");
	const [sessionPreset, setSessionPreset] = useState<string | undefined>(undefined);
	// ensureSession 闭包要读最新暂存值：经 ref 中转（设置页代创会先改暂存再开会话）。
	const stagedPresetRef = useRef(stagedPreset);
	const [sessionInfo, setSessionInfo] = useState<SessionStatsResult | undefined>(undefined);
	/** 当前会话是否由别的会话分支而来（快照 header.parentSession）：无名分支的顶栏标题加「· 分支」。 */
	const [sessionBranched, setSessionBranched] = useState(false);
	/** 当前会话的持久化显示名（session_info，如分支的「fork2 · 来自「你好」」）；顶栏优先用它。 */
	const [sessionName, setSessionName] = useState<string | undefined>(undefined);
	const [workspaceDir, setWorkspaceDir] = useState(
		() => localStorage.getItem(WORKSPACE_KEY) ?? DEFAULT_WORKSPACE_DIR,
	);
	// 目录选择状态：叉掉 chip 后为 false——输入框不再绑定目录，会话默认进 DEFAULT_WORKSPACE_DIR。
	const [workspaceSelected, setWorkspaceSelected] = useState(
		() => localStorage.getItem(WORKSPACE_SELECTED_KEY) !== "0",
	);
	const lifeProbe = useLifeProbe({ client, connected, cwd: workspaceDir, model: modelValue });
	const lifeView = useMemo(() => presentLife(lifeProbe.channels, lifeProbe.round), [lifeProbe.channels, lifeProbe.round]);
	// 输入框项目选择器的候选列表：与侧边栏同源（当前 ∪ 有会话 ∪ 到访过），切换项目/侧边栏变更时刷新。
	const [projects, setProjects] = useState<string[]>([]);
	const [researchProjects, setResearchProjects] = useState<string[]>([]);
	const visibleProjects = useMemo(() => projects.filter((path) => !isProjectHidden(path, "chat")), [projects, projectSidebarRevision]);
	const visibleResearchProjects = useMemo(() => researchProjects.filter((path) => !isProjectHidden(path, "research")), [researchProjects, projectSidebarRevision]);
	// 斜杠命令清单（桥端 commands.list）：连接后、切项目、建/恢复会话时刷新（扩展命令随会话出现）。
	const [slashCommands, setSlashCommands] = useState<SlashCommandEntry[]>([]);
	// 两块独立面板：右侧工具侧栏（文件/编辑器/浏览器等，不含终端）与底部终端
	// 栏，各自开合、可同时存在于界面上（底栏是底栏，侧栏是侧栏）。
	const [sidebarOpen, setSidebarOpen] = useState(() =>
		localStorage.getItem(WORKBENCH_OPEN_KEY) === "1" && localStorage.getItem(WORKBENCH_DOCK_KEY) !== "bottom",
	);
	const [terminalOpen, setTerminalOpen] = useState(() => {
		const stored = localStorage.getItem(TERMINAL_OPEN_KEY);
		if (stored !== null) return stored === "1";
		// 老版本迁移：原本停靠在底部且展开的工作台 → 迁成打开终端底栏
		return localStorage.getItem(WORKBENCH_OPEN_KEY) === "1" && localStorage.getItem(WORKBENCH_DOCK_KEY) !== "right";
	});
	const [developerLayout, setDeveloperLayout] = useState(
		() => localStorage.getItem(WORKBENCH_LAYOUT_KEY) === "developer",
	);
	// 主区视图（顶栏 tab 切换）：对话 / 上下文（owl-context 插件供数）
	const [conversationView, setConversationView] = useState<ConversationView>(() =>
		localStorage.getItem(CONVERSATION_VIEW_KEY) === "context" ? "context" : "chat",
	);
	const [researchConversationView, setResearchConversationView] = useState<ConversationView>(() =>
		localStorage.getItem(RESEARCH_CONVERSATION_VIEW_KEY) === "context" ? "context" : "chat",
	);
	const setResearchConversationViewPersisted = (view: ConversationView): void => {
		setResearchConversationView(view);
		localStorage.setItem(RESEARCH_CONVERSATION_VIEW_KEY, view);
	};
	const setConversationViewPersisted = (view: ConversationView): void => {
		setConversationView(view);
		localStorage.setItem(CONVERSATION_VIEW_KEY, view);
	};
	const setDeveloperLayoutPersisted = (developer: boolean): void => {
		setDeveloperLayout(developer);
		localStorage.setItem(WORKBENCH_LAYOUT_KEY, developer ? "developer" : "tools");
	};
	const setSidebarOpenPersisted = (open: boolean): void => {
		setSidebarOpen(open);
		localStorage.setItem(WORKBENCH_OPEN_KEY, open ? "1" : "0");
	};
	const setTerminalOpenPersisted = (open: boolean): void => {
		setTerminalOpen(open);
		localStorage.setItem(TERMINAL_OPEN_KEY, open ? "1" : "0");
	};

	// 「帮助」弹窗（使用指南 / 键盘快捷键）与页面内查找条（Ctrl+F）
	const [helpSection, setHelpSection] = useState<HelpSection>();
	const [findOpen, setFindOpen] = useState(false);
	// 视图：全屏（F11）与 webview 缩放。缩放持久化到 localStorage，启动时经 effect 恢复。
	const [fullscreen, setFullscreen] = useState(false);
	const [zoom, setZoom] = useState(() => {
		const stored = Number(localStorage.getItem(ZOOM_KEY));
		return Number.isFinite(stored) && stored > 0 ? stored : 1;
	});
	const fullscreenRef = useRef(fullscreen);
	fullscreenRef.current = fullscreen;

	/** 缩放挡位步进；越界停在端点，未知当前值时按最近的下一挡推算。 */
	const zoomStep = (direction: 1 | -1): void => {
		setZoom((current) => {
			let index = ZOOM_STEPS.findIndex((step) => Math.abs(step - current) < 0.01);
			if (index === -1) index = ZOOM_STEPS.findIndex((step) => step > current) - 1;
			return ZOOM_STEPS[Math.min(Math.max(index + direction, 0), ZOOM_STEPS.length - 1)];
		});
	};

	// 缩放持久化并即时生效；浏览器模式 setWebviewZoom 是 no-op。
	useEffect(() => {
		localStorage.setItem(ZOOM_KEY, String(zoom));
		void setWebviewZoom(zoom);
	}, [zoom]);

	// 启动时对齐一次全屏状态（例如上次以全屏退出后重启）。
	useEffect(() => {
		void isWindowFullscreen().then(setFullscreen);
	}, []);

	// 工作台 store 按项目提升到 App：Workbench 与快捷入口共用同一实例。
	// 工具侧栏不再承载终端（归底栏专管），历史布局里的终端 tab 一次性清掉；
	// 终端栏有自己独立的 store（独立持久化，互不掺和）。
	const workbenchKey = normProjectKey(workspaceDir);
	const workbenchStore = useMemo(() => {
		const store = new SidebarStore(workspaceDir);
		for (const tab of store.getState().tabs) {
			if (tab.kind === "terminal") store.closeTab(tab.id);
		}
		return store;
	}, [workbenchKey]); // eslint-disable-line react-hooks/exhaustive-deps
	const terminalStore = useMemo(() => new SidebarStore(workspaceDir, "owl.terminal.state"), [workbenchKey]); // eslint-disable-line react-hooks/exhaustive-deps
	const artifacts = useMemo(() => collectArtifacts(entries, workspaceDir, { scope: "turn", includeCode: true }), [entries, workspaceDir]);
	const [fileOpenError, setFileOpenError] = useState<string>();
	useEffect(() => setFileOpenError(undefined), [sessionId, workspaceDir]);
	// 会话日志导出：结果条（成功=保存路径，失败=具体原因）。不自动消失，切会话即清，
	// 避免导出失败时点菜单「毫无反应」却看不到原因。
	const [exportingLog, setExportingLog] = useState(false);
	const [exportNotice, setExportNotice] = useState<{ text: string; tone: "info" | "error" }>();
	useEffect(() => setExportNotice(undefined), [sessionId, researchSessionId]);
	// 勾选历史分享：弹窗挂载的目标会话（普通/科研视图同一套导出链路）
	const [shareTurnsSession, setShareTurnsSession] = useState<string>();
	/** 在侧边栏浏览器 tab 打开 URL：同一 URL 已有 tab 就激活，否则开新 tab（标题带序号）。 */
	const openInBrowserTab = (url: string, title: string): void => {
		if (!isTabKindEnabled("browser", getSidebarConfig())) return;
		for (const tab of workbenchStore.getState().tabs) {
			if (tab.kind === "browser" && parseIabPath(tab.path).url === url) {
				workbenchStore.activate(tab.id);
				setDeveloperLayoutPersisted(false);
				if (!sidebarOpenRef.current) setSidebarOpenPersisted(true);
				return;
			}
		}
		workbenchStore.openNew("browser", title, url);
		setDeveloperLayoutPersisted(false);
		if (!sidebarOpenRef.current) setSidebarOpenPersisted(true);
	};
	/** 聊天正文行内芯片的 http(s) 链接：交给侧边栏浏览器（「浏览器」卡片停用时不动）。 */
	const openUrlInSidebarBrowser = (url: string): void => {
		openInBrowserTab(url, t("app.browserTab"));
	};
	const openTaskFile = (path: string): void => {
		const relative = workspaceArtifactPath(path, workspaceRef.current);
		if (!relative) return;
		setFileOpenError(undefined);
		// 工作区 HTML 优先内置浏览器：真实加载（相对资源可解析），document 预览的
		// srcDoc iframe 做不到；「浏览器」卡片停用时维持原 document 预览。
		if (/\.html?$/i.test(relative) && isTabKindEnabled("browser", getSidebarConfig())) {
			openInBrowserTab(fileUrlOf(workspaceRef.current, relative), relative.split("/").pop() ?? relative);
			return;
		}
		const kind = viewerKindForPath(relative, getSidebarConfig());
		if (kind === undefined) {
			void client.request({ type: "open.external", action: "url", target: fileUrlOf(workspaceRef.current, relative) })
				.then((result) => { if (!result.ok) setFileOpenError(result.error ?? t("app.fileOpenFailed")); })
				.catch((error: unknown) => setFileOpenError(error instanceof Error ? error.message : String(error)));
			return;
		}
		workbenchStore.openFileTab(kind, relative, relative.split("/").pop() ?? relative);
		setDeveloperLayoutPersisted(false);
		if (!sidebarOpenRef.current) setSidebarOpenPersisted(true);
	};

	// 面板开合的 ref 镜像：快捷键与卡片回调里免 stale closure。
	const sidebarOpenRef = useRef(sidebarOpen);
	sidebarOpenRef.current = sidebarOpen;
	const terminalOpenRef = useRef(terminalOpen);
	terminalOpenRef.current = terminalOpen;

	/** 打开终端底栏；栏里一个终端都没有时顺手建一个（首次打开即能用）。 */
	const openTerminalPanel = (): void => {
		if (terminalStore.getState().tabs.length === 0) openQuickAction(terminalStore, "terminal");
		setTerminalOpenPersisted(true);
	};

	const toggleTerminalPanel = (): void => {
		if (terminalOpenRef.current) setTerminalOpenPersisted(false);
		else openTerminalPanel();
	};

	const toggleSidebarPanel = (): void => setSidebarOpenPersisted(!sidebarOpenRef.current);

	/** 打开一个快捷 tab：终端归底栏，其余工具归右侧栏。 */
	const requestOpenKind = (kind: string): void => {
		if (kind === "terminal") {
			openTerminalPanel();
			return;
		}
		openQuickAction(workbenchStore, kind);
		setSidebarOpenPersisted(true);
	};

	/** 对话流改动卡「工作台审查」跳转：先记下要选中的文件，再打开改动审批卡片。 */
	const openWorkbenchReview = (focusPath?: string): void => {
		if (focusPath !== undefined && focusPath !== "") focusReviewEntry(focusPath);
		requestOpenKind("review");
	};

	const openDeveloper = (): void => {
		if (!openDeveloperWorkbench(workbenchStore, (kind) => isTabKindEnabled(kind))) return;
		setRailView("chat");
		setDeveloperLayoutPersisted(true);
		setSidebarOpenPersisted(true);
		openTerminalPanel();
		setShowSettings(false);
	};

	/** 快捷键开终端 / 浏览器 tab：所在面板没开就先展开。 */
	const openInPanel = (kind: string): void => {
		if (railView !== "research") setRailView("chat");
		if (kind === "terminal") {
			openTerminalPanel();
			return;
		}
		if (!sidebarOpenRef.current) setSidebarOpenPersisted(true);
		openQuickAction(workbenchStore, kind);
	};

	const workspaceRef = useRef(workspaceDir);
	workspaceRef.current = workspaceDir;
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;
	// 会话视图序号：openSession 的响应落地前用户可能又点了别的会话/新会话/切项目，
	// 序号对不上的过期响应直接丢弃，否则旧会话（连同 workspace、localStorage）
	// 会被后到的响应画回屏幕
	const sessionViewSeq = useRef(0);
	// session.create 在途标记：连点「新会话」时只放行第一笔创建，免得侧栏多出空会话
	const creatingSessionRef = useRef(false);
	const panelSessionIdRef = useRef<string | undefined>(undefined);
	panelSessionIdRef.current = railView === "research" ? researchSessionId : sessionId;
	useEffect(() => client.onNewsOpen((message) => {
			if (message.sessionId !== sessionIdRef.current) return;
		setShowSettings(false);
		setRailView("news");
		setNewsTarget({ kind: message.kind, id: message.id, revision: Date.now() });
	}), [client]);
	useEffect(() => {
		const openNewsHash = (): void => {
			const match = /^#news\/(item|story|daily|weekly|monthly)\/([^/]+)$/.exec(window.location.hash.replace(/^#\//, "#"));
			if (!match) return;
			let id: string;
			try { id = decodeURIComponent(match[2]); } catch { return; }
			setShowSettings(false); setRailView("news");
			const kind = match[1];
			if (kind === "daily" || kind === "weekly" || kind === "monthly") setNewsTarget({ kind, key: id, revision: Date.now() });
			else if (kind === "item" || kind === "story") setNewsTarget({ kind, id, revision: Date.now() });
		};
		openNewsHash();
		window.addEventListener("hashchange", openNewsHash);
		return () => window.removeEventListener("hashchange", openNewsHash);
	}, []);
	useEffect(() => setRewindTarget(undefined), [sessionId, workspaceDir]);

	// -- 会话回退（owl-rewind）--------------------------------------------------
	// 点用户消息旁的 ↶：找到带 entryId 的行弹确认弹层；执行成功后按快照重建
	// 转录、把被回退的目标消息文本回填输入框（replace 语义，替换现有草稿）。
	const handleRewindClick = (entryId: string): void => {
		if (!sessionIdRef.current) return;
		const clicked = entries.find((entry) => entry.kind === "user" && entry.entryId === entryId);
		if (clicked?.kind === "user") setRewindTarget({ entryId, text: clicked.text });
	};

	/** 回退成功后的公共收尾：按快照重建转录 + 清理受影响文件的工作台过期缓冲。 */
	const applyRewindSnapshot = (result: RewindExecuteResult, affectedFiles: RewindImpactFile[] = []): void => {
		const messages = result.snapshot.messages as Record<string, unknown>[];
		setEntries(rebuild(messages, result.snapshot.messageEntryIds));
		// 收尾工作台：被还原/删除的文件在编辑器里的旧缓冲不会自己感知磁盘变化，
		// 关掉无未保存改动的匹配 tab（脏 tab 留给用户自己决定），重开即是新内容。
		const affected = new Set(affectedFiles.map((file) => file.displayPath));
		if (affected.size > 0) {
			const workbenchState = workbenchStore.getState();
			for (const tab of workbenchState.tabs) {
				if (tab.path && affected.has(tab.path) && !workbenchState.dirty[tab.id]) workbenchStore.closeTab(tab.id);
			}
		}
		void refreshStats();
	};

	const handleRewindDone = (result: RewindExecuteResult, affectedFiles: RewindImpactFile[] = []): void => {
		setRewindTarget(undefined);
		applyRewindSnapshot(result, affectedFiles);
		if (typeof result.editorText === "string") {
			setDraftRequest({ id: ++draftSequence.current, text: result.editorText, replace: true });
		}
	};

	// -- 消息操作：编辑重发 / 重新生成 ------------------------------------------
	// 两者都是「仅回退对话」到目标用户消息再重发：不动文件，模型看到的历史回到该条之前。
	const rewindConversation = async (entryId: string): Promise<RewindExecuteResult | undefined> => {
		if (!sessionIdRef.current || !connected || running || submitInFlight.current) return undefined;
		try {
			const response = await client.request<RewindExecuteResult>({
				type: "rewind.execute",
				sessionId: sessionIdRef.current,
				entryId,
				mode: "conversation",
			});
			if (response.ok && response.result) return response.result;
		} catch {
			// 回退失败（会话已卸载等）：放弃本次操作，转录保持原样
		}
		return undefined;
	};

	const handleEditMessage = async (entryId: string, text: string, images?: { data: string; mimeType: string }[]): Promise<void> => {
		const result = await rewindConversation(entryId);
		if (!result) return;
		applyRewindSnapshot(result);
		await sendPrompt(text, images?.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })));
	};

	const handleRegenerate = async (): Promise<void> => {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			if (entry.kind !== "user") continue;
			// 目标用户消息没有 entryId（旧桥/异常流）就无从回退，直接放弃
			if (!entry.entryId) return;
			const result = await rewindConversation(entry.entryId);
			if (!result) return;
			applyRewindSnapshot(result);
			await sendPrompt(result.editorText ?? entry.text);
			return;
		}
	};

	// 在新对话中分支：以某条回答为末梢复制新会话（原会话原封不动），桥端全新挂载。
	// 会话正在跑也可以从历史回答分支：原会话留在后台继续，界面切到新会话。
	// 成功后必须直接跳进新会话：走与点击侧边栏会话完全相同的 openSession 通道切换
	// （工作区/标题后缀/转录回放/统计全部同源），再在尾部补一行反馈让跳转肉眼可见。
	const handleBranch = async (entryId: string): Promise<void> => {
		if (!sessionIdRef.current || !connected) return;
		try {
			const response = await client.request<{
				sessionId: string;
				researchMode?: ResearchMode;
			}>({
				type: "session.fork",
				sessionId: sessionIdRef.current,
				entryId,
				approvalMode,
				...selectedModel(),
			});
			if (!response.ok || !response.result) {
				setEntries((current) => [
					...current,
					{ kind: "toolResult", toolName: t("app.branchFailed"), ok: false, brief: response.error ?? t("app.unknownError") },
				]);
				return;
			}
			const { sessionId: forkedId, researchMode } = response.result;
			if (researchMode !== undefined || !forkedId) return;
			await openSession(forkedId);
			// openSession 失败时会把转录换成错误行，此时不再补成功反馈
			if (sessionIdRef.current === forkedId) {
				setEntries((current) => [
					...current,
					{ kind: "toolResult", toolName: t("app.branchTool"), ok: true, brief: t("app.branchDone") },
				]);
			}
			setSidebarRev((current) => current + 1);
		} catch (error) {
			setEntries((current) => [
				...current,
				{
					kind: "toolResult",
					toolName: t("app.branchFailed"),
					ok: false,
					brief: error instanceof Error ? error.message : String(error),
				},
			]);
		}
	};

	useEffect(() => {
		// A replaced bridge client must report its own connection before mailbox queries resume.
		setConnected(false);
		client.connect();
		const offStatus = client.onStatus((up) => {
			setConnected(up);
			if (!up) {
				submitInFlight.current = false;
				setSubmitting(false);
			}
		});
		const offEvents = client.onSessionEvent((message: ServerEventMessage) => {
			// 全会话运行状态跟踪：agent_start / agent_settled 成对出现（abort、出错也走 settled），
			// 必须在下面的当前会话过滤之前记录，否则后台会话的绿点状态丢失。
			const eventType = (message.event as { type?: string }).type;
			const now = Date.now();
			activityAtRef.current.set(message.sessionId, now);
			// 用户消息落盘即刷新侧栏：新会话文件要等首条用户消息写入才创建（桥端
			// _hasConversation 门控），此刻 refreshKey（sessionId）早已稳定不再变化，
			// 只靠 agent_settled 刷新的话，长任务运行期间侧栏一直看不到这个新对话。
			if (eventType === "queue_update") {
				const queued = message.event as { steering?: string[]; followUp?: string[] };
				setPromptQueues((current) => ({
					...current,
					[message.sessionId]: { steering: [...(queued.steering ?? [])], followUp: [...(queued.followUp ?? [])] },
				}));
			}
			if (eventType === "entry_appended" && (message.event as { entry?: { message?: { role?: string } } }).entry?.message?.role === "user") {
				setSidebarRev((current) => current + 1);
			}
			if (eventType === "agent_start") {
				outcomeRef.current.delete(message.sessionId);
				startedAtRef.current.set(message.sessionId, now);
				stepRef.current.delete(message.sessionId);
				const next = new Set(runningSessionsRef.current);
				next.add(message.sessionId);
				runningSessionsRef.current = next;
				setRunningSessions(next);
				publishActivityRef.current(next);
			} else if (eventType === "agent_settled") {
				setSidebarRev((current) => current + 1);
				setPermissions((current) => current.filter((request) => request.sessionId !== message.sessionId));
				setQuestions((current) => current.filter((question) => question.sessionId !== message.sessionId));
				const next = new Set(runningSessionsRef.current);
				if (next.delete(message.sessionId)) {
					runningSessionsRef.current = next;
					startedAtRef.current.delete(message.sessionId);
					stepRef.current.delete(message.sessionId);
					setRunningSessions(next);
					publishActivityRef.current(next);
					const outcome = outcomeRef.current.get(message.sessionId) ?? "done";
					outcomeRef.current.delete(message.sessionId);
					setDoneNotice({ seq: ++doneSeqRef.current, id: message.sessionId, outcome });
				}
			} else if (eventType === "agent_end") {
				const end = message.event as { willRetry?: boolean; messages?: { role?: string; stopReason?: string }[] };
				const assistant = !end.willRetry ? [...(end.messages ?? [])].reverse().find((item) => item.role === "assistant") : undefined;
				if (assistant?.stopReason) {
					const reason = assistant.stopReason;
					outcomeRef.current.set(message.sessionId, reason === "aborted" ? "aborted" : reason === "error" ? "error" : "done");
				}
			} else if (eventType === "message_update" && runningSessionsRef.current.has(message.sessionId)) {
				const update = (message.event as { assistantMessageEvent?: { type?: string; toolName?: string; toolCall?: { name?: string }; contentIndex?: number; partial?: { content?: { name?: string }[] } } }).assistantMessageEvent;
				if (update?.type === "toolcall_start" || update?.type === "toolcall_end") {
					const tool = update.toolName ?? update.toolCall?.name ?? update.partial?.content?.[update.contentIndex ?? -1]?.name;
					if (tool) noteStepRef.current(message.sessionId, tool);
				} else if (update?.type === "thinking_delta") noteStepRef.current(message.sessionId, "thinking");
				else if (update?.type === "text_delta") noteStepRef.current(message.sessionId, "writing");
			} else if (runningSessionsRef.current.has(message.sessionId) && activityLeaderRef.current !== message.sessionId) {
				publishActivityRef.current(runningSessionsRef.current);
			}
			if (eventType === "agent_start" || eventType === "agent_settled") {
				setPendingPrompts((current) => {
					if (!current.has(message.sessionId)) return current;
					const next = new Set(current);
					next.delete(message.sessionId);
					return next;
				});
			}
			// 旁路会话（侧边对话等）的事件由各自 tab 消费，主转录只跟当前会话
			if (message.sessionId !== sessionIdRef.current) return;
			setEntries((current) => applyEvent(current, message));
			setRetryStatus((current) => applyRetryEvent(current, message));
			if (eventType === "agent_settled") {
				void refreshStats();
				void notifyAgentStatus({
					title: t("app.notifyDoneTitle"),
					body: t("app.notifyDoneBody"),
					category: "done",
					critical: false,
				});
			}
		});
		const offPermission = client.onPermissionRequest((request) => {
			if (request) {
				setPermissions((current) => current.some((pending) => pending.requestId === request.requestId) ? current : [...current, request]);
				void notifyAgentStatus({
					title: t("app.notifyConfirmTitle"),
					body: t("app.notifyConfirmBody", { name: request.toolName ?? t("app.toolFallback") }),
					category: "permission",
					critical: true,
					quickAction: {
						requestId: request.requestId,
						approveLabel: t("perm.allow"),
						denyLabel: t("perm.deny"),
					},
				});
			}
		});
		const offQuestion = client.onQuestionRequest((request) => {
			setQuestions((current) => current.some((pending) => pending.requestId === request.requestId) ? current : [...current, request]);
			void notifyAgentStatus({
				title: t("app.notifyQuestionTitle"),
				body: request.questions[0]?.question ?? t("app.notifyQuestionBody"),
				category: "question",
				critical: true,
			});
		});
		return () => {
			offStatus();
			offEvents();
			offPermission();
			offQuestion();
		};
	}, [client]);

	// 原生 Toast 快捷裁决：Rust 侧按钮点击经 owl-toast-action 事件转发过来，
	// 直接应答对应审批（requestId 已不在等待队列时内核安全拒绝，无副作用）
	useEffect(() => {
		if (!hasTauri()) return;
		let unlisten: (() => void) | undefined;
		let disposed = false;
		void listen<{ kind?: string; requestId?: string; approved?: boolean }>("owl-toast-action", (event) => {
			const payload = event.payload;
			if (payload?.kind !== "decision" || typeof payload.requestId !== "string" || typeof payload.approved !== "boolean") return;
			answerAndRestore(payload.requestId, permissionsRef, setPermissions, () => client.respondPermission(payload.requestId!, payload.approved!));
		}).then((off) => {
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [client]);

	// 任务管理 tab 的 feed：流式 delta 只重渲染订阅者，不牵连整个工作台
	useEffect(() => {
		if (railView === "research") return;
		setSessionFeed({ running, entries });
	}, [running, entries, railView]);

		// 全局快捷键（对照 Codex 桌面端菜单，全部动作的键盘入口收在这一个 handler）：
		// 动作集经 shortcutsRef 每次渲染刷新，免 stale closure；
		// 焦点在内嵌浏览器（data-iab-capture）里时不抢键：那些组合键属于页面本身。
		// 终端 Ctrl+` / 浏览器 Ctrl+T 沿用 DSH 语义：落在当前停靠位，面板没开就顺手展开。
		useEffect(() => {
			const onKey = (event: KeyboardEvent): void => {
				if ((event.target as HTMLElement | null)?.closest?.("[data-iab-capture]")) return;
				const actions = shortcutsRef.current;
				// Alt+Ctrl+B：对话 / 上下文 tab 切换
				if (event.ctrlKey && event.altKey && (event.key === "b" || event.key === "B")) {
					event.preventDefault();
					actions.toggleChatContext();
					return;
				}
				const mod = event.ctrlKey && !event.altKey;
				if (mod && event.shiftKey) {
					switch (event.key) {
						case "S": case "s": event.preventDefault(); actions.toggleSidebar(); return;
						case "E": case "e": event.preventDefault(); actions.toggleRightPanel(); return;
						case "[": event.preventDefault(); actions.prevSession(); return;
						case "]": event.preventDefault(); actions.nextSession(); return;
					}
				}
				if (!mod) {
					if (event.key === "F11") {
						event.preventDefault();
						actions.toggleFullscreen();
					}
					return;
				}
				switch (event.key) {
					case "n": case "N": event.preventDefault(); actions.newChat(); return;
					case "o": case "O": event.preventDefault(); actions.openProject(); return;
					case "w": case "W": event.preventDefault(); actions.closeWindow(); return;
					case "q": case "Q": event.preventDefault(); actions.quit(); return;
					case ",": event.preventDefault(); actions.openSettings(); return;
					case "/": event.preventDefault(); actions.showShortcuts(); return;
					case "f": case "F": event.preventDefault(); actions.find(); return;
					case "j": case "J": event.preventDefault(); actions.toggleBottomPanel(); return;
					case "`": case "~": event.preventDefault(); actions.openTerminal(); return;
					case "t": case "T": event.preventDefault(); actions.openBrowserTab(); return;
					case "[": event.preventDefault(); actions.historyBack(); return;
					case "]": event.preventDefault(); actions.historyForward(); return;
					case "-": case "_": event.preventDefault(); actions.zoomOut(); return;
					case "=": case "+": event.preventDefault(); actions.zoomIn(); return;
					case "0": event.preventDefault(); actions.zoomReset(); return;
					case ".": event.preventDefault(); actions.openIsland(); return;
					default: return;
				}
			};
			window.addEventListener("keydown", onKey);
			return () => window.removeEventListener("keydown", onKey);
		}, []); // eslint-disable-line react-hooks/exhaustive-deps

		// IAB 联动（ZCode 同款）：agent 用 browser_* 工具开/切页面时，用户始终
		// 看得见 agent 的浏览器操作。用户自己开的面板（origin=ui）不打扰。
		// 浏览器 tab 固定落在右侧工具侧栏（纵向空间足），侧栏没开就顺手展开。
		// 侧边卡片设置停用了「浏览器」卡片时不再自动弹面板（设置页「侧边卡片」）。
		useEffect(() => {
			return client.onIabMessage((message) => {
				if (message.type !== "iab.pages" || message.origin !== "agent") return;
				if (!isTabKindEnabled("browser", getSidebarConfig())) return;
				const target = agentPageForSession(message, panelSessionIdRef.current);
				if (!target) return;
				// 已有面板在看：直接激活那个 tab；没有才开新 tab
				const boundTabId = isIabPageBound(target.pageId) ? boundTabIdFor(target.pageId) : undefined;
				if (boundTabId) workbenchStore.activate(boundTabId);
				else workbenchStore.openNew("browser", target.title || t("app.browserTab"), encodeIabPath(target.pageId, target.url, target.sessionId));
				setSidebarOpenPersisted(true);
			});
		}, [client, workbenchStore]); // eslint-disable-line react-hooks/exhaustive-deps

		// sidebar_open 工具广播：模型请求在侧边工作台打开文件（设置页「侧边卡片」
		// 开启工具注入后才会出现）。仅处理当前项目的广播——路径是该项目 cwd 的
		// 相对路径，切了项目后旧广播里的路径对不上新工作台。预览卡片停用时的
		// 回退与工作台一致：交给系统默认程序。
		useEffect(() => {
			return client.onSidebarMessage((message) => {
				if (normProjectKey(message.cwd) !== normProjectKey(workspaceRef.current)) return;
				openTaskFile(message.path);
			});
		}, [client, workbenchStore]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
			void Notification.requestPermission().catch(() => {});
		}
	}, []);

	useEffect(() => {
		if (!connected || showSettings) return;
		void client
			.request<ProviderModelsMessage[]>({ type: "models.list" })
			.then((response) => response.ok && setProviders(response.result ?? []))
			.catch(() => {});
	}, [connected, client, showSettings]);

	useEffect(() => {
		if (!connected) return;
		// 连接后拉一次运行中的会话：UI 刷新或桥重连后恢复侧边栏的运行状态点。
		void client
			.request<SessionRunningResult>({ type: "session.running" })
			.then((response) => {
				if (!response.ok) return;
				const ids = response.result?.running ?? [];
				const now = Date.now();
				for (const id of ids) if (!activityAtRef.current.has(id)) activityAtRef.current.set(id, now);
				const next = new Set(ids);
				runningSessionsRef.current = next;
				setRunningSessions(next);
				publishActivityRef.current(next);
				setPendingPrompts(new Set());
			})
			.catch(() => {});
		// 主题偏好存放在 settings.json（dark / light / system），连上桥后立即应用；
		// 外观自定义颜色（owlAppearance：强调色 + 深浅各自的背景/前景）同源加载；
		// 侧边卡片配置（owlSidebar）同源拉取，供工作台/快捷入口即时生效。
		void client
			.request<{ agentDir: string; settings: unknown }>({ type: "settings.get" })
			.then((response) => {
				if (!response.ok) return;
				if (response.result?.agentDir) setAgentDir(response.result.agentDir);
				const settings = response.result?.settings as Record<string, unknown> | undefined;
				if (isThemePreference(settings?.theme)) setThemePreference(settings.theme);
				applyOwlAppearance(parseOwlAppearance(settings?.owlAppearance));
				// 动态壁纸：写 <html data-owl-wallpaper> 门控属性 + 同步渲染层状态
				const wallpaperSettings = parseOwlWallpaper(settings?.owlWallpaper);
				applyOwlWallpaper(wallpaperSettings);
				setWallpaper(wallpaperSettings);
				setSidebarConfig(parseSidebarSettings(settings?.owlSidebar));
				applyChatAppearance(parseChatAppearance(settings?.desktopChatAppearance));
				// 界面语言随 settings.json 启动加载；设置页/左下角菜单切换后经 settings.set 持久化。
				setUiLanguageSetting(parseUiLanguageSetting(settings?.uiLanguage));
				// 通知偏好（owlNotifications）：启动时同步进模块级缓存，notifyAgentStatus 据此门控
				setNotificationPrefs(parseNotificationPrefs(settings?.owlNotifications));
			})
			.catch(() => {});
		// 工作目录必须存在，否则 session.create 会失败（默认目录首启、或本地记录的目录被删）。
		// project.create 即 mkdir -p：目录已有时是幂等空操作，顺带把路径规范化后回填显示。
		void client
			.request<{ path: string }>({ type: "project.create", path: workspaceRef.current })
			.then((response) => {
				if (response.ok && response.result?.path) setWorkspaceDir(response.result.path);
			})
			.catch(() => {});
	}, [connected, client]);

	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		void client.request<SessionRowLite[]>({ type: "session.list" }).then((response) => {
			if (cancelled || !response.ok || !response.result) return;
			const next = new Map<string, string>();
			for (const row of response.result) {
				if (!row.id) continue;
				next.set(row.id, islandSessionTitle(row, {
					unnamed: t("sidebar.sessionUnnamed"),
					branch: t("app.branchSuffix"),
					fallback: t("sidebar.sessionFallback", { id: row.id.slice(0, 8) }),
				}));
			}
			setListedTitles(next);
		}).catch(() => {});
		return () => { cancelled = true; };
	}, [client, connected, sidebarRev, runningSessions, t]);

	// Agent 预设花名册（内置 + 自定义 + 全局默认）：连接后拉取，设置页改动后由 preset.list 刷新。
	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		void client
			.request<{ presets: AgentPresetDefinition[]; defaultPreset: string }>({ type: "preset.list" })
			.then((response) => {
				if (cancelled || !response.ok || !response.result) return;
				setAgentPresets(response.result.presets);
				setDefaultPresetId(response.result.defaultPreset);
			})
			.catch(() => {});
		return () => { cancelled = true; };
	}, [client, connected]);

	function selectedModel(): { provider: string; model: string } | undefined {
		const value = modelValue;
		if (!value) return undefined;
		const slash = value.indexOf("/");
		if (slash <= 0) return undefined;
		return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
	}

	// 会话状态（模型/思考/上下文用量）：创建、恢复、每轮对话结束后刷新。
	async function refreshStats(id?: string): Promise<void> {
		const target = id ?? sessionIdRef.current;
		if (!target) return;
		try {
			const response = await client.request<SessionStatsResult>({ type: "session.stats", sessionId: target });
			// 落地时会话可能已切走：过期统计画进当前会话就是用量环/模型名串话
			if (response.ok && target === sessionIdRef.current) {
				setSessionInfo(response.result ?? undefined);
				if (response.result?.queue) {
					setPromptQueues((current) => ({ ...current, [target]: response.result!.queue! }));
				}
			}
		} catch {
			// 桥断开时静默跳过，重连后下一轮会重新拉取
		}
	}

	// 导出当前会话日志（头部下载菜单）：桥端把文件写进下载目录，前端唤起资源
	// 管理器定位；每一步的结果都写进 exportNotice，绝不静默失败。
	// turnEntryIds 提供时（勾选历史分享）只导出所选轮次，其余整支导出。
	async function exportSessionLog(format: SessionExportFormat, turnEntryIds?: string[]): Promise<void> {
		// research 视图里导的是 research 会话；普通视图导当前会话
		const target = railView === "research" ? researchSessionId : sessionIdRef.current;
		if (!target || exportingLog) return;
		setExportNotice(undefined);
		setExportingLog(true);
		try {
			const response = await client.request<SessionExportLogResult>({
				type: "session.exportLog",
				sessionId: target,
				format,
				...(turnEntryIds ? { turnEntryIds } : {}),
			});
			if (!response.ok || !response.result) {
				throw new Error(response.error ?? t("api.opFailed", { what: t("app.downloadSessionLog") }));
			}
			const { filename, content, savedPath } = response.result;
			if (!savedPath) {
				// 旧桥不落盘：桌面壳里 blob 下载会被 WebView2 静默丢弃，必须提示重建；
				// 纯浏览器（node serve 直开）blob 下载可用
				if (hasTauri()) throw new Error(t("app.exportSessionStaleBridge"));
				downloadTextFile(content, filename, format === "jsonl" ? "text/plain" : "text/markdown");
				return;
			}
			const reveal = await revealInFileManager(savedPath);
			if (reveal.ok) {
				setExportNotice({ text: t("app.exportSessionSaved", { path: savedPath }), tone: "info" });
			} else {
				setExportNotice({
					text: t("app.exportSessionSavedNoReveal", { path: savedPath, message: reveal.error ?? "" }),
					tone: "error",
				});
			}
		} catch (error) {
			setExportNotice({ text: error instanceof Error ? error.message : String(error), tone: "error" });
		} finally {
			setExportingLog(false);
		}
	}

	// 壁纸轮播：到点在可用壁纸列表里顺次/随机切换并落盘。就绪门在渲染层
	// （staging 层加载完成才接管），切换不会黑屏；本机文件路径优先时轮播暂停。
	useEffect(() => {
		if (!wallpaper.enabled || !wallpaper.rotationEnabled || wallpaper.customPath.trim()) return;
		const intervalMs = Math.max(1, wallpaper.rotationInterval) * 60_000;
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const entries = await fetchInventory();
					const pool = entries.filter(
						(entry) =>
							entry.id !== wallpaper.selectionId &&
							(entry.mediaUrl || entry.webUrl || entry.sceneSrc || entry.previewUrl) &&
							passesRating(entry, wallpaper.contentRating),
					);
					if (!pool.length) return;
					let picked: (typeof pool)[number];
					if (wallpaper.rotationOrder === "random") {
						picked = pool[Math.floor(Math.random() * pool.length)];
					} else {
						const at = pool.findIndex((entry) => entry.id === wallpaper.selectionId);
						picked = pool[(at + 1) % pool.length] ?? pool[0];
					}
					const next = parseOwlWallpaper({ ...wallpaper, selectionId: picked.id });
					setWallpaper(next);
					applyOwlWallpaper(next);
					await client.request({ type: "settings.set", values: { owlWallpaper: next } });
				} catch {
					// 清单拉不到（桥重启中等）：下个周期再试
				}
			})();
		}, intervalMs);
		return () => clearTimeout(timer);
	}, [wallpaper, client]);

	async function ensureSession(): Promise<string | undefined> {
		if (sessionIdRef.current) return sessionIdRef.current;
		if (creatingSessionRef.current) return undefined;
		creatingSessionRef.current = true;
		try {
			const response = await client.request<{ sessionId: string }>({
				type: "session.create",
				cwd: workspaceRef.current,
				...selectedModel(),
				thinkingLevel,
				approvalMode,
				...(stagedPresetRef.current ? { agentPreset: stagedPresetRef.current } : {}),
			});
			if (!response.ok || !response.result) {
				console.error("session.create failed:", response.error);
				setEntries([
					{ kind: "toolResult", toolName: t("app.sessionCreateFailed"), ok: false, brief: response.error ?? t("app.unknownError") },
				]);
				return undefined;
			}
			const id = response.result.sessionId;
			sessionIdRef.current = id;
			setSessionId(id);
			setEntries([]);
			setRetryStatus(null);
			setSessionBranched(false);
			setSessionName(undefined);
			setSessionPreset(stagedPreset || undefined);
			void refreshStats(id);
			return id;
		} finally {
			creatingSessionRef.current = false;
		}
	}

	const newChat = (): void => {
		sessionViewSeq.current += 1;
		sessionIdRef.current = undefined;
		setSessionId(undefined);
		setEntries([]);
		setRetryStatus(null);
		setSessionInfo(undefined);
		setSessionBranched(false);
		setSessionName(undefined);
		setSessionPreset(undefined);
		void ensureSession();
	};

	// 插件市场「引入」：新开一条会话并自动发出改造任务书，然后跳到该会话看 Agent 干活。
	// 任务书里已注明 owl 与 pi/DSH 接口不兼容、产物装到 agent 目录；后续权限类操作走常规确认流。
	const importPluginToNewSession = async (promptText: string): Promise<void> => {
		const response = await client.request<{ sessionId: string }>({
			type: "session.create",
			cwd: workspaceRef.current,
			...selectedModel(),
			thinkingLevel,
			approvalMode,
			...(stagedPresetRef.current ? { agentPreset: stagedPresetRef.current } : {}),
		});
		if (!response.ok || !response.result?.sessionId) throw new Error(response.error ?? t("app.unknownError"));
		const id = response.result.sessionId;
		sessionViewSeq.current += 1;
		setShowSettings(false);
		setRailView("chat");
		setConversationViewPersisted("chat");
		await openSession(id);
		const promptResponse = await client.request({ type: "session.prompt", sessionId: id, message: promptText });
		if (!promptResponse.ok) throw new Error(promptResponse.error ?? t("app.sendFailedMsg"));
	};

	// 换工作目录 = 从新会话开始；会话历史按项目分目录存（Owl-history\<编码cwd>），
	// 不随切换丢失，随时可从侧边栏切回。首个 prompt 时才在目标目录下创建会话。
	const resetToWorkspace = (path: string): void => {
		sessionViewSeq.current += 1;
		setResearchConversationTitle(undefined);
		setResearchResumeRequest(undefined);
		setResearchSessionId(undefined);
		sessionIdRef.current = undefined;
		setWorkspaceDir(path);
		localStorage.setItem(WORKSPACE_KEY, path);
		setSessionId(undefined);
		setEntries([]);
		setRetryStatus(null);
		setSessionInfo(undefined);
		setSessionBranched(false);
		setSessionName(undefined);
		setSessionPreset(undefined);
	};

	// 切换项目：绑定目录（chip 显示）并从新会话开始。
	const switchProject = (path: string): void => {
		resetToWorkspace(path);
		setWorkspaceSelected(true);
		localStorage.setItem(WORKSPACE_SELECTED_KEY, "1");
	};

	// 叉掉目录（输入框 chip 上的 ✕）：不选目录对话，会话默认进 DEFAULT_WORKSPACE_DIR。
	// 当前会话已经在默认目录时原地继续，不打断；否则换到默认目录并从新会话开始。
	const clearWorkspaceSelection = (): void => {
		if (!workspaceSelected) return;
		setWorkspaceSelected(false);
		localStorage.setItem(WORKSPACE_SELECTED_KEY, "0");
		if (samePath(workspaceRef.current, DEFAULT_WORKSPACE_DIR)) return;
		resetToWorkspace(DEFAULT_WORKSPACE_DIR);
	};

	// 恢复历史会话：回放消息快照、切到该会话的项目视图，后续 prompt 直接续聊。
	// silent：自动恢复专用——失败不留错误横幅，退回空白新会话即可（用户没主动点过它）。
	const openSession = async (targetSessionId: string, options?: { silent?: boolean; preserveRail?: boolean }): Promise<void> => {
		const requestSeq = ++sessionViewSeq.current;
		const response = await client.request<{
			sessionId: string;
			cwd: string;
			messages: Record<string, unknown>[];
			messageEntryIds?: (string | undefined)[];
			researchMode?: ResearchMode;
			/** 会话头（含 parentSession）：分支出来的无名会话顶栏标题要加「· 分支」后缀 */
			header?: { parentSession?: string };
			/** 会话持久化显示名（session_info，如分支的「fork2 · 来自「你好」」） */
			name?: string;
			/** 会话绑定的 Agent 预设 id：顶栏标签与选择器显示它。 */
			agentPreset?: string;
		}>({
			type: "session.resume",
			sessionId: targetSessionId,
			approvalMode,
			...selectedModel(),
		});
		// 响应落地前用户又做了新的会话切换：这份过期响应整体丢弃（含错误横幅，
		// 免得旧会话的失败盖在别的会话视图上）
		if (requestSeq !== sessionViewSeq.current) return;
		if (!response.ok || !response.result) {
			console.error("session.resume failed:", response.error);
			if (!options?.silent) {
				setEntries([
					{ kind: "toolResult", toolName: t("app.sessionRestoreFailed"), ok: false, brief: response.error ?? t("app.unknownError") },
				]);
			}
			return;
		}
		const { sessionId: resumedId, cwd, messages, messageEntryIds, researchMode } = response.result;
		if (researchMode !== undefined) {
			if (options?.preserveRail) return;
			if (options?.silent && railViewRef.current !== "chat") return;
			if (!samePath(cwd, workspaceRef.current)) switchProject(cwd);
			setShowSettings(false);
			setResearchMounted(true);
			setRailView("research");
			setResearchResumeRequest({ id: resumedId, revision: ++researchActionSequence.current });
			return;
		}
		if (!options?.preserveRail && !options?.silent && railViewRef.current === "research") setRailView("chat");
		setWorkspaceDir(cwd);
		localStorage.setItem(WORKSPACE_KEY, cwd);
		setSessionId(resumedId);
		sessionIdRef.current = resumedId;
		setEntries(rebuild(messages, messageEntryIds));
		setRetryStatus(null);
		setSessionBranched(Boolean(response.result.header?.parentSession));
		setSessionName(response.result.name);
		setSessionPreset(response.result.agentPreset);
		void refreshStats(resumedId);
	};

	// 上一个/下一个会话（Ctrl+Shift+[ / ]）：当前项目内按最近活跃排序循环切换。
	// 与侧边栏同源（session.list），排除归档行；桥瞬断时静默放弃。
	const cycleSession = async (direction: 1 | -1): Promise<void> => {
		try {
			const scope = railViewRef.current === "research" ? "research" : "chat";
			const response = await client.request<SessionRowLite[]>({ type: "session.list", scope });
			if (!response.ok || !response.result) return;
			const rows = response.result
				.filter((row) => matchesSessionScope(row, scope) && row.id && typeof row.archivedAt !== "string" && samePath(row.cwd, workspaceRef.current))
				.sort((a, b) => rowTime(b).localeCompare(rowTime(a)));
			if (rows.length === 0) return;
			const index = rows.findIndex((row) => row.id === panelSessionIdRef.current);
			const next = rows[(index + direction + rows.length) % rows.length];
			if (!next || next.id === panelSessionIdRef.current) return;
			setShowSettings(false);
			if (scope === "chat") setRailView("chat");
			await openSession(String(next.id));
		} catch {
			// 桥离线：菜单项通常已禁用，快捷键静默放弃
		}
	};

	// 启动自动续聊：连接后自动恢复当前项目最近一个有消息的会话（Claude Desktop 同款行为）。
	// 每次启动只尝试一次；若用户抢先发消息/点会话（sessionId 已就位），则不打扰。
	const restoreTriedRef = useRef(railView === "research");
	useEffect(() => {
		if (!connected || restoreTriedRef.current || railView === "research") return;
		restoreTriedRef.current = true;
		void (async () => {
			try {
				const response = await client.request<SessionRowLite[]>({ type: "session.list", scope: "chat" });
				if (!response.ok || !response.result) return;
				const rows = response.result.filter((row) => matchesSessionScope(row, "chat") && row.id && samePath(row.cwd, workspaceRef.current));
				if (rows.length === 0) return;
				// 优先有消息的会话：新会话按钮创建的空会话不算「上次正在聊的内容」。
				const withMessages = rows.filter((row) => (row.messageCount ?? 0) > 0);
				const pool = withMessages.length > 0 ? withMessages : rows;
				const latest = pool.reduce((a, b) => (rowTime(a) >= rowTime(b) ? a : b));
				if (sessionIdRef.current) return;
				await openSession(String(latest.id), { silent: true });
			} catch {
				// 桥瞬断时静默放弃，侧边栏手动点会话仍可恢复
			}
		})();
	}, [connected, client, railView]); // eslint-disable-line react-hooks/exhaustive-deps

	// 输入框项目选择器的候选列表：session.list 的项目 ∪ 到访过的项目 ∪ 当前项目（与侧边栏同源）。
	// 保留目录（默认目录/助理目录）只在被选中为当前项目时进入候选；切项目 / 侧边栏重拉
	// （恢复、删除归档）时刷新；桥瞬断静默跳过。
	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		void client
			.request<SessionRowLite[]>({ type: "session.list" })
			.then((response) => {
				if (!response.ok || !response.result || cancelled) return;
				for (const scope of ["chat", "research"] as const) {
					const seen = new Map<string, string>();
					const track = (path: string | undefined): void => {
						if (!path) return;
						if (isReservedDir(path) && !(workspaceSelected && samePath(path, workspaceRef.current))) return;
						const key = normPath(path);
						if (!seen.has(key)) seen.set(key, path);
					};
					track(workspaceRef.current);
					for (const row of response.result) if (matchesSessionScope(row, scope)) track(row.cwd);
					for (const path of loadSidebarStrings(localStorage, sidebarStorageKeys(scope).projects)) track(path);
					if (scope === "research") setResearchProjects([...seen.values()]);
					else setProjects([...seen.values()]);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [connected, client, workspaceDir, workspaceSelected, sidebarRev, railView, researchSessionId, sessionId]);

	// 斜杠命令清单：随项目（技能/模板按 cwd 扫描）与会话（扩展命令挂在运行时上）刷新。
	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		void client
			.request<CommandsListResult>({ type: "commands.list", cwd: workspaceRef.current })
			.then((response) => {
				if (!cancelled && response.ok && response.result) setSlashCommands(response.result.commands);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [connected, client, workspaceDir, sessionId]);

	// 输入栏的模型/思考切换：未建会话时只记选择（localStorage + 状态），
	// 已有会话则即时下发到运行中的 session（setModel 自带思考级别自适应）。
	const handleModelChange = (value: string): void => {
		setModelValue(value);
		localStorage.setItem(MODEL_KEY, value);
		const current = sessionIdRef.current;
		if (!current) return;
		const spec = (() => {
			const slash = value.indexOf("/");
			return slash > 0 ? { provider: value.slice(0, slash), model: value.slice(slash + 1) } : undefined;
		})();
		if (!spec) return;
		void client
			.request<SessionStatsResult>({ type: "session.setModel", sessionId: current, ...spec })
			.then((response) => {
				// 落地时会话可能已切走，过期统计不画
				if (response.ok && response.result && current === sessionIdRef.current) setSessionInfo(response.result);
			})
			.catch(() => {});
	};

	const handleThinkingChange = (level: string): void => {
		setThinkingLevel(level);
		localStorage.setItem(THINKING_KEY, level);
		const current = sessionIdRef.current;
		if (!current) return;
		void client
			.request<SessionStatsResult>({ type: "session.setThinkingLevel", sessionId: current, level })
			.then((response) => {
				if (response.ok && response.result && current === sessionIdRef.current) setSessionInfo(response.result);
			})
			.catch(() => {});
	};

	// 审批模式切换：与模型/思考同款——先记本地，再有会话就即时下发（下次工具调用生效）。
	const handleApprovalModeChange = (mode: ApprovalMode): void => {
		setApprovalMode(mode);
		localStorage.setItem(APPROVAL_KEY, mode);
		const current = sessionIdRef.current;
		if (!current) return;
		void client
			.request({ type: "session.setApprovalMode", sessionId: current, approvalMode: mode })
			.catch(() => {});
	};

	// Agent 预设选择：空白/新会话换组合，跑过第一轮的会话由桥端拒绝（preset-locked）——
	// 此时选择只更新暂存（新会话生效），当前会话继续显示自己的绑定。
	const handleAgentPresetSelect = (id: string): void => {
		setStagedPreset(id);
		stagedPresetRef.current = id;
		localStorage.setItem(PRESET_KEY, id);
		const current = sessionIdRef.current;
		if (!current || entries.length > 0) return;
		void client
			.request<{ agentPreset: string }>({ type: "session.setPreset", sessionId: current, agentPreset: id })
			.then((response) => {
				if (response.ok) setSessionPreset(id);
			})
			.catch(() => {});
	};

	// 设置页「让 Agent 帮我创建预设模式」：切到创造模式，空白会话直接换、否则开新会话，
	// 再把引导语填进输入框（不发出去，让用户补一句自己的需求）。
	const handleAskAgentCreatePreset = (): void => {
		setShowSettings(false);
		setRailView("chat");
		if (sessionIdRef.current && entries.length === 0) {
			handleAgentPresetSelect("cordis");
		} else {
			setStagedPreset("cordis");
			stagedPresetRef.current = "cordis";
			localStorage.setItem(PRESET_KEY, "cordis");
			setSessionPreset(undefined);
			newChat();
		}
		setDraftRequest({ id: ++draftSequence.current, text: t("settings.presets.creatorPrompt") });
	};

	// 桌面内置斜杠命令：都在界面/桥本地执行，session.prompt 不认识它们，绝不能当文本发给模型。
	// 技能（/skill:name）、提示词模板、扩展命令不在此列，原样发送由核心展开执行。
	const executeBuiltinCommand = async (name: string, args: string): Promise<boolean> => {
		switch (name) {
			case "new":
				newChat();
				return true;
			case "settings":
				setShowSettings(true);
				return true;
			case "model": {
				const spec = args.trim();
				if (!spec) {
					setEntries((current) => [
						...current,
						{ kind: "toolResult", toolName: "/model", ok: false, brief: t("app.modelUsage") },
					]);
					return true;
				}
				handleModelChange(spec);
				return true;
			}
			case "thinking": {
				const level = args.trim();
				if (!level) {
					setEntries((current) => [
						...current,
						{ kind: "toolResult", toolName: "/thinking", ok: false, brief: t("app.thinkingUsage") },
					]);
					return true;
				}
				handleThinkingChange(level);
				return true;
			}
			case "compact": {
				const target = await ensureSession();
				if (!target) return true;
				setEntries((current) => [
					...current,
					{ kind: "toolResult", toolName: t("app.compactTool"), ok: true, brief: t("app.compactStarted") },
				]);
				try {
					const response = await client.request<SessionStatsResult>({ type: "session.compact", sessionId: target });
					setEntries((current) => [
						...current,
						response.ok
							? { kind: "toolResult", toolName: t("app.compactTool"), ok: true, brief: t("app.compactDone") }
							: { kind: "toolResult", toolName: t("app.compactTool"), ok: false, brief: response.error ?? t("app.compactFailed") },
					]);
					if (response.ok && response.result) setSessionInfo(response.result);
				} catch (error) {
					setEntries((current) => [
						...current,
						{
							kind: "toolResult",
							toolName: t("app.compactTool"),
							ok: false,
							brief: error instanceof Error ? error.message : String(error),
						},
					]);
				}
				return true;
			}
			default:
				return false;
		}
	};

	const sendPrompt = async (message: string, images?: ComposerImage[], attachedPaths?: string[], delivery?: "queue" | "steer"): Promise<void> => {
		const hasImages = (images?.length ?? 0) > 0;
		const hasAttachments = (attachedPaths?.length ?? 0) > 0;
		const queueing = running;
		if (!connected || submitInFlight.current || (!message.trim() && !hasImages && !hasAttachments)) return;
		submitInFlight.current = true;
		setSubmitting(true);
		let target: string | undefined;
		try {
		// "/命令 参数" 形态先过内置命令表：只拦 kind=builtin 且当前清单里确实是内置的
		// 名字（扩展命令若与内置同名，桥端清单里它是 extension，让位给扩展）。
		const match = /^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
		if (match) {
			const [, name, args] = match;
			const entry = slashCommands.find((candidate) => candidate.name === name);
			if (entry?.kind === "builtin" && (await executeBuiltinCommand(name, args ?? ""))) return;
		}
		target = await ensureSession();
		if (!target) return;
		// 新消息接管会话：若该会话此前被暂停，解除暂停态（按钮回到发送/暂停的常规轮转）。
		setPausedSessions((current) => {
			if (!current.has(target!)) return current;
			const next = new Set(current);
			next.delete(target!);
			return next;
		});
		if (!queueing) {
			setEntries((current) => [
				...current,
				// 乐观行先取本地时钟，entry_appended 事件随后补 entryId。
				// 运行中的排队和追加不写进对话，等 queue_update 出现在输入框上方。
				{ kind: "user", text: message, timestamp: Date.now(), ...(hasImages ? { images: images!.map(({ data, mimeType }) => ({ data, mimeType })) } : {}) },
			]);
			setPendingPrompts((current) => new Set(current).add(target!));
		}
		// 用户亲自发言：旧的"重试中/重试失败"横幅已过时（会话由新消息接管）
		setRetryStatus(null);
		const response = await client.request({
			type: "session.prompt",
			sessionId: target,
			message,
			...(queueing ? { streamingBehavior: delivery === "steer" ? "steer" as const : "followUp" as const } : {}),
			...(hasImages ? { images } : {}),
			...(hasAttachments ? { attachedPaths } : {}),
		});
		if (!response.ok) throw new Error(response.error ?? t("app.sendFailedMsg"));
		// Some extension commands finish before starting an agent run. Reconcile their
		// optimistic indicator with the bridge instead of leaving the input locked.
		const submittedSession = target;
		setTimeout(() => {
			void client.request<SessionRunningResult>({ type: "session.running" }).then((state) => {
				if (!state.ok || state.result?.running.includes(submittedSession) || runningSessionsRef.current.has(submittedSession)) return;
				setPendingPrompts((current) => {
					const next = new Set(current);
					next.delete(submittedSession);
					return next;
				});
			}).catch(() => {});
		}, 2000);
		} catch (error) {
			if (target) setPendingPrompts((current) => {
				const next = new Set(current);
				next.delete(target!);
				return next;
			});
			if (queueing) setDraftRequest({ id: ++draftSequence.current, text: message });
			if (!target || target === sessionIdRef.current) setEntries((current) => [...current, {
				kind: "toolResult", toolName: t("app.sendFailed"), ok: false, brief: error instanceof Error ? error.message : String(error),
			}]);
		} finally {
			submitInFlight.current = false;
			setSubmitting(false);
		}
	};

	const replyToSession = (target: string, message: string): void => {
		const text = message.trim();
		if (!connected || !text) return;
		const queueing = runningSessions.has(target) || pendingPrompts.has(target);
		setPausedSessions((current) => {
			if (!current.has(target)) return current;
			const next = new Set(current);
			next.delete(target);
			return next;
		});
		if (target === sessionIdRef.current && !queueing) {
			setEntries((current) => [...current, { kind: "user", text, timestamp: Date.now() }]);
			setRetryStatus(null);
		}
		if (!queueing) setPendingPrompts((current) => new Set(current).add(target));
		void client.request({ type: "session.prompt", sessionId: target, message: text, ...(queueing ? { streamingBehavior: "followUp" as const } : {}) }).then((response) => {
			if (!response.ok) throw new Error(response.error ?? t("app.sendFailedMsg"));
		}).catch((error: unknown) => {
			setPendingPrompts((current) => {
				if (!current.has(target)) return current;
				const next = new Set(current);
				next.delete(target);
				return next;
			});
			if (target === sessionIdRef.current) {
				setEntries((current) => [...current, {
					kind: "toolResult", toolName: t("app.sendFailed"), ok: false, brief: error instanceof Error ? error.message : String(error),
				}]);
			}
		});
	};

	const abort = async (): Promise<void> => {
		const target = sessionId;
		if (!target) return;
		outcomeRef.current.set(target, "aborted");
		// 停止请求失败必须可见：桥重启后旧会话不再挂载（Unknown session）或桥断开时，
		// 服务端不会再有 agent_settled 事件来解开运行态——本地同步清掉，按钮恢复可用。
		const fail = (brief: string): void => {
			setRunningSessions((current) => {
				if (!current.has(target)) return current;
				const next = new Set(current);
				next.delete(target);
				return next;
			});
			setPendingPrompts((current) => {
				if (!current.has(target)) return current;
				const next = new Set(current);
				next.delete(target);
				return next;
			});
			// 停止都没成功（多半会话已随桥重启消失），暂停态没有可恢复的对象，一并解开。
			setPausedSessions((current) => {
				if (!current.has(target)) return current;
				const next = new Set(current);
				next.delete(target);
				return next;
			});
			setEntries((current) => [...current, { kind: "toolResult", toolName: t("app.abortFailed"), ok: false, brief }]);
		};
		try {
			const response = await client.request({ type: "session.abort", sessionId: target });
			if (!response.ok) fail(response.error ?? t("app.unknownError"));
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	};

	// 暂停 = 先记住暂停态再中止当前回合；中止成功后按钮转为「继续」，等 agent_settled 解开运行态。
	const pauseSession = (): void => {
		const target = sessionId;
		if (!target) return;
		setPausedSessions((current) => new Set(current).add(target));
		void abort();
	};

	// 继续 = 解开暂停态并以隐藏消息续跑（session.continue）：模型带着被中断的完整
	// 上下文从断点接着做，转录里不出现伪造的「继续」用户消息，界面对此无感。
	const resumePaused = async (): Promise<void> => {
		const target = sessionId;
		if (!target || !connected || running || submitInFlight.current) return;
		submitInFlight.current = true;
		setSubmitting(true);
		// 乐观状态：暂停态解除 + 运行指示先挂起，按钮立即回到暂停图标，agent_start 随后接管
		setPausedSessions((current) => {
			if (!current.has(target)) return current;
			const next = new Set(current);
			next.delete(target);
			return next;
		});
		setPendingPrompts((current) => new Set(current).add(target));
		const reconcile = (): void => {
			setPendingPrompts((current) => {
				if (!current.has(target)) return current;
				const next = new Set(current);
				next.delete(target);
				return next;
			});
		};
		try {
			const response = await client.request({
				type: "session.continue",
				sessionId: target,
				message: t("app.resumePrompt"),
			});
			if (!response.ok) throw new Error(response.error ?? t("app.unknownError"));
			// 与 sendPrompt 同款对账：续跑迟迟没有 agent_start 时靠 running 查询解开指示灯
			setTimeout(() => {
				void client.request<SessionRunningResult>({ type: "session.running" }).then((state) => {
					if (!state.ok || state.result?.running.includes(target) || runningSessionsRef.current.has(target)) return;
					reconcile();
				}).catch(() => {});
			}, 2000);
		} catch (error) {
			reconcile();
			// 续跑失败（桥断开/会话消失）：恢复暂停态让「继续」按钮可重试，并把失败摆出来
			setPausedSessions((current) => new Set(current).add(target));
			setEntries((current) => [...current, {
				kind: "toolResult", toolName: t("app.resumeFailed"), ok: false, brief: error instanceof Error ? error.message : String(error),
			}]);
		} finally {
			submitInFlight.current = false;
			setSubmitting(false);
		}
	};

	// -- 顶栏（对照 DSH 会话头：标题 + 元信息 chips + 右侧功能簇） --------------
	const conversationBaseTitle = conversationTitleOf(entries, t("app.newConversation"));
	// 分支出来的会话顶栏标题加「· 分支」，和侧边栏的后缀规则一致
	const sessionTitle = sessionName ?? (sessionBranched ? `${conversationBaseTitle} · ${t("app.branchSuffix")}` : conversationBaseTitle);
	const mapModelValue = modelValue || (sessionInfo?.model ? `${sessionInfo.model.provider}/${sessionInfo.model.id}` : "");
	const mapModelSeparator = mapModelValue.indexOf("/");
	const mapModelName = providers.find((provider) => provider.id === mapModelValue.slice(0, mapModelSeparator))
		?.models.find((model) => model.id === mapModelValue.slice(mapModelSeparator + 1))?.name;
	const waitingForUser = Boolean(sessionId && (permissions.some((request) => request.sessionId === sessionId) || questions.some((question) => question.sessionId === sessionId)));
	const chatActivity: ChatActivity = running || submitting ? !connected ? "disconnected" : waitingForUser ? "waiting" : "working" : "idle";
	const owlPose = useSessionOwlPose(chatActivity, entries);

	const openSettings = (tab: SettingsInitialTab): void => {
		setSettingsInitialTab(tab);
		setShowSettings(true);
	};

	// 菜单与全局快捷键共用的动作集：每次渲染重建并同步进 shortcutsRef，
	// keydown 侧零依赖免 stale closure；语义与旧内联 props 保持一致
	// （面板/新会话先回到对话主区，设置页打开时先收起）。
	const navigation = useAppHistory({
		rail: railView,
		settings: showSettings,
		settingsTab: settingsInitialTab,
		chatSession: sessionId,
		researchSession: researchSessionId,
		workspace: workspaceDir,
	});
	const navigationSeq = useRef(0);
	const restorePlace = async (place: AppPlace, seq: number): Promise<void> => {
		// 作废还在飞的会话恢复，避免旧响应盖住这次回退。
		sessionViewSeq.current += 1;
		if (place.rail === "mail") setMailMounted(true);
			if (place.rail === "media") setMediaMounted(true);
			if (place.rail === "guide") setGuideMounted(true);
		if (place.rail === "career") setCareerMounted(true);
		if (place.rail === "automation") setAutomationMounted(true);
		if (place.rail === "monitor") setMonitorMounted(true);
		if (place.rail === "myself") setMyselfMounted(true);
		if (place.rail === "expert") setExpertMounted(true);
		if (place.rail === "bagu") setBaguMounted(true);
		if (place.rail === "research") setResearchMounted(true);
		if (place.rail === "evaluation") setEvaluationMounted(true);
		const openingChat = place.rail !== "research" && Boolean(place.chatSession) && place.chatSession !== sessionIdRef.current;
		if (openingChat && place.chatSession) {
			await openSession(place.chatSession, { preserveRail: true });
			if (seq !== navigationSeq.current) return;
			if (sessionIdRef.current !== place.chatSession) {
				navigation.abandon();
				return;
			}
		} else if (place.rail !== "research" && !place.chatSession && sessionIdRef.current) {
			sessionIdRef.current = undefined;
			setSessionId(undefined);
			setEntries([]);
			setRetryStatus(null);
			setSessionInfo(undefined);
			setSessionBranched(false);
			setSessionName(undefined);
		}
		if (seq !== navigationSeq.current) return;
		if (place.researchSession && place.researchSession !== researchSessionIdRef.current) {
			setResearchMounted(true);
			setResearchSessionId(place.researchSession);
			setResearchResumeRequest({ id: place.researchSession, revision: ++researchActionSequence.current });
		} else if (place.rail === "research" && !place.researchSession && researchSessionIdRef.current) {
			setResearchNewConversationRequest((current) => current + 1);
		}
		if (!openingChat && normPath(place.workspace) !== normPath(workspaceRef.current)) {
			setWorkspaceDir(place.workspace);
			localStorage.setItem(WORKSPACE_KEY, place.workspace);
		}
		setSettingsInitialTab(place.settingsTab);
		if (place.settings) setSettingsMountKey((key) => key + 1);
		setShowSettings(place.settings);
		setRailView(place.rail);
	};
	const visitPlace = (place: AppPlace | undefined): void => {
		if (!place) return;
		const seq = ++navigationSeq.current;
		void restorePlace(place, seq);
	};
	const shortcuts = {
		newChat: (): void => {
			setShowSettings(false);
			if (railView === "research") {
				setResearchNewConversationRequest((current) => current + 1);
				return;
			}
			setRailView("chat");
			newChat();
		},
		openProject: (): void => {
			if (railView !== "research") setRailView("chat");
			setShowProjectDialog(true);
		},
		closeWindow: (): void => { void closeMainWindow(); },
		quit: (): void => { void quitDesktopApp(); },
		openSettings: (): void => openSettings("general"),
		openAbout: (): void => openSettings("about"),
		showShortcuts: (): void => setHelpSection("shortcuts"),
		openGuide: (): void => setHelpSection("guide"),
		toggleSidebar: (): void => {
			if (railView === "news" && !showSettings) {
				setNewsSidebarMinimized((current) => {
					const next = !current;
					localStorage.setItem(NEWS_SIDEBAR_MINIMIZED_KEY, next ? "1" : "0");
					return next;
				});
				return;
			}
			if (showSettings) {
				setShowSettings(false);
				if (sidebarMinimized) toggleSessionSidebar();
			}
			else toggleSessionSidebar();
		},
		toggleBottomPanel: (): void => {
			setShowSettings(false);
			if (railView !== "research") setRailView("chat");
			toggleTerminalPanel();
		},
		toggleRightPanel: (): void => {
			setShowSettings(false);
			if (railView !== "research") setRailView("chat");
			toggleSidebarPanel();
		},
		openTerminal: (): void => openInPanel("terminal"),
		openBrowserTab: (): void => openInPanel("browser"),
		openTasks: (): void => openInPanel("tasks"),
		openDeveloper,
		toggleChatContext: (): void => {
			setShowSettings(false);
			if (railView === "research") setResearchConversationViewPersisted(researchConversationView === "chat" ? "context" : "chat");
			else {
				setRailView("chat");
				setConversationViewPersisted(conversationView === "chat" ? "context" : "chat");
			}
		},
		prevSession: (): void => { void cycleSession(-1); },
		nextSession: (): void => { void cycleSession(1); },
		historyBack: (): void => visitPlace(navigation.back()),
		historyForward: (): void => visitPlace(navigation.forward()),
		find: (): void => setFindOpen(true),
		zoomIn: (): void => zoomStep(1),
		zoomOut: (): void => zoomStep(-1),
		zoomReset: (): void => setZoom(1),
		openIsland: (): void => islandJumpRef.current?.(),
		toggleFullscreen: (): void => {
			const next = !fullscreenRef.current;
			setFullscreen(next);
			void setWindowFullscreen(next);
		},
	};
	const shortcutsRef = useRef(shortcuts);
	shortcutsRef.current = shortcuts;
	titleForRef.current = (id: string) => {
		if (id === sessionId) return sessionTitle;
		if (id === researchSessionId && researchConversationTitle) return researchConversationTitle;
		return listedTitles.get(id) ?? t("sidebar.sessionFallback", { id: id.slice(0, 8) });
	};
	const islandIds = activityOrder.filter((id) => runningSessions.has(id));
	for (const id of runningSessions) if (!islandIds.includes(id)) islandIds.push(id);
	const islandRunning = islandIds.map((id) => {
		const needsPermission = permissions.some((request) => request.sessionId === id);
		const asked = questions.find((request) => request.sessionId === id);
		const needsQuestion = Boolean(asked);
		return {
			id,
			title: titleForRef.current(id),
			lastActivityAt: activityAtRef.current.get(id) ?? 0,
			startedAt: startedAtRef.current.get(id) ?? activityAtRef.current.get(id) ?? 0,
			step: stepRev >= 0 ? stepRef.current.get(id) ?? "" : "",
			waiting: needsPermission || needsQuestion,
			waitKind: needsPermission ? "permission" as const : needsQuestion ? "question" as const : "" as const,
			whisper: islandWhisper(asked?.questions[0]?.header || asked?.questions[0]?.question || ""),
		};
	});

	return (
		<div className="owl-desktop-shell font-sans text-owl-text">
			<WallpaperLayer settings={wallpaper} />
			{/* 媒体桥全局覆盖层（顶部歌词条 + 深背景）：各自有开关，默认都不渲染。 */}
			<MediaOverlays />
			<DesktopTitlebar
				connected={connected}
				sidebarCollapsed={railView === "news" && !showSettings ? newsSidebarMinimized : sidebarMinimized || showSettings}
				sidebarView={railView === "media" ? "chat" : railView}
				sidebarToggleRef={sidebarToggleRef}
				terminalOpen={terminalOpen}
				sidebarOpen={sidebarOpen}
				fullscreen={fullscreen}
				onToggleSidebar={shortcuts.toggleSidebar}
				onNewChat={shortcuts.newChat}
				onOpenProject={shortcuts.openProject}
				onCloseWindow={shortcuts.closeWindow}
				onQuit={shortcuts.quit}
				onOpenSettings={shortcuts.openSettings}
				onOpenAbout={shortcuts.openAbout}
				onOpenDeveloper={shortcuts.openDeveloper}
				onToggleBottomPanel={shortcuts.toggleBottomPanel}
				onToggleRightPanel={shortcuts.toggleRightPanel}
				onOpenTerminal={shortcuts.openTerminal}
				onOpenBrowserTab={shortcuts.openBrowserTab}
				onOpenTasks={shortcuts.openTasks}
				onToggleChatContext={shortcuts.toggleChatContext}
				onPrevSession={shortcuts.prevSession}
				onNextSession={shortcuts.nextSession}
				onOpenIsland={shortcuts.openIsland}
				onHistoryBack={shortcuts.historyBack}
				onHistoryForward={shortcuts.historyForward}
				canHistoryBack={navigation.canBack}
				canHistoryForward={navigation.canForward}
				onFind={shortcuts.find}
				onZoomIn={shortcuts.zoomIn}
				onZoomOut={shortcuts.zoomOut}
				onZoomReset={shortcuts.zoomReset}
				onToggleFullscreen={shortcuts.toggleFullscreen}
				onOpenGuide={shortcuts.openGuide}
				onShowShortcuts={shortcuts.showShortcuts}
				onOpenEvaluation={() => {
					setShowSettings(false);
					setEvaluationMounted(true);
					setRailView("evaluation");
				}}
				onOpenResearch={() => {
					setShowSettings(false);
					setResearchMounted(true);
					setRailView("research");
				}}
				onOpenLifeGuide={() => {
					// 火柴人按钮 = 打开/关闭指南面板（再点一次回到会话）。
					setShowSettings(false);
					setGuideMounted(true);
					setRailView(railViewRef.current === "guide" ? "chat" : "guide");
				}}
				onOpenTokenCareer={() => {
					// Token 生涯按钮 = 打开/关闭生涯看板（再点一次回到会话）。
					setShowSettings(false);
					setCareerMounted(true);
					setRailView(railViewRef.current === "career" ? "chat" : "career");
				}}
				onOpenLifeMonitor={() => {
					const opening = railViewRef.current !== "monitor";
					setShowSettings(false);
					setMonitorMounted(true);
					setRailView(opening ? "monitor" : "chat");
					if (opening) lifeProbe.refresh();
				}}
				lifeDot={lifeView.summary.dot}
				lifeCount={lifeView.summary.count}
				island={(
					<DynamicIsland
						running={islandRunning}
						notice={doneNotice}
						titleOf={(id) => titleForRef.current(id)}
						jumpToFace={islandJumpRef}
						permissionFor={(id) => {
							const request = permissions.find((item) => item.sessionId === id);
							return request ? { requestId: request.requestId } : undefined;
						}}
						choicesFor={(id) => {
							const request = questions.find((item) => item.sessionId === id);
							if (!request) return undefined;
							const labels = islandQuestionChoices({
								count: request.questions.length,
								multi: request.questions[0]?.multiSelect ?? false,
								labels: request.questions[0]?.options.map((option) => option.label) ?? [],
							});
							return labels.length > 0 ? { requestId: request.requestId, labels } : undefined;
						}}
						onPermission={(requestId, approved) => {
							answerAndRestore(requestId, permissionsRef, setPermissions, () => client.respondPermission(requestId, approved));
						}}
						onChoose={(requestId, label) => {
							answerAndRestore(requestId, questionsRef, setQuestions, () => client.respondQuestion(requestId, [{ index: 0, selectedLabels: [label] }], false));
						}}
						onReply={replyToSession}
						onOpen={(id) => {
							setShowSettings(false);
							void openSession(id);
						}}
					/>
				)}
			/>
			<div className="owl-desktop-body">
			<ActivityRail
				view={railView}
				settingsOpen={showSettings}
				onHome={() => {
					setShowSettings(false);
					setRailView("chat");
					setConversationViewPersisted("chat");
					setHelpSection(undefined);
				}}
						onOpenSettings={openSettings}
						onOpenGuide={shortcuts.openGuide}
						onShowShortcuts={shortcuts.showShortcuts}
						onPersistUiLanguage={(next: UiLanguageSetting) => {
							void client.request({ type: "settings.set", values: { uiLanguage: next } }).catch(() => {});
						}}
				onSelect={(view) => { setShowSettings(false); setRailView(view); if (view === "mail") setMailMounted(true); if (view === "media") setMediaMounted(true); if (view === "research") setResearchMounted(true); if (view === "automation") setAutomationMounted(true); if (view === "myself") setMyselfMounted(true); if (view === "expert") setExpertMounted(true); if (view === "bagu") setBaguMounted(true); if (view === "market") setMarketMounted(true); }}
			/>
			<SessionSidebar
				key={sessionScope}
				client={client}
				sessionScope={sessionScope}
				connected={connected}
				activeId={railView === "research" ? researchSessionId : sessionId}
				// 未选目录时侧栏没有「当前项目」：保留目录也随之从「项目」分组隐藏，会话走「最近会话」。
				activeProject={workspaceSelected ? workspaceDir : ""}
				refreshKey={(railView === "research" ? researchSessionId : sessionId) ?? ""}
				revision={sidebarRev}
				focus={railView}
				conversationVisible={!showSettings && (railView === "chat" ? conversationView === "chat" : railView === "research" && researchConversationView === "chat")}
				minimized={sidebarMinimized || showSettings || (railView !== "chat" && railView !== "research")}
				onToggleMinimized={toggleSessionSidebar}
				runningSessions={runningSessions}
				onNewChat={shortcuts.newChat}
				onNewChatInProject={(path) => {
					if (samePath(path, workspaceRef.current)) shortcuts.newChat();
					else {
						switchProject(path);
						if (railViewRef.current === "research") setResearchNewConversationRequest((current) => current + 1);
					}
				}}
				onSelectProject={switchProject}
				onOpenSession={(id) => void openSession(id)}
			/>
			<div className="owl-map-view" data-owl-island-anchor="" style={{ display: railView === "map" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
				<MapWorkspace
					active={railView === "map" && !showSettings}
					sidebarCollapsed={sidebarMinimized}
					client={client}
					connected={connected}
					cwd={workspaceDir}
					model={mapModelValue}
					modelName={mapModelName}
					thinkingLevel={thinkingLevel}
					approvalMode={approvalMode}
					questions={questions}
					onAnswerQuestion={(requestId, answers, cancelled) => {
						answerAndRestore(requestId, questionsRef, setQuestions, () => client.respondQuestion(requestId, answers, cancelled));
					}}
				/>
			</div>
			<div data-owl-island-anchor="" style={{ display: railView === "news" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
				<NewsPage client={client} active={railView === "news" && !showSettings} sidebarCollapsed={newsSidebarMinimized} initialTarget={newsTarget} onOpenModelSettings={() => {
					setSettingsInitialTab("models");
					setShowSettings(true);
				}} onToChat={(text) => {
					setRailView("chat"); setShowSettings(false); setConversationViewPersisted("chat");
					setDraftRequest({ id: ++draftSequence.current, text });
				}} />
			</div>
			{/* 「项目」页（Codex 式一览）：与 news 同款常挂载 + display 切换；创建走项目页模式（不跳走）。 */}
			<div data-owl-island-anchor="" style={{ display: railView === "projects" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<ProjectsPage
					client={client}
					connected={connected}
					active={railView === "projects" && !showSettings}
					runningSessions={runningSessions}
					revision={sidebarRev}
					activeProject={workspaceSelected ? workspaceDir : ""}
					onOpenSession={(id) => {
						setShowSettings(false);
						setRailView("chat");
						void openSession(id);
					}}
					onNewChatInProject={(path) => {
						setShowSettings(false);
						if (samePath(path, workspaceRef.current)) shortcuts.newChat();
						else {
							switchProject(path);
							setRailView("chat");
						}
					}}
					onCreateProject={() => {
						setProjectDialogStay(true);
						setShowProjectDialog(true);
					}}
				/>
			</div>
			{mailMounted && <div data-owl-island-anchor="" style={{ display: railView === "mail" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
				<MailPage client={client} connected={connected} cwd={workspaceDir} sidebarCollapsed={sidebarMinimized} model={selectedModel()} thinkingLevel={thinkingLevel} />
			</div>}
			{evaluationMounted && <div data-owl-island-anchor="" style={{ display: railView === "evaluation" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
				<EvaluationPage client={client} active={railView === "evaluation" && !showSettings} sidebarCollapsed={sidebarMinimized} />
			</div>}
			{/* 媒体桥（owl-media-bridge 插件）：Rail 一等视图，纯新增入口。 */}
			{mediaMounted && <div data-owl-island-anchor="" style={{ display: railView === "media" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<MediaView active={railView === "media" && !showSettings} />
			</div>}
			{/* 人生指南视图（双 tab）：高性价比人生指南 + 人生进阶指南，内容 jsDelivr 拉取 + 本地缓存（署名与许可在各自底栏）。 */}
			{guideMounted && <div data-owl-island-anchor="" style={{ display: railView === "guide" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<GuidePanel
					active={railView === "guide" && !showSettings}
					onOpenUrl={(url) => {
						void client.request({ type: "open.external", action: "url", target: url })
							.then((result) => { if (!result.ok) window.open(url, "_blank"); })
							.catch(() => window.open(url, "_blank"));
					}}
				/>
			</div>}
			{/* 「我的 Token 生涯」看板：跨 Agent 本地会话记录的 token 用量汇总（career.get，仅本地解析）。 */}
			{careerMounted && <div data-owl-island-anchor="" style={{ display: railView === "career" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<TokenCareerPage active={railView === "career" && !showSettings} client={client} />
			</div>}
			{automationMounted && <div data-owl-island-anchor="" style={{ display: railView === "automation" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<AutomationPage client={client} active={railView === "automation" && !showSettings} onOpenSession={(id) => void openSession(id)} sessions={[
					...(sessionId ? [{ id: sessionId, title: sessionTitle }] : []),
					...[...listedTitles.entries()].filter(([id]) => id !== sessionId).slice(0, 30).map(([id, title]) => ({ id, title })),
				]} />
			</div>}
			{monitorMounted && <div data-owl-island-anchor="" style={{ display: railView === "monitor" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<LifeMonitorPage view={lifeView} round={lifeProbe.round} active={railView === "monitor" && !showSettings} />
			</div>}
			{/* 「我的助理」：owl-myself 目录每天一个 md，左侧日历排序 + 当天提炼/待办/对话。 */}
			{myselfMounted && <div data-owl-island-anchor="" style={{ display: railView === "myself" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<MyselfPanel active={railView === "myself" && !showSettings} client={client} connected={connected} workspaceDir={workspaceDir} agentDir={agentDir} providers={providers} defaultModel={modelValue} defaultThinkingLevel={thinkingLevel} defaultApprovalMode={approvalMode} onOpenSettings={openSettings} />
			</div>}
			{/* 「专家顾问」：owl-expert 目录（人格档案 + 记忆 + 每天一个会话 md），市场 + 1:1/群聊。 */}
			{expertMounted && <div data-owl-island-anchor="" style={{ display: railView === "expert" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<ExpertPanel active={railView === "expert" && !showSettings} client={client} connected={connected} providers={providers} defaultModel={modelValue} defaultThinkingLevel={thinkingLevel} defaultApprovalMode={approvalMode} onOpenSettings={openSettings} />
			</div>}
			{/* 「八股对练」：bagu 题库（localhost:8080）抽题评分 + owl agent 反问/兜底。 */}
			{baguMounted && <div data-owl-island-anchor="" style={{ display: railView === "bagu" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<BaguPage active={railView === "bagu" && !showSettings} client={client} connected={connected} defaultModel={modelValue} defaultThinkingLevel={thinkingLevel} defaultApprovalMode={approvalMode} />
			</div>}
			{/* 插件市场：与 news/bagu 同款常挂载 + display 切换；引入即新开会话交给 Agent 改造。 */}
			{marketMounted && <div data-owl-island-anchor="" style={{ display: railView === "market" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
				<MarketPage active={railView === "market" && !showSettings} connected={connected} agentDir={agentDir ?? ""} workspaceDir={workspaceDir} onImport={(text) => importPluginToNewSession(text)} />
			</div>}
			<div className="owl-main-frame" data-owl-island-anchor="" style={{ display: railView === "chat" || railView === "research" || showSettings ? undefined : "none" }}>
				<ConversationHeader
					title={railView === "research" ? researchConversationTitle ?? t("app.newConversation") : sessionTitle}
					// 未选目录时顶栏不显示项目 chip（会话实际落在默认目录）。
					workspaceDir={workspaceSelected ? workspaceDir : ""}
					presetName={(() => {
						if (railView === "research") return undefined;
						const id = sessionId ? sessionPreset ?? stagedPreset : stagedPreset;
						return id ? agentPresets.find((preset) => preset.id === id)?.name : undefined;
					})()}
					view={railView === "research" ? researchConversationView : conversationView}
					onViewChange={railView === "research" ? setResearchConversationViewPersisted : setConversationViewPersisted}
					terminalOpen={terminalOpen} sidebarOpen={sidebarOpen}
					onToggleTerminal={toggleTerminalPanel} onToggleSidebar={toggleSidebarPanel}
					sessionId={railView === "research" ? researchSessionId : sessionId}
					exporting={exportingLog}
					onExport={exportSessionLog}
					onExportTurns={() => setShareTurnsSession(railView === "research" ? researchSessionId : sessionIdRef.current)}
				/>
				{exportNotice && (
					<p className={`px-5 py-1.5 text-xs ${exportNotice.tone === "error" ? "text-red-400" : "text-owl-faint"}`} role={exportNotice.tone === "error" ? "alert" : "status"}>
						{exportNotice.text}
					</p>
				)}
				{/* 双面板常挂载：owl-shell-content-main 是「对话 + 终端底栏」的纵列，
				    工具侧栏是右列 —— 底栏与侧栏互不依赖，可同时展开。 */}
				<div className={"owl-shell-content" + (questions.some((request) => request.sessionId === (railView === "research" ? researchSessionId : sessionId)) ? " has-pending-question" : "")}>
					<div className="owl-shell-content-main">
					<div className="owl-shell-conversation">
						{researchMounted && <div style={{ display: railView === "research" && !showSettings ? "flex" : "none", flex: 1, minHeight: 0, minWidth: 0 }}>
							<ResearchPage
								onOpenAutomation={openAutomation} client={client} active={railView === "research" && !showSettings} connected={connected} cwd={workspaceDir}
								providers={providers} defaultModel={modelValue} defaultThinkingLevel={thinkingLevel} defaultApprovalMode={approvalMode}
								projects={visibleResearchProjects} onSwitchProject={switchProject} onSessionIdChange={setResearchSessionId}
								resumeRequest={researchResumeRequest} newConversationRequest={researchNewConversationRequest}
								conversationView={researchConversationView} onTitleChange={setResearchConversationTitle}
								questions={questions} onQuestionDone={(requestId) => setQuestions((current) => current.filter((request) => request.requestId !== requestId))}
								waiting={Boolean(researchSessionId && (permissions.some((request) => request.sessionId === researchSessionId) || questions.some((request) => request.sessionId === researchSessionId)))}
								onOpenFile={openTaskFile} onOpenReview={openWorkbenchReview}
								sidebarOpen={sidebarOpen} onOpenResults={() => setSidebarOpenPersisted(false)} onOpenSettings={shortcuts.openSettings}
							/>
						</div>}
						{/* 号池 Manager（迁移阶段 6）：Rail 一等视图，嵌入 pool-server 管理台。 */}
						{managerMounted && <div style={{ display: railView === "manager" && !showSettings ? "flex" : "none", flex: 1, minHeight: 0, minWidth: 0, flexDirection: "column" }}>
							<ManagerTab />
						</div>}
						<div style={{ display: railView === "research" || railView === "manager" ? "none" : "flex", flex: 1, minHeight: 0, minWidth: 0, flexDirection: "column" }}>
						{conversationView === "trajectory" ? (
							<TrajectoryView entries={entries} active={railView === "chat" && !showSettings} />
						) : conversationView === "context" ? (
							<ContextView key={sessionId ?? workspaceDir} client={client} cwd={workspaceDir} sessionId={sessionId} requireSession active={railView === "chat" && !showSettings && connected} />
						) : (
							<>
								<GenuiSessionProvider client={client} sessionId={sessionId}><ChatStream key={sessionId ?? workspaceDir} entries={entries} cwd={workspaceDir} onOpenFile={openTaskFile} onOpenUrl={openUrlInSidebarBrowser} onQuickAction={requestOpenKind} onPromptExample={(text) => setDraftRequest({ id: ++draftSequence.current, text })} onOpenDeveloper={openDeveloper} artifacts={<TurnArtifacts artifacts={artifacts} cwd={workspaceDir} client={client} onOpenFile={openTaskFile} onOpenReview={openWorkbenchReview} />} client={client} onOpenReview={openWorkbenchReview} activity={chatActivity} onRewind={handleRewindClick} onRegenerate={() => void handleRegenerate()} onEditMessage={(entryId, text, images) => void handleEditMessage(entryId, text, images)} onBranch={(entryId) => void handleBranch(entryId)} onOpenAutomation={openAutomation} />
								</GenuiSessionProvider>
								{fileOpenError && <p className="px-4 py-1 text-xs text-red-400" role="alert">{fileOpenError}</p>}
							</>
						)}
						{/* 任务清单常驻条：贴在输入框上方，实时提醒当前进度（无清单时自动隐藏） */}
						<TodoPin entries={entries} onVisibleChange={setTodoPinVisible} />
						<SchedulePin client={client} sessionId={sessionId} active={railView === "chat" && !showSettings} onOpenAutomation={openAutomation} />
						{/* 自动重试横幅：桥端 auto-retry 进行中/耗尽时贴在输入框上方（此前事件过线无人渲染） */}
						<RetryPin status={retryStatus} onDismiss={() => setRetryStatus(null)} />
						<QuestionDock
							requests={questions}
							activeRequest={activeQuestion}
							onAnswer={(requestId, answers, cancelled) => {
								answerAndRestore(requestId, questionsRef, setQuestions, () => client.respondQuestion(requestId, answers, cancelled));
							}}
						>
<Composer
								client={client}
								sessionScope="chat"
								connected={connected}
								disabled={submitting || !connected}
								running={running}
								paused={Boolean(sessionId && pausedSessions.has(sessionId))}
								hideMascot={todoPinVisible}
								hideEnvironment={connected && (Boolean(activeQuestion) || running)}
								onSend={(text, images, attachedPaths, delivery) => void sendPrompt(text, images, attachedPaths, delivery)}
								queued={sessionId ? promptQueues[sessionId] : undefined}
								onRemoveQueued={(lane, index) => {
									const target = sessionIdRef.current;
									if (!target) return;
									void client.request({ type: "session.queue.remove", sessionId: target, lane, index });
								}}
								onPromoteQueued={(index) => {
									const target = sessionIdRef.current;
									if (!target) return;
									void client.request({ type: "session.queue.promote", sessionId: target, index });
								}}
								onAbort={() => void abort()}
								onPause={pauseSession}
								onResume={() => void resumePaused()}
							providers={providers}
							model={modelValue}
							onModel={handleModelChange}
							thinkingLevel={thinkingLevel}
							onThinkingLevel={handleThinkingChange}
						approvalMode={approvalMode}
							onApprovalMode={handleApprovalModeChange}
							agentPresets={agentPresets}
							defaultPresetId={defaultPresetId}
							agentPreset={sessionId ? sessionPreset ?? stagedPreset : stagedPreset}
							agentPresetLocked={Boolean(sessionId) && entries.length > 0}
							onAgentPresetSelect={handleAgentPresetSelect}
							sessionInfo={sessionInfo}
								workspaceDir={workspaceDir}
								projects={visibleProjects}
								workspaceSelected={workspaceSelected}
								onSwitchProject={switchProject}
								onClearProject={clearWorkspaceSelection}
								commands={slashCommands}
								searchFiles={(cwd, query) => client.request<FsSearchHit[]>({ type: "fs.search", cwd, query }).then((r) => (r.ok ? r.result ?? [] : []))}
								draftRequest={draftRequest}
								owlPose={owlPose}
							/>
						</QuestionDock>
						</div>
					</div>
					{/* 终端底栏：挂在对话列之下（高度拖拽），与右侧栏互不相干 */}
					<BrowserSessionContext.Provider value={railView === "research" ? researchSessionId : sessionId}>
						<Workbench
							client={client}
							cwd={workspaceDir}
							store={terminalStore}
							open={terminalOpen}
							onSetOpen={setTerminalOpenPersisted}
							dock="bottom"
							role="terminal"
						/>
					</BrowserSessionContext.Provider>
					</div>
					{/* 工具侧栏：右列（宽度拖拽），装除终端外的全部工作 tab */}
					<BrowserSessionContext.Provider value={railView === "research" ? researchSessionId : sessionId}>
						<Workbench
							client={client}
							cwd={workspaceDir}
							store={workbenchStore}
							open={sidebarOpen}
							onSetOpen={setSidebarOpenPersisted}
							dock="right"
							developerLayout={developerLayout}
						/>
					</BrowserSessionContext.Provider>
				</div>
			{showSettings && (
				<SettingsPage
					key={settingsMountKey}
					client={client}
					workspaceDir={workspaceDir}
					initialTab={settingsInitialTab}
					onAskAgentCreatePreset={handleAskAgentCreatePreset}
					wallpaper={wallpaper}
					onWallpaperChange={(next) => {
						setWallpaper(next);
						applyOwlWallpaper(next);
					}}
					onWorkspaceDir={(dir) => {
						setWorkspaceDir(dir);
						localStorage.setItem(WORKSPACE_KEY, dir);
						setWorkspaceSelected(true);
						localStorage.setItem(WORKSPACE_SELECTED_KEY, "1");
					}}
					onClose={() => setShowSettings(false)}
					onSessionsChanged={() => setSidebarRev((v) => v + 1)}
				/>
			)}
			</div>
			</div>
			{showProjectDialog && (
				<NewProjectDialog client={client} onClose={() => { setShowProjectDialog(false); setProjectDialogStay(false); }} onCreated={(path, name) => {
					restoreProject(path, sessionScope);
					if (name !== undefined) setProjectAlias(path, name);
					setShowProjectDialog(false);
					setShowSettings(false);
					if (projectDialogStay) {
						// 项目页创建：登记进已知项目并留在项目页，列表随 sidebarRev 重拉。
						const known = loadSidebarStrings(localStorage, "owl.projects");
						if (!known.some((p) => samePath(p, path))) localStorage.setItem("owl.projects", JSON.stringify([...known, path]));
						setProjectDialogStay(false);
						setSidebarRev((current) => current + 1);
						return;
					}
					switchProject(path);
				}} />
			)}
			{permission && (
				<PermissionDialog
					request={permission}
					contextLabel={permission.sessionId === researchSessionId ? researchTitle : permission.sessionId === sessionId ? sessionTitle : permission.sessionId.slice(0, 8)}
					onDecide={(approved) => {
						answerAndRestore(permission.requestId, permissionsRef, setPermissions, () => client.respondPermission(permission.requestId, approved));
					}}
				/>
			)}
			{rewindTarget && sessionId && (
				<RewindDialog
					key={rewindTarget.entryId}
					client={client}
					sessionId={sessionId}
					target={rewindTarget}
					onDone={handleRewindDone}
					onClose={() => setRewindTarget(undefined)}
				/>
			)}
			{shareTurnsSession && (
				<SessionShareDialog
					key={shareTurnsSession}
					client={client}
					sessionId={shareTurnsSession}
					exporting={exportingLog}
					onExport={(turnEntryIds) => {
						// 先关弹窗再导出：结果（保存路径/失败原因）走主窗口的 exportNotice
						setShareTurnsSession(undefined);
						void exportSessionLog("markdown", turnEntryIds);
					}}
					onClose={() => setShareTurnsSession(undefined)}
				/>
			)}
			{findOpen && <FindBar onClose={() => setFindOpen(false)} />}
			{helpSection && <ShortcutsDialog section={helpSection} onClose={() => setHelpSection(undefined)} />}
		</div>
	);
}
