import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BridgeClient } from "./bridge/client.ts";
import { hasTauri } from "./bridge/native.ts";
import type { ApprovalMode, CommandsListResult, PermissionRequest, ProviderModelsMessage, QuestionRequest, RewindExecuteResult, ServerEventMessage, SessionRunningResult, SessionStatsResult, SlashCommandEntry } from "./bridge/protocol.ts";
import { applyEvent, applyRetryEvent, rebuild, type ChatEntry, type RetryBannerState } from "./hooks/transcript.ts";
import { ActivityRail, type RailView } from "./components/ActivityRail.tsx";
import { MapWorkspace } from "./map/MapWorkspace.tsx";
import { NewsPage } from "./features/news/NewsPage.tsx";
import { MailPage } from "./features/mail/MailPage.tsx";
import { ChatStream, type ChatActivity } from "./components/ChatStream.tsx";
import { ContextView } from "./components/ContextView.tsx";
import { Composer, type ComposerImage } from "./components/Composer.tsx";
import { Artifacts } from "./components/Artifacts.tsx";
import { collectArtifacts, workspaceArtifactPath } from "./hooks/artifacts.ts";
import { PermissionDialog } from "./components/PermissionDialog.tsx";
import { QuestionDialog } from "./components/QuestionDialog.tsx";
import { RewindDialog } from "./components/RewindDialog.tsx";
import { SessionSidebar } from "./components/SessionSidebar.tsx";
import { IconList } from "./components/icons.tsx";
import { DesktopTitlebar } from "./components/DesktopTitlebar.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { TodoPin } from "./components/TodoPin.tsx";
import { RetryPin } from "./components/RetryPin.tsx";
import { isThemePreference, setThemePreference } from "./theme.ts";
import { applyChatAppearance, parseChatAppearance } from "./chat-appearance.ts";
import { parseUiLanguage, setUiLanguage, t, useT } from "./i18n/index.ts";
import { loadKnownProjects, normPath, samePath } from "./utils/paths.ts";
import { Workbench, type WorkbenchDock } from "./sidebar/Workbench.tsx";
import { SidebarStore, normProjectKey } from "./sidebar/store.ts";
import { openQuickAction } from "./sidebar/quick.tsx";
import { openDeveloperWorkbench } from "./sidebar/developer.ts";
import { getSidebarConfig, isTabKindEnabled, parseSidebarSettings, setSidebarConfig, viewerKindForPath } from "./sidebar/config.ts";
import { fileUrlOf } from "./sidebar/api.ts";
import { isIabPageBound, boundTabIdFor, encodeIabPath, agentPageForSession } from "./sidebar/iab-bound.ts";
import { BrowserSessionContext } from "./sidebar/registry.ts";
import { IconFolder, IconPanelBottom, IconPanelRight } from "./sidebar/icons.tsx";
import { setSessionFeed } from "./sidebar/feed.ts";
import { notifyAgentStatus } from "./utils/notification.ts";
import { parseNotificationPrefs, setNotificationPrefs } from "./utils/notification-prefs.ts";
import "./desktop-shell.css";

const WORKSPACE_KEY = "owl.workspaceDir";
/** 未选择过项目时的默认工作目录；启动时会自动创建，保证开箱即可对话。 */
const DEFAULT_WORKSPACE_DIR = "D:/owl/Owl-def";
const MODEL_KEY = "owl.model";
const THINKING_KEY = "owl.thinkingLevel";
const APPROVAL_KEY = "owl.approvalMode";
const SIDEBAR_MINIMIZED_KEY = "owl.sidebar.minimized";

/** localStorage 里记录的审批模式是否合法（防旧值/手改值落到未知档位）。 */
function isApprovalMode(value: string | null): value is ApprovalMode {
	return value === "auto" || value === "confirm" || value === "plan";
}
const WORKBENCH_OPEN_KEY = "owl.workbench.open";
const WORKBENCH_DOCK_KEY = "owl.workbench.dock";
const WORKBENCH_LAYOUT_KEY = "owl.workbench.layout";
const CONVERSATION_VIEW_KEY = "owl.conversation.view";

/** session.list 返回行的最小字段（完整形状见桥端 SessionInfo）。 */
type SessionRowLite = {
	id?: string;
	cwd?: string;
	modified?: string;
	created?: string;
	messageCount?: number;
	[key: string]: unknown;
};

function rowTime(row: SessionRowLite): string {
	return String(row.modified ?? row.created ?? "");
}

export default function App(): React.JSX.Element {
	const t = useT();
	const client = useMemo(() => new BridgeClient(), []);
	const [connected, setConnected] = useState(false);
	const [everConnected, setEverConnected] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [settingsInitialTab, setSettingsInitialTab] = useState<"general" | "about">("general");
	const [showProjectDialog, setShowProjectDialog] = useState(false);
	// 设置页改动会话（恢复/删除归档）时递增，驱动侧边栏重拉列表
	const [sidebarRev, setSidebarRev] = useState(0);
	const [newsTarget, setNewsTarget] = useState<{ kind: "item" | "story"; id: string; revision: number }>();
	const [railView, setRailView] = useState<RailView>(() => {
		const view = new URLSearchParams(window.location.search).get("view");
		return view === "mail" || view === "map" ? view : "chat";
	});
	const [mailMounted, setMailMounted] = useState(railView === "mail");
	const [sidebarMinimized, setSidebarMinimized] = useState(
		() => localStorage.getItem(SIDEBAR_MINIMIZED_KEY) === "1",
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
	const [draftRequest, setDraftRequest] = useState<{ id: number; text: string; replace?: boolean }>();
	const draftSequence = useRef(0);
	const [submitting, setSubmitting] = useState(false);
	const submitInFlight = useRef(false);
	const [pendingPrompts, setPendingPrompts] = useState<ReadonlySet<string>>(() => new Set<string>());
	/** agent run 活跃的会话 id（含切走后的后台会话与旁路会话）：侧边栏运行状态点依据。 */
	const [runningSessions, setRunningSessions] = useState<ReadonlySet<string>>(() => new Set<string>());
	const runningSessionsRef = useRef(runningSessions);
	runningSessionsRef.current = runningSessions;
	const [sessionId, setSessionId] = useState<string | undefined>(undefined);
	const running = Boolean(sessionId && (runningSessions.has(sessionId) || pendingPrompts.has(sessionId)));
	const [questionNavOpen, setQuestionNavOpen] = useState(false);
	const [permission, setPermission] = useState<PermissionRequest | undefined>(undefined);
	/** agent 提问队列：ask_user_question 的 question_request 按到达顺序排队弹出 */
	const [questions, setQuestions] = useState<QuestionRequest[]>([]);
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
	const [sessionInfo, setSessionInfo] = useState<SessionStatsResult | undefined>(undefined);
	const [workspaceDir, setWorkspaceDir] = useState(
		() => localStorage.getItem(WORKSPACE_KEY) ?? DEFAULT_WORKSPACE_DIR,
	);
	// 输入框项目选择器的候选列表：与侧边栏同源（当前 ∪ 有会话 ∪ 到访过），切换项目/侧边栏变更时刷新。
	const [projects, setProjects] = useState<string[]>([]);
	// 斜杠命令清单（桥端 commands.list）：连接后、切项目、建/恢复会话时刷新（扩展命令随会话出现）。
	const [slashCommands, setSlashCommands] = useState<SlashCommandEntry[]>([]);
	// 侧边栏工作台（文件树 / 编辑器 / Git 变动 / 任务 / 侧聊）：开合与停靠位置持久化。
	const [workbenchOpen, setWorkbenchOpen] = useState(
		() => localStorage.getItem(WORKBENCH_OPEN_KEY) === "1",
	);
	const [workbenchDock, setWorkbenchDock] = useState<WorkbenchDock>(() =>
		localStorage.getItem(WORKBENCH_DOCK_KEY) === "right" ? "right" : "bottom",
	);
	const [developerLayout, setDeveloperLayout] = useState(
		() => localStorage.getItem(WORKBENCH_LAYOUT_KEY) === "developer",
	);
	// 主区视图（顶栏 tab 切换）：对话 / 上下文（owl-context 插件供数）
	const [conversationView, setConversationView] = useState<"chat" | "context">(() =>
		localStorage.getItem(CONVERSATION_VIEW_KEY) === "context" ? "context" : "chat",
	);
	const setConversationViewPersisted = (view: "chat" | "context"): void => {
		setConversationView(view);
		localStorage.setItem(CONVERSATION_VIEW_KEY, view);
	};
	const setDeveloperLayoutPersisted = (developer: boolean): void => {
		setDeveloperLayout(developer);
		localStorage.setItem(WORKBENCH_LAYOUT_KEY, developer ? "developer" : "tools");
	};
	const setWorkbenchOpenPersisted = (open: boolean): void => {
		setWorkbenchOpen(open);
		localStorage.setItem(WORKBENCH_OPEN_KEY, open ? "1" : "0");
	};
	const setDockPersisted = (dock: WorkbenchDock): void => {
		setWorkbenchDock(dock);
		localStorage.setItem(WORKBENCH_DOCK_KEY, dock);
	};

	// 工作台 store 按项目提升到 App：Workbench 与快捷入口共用同一实例。
	const workbenchKey = normProjectKey(workspaceDir);
	const workbenchStore = useMemo(() => new SidebarStore(workspaceDir), [workbenchKey]); // eslint-disable-line react-hooks/exhaustive-deps
	const artifacts = useMemo(() => collectArtifacts(entries, workspaceDir, { scope: "session" }), [entries, workspaceDir]);
	const [fileOpenError, setFileOpenError] = useState<string>();
	useEffect(() => setFileOpenError(undefined), [sessionId, workspaceDir]);
	const openTaskFile = (path: string): void => {
		const relative = workspaceArtifactPath(path, workspaceRef.current);
		if (!relative) return;
		setFileOpenError(undefined);
		const kind = viewerKindForPath(relative, getSidebarConfig());
		if (kind === undefined) {
			void client.request({ type: "open.external", action: "url", target: fileUrlOf(workspaceRef.current, relative) })
				.then((result) => { if (!result.ok) setFileOpenError(result.error ?? t("app.fileOpenFailed")); })
				.catch((error: unknown) => setFileOpenError(error instanceof Error ? error.message : String(error)));
			return;
		}
		workbenchStore.openFileTab(kind, relative, relative.split("/").pop() ?? relative);
		setDeveloperLayoutPersisted(false);
		if (!openRef.current) setDockPersisted(window.innerWidth < 1100 ? "bottom" : "right");
		setWorkbenchOpenPersisted(true);
	};

	// 面板开合/停靠的 ref 镜像：快捷键与卡片回调里免 stale closure。
	const dockRef = useRef(workbenchDock);
	dockRef.current = workbenchDock;
	const openRef = useRef(workbenchOpen);
	openRef.current = workbenchOpen;

	/** 在指定停靠位打开面板；再点一次同位按钮 = 收起（顶部两个按钮共用）。 */
	const togglePanelAt = (target: WorkbenchDock): void => {
		if (openRef.current && dockRef.current === target) {
			setWorkbenchOpenPersisted(false);
			return;
		}
		setDockPersisted(target);
		setWorkbenchOpenPersisted(true);
	};

	/** 打开一个快捷 tab（开始页卡片入口）：不动停靠位，只保证面板展开。 */
	const requestOpenKind = (kind: string): void => {
		openQuickAction(workbenchStore, kind);
		setWorkbenchOpenPersisted(true);
	};

	const openDeveloper = (): void => {
		if (!openDeveloperWorkbench(workbenchStore, (kind) => isTabKindEnabled(kind))) return;
		setRailView("chat");
		setDeveloperLayoutPersisted(true);
		setDockPersisted(window.innerWidth < 1100 ? "bottom" : "right");
		setWorkbenchOpenPersisted(true);
		setShowSettings(false);
	};

	/** 快捷键开终端 / 浏览器 tab：面板没开就先展开（不切停靠位）。 */
	const openInPanel = (kind: string): void => {
		setRailView("chat");
		if (!openRef.current) setWorkbenchOpenPersisted(true);
		openQuickAction(workbenchStore, kind);
	};

	const workspaceRef = useRef(workspaceDir);
	workspaceRef.current = workspaceDir;
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;
	useEffect(() => client.onNewsOpen((message) => {
		if (sessionIdRef.current && message.sessionId !== sessionIdRef.current) return;
		setShowSettings(false);
		setRailView("news");
		setNewsTarget({ kind: message.kind, id: message.id, revision: Date.now() });
	}), [client]);
	useEffect(() => {
		const openNewsHash = (): void => {
			const match = /^#news\/(item|story)\/([^/]+)$/.exec(window.location.hash.replace(/^#\//, "#"));
			if (!match) return;
			let id: string;
			try { id = decodeURIComponent(match[2]); } catch { return; }
			setShowSettings(false); setRailView("news");
			setNewsTarget({ kind: match[1] as "item" | "story", id, revision: Date.now() });
		};
		openNewsHash();
		window.addEventListener("hashchange", openNewsHash);
		return () => window.removeEventListener("hashchange", openNewsHash);
	}, []);
	useEffect(() => setQuestionNavOpen(false), [sessionId, workspaceDir]);
	useEffect(() => setRewindTarget(undefined), [sessionId, workspaceDir]);

	// -- 会话回退（owl-rewind）--------------------------------------------------
	// 点用户消息旁的 ↶：找到带 entryId 的行弹确认弹层；执行成功后按快照重建
	// 转录、把被回退的目标消息文本回填输入框（replace 语义，替换现有草稿）。
	const handleRewindClick = (entryId: string): void => {
		if (!sessionIdRef.current) return;
		const clicked = entries.find((entry) => entry.kind === "user" && entry.entryId === entryId);
		if (clicked?.kind === "user") setRewindTarget({ entryId, text: clicked.text });
	};

	const handleRewindDone = (result: RewindExecuteResult): void => {
		setRewindTarget(undefined);
		const messages = result.snapshot.messages as Record<string, unknown>[];
		setEntries(rebuild(messages, result.snapshot.messageEntryIds));
		if (typeof result.editorText === "string") {
			setDraftRequest({ id: ++draftSequence.current, text: result.editorText, replace: true });
		}
		void refreshStats();
	};

	useEffect(() => {
		client.connect();
		const offStatus = client.onStatus((up) => {
			setConnected(up);
			if (up) setEverConnected(true);
			else {
				submitInFlight.current = false;
				setSubmitting(false);
			}
		});
		const offEvents = client.onSessionEvent((message: ServerEventMessage) => {
			// 全会话运行状态跟踪：agent_start / agent_settled 成对出现（abort、出错也走 settled），
			// 必须在下面的当前会话过滤之前记录，否则后台会话的绿点状态丢失。
			const eventType = (message.event as { type?: string }).type;
			if (eventType === "agent_start") {
				setRunningSessions((current) => new Set(current).add(message.sessionId));
			} else if (eventType === "agent_settled") {
				setRunningSessions((current) => {
					if (!current.has(message.sessionId)) return current;
					const next = new Set(current);
					next.delete(message.sessionId);
					return next;
				});
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
			setPermission(request);
			if (request) {
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
			setQuestions((current) => [...current, request]);
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
			client.respondPermission(payload.requestId, payload.approved);
			setPermission((current) => (current?.requestId === payload.requestId ? undefined : current));
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
		setSessionFeed({ running, entries });
	}, [running, entries]);

		// Ctrl + ` 新建终端、Ctrl + T 新建浏览器 tab（与开始页卡片上的提示一致；
		// DSH 同款语义：终端落在当前停靠位，面板没开时顺手展开。
		// 焦点在内嵌浏览器里时不抢：那些组合键属于页面本身）
		useEffect(() => {
			const onKey = (event: KeyboardEvent): void => {
				if (!event.ctrlKey || event.altKey || event.shiftKey) return;
				if ((event.target as HTMLElement | null)?.closest?.("[data-iab-capture]")) return;
				if (event.key === "`" || event.code === "Backquote") {
					event.preventDefault();
					openInPanel("terminal");
				} else if (event.ctrlKey && (event.key === "t" || event.key === "T")) {
					event.preventDefault();
					openInPanel("browser");
				}
			};
			window.addEventListener("keydown", onKey);
			return () => window.removeEventListener("keydown", onKey);
		}, []); // eslint-disable-line react-hooks/exhaustive-deps

		// IAB 联动（ZCode 同款）：agent 用 browser_* 工具开/切页面时，用户始终
		// 看得见 agent 的浏览器操作。用户自己开的面板（origin=ui）不打扰。
		// agent 拉起的停靠位固定为右列：浏览器需要纵向空间，底栏会压成一条
		// 视觉效果很差；用户自己点的面板不改变它原本的停靠位。
		// 侧边卡片设置停用了「浏览器」卡片时不再自动弹面板（设置页「侧边卡片」）。
		useEffect(() => {
			return client.onIabMessage((message) => {
				if (message.type !== "iab.pages" || message.origin !== "agent") return;
				if (!isTabKindEnabled("browser", getSidebarConfig())) return;
				const target = agentPageForSession(message, sessionIdRef.current);
				if (!target) return;
				// 已有面板在看：直接激活那个 tab；没有才开新 tab
				const boundTabId = isIabPageBound(target.pageId) ? boundTabIdFor(target.pageId) : undefined;
				if (boundTabId) workbenchStore.activate(boundTabId);
				else workbenchStore.openNew("browser", target.title || t("app.browserTab"), encodeIabPath(target.pageId, target.url, target.sessionId));
				if (dockRef.current !== "right") setDockPersisted("right");
				setWorkbenchOpenPersisted(true);
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
		if (!connected) return;
		void client
			.request<ProviderModelsMessage[]>({ type: "models.list" })
			.then((response) => response.ok && setProviders(response.result ?? []))
			.catch(() => {});
		// 连接后拉一次运行中的会话：UI 刷新或桥重连后恢复侧边栏的运行状态点。
		void client
			.request<SessionRunningResult>({ type: "session.running" })
			.then((response) => {
				if (!response.ok) return;
				setRunningSessions(new Set(response.result?.running ?? []));
				setPendingPrompts(new Set());
			})
			.catch(() => {});
		// 主题偏好存放在 settings.json（dark / light / system），连上桥后立即应用；
		// 侧边卡片配置（owlSidebar）同源拉取，供工作台/快捷入口即时生效。
		void client
			.request<{ agentDir: string; settings: unknown }>({ type: "settings.get" })
			.then((response) => {
				if (!response.ok) return;
				const settings = response.result?.settings as Record<string, unknown> | undefined;
				if (isThemePreference(settings?.theme)) setThemePreference(settings.theme);
				setSidebarConfig(parseSidebarSettings(settings?.owlSidebar));
				applyChatAppearance(parseChatAppearance(settings?.desktopChatAppearance));
				// 界面语言随 settings.json 启动加载；设置页切换后经 settings.set 持久化。
				setUiLanguage(parseUiLanguage(settings?.uiLanguage));
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
			if (response.ok) setSessionInfo(response.result ?? undefined);
		} catch {
			// 桥断开时静默跳过，重连后下一轮会重新拉取
		}
	}

	async function ensureSession(): Promise<string | undefined> {
		if (sessionIdRef.current) return sessionIdRef.current;
		const response = await client.request<{ sessionId: string }>({
			type: "session.create",
			cwd: workspaceRef.current,
			...selectedModel(),
			thinkingLevel,
			approvalMode,
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
		void refreshStats(id);
		return id;
	}

	const newChat = (): void => {
		sessionIdRef.current = undefined;
		setSessionId(undefined);
		setEntries([]);
		setRetryStatus(null);
		setSessionInfo(undefined);
		void ensureSession();
	};

	// 切换项目 = 换工作目录并从新会话开始；会话历史按项目分目录存（Owl-history\<编码cwd>），
	// 不随切换丢失，随时可从侧边栏切回。首个 prompt 时才在当前项目下创建会话。
	const switchProject = (path: string): void => {
		sessionIdRef.current = undefined;
		setWorkspaceDir(path);
		localStorage.setItem(WORKSPACE_KEY, path);
		setSessionId(undefined);
		setEntries([]);
		setRetryStatus(null);
		setSessionInfo(undefined);
	};

	// 恢复历史会话：回放消息快照、切到该会话的项目视图，后续 prompt 直接续聊。
	// silent：自动恢复专用——失败不留错误横幅，退回空白新会话即可（用户没主动点过它）。
	const openSession = async (targetSessionId: string, options?: { silent?: boolean }): Promise<void> => {
		const response = await client.request<{
			sessionId: string;
			cwd: string;
			messages: Record<string, unknown>[];
			messageEntryIds?: (string | undefined)[];
		}>({
			type: "session.resume",
			sessionId: targetSessionId,
			approvalMode,
			...selectedModel(),
		});
		if (!response.ok || !response.result) {
			console.error("session.resume failed:", response.error);
			if (!options?.silent) {
				setEntries([
					{ kind: "toolResult", toolName: t("app.sessionRestoreFailed"), ok: false, brief: response.error ?? t("app.unknownError") },
				]);
			}
			return;
		}
		const { sessionId: resumedId, cwd, messages, messageEntryIds } = response.result;
		setWorkspaceDir(cwd);
		localStorage.setItem(WORKSPACE_KEY, cwd);
		setSessionId(resumedId);
		sessionIdRef.current = resumedId;
		setEntries(rebuild(messages, messageEntryIds));
		setRetryStatus(null);
		void refreshStats(resumedId);
	};

	// 启动自动续聊：连接后自动恢复当前项目最近一个有消息的会话（Claude Desktop 同款行为）。
	// 每次启动只尝试一次；若用户抢先发消息/点会话（sessionId 已就位），则不打扰。
	const restoreTriedRef = useRef(false);
	useEffect(() => {
		if (!connected || restoreTriedRef.current) return;
		restoreTriedRef.current = true;
		void (async () => {
			try {
				const response = await client.request<SessionRowLite[]>({ type: "session.list" });
				if (!response.ok || !response.result) return;
				const rows = response.result.filter((row) => row.id && samePath(row.cwd, workspaceRef.current));
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
	}, [connected, client]); // eslint-disable-line react-hooks/exhaustive-deps

	// 输入框项目选择器的候选列表：session.list 的项目 ∪ 到访过的项目 ∪ 当前项目（与侧边栏同源）。
	// 切项目 / 侧边栏重拉（恢复、删除归档）时刷新；桥瞬断静默跳过。
	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		void client
			.request<SessionRowLite[]>({ type: "session.list" })
			.then((response) => {
				if (!response.ok || !response.result || cancelled) return;
				const seen = new Map<string, string>();
				const track = (path: string | undefined): void => {
					if (!path) return;
					const key = normPath(path);
					if (!seen.has(key)) seen.set(key, path);
				};
				track(workspaceRef.current);
				for (const row of response.result) track(row.cwd);
				for (const path of loadKnownProjects()) track(path);
				setProjects([...seen.values()]);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [connected, client, workspaceDir, sidebarRev]);

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
				if (response.ok && response.result) setSessionInfo(response.result);
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
				if (response.ok && response.result) setSessionInfo(response.result);
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

	const sendPrompt = async (message: string, images?: ComposerImage[]): Promise<void> => {
		const hasImages = (images?.length ?? 0) > 0;
		if (!connected || running || submitInFlight.current || (!message.trim() && !hasImages)) return;
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
		setEntries((current) => [
			...current,
			{ kind: "user", text: message, ...(hasImages ? { images: images!.map(({ data, mimeType }) => ({ data, mimeType })) } : {}) },
		]);
		// 用户亲自发言：旧的"重试中/重试失败"横幅已过时（会话由新消息接管）
		setRetryStatus(null);
		setPendingPrompts((current) => new Set(current).add(target!));
		const response = await client.request({
			type: "session.prompt",
			sessionId: target,
			message,
			...(hasImages ? { images } : {}),
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
			if (!target || target === sessionIdRef.current) setEntries((current) => [...current, {
				kind: "toolResult", toolName: t("app.sendFailed"), ok: false, brief: error instanceof Error ? error.message : String(error),
			}]);
		} finally {
			submitInFlight.current = false;
			setSubmitting(false);
		}
	};

	const abort = async (): Promise<void> => {
		if (sessionId) await client.request({ type: "session.abort", sessionId });
	};

	// -- 顶栏（对照 DSH 会话头：标题 + 元信息 chips + 右侧功能簇） --------------
	const sessionTitle = useMemo(() => {
		const first = entries.find((entry) => entry.kind === "user");
		if (!first) return t("app.newConversation");
		const line = first.text.split("\n").find((part) => part.trim() !== "") ?? "";
		return line.length > 42 ? `${line.slice(0, 42)}…` : line || t("app.newConversation");
	}, [entries]);
	const projectBasename = workspaceDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? workspaceDir;
	const mapModelValue = modelValue || (sessionInfo?.model ? `${sessionInfo.model.provider}/${sessionInfo.model.id}` : "");
	const mapModelSeparator = mapModelValue.indexOf("/");
	const mapModelName = providers.find((provider) => provider.id === mapModelValue.slice(0, mapModelSeparator))
		?.models.find((model) => model.id === mapModelValue.slice(mapModelSeparator + 1))?.name;
	const questionCount = entries.filter((entry) => entry.kind === "user").length;
	const waitingForUser = Boolean(sessionId && (permission?.sessionId === sessionId || questions.some((question) => question.sessionId === sessionId)));
	const chatActivity: ChatActivity = running || submitting ? !connected ? "disconnected" : waitingForUser ? "waiting" : "working" : "idle";

	const headerButtonClass = (active: boolean): string =>
		`owl-chrome-button${active ? " is-active" : ""}`;

	return (
		<div className="owl-desktop-shell font-sans text-owl-text">
			<DesktopTitlebar
				connected={connected}
				sidebarCollapsed={sidebarMinimized || showSettings}
				sidebarView={railView}
				sidebarToggleRef={sidebarToggleRef}
				onToggleSidebar={() => {
					if (showSettings) {
						setShowSettings(false);
						if (sidebarMinimized) toggleSessionSidebar();
					}
					else toggleSessionSidebar();
				}}
				onNewChat={() => {
					setShowSettings(false);
					setRailView("chat");
					newChat();
				}}
				onOpenProject={() => { setRailView("chat"); setShowProjectDialog(true); }}
				onOpenSettings={() => {
					setSettingsInitialTab("general");
					setShowSettings(true);
				}}
				onOpenAbout={() => {
					setSettingsInitialTab("about");
					setShowSettings(true);
				}}
				onDockRight={() => {
					setShowSettings(false);
					setRailView("chat");
					togglePanelAt("right");
				}}
				onDockBottom={() => {
					setShowSettings(false);
					setRailView("chat");
					togglePanelAt("bottom");
				}}
				onOpenDeveloper={openDeveloper}
			/>
			<div className="owl-desktop-body">
			<ActivityRail
				view={railView}
				settingsOpen={showSettings}
				onSelect={(view) => { setShowSettings(false); setRailView(view); if (view === "mail") setMailMounted(true); }}
				onOpenSettings={() => { setSettingsInitialTab("general"); setShowSettings(true); }}
			/>
			<SessionSidebar
				client={client}
				connected={connected}
				activeId={sessionId}
				activeProject={workspaceDir}
				refreshKey={sessionId ?? ""}
				revision={sidebarRev}
				focus={railView}
				minimized={sidebarMinimized || showSettings || railView !== "chat"}
				onToggleMinimized={toggleSessionSidebar}
				runningSessions={runningSessions}
				onNewChat={() => {
					setRailView("chat");
					newChat();
				}}
				onSelectProject={switchProject}
				onOpenSession={(id) => void openSession(id)}
				onOpenSettings={() => { setSettingsInitialTab("general"); setShowSettings(true); }}
			/>
			<div className="owl-map-view" style={{ display: railView === "map" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
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
				/>
			</div>
			<div style={{ display: railView === "news" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
				<NewsPage client={client} active={railView === "news" && !showSettings} sidebarCollapsed={sidebarMinimized} initialTarget={newsTarget} onToChat={(text) => {
					setRailView("chat"); setShowSettings(false); setConversationViewPersisted("chat");
					setDraftRequest({ id: ++draftSequence.current, text });
				}} />
			</div>
			{mailMounted && <div style={{ display: railView === "mail" && !showSettings ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
				<MailPage client={client} connected={connected} cwd={workspaceDir} sidebarCollapsed={sidebarMinimized} model={selectedModel()} thinkingLevel={thinkingLevel} />
			</div>}
			<div className="owl-main-frame" style={{ display: railView === "chat" || showSettings ? undefined : "none" }}>
				<header className="owl-chat-header flex shrink-0 select-none items-center" data-tauri-drag-region="deep">
					<h1 className="owl-shell-session-title text-sm font-semibold text-owl-text" title={sessionTitle}>{sessionTitle}</h1>
					<span className="owl-shell-project" title={workspaceDir}>
						<IconFolder size={12} /><span className="owl-shell-project-label">{projectBasename}</span>
					</span>
					{/* 会话视图 tab：对话 / 上下文（owl-context 插件供数，主区随 tab 切换） */}
					<div className="owl-view-tabs" role="tablist" aria-label={t("app.viewTabsAria")} data-tauri-drag-region="false">
						<button type="button" role="tab" aria-selected={conversationView === "chat"} title={t("app.viewChat")} onClick={() => setConversationViewPersisted("chat")}>{t("app.viewChat")}</button>
						<button type="button" role="tab" aria-selected={conversationView === "context"} title={t("composer.context")} onClick={() => setConversationViewPersisted("context")}>{t("composer.context")}</button>
					</div>
					<div className="owl-shell-header-actions" data-tauri-drag-region="false">
						<span className={"owl-shell-connection" + (connected ? "" : " is-offline")} role="status" title={connected ? t("composer.connected") : t("app.connectionOffline")}>
							<span className="owl-shell-connection-dot" />
							{connected ? t("composer.runLocation.local") : everConnected ? t("app.reconnecting") : t("app.connecting")}
						</span>
						{questionCount > 0 && <button type="button" className="owl-chat-directory-trigger" aria-controls="owl-chat-directory" aria-expanded={questionNavOpen} onClick={() => setQuestionNavOpen((open) => !open)}><IconList className="h-3.5 w-3.5" /><span>{t("chat.directoryTitle", { n: questionCount })}</span></button>}
						<button type="button" className="owl-developer-trigger" aria-pressed={workbenchOpen && developerLayout} title={t("app.developerTriggerTip")} onClick={() => {
							if (workbenchOpen && developerLayout) setWorkbenchOpenPersisted(false);
							else openDeveloper();
						}}>{t("app.developerTrigger")}</button>
						<button type="button" title={t("app.dockBottomTitle")} aria-label={t("app.dockBottomTitle")} aria-pressed={workbenchOpen && workbenchDock === "bottom"} className={headerButtonClass(workbenchOpen && workbenchDock === "bottom")} onClick={() => togglePanelAt("bottom")}><IconPanelBottom size={16} /></button>
						<button type="button" title={t("app.dockRightTitle")} aria-label={t("app.dockRightTitle")} aria-pressed={workbenchOpen && workbenchDock === "right"} className={headerButtonClass(workbenchOpen && workbenchDock === "right")} onClick={() => togglePanelAt("right")}><IconPanelRight size={16} /></button>
					</div>
				</header>
				{/* 工作台常挂载：bottom 停靠时在聊天流之下，right 停靠时在右列（仅父容器换向） */}
				<div className={"owl-shell-content" + (workbenchDock === "bottom" ? " is-bottom" : "")}>
					<div className="owl-shell-conversation">
						{conversationView === "context" ? (
							<ContextView client={client} cwd={workspaceDir} />
						) : (
							<>
								<ChatStream key={sessionId ?? workspaceDir} entries={entries} cwd={workspaceDir} onOpenFile={openTaskFile} onQuickAction={requestOpenKind} onPromptExample={(text) => setDraftRequest({ id: ++draftSequence.current, text })} onOpenDeveloper={openDeveloper} artifacts={<Artifacts artifacts={artifacts} onOpenFile={openTaskFile} />} activity={chatActivity} navigationOpen={questionNavOpen} onNavigationClose={() => setQuestionNavOpen(false)} onRewind={handleRewindClick} />
								{fileOpenError && <p className="px-4 py-1 text-xs text-red-400" role="alert">{fileOpenError}</p>}
							</>
						)}
						{/* 任务清单常驻条：贴在输入框上方，实时提醒当前进度（无清单时自动隐藏） */}
						<TodoPin entries={entries} />
						{/* 自动重试横幅：桥端 auto-retry 进行中/耗尽时贴在输入框上方（此前事件过线无人渲染） */}
						<RetryPin status={retryStatus} onDismiss={() => setRetryStatus(null)} />
						<Composer
							client={client}
							connected={connected}
							disabled={running || submitting || !connected}
							running={running}
							onSend={(text, images) => void sendPrompt(text, images)}
							onAbort={() => void abort()}
							providers={providers}
							model={modelValue}
							onModel={handleModelChange}
							thinkingLevel={thinkingLevel}
							onThinkingLevel={handleThinkingChange}
							approvalMode={approvalMode}
							onApprovalMode={handleApprovalModeChange}
							sessionInfo={sessionInfo}
							workspaceDir={workspaceDir}
							projects={projects}
							onSwitchProject={switchProject}
							commands={slashCommands}
							draftRequest={draftRequest}
						/>
					</div>
					<BrowserSessionContext.Provider value={sessionId}>
						<Workbench
							client={client}
							cwd={workspaceDir}
							store={workbenchStore}
							open={workbenchOpen}
							onSetOpen={setWorkbenchOpenPersisted}
							dock={workbenchDock}
							onSetDock={setDockPersisted}
							developerLayout={developerLayout}
						/>
					</BrowserSessionContext.Provider>
				</div>
			{showSettings && (
				<SettingsPage
					client={client}
					workspaceDir={workspaceDir}
					initialTab={settingsInitialTab}
					onWorkspaceDir={(dir) => {
						setWorkspaceDir(dir);
						localStorage.setItem(WORKSPACE_KEY, dir);
					}}
					onClose={() => setShowSettings(false)}
					onSessionsChanged={() => setSidebarRev((v) => v + 1)}
				/>
			)}
			</div>
			</div>
			{showProjectDialog && (
				<NewProjectDialog client={client} onClose={() => setShowProjectDialog(false)} onCreated={(path) => {
					setShowProjectDialog(false);
					setShowSettings(false);
					switchProject(path);
				}} />
			)}
			{permission && (
				<PermissionDialog
					request={permission}
					onDecide={(approved) => {
						client.respondPermission(permission.requestId, approved);
						setPermission(undefined);
					}}
				/>
			)}
			{questions[0] && (
				<QuestionDialog
					key={questions[0].requestId}
					request={questions[0]}
					onAnswer={(answers, cancelled) => {
						client.respondQuestion(questions[0].requestId, answers, cancelled);
						setQuestions((current) => current.slice(1));
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
		</div>
	);
}
