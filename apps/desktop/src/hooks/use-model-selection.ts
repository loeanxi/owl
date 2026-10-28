import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionStatsResult } from "../bridge/protocol.ts";
import { modelSelectionText } from "../components/model-selection-copy.ts";

export interface ModelSelectionFeedback {
	status: "pending" | "confirmed" | "selected" | "error";
	target: string;
	actual: string;
	running: boolean;
	error?: string;
}

interface Options {
	client: BridgeClient;
	sessionId?: string;
	profile?: string;
	viewRevision?: number;
	/** Optional synchronous owner check for navigation that precedes React's next render. */
	isCurrent?: () => boolean;
	cwd: string;
	connected: boolean;
	running: boolean;
	model: string;
	stats?: SessionStatsResult;
	onStart: () => void;
	onApplied: (model: string, stats?: SessionStatsResult) => void;
}

interface SelectionScope {
	client: BridgeClient;
	owner: string;
	connected: boolean;
	active: boolean;
	processing: boolean;
	actual: string;
	stats?: SessionStatsResult;
	observedModel: string;
	observedStats?: SessionStatsResult;
	isCurrent?: () => boolean;
	inFlightTarget?: string;
	next?: { target: string; running: boolean };
}

/** Serialize host mutations and coalesce subsequent selections to the user's latest choice. */
export function useModelSelection(options: Options): {
	feedback?: ModelSelectionFeedback;
	select: (model: string) => void;
	retry: () => void;
	isPending: () => boolean;
} {
	const latest = useRef(options);
	latest.current = options;
	const mounted = useRef(true);
	const scopeRef = useRef<SelectionScope | undefined>(undefined);
	const [view, setView] = useState<{ scope?: SelectionScope; feedback?: ModelSelectionFeedback }>({});
	const owner = JSON.stringify([options.profile, options.cwd, options.sessionId, options.viewRevision]);
	let scope = scopeRef.current;
	if (
		!scope ||
		!scope.active ||
		scope.client !== options.client ||
		scope.owner !== owner ||
		scope.connected !== options.connected
	) {
		if (scope) scope.active = false;
		scope = {
			client: options.client,
			owner,
			connected: options.connected,
			active: true,
			processing: false,
			actual: options.model,
			stats: options.stats,
			observedModel: options.model,
			observedStats: options.stats,
			isCurrent: options.isCurrent,
		};
		scopeRef.current = scope;
	} else if (!scope.processing && (scope.observedModel !== options.model || scope.observedStats !== options.stats)) {
		scope.actual = options.model;
		scope.stats = options.stats;
		scope.observedModel = options.model;
		scope.observedStats = options.stats;
	}
	const active = (source: SelectionScope): boolean =>
		mounted.current && source.active && scopeRef.current === source && (source.isCurrent?.() ?? true);
	useEffect(() => {
		mounted.current = true;
		const off = options.client.onStatus((connected) => {
			if (connected || scopeRef.current?.client !== options.client) return;
			scopeRef.current.active = false;
			setView({});
		});
		return () => {
			mounted.current = false;
			off();
		};
	}, [options.client]);

	const select = (target: string): void => {
		const source = scopeRef.current!;
		if (!active(source)) return;
		const config = latest.current;
		const running = config.running;
		const slash = target.indexOf("/");
		if (slash <= 0 || slash === target.length - 1) {
			setView({
				scope: source,
				feedback: { status: "error", target, actual: source.actual, running, error: modelSelectionText("invalid") },
			});
			return;
		}
		if (!config.sessionId) {
			config.onApplied(target);
			source.actual = target;
			setView({ scope: source, feedback: { status: "selected", target, actual: target, running: false } });
			return;
		}
		if (!config.connected || !source.active) {
			setView({
				scope: source,
				feedback: { status: "error", target, actual: source.actual, running, error: modelSelectionText("offline") },
			});
			return;
		}
		if (source.processing && (source.next?.target ?? source.inFlightTarget) === target) return;
		config.onStart();
		source.next = { target, running };
		setView({ scope: source, feedback: { status: "pending", target, actual: source.actual, running } });
		if (source.processing) return;
		source.processing = true;
		const sessionId = config.sessionId;
		void (async () => {
			try {
				while (active(source) && source.next) {
					const choice = source.next;
					source.next = undefined;
					source.inFlightTarget = choice.target;
					try {
						const separator = choice.target.indexOf("/");
						const response = await source.client.request<SessionStatsResult>({
							type: "session.setModel",
							sessionId,
							provider: choice.target.slice(0, separator),
							model: choice.target.slice(separator + 1),
						});
						if (!active(source)) return;
						if (response.result?.model) {
							source.actual = `${response.result.model.provider}/${response.result.model.id}`;
							source.stats = response.result;
						}
						if (!response.ok) throw new Error(response.error ?? modelSelectionText("failed"));
						if (!response.result?.model) throw new Error(modelSelectionText("unconfirmed"));
						if (source.next) continue;
						latest.current.onApplied(source.actual, source.stats);
						setView({
							scope: source,
							feedback: {
								status: "confirmed",
								target: choice.target,
								actual: source.actual,
								running: choice.running,
							},
						});
					} catch (error) {
						if (!active(source)) return;
						if (source.next) continue;
						// A prior coalesced choice may have reached the host before the latest failed.
						if (source.actual !== latest.current.model && source.stats)
							latest.current.onApplied(source.actual, source.stats);
						setView({
							scope: source,
							feedback: {
								status: "error",
								target: choice.target,
								actual: source.actual,
								running: choice.running,
								error: error instanceof Error ? error.message : String(error),
							},
						});
					}
				}
			} finally {
				source.processing = false;
				source.inFlightTarget = undefined;
			}
		})();
	};
	const candidate = view.scope === scope ? view.feedback : undefined;
	const feedback =
		candidate?.status === "confirmed" && candidate.actual !== scope.actual
			? undefined
			: candidate
				? { ...candidate, actual: scope.actual }
				: undefined;
	return {
		feedback,
		select,
		retry: () => {
			if (feedback?.status === "error") select(feedback.target);
		},
		isPending: () => scopeRef.current?.processing === true,
	};
}
