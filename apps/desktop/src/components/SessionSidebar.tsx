import { useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";

type SessionRow = { id?: string; name?: string; cwd?: string; timestamp?: string; [key: string]: unknown };

export function SessionSidebar({
	client,
	activeId,
	onNewChat,
}: {
	client: BridgeClient;
	activeId: string | undefined;
	onNewChat: () => void;
}): React.JSX.Element {
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	const refresh = async (): Promise<void> => {
		const response = await client.request<SessionRow[]>({ type: "session.list" });
		if (response.ok) setSessions(response.result ?? []);
	};
	useEffect(() => {
		if (client) void refresh();
	}, [client]); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<aside className="flex w-64 flex-col border-r border-neutral-800 bg-neutral-900/40">
			<button
				type="button"
				className="m-3 rounded bg-sky-900 px-3 py-2 text-sm hover:bg-sky-800"
				onClick={onNewChat}
			>
				＋ 新会话
			</button>
			<div className="flex-1 overflow-y-auto px-2 pb-3">
				<p className="px-2 py-1 text-xs text-neutral-600">历史会话（JSONL）</p>
				{sessions.map((session, index) => (
					<div
						key={session.id ?? index}
						className={`rounded px-2 py-1.5 text-xs ${
							session.id === activeId ? "bg-neutral-800 text-neutral-200" : "text-neutral-500"
						}`}
						title={String(session.cwd ?? "")}
					>
						<div className="truncate">{session.id ?? `session-${index}`}</div>
						<div className="truncate text-neutral-600">{String(session.timestamp ?? "").slice(0, 19)}</div>
					</div>
				))}
				{sessions.length === 0 && <p className="px-2 py-2 text-xs text-neutral-700">暂无</p>}
			</div>
		</aside>
	);
}
