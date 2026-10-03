import { useEffect, useRef, useState } from "react";
import type {
	MailAccount,
	MailAgentContext,
	MailAgentStartResult,
	MailDraft,
	MailThreadRef,
} from "../../../../../packages/coding-agent/src/core/mail/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import type { SessionRunningResult } from "../../bridge/protocol.ts";
import { applyEvent } from "../../hooks/transcript.ts";
import type { ChatEntry } from "../../hooks/transcript.ts";
import { t } from "../../i18n/index.ts";
import { mailReadSource, mailThreadKey, sameMailContext } from "./mail-model.ts";

export interface MailSource extends MailThreadRef {
	subject: string;
}
export interface MailScopeDetails {
	accounts: Pick<MailAccount, "id" | "email" | "label">[];
	sources: MailSource[];
	excluded: string[];
}
export interface MailConversation extends MailScopeDetails {
	id: string;
	context: MailAgentContext;
	entries: ChatEntry[];
	running: boolean;
	draft?: MailDraft;
	pendingDraft?: MailDraft;
	draftDirty: boolean;
	sentDraft?: MailDraft;
	readSources: MailSource[];
	error?: string;
}

export function useMailAgent(
	client: BridgeClient,
	connected: boolean,
	cwd: string,
	model?: { provider: string; model: string },
	thinkingLevel?: string,
) {
	const [sessions, setSessions] = useState<MailConversation[]>([]);
	const sessionsRef = useRef<MailConversation[]>([]);
	const [activeId, setActiveId] = useState<string>();
	const activeRef = useRef<string | undefined>(undefined);
	const [submitting, setSubmitting] = useState(false);
	const lock = useRef(false);
	const mounted = useRef(true);
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

	function update(id: string, change: (session: MailConversation) => MailConversation): void {
		const next = sessionsRef.current.map((session) => (session.id === id ? change(session) : session));
		sessionsRef.current = next;
		if (mounted.current) setSessions(next);
	}

	function select(id: string): void {
		activeRef.current = id;
		setActiveId(id);
	}

	useEffect(() => {
		mounted.current = true;
		const events = client.onSessionEvent((message) => {
			if (!sessionsRef.current.some((session) => session.id === message.sessionId)) return;
			const event = message.event as { type?: string; messages?: unknown[] };
			update(message.sessionId, (session) => {
				const reads = [message.event, ...(event.type === "agent_end" ? event.messages ?? [] : [])]
					.map((entry) => mailReadSource(entry, session.context)).filter((entry) => entry !== undefined);
				const sources = new Map(session.sources.map((source) => [mailThreadKey(source), source]));
				const readSources = new Map(session.readSources.map((source) => [mailThreadKey(source), source]));
				for (const source of reads) { sources.set(mailThreadKey(source), source); readSources.set(mailThreadKey(source), source); }
				return {
					...session,
					sources: [...sources.values()],
					readSources: [...readSources.values()],
					entries: applyEvent(session.entries, message),
					running: event.type === "agent_start" ? true : event.type === "agent_end" || event.type === "agent_settled" ? false : session.running,
				};
			});
		});
		const drafts = client.onMailDraft((message) => {
			update(message.sessionId, (session) => {
				if (!session.context.accountIds.includes(message.draft.accountId)) return session;
				if (
					session.context.mode === "threads" &&
					!session.context.threads?.some(
						(source) =>
							source.accountId === message.draft.accountId && source.threadId === message.draft.threadId,
					)
				)
					return session;
				return session.draftDirty
					? { ...session, pendingDraft: message.draft }
					: { ...session, draft: message.draft };
			});
		});
		return () => {
			mounted.current = false;
			events();
			drafts();
			for (const timer of timers.current) clearTimeout(timer);
			timers.current.clear();
		};
	}, [client]);

	useEffect(() => {
		if (!connected) {
			for (const session of sessionsRef.current)
				if (session.running) update(session.id, (entry) => ({ ...entry, running: false }));
			return;
		}
		if (sessionsRef.current.length === 0) return;
		void client
			.request<SessionRunningResult>({ type: "session.running" })
			.then((result) => {
				if (!result.ok || !result.result) return;
				for (const session of sessionsRef.current)
					update(session.id, (entry) => ({ ...entry, running: result.result!.running.includes(entry.id) }));
			})
			.catch(() => {});
	}, [client, connected]);

	async function create(context: MailAgentContext, details: MailScopeDetails): Promise<MailConversation> {
		const response = await client.request<MailAgentStartResult>({
			type: "mail.agent.start",
			context,
			...(cwd ? { cwd } : {}),
			...model,
			...(thinkingLevel ? { thinkingLevel } : {}),
		});
		if (!response.ok || !response.result) throw new Error(response.error ?? t("mail.agentFailed"));
		const session: MailConversation = {
			...details,
			id: response.result.sessionId,
			context: response.result.context,
			entries: [],
			running: false,
			draftDirty: false,
			readSources: [],
		};
		sessionsRef.current = [...sessionsRef.current, session];
		if (mounted.current) setSessions(sessionsRef.current);
		select(session.id);
		return session;
	}

	async function start(context: MailAgentContext, details: MailScopeDetails): Promise<void> {
		if (lock.current || !connected) return;
		lock.current = true;
		setSubmitting(true);
		try {
			await create(context, details);
		} finally {
			lock.current = false;
			if (mounted.current) setSubmitting(false);
		}
	}

	async function ask(prompt: string, context?: MailAgentContext, details?: MailScopeDetails): Promise<void> {
		if (lock.current || !connected || !prompt.trim()) return;
		let session = sessionsRef.current.find((entry) => entry.id === activeRef.current);
		if (session?.running) return;
		lock.current = true;
		setSubmitting(true);
		try {
			if (!session || (context && !sameMailContext(session.context, context))) {
				if (!context || !details) throw new Error(t("mail.chooseMail"));
				session = await create(context, details);
			}
			const id = session.id;
			update(id, (entry) => ({
				...entry,
				entries: [...entry.entries, { kind: "user", text: prompt }],
				running: true,
				error: undefined,
			}));
			const result = await client.request({ type: "session.prompt", sessionId: id, message: prompt });
			if (!result.ok) throw new Error(result.error ?? t("mail.agentFailed"));
			// A command can finish without agent_start/agent_end. Reconcile against the service.
			const timer = setTimeout(() => {
				timers.current.delete(timer);
				void client
					.request<SessionRunningResult>({ type: "session.running" })
					.then((state) => {
						if (state.ok && state.result && !state.result.running.includes(id))
							update(id, (entry) => ({ ...entry, running: false }));
					})
					.catch(() => {});
			}, 2000);
			timers.current.add(timer);
		} catch (error) {
			if (session)
				update(session.id, (entry) => ({
					...entry,
					running: false,
					error: error instanceof Error ? error.message : String(error),
				}));
			throw error;
		} finally {
			lock.current = false;
			if (mounted.current) setSubmitting(false);
		}
	}

	async function stop(): Promise<void> {
		const id = activeRef.current;
		if (!id) return;
		const result = await client.request({ type: "session.abort", sessionId: id });
		if (!result.ok) throw new Error(result.error ?? t("mail.error"));
		update(id, (session) => ({ ...session, running: false }));
	}

	function editDraft(field: "to" | "cc" | "bcc" | "subject" | "body", value: string): void {
		const id = activeRef.current;
		if (id)
			update(id, (session) =>
				session.draft ? { ...session, draft: { ...session.draft, [field]: value }, draftDirty: true } : session,
			);
	}

	function adoptDraft(): void {
		const id = activeRef.current;
		if (id)
			update(id, (session) =>
				session.pendingDraft
					? { ...session, draft: session.pendingDraft, pendingDraft: undefined, draftDirty: false }
					: session,
			);
	}

	function markSaved(id: string, draft: MailDraft, submitted: MailDraft): void {
		// Preserve edits made while the save request was in flight.
		update(id, (session) => (session.draft === submitted ? { ...session, draft, draftDirty: false } : session));
	}
	function markSent(id: string, draft: MailDraft): void {
		update(id, (session) => ({ ...session, sentDraft: draft }));
	}

	return {
		sessions,
		active: sessions.find((entry) => entry.id === activeId),
		submitting,
		select,
		start,
		ask,
		stop,
		editDraft,
		adoptDraft,
		markSaved,
		markSent,
	};
}
