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
import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ServerEventMessage } from "../../bridge/protocol.ts";
import { applyEvent, rebuild, type ChatEntry } from "../../hooks/transcript.ts";
import { renderMarkdown, InlineSummary } from "../../components/ChatStream.tsx";
import { IconChatDiscussion } from "../quick.tsx";
import { IconLoader, IconRefresh, IconX } from "../icons.tsx";
import { normProjectKey } from "../store.ts";

function sideChatKey(cwd: string): string {
	return `owl.sidechat.${normProjectKey(cwd)}`;
}

export function SideChatTab({ client, cwd }: { client: BridgeClient; cwd: string }): React.JSX.Element {
	const [entries, setEntries] = useState<ChatEntry[]>([]);
	const [running, setRunning] = useState(false);
	const [draft, setDraft] = useState("");
	const [attached, setAttached] = useState(false); // 已绑定（或决定不绑定）会话，输入框可用
	const sessionIdRef = useRef<string | null>(null);
	const scroller = useRef<HTMLDivElement>(null);

	// -- 会话绑定：挂载 / 项目切换时重挂 --------------------------------------
	// silent：恢复失败（历史被删等）不留错误，退回全新线程即可
	useEffect(() => {
		let cancelled = false;
		sessionIdRef.current = null;
		setEntries([]);
		setRunning(false);
		setAttached(false);
		const saved = localStorage.getItem(sideChatKey(cwd));
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
					sessionIdRef.current = response.result.sessionId;
					setEntries(rebuild(response.result.messages ?? []));
				} else {
					localStorage.removeItem(sideChatKey(cwd));
				}
			} catch {
				if (!cancelled) localStorage.removeItem(sideChatKey(cwd));
			}
			if (!cancelled) setAttached(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [client, cwd]);

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
		sessionIdRef.current = response.result.sessionId;
		localStorage.setItem(sideChatKey(cwd), response.result.sessionId);
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
		sessionIdRef.current = null;
		localStorage.removeItem(sideChatKey(cwd));
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

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* 头：标识 + 新线程 */}
			<div className="flex shrink-0 select-none items-center gap-2 border-b border-owl-border/40 px-3 py-2 text-xs">
				<IconChatDiscussion size={13} className="text-[#549bf5]" />
				<span className="font-medium text-owl-text">侧边对话</span>
				<span className="rounded-full border border-owl-border px-1.5 py-px text-[10px] text-owl-faint">beta</span>
				<span className="ml-auto text-owl-faint">独立小线程 · 不进主对话</span>
				<button
					type="button"
					title="开一条新线程"
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
						顺手问一句、贴段代码、让它先想想——
						<br />
						这里的小线程不会出现在主对话里。
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
						思考中…
					</div>
				)}
			</div>

			{/* 输入行 */}
			<div className="flex shrink-0 items-end gap-2 border-t border-owl-border/40 px-2.5 py-2">
				<textarea
					className="max-h-24 min-h-[34px] flex-1 resize-none rounded-lg border border-owl-border/50 bg-owl-panel px-2.5 py-1.5 text-xs text-owl-text outline-none placeholder:text-owl-faint focus:border-owl-accent/60"
					placeholder={attached ? "问点小的…（Enter 发送）" : "正在恢复线程…"}
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
						title="中止"
						aria-label="中止"
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
						title="发送"
						aria-label="发送"
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
