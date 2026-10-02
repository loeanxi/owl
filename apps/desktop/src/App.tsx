import { useEffect, useMemo, useRef, useState } from "react";
import { BridgeClient } from "./bridge/client.ts";
import type { ApprovalMode, PermissionRequest, ProviderModelsMessage, ServerEventMessage, SessionRunningResult, SessionStatsResult } from "./bridge/protocol.ts";
import { applyEvent, rebuild, type ChatEntry } from "./hooks/transcript.ts";
import { ActivityRail, type RailView } from "./components/ActivityRail.tsx";
import { ChatStream } from "./components/ChatStream.tsx";
import { Composer } from "./components/Composer.tsx";
import { PermissionDialog } from "./components/PermissionDialog.tsx";
import { SessionSidebar } from "./components/SessionSidebar.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { WindowControls } from "./components/WindowControls.tsx";
import { isThemePreference, setThemePreference } from "./theme.ts";
import { Workbench, type WorkbenchDock } from "./sidebar/Workbench.tsx";
import { BottomDockBar } from "./sidebar/BottomDockBar.tsx";
import { SidebarStore, normProjectKey } from "./sidebar/store.ts";
import { openQuickAction } from "./sidebar/quick.tsx";
import { IconFolder, IconPanelBottom, IconPanelRight } from "./sidebar/icons.tsx";
import { setSessionFeed } from "./sidebar/feed.ts";
import { notifyAgentStatus } from "./utils/notification.ts";

const WORKSPACE_KEY = "owl.workspaceDir";
/** 未选择过项目时的默认工作目录；启动时会自动创建，保证开箱即可对话。 */
const DEFAULT_WORKSPACE_DIR = "D:/owl/Owl-def";
const MODEL_KEY = "owl.model";
const THINKING_KEY = "owl.thinkingLevel";
const APPROVAL_KEY = "owl.approvalMode";

/** localStorage 里记录的审批模式是否合法（防旧值/手改值落到未知档位）。 */
function isApprovalMode(value: string | null): value is ApprovalMode {
	return value === "auto" || value === "confirm" || value === "plan";
}
const WORKBENCH_OPEN_KEY = "owl.workbench.open";
const WORKBENCH_DOCK_KEY = "owl.workbench.dock";
const DOCK_BAR_KEY = "owl.dock.visible";

/** session.list 返回行的最小字段（完整形状见桥端 SessionInfo）。 */
type SessionRowLite = {
	id?: string;
	cwd?: string;
	modified?: string;
	created?: string;
	messageCount?: number;
	[key: string]: unknown;
};

/** Windows 大小写不敏感 + 分隔符统一后比较两个路径是否同一项目（与侧边栏同规则）。 */
function samePath(a: string | undefined, b: string | undefined): boolean {
	const norm = (p: string | undefined): string =>
		(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return norm(a) === norm(b) && norm(a) !== "";
}

function rowTime(row: SessionRowLite): string {
	return String(row.modified ?? row.created ?? "");
}

export default function App(): React.JSX.Element {
	const client = useMemo(() => new BridgeClient(), []);
	const [connected, setConnected] = useState(false);
	const [everConnected, setEverConnected] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	// 设置页改动会话（恢复/删除归档）时递增，驱动侧边栏重拉列表
	const [sidebarRev, setSidebarRev] = useState(0);
	const [railView, setRailView] = useState<RailView>("chat");
	const [entries, setEntries] = useState<ChatEntry[]>([]);
	const [running, setRunning] = useState(false);
	/** agent run 活跃的会话 id（含切走后的后台会话与旁路会话）：侧边栏运行状态点依据。 */
	const [runningSessions, setRunningSessions] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [sessionId, setSessionId] = useState<string | undefined>(undefined);
	const [permission, setPermission] = useState<PermissionRequest | undefined>(undefined);
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
	// 侧边栏工作台（文件树 / 编辑器 / Git 变动 / 任务 / 侧聊）：开合与停靠位置持久化。
	const [workbenchOpen, setWorkbenchOpen] = useState(
		() => localStorage.getItem(WORKBENCH_OPEN_KEY) === "1",
	);
	const [workbenchDock, setWorkbenchDock] = useState<WorkbenchDock>(() =>
		localStorage.getItem(WORKBENCH_DOCK_KEY) === "right" ? "right" : "bottom",
	);
	// 底部栏目（快捷卡条）：X 收起后从顶栏的底部面板按钮唤回。
	const [dockBarVisible, setDockBarVisible] = useState(() => localStorage.getItem(DOCK_BAR_KEY) !== "0");
	const setWorkbenchOpenPersisted = (open: boolean): void => {
		setWorkbenchOpen(open);
		localStorage.setItem(WORKBENCH_OPEN_KEY, open ? "1" : "0");
	};
	const setDockPersisted = (dock: WorkbenchDock): void => {
		setWorkbenchDock(dock);
		localStorage.setItem(WORKBENCH_DOCK_KEY, dock);
	};

	// 工作台 store 按项目提升到 App：底部栏与 Workbench 共用同一实例。
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
		if (target === "bottom") setDockBarVisible(true);
		setDockPersisted(target);
		setWorkbenchOpenPersisted(true);
	};

	/** 打开一个快捷 tab（底部栏 / 开始页卡片入口）：不动停靠位，只保证面板展开。 */
	const requestOpenKind = (kind: string): void => {
		openQuickAction(workbenchStore, kind);
		if (dockRef.current === "bottom") setDockBarVisible(true);
		setWorkbenchOpenPersisted(true);
	};

	/** 快捷键开终端 / 浏览器 tab：面板没开就先展开（不切停靠位）。 */
	const openInPanel = (kind: string): void => {
		if (!openRef.current) setWorkbenchOpenPersisted(true);
		openQuickAction(workbenchStore, kind);
		if (dockRef.current === "bottom") setDockBarVisible(true);
	};

	const workspaceRef = useRef(workspaceDir);
	workspaceRef.current = workspaceDir;
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;

	useEffect(() => {
		client.connect();
		const offStatus = client.onStatus((up) => {
			setConnected(up);
			if (up) setEverConnected(true);
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
			// 旁路会话（侧边对话等）的事件由各自 tab 消费，主转录只跟当前会话
			if (message.sessionId !== sessionIdRef.current) return;
			setEntries((current) => applyEvent(current, message));
			if (eventType === "agent_settled") {
				setRunning(false);
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
		return () => {
			offStatus();
			offEvents();
			offPermission();
		};
	}, [client]);

	// 任务管理 tab 的 feed：流式 delta 只重渲染订阅者，不牵连整个工作台
	useEffect(() => {
		setSessionFeed({ running, entries });
	}, [running, entries]);

	// Ctrl + ` 新建终端、Ctrl + T 新建浏览器 tab（与开始页卡片上的提示一致；
	// DSH 同款语义：终端落在当前停靠位，面板没开时顺手展开）
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (!event.ctrlKey || event.altKey || event.shiftKey) return;
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
			.then((response) => response.ok && setRunningSessions(new Set(response.result?.running ?? [])))
			.catch(() => {});
		// 主题偏好存放在 settings.json（dark / light / system），连上桥后立即应用。
		void client
			.request<{ agentDir: string; settings: unknown }>({ type: "settings.get" })
			.then((response) => {
				const theme = (response.result?.settings as Record<string, unknown> | undefined)?.theme;
				if (isThemePreference(theme)) setThemePreference(theme);
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
		if (sessionId) return sessionId;
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
		setSessionId(id);
		setEntries([]);
		void refreshStats(id);
		return id;
	}

	const newChat = (): void => {
		setSessionId(undefined);
		setEntries([]);
		setSessionInfo(undefined);
		void ensureSession();
	};

	// 切换项目 = 换工作目录并从新会话开始；会话历史按项目分目录存（Owl-history\<编码cwd>），
	// 不随切换丢失，随时可从侧边栏切回。首个 prompt 时才在当前项目下创建会话。
	const switchProject = (path: string): void => {
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

	const sendPrompt = async (message: string): Promise<void> => {
		const target = await ensureSession();
		if (!target) return;
		setEntries((current) => [...current, { kind: "user", text: message }]);
		setRunning(true);
		await client.request({ type: "session.prompt", sessionId: target, message });
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

	const headerButtonClass = (active: boolean): string =>
		`rounded-md border p-1 transition-colors ${
			active
				? "border-owl-accent/60 bg-owl-accent/10 text-owl-accent"
				: "border-owl-border text-owl-muted hover:bg-owl-hover hover:text-owl-text"
		}`;

	return (
		<div className="flex h-screen bg-owl-bg text-owl-text">
			<ActivityRail
				view={railView}
				onSelect={(view) => setRailView(view)}
				onOpenSettings={() => setShowSettings(true)}
			/>
			<SessionSidebar
				client={client}
				connected={connected}
				activeId={sessionId}
				activeProject={workspaceDir}
				refreshKey={sessionId ?? ""}
				revision={sidebarRev}
				focus={railView}
				runningSessions={runningSessions}
				onNewChat={() => {
					setRailView("chat");
					newChat();
				}}
				onSelectProject={switchProject}
				onOpenSession={(id) => void openSession(id)}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<header
					className="flex shrink-0 select-none items-center gap-2.5 border-b border-owl-border/60 px-4 py-2"
					data-tauri-drag-region="deep"
				>
					{/* 桥是界面与本地 agent 进程的内部管道：正常只留绿点，异常才出文案 */}
					{connected ? (
						<span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="已连接" />
					) : (
						<span className="flex shrink-0 items-center gap-2">
							<span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
							<span className="text-sm text-red-400">
								{everConnected ? "连接已断开，正在重连…" : "正在连接…"}
							</span>
						</span>
					)}
					{/* 会话标题（取首条提问），DSH 的 "Greeting and session start" 同位 */}
					<h1 className="max-w-56 shrink-0 truncate text-sm font-semibold text-owl-text" title={sessionTitle}>
						{sessionTitle}
					</h1>
					<span
						className="flex min-w-0 items-center gap-1.5 rounded bg-owl-sidebar px-2 py-0.5 text-xs text-owl-faint"
						title={workspaceDir}
					>
						<IconFolder size={11} />
						<span className="truncate">{projectBasename}</span>
					</span>
					<div className="min-w-4 flex-1" data-tauri-drag-region="deep" />
					{/* 右侧功能簇：底部工作台 / 右列工作台 / 窗口控制 */}
					<button
						type="button"
						title="底部工作台"
						aria-label="底部工作台"
						className={headerButtonClass(workbenchOpen && workbenchDock === "bottom")}
						onClick={() => togglePanelAt("bottom")}
					>
						<IconPanelBottom size={14} />
					</button>
					<button
						type="button"
						title="右列工作台"
						aria-label="右列工作台"
						className={headerButtonClass(workbenchOpen && workbenchDock === "right")}
						onClick={() => togglePanelAt("right")}
					>
						<IconPanelRight size={14} />
					</button>
					<WindowControls />
				</header>
				{/* 工作台常挂载：bottom 停靠时在聊天流之下，right 停靠时在右列（仅父容器换向） */}
				<div className={`flex min-h-0 flex-1 ${workbenchDock === "right" ? "flex-row" : "flex-col"}`}>
					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						<ChatStream entries={entries} onQuickAction={requestOpenKind} />
						<Composer
							disabled={running || !connected}
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
						/>
						{workbenchDock === "right" && dockBarVisible && (
							<BottomDockBar store={workbenchStore} panelOpen={workbenchOpen} onOpenKind={requestOpenKind} onHide={() => {
								setDockBarVisible(false);
								localStorage.setItem(DOCK_BAR_KEY, "0");
							}} />
						)}
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
					{workbenchDock === "bottom" && dockBarVisible && (
						<BottomDockBar store={workbenchStore} panelOpen={workbenchOpen} onOpenKind={requestOpenKind} onHide={() => {
							setDockBarVisible(false);
							localStorage.setItem(DOCK_BAR_KEY, "0");
						}} />
					)}
				</div>
			</div>
			{permission && (
				<PermissionDialog
					request={permission}
					onDecide={(approved) => {
						client.respondPermission(permission.requestId, approved);
						setPermission(undefined);
					}}
				/>
			)}
			{showSettings && (
				<SettingsPage
					client={client}
					workspaceDir={workspaceDir}
					onWorkspaceDir={(dir) => {
						setWorkspaceDir(dir);
						localStorage.setItem(WORKSPACE_KEY, dir);
					}}
					onClose={() => setShowSettings(false)}
					onSessionsChanged={() => setSidebarRev((v) => v + 1)}
				/>
			)}
		</div>
	);
}
