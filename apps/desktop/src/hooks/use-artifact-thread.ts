/**
 * 产物页的页内对话线程。
 *
 * 一件产物一条独立线程（不进主对话）：绑定一个独立会话，事件按 sessionId 过滤，
 * 每一轮都把产物重新带上（文件走 attachedPaths，可视化把 spec 内联进正文）。
 * 绑定按「项目 + 产物」持久化（localStorage），重开应用后 session.resume 静默回放。
 *
 * 与 `SideChatTab` 同一套机制（侧边小线程），差别只有两点：
 *   - 线程的键是产物而不是宿主会话；
 *   - 每一轮都附带产物上下文（`artifactPromptFor`）。
 */

import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import { SessionWatch } from "../bridge/session-watch.ts";
import { artifactPromptFor, artifactThreadKey } from "./artifact-thread.ts";
import type { Product } from "./products.ts";
import { applyEvent, type ChatEntry, rebuild } from "./transcript.ts";

export interface ArtifactThreadState {
	/** 线程转录（用户问 + 回答 + 工具行）。 */
	entries: ChatEntry[];
	/** 正在跑。 */
	running: boolean;
	/** 会话还没挂上（恢复中）——输入框先禁用。 */
	attached: boolean;
	/** 当前绑定的会话 id（还没建会话时是 undefined）。 */
	sessionId: string | undefined;
	/** 追问一句。 */
	send: (text: string) => void;
	/** 开一条新线程（丢掉当前绑定）。 */
	reset: () => void;
}

export function useArtifactThread({
	client,
	cwd,
	product,
}: {
	client: BridgeClient;
	cwd: string;
	product: Product;
}): ArtifactThreadState {
	const [entries, setEntries] = useState<ChatEntry[]>([]);
	const [running, setRunning] = useState(false);
	const [attached, setAttached] = useState(false);
	const [sessionId, setSessionId] = useState<string | undefined>(undefined);
	const sessionIdRef = useRef<string | null>(null);
	const watchRef = useRef<SessionWatch | null>(null);
	if (!watchRef.current) watchRef.current = new SessionWatch(client);
	const bindSession = (id: string | null): void => {
		sessionIdRef.current = id;
		setSessionId(id ?? undefined);
		watchRef.current?.set(id);
	};
	useEffect(() => () => watchRef.current?.dispose(), []);

	const threadKey = artifactThreadKey(cwd, product.id);

	// -- 会话绑定：挂载 / 换产物时重挂 ----------------------------------------
	useEffect(() => {
		let cancelled = false;
		bindSession(null);
		setEntries([]);
		setRunning(false);
		setAttached(false);
		const saved = localStorage.getItem(threadKey);
		if (!saved) {
			setAttached(true);
			return;
		}
		void (async () => {
			try {
				const response = await client.request<{ sessionId: string; messages: Record<string, unknown>[] }>({
					type: "session.resume",
					sessionId: saved,
					approvalMode: "confirm",
				});
				if (cancelled) return;
				if (response.ok && response.result) {
					bindSession(response.result.sessionId);
					setEntries(rebuild(response.result.messages ?? []));
				} else {
					localStorage.removeItem(threadKey);
				}
			} catch {
				if (!cancelled) localStorage.removeItem(threadKey);
			}
			if (!cancelled) setAttached(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [client, threadKey]);

	// -- 事件订阅：只消费本线程的事件 -----------------------------------------
	useEffect(() => {
		return client.onSessionEvent((message) => {
			if (message.sessionId !== sessionIdRef.current) return;
			const event = message.event as { type?: string };
			setEntries((current) => applyEvent(current, message));
			if (event.type === "agent_settled") setRunning(false);
		});
	}, [client]);

	const ensureSession = async (): Promise<string | undefined> => {
		const current = sessionIdRef.current;
		if (current) return current;
		const response = await client.request<{ sessionId: string }>({
			type: "session.create",
			cwd,
			approvalMode: "confirm",
		});
		if (!response.ok || !response.result) return undefined;
		bindSession(response.result.sessionId);
		localStorage.setItem(threadKey, response.result.sessionId);
		return response.result.sessionId;
	};

	const send = (text: string): void => {
		const question = text.trim();
		if (question === "" || running || !attached) return;
		setEntries((current) => [...current, { kind: "user", text: question }]);
		setRunning(true);
		void (async () => {
			const target = await ensureSession();
			if (!target) {
				setRunning(false);
				return;
			}
			const prompt = artifactPromptFor(product, question);
			try {
				await client.request({
					type: "session.prompt",
					sessionId: target,
					message: prompt.message,
					...(prompt.attachedPaths !== undefined ? { attachedPaths: prompt.attachedPaths } : {}),
				});
			} catch {
				setRunning(false);
			}
		})();
	};

	const reset = (): void => {
		bindSession(null);
		localStorage.removeItem(threadKey);
		setEntries([]);
		setRunning(false);
		setAttached(true);
	};

	return { entries, running, attached, sessionId, send, reset };
}
