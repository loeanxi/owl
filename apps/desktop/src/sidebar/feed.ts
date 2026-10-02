/**
 * 会话运行 feed 的模块级外部 store：任务管理 tab 等轻消费者用 useFeed 订阅，
 * 不把 entries 挂进 Workbench 的 props 链——流式输出每个 delta 只重渲染订阅者，
 * 不牵连文件树 / 编辑器这些重组件（App 里 useEffect 同步写入）。
 */
import { useSyncExternalStore } from "react";
import type { ChatEntry } from "../hooks/transcript.ts";

export interface SessionFeed {
	running: boolean;
	entries: ChatEntry[];
}

let state: SessionFeed = { running: false, entries: [] };
const listeners = new Set<() => void>();

export function setSessionFeed(next: SessionFeed): void {
	if (next.running === state.running && next.entries === state.entries) return;
	state = next;
	for (const listener of listeners) listener();
}

export function useSessionFeed(): SessionFeed {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => state,
		() => state,
	);
}
