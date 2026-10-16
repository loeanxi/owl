import { createContext, useContext, useSyncExternalStore } from "react";
import { t } from "../i18n/index.ts";

export interface PendingResponseFeedback {
	phase: "pending" | "error";
	error?: string;
}

export interface QuestionDraft {
	states: Array<{ picked: Set<string>; custom: string; customOpen: boolean; note: string; noteOpen: boolean; previewOpen: Set<string> }>;
	current: number;
	missing: Set<number>;
	collapsed: boolean;
}

interface ResponseAction {
	requestId: string;
	sessionId: string;
	respond: () => Promise<{ ok: boolean; error?: string }>;
	confirmed: () => void;
}

/** Keep the request mounted until its acknowledgement or an authoritative terminal event. */
export class PendingResponses {
	private state: ReadonlyMap<string, PendingResponseFeedback> = new Map();
	private readonly listeners = new Set<() => void>();
	private readonly actions = new Map<string, ResponseAction>();
	private readonly pending = new Map<string, object>();
	private readonly terminal = new Set<string>();
	private active = true;
	readonly questionDrafts = new Map<string, QuestionDraft>();
	saveQuestionDraft(id: string, draft: QuestionDraft): void { if (this.active && !this.terminal.has(id)) this.questionDrafts.set(id, draft); }
	getSnapshot = (): ReadonlyMap<string, PendingResponseFeedback> => this.state;
	subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

	private publish(id: string, feedback?: PendingResponseFeedback): void {
		const next = new Map(this.state);
		if (feedback) next.set(id, feedback); else next.delete(id);
		this.state = next;
		for (const notify of this.listeners) notify();
	}

	async submit(action: ResponseAction): Promise<boolean> {
		const id = action.requestId;
		if (!this.active || this.pending.has(id) || this.terminal.has(id)) return false;
		const attempt = {};
		this.actions.set(id, action);
		this.pending.set(id, attempt);
		this.publish(id, { phase: "pending" });
		try {
			const response = await action.respond();
			if (!this.active || this.terminal.has(id) || this.actions.get(id) !== action) return false;
			if (!response.ok) throw new Error(response.error || t("app.unknownError"));
			this.retire(id);
			action.confirmed();
			return true;
		} catch (error) {
			if (this.active && !this.terminal.has(id) && this.actions.get(id) === action) {
				this.publish(id, { phase: "error", error: error instanceof Error ? error.message : String(error) });
			}
			return false;
		} finally { if (this.pending.get(id) === attempt) this.pending.delete(id); }
	}

	retry = (id: string): void => { const action = this.actions.get(id); if (action) void this.submit(action); };
	activate(): void { this.active = true; }
	retire(id: string): void {
		this.terminal.add(id);
		if (this.terminal.size > 512) { const oldest = this.terminal.values().next().value; if (oldest !== undefined) this.terminal.delete(oldest); }
		this.actions.delete(id);
		this.questionDrafts.delete(id);
		this.publish(id);
	}
	retireSession(sessionId: string, requestIds: readonly string[] = []): void {
		for (const id of requestIds) this.retire(id);
		for (const action of this.actions.values()) if (action.sessionId === sessionId) this.retire(action.requestId);
	}
	invalidate(): void {
		this.active = false;
		this.actions.clear();
		this.pending.clear();
		this.terminal.clear();
		this.questionDrafts.clear();
		this.state = new Map();
		for (const notify of this.listeners) notify();
	}
}

export const PendingResponsesContext = createContext<PendingResponses | undefined>(undefined);
const empty = new Map<string, PendingResponseFeedback>();
const subscribeEmpty = (): (() => void) => () => {};
const readEmpty = (): ReadonlyMap<string, PendingResponseFeedback> => empty;

export function usePendingResponses(): { controller: PendingResponses | undefined; feedback: ReadonlyMap<string, PendingResponseFeedback> } {
	const controller = useContext(PendingResponsesContext);
	const feedback = useSyncExternalStore(controller?.subscribe ?? subscribeEmpty, controller?.getSnapshot ?? readEmpty);
	return { controller, feedback };
}
