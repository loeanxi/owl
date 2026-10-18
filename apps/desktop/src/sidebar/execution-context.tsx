import { createContext } from "react";
import type { DesktopSubagentSummary } from "../bridge/protocol.ts";
import type { ChatEntry } from "../hooks/transcript.ts";

export interface ExecutionContextValue {
	sessionId?: string;
	profile?: string;
	entries: readonly ChatEntry[];
	subagents: readonly DesktopSubagentSummary[];
	onOpenSubagent: (id: string) => void;
	onRefreshSubagents: () => void;
	onOpenSession?: (id: string) => void;
	onSubmitFeedback?: (text: string) => Promise<boolean>;
}

export const ExecutionContext = createContext<ExecutionContextValue>({
	entries: [],
	subagents: [],
	onOpenSubagent: () => {},
	onRefreshSubagents: () => {},
});
