/**
 * 侧边对话 tab（beta）—— 对应 dsh-better-sidebar 的 SideChatView：一条独立的
 * 轻量会话线程，与主对话并行，不污染主转录。owl 桥的会话是按 sessionId 挂载
 * 的（serve.ts 的 sessions 表），事件广播也带 sessionId，所以这里自建会话、
 * 自己过滤事件即可，桥无需改动。
 *
 * 绑定按项目持久化（owl.sidechat.<projectKey> → sessionId），重开应用后
 * session.resume 静默回放；权限确认走 App 的全局对话框（按 requestId 响应，
 * 与会话无关）。
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { t, useT } from "../../i18n/index.ts";
import { SessionWatch } from "../../bridge/session-watch.ts";
import type { ServerEventMessage } from "../../bridge/protocol.ts";
import { applyEvent, rebuild, type ChatEntry } from "../../hooks/transcript.ts";
import { renderMarkdown, InlineSummary } from "../../components/ChatStream.tsx";
import { ExecutionContext } from "../execution-context.tsx";
import { IconChatDiscussion } from "../quick.tsx";
import { IconLoader, IconRefresh, IconX } from "../icons.tsx";
import { normProjectKey } from "../store.ts";
import type { TabComponentProps } from "../registry.ts";

/**
 * 侧聊线程的绑定键：按「项目 + 宿主会话」存。
 * 侧聊是这次对话的支线线程：换个对话就该换一条线程，否则会话 B 里会看到会话 A
 * 的支线（连「带回主对话」都会把别的会话的问答带过来）。
 */
function sideChatKey(cwd: string, sessionId: string | undefined): string {
	return `owl.sidechat.${normProjectKey(cwd)}${sessionId ? `.${sessionId}` : ""}`;
}

export function SideChatTab({ client, cwd, onToChat }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const execution = useContext(ExecutionContext);
	// 侧聊归属的宿主会话：主对话换了，侧聊就换一条线程。
	const ownerSessionId = execution.sessionId;
	const [entries, setEntries] = useState<ChatEntry[]>([]);
	const [running, setRunning] = useState(false);
	const [draft, setDraft] = useState("");
	const [attached, setAttached] = useState(false); // 已绑定（或决定不绑定）会话，输入框可用
	const sessionIdRef = useRef<string | null>(null);
	const watchRef = useRef<SessionWatch | null>(null);
	if (!watchRef.current) watchRef.current = new SessionWatch(client);
	const bindSession = (id: string | null): void => {
		sessionIdRef.current = id;
		watchRef.current?.set(id);
	};
	useEffect(() => () => watchRef.current?.dispose(), []);
	const scroller = useRef<HTMLDivElement>(null);

	// -- 会话绑定：挂载 / 项目切换时重挂 --------------------------------------
	// silent：恢复失败（历史被删等）不留错误，退回全新线程即可
	useEffect(() => {
		let cancelled = false;
		bindSession(null);
		setEntries([]);
		setRunning(false);
		setAttached(false);
		const saved = localStorage.getItem(sideChatKey(cwd, ownerSessionId));
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
					localStorage.removeItem(sideChatKey(cwd, ownerSessionId));
				}
			} catch {
				if (!cancelled) localStorage.removeItem(sideChatKey(cwd, ownerSessionId));
			}
			if (!cancelled) setAttached(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [client, cwd, ownerSessionId]);

	// -- 事件订阅：只消费本线程的事件（app 层会过滤旁路会话，主转录不受影响） --
	useEffect(() => {
		return client.onSessionEvent((message: ServerEventMessage) => {
			if (message.sessionId !== sessionIdRef.current) return;
			const event = message.event as { type?: string };
			setEntries((current) => applyEvent(current, message));
			if (event.type === "agent_settled") setRunning(false);
		});
	}, [client]);

	// -- 贴底跟随（与 ChatStream 同规则） ------------------------------------
	const stick = useRef(true);
	useEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [entries]);

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
		localStorage.setItem(sideChatKey(cwd, ownerSessionId), response.result.sessionId);
		return response.result.sessionId;
	};

	const send = async (): Promise<void> => {
		const text = draft.trim();
		if (!text || running || !attached) return;
		setDraft("");
		const target = await ensureSession();
		if (!target) return;
		setEntries((current) => [...current, { kind: "user", text }]);
		setRunning(true);
		try {
			await client.request({ type: "session.prompt", sessionId: target, message: text });
		} catch {
			setRunning(false);
		}
	};

	const newThread = (): void => {
		bindSession(null);
		localStorage.removeItem(sideChatKey(cwd, ownerSessionId));
		setEntries([]);
		setRunning(false);
		setAttached(true);
	};

	const lastAssistant = useMemo(() => {
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry.kind === "assistant") return entry;
			if (entry.kind === "user") return undefined;
		}
		return undefined;
	}, [entries]);

	/** 最近这一问一答（带回主对话用）：先找最后一条回答，再往前找对应的问题。 */
	const lastExchange = useMemo(() => {
		let answer = "";
		let question = "";
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry.kind === "assistant" && answer === "") {
				answer = entry.text ?? "";
				continue;
			}
			if (entry.kind === "user" && answer !== "") {
				question = entry.text;
				break;
			}
		}
		return { question, answer };
	}, [entries]);

	/** 把这条小线程的问答放进主对话，接着在主对话里做。 */
	const sendToMainChat = (): void => {
		if (onToChat === undefined || lastExchange.answer.trim() === "") return;
		const parts = [t("sidechat.backToChatPrompt")];
		if (lastExchange.question.trim() !== "") parts.push(`问：${lastExchange.question.trim()}`);
		parts.push(`答：${lastExchange.answer.trim()}`);
		onToChat(parts.join("\n\n"));
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* 头：标识 + 新线程 */}
			<div className="flex shrink-0 select-none items-center gap-2 border-b border-owl-border/40 px-3 py-2 text-xs">
				<IconChatDiscussion size={13} className="text-[#549bf5]" />
				<span className="font-medium text-owl-text">{t("sidechat.title")}</span>
				<span className="rounded-full border border-owl-border px-1.5 py-px text-[10px] text-owl-faint">beta</span>
				<span className="ml-auto text-owl-faint">{t("sidechat.caption")}</span>
				{onToChat !== undefined && (
					<button
						type="button"
						title={t("sidechat.backToChatTitle")}
						aria-label={t("sidechat.backToChat")}
						disabled={lastExchange.answer.trim() === ""}
						className="rounded border border-owl-border/60 px-1.5 py-0.5 text-[10px] text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text disabled:cursor-not-allowed disabled:opacity-40"
						onClick={sendToMainChat}
					>
						{t("sidechat.backToChat")}
					</button>
				)}
				<button
					type="button"
					title={t("sidechat.newThreadTitle")}
					className="rounded p-1 text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text"
					onClick={newThread}
				>
					<IconRefresh size={12} />
				</button>
			</div>

			{/* 转录 */}
			<div
				ref={scroller}
				onWheel={(e) => {
					if (e.deltaY < 0) stick.current = false;
				}}
				onScroll={() => {
					const el = scroller.current;
					if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
				}}
				className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3"
			>
				{entries.length === 0 && (
					<p className="mt-6 text-center text-xs leading-relaxed text-owl-faint">
						{t("sidechat.hook1")}
						<br />
						{t("sidechat.hook2")}
					</p>
				)}
				{entries.map((entry, index) => {
					if (entry.kind === "user") {
						return (
							<div key={index} className="flex justify-end">
								<div className="max-w-[85%] rounded-2xl rounded-br-md bg-owl-bubble px-3 py-1.5 text-xs whitespace-pre-wrap">{entry.text}</div>
							</div>
						);
					}
					if (entry.kind === "assistant") {
						return (
							<div key={index} className="max-w-[92%] space-y-1.5">
								{entry.tools.map((tool) => (
									<div key={tool.id} className="flex items-center gap-1.5 text-[10px] text-owl-faint">
										{tool.status === "running" ? (
											<IconLoader size={9} className="animate-spin text-owl-accent" />
										) : tool.status === "error" ? (
											<span className="text-red-400">✗</span>
										) : (
											<span className="text-emerald-500">✓</span>
										)}
										<span className="min-w-0 truncate">
											<InlineSummary text={tool.summary} />
										</span>
									</div>
								))}
								{entry.text && (
									<div
										className="text-xs leading-relaxed [&_code]:rounded [&_code]:bg-owl-sidebar [&_code]:px-1 [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-owl-sidebar [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-[10px]"
										dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }}
									/>
								)}
								{entry.error && <p className="text-[11px] text-red-400">{entry.error}</p>}
							</div>
						);
					}
					return (
						<div key={index} className="max-w-[92%] truncate text-[10px] text-owl-faint">
							<span className={entry.ok ? "text-emerald-500" : "text-red-400"}>{entry.ok ? "✓" : "✗"}</span>{" "}
							<span className="font-mono">{entry.toolName}</span>
						</div>
					);
				})}
				{running && lastAssistant === undefined && (
					<div className="flex items-center gap-1.5 text-[10px] text-owl-faint">
						<IconLoader size={9} className="animate-spin text-owl-accent" />
						{t("sidechat.thinking")}
					</div>
				)}
			</div>

			{/* 输入行 */}
			<div className="flex shrink-0 items-end gap-2 border-t border-owl-border/40 px-2.5 py-2">
				<textarea
					className="max-h-24 min-h-[34px] flex-1 resize-none rounded-lg border border-owl-border/50 bg-owl-panel px-2.5 py-1.5 text-xs text-owl-text outline-none placeholder:text-owl-faint focus:border-owl-accent/60"
					placeholder={attached ? t("sidechat.placeholderAttached") : t("sidechat.placeholderRestoring")}
					disabled={!attached}
					rows={1}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
				/>
				{running ? (
					<button
						type="button"
						title={t("composer.abort")}
						aria-label={t("composer.abort")}
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-owl-accent text-white transition-colors hover:bg-owl-accent-hover"
						onClick={() => {
							if (sessionIdRef.current) void client.request({ type: "session.abort", sessionId: sessionIdRef.current });
						}}
					>
						<IconX size={12} />
					</button>
				) : (
					<button
						type="button"
						title={t("composer.send")}
						aria-label={t("composer.send")}
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-owl-accent text-white transition-colors hover:bg-owl-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
						disabled={!draft.trim() || !attached}
						onClick={() => void send()}
					>
						<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5">
							<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
						</svg>
					</button>
				)}
			</div>
		</div>
	);
}
