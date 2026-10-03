import { useEffect, useMemo, useRef, useState } from "react";
import { BridgeClient } from "./bridge/client.ts";
import type { ApprovalMode, CommandsListResult, PermissionRequest, ProviderModelsMessage, QuestionRequest, ServerEventMessage, SessionRunningResult, SessionStatsResult, SlashCommandEntry } from "./bridge/protocol.ts";
import { applyEvent, rebuild, type ChatEntry } from "./hooks/transcript.ts";
import { ActivityRail, type RailView } from "./components/ActivityRail.tsx";
import { ChatStream, type ChatActivity } from "./components/ChatStream.tsx";
import { Composer } from "./components/Composer.tsx";
import { PermissionDialog } from "./components/PermissionDialog.tsx";
import { QuestionDialog } from "./components/QuestionDialog.tsx";
import { SessionSidebar } from "./components/SessionSidebar.tsx";
import { IconList } from "./components/icons.tsx";
import { DesktopTitlebar } from "./components/DesktopTitlebar.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { TodoPin } from "./components/TodoPin.tsx";
import { isThemePreference, setThemePreference } from "./theme.ts";
import { applyChatAppearance, parseChatAppearance } from "./chat-appearance.ts";
import { loadKnownProjects, normPath, samePath } from "./utils/paths.ts";
import { Workbench, type WorkbenchDock } from "./sidebar/Workbench.tsx";
import { SidebarStore, normProjectKey } from "./sidebar/store.ts";
import { openQuickAction } from "./sidebar/quick.tsx";
import { getSidebarConfig, isTabKindEnabled, parseSidebarSettings, setSidebarConfig, viewerKindForPath } from "./sidebar/config.ts";
import { fileUrlOf } from "./sidebar/api.ts";
import { isIabPageBound, boundTabIdFor, encodeIabPath } from "./sidebar/iab-bound.ts";
import { IconFolder, IconPanelBottom, IconPanelRight } from "./sidebar/icons.tsx";
import { setSessionFeed } from "./sidebar/feed.ts";
import { notifyAgentStatus } from "./utils/notification.ts";
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
	const client = useMemo(() => new BridgeClient(), []);
	const [connected, setConnected] = useState(false);
	const [everConnected, setEverConnected] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [settingsInitialTab, setSettingsInitialTab] = useState<"general" | "about">("general");
	const [showProjectDialog, setShowProjectDialog] = useState(false);
	// 设置页改动会话（恢复/删除归档）时递增，驱动侧边栏重拉列表
	const [sidebarRev, setSidebarRev] = useState(0);
	const [railView, setRailView] = useState<RailView>("chat");
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

	/** 快捷键开终端 / 浏览器 tab：面板没开就先展开（不切停靠位）。 */
	const openInPanel = (kind: string): void => {
		if (!openRef.current) setWorkbenchOpenPersisted(true);
		openQuickAction(workbenchStore, kind);
	};

	const workspaceRef = useRef(workspaceDir);
	workspaceRef.current = workspaceDir;
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;
	useEffect(() => setQuestionNavOpen(false), [sessionId, workspaceDir]);

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
			if (eventType === "agent_settled") {
				void refreshStats();
				void notifyAgentStatus({
					title: "Owl 任务完成",
					body: "Agent 已完成当前回答与代码修改",
					critical: false,
				});
			}
		});
		const offPermission = client.onPermissionRequest((request) => {
			setPermission(request);
			if (request) {
				void notifyAgentStatus({
					title: "Owl 需要人工确认",
					body: `Agent 请求执行工具：${request.toolName ?? "工具操作"}`,
					critical: true,
				});
			}
		});
		const offQuestion = client.onQuestionRequest((request) => {
			setQuestions((current) => [...current, request]);
			void notifyAgentStatus({
				title: "Owl 向你提问",
				body: request.questions[0]?.question ?? "Agent 需要你作答后才能继续",
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
				const target = message.pages.find((page) => page.active) ?? message.pages[0];
				if (!target) return;
				// 已有面板在看：直接激活那个 tab；没有才开新 tab
				const boundTabId = isIabPageBound(target.pageId) ? boundTabIdFor(target.pageId) : undefined;
				if (boundTabId) workbenchStore.activate(boundTabId);
				else workbenchStore.openNew("browser", target.title || "浏览器", encodeIabPath(target.pageId, target.url));
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
				const kind = viewerKindForPath(message.path, getSidebarConfig());
				if (kind === undefined) {
					void client
						.request({ type: "open.external", action: "url", target: fileUrlOf(workspaceRef.current, message.path) })
						.catch(() => {});
					return;
				}
				workbenchStore.openFileTab(kind, message.path, message.path.split("/").pop() ?? message.path);
				if (!openRef.current) setWorkbenchOpenPersisted(true);
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
				{ kind: "toolResult", toolName: "会话创建失败", ok: false, brief: response.error ?? "未知错误" },
			]);
			return undefined;
		}
		const id = response.result.sessionId;
		sessionIdRef.current = id;
		setSessionId(id);
		setEntries([]);
		void refreshStats(id);
		return id;
	}

	const newChat = (): void => {
		sessionIdRef.current = undefined;
		setSessionId(undefined);
		setEntries([]);
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
		setSessionInfo(undefined);
	};

	// 恢复历史会话：回放消息快照、切到该会话的项目视图，后续 prompt 直接续聊。
	// silent：自动恢复专用——失败不留错误横幅，退回空白新会话即可（用户没主动点过它）。
	const openSession = async (targetSessionId: string, options?: { silent?: boolean }): Promise<void> => {
		const response = await client.request<{
			sessionId: string;
			cwd: string;
			messages: Record<string, unknown>[];
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
					{ kind: "toolResult", toolName: "会话恢复失败", ok: false, brief: response.error ?? "未知错误" },
				]);
			}
			return;
		}
		const { sessionId: resumedId, cwd, messages } = response.result;
		setWorkspaceDir(cwd);
		localStorage.setItem(WORKSPACE_KEY, cwd);
		setSessionId(resumedId);
		sessionIdRef.current = resumedId;
		setEntries(rebuild(messages));
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
						{ kind: "toolResult", toolName: "/model", ok: false, brief: "用法：/model <provider/model>" },
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
						{ kind: "toolResult", toolName: "/thinking", ok: false, brief: "用法：/thinking <off|minimal|low|medium|high|xhigh|max>" },
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
					{ kind: "toolResult", toolName: "压缩上下文", ok: true, brief: "开始手动压缩…" },
				]);
				try {
					const response = await client.request<SessionStatsResult>({ type: "session.compact", sessionId: target });
					setEntries((current) => [
						...current,
						response.ok
							? { kind: "toolResult", toolName: "压缩上下文", ok: true, brief: "压缩完成。" }
							: { kind: "toolResult", toolName: "压缩上下文", ok: false, brief: response.error ?? "压缩失败" },
					]);
					if (response.ok && response.result) setSessionInfo(response.result);
				} catch (error) {
					setEntries((current) => [
						...current,
						{
							kind: "toolResult",
							toolName: "压缩上下文",
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

	const sendPrompt = async (message: string): Promise<void> => {
		if (!connected || running || submitInFlight.current || !message.trim()) return;
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
		setEntries((current) => [...current, { kind: "user", text: message }]);
		setPendingPrompts((current) => new Set(current).add(target!));
		const response = await client.request({ type: "session.prompt", sessionId: target, message });
		if (!response.ok) throw new Error(response.error ?? "消息发送失败");
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
				kind: "toolResult", toolName: "发送失败", ok: false, brief: error instanceof Error ? error.message : String(error),
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
		if (!first) return "新对话";
		const line = first.text.split("\n").find((part) => part.trim() !== "") ?? "";
		return line.length > 42 ? `${line.slice(0, 42)}…` : line || "新对话";
	}, [entries]);
	const projectBasename = workspaceDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? workspaceDir;
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
				sidebarToggleRef={sidebarToggleRef}
				onToggleSidebar={() => {
					if (showSettings) setShowSettings(false);
					else toggleSessionSidebar();
				}}
				onNewChat={() => {
					setShowSettings(false);
					setRailView("chat");
					newChat();
				}}
				onOpenProject={() => setShowProjectDialog(true)}
				onOpenSettings={() => {
					setSettingsInitialTab("general");
					setShowSettings(true);
				}}
				onOpenAbout={() => {
					setSettingsInitialTab("about");
					setShowSettings(true);
				}}
				onDockRight={() => togglePanelAt("right")}
				onDockBottom={() => togglePanelAt("bottom")}
			/>
			<div className="owl-desktop-body">
			<ActivityRail
				view={railView}
				settingsOpen={showSettings}
				onSelect={(view) => { setShowSettings(false); setRailView(view); }}
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
				minimized={sidebarMinimized || showSettings}
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
			<div className="owl-main-frame">
				<header className="owl-chat-header flex shrink-0 select-none items-center" data-tauri-drag-region="deep">
					<h1 className="owl-shell-session-title text-sm font-semibold text-owl-text" title={sessionTitle}>{sessionTitle}</h1>
					<span className="owl-shell-project" title={workspaceDir}>
						<IconFolder size={12} /><span className="owl-shell-project-label">{projectBasename}</span>
					</span>
					<div className="owl-shell-header-actions" data-tauri-drag-region="false">
						<span className={"owl-shell-connection" + (connected ? "" : " is-offline")} role="status" title={connected ? "已连接" : "本地连接不可用"}>
							<span className="owl-shell-connection-dot" />
							{connected ? "本地" : everConnected ? "连接已断开，正在重连…" : "正在连接…"}
						</span>
						{questionCount > 0 && <button type="button" className="owl-chat-directory-trigger" aria-controls="owl-chat-directory" aria-expanded={questionNavOpen} onClick={() => setQuestionNavOpen((open) => !open)}><IconList className="h-3.5 w-3.5" /><span>对话目录 · {questionCount}</span></button>}
						<button type="button" title="底部工作台" aria-label="底部工作台" aria-pressed={workbenchOpen && workbenchDock === "bottom"} className={headerButtonClass(workbenchOpen && workbenchDock === "bottom")} onClick={() => togglePanelAt("bottom")}><IconPanelBottom size={16} /></button>
						<button type="button" title="右列工作台" aria-label="右列工作台" aria-pressed={workbenchOpen && workbenchDock === "right"} className={headerButtonClass(workbenchOpen && workbenchDock === "right")} onClick={() => togglePanelAt("right")}><IconPanelRight size={16} /></button>
					</div>
				</header>
				{/* 工作台常挂载：bottom 停靠时在聊天流之下，right 停靠时在右列（仅父容器换向） */}
				<div className={"owl-shell-content" + (workbenchDock === "bottom" ? " is-bottom" : "")}>
					<div className="owl-shell-conversation">
						<ChatStream key={sessionId ?? workspaceDir} entries={entries} onQuickAction={requestOpenKind} activity={chatActivity} navigationOpen={questionNavOpen} onNavigationClose={() => setQuestionNavOpen(false)} />
						{/* 任务清单常驻条：贴在输入框上方，实时提醒当前进度（无清单时自动隐藏） */}
						<TodoPin entries={entries} />
						<Composer
							client={client}
							connected={connected}
							disabled={running || submitting || !connected}
							running={running}
							onSend={(text) => void sendPrompt(text)}
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
						/>
					</div>
					<Workbench
						client={client}
						cwd={workspaceDir}
						store={workbenchStore}
						open={workbenchOpen}
						onSetOpen={setWorkbenchOpenPersisted}
						dock={workbenchDock}
						onSetDock={setDockPersisted}
					/>
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
		</div>
	);
}
