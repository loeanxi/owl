import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyOwlAnimation } from "./animation-settings.ts";
import type { AppPlace } from "./app-history.ts";
import {
	APP_KEYBINDINGS_KEY,
	type AppKeybindingAction,
	DEFAULT_APP_KEYBINDINGS,
	loadAppKeybindings,
	matchingAppAction,
	publishAppKeybindings,
} from "./app-keybindings.ts";
import { BridgeClient } from "./bridge/client.ts";
import {
	closeMainWindow,
	hasTauri,
	isWindowFullscreen,
	quitDesktopApp,
	revealInFileManager,
	setWebviewZoom,
	setWindowFullscreen,
	startDebugRebuild,
} from "./bridge/native.ts";
import { PendingResponses, PendingResponsesContext } from "./bridge/pending-responses.ts";
import { applyPermissionQueueEvent, approvalModeFromEvent } from "./bridge/permission-state.ts";
import type {
	AgentPresetDefinition,
	ApprovalMode,
	CommandsListResult,
	DesktopRunTiming,
	FsSearchHit,
	GitStatusResult,
	ModelFallbackNotice as ModelFallbackNoticePayload,
	PermissionRequest,
	ProviderModelsMessage,
	QuestionRequest,
	ResearchMode,
	RewindExecuteResult,
	RewindImpactFile,
	ServerEventMessage,
	SessionExportLogResult,
	SessionQueueSnapshot,
	SessionRunningResult,
	SessionSearchHit,
	SessionSearchMessageResult,
	SessionStatsResult,
	SidebarContextMessage,
	SidebarFocusState,
	SidebarShowMessage,
	SlashCommandEntry,
} from "./bridge/protocol.ts";
import { applyChatAppearance, parseChatAppearance } from "./chat-appearance.ts";
import { AccountProfilePage } from "./components/AccountProfilePage.tsx";
import { ActivityRail, type RailView } from "./components/ActivityRail.tsx";
import { AgentConversation } from "./components/AgentConversation.tsx";
import { AmbientBackground } from "./components/AmbientBackground.tsx";
import { BuildConsistencyBanner } from "./components/BuildConsistencyBanner.tsx";
import { type ChatActivity, ChatStream, type MessageSearchTarget } from "./components/ChatStream.tsx";
import { Composer, type ComposerDraftRequest, type ComposerImage } from "./components/Composer.tsx";
import { ContextView } from "./components/ContextView.tsx";
import {
	ConversationHeader,
	type ConversationView,
	type SessionExportFormat,
} from "./components/ConversationHeader.tsx";
import { conversationTitleOf } from "./components/conversation-title.ts";
import { DesktopTitlebar } from "./components/DesktopTitlebar.tsx";
import { DynamicIsland } from "./components/DynamicIsland.tsx";
import { loadIslandMemory } from "./components/dynamic-island-memory.ts";
import {
	type IslandOutcome,
	islandQuestionChoices,
	islandSessionTitle,
	islandWhisper,
} from "./components/dynamic-island-model.ts";
import { executionText } from "./components/execution-copy.ts";
import { FindBar } from "./components/FindBar.tsx";
import { latestTurn } from "./components/follow-up-suggestion.ts";
import { GenuiSessionProvider } from "./components/Genui.tsx";
import { ModelFallbackNotice } from "./components/ModelFallbackNotice.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { useSessionOwlPose } from "./components/OwlMascot.tsx";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary.tsx";
import { PermissionDialog } from "./components/PermissionDialog.tsx";
import { RegenerateConfirmDialog } from "./components/RegenerateConfirmDialog.tsx";
import { RetryPin } from "./components/RetryPin.tsx";
import { TurnArtifacts } from "./components/ReviewChangesCard.tsx";
import { RewindDialog } from "./components/RewindDialog.tsx";
import { SessionShareDialog } from "./components/SessionShareDialog.tsx";
import { SessionSidebar } from "./components/SessionSidebar.tsx";
import { SessionStatusPill } from "./components/SessionStatusPill.tsx";
import { type SettingsInitialTab, SettingsPage } from "./components/SettingsPage.tsx";
import { type HelpSection, ShortcutsDialog } from "./components/ShortcutsDialog.tsx";
import { SubagentPin } from "./components/SubagentPin.tsx";
import { type SubagentSelection, SubagentView, selectedSubagent } from "./components/SubagentView.tsx";
import {
	initializeResearchSidebar,
	loadSidebarStrings,
	matchesSessionScope,
	sidebarStorageKeys,
} from "./components/sidebar-scope.ts";
import { TaskRecoveryNotice } from "./components/TaskRecoveryNotice.tsx";
import { TodoPin } from "./components/TodoPin.tsx";
import { useTurnDiff } from "./components/turn-diff.ts";
import { fetchInventory, passesRating, WallpaperLayer } from "./components/WallpaperLayer.tsx";
import { AutomationPage } from "./features/automation/AutomationPage.tsx";
import { SchedulePin } from "./features/automation/SchedulePin.tsx";
import { BaguPage } from "./features/bagu/BaguPage.tsx";
import { EvaluationPage } from "./features/evaluation/EvaluationPage.tsx";
import { ExpertPanel } from "./features/expert/ExpertPanel.tsx";
import { GuidePanel } from "./features/guide/GuidePanel.tsx";
import { presentLife } from "./features/life-monitor/present.ts";
import { useLifeProbe } from "./features/life-monitor/use-life-probe.ts";
import { MailPage } from "./features/mail/MailPage.tsx";
import { MarketPage } from "./features/market/MarketPage.tsx";
import { MediaOverlays } from "./features/media/MediaOverlays.tsx";
import { MediaView } from "./features/media/MediaView.tsx";
import { MyselfPanel } from "./features/myself/MyselfPanel.tsx";
import { myselfDirCandidates } from "./features/myself/myself-data.ts";
import { NewsPage } from "./features/news/NewsPage.tsx";
import type { NewsTarget } from "./features/news/NewsReading.tsx";
import { ProjectsPage } from "./features/projects/ProjectsPage.tsx";
import { ResearchPage } from "./features/research/ResearchPage.tsx";
import { useResearchEntryText } from "./features/research/research-entry-copy.ts";
import { researchSessionKey } from "./features/research/research-session.ts";
import { TokenCareerPage } from "./features/token-career/TokenCareerPage.tsx";
import { TrajectoryView } from "./features/trajectory/TrajectoryView.tsx";
import { parseFileIconTheme, setFileIconTheme } from "./file-icons/file-icon-theme.ts";
import { settledRunStatus } from "./hooks/agent-settlement.ts";
import { collectArtifacts, workspaceArtifactPath } from "./hooks/artifacts.ts";
import { createFrameBatcher, isStreamingDeltaEvent } from "./hooks/event-batch.ts";
import { type MessageInput, messageInputOf } from "./hooks/message-input.ts";
import { collectProducts, type Product } from "./hooks/products.ts";
import { describeToolInput } from "./hooks/summarize.ts";
import { continueTask, taskRecovery } from "./hooks/task-recovery.ts";
import {
	applyEvent,
	applyRetryEvent,
	type ChatEntry,
	outputRate,
	type RetryBannerState,
	rebuild,
	type ToolCard,
} from "./hooks/transcript.ts";
import { useModelSelection } from "./hooks/use-model-selection.ts";
import { useStartRecentSessions } from "./hooks/use-start-recent-sessions.ts";
import { useSubagents } from "./hooks/use-subagents.ts";
import { parseUiLanguageSetting, setUiLanguageSetting, t, type UiLanguageSetting, useT } from "./i18n/index.ts";
import { MapWorkspace } from "./map/MapWorkspace.tsx";
import { applyOwlAppearance, parseOwlAppearance, presetThemeLock } from "./owl-appearance.ts";
import { rememberProjectSession, resolveProjectSession } from "./project-session-memory.ts";
import {
	isProjectHidden,
	restoreProject,
	setProjectAlias,
	useProjectSidebarRevision,
} from "./project-sidebar-model.ts";
import { resolveSessionRunTiming, type SessionRunTiming, type SessionRunTimingWire } from "./session-run-timing.ts";
import { createSidebarApi, fileUrlOf } from "./sidebar/api.ts";
import { focusChangesFile } from "./sidebar/changes-focus.ts";
import {
	getSidebarConfig,
	isTabKindEnabled,
	parseSidebarSettings,
	setSidebarConfig,
	viewerKindForPath,
} from "./sidebar/config.ts";
import { openDeveloperWorkbench } from "./sidebar/developer.ts";
import {
	confirmEditorAccountProfile,
	listenForUnprotectedEditorUnload,
	registerEditorExitGuard,
} from "./sidebar/editor-exit-guard.ts";
import { focusEditorLine } from "./sidebar/editor-line-focus.ts";
import { ExecutionContext, type ExecutionContextValue } from "./sidebar/execution-context.tsx";
import { setSessionFeed } from "./sidebar/feed.ts";
import { peekEditorFocus } from "./sidebar/focus-state.ts";
import {
	agentPageForSession,
	boundTabIdFor,
	encodeIabPath,
	isIabPageBound,
	parseIabPath,
} from "./sidebar/iab-bound.ts";
import { pushSidebarNotice } from "./sidebar/notice.ts";
import { openQuickAction } from "./sidebar/quick.tsx";
import { BrowserSessionContext } from "./sidebar/registry.ts";
import { focusReviewEntry } from "./sidebar/review-focus.ts";
import { summarizeReviewState } from "./sidebar/review-state.ts";
import { normProjectKey, SidebarStore } from "./sidebar/store.ts";
import { ManagerTab } from "./sidebar/tabs/ManagerTab.tsx";
import { peekTerminalTail } from "./sidebar/terminal-state.ts";
import { Workbench } from "./sidebar/Workbench.tsx";
import { useStartupWindow } from "./startup-window.ts";
import { isThemePreference, setThemeLock, setThemePreference } from "./theme.ts";
import { useAppHistory } from "./use-app-history.ts";
import { useWorkspaceMemory } from "./use-workspace-memory.ts";
import { downloadTextFile } from "./utils/download.ts";
import { filterProvidersByEnabledModels, parseEnabledModels } from "./utils/enabled-models.ts";
import { notifyAgentStatus } from "./utils/notification.ts";
import { parseNotificationPrefs, setNotificationPrefs } from "./utils/notification-prefs.ts";
import {
	DEFAULT_WORKSPACE_DIR,
	isReservedDir,
	isValidationDir,
	loadAndScrubProjects,
	normPath,
	samePath,
} from "./utils/paths.ts";
import { type TitleSignal, windowTitle } from "./utils/window-title.ts";
import { applyOwlWallpaper, type OwlWallpaperSettings, parseOwlWallpaper } from "./wallpaper.ts";
import { syncWindowGlass } from "./window-glass.ts";
import { resolveWorkspaceMemory, type WorkspaceSettingsSection } from "./workspace-memory.ts";
import "./desktop-shell.css";
import { toExternalUrl } from "./external-url.ts";

const WORKSPACE_KEY = "owl.workspaceDir";
/** 短剧面板开合：机器级状态，跟着应用走，不跟项目走。 */
const MIRROR_OPEN_KEY = "owl.mirror.open";
/** 是否选择了对话目录（"0" = 已叉掉，不选目录）：不选时会话进 DEFAULT_WORKSPACE_DIR。 */
const WORKSPACE_SELECTED_KEY = "owl.workspaceSelected";
/** 研究工作台自己的当前项目与选择状态：与主会话隔离，切换互不带动。 */
const RESEARCH_WORKSPACE_KEY = "owl.research.workspaceDir";
const RESEARCH_WORKSPACE_SELECTED_KEY = "owl.research.workspaceSelected";
const MODEL_KEY = "owl.model";
const THINKING_KEY = "owl.thinkingLevel";
const APPROVAL_KEY = "owl.approvalMode";
/** 暂存的 Agent 预设 id：新会话创建时带上（DSH 的 staged-selection 语义）。 */
const PRESET_KEY = "owl.agentPreset";
const ACTIVITY_RAIL_COLLAPSED_KEY = "owl.activityRailCollapsed";
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

function promptQueueKey(profile: string | undefined, sessionId: string): string {
	return JSON.stringify([profile, sessionId]);
}

export default function App(): React.JSX.Element {
	const t = useT();
	const projectSidebarRevision = useProjectSidebarRevision();
	const researchTitle = useResearchEntryText();
	const client = useMemo(() => new BridgeClient(), []);
	const managerApi = useMemo(() => createSidebarApi(client), [client]);
	const [connected, setConnected] = useState(false);
	const completeStartupAppearance = useStartupWindow();
	const [showSettings, setShowSettings] = useState(false);
	const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsInitialTab>("general");
	const [settingsSection, setSettingsSection] = useState<WorkspaceSettingsSection>("general");
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
		return view === "manager" ||
			view === "mail" ||
			view === "map" ||
			view === "evaluation" ||
			view === "media" ||
			view === "projects" ||
			view === "research" ||
			view === "guide" ||
			view === "career" ||
			view === "myself" ||
			view === "expert" ||
			view === "bagu" ||
			view === "market" ||
			view === "account"
			? view
			: "chat";
	});
	const sessionScope = railView === "research" ? "research" : "chat";
	const [mailMounted, setMailMounted] = useState(railView === "mail");
	const [evaluationMounted, setEvaluationMounted] = useState(railView === "evaluation");
	const [researchMounted, setResearchMounted] = useState(railView === "research");
	const [researchSessionId, setResearchSessionId] = useState<string>();
	const researchSessionIdRef = useRef(researchSessionId);
	researchSessionIdRef.current = researchSessionId;
	const [researchConversationTitle, setResearchConversationTitle] = useState<string>();
	const [researchResumeRequest, setResearchResumeRequest] = useState<{ id: string; revision: number }>();
	const [researchNewConversationRequest, setResearchNewConversationRequest] = useState(0);
	const researchActionSequence = useRef(0);
	const pendingResearchRestoreId = useRef<string | undefined>(undefined);
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
	// 「我的助理」同样懒挂载保活：owl-myself 的天文件读一次留在内存，勾选即时回写。
	const [myselfMounted, setMyselfMounted] = useState(railView === "myself");
	const [myselfOpenRequest, setMyselfOpenRequest] = useState<{ id: string; revision: number }>();
	const myselfOpenSequence = useRef(0);
	// 「专家顾问」懒挂载保活：owl-expert 的人格目录与群清单留在内存。
	const [expertMounted, setExpertMounted] = useState(railView === "expert");
	// 「八股对练」懒挂载保活：题库与面试线程留在内存，切走再回来不丢进度。
	const [baguMounted, setBaguMounted] = useState(railView === "bagu");
	const [marketMounted, setMarketMounted] = useState(railView === "market");
	// owl agent 数据目录（settings.get 带出）：我的助理的兜底数据根。
	const [agentDir, setAgentDir] = useState<string>();
	const [profileReady, setProfileReady] = useState(false);
	const agentDirRef = useRef(agentDir);
	agentDirRef.current = agentDir;
	useEffect(() => {
		if (profileReady && agentDir) confirmEditorAccountProfile(agentDir);
	}, [profileReady, agentDir]);
	const [searchTarget, setSearchTarget] = useState<MessageSearchTarget>();
	const [searchHistory, setSearchHistory] = useState<{ sessionId: string; result: SessionSearchMessageResult }>();
	const searchSequence = useRef(0);
	const [deliveryTarget, setDeliveryTarget] = useState<{ sessionId: string; requestId: number }>();
	const deliverySequence = useRef(0);
	const [projectRestoring, setProjectRestoring] = useState<{
		scope: "chat" | "research";
		path: string;
		token: number;
	}>();
	const [projectNotice, setProjectNotice] = useState<string>();
	// 会话打开在途/失败：打开历史会话时给一行状态，失败给重试入口（silent 的自动恢复也能看到）。
	// 项目恢复已有 projectRestoring 提示，openSession 在那条路上不再重复设置。
	const [sessionOpening, setSessionOpening] = useState<{ id: string; token: number }>();
	const [sessionOpenFailed, setSessionOpenFailed] = useState<{ id: string; message: string }>();
	/**
	 * 已忽略的模型替换提示。按「原模型 → 现在的模型」记，所以同一个替换只提示一次，
	 * 而切到别的会话、或又换到一个新模型时会重新提示。
	 */
	const [dismissedModelFallbacks, setDismissedModelFallbacks] = useState<string[]>([]);
	const [activityRailCollapsed, setActivityRailCollapsed] = useState(() => {
		try {
			return localStorage.getItem(ACTIVITY_RAIL_COLLAPSED_KEY) === "1";
		} catch {
			return false;
		}
	});
	const toggleActivityRail = (): void => {
		setActivityRailCollapsed((current) => {
			const next = !current;
			try {
				localStorage.setItem(ACTIVITY_RAIL_COLLAPSED_KEY, next ? "1" : "0");
			} catch {
				/* Keep the rail toggle usable without local storage. */
			}
			return next;
		});
	};
	const [sidebarMinimized, setSidebarMinimized] = useState(() => localStorage.getItem(SIDEBAR_MINIMIZED_KEY) === "1");
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
	const [draftRequest, setDraftRequest] = useState<ComposerDraftRequest>();
	// 活跃提问弹卷的已答题号（QuestionDialog 经 dock 上报，R18）：小地图实心/空心依据。
	const [answeredQuestions, setAnsweredQuestions] = useState<ReadonlySet<number>>(() => new Set());
	// ↑ 召回的历史输入：本会话已送达的用户消息，最新在前（排队中的不算）。
	const sentHistory = entries
		.filter(
			(entry): entry is Extract<ChatEntry, { kind: "user" }> =>
				entry.kind === "user" && !entry.queued && entry.text.trim() !== "",
		)
		.map((entry) => entry.text)
		.slice(-50)
		.reverse();
	const draftSequence = useRef(0);
	const [submitting, setSubmitting] = useState(false);
	const submitInFlight = useRef(false);
	const [pendingPrompts, setPendingPrompts] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [promptQueues, setPromptQueues] = useState<Record<string, SessionQueueSnapshot>>({});
	/** agent run 活跃的会话 id（含切走后的后台会话与旁路会话）：侧边栏运行状态点依据。 */
	const [runningSessions, setRunningSessions] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [runningReady, setRunningReady] = useState(false);
	const runningReadyRef = useRef(runningReady);
	runningReadyRef.current = runningReady;
	const runningSessionsRef = useRef(runningSessions);
	runningSessionsRef.current = runningSessions;
	/** 每个正在跑的会话最近一次有动静的时间。只在「谁排第一」变化时写进 state。 */
	const activityAtRef = useRef(new Map<string, number>());
	const runTimingRef = useRef(new Map<string, SessionRunTiming>());
	const authoritativeRunTimings = useRef(new Set<string>());
	const updateRunTiming = (id: string, incoming: SessionRunTimingWire = {}, fallbackStartedAt = 0): void => {
		runTimingRef.current.set(id, resolveSessionRunTiming(runTimingRef.current.get(id), incoming, fallbackStartedAt));
		if (typeof incoming.startedAt === "number" && Number.isFinite(incoming.startedAt) && incoming.startedAt > 0)
			authoritativeRunTimings.current.add(id);
	};
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
	const listedCwdsRef = useRef<ReadonlyMap<string, string>>(new Map());
	const titleForRef = useRef<(id: string) => string>((id) => id);
	const publishActivityRef = useRef<(ids: ReadonlySet<string>) => void>(() => {});
	publishActivityRef.current = (ids) => {
		const order = [...ids].sort(
			(a, b) => (activityAtRef.current.get(b) ?? 0) - (activityAtRef.current.get(a) ?? 0) || a.localeCompare(b),
		);
		activityLeaderRef.current = order[0] ?? null;
		setActivityOrder((current) =>
			current.length === order.length && current.every((id, index) => id === order[index]) ? current : order,
		);
	};
	/** 被用户主动暂停的会话：这些会话的输入框按钮显示「继续」，点击即从断点续跑。 */
	const [pausedSessions, setPausedSessions] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [sessionId, setSessionId] = useState<string | undefined>(undefined);
	// 按会话隔离的输入草稿：切走留存、切回还原，杜绝半段话发错会话。
	// 存 ref 不进 state——键入时写 ref 不触发全 App 重渲染；Composer 按会话 key 重挂时读取。
	const sessionDraftsRef = useRef(new Map<string, string>());
	const composerSessionKey = sessionId ?? "__new__";
	// 排队气泡的撤销/立即发送：走与排队条相同的协议，响应带回新队列即更新。
	const queuedRemove = (messageId: string, lane: "steering" | "followUp"): void => {
		if (!sessionId || !profileReady) return;
		void client.request({ type: "session.queue.remove", sessionId, messageId, lane }).then((raw) => {
			const response = raw as { ok: boolean; result?: { queue?: SessionQueueSnapshot } };
			if (response.ok && response.result?.queue)
				setPromptQueues((current) => ({
					...current,
					[promptQueueKey(agentDir, sessionId)]: response.result!.queue!,
				}));
		});
	};
	const queuedPromote = (messageId: string): void => {
		if (!sessionId || !profileReady) return;
		void client.request({ type: "session.queue.promote", sessionId, messageId }).then((raw) => {
			const response = raw as { ok: boolean; result?: { queue?: SessionQueueSnapshot } };
			if (response.ok && response.result?.queue)
				setPromptQueues((current) => ({
					...current,
					[promptQueueKey(agentDir, sessionId)]: response.result!.queue!,
				}));
		});
	};
	// 有未发送草稿的会话集合（侧栏铅笔点）：只在 空↔非空 翻转时 setState，键入零重渲染。
	const [draftSessions, setDraftSessions] = useState<ReadonlySet<string>>(() => new Set());
	const draftFilledRef = useRef(new Set<string>());
	const trackDraft = (key: string, text: string): void => {
		sessionDraftsRef.current.set(key, text);
		const filled = text.trim() !== "";
		if (draftFilledRef.current.has(key) === filled) return;
		if (filled) draftFilledRef.current.add(key);
		else draftFilledRef.current.delete(key);
		setDraftSessions((current) => {
			const next = new Set(current);
			if (filled) next.add(key);
			else next.delete(key);
			return next;
		});
	};
	const [subagentSelection, setSubagentSelection] = useState<SubagentSelection>();
	const [subagentView, setSubagentView] = useState<ConversationView>("chat");
	const subagentParentId = railView === "research" ? researchSessionId : sessionId;
	const subagents = useSubagents(
		client,
		connected,
		subagentParentId,
		!showSettings && (railView === "chat" || railView === "research"),
	);
	const visibleSubagent = subagentSelection?.parentSessionId === subagentParentId ? subagentSelection : undefined;
	const activeSubagent = visibleSubagent ? selectedSubagent(subagents.runs, visibleSubagent) : undefined;
	const openSubagentCard = (card: ToolCard): void => {
		if (!subagentParentId) return;
		setSubagentSelection({ parentSessionId: subagentParentId, toolCallId: card.id, card });
		setSubagentView("chat");
		subagents.refresh();
	};
	const openSubagent = (id: string): void => {
		if (!subagentParentId) return;
		setSubagentSelection({ parentSessionId: subagentParentId, id });
		setSubagentView("chat");
	};
	useEffect(() => setSubagentSelection(undefined), [subagentParentId]);
	useEffect(() => {
		if (!visibleSubagent || visibleSubagent.id || !activeSubagent) return;
		setSubagentSelection((current) =>
			current?.parentSessionId === activeSubagent.parentSessionId && current.toolCallId === activeSubagent.toolCallId
				? { ...current, id: activeSubagent.id }
				: current,
		);
	}, [visibleSubagent, activeSubagent?.id]);
	const running = Boolean(sessionId && (runningSessions.has(sessionId) || pendingPrompts.has(sessionId)));
	const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
	const [permissionDetailId, setPermissionDetailId] = useState<string>();
	const [deferredPermissions, setDeferredPermissions] = useState<ReadonlySet<string>>(new Set());
	const foregroundPermissionSession = showSettings
		? undefined
		: railView === "research"
			? researchSessionId
			: railView === "chat"
				? sessionId
				: undefined;
	const permission =
		permissions.find((request) => request.requestId === permissionDetailId) ??
		permissions.find(
			(request) => request.sessionId === foregroundPermissionSession && !deferredPermissions.has(request.requestId),
		);
	/** agent 提问队列：按到达顺序在所属会话的输入框上方显示。 */
	const [questions, setQuestions] = useState<QuestionRequest[]>([]);
	const activeQuestion = questions.find((question) => question.sessionId === sessionId);
	// 应答审批/提问用的实时镜像：Toast 监听器等一次性注册的闭包拿不到新 state
	const permissionsRef = useRef(permissions);
	permissionsRef.current = permissions;
	const pendingResponses = useMemo(() => new PendingResponses(), [agentDir]);
	const pendingResponsesRef = useRef(pendingResponses);
	pendingResponsesRef.current = pendingResponses;
	useEffect(() => {
		pendingResponses.activate();
		return () => pendingResponses.invalidate();
	}, [pendingResponses]);
	const questionsRef = useRef(questions);
	questionsRef.current = questions;
	// Only successful acknowledgements or authoritative terminal events retire a request.
	const answerAndRestore = <T extends { requestId: string; sessionId: string }>(
		requestId: string,
		listRef: { current: T[] },
		setList: (update: (current: T[]) => T[]) => void,
		respond: () => Promise<{ ok: boolean; error?: string }>,
	): void => {
		const entry = listRef.current.find((item) => item.requestId === requestId);
		if (!entry) return;
		void pendingResponsesRef.current.submit({
			requestId,
			sessionId: entry.sessionId,
			respond,
			confirmed: () => setList((current) => current.filter((item) => item.requestId !== requestId)),
		});
	};
	/** 会话回退（owl-rewind）：待确认的目标用户消息，弹 RewindDialog */
	const [rewindTarget, setRewindTarget] = useState<{ entryId: string; text: string } | undefined>(undefined);
	const [providers, setProviders] = useState<ProviderModelsMessage[]>([]);
	/** settings.enabledModels：null = 不过滤；数组 = 对话选择器 allowlist。 */
	const [enabledModels, setEnabledModels] = useState<string[] | null>(null);
	const chatProviders = useMemo(
		() => filterProvidersByEnabledModels(providers, enabledModels),
		[providers, enabledModels],
	);
	const [modelValue, setModelValue] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
	const [thinkingLevel, setThinkingLevel] = useState(() => localStorage.getItem(THINKING_KEY) ?? "medium");
	// 审批模式（标准 confirm / 计划 plan / 自动 auto）：输入栏切换，会话中可即时下发
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>(() => {
		const stored = localStorage.getItem(APPROVAL_KEY);
		return isApprovalMode(stored) ? stored : "confirm";
	});
	const [observedApprovalMode, setObservedApprovalMode] = useState<{ sessionId: string; mode: ApprovalMode }>();
	const currentApprovalMode =
		observedApprovalMode && observedApprovalMode.sessionId === sessionId ? observedApprovalMode.mode : approvalMode;
	// Agent 预设：花名册 + 新任务默认（桥端）+ 暂存选择 + 当前会话绑定。
	// 显示优先级：打开的会话显示它的绑定；空白/新会话显示暂存选择。
	const [agentPresets, setAgentPresets] = useState<AgentPresetDefinition[]>([]);
	const [defaultPresetId, setDefaultPresetId] = useState("standard");
	const [stagedPreset, setStagedPreset] = useState(() => localStorage.getItem(PRESET_KEY) ?? "");
	const [sessionPreset, setSessionPreset] = useState<string | undefined>(undefined);
	// ensureSession 闭包要读最新暂存值：经 ref 中转（设置页代创会先改暂存再开会话）。
	const stagedPresetRef = useRef(stagedPreset);
	const [sessionInfo, setSessionInfo] = useState<SessionStatsResult | undefined>(undefined);
	const recoveryModelRevision = useRef(0);
	/** 当前会话是否由别的会话分支而来（快照 header.parentSession）：无名分支的顶栏标题加「· 分支」。 */
	const [sessionBranched, setSessionBranched] = useState(false);
	/** 当前会话的持久化显示名（session_info，如分支的「fork2 · 来自「你好」」）；顶栏优先用它。 */
	const [sessionName, setSessionName] = useState<string | undefined>(undefined);
	const [workspaceDir, setWorkspaceDir] = useState(() => {
		const saved = localStorage.getItem(WORKSPACE_KEY) ?? DEFAULT_WORKSPACE_DIR;
		// 评测临时 workspace 不应作为当前工作目录常驻（输入框 chip / 顶栏会显示成一堆同名「workspace」）。
		if (!isValidationDir(saved)) return saved;
		localStorage.setItem(WORKSPACE_KEY, DEFAULT_WORKSPACE_DIR);
		return DEFAULT_WORKSPACE_DIR;
	});
	// 本轮改动摘要：Claude 式回答流用它给总结行算 +N −M，并给行内 code 染色。
	const turnDiff = useTurnDiff(client, workspaceDir, sessionId);
	// 目录选择状态：叉掉 chip 后为 false——输入框不再绑定目录，会话默认进 DEFAULT_WORKSPACE_DIR。
	const [workspaceSelected, setWorkspaceSelected] = useState(
		() => localStorage.getItem(WORKSPACE_SELECTED_KEY) !== "0",
	);
	// 研究工作台的项目：首次使用时不绑定目录（会话进默认目录），避免把主会话的项目带进研究侧栏。
	const [researchWorkspaceDir, setResearchWorkspaceDir] = useState(() => {
		const saved = localStorage.getItem(RESEARCH_WORKSPACE_KEY);
		return saved && !isValidationDir(saved) ? saved : DEFAULT_WORKSPACE_DIR;
	});
	const [researchWorkspaceSelected, setResearchWorkspaceSelected] = useState(
		() => localStorage.getItem(RESEARCH_WORKSPACE_SELECTED_KEY) === "1",
	);
	const lifeProbe = useLifeProbe({ client, connected, cwd: workspaceDir, model: modelValue });
	const lifeView = useMemo(
		() => presentLife(lifeProbe.channels, lifeProbe.round),
		[lifeProbe.channels, lifeProbe.round],
	);
	// 输入框项目选择器的候选列表：与侧边栏同源（当前 ∪ 有会话 ∪ 到访过），切换项目/侧边栏变更时刷新。
	const [projects, setProjects] = useState<string[]>([]);
	const [researchProjects, setResearchProjects] = useState<string[]>([]);
	const visibleProjects = useMemo(
		() => projects.filter((path) => !isProjectHidden(path, "chat")),
		[projects, projectSidebarRevision],
	);
	const visibleResearchProjects = useMemo(
		() => researchProjects.filter((path) => !isProjectHidden(path, "research")),
		[researchProjects, projectSidebarRevision],
	);
	// 斜杠命令清单（桥端 commands.list）：连接后、切项目、建/恢复会话时刷新（扩展命令随会话出现）。
	const [slashCommands, setSlashCommands] = useState<SlashCommandEntry[]>([]);
	// 两块独立面板：右侧工具侧栏（文件/编辑器/浏览器等，不含终端）与底部终端
	// 栏，各自开合、可同时存在于界面上（底栏是底栏，侧栏是侧栏）。
	const [sidebarOpen, setSidebarOpen] = useState(
		() => localStorage.getItem(WORKBENCH_OPEN_KEY) === "1" && localStorage.getItem(WORKBENCH_DOCK_KEY) !== "bottom",
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
		localStorage.getItem(CONVERSATION_VIEW_KEY) === "trajectory"
			? "trajectory"
			: localStorage.getItem(CONVERSATION_VIEW_KEY) === "context"
				? "context"
				: "chat",
	);
	// 执行记录视图固定为「正常」，入口已移除；不再读写 owl.execution.view。
	const [appKeybindings, setAppKeybindings] = useState(() => loadAppKeybindings(localStorage));
	const appKeybindingsRef = useRef(appKeybindings);
	appKeybindingsRef.current = appKeybindings;
	// 键位变更时发布快照：工具菜单等 UI 读真实键位显示提示，不另写一份硬编码。
	useEffect(() => {
		publishAppKeybindings(appKeybindings);
	}, [appKeybindings]);
	const [researchConversationView, setResearchConversationView] = useState<ConversationView>(() =>
		localStorage.getItem(RESEARCH_CONVERSATION_VIEW_KEY) === "trajectory"
			? "trajectory"
			: localStorage.getItem(RESEARCH_CONVERSATION_VIEW_KEY) === "context"
				? "context"
				: "chat",
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

	// Ctrl/⌘+滚轮复用同一套挡位缩放，并拦掉 WebView 默认的整页缩放，
	// 避免出现第二套不持久化、与应用缩放状态不同步的缩放。
	const wheelZoomRef = useRef<(direction: 1 | -1) => void>(() => {});
	wheelZoomRef.current = zoomStep;
	useEffect(() => {
		const onWheelZoom = (event: WheelEvent): void => {
			if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
			event.preventDefault();
			wheelZoomRef.current(event.deltaY < 0 ? 1 : -1);
		};
		window.addEventListener("wheel", onWheelZoom, { passive: false });
		return () => window.removeEventListener("wheel", onWheelZoom);
	}, []);

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
	// 短剧面板：机器级（全局）面板——它看的是别的应用窗口，与哪个项目/哪次对话无关，
	// 所以状态不带项目段，跨项目与跨会话共用一份。
	const mirrorStore = useMemo(() => new SidebarStore(workspaceDir, "owl.mirror.state", { scope: "global" }), []);
	const [mirrorOpen, setMirrorOpen] = useState(() => localStorage.getItem(MIRROR_OPEN_KEY) === "1");
	const [workbenchGit, setWorkbenchGit] = useState<{ cwd: string; profile?: string; status?: GitStatusResult }>();
	const onWorkbenchGitStatus = useCallback(
		(cwd: string, profile: string | undefined, status: GitStatusResult | undefined): void =>
			setWorkbenchGit({ cwd, profile, status }),
		[],
	);
	useEffect(() => {
		const unregister = registerEditorExitGuard({
			prepare: () => workbenchStore.prepareToLeave(),
			needsWarning: () => workbenchStore.hasUnprotectedEdits(),
		});
		const stopUnloadGuard = listenForUnprotectedEditorUnload(window);
		return () => {
			unregister();
			stopUnloadGuard();
		};
	}, [workbenchStore]);
	const artifacts = useMemo(
		() => collectArtifacts(entries, workspaceDir, { scope: "turn", includeCode: true }),
		[entries, workspaceDir],
	);
	// 会话级产物清单：工作台里的产物页按 productId 在这份清单里找自己的产物
	// （对话流里的产物卡只列本轮新建的，产物页要能打开整个会话的产物）。
	const sessionProducts = useMemo(
		() => collectProducts(entries, workspaceDir, { scope: "session", includeCode: true }),
		[entries, workspaceDir],
	);
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
	/** 在系统浏览器打开 URL：桥不可用时退回 window.open。
	 *  入参来自模型输出、文档与插件内容，先过白名单（仅 http/https）再交给桥或窗口。 */
	const openUrlExternally = (url: string): void => {
		const target = toExternalUrl(url);
		if (!target) return;
		void client
			.request({ type: "open.external", action: "url", target })
			.then((result) => {
				if (!result.ok) window.open(target, "_blank", "noopener,noreferrer");
			})
			.catch(() => window.open(target, "_blank", "noopener,noreferrer"));
	};
	/** 聊天正文的 http(s) 链接：交给侧边栏浏览器；「浏览器」卡片停用时走系统浏览器。 */
	const openUrlInSidebarBrowser = (url: string): void => {
		if (!isTabKindEnabled("browser", getSidebarConfig())) {
			openUrlExternally(url);
			return;
		}
		openInBrowserTab(url, t("app.browserTab"));
	};
	const openUrlExternallyRef = useRef(openUrlExternally);
	openUrlExternallyRef.current = openUrlExternally;
	// 兜底：组件没接管的外链点击一律不许导航主窗口（Tauri 窗口没有后退入口，导航走就回不来）
	useEffect(() => {
		const onClick = (event: MouseEvent): void => {
			if (event.defaultPrevented || !(event.target instanceof Element)) return;
			const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
			if (!anchor || anchor.hasAttribute("download")) return;
			const url = anchor.href;
			if (!/^https?:\/\//i.test(url) || new URL(url).origin === window.location.origin) return;
			event.preventDefault();
			openUrlExternallyRef.current(url);
		};
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, []);
	/** 打开工作区文件并定位到某一行：用编辑器打开（文档预览没有行概念），并高亮那一行。 */
	const openFileAtLine = (relative: string, line: number): void => {
		// 同一个文件若已用别的 viewer 开着，收掉旧页签，免得同文件两个页签。
		for (const tab of workbenchStore.getState().tabs) {
			if (tab.path === relative && tab.kind !== "editor") void workbenchStore.closeTab(tab.id);
		}
		if (getSidebarConfig().disabledViewers.includes("editor")) {
			void openTaskFile(relative);
			return;
		}
		workbenchStore.openFileTab("editor", relative, relative.split("/").pop() ?? relative);
		setDeveloperLayoutPersisted(false);
		if (!sidebarOpenRef.current) setSidebarOpenPersisted(true);
		focusEditorLine(relative, line);
	};
	const openTaskFile = (path: string, line?: number): Promise<void> => {
		const cwd = workspaceRef.current;
		const origin = sessionIdRef.current;
		const relative = workspaceArtifactPath(path, cwd);
		if (!relative) {
			const failed = Promise.reject<void>(new Error(t("app.fileOpenFailed")));
			void failed.catch((error: Error) => setFileOpenError(error.message));
			return failed;
		}
		setFileOpenError(undefined);
		// 带行锚点（对话里的 `路径:行号` 芯片、模型点名的那一行）：落到那一行。
		if (line !== undefined) {
			openFileAtLine(relative, line);
			return Promise.resolve();
		}
		// 工作区 HTML 优先内置浏览器：真实加载（相对资源可解析），document 预览的
		// srcDoc iframe 做不到；「浏览器」卡片停用时维持原 document 预览。
		if (/\.html?$/i.test(relative) && isTabKindEnabled("browser", getSidebarConfig())) {
			openInBrowserTab(fileUrlOf(cwd, relative), relative.split("/").pop() ?? relative);
			return Promise.resolve();
		}
		const kind = viewerKindForPath(relative, getSidebarConfig());
		if (kind === undefined) {
			const opening = client
				.request({ type: "open.external", action: "url", target: fileUrlOf(cwd, relative) })
				.then((result) => {
					if (!result.ok) throw new Error(result.error ?? t("app.fileOpenFailed"));
				});
			// Awaiting artifact controls observe the same rejection; legacy click/broadcast
			// callers still receive global feedback without an unhandled rejection.
			void opening.catch((error: unknown) => {
				if (origin === sessionIdRef.current && samePath(cwd, workspaceRef.current))
					setFileOpenError(error instanceof Error ? error.message : String(error));
			});
			return opening;
		}
		workbenchStore.openFileTab(kind, relative, relative.split("/").pop() ?? relative);
		setDeveloperLayoutPersisted(false);
		if (!sidebarOpenRef.current) setSidebarOpenPersisted(true);
		return Promise.resolve();
	};
	// 工具侧栏绑定主会话项目：研究项目不同时，研究产物交给系统默认程序打开。
	const openResearchFile = (path: string): Promise<void> => {
		const cwd = researchWorkspaceRef.current;
		const origin = researchSessionIdRef.current;
		if (samePath(cwd, workspaceRef.current)) {
			return openTaskFile(path);
		}
		const relative = workspaceArtifactPath(path, cwd);
		if (!relative) {
			const failed = Promise.reject<void>(new Error(t("app.fileOpenFailed")));
			void failed.catch((error: Error) => setFileOpenError(error.message));
			return failed;
		}
		setFileOpenError(undefined);
		const opening = client
			.request({ type: "open.external", action: "url", target: fileUrlOf(cwd, relative) })
			.then((result) => {
				if (!result.ok) throw new Error(result.error ?? t("app.fileOpenFailed"));
			});
		void opening.catch((error: unknown) => {
			if (origin === researchSessionIdRef.current && samePath(cwd, researchWorkspaceRef.current))
				setFileOpenError(error instanceof Error ? error.message : String(error));
		});
		return opening;
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

	/** 短剧面板开合：机器级面板，跨项目/会话共用（工作台里点「短剧」也走这里）。 */
	const setMirrorOpenPersisted = useCallback((open: boolean) => {
		setMirrorOpen(open);
		localStorage.setItem(MIRROR_OPEN_KEY, open ? "1" : "0");
	}, []);
	const mirrorOpenRef = useRef(mirrorOpen);
	mirrorOpenRef.current = mirrorOpen;
	const openMirrorPanel = useCallback((): void => {
		if (mirrorStore.getState().tabs.length === 0) openQuickAction(mirrorStore, "mirror");
		setMirrorOpenPersisted(true);
	}, [mirrorStore, setMirrorOpenPersisted]);
	const toggleMirrorPanel = useCallback((): void => {
		if (mirrorOpenRef.current) setMirrorOpenPersisted(false);
		else openMirrorPanel();
	}, [openMirrorPanel, setMirrorOpenPersisted]);

	/** 打开一个快捷 tab：终端归底栏，其余工具归右侧栏。 */
	const requestOpenKind = (kind: string): void => {
		if (kind === "terminal") {
			openTerminalPanel();
			return;
		}
		openQuickAction(workbenchStore, kind);
		setSidebarOpenPersisted(true);
	};
	const openExecution = (mode: "tasks" | "tool", card?: ToolCard, ownerIndex?: number): void => {
		if (!sessionId) return;
		const path = JSON.stringify({
			sessionId,
			profile: agentDir,
			mode,
			...(card ? { toolId: card.id } : {}),
			...(ownerIndex !== undefined ? { ownerIndex } : {}),
		});
		workbenchStore.openFileTab("execution", path, executionText(mode === "tasks" ? "tasks" : "toolOutput"));
		setDeveloperLayoutPersisted(false);
		setSidebarOpenPersisted(true);
	};

	/** 对话流改动卡「工作台审查」跳转：先记下要选中的文件，再打开改动审批卡片。 */
	const openWorkbenchReview = (focusPath?: string): void => {
		if (focusPath !== undefined && focusPath !== "") focusReviewEntry(focusPath);
		requestOpenKind("review");
	};

	/**
	 * 打开产物页（侧栏工作台里的一个页签）。
	 *
	 * 产物页内可以直接追问这件产物 —— 与 Claude 的 artifact page 同构：
	 * 点产物开页，页底有 composer，问答都发生在这份产物的上下文里。
	 */
	const openArtifactPage = useCallback(
		(product: Product): void => {
			workbenchStore.openArtifactTab(product.id, product.title);
			setSidebarOpenPersisted(true);
		},
		[workbenchStore],
	);

	/** 侧栏焦点快照：用户此刻在看什么（模型问「用户在看哪」时的答案）。 */
	const sidebarFocusState = (cwd: string): SidebarFocusState | undefined => {
		if (normProjectKey(cwd) !== normProjectKey(workspaceRef.current)) return undefined;
		const state = workbenchStore.getState();
		const active = state.tabs.find((tab) => tab.id === state.activeId);
		const openFiles = state.tabs.filter((tab) => tab.path !== undefined).map((tab) => tab.path!);
		const dirtyFiles = state.tabs
			.filter((tab) => state.dirty[tab.id] === true && tab.path !== undefined)
			.map((tab) => tab.path!);
		const focus = peekEditorFocus();
		// 只有焦点文件就是当前页签时才报行号：别的页签残留的光标位置不算数。
		const line =
			focus !== undefined && active?.path !== undefined && samePath(focus.path, active.path)
				? focus.line
				: undefined;
		// 用户在侧栏终端里手动跑出来的输出：模型自己没跑过，只能从这里看到。
		const terminalOutput = peekTerminalTail(terminalStore.getState().activeId);
		return {
			...(active !== undefined ? { tabKind: active.kind } : {}),
			...(active?.path !== undefined ? { path: active.path } : {}),
			...(line !== undefined ? { line } : {}),
			openFiles,
			dirtyFiles,
			...(mirrorOpen ? { mirrorOpen: true } : {}),
			...(terminalOutput.trim() !== "" ? { terminalOutput } : {}),
		};
	};

	/** 模型问侧栏「用户在看什么」：回一份焦点快照（界面不在该项目就说没有）。 */
	const handleSidebarContext = (message: SidebarContextMessage): void => {
		const state = sidebarFocusState(message.cwd);
		const reply = (snapshot: SidebarFocusState | undefined, detail?: string): void => {
			void client
				.request({
					type: "sidebar.context.result",
					requestId: message.requestId,
					...(snapshot !== undefined ? { state: snapshot } : { detail: detail ?? "当前界面在别的项目" }),
				})
				.catch(() => {});
		};
		if (state === undefined) {
			reply(undefined);
			return;
		}
		// 顺带把「改动审批」的状态带上：模型写完的改动等用户决定，用户撤销了什么
		// 模型原来完全看不见，问一次就能知道。
		void managerApi
			.diffApprovalList(
				workspaceRef.current,
				sessionIdRef.current !== undefined ? { sessionId: sessionIdRef.current } : undefined,
			)
			.then((files) => {
				const review = summarizeReviewState(files);
				reply({
					...state,
					...(review.pending.length > 0 ? { pendingReview: review.pending } : {}),
					...(review.decided.length > 0 ? { decidedReview: review.decided } : {}),
				});
			})
			.catch(() => reply(state));
	};

	/** 侧栏动作回执：回给桥，唤醒等待中的模型工具调用（旧桥没有回执 id 时跳过）。 */
	const ackSidebarShow = (
		message: SidebarShowMessage,
		status: "delivered" | "ignored" | "failed",
		detail?: string,
	): void => {
		if (message.requestId === "") return;
		void client
			.request({
				type: "sidebar.show.ack",
				requestId: message.requestId,
				status,
				...(detail !== undefined ? { detail } : {}),
			})
			.catch(() => {});
	};

	/**
	 * 模型让侧边工作台做一件事（sidebar_show）：打开文件（可定位到行）、看工作区
	 * 差异、看待审改动。做完回一条回执，模型据此知道用户到底看没看到——不再
	 * 出现「模型说已打开、界面其实收都没收到」。
	 */
	const handleSidebarShow = async (message: SidebarShowMessage): Promise<void> => {
		if (normProjectKey(message.cwd) !== normProjectKey(workspaceRef.current)) {
			ackSidebarShow(message, "ignored", "当前界面在别的项目");
			return;
		}
		const note = message.note !== undefined && message.note !== "" ? message.note : undefined;
		if (message.action === "diff") {
			// 工作区状态已知却没有这个文件的改动：别让用户对着一个空卡片点头。
			const status = workbenchGit?.status;
			const known =
				workbenchGit !== undefined &&
				normProjectKey(workbenchGit.cwd) === normProjectKey(workspaceRef.current) &&
				status?.repo === true;
			if (known && !status!.entries.some((entry) => entry.path === message.path)) {
				ackSidebarShow(message, "failed", "该文件没有工作区改动");
				return;
			}
			focusChangesFile(message.path, message.line);
			requestOpenKind("changes");
			if (note !== undefined) pushSidebarNotice(note);
			ackSidebarShow(message, "delivered");
			return;
		}
		if (message.action === "review") {
			openWorkbenchReview(message.path);
			if (note !== undefined) pushSidebarNotice(note);
			ackSidebarShow(message, "delivered");
			return;
		}
		const relative = workspaceArtifactPath(message.path, workspaceRef.current) ?? message.path;
		try {
			if (message.line !== undefined) {
				// 带行锚点：必须用能按行定位的编辑器打开（md/txt 这类默认走文档预览，
				// 预览没有行概念，指到哪一行就落不到哪一行）。
				openFileAtLine(relative, message.line);
			} else {
				await openTaskFile(relative);
			}
		} catch (error) {
			ackSidebarShow(message, "failed", error instanceof Error ? error.message : String(error));
			return;
		}
		if (message.line !== undefined) focusEditorLine(relative, message.line, message.endLine);
		if (note !== undefined) pushSidebarNotice(note);
		ackSidebarShow(message, "delivered");
	};

	// 只用到稳定的 state setter，空依赖让工作台 tab props 不随 App 重渲染变化
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const sendWorkbenchTextToChat = useCallback((text: string): void => {
		setRailView("chat");
		setShowSettings(false);
		setConversationViewPersisted("chat");
		setDraftRequest({ id: ++draftSequence.current, text });
	}, []);

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
	const researchWorkspaceRef = useRef(researchWorkspaceDir);
	researchWorkspaceRef.current = researchWorkspaceDir;
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;
	// 会话视图序号：openSession 的响应落地前用户可能又点了别的会话/新会话/切项目，
	// 序号对不上的过期响应直接丢弃，否则旧会话（连同 workspace、localStorage）
	// 会被后到的响应画回屏幕
	const sessionViewSeq = useRef(0);
	const workspaceLeaveSequence = useRef(0);
	const workbenchStoreRef = useRef(workbenchStore);
	workbenchStoreRef.current = workbenchStore;
	const prepareWorkspaceChange = async (path: string): Promise<boolean> => {
		const sequence = ++workspaceLeaveSequence.current;
		if (path === workspaceRef.current) return true;
		const source = workbenchStoreRef.current;
		const profile = agentDirRef.current;
		const allowed = await source.prepareToLeave();
		return (
			allowed &&
			sequence === workspaceLeaveSequence.current &&
			source === workbenchStoreRef.current &&
			profile === agentDirRef.current
		);
	};
	const confirmedModel =
		sessionId && sessionInfo?.model ? `${sessionInfo.model.provider}/${sessionInfo.model.id}` : modelValue;
	const modelScopeRevision = sessionViewSeq.current;
	const researchQueueRevision = researchActionSequence.current;
	const modelSelection = useModelSelection({
		client,
		sessionId,
		profile: agentDir,
		cwd: workspaceDir,
		connected,
		running,
		viewRevision: modelScopeRevision,
		isCurrent: () =>
			sessionIdRef.current === sessionId &&
			agentDirRef.current === agentDir &&
			workspaceRef.current === workspaceDir &&
			sessionViewSeq.current === modelScopeRevision,
		model: confirmedModel,
		stats: sessionInfo,
		onStart: () => {
			recoveryModelRevision.current++;
		},
		onApplied: (model, stats) => {
			recoveryModelRevision.current++;
			setModelValue(model);
			try {
				localStorage.setItem(MODEL_KEY, model);
			} catch {
				/* The host-confirmed selection remains usable without local storage. */
			}
			if (stats) {
				setSessionInfo(stats);
				setThinkingLevel(stats.thinkingLevel);
			}
		},
	});
	/** 主转录事件按帧合并：同一帧多个 text_delta 只触发一次 setEntries。 */
	const transcriptBatchRef = useRef(
		createFrameBatcher<{ message: ServerEventMessage; seq: number }>((items) => {
			const live = items.filter(
				(item) => item.seq === sessionViewSeq.current && item.message.sessionId === sessionIdRef.current,
			);
			if (live.length === 0) return;
			setEntries((current) => live.reduce((acc, item) => applyEvent(acc, item.message), current));
			setRetryStatus((current) => live.reduce((acc, item) => applyRetryEvent(acc, item.message), current));
		}),
	);
	useEffect(() => client.watchSessionEvents(sessionId), [client, sessionId]);
	useEffect(() => () => transcriptBatchRef.current.clear(), []);
	// session.create 在途标记：连点「新会话」时只放行第一笔创建，免得侧栏多出空会话
	const creatingSessionRef = useRef(false);
	const panelSessionIdRef = useRef<string | undefined>(undefined);
	panelSessionIdRef.current = railView === "research" ? researchSessionId : sessionId;
	useEffect(
		() =>
			client.onNewsOpen((message) => {
				if (message.sessionId !== sessionIdRef.current) return;
				setShowSettings(false);
				setRailView("news");
				setNewsTarget({ kind: message.kind, id: message.id, revision: Date.now() });
			}),
		[client],
	);
	useEffect(() => {
		const openNewsHash = (): void => {
			const match = /^#news\/(item|story|daily|weekly|monthly)\/([^/]+)$/.exec(
				window.location.hash.replace(/^#\//, "#"),
			);
			if (!match) return;
			let id: string;
			try {
				id = decodeURIComponent(match[2]);
			} catch {
				return;
			}
			setShowSettings(false);
			setRailView("news");
			const kind = match[1];
			if (kind === "daily" || kind === "weekly" || kind === "monthly")
				setNewsTarget({ kind, key: id, revision: Date.now() });
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
		transcriptBatchRef.current.clear();
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
		const original = entries.find((entry) => entry.kind === "user" && entry.entryId === rewindTarget?.entryId);
		setRewindTarget(undefined);
		applyRewindSnapshot(result, affectedFiles);
		if (typeof result.editorText === "string") {
			setDraftRequest({
				id: ++draftSequence.current,
				...(original?.kind === "user" ? messageInputOf(original, result.editorText) : { text: result.editorText }),
				replace: true,
			});
		}
	};

	// -- 消息操作：编辑重发 / 重新生成 ------------------------------------------
	// 两者都是「仅回退对话」到目标用户消息再重发：不动文件，模型看到的历史回到该条之前。
	const rewindConversation = async (entryId: string): Promise<RewindExecuteResult | undefined> => {
		if (!sessionIdRef.current || !connected || running || submitInFlight.current) return undefined;
		// 回退完成前就占住提交，避免编辑和重新生成再开一次。
		submitInFlight.current = true;
		setSubmitting(true);
		const origin = sessionIdRef.current;
		const viewSeq = sessionViewSeq.current;
		let handoff = false;
		try {
			const response = await client.request<RewindExecuteResult>({
				type: "rewind.execute",
				sessionId: origin,
				entryId,
				mode: "conversation",
			});
			if (origin !== sessionIdRef.current || viewSeq !== sessionViewSeq.current) return undefined;
			if (response.ok && response.result) {
				handoff = true;
				return response.result;
			}
		} catch {
			// 回退失败（会话已卸载等）：放弃本次操作，转录保持原样
		} finally {
			if (!handoff) {
				submitInFlight.current = false;
				setSubmitting(false);
			}
		}
		return undefined;
	};

	const reportRewindFailure = (origin: string | undefined): void => {
		if (origin && origin === sessionIdRef.current) setProjectNotice(t("rewind.failed"));
	};

	const handleEditMessage = async (
		entryId: string,
		text: string,
		images?: { data: string; mimeType: string }[],
	): Promise<boolean> => {
		const origin = sessionIdRef.current;
		const original = entries.find((entry) => entry.kind === "user" && entry.entryId === entryId);
		if (original?.kind !== "user") return false;
		const input = messageInputOf({ ...original, images: images ?? original.images }, text);
		const result = await rewindConversation(entryId);
		if (!result) {
			reportRewindFailure(origin);
			return false;
		}
		applyRewindSnapshot(result);
		if (!(await sendPrompt(input.text, input.images, input.attachedPaths, undefined, true)))
			setDraftRequest({ id: ++draftSequence.current, ...input });
		return true;
	};

	// 重新生成要先确认：与相邻的 ↶ 回退同为破坏性操作（当前回答不保留），
	// 此前 ⟳ 是一键即执行。这里只找目标并弹确认框，真正的回退在 confirmedRegenerate。
	const requestRegenerate = (): void => {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			// 排队跟进还没成为这一轮的用户消息，不能挡住对上一条已送达消息的重新生成。
			if (entry.kind !== "user" || entry.queued) continue;
			if (!entry.entryId) return;
			// 请求时就把完整输入（含图片/附件）锁进目标：确认前后条目可能重建。
			setRegenerateTarget({ entryId: entry.entryId, text: entry.text, input: messageInputOf(entry) });
			return;
		}
	};
	const [regenerateTarget, setRegenerateTarget] = useState<
		{ entryId: string; text: string; input: MessageInput } | undefined
	>(undefined);
	const handleRegenerate = async (target?: { entryId: string; input: MessageInput }): Promise<void> => {
		// 确认框带来的目标优先：以用户确认的那条为准（输入已在请求时锁定）。
		if (target?.entryId) {
			const origin = sessionIdRef.current;
			const result = await rewindConversation(target.entryId);
			if (!result) {
				reportRewindFailure(origin);
				return;
			}
			const input =
				result.editorText !== undefined
					? messageInputOf(
							{
								kind: "user",
								text: target.input.text,
								images: target.input.images,
								attachedPaths: target.input.attachedPaths,
							},
							result.editorText,
						)
					: target.input;
			applyRewindSnapshot(result);
			if (!(await sendPrompt(input.text, input.images, input.attachedPaths, undefined, true)))
				setDraftRequest({ id: ++draftSequence.current, ...input });
			return;
		}
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			// 排队跟进还没成为这一轮的用户消息，不能挡住对上一条已送达消息的重新生成。
			if (entry.kind !== "user" || entry.queued) continue;
			// 目标用户消息没有 entryId（旧桥/异常流）就无从回退，直接放弃
			if (!entry.entryId) return;
			const origin = sessionIdRef.current;
			const result = await rewindConversation(entry.entryId);
			if (!result) {
				reportRewindFailure(origin);
				return;
			}
			const input = messageInputOf(entry, result.editorText ?? entry.text);
			applyRewindSnapshot(result);
			if (!(await sendPrompt(input.text, input.images, input.attachedPaths, undefined, true)))
				setDraftRequest({ id: ++draftSequence.current, ...input });
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
					{
						kind: "toolResult",
						toolName: t("app.branchFailed"),
						ok: false,
						brief: response.error ?? t("app.unknownError"),
					},
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
		setProfileReady(false);
		client.connect();
		const offStatus = client.onStatus((up) => {
			setConnected(up);
			if (!up) {
				setProfileReady(false);
				setRunningReady(false);
				submitInFlight.current = false;
				setSubmitting(false);
			}
		});
		const offEvents = client.onSessionEvent((message: ServerEventMessage) => {
			// 全会话运行状态跟踪：agent_start / agent_settled 成对出现（abort、出错也走 settled），
			// 必须在下面的当前会话过滤之前记录，否则后台会话的绿点状态丢失。
			const eventType = (message.event as { type?: string }).type;
			const settlement =
				eventType === "agent_settled"
					? settledRunStatus(message.event as { aborted?: unknown }, outcomeRef.current.get(message.sessionId))
					: undefined;
			if (eventType === "permission_resolved" || eventType === "question_resolved") {
				const requestId = (message.event as { requestId?: string }).requestId;
				if (requestId) pendingResponsesRef.current.retire(requestId);
				if (eventType === "question_resolved") {
					setQuestions((current) =>
						current.filter(
							(request) => request.sessionId !== message.sessionId || request.requestId !== requestId,
						),
					);
					return;
				}
			}
			if (eventType === "agent_settled")
				pendingResponsesRef.current.retireSession(
					message.sessionId,
					[...permissionsRef.current, ...questionsRef.current]
						.filter((request) => request.sessionId === message.sessionId)
						.map((request) => request.requestId),
				);
			if (eventType === "permission_resolved" || eventType === "approval_mode_changed") {
				if (
					eventType === "approval_mode_changed" &&
					["auto", "plan"].includes(String((message.event as { approvalMode?: string }).approvalMode))
				) {
					for (const request of permissionsRef.current)
						if (request.sessionId === message.sessionId) pendingResponsesRef.current.retire(request.requestId);
				}
				setPermissions((current) => applyPermissionQueueEvent(current, message));
				const mode = approvalModeFromEvent(message);
				if (mode && message.sessionId === sessionIdRef.current)
					setObservedApprovalMode({ sessionId: message.sessionId, mode });
				return;
			}
			const now = Date.now();
			activityAtRef.current.set(message.sessionId, now);
			// 用户消息落盘即刷新侧栏：新会话文件要等首条用户消息写入才创建（桥端
			// _hasConversation 门控），此刻 refreshKey（sessionId）早已稳定不再变化，
			// 只靠 agent_settled 刷新的话，长任务运行期间侧栏一直看不到这个新对话。
			if (eventType === "queue_update") {
				const queued = message.event as Partial<SessionQueueSnapshot>;
				setPromptQueues((current) => ({
					...current,
					[promptQueueKey(agentDirRef.current, message.sessionId)]: {
						steering: [...(queued.steering ?? [])],
						followUp: [...(queued.followUp ?? [])],
					},
				}));
			}
			if (
				eventType === "entry_appended" &&
				(message.event as { entry?: { message?: { role?: string } } }).entry?.message?.role === "user"
			) {
				setSidebarRev((current) => current + 1);
			}
			if (eventType === "agent_start") {
				outcomeRef.current.delete(message.sessionId);
				const continuing = runningSessionsRef.current.has(message.sessionId);
				if (!continuing && runningReadyRef.current) {
					runTimingRef.current.delete(message.sessionId);
					authoritativeRunTimings.current.delete(message.sessionId);
				}
				updateRunTiming(message.sessionId, message.event as SessionRunTimingWire, continuing ? 0 : now);
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
					runTimingRef.current.delete(message.sessionId);
					authoritativeRunTimings.current.delete(message.sessionId);
					stepRef.current.delete(message.sessionId);
					setRunningSessions(next);
					publishActivityRef.current(next);
					const outcome = settlement!.outcome;
					outcomeRef.current.delete(message.sessionId);
					setDoneNotice({ seq: ++doneSeqRef.current, id: message.sessionId, outcome });
				}
			} else if (eventType === "agent_end") {
				const end = message.event as { willRetry?: boolean; messages?: { role?: string; stopReason?: string }[] };
				const assistant = !end.willRetry
					? [...(end.messages ?? [])].reverse().find((item) => item.role === "assistant")
					: undefined;
				if (assistant?.stopReason) {
					const reason = assistant.stopReason;
					outcomeRef.current.set(
						message.sessionId,
						reason === "aborted" ? "aborted" : reason === "error" ? "error" : "done",
					);
				}
			} else if (eventType === "message_update" && runningSessionsRef.current.has(message.sessionId)) {
				const update = (
					message.event as {
						assistantMessageEvent?: {
							type?: string;
							toolName?: string;
							toolCall?: { name?: string };
							contentIndex?: number;
							partial?: { content?: { name?: string }[] };
						};
					}
				).assistantMessageEvent;
				if (update?.type === "toolcall_start" || update?.type === "toolcall_end") {
					const tool =
						update.toolName ??
						update.toolCall?.name ??
						update.partial?.content?.[update.contentIndex ?? -1]?.name;
					if (tool) noteStepRef.current(message.sessionId, tool);
				} else if (update?.type === "thinking_delta") noteStepRef.current(message.sessionId, "thinking");
				else if (update?.type === "text_delta") noteStepRef.current(message.sessionId, "writing");
			} else if (
				runningSessionsRef.current.has(message.sessionId) &&
				activityLeaderRef.current !== message.sessionId
			) {
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
			transcriptBatchRef.current.push({ message, seq: sessionViewSeq.current });
			if (!isStreamingDeltaEvent(message)) transcriptBatchRef.current.flush();
			if (eventType === "agent_settled") {
				void refreshStats();
				if (settlement?.notifyDone)
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
				setPermissions((current) =>
					current.some((pending) => pending.requestId === request.requestId) ? current : [...current, request],
				);
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
			setQuestions((current) =>
				current.some((pending) => pending.requestId === request.requestId) ? current : [...current, request],
			);
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
			if (
				payload?.kind !== "decision" ||
				typeof payload.requestId !== "string" ||
				typeof payload.approved !== "boolean"
			)
				return;
			answerAndRestore(payload.requestId, permissionsRef, setPermissions, () =>
				client.respondPermission(payload.requestId!, payload.approved!),
			);
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
			const action = matchingAppAction(event, appKeybindingsRef.current);
			if (!action) return;
			event.preventDefault();
			shortcutsRef.current[action]();
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
			else
				workbenchStore.openNew(
					"browser",
					target.title || t("app.browserTab"),
					encodeIabPath(target.pageId, target.url, target.sessionId),
				);
			setSidebarOpenPersisted(true);
		});
	}, [client, workbenchStore]); // eslint-disable-line react-hooks/exhaustive-deps

	// sidebar_show 工具广播：模型请求侧边工作台做一件事（设置页「侧边卡片」
	// 开启工具注入后才会出现）。处理完回一条回执：delivered=用户看得到，
	// ignored=界面不在该项目（用户没看到），failed=目标打不开。模型据此
	// 判断，别再假报「已打开」。
	useEffect(() => {
		return client.onSidebarMessage((message) => {
			void handleSidebarShow(message);
		});
	}, [client, workbenchStore]); // eslint-disable-line react-hooks/exhaustive-deps

	// sidebar_context：模型问用户此刻在看什么（App 回焦点快照）。
	useEffect(() => {
		return client.onSidebarContext((message) => {
			handleSidebarContext(message);
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
		// 离开设置页后重读 enabledModels，使「正在使用中的模型」勾选立刻反映到对话选择器。
		void client
			.request<{ settings: unknown }>({ type: "settings.get" })
			.then((response) => {
				if (!response.ok) return;
				const settings = response.result?.settings as Record<string, unknown> | undefined;
				setEnabledModels(parseEnabledModels(settings?.enabledModels));
			})
			.catch(() => {});
	}, [connected, client, showSettings]);

	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		// 连接后拉一次运行中的会话：UI 刷新或桥重连后恢复侧边栏的运行状态点。
		void client
			.request<SessionRunningResult>({ type: "session.running" })
			.then((response) => {
				if (cancelled || !response.ok) return;
				const ids = response.result?.running ?? [];
				const now = Date.now();
				const timings = new Map(response.result?.runs?.map((run) => [run.sessionId, run]));
				for (const id of ids) {
					if (!activityAtRef.current.has(id)) activityAtRef.current.set(id, now);
					updateRunTiming(id, timings.get(id));
				}
				const next = new Set(ids);
				runningSessionsRef.current = next;
				setRunningSessions(next);
				publishActivityRef.current(next);
				setPendingPrompts(new Set());
				setRunningReady(true);
			})
			.catch(() => {});
		// 主题偏好存放在 settings.json（dark / light / system），连上桥后立即应用；
		// 外观自定义颜色（owlAppearance：强调色 + 深浅各自的背景/前景）同源加载；
		// 侧边卡片配置（owlSidebar）同源拉取，供工作台/快捷入口即时生效。
		void client
			.request<{ agentDir: string; settings: unknown }>({ type: "settings.get" })
			.then(async (response) => {
				if (cancelled || !response.ok) return;
				if (response.result?.agentDir?.trim()) {
					if (agentDirRef.current && !samePath(agentDirRef.current, response.result.agentDir)) {
						pendingResponsesRef.current.invalidate();
						setPermissions([]);
						setQuestions([]);
						setPermissionDetailId(undefined);
						setDeferredPermissions(new Set());
					}
					setAgentDir(response.result.agentDir);
					setProfileReady(true);
				}
				const settings = response.result?.settings as Record<string, unknown> | undefined;
				if (isThemePreference(settings?.theme)) setThemePreference(settings.theme);
				const appearance = parseOwlAppearance(settings?.owlAppearance);
				setThemeLock(presetThemeLock(appearance.preset));
				applyOwlAppearance(appearance);
				const glassReady = syncWindowGlass(appearance);
				// 动态壁纸：写 <html data-owl-wallpaper> 门控属性 + 同步渲染层状态
				const wallpaperSettings = parseOwlWallpaper(settings?.owlWallpaper);
				applyOwlWallpaper(wallpaperSettings);
				setWallpaper(wallpaperSettings);
				// 动画设置（启动动画 + 背景动画）：模块级订阅存储，背景层与设置页各自订阅
				applyOwlAnimation(settings?.owlAnimation);
				setSidebarConfig(parseSidebarSettings(settings?.owlSidebar));
				setFileIconTheme(parseFileIconTheme(settings?.fileIconTheme));
				applyChatAppearance(parseChatAppearance(settings?.desktopChatAppearance));
				// 界面语言随 settings.json 启动加载；设置页/左下角菜单切换后经 settings.set 持久化。
				setUiLanguageSetting(parseUiLanguageSetting(settings?.uiLanguage));
				// 通知偏好（owlNotifications）：启动时同步进模块级缓存，notifyAgentStatus 据此门控
				setNotificationPrefs(parseNotificationPrefs(settings?.owlNotifications));
				setEnabledModels(parseEnabledModels(settings?.enabledModels));
				await glassReady;
			})
			.catch(() => {})
			.finally(() => {
				if (!cancelled) completeStartupAppearance();
			});
		// 工作目录必须存在，否则 session.create 会失败（默认目录首启、或本地记录的目录被删）。
		// project.create 即 mkdir -p：目录已有时是幂等空操作，顺带把路径规范化后回填显示。
		const startingWorkspace = workspaceRef.current;
		const startingLeaveSequence = workspaceLeaveSequence.current;
		void client
			.request<{ path: string }>({ type: "project.create", path: startingWorkspace })
			.then(async (response) => {
				if (
					!cancelled &&
					startingWorkspace === workspaceRef.current &&
					startingLeaveSequence === workspaceLeaveSequence.current &&
					response.ok &&
					response.result?.path &&
					(await prepareWorkspaceChange(response.result.path))
				)
					setWorkspaceDir(response.result.path);
			})
			.catch(() => {});
		if (!samePath(researchWorkspaceRef.current, workspaceRef.current)) {
			void client
				.request<{ path: string }>({ type: "project.create", path: researchWorkspaceRef.current })
				.then((response) => {
					if (response.ok && response.result?.path) setResearchWorkspaceDir(response.result.path);
				})
				.catch(() => {});
		}
		return () => {
			cancelled = true;
		};
	}, [connected, client, completeStartupAppearance]);

	useEffect(() => {
		if (!agentDir) return;
		const saved = loadIslandMemory(localStorage, agentDir);
		if (!saved) return;
		for (const item of saved.running) {
			if (!authoritativeRunTimings.current.has(item.id) && !runTimingRef.current.get(item.id)?.runId) {
				runTimingRef.current.set(
					item.id,
					resolveSessionRunTiming(runTimingRef.current.get(item.id), { startedAt: item.startedAt }),
				);
			}
			if (!activityAtRef.current.has(item.id)) activityAtRef.current.set(item.id, item.lastActivityAt);
			if (item.step && !stepRef.current.has(item.id)) stepRef.current.set(item.id, item.step);
		}
		setListedTitles(
			(current) =>
				new Map(
					[...saved.finished, ...saved.running].map((item) => [item.id, item.title] as const).concat([...current]),
				),
		);
		setStepRev((current) => current + 1);
		publishActivityRef.current(runningSessionsRef.current);
	}, [agentDir]);

	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		void client
			.request<SessionRowLite[]>({ type: "session.list" })
			.then((response) => {
				if (cancelled || !response.ok || !response.result) return;
				const next = new Map<string, string>();
				const cwds = new Map<string, string>();
				for (const row of response.result) {
					if (!row.id) continue;
					if (row.cwd) cwds.set(row.id, row.cwd);
					next.set(
						row.id,
						islandSessionTitle(row, {
							unnamed: t("sidebar.sessionUnnamed"),
							branch: t("app.branchSuffix"),
							fallback: t("sidebar.sessionFallback", { id: row.id.slice(0, 8) }),
						}),
					);
				}
				listedCwdsRef.current = cwds;
				setListedTitles(next);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
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
		return () => {
			cancelled = true;
		};
	}, [client, connected]);

	function selectedModel(): { provider: string; model: string } | undefined {
		const value = modelValue;
		if (!value) return undefined;
		const slash = value.indexOf("/");
		if (slash <= 0) return undefined;
		return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
	}

	/** 模型替换提示的去重键：同一个「原模型 → 新模型」只提一次。 */
	function modelFallbackKey(fallback: ModelFallbackNoticePayload): string {
		return `${fallback.saved.provider}/${fallback.saved.id}->${fallback.used.provider}/${fallback.used.id}`;
	}

	/** 当前要展示的模型替换提示（已点过「知道了」的不再出现）。 */
	const modelFallbackNotice = useMemo(() => {
		const fallback = sessionInfo?.modelFallback;
		if (!fallback) return undefined;
		return dismissedModelFallbacks.includes(modelFallbackKey(fallback)) ? undefined : fallback;
	}, [sessionInfo?.modelFallback, dismissedModelFallbacks]);

	// 会话状态（模型/思考/上下文用量）：创建、恢复、每轮对话结束后刷新。
	async function refreshStats(id?: string): Promise<void> {
		const target = id ?? sessionIdRef.current;
		if (!target) return;
		const modelRevision = recoveryModelRevision.current;
		const queueProfile = agentDirRef.current;
		try {
			const response = await client.request<SessionStatsResult>({ type: "session.stats", sessionId: target });
			// 落地时会话可能已切走：过期统计画进当前会话就是用量环/模型名串话
			if (
				response.ok &&
				target === sessionIdRef.current &&
				modelRevision === recoveryModelRevision.current &&
				!modelSelection.isPending()
			) {
				setSessionInfo(response.result ?? undefined);
				if (response.result?.queue) {
					setPromptQueues((current) => ({
						...current,
						[promptQueueKey(queueProfile, target)]: response.result!.queue!,
					}));
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
		const viewSeq = sessionViewSeq.current;
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
			if (viewSeq !== sessionViewSeq.current || sessionIdRef.current) return undefined;
			if (!response.ok || !response.result) {
				console.error("session.create failed:", response.error);
				setEntries([
					{
						kind: "toolResult",
						toolName: t("app.sessionCreateFailed"),
						ok: false,
						brief: response.error ?? t("app.unknownError"),
					},
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
		setSearchHistory(undefined);
		setSearchTarget(undefined);
		setProjectNotice(undefined);
		setProjectRestoring(undefined);
		setSessionOpening(undefined);
		setSessionOpenFailed(undefined);
		setSubagentSelection(undefined);
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
	const resetToWorkspace = async (path: string): Promise<boolean> => {
		if (!(await prepareWorkspaceChange(path))) return false;
		setProjectRestoring(undefined);
		setSessionOpening(undefined);
		setSessionOpenFailed(undefined);
		setSearchHistory(undefined);
		sessionViewSeq.current += 1;
		sessionIdRef.current = undefined;
		workspaceRef.current = path;
		setSearchTarget(undefined);
		setWorkspaceDir(path);
		localStorage.setItem(WORKSPACE_KEY, path);
		setSessionId(undefined);
		setEntries([]);
		setRetryStatus(null);
		setSessionInfo(undefined);
		setSessionBranched(false);
		setSessionName(undefined);
		setSessionPreset(undefined);
		return true;
	};

	// 切换项目：绑定目录（chip 显示）并从新会话开始。
	const switchProject = (path: string): void => {
		void restoreProjectConversation(path, "chat");
	};

	// 叉掉目录（输入框 chip 上的 ✕）：不选目录对话，会话默认进 DEFAULT_WORKSPACE_DIR。
	// 当前会话已经在默认目录时原地继续，不打断；否则换到默认目录并从新会话开始。
	const clearWorkspaceSelection = async (): Promise<void> => {
		if (!workspaceSelected) return;
		if (!samePath(workspaceRef.current, DEFAULT_WORKSPACE_DIR) && !(await resetToWorkspace(DEFAULT_WORKSPACE_DIR)))
			return;
		setWorkspaceSelected(false);
		localStorage.setItem(WORKSPACE_SELECTED_KEY, "0");
	};

	// 研究工作台换目录：只动研究侧（研究页按目录重建会话控制器），主会话原地不动。
	const resetResearchWorkspace = (path: string): void => {
		setProjectRestoring(undefined);
		setSearchHistory(undefined);
		sessionViewSeq.current += 1;
		researchWorkspaceRef.current = path;
		setSearchTarget(undefined);
		pendingResearchRestoreId.current = undefined;
		setResearchConversationTitle(undefined);
		setResearchResumeRequest(undefined);
		setResearchSessionId(undefined);
		setResearchWorkspaceDir(path);
		localStorage.setItem(RESEARCH_WORKSPACE_KEY, path);
	};

	const switchResearchProject = (path: string): void => {
		void restoreProjectConversation(path, "research");
	};

	/** Project names resume work; the adjacent compose action always opens a fresh conversation. */
	const newChatInProject = async (path: string, scope: "chat" | "research"): Promise<void> => {
		setProjectRestoring(undefined);
		setProjectNotice(undefined);
		if (scope === "research") {
			try {
				localStorage.removeItem(researchSessionKey(path));
			} catch {
				/* In-memory reset remains available. */
			}
			resetResearchWorkspace(path);
			setResearchWorkspaceSelected(true);
			localStorage.setItem(RESEARCH_WORKSPACE_SELECTED_KEY, "1");
			setResearchNewConversationRequest((current) => current + 1);
		} else {
			if (!(await resetToWorkspace(path))) return;
			setWorkspaceSelected(true);
			localStorage.setItem(WORKSPACE_SELECTED_KEY, "1");
		}
	};

	async function restoreProjectConversation(path: string, scope: "chat" | "research"): Promise<void> {
		if (!connected) return;
		const currentPath = scope === "research" ? researchWorkspaceRef.current : workspaceRef.current;
		const currentId = scope === "research" ? researchSessionIdRef.current : sessionIdRef.current;
		if (samePath(path, currentPath) && currentId) return;
		const profile = agentDirRef.current;
		// 查到目标会话之前不动现有画面：先只作废在途会话视图，等会话数据就绪后由
		// openSession 一次性换屏。先清空（旧 resetToWorkspace 路径）会让 ChatStream 的
		// key 短暂落到起始页再重建，看起来是整屏闪一下。
		sessionViewSeq.current += 1;
		const token = sessionViewSeq.current;
		setProjectRestoring({ scope, path, token });
		setProjectNotice(undefined);
		try {
			const response = await client.request<SessionRowLite[]>({ type: "session.list", scope });
			if (token !== sessionViewSeq.current || profile !== agentDirRef.current) return;
			if (!response.ok || !response.result) throw new Error(response.error ?? t("app.projectRestoreFailed"));
			const choice = resolveProjectSession(localStorage, profile, scope, path, response.result);
			if (scope === "research") {
				try {
					if (choice.sessionId) localStorage.setItem(researchSessionKey(path), choice.sessionId);
					else localStorage.removeItem(researchSessionKey(path));
				} catch {
					/* The explicit resume request is authoritative. */
				}
				resetResearchWorkspace(path);
				setResearchWorkspaceSelected(true);
				localStorage.setItem(RESEARCH_WORKSPACE_SELECTED_KEY, "1");
				if (choice.sessionId) {
					pendingResearchRestoreId.current = choice.sessionId;
					setResearchSessionId(choice.sessionId);
					setResearchResumeRequest({ id: choice.sessionId, revision: ++researchActionSequence.current });
				} else {
					setResearchNewConversationRequest((current) => current + 1);
				}
			} else if (choice.sessionId) {
				const opening = openSession(choice.sessionId, { silent: true, projectRestore: true });
				const restoreSeq = sessionViewSeq.current;
				await opening;
				if (restoreSeq !== sessionViewSeq.current || sessionIdRef.current !== choice.sessionId) return;
				setWorkspaceSelected(true);
				localStorage.setItem(WORKSPACE_SELECTED_KEY, "1");
			} else {
				// 该项目没有可恢复的会话：唯一需要清屏的情况，落到绑定新目录的全新起始页。
				if (!(await resetToWorkspace(path))) return;
				setWorkspaceSelected(true);
				localStorage.setItem(WORKSPACE_SELECTED_KEY, "1");
			}
			if (choice.fallback)
				setProjectNotice(t(choice.sessionId ? "app.projectRestoreFallback" : "app.projectRestoreEmpty"));
		} catch (error) {
			if (token === sessionViewSeq.current)
				setProjectNotice(
					`${t("app.projectRestoreFailed")} ${error instanceof Error ? error.message : String(error)}`,
				);
		} finally {
			setProjectRestoring((current) => (current?.token === token ? undefined : current));
		}
	}

	const clearResearchWorkspaceSelection = (): void => {
		if (!researchWorkspaceSelected) return;
		setResearchWorkspaceSelected(false);
		localStorage.setItem(RESEARCH_WORKSPACE_SELECTED_KEY, "0");
		if (samePath(researchWorkspaceRef.current, DEFAULT_WORKSPACE_DIR)) return;
		resetResearchWorkspace(DEFAULT_WORKSPACE_DIR);
	};

	/** 侧栏、新建项目等共用入口：切的是当前所在视图（主会话 / 研究工作台）的项目。 */
	const switchScopedProject = (path: string): void => {
		if (railViewRef.current === "research") switchResearchProject(path);
		else switchProject(path);
	};

	// 恢复历史会话：回放消息快照、切到该会话的项目视图，后续 prompt 直接续聊。
	// silent：自动恢复专用——失败不留错误横幅，退回空白新会话即可（用户没主动点过它）。
	const openSession = async (
		targetSessionId: string,
		options?: { silent?: boolean; preserveRail?: boolean; projectRestore?: boolean; canApply?: () => boolean },
	): Promise<void> => {
		if (!options?.projectRestore) setProjectRestoring(undefined);
		setSearchHistory(undefined);
		setSearchTarget(undefined);
		setProjectNotice(undefined);
		setSubagentSelection(undefined);
		const requestSeq = ++sessionViewSeq.current;
		setSessionOpenFailed(undefined);
		if (!options?.projectRestore) setSessionOpening({ id: targetSessionId, token: requestSeq });
		const queueProfile = agentDirRef.current;
		try {
			const response = await client.request<{
				sessionId: string;
				cwd: string;
				messages: Record<string, unknown>[];
				messageEntryIds?: (string | undefined)[];
				running?: boolean;
				queue?: SessionQueueSnapshot;
				run?: DesktopRunTiming;
				runStartMessageIndex?: number;
				researchMode?: ResearchMode;
				/** 会话头（含 parentSession）：分支出来的无名会话顶栏标题要加「· 分支」后缀 */
				header?: { parentSession?: string };
				/** 会话持久化显示名（session_info，如分支的「fork2 · 来自「你好」」） */
				name?: string;
				/** 会话绑定的 Agent 预设 id：顶栏标签与选择器显示它。 */
				agentPreset?: string;
				approvalMode?: ApprovalMode;
			}>({
				type: "session.resume",
				sessionId: targetSessionId,
				approvalModeFallback: approvalMode,
				...selectedModel(),
			});
			// 响应落地前用户又做了新的会话切换：这份过期响应整体丢弃（含错误横幅，
			// 免得旧会话的失败盖在别的会话视图上）
			if (requestSeq !== sessionViewSeq.current || (options?.canApply && !options.canApply())) return;
			if (!response.ok || !response.result) {
				console.error("session.resume failed:", response.error);
				// 恢复失败行自带「重试」入口，silent 的自动恢复失败也记录；替代原 projectNotice 单行提示。
				setSessionOpenFailed({ id: targetSessionId, message: response.error ?? t("app.sessionRestoreFailed") });
				if (options?.canApply) throw new Error(response.error ?? t("app.sessionRestoreFailed"));
				return;
			}
			const { sessionId: resumedId, cwd, messages, messageEntryIds, researchMode } = response.result;
			if (response.result.run) updateRunTiming(resumedId, response.result.run);
			if (researchMode !== undefined) {
				if (options?.preserveRail) return;
				if (options?.silent && railViewRef.current !== "chat") return;
				if (!samePath(cwd, researchWorkspaceRef.current)) resetResearchWorkspace(cwd);
				setShowSettings(false);
				setResearchMounted(true);
				setRailView("research");
				pendingResearchRestoreId.current = resumedId;
				researchSessionIdRef.current = resumedId;
				setResearchSessionId(resumedId);
				setResearchResumeRequest({ id: resumedId, revision: ++researchActionSequence.current });
				return;
			}
			if (!(await prepareWorkspaceChange(cwd))) return;
			if (requestSeq !== sessionViewSeq.current || (options?.canApply && !options.canApply())) return;
			if (!options?.preserveRail && !options?.silent && railViewRef.current === "research") setRailView("chat");
			setWorkspaceDir(cwd);
			localStorage.setItem(WORKSPACE_KEY, cwd);
			setSessionId(resumedId);
			sessionIdRef.current = resumedId;
			if (response.result.queue)
				setPromptQueues((current) => ({
					...current,
					[promptQueueKey(queueProfile, resumedId)]: response.result!.queue!,
				}));
			transcriptBatchRef.current.clear();
			setEntries(
				rebuild(messages, messageEntryIds, {
					running: response.result.running ?? runningSessionsRef.current.has(resumedId),
					runStartMessageIndex: response.result.runStartMessageIndex,
				}),
			);
			setRetryStatus(null);
			setSessionBranched(Boolean(response.result.header?.parentSession));
			setSessionName(response.result.name);
			setSessionPreset(response.result.agentPreset);
			if (response.result.approvalMode)
				setObservedApprovalMode({ sessionId: resumedId, mode: response.result.approvalMode });
			void refreshStats(resumedId);
		} finally {
			// 出口统一清掉在途标记（过期响应/失败/转研究视图/成功都算走完）；更新的打开请求不受影响。
			setSessionOpening((current) => (current?.token === requestSeq ? undefined : current));
		}
	};

	const openSearchHit = async (hit: SessionSearchHit, query: string): Promise<void> => {
		const requestId = ++searchSequence.current;
		await openSession(hit.sessionId);
		if (requestId !== searchSequence.current) return;
		if (
			hit.scope === "research"
				? pendingResearchRestoreId.current !== hit.sessionId && researchSessionIdRef.current !== hit.sessionId
				: sessionIdRef.current !== hit.sessionId
		)
			return;
		setShowSettings(false);
		if (hit.scope === "research") setResearchConversationViewPersisted("chat");
		else {
			setRailView("chat");
			setConversationViewPersisted("chat");
		}
		if (!hit.entryId) return;
		setSearchTarget({ sessionId: hit.sessionId, entryId: hit.entryId, query, requestId });
		const viewSeq = sessionViewSeq.current;
		try {
			const response = await client.request<SessionSearchMessageResult>({
				type: "session.searchMessage",
				sessionId: hit.sessionId,
				entryId: hit.entryId,
			});
			if (viewSeq !== sessionViewSeq.current || requestId !== searchSequence.current) return;
			if (response.ok && response.result) setSearchHistory({ sessionId: hit.sessionId, result: response.result });
			else setProjectNotice(t("app.searchMessageUnavailable"));
		} catch {
			if (viewSeq === sessionViewSeq.current && requestId === searchSequence.current)
				setProjectNotice(t("app.searchMessageUnavailable"));
		}
	};

	useEffect(() => {
		if (projectRestoring?.scope !== "chat")
			rememberProjectSession(localStorage, agentDir, "chat", workspaceDir, sessionId);
		if (projectRestoring?.scope !== "research")
			rememberProjectSession(localStorage, agentDir, "research", researchWorkspaceDir, researchSessionId);
	}, [agentDir, workspaceDir, sessionId, researchWorkspaceDir, researchSessionId, projectRestoring]);

	// 助理会话由「我的助理」面板的独立线程承载：灵动岛要跳回那里，不能装进主页对话。
	const openIslandSession = async (id: string): Promise<void> => {
		setShowSettings(false);
		let cwd = listedCwdsRef.current.get(id);
		if (cwd === undefined) {
			const response = await client.request<SessionRowLite[]>({ type: "session.list" }).catch(() => undefined);
			cwd = response?.ok ? response.result?.find((row) => row.id === id)?.cwd : undefined;
		}
		if (cwd && myselfDirCandidates(workspaceRef.current, agentDir).some((dir) => samePath(dir, cwd))) {
			setMyselfMounted(true);
			setRailView("myself");
			setMyselfOpenRequest({ id, revision: ++myselfOpenSequence.current });
			return;
		}
		await openSession(id);
	};

	// 上一个/下一个会话（Ctrl+Shift+[ / ]）：当前项目内按最近活跃排序循环切换。
	// 与侧边栏同源（session.list），排除归档行；桥瞬断时静默放弃。
	const cycleSession = async (direction: 1 | -1): Promise<void> => {
		try {
			const scope = railViewRef.current === "research" ? "research" : "chat";
			const response = await client.request<SessionRowLite[]>({ type: "session.list", scope });
			if (!response.ok || !response.result) return;
			const cwd = scope === "research" ? researchWorkspaceRef.current : workspaceRef.current;
			const rows = response.result
				.filter(
					(row) =>
						matchesSessionScope(row, scope) &&
						row.id &&
						typeof row.archivedAt !== "string" &&
						samePath(row.cwd, cwd),
				)
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

	useWorkspaceMemory({
		profile: agentDir,
		connected,
		place: {
			rail: railView,
			settings: showSettings,
			settingsTab: settingsSection,
			chatSession: sessionId,
			researchSession: researchSessionId,
			workspace: workspaceDir,
			workspaceSelected,
			researchWorkspace: researchWorkspaceDir,
			researchWorkspaceSelected,
			conversationView,
			researchConversationView,
			sidebarMinimized,
			newsSidebarMinimized,
			sidebarOpen,
			terminalOpen,
			developerLayout,
		},
		cancelRestore: () => {
			sessionViewSeq.current += 1;
			pendingResearchRestoreId.current = undefined;
		},
		restore: async (saved, canApply) => {
			const response = await client.request<SessionRowLite[]>({ type: "session.list" });
			if (!response.ok || !response.result) throw new Error(response.error ?? "Session list unavailable");
			if (!canApply()) return;
			if (!saved) {
				// First upgrade keeps the incumbent recent-session fallback until an exact location is saved.
				if (railViewRef.current === "research" || sessionIdRef.current) return;
				const rows = response.result.filter(
					(row) =>
						matchesSessionScope(row, "chat") &&
						row.id &&
						typeof row.archivedAt !== "string" &&
						samePath(row.cwd, workspaceRef.current),
				);
				const populated = rows.filter((row) => (row.messageCount ?? 0) > 0);
				const latest = (populated.length ? populated : rows).sort((a, b) =>
					rowTime(b).localeCompare(rowTime(a)),
				)[0];
				if (latest?.id) await openSession(latest.id, { silent: true, preserveRail: true, canApply });
				return;
			}
			const snapshot = resolveWorkspaceMemory(saved, response.result);
			const requestedView =
				new URLSearchParams(window.location.search).get("view") ||
				/^#news\/(item|story|daily|weekly|monthly)\/[^/]+$/.test(window.location.hash.replace(/^#\//, "#"));
			const view = requestedView ? railViewRef.current : snapshot.rail;
			if (!(await prepareWorkspaceChange(snapshot.workspace)) || !canApply()) return;
			const researchKey = researchSessionKey(snapshot.researchWorkspace);
			if (snapshot.researchSession) localStorage.setItem(researchKey, snapshot.researchSession);
			else localStorage.removeItem(researchKey);
			if (view === "mail") setMailMounted(true);
			if (view === "media") setMediaMounted(true);
			if (view === "guide") setGuideMounted(true);
			if (view === "career") setCareerMounted(true);
			if (view === "automation") setAutomationMounted(true);
			if (view === "myself") setMyselfMounted(true);
			if (view === "expert") setExpertMounted(true);
			if (view === "bagu") setBaguMounted(true);
			if (view === "market") setMarketMounted(true);
			if (view === "evaluation") setEvaluationMounted(true);
			if (view === "research" || snapshot.researchSession) setResearchMounted(true);
			setWorkspaceDir(snapshot.workspace);
			workspaceRef.current = snapshot.workspace;
			localStorage.setItem(WORKSPACE_KEY, snapshot.workspace);
			setWorkspaceSelected(snapshot.workspaceSelected);
			localStorage.setItem(WORKSPACE_SELECTED_KEY, snapshot.workspaceSelected ? "1" : "0");
			setResearchWorkspaceDir(snapshot.researchWorkspace);
			researchWorkspaceRef.current = snapshot.researchWorkspace;
			localStorage.setItem(RESEARCH_WORKSPACE_KEY, snapshot.researchWorkspace);
			setResearchWorkspaceSelected(snapshot.researchWorkspaceSelected);
			localStorage.setItem(RESEARCH_WORKSPACE_SELECTED_KEY, snapshot.researchWorkspaceSelected ? "1" : "0");
			setConversationViewPersisted(snapshot.conversationView);
			setResearchConversationViewPersisted(snapshot.researchConversationView);
			setSidebarMinimized(snapshot.sidebarMinimized);
			localStorage.setItem(SIDEBAR_MINIMIZED_KEY, snapshot.sidebarMinimized ? "1" : "0");
			setNewsSidebarMinimized(snapshot.newsSidebarMinimized);
			localStorage.setItem(NEWS_SIDEBAR_MINIMIZED_KEY, snapshot.newsSidebarMinimized ? "1" : "0");
			setSidebarOpenPersisted(snapshot.sidebarOpen);
			setTerminalOpenPersisted(snapshot.terminalOpen);
			setDeveloperLayoutPersisted(snapshot.developerLayout);
			setSettingsSection(snapshot.settingsTab);
			setShowSettings(requestedView ? false : snapshot.settings);
			setRailView(view);
			if (snapshot.researchSession) {
				pendingResearchRestoreId.current = snapshot.researchSession;
				setResearchSessionId(snapshot.researchSession);
				setResearchResumeRequest({ id: snapshot.researchSession, revision: ++researchActionSequence.current });
			}
			if (snapshot.chatSession)
				await openSession(snapshot.chatSession, { silent: true, preserveRail: true, canApply });
		},
	});

	// 输入框项目选择器的候选列表：session.list 的项目 ∪ 到访过的项目 ∪ 当前项目（与侧边栏同源）。
	// 保留目录（默认目录/助理目录）一律不进候选（当前位置由输入框 chip 标识）；切项目 / 侧边栏重拉
	// （恢复、删除归档）时刷新；桥瞬断静默跳过。
	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		void client
			.request<SessionRowLite[]>({ type: "session.list" })
			.then((response) => {
				if (!response.ok || !response.result || cancelled) return;
				initializeResearchSidebar(localStorage, response.result);
				for (const scope of ["chat", "research"] as const) {
					const seen = new Map<string, string>();
					const track = (path: string | undefined): void => {
						if (!path || isReservedDir(path) || isValidationDir(path)) return;
						const key = normPath(path);
						if (!seen.has(key)) seen.set(key, path);
					};
					if (scope === "research") track(researchWorkspaceSelected ? researchWorkspaceRef.current : undefined);
					else track(workspaceSelected ? workspaceRef.current : undefined);
					for (const row of response.result) if (matchesSessionScope(row, scope)) track(row.cwd);
					for (const path of loadAndScrubProjects(localStorage, sidebarStorageKeys(scope).projects)) track(path);
					if (scope === "research") setResearchProjects([...seen.values()]);
					else setProjects([...seen.values()]);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [
		connected,
		client,
		workspaceDir,
		workspaceSelected,
		researchWorkspaceDir,
		researchWorkspaceSelected,
		sidebarRev,
		railView,
		researchSessionId,
		sessionId,
	]);

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

	// Host confirmation owns the current selection; new threads only stage a preference.
	const handleModelChange = modelSelection.select;

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
		setObservedApprovalMode(undefined);
		setApprovalMode(mode);
		localStorage.setItem(APPROVAL_KEY, mode);
		const current = sessionIdRef.current;
		if (!current) return;
		void client.request({ type: "session.setApprovalMode", sessionId: current, approvalMode: mode }).catch(() => {});
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
				const viewSeq = sessionViewSeq.current;
				const stillHere = (): boolean => target === sessionIdRef.current && viewSeq === sessionViewSeq.current;
				if (!stillHere()) return true;
				setEntries((current) => [
					...current,
					{ kind: "toolResult", toolName: t("app.compactTool"), ok: true, brief: t("app.compactStarted") },
				]);
				try {
					const response = await client.request<SessionStatsResult>({
						type: "session.compact",
						sessionId: target,
					});
					if (!stillHere()) return true;
					setEntries((current) => [
						...current,
						response.ok
							? { kind: "toolResult", toolName: t("app.compactTool"), ok: true, brief: t("app.compactDone") }
							: {
									kind: "toolResult",
									toolName: t("app.compactTool"),
									ok: false,
									brief: response.error ?? t("app.compactFailed"),
								},
					]);
					if (response.ok && response.result) setSessionInfo(response.result);
				} catch (error) {
					if (!stillHere()) return true;
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

	const sendPrompt = async (
		message: string,
		images?: ComposerImage[],
		attachedPaths?: string[],
		delivery?: "queue" | "steer",
		handoff = false,
	): Promise<boolean> => {
		const hasImages = (images?.length ?? 0) > 0;
		const hasAttachments = (attachedPaths?.length ?? 0) > 0;
		const queueing = running;
		const viewSeq = sessionViewSeq.current;
		const sourceProfile = agentDirRef.current;
		const releaseHandoff = (): void => {
			if (!handoff) return;
			submitInFlight.current = false;
			setSubmitting(false);
		};
		if (!connected || (!handoff && submitInFlight.current) || (!message.trim() && !hasImages && !hasAttachments)) {
			releaseHandoff();
			return false;
		}
		submitInFlight.current = true;
		setSubmitting(true);
		let target: string | undefined;
		let optimisticEntry: ChatEntry | undefined;
		const wasPaused = Boolean(sessionId && pausedSessions.has(sessionId));
		try {
			// "/命令 参数" 形态先过内置命令表：只拦 kind=builtin 且当前清单里确实是内置的
			// 名字（扩展命令若与内置同名，桥端清单里它是 extension，让位给扩展）。
			const match = /^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
			if (match) {
				const [, name, args] = match;
				const entry = slashCommands.find((candidate) => candidate.name === name);
				if (entry?.kind === "builtin" && (await executeBuiltinCommand(name, args ?? ""))) return true;
			}
			target = await ensureSession();
			if (
				!target ||
				viewSeq !== sessionViewSeq.current ||
				target !== sessionIdRef.current ||
				sourceProfile !== agentDirRef.current
			)
				return false;
			// 新消息接管会话：若该会话此前被暂停，解除暂停态（按钮回到发送/暂停的常规轮转）。
			setPausedSessions((current) => {
				if (!current.has(target!)) return current;
				const next = new Set(current);
				next.delete(target!);
				return next;
			});
			if (queueing) {
				// 乐观行先取本地时钟，entry_appended 事件随后补 entryId。
				// 运行中的排队和追加不写进对话，等 queue_update 出现在输入框上方。
				optimisticEntry = {
					kind: "user",
					text: message,
					timestamp: Date.now(),
					queued: true,
					...(hasImages ? { images: images!.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
					...(hasAttachments ? { attachedPaths: [...attachedPaths!] } : {}),
				};
				setEntries((current) => [...current, optimisticEntry!]);
			} else {
				// 乐观行先取本地时钟，entry_appended 事件随后补 entryId。
				optimisticEntry = {
					kind: "user",
					text: message,
					timestamp: Date.now(),
					...(hasImages ? { images: images!.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
					...(hasAttachments ? { attachedPaths: [...attachedPaths!] } : {}),
				};
				setEntries((current) => [...current, optimisticEntry!]);
				setPendingPrompts((current) => new Set(current).add(target!));
			}
			// 用户亲自发言：旧的"重试中/重试失败"横幅已过时（会话由新消息接管）
			setRetryStatus(null);
			const response = await client.request({
				type: "session.prompt",
				sessionId: target,
				message,
				...(queueing
					? { streamingBehavior: delivery === "steer" ? ("steer" as const) : ("followUp" as const) }
					: {}),
				...(hasImages ? { images } : {}),
				...(hasAttachments ? { attachedPaths } : {}),
			});
			if (!response.ok) throw new Error(response.error ?? t("app.sendFailedMsg"));
			// Some extension commands finish before starting an agent run. Reconcile their
			// optimistic indicator with the bridge instead of leaving the input locked.
			const submittedSession = target;
			setTimeout(() => {
				void client
					.request<SessionRunningResult>({ type: "session.running" })
					.then((state) => {
						if (
							!state.ok ||
							state.result?.running.includes(submittedSession) ||
							runningSessionsRef.current.has(submittedSession)
						)
							return;
						setPendingPrompts((current) => {
							const next = new Set(current);
							next.delete(submittedSession);
							return next;
						});
					})
					.catch(() => {});
			}, 2000);
			return true;
		} catch (error) {
			if (target)
				setPendingPrompts((current) => {
					const next = new Set(current);
					next.delete(target!);
					return next;
				});
			if (wasPaused && target) setPausedSessions((current) => new Set(current).add(target!));
			// Only remove an unacknowledged optimistic row; an entry_appended replacement is real history.
			if (optimisticEntry && target === sessionIdRef.current)
				setEntries((current) => current.filter((entry) => entry !== optimisticEntry));
			if (!target || target === sessionIdRef.current)
				setEntries((current) => [
					...current,
					{
						kind: "toolResult",
						toolName: t("app.sendFailed"),
						ok: false,
						brief: error instanceof Error ? error.message : String(error),
					},
				]);
			return false;
		} finally {
			submitInFlight.current = false;
			setSubmitting(false);
		}
	};

	const sendPromptRef = useRef(sendPrompt);
	sendPromptRef.current = sendPrompt;
	const executionOwnerRevision = sessionViewSeq.current;
	const executionContext: ExecutionContextValue = {
		sessionId: railView === "research" ? undefined : sessionId,
		profile: agentDir,
		entries: railView === "research" ? [] : entries,
		subagents: railView === "research" ? [] : subagents.runs,
		onOpenSubagent: openSubagent,
		onRefreshSubagents: subagents.refresh,
		onOpenSession: (id) => {
			setRailView("chat");
			setShowSettings(false);
			void openSession(id);
		},
		onSubmitFeedback: async (text) => {
			const ownsSession = (): boolean =>
				Boolean(sessionId) &&
				sessionIdRef.current === sessionId &&
				agentDirRef.current === agentDir &&
				sessionViewSeq.current === executionOwnerRevision &&
				railViewRef.current === "chat";
			if (!connected || !profileReady || !ownsSession()) return false;
			// Reviews keep their original owner while delivery uses the current run state.
			// sendPrompt omits streamingBehavior for idle sessions and steers active ones.
			const accepted = await sendPromptRef.current(text, undefined, undefined, "steer");
			return accepted && ownsSession();
		},
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
		let optimisticEntry: ChatEntry | undefined;
		if (target === sessionIdRef.current && !queueing) {
			optimisticEntry = { kind: "user", text, timestamp: Date.now() };
			setEntries((current) => [...current, optimisticEntry!]);
			setRetryStatus(null);
		}
		if (!queueing) setPendingPrompts((current) => new Set(current).add(target));
		void client
			.request({
				type: "session.prompt",
				sessionId: target,
				message: text,
				...(queueing ? { streamingBehavior: "followUp" as const } : {}),
			})
			.then((response) => {
				if (!response.ok) throw new Error(response.error ?? t("app.sendFailedMsg"));
			})
			.catch((error: unknown) => {
				setPendingPrompts((current) => {
					if (!current.has(target)) return current;
					const next = new Set(current);
					next.delete(target);
					return next;
				});
				if (target === sessionIdRef.current) {
					setEntries((current) => [
						...current.filter((entry) => entry !== optimisticEntry),
						{
							kind: "toolResult",
							toolName: t("app.sendFailed"),
							ok: false,
							brief: error instanceof Error ? error.message : String(error),
						},
					]);
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
			setEntries((current) => [
				...current,
				{ kind: "toolResult", toolName: t("app.abortFailed"), ok: false, brief },
			]);
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
	const resumePaused = async (nextModel?: string): Promise<boolean> => {
		const target = sessionId;
		if (!target || !connected || running || submitInFlight.current) return false;
		const wasPaused = pausedSessions.has(target);
		if (nextModel) recoveryModelRevision.current++;
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
			await continueTask(client, target, nextModel, (changed, model) => {
				if (target !== sessionIdRef.current) return;
				recoveryModelRevision.current++;
				setModelValue(model);
				localStorage.setItem(MODEL_KEY, model);
				if (changed) setSessionInfo(changed);
			});
			if (target === sessionIdRef.current) {
				setRetryStatus(null);
			}
			// 与 sendPrompt 同款对账：续跑迟迟没有 agent_start 时靠 running 查询解开指示灯
			setTimeout(() => {
				void client
					.request<SessionRunningResult>({ type: "session.running" })
					.then((state) => {
						if (!state.ok || state.result?.running.includes(target) || runningSessionsRef.current.has(target))
							return;
						reconcile();
					})
					.catch(() => {});
			}, 2000);
			return true;
		} catch (error) {
			reconcile();
			// 续跑失败（桥断开/会话消失）：恢复暂停态让「继续」按钮可重试，并把失败摆出来
			if (wasPaused) setPausedSessions((current) => new Set(current).add(target));
			if (target === sessionIdRef.current)
				setEntries((current) => [
					...current,
					{
						kind: "toolResult",
						toolName: t("app.resumeFailed"),
						ok: false,
						brief: error instanceof Error ? error.message : String(error),
					},
				]);
			return false;
		} finally {
			submitInFlight.current = false;
			setSubmitting(false);
		}
	};

	// -- 顶栏（对照 DSH 会话头：标题 + 元信息 chips + 右侧功能簇） --------------
	const conversationBaseTitle = conversationTitleOf(entries, t("app.newConversation"));
	// 分支出来的会话顶栏标题加「· 分支」，和侧边栏的后缀规则一致
	const sessionTitle =
		sessionName ?? (sessionBranched ? `${conversationBaseTitle} · ${t("app.branchSuffix")}` : conversationBaseTitle);
	// 顶栏标题重命名：与侧栏 ⋯ 菜单同走 session.rename；改名后自定义名优先于自动标题。
	const renameSessionFromHeader = (name: string): void => {
		if (!sessionId || !profileReady) return;
		void client.request({ type: "session.rename", id: sessionId, sessionId, name }).then((response) => {
			if (!response.ok) return;
			setSessionName(name);
			setSidebarRev((current) => current + 1);
		});
	};
	// 研究会话的顶栏重命名：同一协议；自定义名写进 research 标题态（优先于自动标题）。
	const renameResearchFromHeader = (name: string): void => {
		if (!researchSessionId || !profileReady) return;
		void client
			.request({ type: "session.rename", id: researchSessionId, sessionId: researchSessionId, name })
			.then((response) => {
				if (!response.ok) return;
				setResearchConversationTitle(name);
				setSidebarRev((current) => current + 1);
			});
	};
	const mapModelValue =
		modelValue || (sessionInfo?.model ? `${sessionInfo.model.provider}/${sessionInfo.model.id}` : "");
	const mapModelSeparator = mapModelValue.indexOf("/");
	const mapModelName = providers
		.find((provider) => provider.id === mapModelValue.slice(0, mapModelSeparator))
		?.models.find((model) => model.id === mapModelValue.slice(mapModelSeparator + 1))?.name;
	const waitingForUser = Boolean(
		sessionId &&
			(permissions.some((request) => request.sessionId === sessionId) ||
				questions.some((question) => question.sessionId === sessionId)),
	);
	const chatActivity: ChatActivity =
		running || submitting ? (!connected ? "disconnected" : waitingForUser ? "waiting" : "working") : "idle";
	const owlPose = useSessionOwlPose(chatActivity, entries);
	const startRecentSessions = useStartRecentSessions(client, {
		active:
			railView === "chat" &&
			!showSettings &&
			!visibleSubagent &&
			conversationView === "chat" &&
			entries.length === 0 &&
			!searchTarget &&
			chatActivity === "idle",
		connected,
		profile: profileReady ? agentDir : undefined,
		cwd: workspaceDir,
		revision: sidebarRev,
	});

	const openSettings = (tab: SettingsInitialTab): void => {
		setSettingsInitialTab(tab);
		setSettingsSection(tab);
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
		researchWorkspace: researchWorkspaceDir,
	});
	const navigationSeq = useRef(0);
	const restorePlace = async (place: AppPlace, seq: number): Promise<void> => {
		if (!(await prepareWorkspaceChange(place.workspace)) || seq !== navigationSeq.current) return;
		// 作废还在飞的会话恢复，避免旧响应盖住这次回退。
		sessionViewSeq.current += 1;
		if (place.rail === "mail") setMailMounted(true);
		if (place.rail === "media") setMediaMounted(true);
		if (place.rail === "guide") setGuideMounted(true);
		if (place.rail === "career") setCareerMounted(true);
		if (place.rail === "automation") setAutomationMounted(true);
		if (place.rail === "myself") setMyselfMounted(true);
		if (place.rail === "expert") setExpertMounted(true);
		if (place.rail === "bagu") setBaguMounted(true);
		if (place.rail === "research") setResearchMounted(true);
		if (place.rail === "evaluation") setEvaluationMounted(true);
		const openingChat =
			place.rail !== "research" && Boolean(place.chatSession) && place.chatSession !== sessionIdRef.current;
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
		if (normPath(place.researchWorkspace) !== normPath(researchWorkspaceRef.current)) {
			setResearchWorkspaceDir(place.researchWorkspace);
			localStorage.setItem(RESEARCH_WORKSPACE_KEY, place.researchWorkspace);
		}
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
		setSettingsSection(place.settingsTab);
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
				pendingResearchRestoreId.current = undefined;
				setResearchResumeRequest(undefined);
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
		closeWindow: (): void => {
			void closeMainWindow();
		},
		quit: (): void => {
			void quitDesktopApp();
		},
		debugUpdate: (): void => {
			// 键盘入口与左下角菜单「调试更新」同一条路：确认后 Owl 退出、全量重建、自动重启。
			// 非桌面壳（浏览器模式）startDebugRebuild 直接返回 false，这里给出同样提示。
			if (!window.confirm(t("rail.debugUpdateConfirm"))) return;
			void (async () => {
				try {
					if (await startDebugRebuild()) return;
					window.alert(t("rail.updateDesktopOnly"));
				} catch (error) {
					const message =
						error instanceof Error && error.message.trim()
							? error.message.trim()
							: typeof error === "string" && error.trim()
								? error.trim()
								: String(error || "unknown");
					window.alert(t("rail.debugUpdateFailed", { message }));
				}
			})();
		},
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
			} else toggleSessionSidebar();
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
			if (railView === "research")
				setResearchConversationViewPersisted(researchConversationView === "chat" ? "context" : "chat");
			else {
				setRailView("chat");
				setConversationViewPersisted(conversationView === "chat" ? "context" : "chat");
			}
		},
		// 水位菜单的「打开上下文面板」：语义是打开而非切换，已在 context 视图也保持。
		openContextView: (): void => {
			setShowSettings(false);
			if (railView === "research") setResearchConversationViewPersisted("context");
			else {
				setRailView("chat");
				setConversationViewPersisted("context");
			}
		},
		prevSession: (): void => {
			void cycleSession(-1);
		},
		nextSession: (): void => {
			void cycleSession(1);
		},
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
	for (const request of [...permissions, ...questions])
		if (!islandIds.includes(request.sessionId)) islandIds.push(request.sessionId);
	const islandRunning = islandIds.map((id) => {
		const needsPermission = permissions.some((request) => request.sessionId === id);
		const asked = questions.find((request) => request.sessionId === id);
		const needsQuestion = Boolean(asked);
		return {
			id,
			title: titleForRef.current(id),
			lastActivityAt: activityAtRef.current.get(id) ?? 0,
			startedAt: runTimingRef.current.get(id)?.startedAt ?? 0,
			step: stepRev >= 0 ? (stepRef.current.get(id) ?? "") : "",
			waiting: needsPermission || needsQuestion,
			waitKind: needsPermission ? ("permission" as const) : needsQuestion ? ("question" as const) : ("" as const),
			whisper: islandWhisper(asked?.questions[0]?.header || asked?.questions[0]?.question || ""),
			disconnected: !connected,
		};
	});
	/** 本轮最近一条可测速回复：并入输入框上下文计数的实时 tok/s（流式中为估算）。 */
	const composerTurnRate = ((): { tps: number; estimated: boolean } | undefined => {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (!entry || entry.kind === "user") break;
			if (entry.kind === "assistant") {
				const rate = outputRate(entry);
				if (rate) return { tps: rate.tps, estimated: rate.estimated };
			}
		}
		return undefined;
	})();

	// 窗口标题随活动态更新：最小化或切走时任务栏仍可读（正在工作/等你确认/并行计数）。
	// 有任意会话在等用户（审批或提问）优先；多个会话并行工作时带计数。
	// 窗口在后台时，一轮的落点挂进标题（doneNotice 是完成脉冲的现成状态源）；
	// 开始等用户也标；窗口回来即清，回到活动态标题。
	const [titleSignal, setTitleSignal] = useState<TitleSignal>(undefined);
	useEffect(() => {
		document.title = windowTitle(permissions.length > 0 || questions.length > 0, runningSessions.size, titleSignal);
	}, [permissions.length, questions.length, runningSessions.size, titleSignal]);
	useEffect(() => {
		if (!document.hidden) return;
		if (doneNotice && doneNotice.outcome !== "aborted")
			setTitleSignal(doneNotice.outcome === "error" ? "error" : "done");
	}, [doneNotice?.seq]);
	useEffect(() => {
		if (document.hidden && waitingForUser) setTitleSignal("waiting");
	}, [waitingForUser]);
	useEffect(() => {
		const onVisibility = (): void => {
			if (!document.hidden) setTitleSignal(undefined);
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, []);

	return (
		<PendingResponsesContext.Provider value={pendingResponses}>
			<div
				className={`owl-desktop-shell font-sans text-owl-text${activityRailCollapsed ? " is-activity-rail-collapsed" : ""}`}
			>
				<WallpaperLayer settings={wallpaper} />
				{/* 背景动画（深色 + 未开壁纸时生效）：随 Agent 状态联动——等待授权/提问 > 工作中 > 空闲；完成/异常触发一次脉冲。 */}
				<AmbientBackground
					mood={
						permissions.length > 0 || questions.length > 0
							? "waiting"
							: runningSessions.size > 0
								? "working"
								: "idle"
					}
					pulse={
						doneNotice && doneNotice.outcome !== "aborted"
							? { seq: doneNotice.seq, kind: doneNotice.outcome === "error" ? "error" : "done" }
							: null
					}
					wallpaperEnabled={wallpaper.enabled}
				/>
				{/* 媒体桥全局覆盖层（顶部歌词条 + 深背景）：各自有开关，默认都不渲染。 */}
				<MediaOverlays />
				<BuildConsistencyBanner client={client} connected={connected} />
				<DesktopTitlebar
					connected={connected}
					activityRailCollapsed={activityRailCollapsed}
					onToggleActivityRail={toggleActivityRail}
					sidebarCollapsed={
						railView === "news" && !showSettings ? newsSidebarMinimized : sidebarMinimized || showSettings
					}
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
					onDebugUpdate={shortcuts.debugUpdate}
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
					onOpenManager={() => {
						setShowSettings(false);
						setRailView(railViewRef.current === "manager" ? "chat" : "manager");
					}}
					onOpenDiagnostics={() => openSettings("diagnostics")}
					lifeDot={lifeView.summary.dot}
					lifeCount={lifeView.summary.count}
					island={
						<DynamicIsland
							memoryScope={agentDir}
							runningReady={runningReady}
							knownTitles={listedTitles}
							running={islandRunning}
							notice={doneNotice}
							titleOf={(id) => titleForRef.current(id)}
							jumpToFace={islandJumpRef}
							permissionFor={(id) => {
								const request = permissions.find((item) => item.sessionId === id);
								return request
									? {
											requestId: request.requestId,
											toolName: request.toolName,
											description: describeToolInput(request.toolName, request.input),
											contextLabel: titleForRef.current(id),
											workspace:
												listedCwdsRef.current.get(id) ??
												(id === sessionId
													? workspaceDir
													: id === researchSessionId
														? researchWorkspaceDir
														: undefined),
										}
									: undefined;
							}}
							onOpenPermission={(requestId) => setPermissionDetailId(requestId)}
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
								answerAndRestore(requestId, permissionsRef, setPermissions, () =>
									client.respondPermission(requestId, approved),
								);
							}}
							onChoose={(requestId, label) => {
								answerAndRestore(requestId, questionsRef, setQuestions, () =>
									client.respondQuestion(requestId, [{ index: 0, selectedLabels: [label] }], false),
								);
							}}
							onReply={replyToSession}
							onOpen={(id) => {
								void openIslandSession(id).then(() => {
									if (!runningSessionsRef.current.has(id))
										setDeliveryTarget({ sessionId: id, requestId: ++deliverySequence.current });
								});
							}}
						/>
					}
				/>
				<div className="owl-desktop-body">
					<ActivityRail
						client={client}
						collapsed={activityRailCollapsed}
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
						onSelect={(view) => {
							setShowSettings(false);
							setRailView(view);
							if (view === "mail") setMailMounted(true);
							if (view === "media") setMediaMounted(true);
							if (view === "research") setResearchMounted(true);
							if (view === "automation") setAutomationMounted(true);
							if (view === "myself") setMyselfMounted(true);
							if (view === "expert") setExpertMounted(true);
							if (view === "bagu") setBaguMounted(true);
							if (view === "market") setMarketMounted(true);
						}}
					/>
					<div className="owl-workspace-frame">
						<SessionSidebar
							key={sessionScope}
							client={client}
							sessionScope={sessionScope}
							connected={connected}
							activeId={railView === "research" ? researchSessionId : sessionId}
							// 未选目录时侧栏没有「当前项目」：保留目录也随之从「项目」分组隐藏，会话走「最近会话」。
							// 研究侧栏只认研究工作台自己的项目，两边的「项目」分组互不串。
							activeProject={
								railView === "research"
									? researchWorkspaceSelected
										? researchWorkspaceDir
										: ""
									: workspaceSelected
										? workspaceDir
										: ""
							}
							refreshKey={(railView === "research" ? researchSessionId : sessionId) ?? ""}
							revision={sidebarRev}
							focus={railView}
							conversationVisible={
								!showSettings &&
								!visibleSubagent &&
								(railView === "chat"
									? conversationView === "chat"
									: railView === "research" && researchConversationView === "chat")
							}
							minimized={sidebarMinimized || showSettings || (railView !== "chat" && railView !== "research")}
							onToggleMinimized={toggleSessionSidebar}
							runningSessions={runningSessions}
							draftSessions={draftSessions}
							onNewChat={shortcuts.newChat}
							onNewChatInProject={(path) =>
								newChatInProject(path, railViewRef.current === "research" ? "research" : "chat")
							}
							onSelectProject={switchScopedProject}
							onOpenSearchHit={(hit, query) => void openSearchHit(hit, query)}
							onOpenSession={(id) => void openSession(id)}
							onSessionRenamed={(id, name) => {
								if (id === sessionIdRef.current) setSessionName(name);
								if (id === researchSessionIdRef.current) setResearchConversationTitle(name);
							}}
						/>
						<div
							className="owl-map-view"
							data-owl-island-anchor=""
							style={{
								display: railView === "map" && !showSettings ? "flex" : "none",
								flex: 1,
								minWidth: 0,
								minHeight: 0,
							}}
						>
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
									answerAndRestore(requestId, questionsRef, setQuestions, () =>
										client.respondQuestion(requestId, answers, cancelled),
									);
								}}
							/>
						</div>
						<div
							data-owl-island-anchor=""
							style={{
								display: railView === "news" && !showSettings ? "flex" : "none",
								flex: 1,
								minWidth: 0,
								minHeight: 0,
							}}
						>
							<NewsPage
								client={client}
								active={railView === "news" && !showSettings}
								sidebarCollapsed={newsSidebarMinimized}
								initialTarget={newsTarget}
								onOpenModelSettings={() => {
									setSettingsInitialTab("models");
									setSettingsSection("models");
									setShowSettings(true);
								}}
								onToChat={(text) => {
									setRailView("chat");
									setShowSettings(false);
									setConversationViewPersisted("chat");
									setDraftRequest({ id: ++draftSequence.current, text });
								}}
							/>
						</div>
						{/* 「项目」页（Codex 式一览）：与 news 同款常挂载 + display 切换；创建走项目页模式（不跳走）。 */}
						<div
							data-owl-island-anchor=""
							style={{
								display: railView === "projects" && !showSettings ? "flex" : "none",
								flex: 1,
								minWidth: 0,
								minHeight: 0,
								flexDirection: "column",
							}}
						>
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
									newChatInProject(path, "chat");
									setRailView("chat");
								}}
								onCreateProject={() => {
									setProjectDialogStay(true);
									setShowProjectDialog(true);
								}}
							/>
						</div>
						{mailMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "mail" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
								}}
							>
								<MailPage
									client={client}
									connected={connected}
									cwd={workspaceDir}
									sidebarCollapsed={sidebarMinimized}
									model={selectedModel()}
									thinkingLevel={thinkingLevel}
								/>
							</div>
						)}
						{evaluationMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "evaluation" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
								}}
							>
								<EvaluationPage
									client={client}
									active={railView === "evaluation" && !showSettings}
									sidebarCollapsed={sidebarMinimized}
								/>
							</div>
						)}
						{/* 媒体桥（owl-media-bridge 插件）：Rail 一等视图，纯新增入口。 */}
						{mediaMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "media" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								<MediaView active={railView === "media" && !showSettings} />
							</div>
						)}
						{/* 人生指南视图（三 tab）：高性价比人生指南 + 人生进阶指南 + 程序员延寿指南，内容 jsDelivr 拉取 + 本地缓存（署名与许可在各自底栏）。 */}
						{guideMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "guide" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								<GuidePanel active={railView === "guide" && !showSettings} onOpenUrl={openUrlExternally} />
							</div>
						)}
						{/* 「我的 Token 生涯」看板：跨 Agent 本地会话记录的 token 用量汇总（career.get，仅本地解析）。 */}
						{careerMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "career" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								<TokenCareerPage active={railView === "career" && !showSettings} client={client} />
							</div>
						)}
						{automationMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "automation" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								<AutomationPage
									client={client}
									active={railView === "automation" && !showSettings}
									model={selectedModel()}
									onOpenSession={(id) => void openSession(id)}
									sessions={[
										...(sessionId ? [{ id: sessionId, title: sessionTitle }] : []),
										...[...listedTitles.entries()]
											.filter(([id]) => id !== sessionId)
											.slice(0, 30)
											.map(([id, title]) => ({ id, title })),
									]}
								/>
							</div>
						)}
						{/* 个人主页（Codex 式）：rail 左下角头像菜单的账号块进入。 */}
						{railView === "account" && !showSettings && (
							<div
								data-owl-island-anchor=""
								style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}
							>
								<AccountProfilePage client={client} />
							</div>
						)}
						{/* 「我的助理」：owl-myself 目录每天一个 md，左侧日历排序 + 当天提炼/待办/对话。 */}
						{myselfMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "myself" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								<MyselfPanel
									active={railView === "myself" && !showSettings}
									client={client}
									connected={connected}
									workspaceDir={workspaceDir}
									agentDir={agentDir}
									openRequest={myselfOpenRequest}
									providers={chatProviders}
									defaultModel={modelValue}
									defaultThinkingLevel={thinkingLevel}
									defaultApprovalMode={approvalMode}
									onOpenSettings={openSettings}
									questions={questions}
									permissions={permissions}
									onQuestionAnswer={(requestId, answers, cancelled) => {
										answerAndRestore(requestId, questionsRef, setQuestions, () =>
											client.respondQuestion(requestId, answers, cancelled),
										);
									}}
								/>
							</div>
						)}
						{/* 「专家顾问」：owl-expert 目录（人格档案 + 记忆 + 每天一个会话 md），市场 + 1:1/群聊。 */}
						{expertMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "expert" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								<ExpertPanel
									active={railView === "expert" && !showSettings}
									client={client}
									connected={connected}
									providers={chatProviders}
									defaultModel={modelValue}
									defaultThinkingLevel={thinkingLevel}
									defaultApprovalMode={approvalMode}
									onOpenSettings={openSettings}
								/>
							</div>
						)}
						{/* 「八股对练」：bagu 题库（localhost:8080）抽题评分 + owl agent 反问/兜底。 */}
						{baguMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "bagu" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								<BaguPage
									active={railView === "bagu" && !showSettings}
									client={client}
									connected={connected}
									defaultModel={modelValue}
									defaultThinkingLevel={thinkingLevel}
									defaultApprovalMode={approvalMode}
								/>
							</div>
						)}
						{/* 插件市场：与 news/bagu 同款常挂载 + display 切换；引入即新开会话交给 Agent 改造。 */}
						{marketMounted && (
							<div
								data-owl-island-anchor=""
								style={{
									display: railView === "market" && !showSettings ? "flex" : "none",
									flex: 1,
									minWidth: 0,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								<MarketPage
									active={railView === "market" && !showSettings}
									connected={connected}
									agentDir={agentDir ?? ""}
									workspaceDir={workspaceDir}
									onImport={(text) => importPluginToNewSession(text)}
								/>
							</div>
						)}
						{/* 号池 Manager：与 news/mail 同层。不能放进 owl-main-frame——那个框在非对话视图下是 display:none。 */}
						<div
							data-owl-island-anchor=""
							style={{
								display: railView === "manager" && !showSettings ? "flex" : "none",
								flex: 1,
								minWidth: 0,
								minHeight: 0,
								flexDirection: "column",
								background: "var(--owl-ui-canvas, var(--color-owl-bg))",
							}}
						>
							<PanelErrorBoundary label="号池 Manager">
								<ManagerTab
									onOpenExternal={async (url) => {
										await managerApi.openExternal("url", url);
									}}
									onThemeChange={async (theme) => {
										const response = await client.request({ type: "settings.set", values: { theme } });
										if (!response.ok) throw new Error(response.error ?? "保存主题失败");
										setThemePreference(theme);
									}}
								/>
							</PanelErrorBoundary>
						</div>
						<div
							className="owl-main-frame"
							data-owl-island-anchor=""
							style={{
								display: railView === "chat" || railView === "research" || showSettings ? undefined : "none",
							}}
						>
							<ConversationHeader
								title={
									visibleSubagent
										? (activeSubagent?.agent ?? t("chat.subagentPlain"))
										: railView === "research"
											? (researchConversationTitle ?? t("app.newConversation"))
											: sessionTitle
								}
								onRenameSession={
									visibleSubagent
										? undefined
										: railView === "research"
											? researchSessionId
												? renameResearchFromHeader
												: undefined
											: renameSessionFromHeader
								}
								presetName={(() => {
									if (railView === "research" || visibleSubagent) return undefined;
									const id = sessionId ? (sessionPreset ?? stagedPreset) : stagedPreset;
									return id ? agentPresets.find((preset) => preset.id === id)?.name : undefined;
								})()}
								view={
									visibleSubagent
										? subagentView
										: railView === "research"
											? researchConversationView
											: conversationView
								}
								onViewChange={
									visibleSubagent
										? setSubagentView
										: railView === "research"
											? setResearchConversationViewPersisted
											: setConversationViewPersisted
								}
								terminalOpen={terminalOpen}
								sidebarOpen={sidebarOpen}
								onToggleTerminal={toggleTerminalPanel}
								onToggleSidebar={toggleSidebarPanel}
								mirrorOpen={mirrorOpen}
								onToggleMirror={toggleMirrorPanel}
								sessionId={
									visibleSubagent ? undefined : railView === "research" ? researchSessionId : sessionId
								}
								exporting={exportingLog}
								onExport={exportSessionLog}
								onExportTurns={() =>
									setShareTurnsSession(railView === "research" ? researchSessionId : sessionIdRef.current)
								}
							/>
							{/* 顶栏已抽离文档流；包一层只在真有条时才让出头部高度的容器，
				   否则这帧提示条会钻到悬浮头下面。 */}
							<div className="owl-shell-notices">
								{exportNotice && (
									<p
										className={`px-5 py-1.5 text-xs ${exportNotice.tone === "error" ? "text-red-400" : "text-owl-faint"}`}
										role={exportNotice.tone === "error" ? "alert" : "status"}
									>
										{exportNotice.text}
									</p>
								)}
								{projectNotice && (
									<p className="px-5 py-1.5 text-xs text-owl-muted" role="status">
										{projectNotice}
									</p>
								)}
								{sessionOpenFailed && (
									<p className="px-5 py-1.5 text-xs text-owl-muted" role="status">
										<span>{`${t("app.sessionRestoreFailed")}：${sessionOpenFailed.message}`}</span>
										<button
											type="button"
											className="owl-model-fallback-action"
											onClick={() => {
												setSessionOpenFailed(undefined);
												void openSession(sessionOpenFailed.id);
											}}
										>
											{t("app.sessionRetry")}
										</button>
									</p>
								)}
								{modelFallbackNotice && (
									<ModelFallbackNotice
										fallback={modelFallbackNotice}
										onChooseModel={() => openSettings("models")}
										onDismiss={() =>
											setDismissedModelFallbacks((current) => [
												...current,
												modelFallbackKey(modelFallbackNotice),
											])
										}
									/>
								)}
							</div>
							{/* 双面板常挂载：owl-shell-content-main 是「对话 + 终端底栏」的纵列，
				    工具侧栏是右列 —— 底栏与侧栏互不依赖，可同时展开。 */}
							<div
								className={
									"owl-shell-content" +
									(questions.some(
										(request) =>
											request.sessionId === (railView === "research" ? researchSessionId : sessionId),
									)
										? " has-pending-question"
										: "")
								}
							>
								<div className="owl-shell-content-main">
									<div className="owl-shell-conversation">
										{visibleSubagent && (
											<SubagentView
												client={client}
												connected={connected}
												selection={visibleSubagent}
												runs={subagents.runs}
												listLoading={subagents.loading}
												listError={subagents.error}
												view={subagentView}
												onBack={() => setSubagentSelection(undefined)}
												onRefresh={subagents.refresh}
												onSelect={openSubagent}
												onOpenUrl={openUrlInSidebarBrowser}
												headerActions={
													<SubagentPin
														key={subagentParentId}
														runs={subagents.runs}
														activeId={activeSubagent?.id ?? visibleSubagent.id}
														onSelect={openSubagent}
													/>
												}
											/>
										)}
										{researchMounted && (
											<div
												style={{
													display:
														railView === "research" && !showSettings && !visibleSubagent
															? "flex"
															: "none",
													flex: 1,
													minHeight: 0,
													minWidth: 0,
												}}
											>
												<ResearchPage
													profile={agentDir}
													queueProfile={profileReady ? agentDir : undefined}
													queueIsCurrent={() =>
														agentDirRef.current === agentDir &&
														researchWorkspaceRef.current === researchWorkspaceDir &&
														researchActionSequence.current === researchQueueRevision
													}
													deliveryRequest={
														deliveryTarget?.sessionId === researchSessionId
															? deliveryTarget?.requestId
															: undefined
													}
													searchTarget={searchTarget}
													searchHistoryMessage={
														searchHistory !== undefined && searchHistory.sessionId === researchSessionId
															? searchHistory.result
															: undefined
													}
													restorePending={projectRestoring?.scope === "research"}
													subagentControl={
														<SubagentPin
															key={subagentParentId}
															runs={subagents.runs}
															onSelect={openSubagent}
														/>
													}
													onOpenSubagent={openSubagentCard}
													onOpenAutomation={openAutomation}
													client={client}
													active={railView === "research" && !showSettings}
													connected={connected}
													cwd={researchWorkspaceDir}
													providers={chatProviders}
													defaultModel={modelValue}
													defaultThinkingLevel={thinkingLevel}
													defaultApprovalMode={approvalMode}
													agentPresets={agentPresets}
													defaultPresetId={defaultPresetId}
													defaultAgentPreset={stagedPreset}
													projects={visibleResearchProjects}
													workspaceSelected={researchWorkspaceSelected}
													onSwitchProject={switchResearchProject}
													onClearProject={clearResearchWorkspaceSelection}
													onSessionIdChange={(id) => {
														if (
															pendingResearchRestoreId.current &&
															id !== pendingResearchRestoreId.current
														)
															return;
														if (id === pendingResearchRestoreId.current)
															pendingResearchRestoreId.current = undefined;
														setResearchSessionId(id);
													}}
													resumeRequest={researchResumeRequest}
													newConversationRequest={researchNewConversationRequest}
													conversationView={researchConversationView}
													onTitleChange={setResearchConversationTitle}
													questions={questions}
													onQuestionAnswer={(requestId, answers, cancelled) =>
														answerAndRestore(requestId, questionsRef, setQuestions, () =>
															client.respondQuestion(requestId, answers, cancelled),
														)
													}
													waiting={Boolean(
														researchSessionId &&
															(permissions.some((request) => request.sessionId === researchSessionId) ||
																questions.some((request) => request.sessionId === researchSessionId)),
													)}
													onOpenFile={openResearchFile}
													onOpenReview={openWorkbenchReview}
													sidebarOpen={sidebarOpen}
													onOpenResults={() => setSidebarOpenPersisted(false)}
													onOpenSettings={shortcuts.openSettings}
													onOpenContext={() => shortcuts.openContextView()}
												/>
											</div>
										)}
										<AgentConversation
											hidden={railView === "research" || Boolean(visibleSubagent)}
											header={
												conversationView === "chat" && entries.length > 0 ? (
													<TodoPin entries={entries} presentation="summary" />
												) : undefined
											}
											view={conversationView}
											trajectory={
												<TrajectoryView entries={entries} active={railView === "chat" && !showSettings} />
											}
											context={
												<ContextView
													key={sessionId ?? workspaceDir}
													client={client}
													cwd={workspaceDir}
													sessionId={sessionId}
													requireSession
													active={railView === "chat" && !showSettings && connected}
												/>
											}
											chat={
												<>
													<GenuiSessionProvider client={client} sessionId={sessionId}>
														<ChatStream
															executionView="normal"
															diffSummary={turnDiff}
															onInspectTool={(card, ownerIndex) =>
																openExecution("tool", card, ownerIndex)
															}
															key={sessionId ?? workspaceDir}
															sessionId={sessionId}
															profile={agentDir}
															startReady={profileReady && connected}
															recentSessions={startRecentSessions}
															onResumeSession={(id) => void openSession(id)}
															deliveryRequest={
																deliveryTarget?.sessionId === sessionId
																	? deliveryTarget?.requestId
																	: undefined
															}
															searchHistoryMessage={
																searchHistory !== undefined &&
																searchHistory.sessionId === sessionId &&
																!entries.some(
																	(entry) =>
																		(entry.kind === "user" || entry.kind === "assistant") &&
																		entry.entryId === searchHistory.result.entryId,
																)
																	? searchHistory.result
																	: undefined
															}
															searchTarget={
																searchTarget?.sessionId === sessionId ? searchTarget : undefined
															}
															entries={entries}
															cwd={workspaceDir}
															onOpenFile={openTaskFile}
															onOpenUrl={openUrlInSidebarBrowser}
															onQuickAction={requestOpenKind}
															onPromptExample={(text) =>
																setDraftRequest({ id: ++draftSequence.current, text })
															}
															onOpenProduct={openArtifactPage}
															onSubmitFeedback={executionContext.onSubmitFeedback}
															approvalMode={currentApprovalMode}
															onApprovePlan={() => handleApprovalModeChange("confirm")}
															onRejectPlan={(feedback) => void sendPrompt(feedback)}
															onOpenDeveloper={openDeveloper}
															artifacts={
																<TurnArtifacts
																	artifacts={artifacts}
																	cwd={workspaceDir}
																	client={client}
																	sessionId={sessionId}
																	disabled={running || submitting}
																	onOpenFile={openTaskFile}
																	onOpenReview={openWorkbenchReview}
																/>
															}
															client={client}
															onOpenReview={openWorkbenchReview}
															activity={chatActivity}
															onRewind={handleRewindClick}
															onRegenerate={requestRegenerate}
															onEditMessage={handleEditMessage}
															onBranch={(entryId) => void handleBranch(entryId)}
															onOpenAutomation={openAutomation}
															onOpenSubagent={openSubagentCard}
															answeredQuestions={answeredQuestions}
															onQueuedRemove={queuedRemove}
															onQueuedPromote={queuedPromote}
															queuedItems={(() => {
																const snapshot =
																	profileReady && sessionId
																		? promptQueues[promptQueueKey(agentDir, sessionId)]
																		: undefined;
																return snapshot
																	? [
																			...snapshot.steering.map((item) => ({
																				messageId: item.messageId,
																				lane: "steering" as const,
																				text: item.text,
																			})),
																			...snapshot.followUp.map((item) => ({
																				messageId: item.messageId,
																				lane: "followUp" as const,
																				text: item.text,
																			})),
																		]
																	: undefined;
															})()}
														/>
													</GenuiSessionProvider>
													{fileOpenError && (
														<p className="px-4 py-1 text-xs text-red-400" role="alert">
															{fileOpenError}
														</p>
													)}
												</>
											}
											overlay={
												<div className="owl-conversation-pins">
													{(projectRestoring?.scope === "chat" || sessionOpening) && (
														<SessionStatusPill
															text={
																projectRestoring?.scope === "chat"
																	? t("app.projectRestoring")
																	: t("app.sessionOpening")
															}
														/>
													)}
													{conversationView !== "chat" && <TodoPin entries={entries} />}
													<SubagentPin
														key={subagentParentId}
														runs={subagents.runs}
														onSelect={openSubagent}
													/>
												</div>
											}
											beforeComposer={
												<>
													<SchedulePin
														client={client}
														sessionId={sessionId}
														active={railView === "chat" && !showSettings}
														onOpenAutomation={openAutomation}
													/>
													{/* 自动重试横幅：桥端 auto-retry 进行中/耗尽时贴在输入框上方（此前事件过线无人渲染） */}
													<RetryPin
														status={retryStatus?.phase === "retrying" ? retryStatus : null}
														onDismiss={() => setRetryStatus(null)}
													/>
													<TaskRecoveryNotice
														key={sessionId}
														recovery={
															!running && !submitting && retryStatus?.phase !== "retrying"
																? taskRecovery(entries, retryStatus)
																: undefined
														}
														providers={chatProviders}
														model={
															sessionInfo?.model
																? `${sessionInfo.model.provider}/${sessionInfo.model.id}`
																: modelValue
														}
														disabled={!connected}
														onContinue={resumePaused}
														onRetry={() => {
															requestRegenerate();
															return true;
														}}
														onOpenSettings={() => openSettings("models")}
													/>
												</>
											}
											questionDock={{
												requests: questions,
												activeRequest: activeQuestion,
												onAnswer: (requestId, answers, cancelled) => {
													answerAndRestore(requestId, questionsRef, setQuestions, () =>
														client.respondQuestion(requestId, answers, cancelled),
													);
												},
												onAnsweredChange: setAnsweredQuestions,
											}}
											composer={
												<Composer
													key={`composer-${composerSessionKey}`}
													client={client}
													sentHistory={sentHistory}
													initialDraft={sessionDraftsRef.current.get(composerSessionKey)}
													onDraftChange={(text) => trackDraft(composerSessionKey, text)}
													onOpenContext={() => shortcuts.openContextView()}
													sessionScope="chat"
													connected={connected}
													disabled={submitting || !connected || projectRestoring?.scope === "chat"}
													running={running}
													turnRate={running ? composerTurnRate : undefined}
													paused={Boolean(sessionId && pausedSessions.has(sessionId))}
													hideEnvironment={connected && (Boolean(activeQuestion) || running)}
													questionPending={Boolean(activeQuestion)}
													onSend={sendPrompt}
													queueSessionId={sessionId}
													queueProfile={profileReady ? agentDir : undefined}
													queueOwnerRevision={sessionViewSeq.current}
													queueIsCurrent={() =>
														sessionIdRef.current === sessionId &&
														agentDirRef.current === agentDir &&
														workspaceRef.current === workspaceDir &&
														sessionViewSeq.current === modelScopeRevision
													}
													followUp={latestTurn(entries)}
													onAbort={() => void abort()}
													onPause={pauseSession}
													onResume={() => void resumePaused()}
													providers={chatProviders}
													model={confirmedModel}
													onModel={handleModelChange}
													modelSelection={modelSelection.feedback}
													onRetryModelSelection={modelSelection.retry}
													thinkingLevel={thinkingLevel}
													onThinkingLevel={handleThinkingChange}
													approvalMode={currentApprovalMode}
													onApprovalMode={handleApprovalModeChange}
													agentPresets={agentPresets}
													defaultPresetId={defaultPresetId}
													agentPreset={sessionId ? (sessionPreset ?? stagedPreset) : stagedPreset}
													agentPresetLocked={Boolean(sessionId) && entries.length > 0}
													onAgentPresetSelect={handleAgentPresetSelect}
													sessionInfo={sessionInfo}
													workspaceDir={workspaceDir}
													projects={visibleProjects}
													workspaceSelected={workspaceSelected}
													onSwitchProject={switchProject}
													onClearProject={clearWorkspaceSelection}
													commands={slashCommands}
													searchFiles={(cwd, query) =>
														client
															.request<FsSearchHit[]>({ type: "fs.search", cwd, query })
															.then((r) => (r.ok ? (r.result ?? []) : []))
													}
													draftRequest={draftRequest}
													owlPose={owlPose}
												/>
											}
										/>
									</div>
									{/* 终端底栏：挂在对话列之下（高度拖拽），与右侧栏互不相干 */}
									<BrowserSessionContext.Provider
										value={railView === "research" ? researchSessionId : sessionId}
									>
										<Workbench
											client={client}
											cwd={workspaceDir}
											profile={agentDir}
											connected={connected && profileReady}
											store={mirrorStore}
											open={mirrorOpen}
											onSetOpen={setMirrorOpenPersisted}
											dock="bottom"
											role="mirror"
										/>
										<Workbench
											client={client}
											cwd={workspaceDir}
											profile={agentDir}
											connected={connected && profileReady}
											store={terminalStore}
											open={terminalOpen}
											onSetOpen={setTerminalOpenPersisted}
											dock="bottom"
											role="terminal"
											onToChat={sendWorkbenchTextToChat}
										/>
									</BrowserSessionContext.Provider>
								</div>
								{/* 工具侧栏：右列（宽度拖拽），装除终端外的全部工作 tab */}
								<ExecutionContext.Provider value={executionContext}>
									<BrowserSessionContext.Provider
										value={railView === "research" ? researchSessionId : sessionId}
									>
										<Workbench
											client={client}
											cwd={workspaceDir}
											profile={agentDir}
											connected={connected && profileReady}
											store={workbenchStore}
											onGitStatusChange={onWorkbenchGitStatus}
											onOpenPanel={(kind) => {
												if (kind === "mirror") toggleMirrorPanel();
											}}
											open={sidebarOpen}
											onSetOpen={setSidebarOpenPersisted}
											dock="right"
											developerLayout={developerLayout}
											onToChat={sendWorkbenchTextToChat}
											products={sessionProducts}
										/>
									</BrowserSessionContext.Provider>
								</ExecutionContext.Provider>
							</div>
							{showSettings && (
								<SettingsPage
									key={settingsMountKey}
									client={client}
									workspaceDir={workspaceDir}
									initialTab={settingsInitialTab}
									restoreSection={settingsSection}
									onSectionChange={setSettingsSection}
									onAskAgentCreatePreset={handleAskAgentCreatePreset}
									lifeProbe={lifeProbe}
									wallpaper={wallpaper}
									onWallpaperChange={(next) => {
										setWallpaper(next);
										applyOwlWallpaper(next);
									}}
									onWorkspaceDir={async (dir) => {
										if (!(await prepareWorkspaceChange(dir))) return;
										workspaceRef.current = dir;
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
				</div>
				{showProjectDialog && (
					<NewProjectDialog
						client={client}
						onClose={() => {
							setShowProjectDialog(false);
							setProjectDialogStay(false);
						}}
						onCreated={(path, name) => {
							restoreProject(path, sessionScope);
							if (name !== undefined) setProjectAlias(path, name);
							setShowProjectDialog(false);
							setShowSettings(false);
							if (projectDialogStay) {
								// 项目页创建：登记进已知项目并留在项目页，列表随 sidebarRev 重拉。
								const known = loadSidebarStrings(localStorage, "owl.projects");
								if (!known.some((p) => samePath(p, path)))
									localStorage.setItem("owl.projects", JSON.stringify([...known, path]));
								setProjectDialogStay(false);
								setSidebarRev((current) => current + 1);
								return;
							}
							switchScopedProject(path);
						}}
					/>
				)}
				{permission && (
					<PermissionDialog
						request={permission}
						contextLabel={titleForRef.current(permission.sessionId)}
						workspace={
							listedCwdsRef.current.get(permission.sessionId) ??
							(permission.sessionId === sessionId
								? workspaceDir
								: permission.sessionId === researchSessionId
									? researchWorkspaceDir
									: undefined)
						}
						onLater={() => {
							setDeferredPermissions((current) => new Set(current).add(permission.requestId));
							setPermissionDetailId(undefined);
						}}
						onDecide={(approved) => {
							answerAndRestore(permission.requestId, permissionsRef, setPermissions, () =>
								client.respondPermission(permission.requestId, approved),
							);
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
				{regenerateTarget && (
					<RegenerateConfirmDialog
						preview={regenerateTarget.text}
						onConfirm={() => {
							const target = regenerateTarget;
							setRegenerateTarget(undefined);
							void handleRegenerate(target);
						}}
						onClose={() => setRegenerateTarget(undefined)}
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
		</PendingResponsesContext.Provider>
	);
}
