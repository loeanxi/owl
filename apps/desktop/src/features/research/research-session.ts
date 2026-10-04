import type { BridgeClient } from "../../bridge/client.ts";
import type { ApprovalMode, DesktopClientRequestWithoutId, ResearchMode, ResearchResult, ServerEventMessage, SessionRunningResult, SessionSnapshotPayload, SessionStatsResult } from "../../bridge/protocol.ts";
import { applyEvent, applyRetryEvent, rebuild, type ChatEntry, type RetryBannerState } from "../../hooks/transcript.ts";
import { normPath, samePath } from "../../utils/paths.ts";
import { t } from "../../i18n/index.ts";
import { mergeResearchResults, publishedResults, researchResultsFromEvent } from "./research-results.ts";
import { researchText } from "./research-copy.ts";

type ResearchImage = { type: "image"; data: string; mimeType: string };
type ResearchBridge = Pick<BridgeClient, "request" | "onSessionEvent">;
type ResearchStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ResearchPreferences = { model: string; thinkingLevel: string; approvalMode: ApprovalMode; mode: ResearchMode };
export type ResearchSessionState = ResearchPreferences & {
	sessionId?: string;
	entries: ChatEntry[];
	results: ResearchResult[];
	running: boolean;
	busy: boolean;
	ready: boolean;
	connected: boolean;
	stats?: SessionStatsResult;
	error?: string;
	retryStatus: RetryBannerState | null;
	failedPrompt?: { text: string; images?: ResearchImage[] };
};

export function researchSessionKey(cwd: string): string {
	return `owl.research.session.${normPath(cwd)}`;
}

/** Completed messages before the resume response are already in its atomic snapshot. */
export function eventsAfterSnapshot(snapshot: SessionSnapshotPayload, events: ServerEventMessage[]): ServerEventMessage[] {
	const messages = new Set(snapshot.messages.map((message) => JSON.stringify(message)));
	const entryIds = new Set(snapshot.messageEntryIds ?? []);
	let covered = -1;
	for (const [index, message] of events.entries()) {
		const event = message.event as { type?: string; message?: unknown; entry?: { id?: string } };
		if ((event.type === "message_end" && messages.has(JSON.stringify(event.message))) ||
			(event.type === "entry_appended" && typeof event.entry?.id === "string" && entryIds.has(event.entry.id))) covered = index;
	}
	return events.slice(covered + 1);
}

/** Owns one project's research thread and rejects stale asynchronous responses. */
export class ResearchSessionController {
	private state: ResearchSessionState;
	private listeners = new Set<() => void>();
	private client: ResearchBridge;
	private storage: ResearchStorage;
	private cwd: string;
	private offEvents?: () => void;
	private disposed = false;
	private epoch = 0;
	private attachPromise?: Promise<void>;
	private restoring = false;
	private replayEvents: ServerEventMessage[] = [];
	private runRevision = 0;
	private settingsRevision = 0;
	private reconcileTimer?: ReturnType<typeof setTimeout>;

	constructor(client: ResearchBridge, storage: ResearchStorage, cwd: string, defaults: ResearchPreferences) {
		this.client = client;
		this.storage = storage;
		this.cwd = cwd;
		let preferences = defaults;
		try {
			const saved: unknown = JSON.parse(storage.getItem(`${researchSessionKey(cwd)}.preferences`) ?? "null");
			if (saved && typeof saved === "object") {
				const value = saved as Record<string, unknown>;
				preferences = {
					model: typeof value.model === "string" ? value.model : defaults.model,
					thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : defaults.thinkingLevel,
					approvalMode: ["confirm", "plan", "auto"].includes(String(value.approvalMode)) ? value.approvalMode as ApprovalMode : defaults.approvalMode,
					mode: ["auto", "crawl", "web", "binary", "model", "osint"].includes(String(value.mode)) ? value.mode as ResearchMode : "auto",
				};
			}
		} catch { /* Storage can be unavailable in restricted webviews. */ }
		this.state = { ...preferences, entries: [], results: [], running: false, busy: false, ready: false, connected: false, retryStatus: null };
	}

	getSnapshot = (): ResearchSessionState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	start(): void {
		this.disposed = false;
		this.offEvents = this.client.onSessionEvent((message) => {
			if (this.disposed || message.sessionId !== this.state.sessionId) return;
			if (this.restoring) this.replayEvents.push(message);
			this.consume(message);
		});
	}

	dispose(): void {
		this.disposed = true;
		this.epoch++;
		this.offEvents?.();
		this.offEvents = undefined;
		this.attachPromise = undefined;
		this.restoring = false;
		this.replayEvents = [];
		clearTimeout(this.reconcileTimer);
	}

	private update(patch: Partial<ResearchSessionState>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}

	private persistPreferences(): void {
		const { model, thinkingLevel, approvalMode, mode } = this.state;
		try { this.storage.setItem(`${researchSessionKey(this.cwd)}.preferences`, JSON.stringify({ model, thinkingLevel, approvalMode, mode })); } catch { /* In-memory use remains available. */ }
	}

	setConnected(connected: boolean): void {
		if (this.state.connected === connected) return;
		if (!connected) {
			this.epoch++;
			this.attachPromise = undefined;
			this.restoring = false;
			this.replayEvents = [];
			clearTimeout(this.reconcileTimer);
			this.update({ connected, busy: false, ready: false });
		} else this.update({ connected });
	}

	private consume(message: ServerEventMessage): void {
		const type = (message.event as { type?: string }).type;
		const patch: Partial<ResearchSessionState> = {
			entries: applyEvent(this.state.entries, message),
			results: mergeResearchResults(this.state.results, researchResultsFromEvent(message.event)),
			retryStatus: applyRetryEvent(this.state.retryStatus, message),
		};
		if (type === "agent_start" || type === "agent_settled") {
			this.runRevision++;
			patch.running = type === "agent_start";
			if (type === "agent_settled") {
				patch.busy = false;
				void this.refreshStats();
			}
		}
		this.update(patch);
	}

	private isCurrent(epoch: number, sessionId?: string): boolean {
		return !this.disposed && epoch === this.epoch && (sessionId === undefined || sessionId === this.state.sessionId);
	}

	private async reconcileRunning(epoch = this.epoch): Promise<void> {
		const sessionId = this.state.sessionId;
		const revision = this.runRevision;
		const response = await this.client.request<SessionRunningResult>({ type: "session.running" });
		if (!response.ok || !this.isCurrent(epoch, sessionId) || revision !== this.runRevision) return;
		this.update({ running: sessionId !== undefined && (response.result?.running.includes(sessionId) ?? false) });
	}

	async attach(): Promise<void> {
		if (this.disposed || !this.state.connected || this.state.ready) return;
		if (this.attachPromise) return this.attachPromise;
		const promise = this.restore();
		this.attachPromise = promise;
		try { await promise; } finally { if (this.attachPromise === promise) this.attachPromise = undefined; }
	}

	private async restore(): Promise<void> {
		const epoch = this.epoch;
		let saved = this.state.sessionId;
		try { saved ??= this.storage.getItem(researchSessionKey(this.cwd)) ?? undefined; } catch { /* Fresh in-memory thread. */ }
		if (!saved) {
			this.update({ ready: true, error: undefined });
			return;
		}
		this.restoring = true;
		this.replayEvents = [];
		this.update({ sessionId: saved, busy: true, error: undefined });
		try {
			const response = await this.client.request<SessionSnapshotPayload>({ type: "session.resume", sessionId: saved });
			if (!this.isCurrent(epoch, saved)) return;
			if (!response.ok || !response.result) throw new Error(response.error ?? researchText("restoreFailed"));
			const snapshot = response.result;
			if (snapshot.sessionId !== saved || !samePath(snapshot.cwd, this.cwd) || !snapshot.researchMode || !Array.isArray(snapshot.messages)) throw new Error(researchText("wrongWorkspace"));
			let entries = rebuild(snapshot.messages as Record<string, unknown>[], snapshot.messageEntryIds);
			let results = publishedResults(snapshot.messages);
			for (const message of eventsAfterSnapshot(snapshot, this.replayEvents)) {
				entries = applyEvent(entries, message);
				results = mergeResearchResults(results, researchResultsFromEvent(message.event));
			}
			this.update({ entries, results, mode: snapshot.researchMode, ...(snapshot.approvalMode ? { approvalMode: snapshot.approvalMode } : {}), ready: true });
			this.persistPreferences();
			await this.reconcileRunning(epoch);
			await this.refreshStats();
		} catch (error) {
			if (this.isCurrent(epoch, saved)) this.update({ error: error instanceof Error ? error.message : String(error), ready: false });
		} finally {
			if (this.isCurrent(epoch, saved)) {
				this.restoring = false;
				this.replayEvents = [];
				this.update({ busy: false });
			}
		}
	}

	async refreshStats(): Promise<void> {
		const sessionId = this.state.sessionId;
		const epoch = this.epoch;
		const settingsRevision = this.settingsRevision;
		if (!sessionId || !this.state.connected) return;
		try {
			const response = await this.client.request<SessionStatsResult>({ type: "session.stats", sessionId });
			if (response.ok && response.result && this.isCurrent(epoch, sessionId) && settingsRevision === this.settingsRevision) this.applyStats(response.result);
		} catch { /* A reconnect refreshes authoritative state. */ }
	}

	private applyStats(stats: SessionStatsResult): void {
		this.update({ stats, ...(stats.model ? { model: `${stats.model.provider}/${stats.model.id}` } : {}), thinkingLevel: stats.thinkingLevel });
		this.persistPreferences();
	}

	async send(text: string, images?: ResearchImage[]): Promise<boolean> {
		if (!this.state.connected || !this.state.ready || this.state.running || this.state.busy || (!text.trim() && !images?.length)) return false;
		const epoch = this.epoch;
		let optimisticEntry: Extract<ChatEntry, { kind: "user" }> | undefined;
		let submittedRunRevision = this.runRevision;
		this.update({ busy: true, error: undefined, failedPrompt: undefined });
		try {
			let sessionId = this.state.sessionId;
			if (!sessionId) {
				const slash = this.state.model.indexOf("/");
				const response = await this.client.request<SessionSnapshotPayload>({
					type: "session.create", cwd: this.cwd, approvalMode: this.state.approvalMode, thinkingLevel: this.state.thinkingLevel, researchMode: this.state.mode,
					...(slash > 0 ? { provider: this.state.model.slice(0, slash), model: this.state.model.slice(slash + 1) } : {}),
				});
				if (!this.isCurrent(epoch)) return false;
				if (!response.ok || !response.result?.sessionId) throw new Error(response.error ?? researchText("createFailed"));
				sessionId = response.result.sessionId;
				this.update({ sessionId });
				try { this.storage.setItem(researchSessionKey(this.cwd), sessionId); } catch { /* In-memory binding is sufficient for the current run. */ }
				void this.refreshStats();
			}
			optimisticEntry = { kind: "user", text, ...(images?.length ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}) };
			submittedRunRevision = this.runRevision;
			this.update({ entries: [...this.state.entries, optimisticEntry], running: true, retryStatus: null });
			const response = await this.client.request({ type: "session.prompt", sessionId, message: text, researchMode: this.state.mode, ...(images?.length ? { images } : {}) });
			if (!this.isCurrent(epoch, sessionId)) return false;
			if (!response.ok) throw new Error(response.error ?? researchText("sendFailed"));
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = setTimeout(() => { void this.reconcileRunning(epoch).catch(() => {}); }, 2000);
			return true;
		} catch (error) {
			if (this.isCurrent(epoch)) this.update({
				error: error instanceof Error ? error.message : String(error), running: false, failedPrompt: { text, images },
				...(this.runRevision === submittedRunRevision && optimisticEntry ? { entries: this.state.entries.filter((entry) => entry !== optimisticEntry) } : {}),
			});
			return false;
		} finally {
			if (this.isCurrent(epoch)) this.update({ busy: false });
		}
	}

	async abort(): Promise<void> {
		if (!this.state.sessionId || !this.state.connected) return;
		const epoch = this.epoch;
		try {
			const response = await this.client.request({ type: "session.abort", sessionId: this.state.sessionId });
			if (!this.isCurrent(epoch)) return;
			if (!response.ok) throw new Error(response.error ?? researchText("stopFailed"));
			await this.reconcileRunning(epoch);
		} catch (error) {
			if (this.isCurrent(epoch)) this.update({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	newThread(): boolean {
		if (this.state.running || this.state.busy || !this.state.connected) return false;
		this.epoch++;
		clearTimeout(this.reconcileTimer);
		try { this.storage.removeItem(researchSessionKey(this.cwd)); } catch { /* Reset in-memory state even when storage is unavailable. */ }
		this.update({ sessionId: undefined, entries: [], results: [], running: false, stats: undefined, error: undefined, ready: true, retryStatus: null, failedPrompt: undefined });
		return true;
	}

	async resume(sessionId: string): Promise<void> {
		if (sessionId === this.state.sessionId && this.state.ready) return;
		this.epoch++;
		clearTimeout(this.reconcileTimer);
		this.attachPromise = undefined;
		this.restoring = false;
		this.replayEvents = [];
		try { this.storage.setItem(researchSessionKey(this.cwd), sessionId); } catch { /* The requested thread remains available in memory. */ }
		this.update({ sessionId, entries: [], results: [], stats: undefined, ready: false, busy: false, running: false, error: undefined, retryStatus: null, failedPrompt: undefined });
		await this.attach();
	}

	dismissRetry(): void { this.update({ retryStatus: null }); }

	async executeBuiltin(name: string, args: string): Promise<boolean> {
		if (!["new", "model", "thinking", "compact"].includes(name)) return false;
		if (this.state.running || this.state.busy || !this.state.ready || !this.state.connected) return true;
		if (name === "new") this.newThread();
		else if (name === "model") {
			if (args.trim().includes("/")) await this.setModel(args.trim());
			else this.update({ error: t("app.modelUsage") });
		} else if (name === "thinking") {
			if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(args.trim())) await this.setThinkingLevel(args.trim());
			else this.update({ error: t("app.thinkingUsage") });
		} else if (this.state.sessionId) {
			await this.setting({ type: "session.compact", sessionId: this.state.sessionId }, {});
		}
		return true;
	}

	setMode(mode: ResearchMode): void {
		if (this.state.running || this.state.busy) return;
		this.update({ mode });
		this.persistPreferences();
	}

	private async setting(request: DesktopClientRequestWithoutId, patch: Partial<ResearchPreferences>): Promise<void> {
		if (!this.state.connected || !this.state.ready || this.state.busy || this.state.running) return;
		const epoch = this.epoch;
		this.settingsRevision++;
		this.update({ busy: true, error: undefined });
		try {
			const response = await this.client.request<SessionStatsResult>(request);
			if (!this.isCurrent(epoch)) return;
			if (!response.ok) throw new Error(response.error ?? researchText("settingsFailed"));
			this.update(patch);
			if (response.result?.availableThinkingLevels) this.applyStats(response.result);
			this.persistPreferences();
		} catch (error) {
			if (this.isCurrent(epoch)) this.update({ error: error instanceof Error ? error.message : String(error) });
		} finally { if (this.isCurrent(epoch)) this.update({ busy: false }); }
	}

	async setModel(model: string): Promise<void> {
		if (this.state.running || this.state.busy) return;
		if (!this.state.sessionId) { this.update({ model }); this.persistPreferences(); return; }
		const slash = model.indexOf("/");
		if (slash <= 0) return;
		await this.setting({ type: "session.setModel", sessionId: this.state.sessionId, provider: model.slice(0, slash), model: model.slice(slash + 1) }, { model });
	}

	async setThinkingLevel(thinkingLevel: string): Promise<void> {
		if (this.state.running || this.state.busy) return;
		if (!this.state.sessionId) { this.update({ thinkingLevel }); this.persistPreferences(); return; }
		await this.setting({ type: "session.setThinkingLevel", sessionId: this.state.sessionId, level: thinkingLevel }, { thinkingLevel });
	}

	async setApprovalMode(approvalMode: ApprovalMode): Promise<void> {
		if (this.state.running || this.state.busy) return;
		if (!this.state.sessionId) { this.update({ approvalMode }); this.persistPreferences(); return; }
		await this.setting({ type: "session.setApprovalMode", sessionId: this.state.sessionId, approvalMode }, { approvalMode });
	}
}
