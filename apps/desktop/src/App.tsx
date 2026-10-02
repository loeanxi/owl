import { useEffect, useMemo, useRef, useState } from "react";
import { BridgeClient } from "./bridge/client.ts";
import type { PermissionRequest, ServerEventMessage, SessionStatsResult } from "./bridge/protocol.ts";
import { applyEvent, rebuild, type ChatEntry } from "./hooks/transcript.ts";
import { ActivityRail, type RailView } from "./components/ActivityRail.tsx";
import { ChatStream } from "./components/ChatStream.tsx";
import { Composer } from "./components/Composer.tsx";
import { PermissionDialog } from "./components/PermissionDialog.tsx";
import { SessionSidebar } from "./components/SessionSidebar.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { WindowControls } from "./components/WindowControls.tsx";
import { isThemePreference, setThemePreference } from "./theme.ts";
import { Workbench } from "./sidebar/Workbench.tsx";
import { IconPanelRight } from "./sidebar/icons.tsx";
import { notifyAgentStatus } from "./utils/notification.ts";
import type { ProviderModelsMessage } from "./bridge/protocol.ts";

const WORKSPACE_KEY = "owl.workspaceDir";
/** 未选择过项目时的默认工作目录；启动时会自动创建，保证开箱即可对话。 */
const DEFAULT_WORKSPACE_DIR = "D:/owl/Owl-def";
const MODEL_KEY = "owl.model";
const THINKING_KEY = "owl.thinkingLevel";
const WORKBENCH_OPEN_KEY = "owl.workbench.open";

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
	const [railView, setRailView] = useState<RailView>("chat");
	const [entries, setEntries] = useState<ChatEntry[]>([]);
	const [running, setRunning] = useState(false);
	const [sessionId, setSessionId] = useState<string | undefined>(undefined);
	const [permission, setPermission] = useState<PermissionRequest | undefined>(undefined);
	const [providers, setProviders] = useState<ProviderModelsMessage[]>([]);
	const [modelValue, setModelValue] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
	const [thinkingLevel, setThinkingLevel] = useState(() => localStorage.getItem(THINKING_KEY) ?? "medium");
	const [sessionInfo, setSessionInfo] = useState<SessionStatsResult | undefined>(undefined);
	const [workspaceDir, setWorkspaceDir] = useState(
		() => localStorage.getItem(WORKSPACE_KEY) ?? DEFAULT_WORKSPACE_DIR,
	);
	// 侧边栏工作台（文件树 / 编辑器 / Git 变动）：开合状态持久化。
	const [workbenchOpen, setWorkbenchOpen] = useState(
		() => localStorage.getItem(WORKBENCH_OPEN_KEY) === "1",
	);
	const toggleWorkbench = (): void => {
		setWorkbenchOpen((open) => {
			localStorage.setItem(WORKBENCH_OPEN_KEY, open ? "0" : "1");
			return !open;
		});
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
			setEntries((current) => applyEvent(current, message));
			if ((message.event as { type?: string }).type === "agent_settled") {
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
					body: `Agent 请求执行工具：${request.toolCall?.name ?? "工具操作"}`,
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
			approvalMode: "confirm",
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
			approvalMode: "confirm",
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
				focus={railView}
				onNewChat={() => {
					setRailView("chat");
					newChat();
				}}
				onSelectProject={switchProject}
				onOpenSession={(id) => void openSession(id)}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<header
					className="flex select-none items-center gap-3 border-b border-owl-border/60 px-4 py-2"
					data-tauri-drag-region="deep"
				>
					{/* 桥是界面与本地 agent 进程的内部管道：正常只留绿点，异常才出文案 */}
					{connected ? (
						<span className="h-2 w-2 rounded-full bg-emerald-500" title="已连接" />
					) : (
						<span className="flex items-center gap-2">
							<span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
							<span className="text-sm text-red-400">
								{everConnected ? "连接已断开，正在重连…" : "正在连接…"}
							</span>
						</span>
					)}
					<span
						className="max-w-72 truncate rounded bg-owl-sidebar px-2 py-0.5 font-mono text-xs text-owl-faint"
						title={workspaceDir}
					>
						{workspaceDir}
					</span>
					<div className="flex-1" />
					<button
						type="button"
						title="工作台（文件 / 编辑器 / Git 变动）"
						className={`rounded-lg border px-2.5 py-1 text-sm transition-colors ${
							workbenchOpen
								? "border-owl-accent/60 bg-owl-accent/10 text-owl-accent"
								: "border-owl-border text-owl-muted hover:bg-owl-hover hover:text-owl-text"
						}`}
						onClick={toggleWorkbench}
					>
						<span className="flex items-center gap-1.5">
							<IconPanelRight size={14} />
							工作台
						</span>
					</button>
					<button
						type="button"
						className="rounded-lg border border-owl-border px-2.5 py-1 text-sm text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
						onClick={() => setShowSettings(true)}
					>
						设置
					</button>
					<WindowControls />
				</header>
				<ChatStream entries={entries} />
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
					sessionInfo={sessionInfo}
				/>
			</div>
			{/* 侧边栏工作台：常挂载（隐藏时不丢编辑器草稿），按项目持久化布局 */}
			<Workbench client={client} cwd={workspaceDir} open={workbenchOpen} onSetOpen={setWorkbenchOpen} />
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
				/>
			)}
		</div>
	);
}
