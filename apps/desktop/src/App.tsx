import { useEffect, useMemo, useRef, useState } from "react";
import { BridgeClient } from "./bridge/client.ts";
import type { PermissionRequest, ServerEventMessage } from "./bridge/protocol.ts";
import { applyEvent, type ChatEntry } from "./hooks/transcript.ts";
import { ChatStream } from "./components/ChatStream.tsx";
import { Composer } from "./components/Composer.tsx";
import { PermissionDialog } from "./components/PermissionDialog.tsx";
import { ModelSwitcher } from "./components/ModelSwitcher.tsx";
import { SessionSidebar } from "./components/SessionSidebar.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import type { ProviderModelsMessage } from "./bridge/protocol.ts";

const WORKSPACE_KEY = "pire.workspaceDir";

export default function App(): React.JSX.Element {
	const client = useMemo(() => new BridgeClient(), []);
	const [connected, setConnected] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [entries, setEntries] = useState<ChatEntry[]>([]);
	const [running, setRunning] = useState(false);
	const [sessionId, setSessionId] = useState<string | undefined>(undefined);
	const [permission, setPermission] = useState<PermissionRequest | undefined>(undefined);
	const [providers, setProviders] = useState<ProviderModelsMessage[]>([]);
	const [workspaceDir, setWorkspaceDir] = useState(
		() => localStorage.getItem(WORKSPACE_KEY) ?? "D:/pire/acceptance-ws",
	);
	const workspaceRef = useRef(workspaceDir);
	workspaceRef.current = workspaceDir;

	useEffect(() => {
		client.connect();
		const offStatus = client.onStatus(setConnected);
		const offEvents = client.onSessionEvent((message: ServerEventMessage) => {
			setEntries((current) => applyEvent(current, message));
			if ((message.event as { type?: string }).type === "agent_settled") setRunning(false);
		});
		const offPermission = client.onPermissionRequest(setPermission);
		return () => {
			offStatus();
			offEvents();
			offPermission();
		};
	}, [client]);

	useEffect(() => {
		if (!connected) return;
		void client
			.request<ProviderModelsMessage[]>({ type: "models.list" })
			.then((response) => response.ok && setProviders(response.result ?? []))
			.catch(() => {});
	}, [connected, client]);

	function selectedModel(): { provider: string; model: string } | undefined {
		const value = localStorage.getItem("pire.model");
		if (!value) return undefined;
		const slash = value.indexOf("/");
		if (slash <= 0) return undefined;
		return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
	}

	async function ensureSession(): Promise<string | undefined> {
		if (sessionId) return sessionId;
		const response = await client.request<{ sessionId: string }>({
			type: "session.create",
			cwd: workspaceRef.current,
			...selectedModel(),
			approvalMode: "confirm",
		});
		if (!response.ok || !response.result) {
			console.error("session.create failed:", response.error);
			return undefined;
		}
		const id = response.result.sessionId;
		setSessionId(id);
		setEntries([]);
		return id;
	}

	const newChat = (): void => {
		setSessionId(undefined);
		setEntries([]);
		void ensureSession();
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
		<div className="flex h-screen bg-neutral-950 text-neutral-200">
			<SessionSidebar client={client} activeId={sessionId} onNewChat={newChat} />
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex items-center gap-3 px-4 py-2">
					<span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
					<span className="text-sm text-neutral-400">{connected ? "bridge 已连接" : "桥未连接"}</span>
					<div className="flex-1" />
					<ModelSwitcher providers={providers} />
					<button
						type="button"
						className="rounded border border-neutral-700 px-2 py-1 text-sm hover:bg-neutral-800"
						onClick={() => setShowSettings(true)}
					>
						设置
					</button>
				</header>
				<ChatStream entries={entries} />
				<Composer
					disabled={running || !connected}
					running={running}
					onSend={(text) => void sendPrompt(text)}
					onAbort={() => void abort()}
				/>
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
				/>
			)}
		</div>
	);
}
