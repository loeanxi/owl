import type { BridgeClient } from "../../bridge/client.ts";
import { isResearchDiagnosis, RESEARCH_DIAGNOSIS_ENTRY } from "../../../../../packages/coding-agent/src/core/research/diagnosis.ts";
import { isResearchTaskRecord, RESEARCH_TASK_ENTRY, type ResearchTaskRecord } from "../../../../../packages/coding-agent/src/core/research/task-state.ts";
import { SessionWatch } from "../../bridge/session-watch.ts";
import type { ApprovalMode, DesktopClientRequestWithoutId, ResearchDiagnosis, ResearchResult, ServerEventMessage, SessionRunningResult, SessionSnapshotPayload, SessionStatsResult } from "../../bridge/protocol.ts";
import { applyEvent, applyRetryEvent, rebuild, type ChatEntry, type RetryBannerState } from "../../hooks/transcript.ts";
import { continueTask } from "../../hooks/task-recovery.ts";
import { normPath, samePath } from "../../utils/paths.ts";
import { t } from "../../i18n/index.ts";
import { mergeResearchResults, publishedResults, researchResultsFromEvent } from "./research-results.ts";
import { researchText } from "./research-copy.ts";

type ResearchImage = { type: "image"; data: string; mimeType: string };
type ResearchBridge = Pick<BridgeClient, "request" | "onSessionEvent"> & Partial<Pick<BridgeClient, "watchSessionEvents">>;
type ResearchStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ResearchPreferences = { model: string; thinkingLevel: string; approvalMode: ApprovalMode; agentPreset?: string };
export type ResearchSessionState = ResearchPreferences & {
	sessionId?: string;
	sessionPreset?: string;
	entries: ChatEntry[];
	results: ResearchResult[];
	diagnosis?: ResearchDiagnosis;
	task?: ResearchTaskRecord;
	running: boolean;
	paused: boolean;
	queue: { steering: string[]; followUp: string[] };
	busy: boolean;
	ready: boolean;
	connected: boolean;
	stats?: SessionStatsResult;
	error?: string;
	retryStatus: RetryBannerState | null;
	failedPrompt?: { text: string; images?: ResearchImage[]; attachedPaths?: string[]; delivery?: "queue" | "steer" };
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

function researchDiagnosisFromEvent(event: unknown, sessionId: string | undefined): ResearchDiagnosis | undefined {
	if (!event || typeof event !== "object") return undefined;
	const payload = event as { type?: string; entry?: { type?: string; customType?: string; data?: unknown } };
	const entry = payload.entry;
	if (!sessionId || payload.type !== "entry_appended" || entry?.type !== "custom" || entry.customType !== RESEARCH_DIAGNOSIS_ENTRY) return undefined;
	return isResearchDiagnosis(entry.data, sessionId) ? entry.data : undefined;
}

function researchTaskFromEvent(event: unknown, sessionId: string | undefined): ResearchTaskRecord | undefined {
	if (!event || typeof event !== "object") return undefined;
	const payload = event as { type?: string; entry?: { type?: string; customType?: string; data?: unknown } };
	const entry = payload.entry;
	if (!sessionId || payload.type !== "entry_appended" || entry?.type !== "custom" || entry.customType !== RESEARCH_TASK_ENTRY) return undefined;
	return isResearchTaskRecord(entry.data, sessionId) ? entry.data : undefined;
}

function newerResearchTask(current: ResearchTaskRecord | undefined, next: ResearchTaskRecord): ResearchTaskRecord {
	return current?.taskId === next.taskId && current.revision > next.revision ? current : next;
}

/** Owns one project's research thread and rejects stale asynchronous responses. */
export class ResearchSessionController {
	private state: ResearchSessionState;
	private listeners = new Set<() => void>();
	private client: ResearchBridge;
	private storage: ResearchStorage;
	private cwd: string;
	private offEvents?: () => void;
	private readonly sessionWatch: SessionWatch;
	private disposed = false;
	private epoch = 0;
	private attachPromise?: Promise<void>;
	private restoring = false;
	private replayEvents: ServerEventMessage[] = [];
	private runRevision = 0;
	private settingsRevision = 0;
	private submissionEpoch?: number;
	private defaultAgentPreset?: string;
	private disabledPresetIds = new Set(["pi"]);
	private reconcileTimer?: ReturnType<typeof setTimeout>;

	constructor(client: ResearchBridge, storage: ResearchStorage, cwd: string, defaults: ResearchPreferences) {
		this.client = client;
		this.sessionWatch = new SessionWatch(client);
		this.storage = storage;
		this.cwd = cwd;
		this.defaultAgentPreset = defaults.agentPreset;
		let preferences: ResearchPreferences = { model: defaults.model, thinkingLevel: defaults.thinkingLevel, approvalMode: defaults.approvalMode };
		try {
			const saved: unknown = JSON.parse(storage.getItem(`${researchSessionKey(cwd)}.preferences`) ?? "null");
			if (saved && typeof saved === "object") {
				const value = saved as Record<string, unknown>;
				preferences = {
					model: typeof value.model === "string" ? value.model : defaults.model,
					thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : defaults.thinkingLevel,
					approvalMode: ["confirm", "plan", "auto"].includes(String(value.approvalMode)) ? value.approvalMode as ApprovalMode : defaults.approvalMode,
					...(typeof value.agentPreset === "string" && value.agentPreset ? { agentPreset: value.agentPreset } : {}),
				};
			}
		} catch { /* Storage can be unavailable in restricted webviews. */ }
		this.state = { ...preferences, entries: [], results: [], running: false, paused: false, queue: { steering: [], followUp: [] }, busy: false, ready: false, connected: false, retryStatus: null };
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
		this.sessionWatch.dispose();
		this.attachPromise = undefined;
		this.restoring = false;
		this.replayEvents = [];
		clearTimeout(this.reconcileTimer);
	}

	private update(patch: Partial<ResearchSessionState>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		this.sessionWatch.set(this.state.sessionId);
		for (const listener of this.listeners) listener();
	}

	private persistPreferences(): void {
		const { model, thinkingLevel, approvalMode, agentPreset } = this.state;
		try { this.storage.setItem(`${researchSessionKey(this.cwd)}.preferences`, JSON.stringify({ model, thinkingLevel, approvalMode, agentPreset })); } catch { /* In-memory use remains available. */ }
	}

	setDefaultAgentPreset(agentPreset: string, disabledPresetIds: readonly string[] = []): void {
		this.disabledPresetIds = new Set(["pi", ...disabledPresetIds]);
		this.defaultAgentPreset = this.disabledPresetIds.has(agentPreset) ? "standard" : agentPreset;
		if (this.state.agentPreset && this.disabledPresetIds.has(this.state.agentPreset)) {
			this.update({ agentPreset: undefined });
			this.persistPreferences();
		}
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
		const diagnosis = researchDiagnosisFromEvent(message.event, this.state.sessionId);
		if (diagnosis) patch.diagnosis = diagnosis;
		const task = researchTaskFromEvent(message.event, this.state.sessionId);
		if (task) patch.task = newerResearchTask(this.state.task, task);
		if (type === "queue_update") {
			const queue = message.event as { steering?: string[]; followUp?: string[] };
			patch.queue = { steering: [...(queue.steering ?? [])], followUp: [...(queue.followUp ?? [])] };
		}
		if (type === "agent_start" || type === "agent_settled") {
			this.runRevision++;
			patch.running = type === "agent_start";
			if (type === "agent_start") { patch.diagnosis = undefined; patch.paused = false; }
			if (type === "agent_settled") {
				patch.busy = this.submissionEpoch === this.epoch;
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
			let diagnosis = isResearchDiagnosis(snapshot.researchDiagnosis, saved) ? snapshot.researchDiagnosis : undefined;
			let task = isResearchTaskRecord(snapshot.researchTask, saved) ? snapshot.researchTask : undefined;
			for (const message of eventsAfterSnapshot(snapshot, this.replayEvents)) {
				entries = applyEvent(entries, message);
				results = mergeResearchResults(results, researchResultsFromEvent(message.event));
				diagnosis = (message.event as { type?: string })?.type === "agent_start" ? undefined : researchDiagnosisFromEvent(message.event, saved) ?? diagnosis;
				const updatedTask = researchTaskFromEvent(message.event, saved);
				if (updatedTask) task = newerResearchTask(task, updatedTask);
			}
			this.update({ entries, results, diagnosis, task, sessionPreset: snapshot.agentPreset ?? "standard", ...(snapshot.approvalMode ? { approvalMode: snapshot.approvalMode } : {}), ready: true });
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
		this.update({ stats, ...(stats.queue ? { queue: stats.queue } : {}), ...(stats.model ? { model: `${stats.model.provider}/${stats.model.id}` } : {}), thinkingLevel: stats.thinkingLevel });
		this.persistPreferences();
	}

	async send(text: string, images?: ResearchImage[], attachedPaths?: string[], delivery?: "queue" | "steer"): Promise<boolean> {
		if (!this.state.connected || !this.state.ready || this.state.busy || this.submissionEpoch === this.epoch || (!text.trim() && !images?.length && !attachedPaths?.length)) return false;
		const epoch = this.epoch;
		this.submissionEpoch = epoch;
		const queueing = this.state.running;
		const wasPaused = this.state.paused;
		let optimisticEntry: Extract<ChatEntry, { kind: "user" }> | undefined;
		let submittedRunRevision = this.runRevision;
		this.update({ busy: true, error: undefined, failedPrompt: undefined });
		try {
			let sessionId = this.state.sessionId;
			if (!sessionId) {
				const slash = this.state.model.indexOf("/");
				const selectedPreset = this.state.agentPreset ?? this.defaultAgentPreset;
				const agentPreset = selectedPreset && this.disabledPresetIds.has(selectedPreset) ? "standard" : selectedPreset;
				const response = await this.client.request<SessionSnapshotPayload>({
					type: "session.create", cwd: this.cwd, approvalMode: this.state.approvalMode, thinkingLevel: this.state.thinkingLevel, researchMode: "auto",
					...(slash > 0 ? { provider: this.state.model.slice(0, slash), model: this.state.model.slice(slash + 1) } : {}),
					...(agentPreset ? { agentPreset } : {}),
				});
				if (!this.isCurrent(epoch)) return false;
				if (!response.ok || !response.result?.sessionId) throw new Error(response.error ?? researchText("createFailed"));
				sessionId = response.result.sessionId;
				this.update({ sessionId, sessionPreset: response.result.agentPreset ?? "standard" });
				try { this.storage.setItem(researchSessionKey(this.cwd), sessionId); } catch { /* In-memory binding is sufficient for the current run. */ }
				void this.refreshStats();
			}
			if (!queueing) optimisticEntry = {
				kind: "user", text,
				...(images?.length ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
				...(attachedPaths?.length ? { attachedPaths: [...attachedPaths] } : {}),
			};
			submittedRunRevision = this.runRevision;
			this.update({ ...(optimisticEntry ? { entries: [...this.state.entries, optimisticEntry], diagnosis: undefined, task: undefined, running: true } : {}), paused: false, retryStatus: null });
			const response = await this.client.request({
				type: "session.prompt",
				sessionId,
				message: text,
				...(!queueing ? { researchMode: "auto" as const } : {}),
				...(queueing ? { streamingBehavior: delivery === "steer" ? "steer" as const : "followUp" as const } : {}),
				...(images?.length ? { images } : {}),
				...(attachedPaths?.length ? { attachedPaths } : {}),
			});
			if (!this.isCurrent(epoch, sessionId)) return false;
			if (!response.ok) throw new Error(response.error ?? researchText("sendFailed"));
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = setTimeout(() => { void this.reconcileRunning(epoch).catch(() => {}); }, 2000);
			return true;
		} catch (error) {
			if (this.isCurrent(epoch)) this.update({
				error: error instanceof Error ? error.message : String(error), ...(!queueing && this.runRevision === submittedRunRevision ? { running: false, paused: wasPaused } : {}), failedPrompt: { text, images, attachedPaths, ...(delivery ? { delivery } : {}) },
				...(this.runRevision === submittedRunRevision && optimisticEntry ? { entries: this.state.entries.filter((entry) => entry !== optimisticEntry) } : {}),
			});
			return false;
		} finally {
			if (this.submissionEpoch === epoch) this.submissionEpoch = undefined;
			if (this.isCurrent(epoch)) this.update({ busy: false });
		}
	}

	async abort(): Promise<boolean> {
		if (!this.state.sessionId || !this.state.connected) return false;
		const epoch = this.epoch;
		try {
			const response = await this.client.request({ type: "session.abort", sessionId: this.state.sessionId });
			if (!this.isCurrent(epoch)) return false;
			if (!response.ok) throw new Error(response.error ?? researchText("stopFailed"));
			await this.reconcileRunning(epoch);
			return true;
		} catch (error) {
			if (this.isCurrent(epoch)) this.update({ error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	async pause(): Promise<void> {
		if (!this.state.running || !this.state.connected) return;
		const epoch = this.epoch;
		this.update({ paused: true });
		if (!(await this.abort()) && this.isCurrent(epoch)) this.update({ paused: false });
	}

	async continue(model?: string): Promise<boolean> {
		const sessionId = this.state.sessionId;
		if (!sessionId || !this.state.connected || !this.state.ready || this.state.running || this.state.busy || this.submissionEpoch === this.epoch) return false;
		const epoch = this.epoch;
		this.submissionEpoch = epoch;
		const paused = this.state.paused;
		const runRevision = this.runRevision;
		this.settingsRevision++;
		this.update({ busy: true, running: true, paused: false, error: undefined, retryStatus: null, failedPrompt: undefined });
		try {
			await continueTask(this.client, sessionId, model, (stats, selectedModel) => {
				if (!this.isCurrent(epoch, sessionId)) return;
				this.settingsRevision++;
				if (stats) this.applyStats(stats);
				else { this.update({ model: selectedModel }); this.persistPreferences(); }
			});
			if (!this.isCurrent(epoch, sessionId)) return false;
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = setTimeout(() => { void this.reconcileRunning(epoch).catch(() => {}); }, 2000);
			return true;
		} catch (error) {
			if (this.isCurrent(epoch, sessionId)) this.update({ error: error instanceof Error ? error.message : String(error), ...(this.runRevision === runRevision ? { running: false, paused } : {}) });
			return false;
		} finally {
			if (this.submissionEpoch === epoch) this.submissionEpoch = undefined;
			if (this.isCurrent(epoch, sessionId)) this.update({ busy: false });
		}
	}

	async changeQueue(lane: "steering" | "followUp", index: number, promote = false): Promise<void> {
		const sessionId = this.state.sessionId;
		if (!sessionId || !this.state.connected) return;
		const epoch = this.epoch;
		try {
			const response = await this.client.request(promote ? { type: "session.queue.promote", sessionId, index } : { type: "session.queue.remove", sessionId, lane, index });
			if (!response.ok) throw new Error(response.error ?? researchText("sendFailed"));
			if (this.isCurrent(epoch, sessionId)) await this.refreshStats();
		} catch (error) {
			if (this.isCurrent(epoch, sessionId)) this.update({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** 任务运行中也允许新开对话：旧会话在后台继续跑，侧栏可切回（resume）续看。 */
	newThread(): boolean {
		if (!this.state.connected) return false;
		this.epoch++;
		clearTimeout(this.reconcileTimer);
		try { this.storage.removeItem(researchSessionKey(this.cwd)); } catch { /* Reset in-memory state even when storage is unavailable. */ }
		this.update({ sessionId: undefined, sessionPreset: undefined, entries: [], results: [], diagnosis: undefined, task: undefined, running: false, paused: false, queue: { steering: [], followUp: [] }, busy: false, stats: undefined, error: undefined, ready: true, retryStatus: null, failedPrompt: undefined });
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
		this.update({ sessionId, sessionPreset: undefined, entries: [], results: [], diagnosis: undefined, task: undefined, stats: undefined, ready: false, busy: false, running: false, paused: false, queue: { steering: [], followUp: [] }, error: undefined, retryStatus: null, failedPrompt: undefined });
		await this.attach();
	}

	dismissRetry(): void { this.update({ retryStatus: null }); }

	async executeBuiltin(name: string, args: string): Promise<boolean> {
		if (!["new", "model", "thinking", "compact"].includes(name)) return false;
		if (name === "new") { if (this.state.connected) this.newThread(); return true; }
		if (this.state.running || this.state.busy || !this.state.ready || !this.state.connected) return true;
		if (name === "model") {
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

	async setAgentPreset(agentPreset: string): Promise<void> {
		if (!agentPreset || !this.state.connected || !this.state.ready || this.state.busy) return;
		if (this.disabledPresetIds.has(agentPreset)) { this.update({ error: researchText("piPresetUnavailable") }); return; }
		const sessionId = this.state.sessionId;
		if (!sessionId || this.state.entries.length > 0) {
			this.update({ agentPreset });
			this.persistPreferences();
			return;
		}
		if (this.state.running) return;
		const epoch = this.epoch;
		this.settingsRevision++;
		this.update({ busy: true, error: undefined });
		try {
			const response = await this.client.request<{ agentPreset: string }>({ type: "session.setPreset", sessionId, agentPreset });
			if (!this.isCurrent(epoch, sessionId)) return;
			if (!response.ok) throw new Error(response.error ?? researchText("settingsFailed"));
			this.update({ agentPreset, sessionPreset: response.result?.agentPreset ?? agentPreset });
			this.persistPreferences();
		} catch (error) {
			if (this.isCurrent(epoch, sessionId)) this.update({ error: error instanceof Error ? error.message : String(error) });
		} finally { if (this.isCurrent(epoch, sessionId)) this.update({ busy: false }); }
	}
}
