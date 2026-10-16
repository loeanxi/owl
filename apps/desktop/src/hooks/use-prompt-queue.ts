import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { DesktopClientRequestWithoutId, SessionQueueInput, SessionQueueReturnedInput, SessionQueueReturnedSummary, SessionQueueSnapshot } from "../bridge/protocol.ts";
import { promptQueueText } from "../components/prompt-queue-copy.ts";

type Action = "preview" | "remove" | "promote" | "take" | "append" | "receipt-preview" | "forget";
export interface QueueActionFeedback { action: Action; pending: boolean; error?: string; message?: string }
interface Response { queue?: SessionQueueSnapshot; input?: SessionQueueInput; receipt?: SessionQueueReturnedInput; receipts?: SessionQueueReturnedSummary[] }
interface QueueScope { key: string; profile?: string; sessionId?: string; cwd: string; client: BridgeClient; connected: boolean; active: boolean; isCurrent?: () => boolean }
interface State {
	scope?: QueueScope;
	feedback: Record<string, QueueActionFeedback>;
	previews: Record<string, SessionQueueInput>;
	receipts: SessionQueueReturnedSummary[];
	receiptPreviews: Record<string, SessionQueueReturnedInput>;
	appended: ReadonlySet<string>;
	listError?: string;
}
interface Options {
	client: BridgeClient;
	connected: boolean;
	sessionId?: string;
	profile?: string;
	cwd: string;
	conversationScope: string;
	ownerRevision?: string | number;
	isCurrent?: () => boolean;
	queue?: SessionQueueSnapshot;
	onQueueChange?: (queue: SessionQueueSnapshot) => void;
	onAppend: (receipt: SessionQueueReturnedInput) => void;
}
const EMPTY_STATE: State = { feedback: {}, previews: {}, receipts: [], receiptPreviews: {}, appended: new Set() };

/** Queue operations use durable message identity; retrieved originals stay in the host ledger. */
export function usePromptQueue(options: Options) {
	const latest = useRef(options);
	latest.current = options;
	const mounted = useRef(true);
	const owner = JSON.stringify([options.profile, options.sessionId, options.cwd, options.conversationScope, options.ownerRevision]);
	const scopeRef = useRef<QueueScope | undefined>(undefined);
	if (!scopeRef.current || !scopeRef.current.active || scopeRef.current.key !== owner || scopeRef.current.client !== options.client || scopeRef.current.connected !== options.connected) {
		if (scopeRef.current) scopeRef.current.active = false;
		scopeRef.current = { key: owner, profile: options.profile, sessionId: options.sessionId, cwd: options.cwd, client: options.client, connected: options.connected, active: true, isCurrent: options.isCurrent };
	}
	const scope = scopeRef.current;
	const [state, setState] = useState<State>(EMPTY_STATE);
	const locks = useRef(new Map<string, object>());
	const takes = useRef(new Map<string, string>());
	const retries = useRef(new Map<string, () => void>());
	const receiptRevision = useRef(0);
	const active = (source: QueueScope): boolean => mounted.current && source.active && scopeRef.current === source && (source.isCurrent?.() ?? true);
	const update = (source: QueueScope, patch: (previous: State) => State): void => {
		if (!active(source)) return;
		setState((previous) => ({ ...patch(previous.scope === source ? previous : EMPTY_STATE), scope: source }));
	};
	const refreshReturned = async (source = scopeRef.current!): Promise<void> => {
		if (!active(source) || !source.connected || !source.profile) return;
		const revision = receiptRevision.current;
		try {
			const response = await source.client.request<Response>({ type: "session.queue.returned.list" });
			if (!response.ok) throw new Error(response.error ?? promptQueueText("returnedFailed"));
			if (revision !== receiptRevision.current) return;
			update(source, (previous) => ({ ...previous, receipts: response.result?.receipts ?? [], listError: undefined }));
		} catch (error) {
			update(source, (previous) => ({ ...previous, listError: error instanceof Error ? error.message : String(error) }));
		}
	};
	useEffect(() => {
		mounted.current = true;
		const off = typeof options.client.onStatus === "function" ? options.client.onStatus((connected) => {
			if (connected || scopeRef.current?.client !== options.client) return;
			scopeRef.current.active = false;
			setState(EMPTY_STATE);
		}) : undefined;
		return () => { mounted.current = false; off?.(); };
	}, [options.client]);
	useEffect(() => { void refreshReturned(scope); }, [scope]);
	const refreshTakeReceipt = (source: QueueScope): void => {
		const current = scopeRef.current;
		if (!current || current.profile !== source.profile || current.client !== source.client) return;
		receiptRevision.current++;
		void refreshReturned(current);
	};

	const perform = async (key: string, action: Action, request: DesktopClientRequestWithoutId, complete?: (result: Response) => void): Promise<void> => {
		const source = scopeRef.current!;
		if (!active(source)) return;
		const lockKey = `${source.key}:${key}`;
		if (locks.current.has(lockKey)) return;
		const token = {};
		locks.current.set(lockKey, token);
		retries.current.set(lockKey, () => { if (active(source)) void perform(key, action, request, complete); });
		update(source, (previous) => ({ ...previous, feedback: { ...previous.feedback, [key]: { action, pending: true } } }));
		const queueAtRequest = latest.current.queue;
		try {
			if (!source.connected) throw new Error(promptQueueText("offline"));
			if (!source.profile) throw new Error(promptQueueText("unknownProfile"));
			const response = await source.client.request<Response>(request);
			if (!active(source)) { if (action === "take") refreshTakeReceipt(source); return; }
			if (response.result?.queue && latest.current.queue === queueAtRequest) latest.current.onQueueChange?.(response.result.queue);
			if (!response.ok) throw new Error(response.error ?? promptQueueText("failed"));
			complete?.(response.result ?? {});
			update(source, (previous) => ({ ...previous, feedback: { ...previous.feedback, [key]: { action, pending: false, message: action === "remove" ? promptQueueText("cancelled") : action === "promote" ? promptQueueText("promoted") : action === "take" ? promptQueueText("taken") : action === "forget" ? promptQueueText("removedReceipt") : undefined } } }));
		} catch (error) {
			update(source, (previous) => ({ ...previous, feedback: { ...previous.feedback, [key]: { action, pending: false, error: error instanceof Error ? error.message : String(error) } } }));
			if (action === "take") refreshTakeReceipt(source);
		} finally {
			if (locks.current.get(lockKey) === token) locks.current.delete(lockKey);
		}
	};
	const sessionRequest = (messageId: string, action: "preview" | "remove" | "promote" | "take", lane: "steering" | "followUp" = "followUp"): void => {
		const source = scopeRef.current!;
		if (!source.sessionId) return;
		const { sessionId } = source;
		if (action === "preview") void perform(messageId, action, { type: "session.queue.get", sessionId, messageId }, (result) => {
			if (!result.input || result.input.messageId !== messageId) throw new Error(promptQueueText("missingPayload"));
			update(source, (previous) => ({ ...previous, previews: { ...previous.previews, [messageId]: result.input! } }));
		});
		else if (action === "take") {
			if (!source.profile) return;
			const takeKey = `${source.key}:${messageId}`;
			const operationId = takes.current.get(takeKey) ?? crypto.randomUUID();
			takes.current.set(takeKey, operationId);
			void perform(messageId, action, { type: "session.queue.take", sessionId, messageId, operationId }, (result) => {
				if (!result.receipt || result.receipt.receiptId !== operationId || result.receipt.sourceSessionId !== sessionId || result.receipt.input.messageId !== messageId) throw new Error(promptQueueText("missingPayload"));
				receiptRevision.current++;
				void refreshReturned(source);
			});
		} else if (action === "remove") void perform(messageId, action, { type: "session.queue.remove", sessionId, messageId, lane });
		else void perform(messageId, action, { type: "session.queue.promote", sessionId, messageId });
	};
	const receiptRequest = (receiptId: string, action: "append" | "receipt-preview" | "forget"): void => {
		const source = scopeRef.current!;
		if (!source.profile) return;
		if (action === "forget") void perform(receiptId, action, { type: "session.queue.returned.remove", receiptId }, (result) => {
			receiptRevision.current++;
			update(source, (previous) => ({ ...previous, receipts: result.receipts ?? previous.receipts.filter((receipt) => receipt.receiptId !== receiptId) }));
		});
		else void perform(receiptId, action, { type: "session.queue.returned.get", receiptId }, (result) => {
			if (!result.receipt || result.receipt.receiptId !== receiptId) throw new Error(promptQueueText("missingPayload"));
			if (action === "append") {
				latest.current.onAppend(result.receipt);
				update(source, (previous) => ({ ...previous, appended: new Set([...previous.appended, receiptId]) }));
			} else update(source, (previous) => ({ ...previous, receiptPreviews: { ...previous.receiptPreviews, [receiptId]: result.receipt! } }));
		});
	};
	const visible = state.scope === scope ? state : EMPTY_STATE;
	return { ...visible, ownerKey: scope.key, sessionRequest, receiptRequest, retry: (key: string) => retries.current.get(`${scope.key}:${key}`)?.(), refreshReturned: () => { void refreshReturned(); }, available: options.connected && !!options.profile && !!options.sessionId, canTake: options.connected && !!options.profile && !!options.sessionId, returnedAvailable: options.connected && !!options.profile };
}
