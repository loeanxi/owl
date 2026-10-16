import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionPromptSuggestionResult } from "../bridge/protocol.ts";

const PREFERENCE_KEY = "owl.composer.predictions.enabled";
const PREFERENCE_EVENT = "owl:composer-predictions-setting";
const dismissed = new Set<string>();
let generationSequence = 0;

interface Options {
	client: BridgeClient;
	connected: boolean;
	sessionId?: string;
	profile?: string;
	ownerRevision?: string | number;
	cwd: string;
	model: string;
	running: boolean;
	paused: boolean;
	disabled: boolean;
	eligible: boolean;
	isCurrent?: () => boolean;
}

interface Pending {
	client: BridgeClient;
	sessionId: string;
	generationId: string;
	finished: boolean;
}

function preference(): boolean {
	try { return localStorage.getItem(PREFERENCE_KEY) !== "false"; } catch { return true; }
}

function remember(set: Set<string>, key: string): void {
	set.add(key);
	while (set.size > 256) {
		const oldest = set.values().next().value;
		if (oldest === undefined) break;
		set.delete(oldest);
	}
}

/** Predictions are hints only: accepting never submits, and user edits always win late responses. */
export function usePromptSuggestion(options: Options): {
	suggestion?: string;
	accept: () => string | undefined;
	dismiss: () => void;
	enabled: boolean;
	setEnabled: (value: boolean) => void;
} {
	const [enabled, updateEnabled] = useState(preference);
	const [revision, setRevision] = useState(0);
	const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
	const [view, setView] = useState<{ key: string; result: SessionPromptSuggestionResult }>();
	const pending = useRef<Pending | undefined>(undefined);
	const attempted = useRef(new Set<string>());
	const runActive = useRef(false);
	const connection = useRef({ client: options.client, revision: 0 });
	if (connection.current.client !== options.client) connection.current = { client: options.client, revision: connection.current.revision + 1 };
	const owner = JSON.stringify([connection.current.revision, options.profile, options.sessionId, options.cwd, options.ownerRevision, options.model]);
	const basisOwner = JSON.stringify([options.profile, options.sessionId]);
	const key = JSON.stringify([owner, revision]);
	const latest = useRef({ options, enabled, owner });
	latest.current = { options, enabled, owner };
	const canUse = enabled && documentVisible && options.connected && Boolean(options.sessionId) && Boolean(options.profile)
		&& !options.running && !options.paused && !options.disabled && options.eligible;

	const cancelPending = useCallback((): void => {
		const request = pending.current;
		if (!request || request.finished) return;
		request.finished = true;
		if (pending.current === request) pending.current = undefined;
		void request.client.request({ type: "session.promptSuggestion.cancel", sessionId: request.sessionId, generationId: request.generationId }).catch(() => {});
	}, []);

	useEffect(() => {
		const update = (event?: Event): void => {
			const value = (event as CustomEvent<{ enabled?: boolean }> | undefined)?.detail?.enabled;
			updateEnabled(typeof value === "boolean" ? value : preference());
			setRevision((current) => current + 1);
		};
		const onStorage = (event: StorageEvent): void => { if (event.key === PREFERENCE_KEY || event.key === null) update(); };
		window.addEventListener(PREFERENCE_EVENT, update);
		window.addEventListener("storage", onStorage);
		const visibility = (): void => {
			setDocumentVisible(document.visibilityState !== "hidden");
			if (document.visibilityState === "hidden") cancelPending();
		};
		document.addEventListener("visibilitychange", visibility);
		return () => {
			window.removeEventListener(PREFERENCE_EVENT, update);
			window.removeEventListener("storage", onStorage);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [cancelPending]);

	useEffect(() => {
		runActive.current = options.running;
		// Small component fixtures may omit event subscriptions; production BridgeClient always supplies it.
		return options.client.onSessionEvent?.((message) => {
			if (message.sessionId !== options.sessionId) return;
			const event = message.event as { type?: string; entry?: { message?: { role?: string } } };
			if (event.type === "agent_start" || (event.type === "entry_appended" && event.entry?.message?.role === "user")) {
				runActive.current = true;
				cancelPending();
				setView(undefined);
			} else if (event.type === "agent_settled") {
				runActive.current = false;
				setRevision((value) => value + 1);
			}
		});
	}, [options.client, options.running, owner, cancelPending]);

	useEffect(() => {
		if (!canUse || runActive.current || attempted.current.has(key)) return;
		let cancelled = false;
		let request: Pending | undefined;
		const timer = setTimeout(() => {
			const current = latest.current;
			if (cancelled || attempted.current.has(key) || current.owner !== owner || !current.enabled || !current.options.eligible || current.options.running
				|| current.options.disabled || !current.options.connected || current.options.paused || runActive.current
				|| document.visibilityState === "hidden" || current.options.isCurrent?.() === false) return;
			remember(attempted.current, key);
			request = { client: options.client, sessionId: options.sessionId!, generationId: `prediction-${Date.now()}-${++generationSequence}`, finished: false };
			pending.current = request;
			const active = request;
			void active.client.request<SessionPromptSuggestionResult>({ type: "session.promptSuggestion", sessionId: active.sessionId, generationId: active.generationId }).then((response) => {
				const now = latest.current;
				if (cancelled || active.finished || now.owner !== owner || now.options.client !== active.client || !now.enabled
					|| !now.options.eligible || !now.options.connected || now.options.disabled || now.options.running || now.options.paused
					|| runActive.current || document.visibilityState === "hidden" || now.options.isCurrent?.() === false) return;
				const result = response.ok ? response.result : undefined;
				if (typeof result?.basisEntryId !== "string" || !result.basisEntryId || typeof result.suggestion !== "string" || !result.suggestion.trim()) return;
				if (!dismissed.has(JSON.stringify([basisOwner, result.basisEntryId]))) setView({ key, result: { basisEntryId: result.basisEntryId, suggestion: result.suggestion.trim() } });
			}).catch(() => {}).finally(() => {
				active.finished = true;
				if (pending.current === active) pending.current = undefined;
			});
		}, 700);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			if (request && pending.current === request) cancelPending();
		};
	}, [options.client, options.sessionId, canUse, key, owner, basisOwner, cancelPending]);

	const result = view?.key === key ? view.result : undefined;
	const suggestion = canUse && !runActive.current && options.isCurrent?.() !== false && result?.basisEntryId
		&& !dismissed.has(JSON.stringify([basisOwner, result.basisEntryId])) ? result.suggestion : undefined;
	const dismiss = (): void => {
		if (result?.basisEntryId) remember(dismissed, JSON.stringify([basisOwner, result.basisEntryId]));
		remember(attempted.current, key);
		cancelPending();
		setView(undefined);
	};
	return {
		suggestion,
		accept: () => {
			const now = latest.current;
			if (!suggestion || now.owner !== owner || !now.enabled || !now.options.eligible || !now.options.connected
				|| now.options.disabled || now.options.running || now.options.paused || now.options.isCurrent?.() === false) return undefined;
			dismiss();
			return suggestion;
		},
		dismiss,
		enabled,
		setEnabled: (value) => {
			try { localStorage.setItem(PREFERENCE_KEY, String(value)); } catch { /* This window still updates if storage is unavailable. */ }
			updateEnabled(value);
			if (!value) cancelPending();
			window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: { enabled: value } }));
		},
	};
}
