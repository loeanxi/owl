/**
 * 「我的助理」对话线程控制器：对齐 features/research 的 ResearchSessionController
 * ——一条按数据目录绑定持久化的独立会话（owl.myself.chat.<dirKey> → sessionId），
 * 重开应用 session.resume 静默回放；模型/思考/审批模式即时下发到本会话并记住偏好；
 * 斜杠内置命令（/new /model /thinking /compact）本地消化。
 *
 * 差异点：cwd 固定指向 owl-myself 数据目录（agent 文件工具天然围栏在内）；
 * 新线程首轮提示词自动带上当日上下文铺垫（primer）；每轮 agent_settled 回调
 * onSettled，由面板把回答落进当天 md 的「对话」段。
 */
import type { DesktopClientRequestWithoutId, ServerEventMessage, SessionRunningResult, SessionSnapshotPayload, SessionStatsResult, ApprovalMode } from "../../bridge/protocol.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import { applyEvent, applyRetryEvent, rebuild, type ChatEntry, type RetryBannerState } from "../../hooks/transcript.ts";
import { samePath } from "../../utils/paths.ts";
import { normProjectKey } from "../../sidebar/store.ts";

type MyselfImage = { type: "image"; data: string; mimeType: string };
type MyselfBridge = Pick<BridgeClient, "request" | "onSessionEvent">;
type MyselfStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type MyselfChatPreferences = { model: string; thinkingLevel: string; approvalMode: ApprovalMode };
export type MyselfChatState = MyselfChatPreferences & {
	sessionId?: string;
	entries: ChatEntry[];
	running: boolean;
	busy: boolean;
	ready: boolean;
	connected: boolean;
	stats?: SessionStatsResult;
	error?: string;
	retryStatus: RetryBannerState | null;
	failedPrompt?: { text: string; images?: MyselfImage[]; attachedPaths?: string[] };
};

export function myselfChatKey(dir: string): string {
	return `owl.myself.chat.${normProjectKey(dir)}`;
}

export class MyselfChatController {
	private state: MyselfChatState;
	private listeners = new Set<() => void>();
	private client: MyselfBridge;
	private storage: MyselfStorage;
	private cwd: string;
	private primer: () => string;
	private onSettled?: (entries: ChatEntry[]) => void;
	/** 会话绑定在 localStorage 里的键前缀：助理与专家面板共用控制器时各用各的名字空间。 */
	private keyPrefix: string;
	private offEvents?: () => void;
	private disposed = false;
	private epoch = 0;
	private attachPromise?: Promise<void>;
	private restoring = false;
	private replayEvents: ServerEventMessage[] = [];
	private runRevision = 0;
	private settingsRevision = 0;
	private reconcileTimer?: ReturnType<typeof setTimeout>;

	constructor(
		client: MyselfBridge,
		storage: MyselfStorage,
		cwd: string,
		defaults: MyselfChatPreferences,
		primer: () => string,
		opts?: { onSettled?: (entries: ChatEntry[]) => void; keyPrefix?: string },
	) {
		this.client = client;
		this.storage = storage;
		this.cwd = cwd;
		this.primer = primer;
		this.onSettled = opts?.onSettled;
		this.keyPrefix = opts?.keyPrefix ?? "owl.myself.chat";
		let preferences = defaults;
		try {
			const saved: unknown = JSON.parse(storage.getItem(`${this.chatKey()}.preferences`) ?? "null");
			if (saved && typeof saved === "object") {
				const value = saved as Record<string, unknown>;
				preferences = {
					model: typeof value.model === "string" ? value.model : defaults.model,
					thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : defaults.thinkingLevel,
					approvalMode: ["confirm", "plan", "auto"].includes(String(value.approvalMode)) ? value.approvalMode as ApprovalMode : defaults.approvalMode,
				};
			}
		} catch { /* Storage can be unavailable in restricted webviews. */ }
		this.state = { ...preferences, entries: [], running: false, busy: false, ready: false, connected: false, retryStatus: null };
	}

	getSnapshot = (): MyselfChatState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** 本线程在 localStorage 的绑定键（前缀 + 数据目录），专家/助理互不串线。 */
	private chatKey(): string {
		return `${this.keyPrefix}.${normProjectKey(this.cwd)}`;
	}

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

	private update(patch: Partial<MyselfChatState>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}

	private persistPreferences(): void {
		const { model, thinkingLevel, approvalMode } = this.state;
		try { this.storage.setItem(`${this.chatKey()}.preferences`, JSON.stringify({ model, thinkingLevel, approvalMode })); } catch { /* In-memory use remains available. */ }
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
		const patch: Partial<MyselfChatState> = {
			entries: applyEvent(this.state.entries, message),
			retryStatus: applyRetryEvent(this.state.retryStatus, message),
		};
		if (type === "agent_start" || type === "agent_settled") {
			this.runRevision++;
			patch.running = type === "agent_start";
			if (type === "agent_settled") {
				patch.busy = false;
				this.onSettled?.(patch.entries ?? this.state.entries);
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
		try { saved ??= this.storage.getItem(this.chatKey()) ?? undefined; } catch { /* Fresh in-memory thread. */ }
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
			if (!response.ok || !response.result) throw new Error(response.error ?? "restore failed");
			const snapshot = response.result;
			if (snapshot.sessionId !== saved || !samePath(snapshot.cwd, this.cwd) || !Array.isArray(snapshot.messages)) throw new Error("session cwd mismatch");
			let entries = rebuild(snapshot.messages as Record<string, unknown>[], snapshot.messageEntryIds);
			for (const message of eventsAfterSnapshot(snapshot, this.replayEvents)) entries = applyEvent(entries, message);
			this.update({ entries, ...(snapshot.approvalMode ? { approvalMode: snapshot.approvalMode } : {}), ready: true });
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

	async send(text: string, images?: MyselfImage[], attachedPaths?: string[]): Promise<boolean> {
		if (!this.state.connected || !this.state.ready || this.state.running || this.state.busy || (!text.trim() && !images?.length && !attachedPaths?.length)) return false;
		const epoch = this.epoch;
		let optimisticEntry: Extract<ChatEntry, { kind: "user" }> | undefined;
		let submittedRunRevision = this.runRevision;
		this.update({ busy: true, error: undefined, failedPrompt: undefined });
		try {
			let sessionId = this.state.sessionId;
			let prefix = "";
			if (!sessionId) {
				const slash = this.state.model.indexOf("/");
				const response = await this.client.request<SessionSnapshotPayload>({
					type: "session.create", cwd: this.cwd, approvalMode: this.state.approvalMode, thinkingLevel: this.state.thinkingLevel,
					...(slash > 0 ? { provider: this.state.model.slice(0, slash), model: this.state.model.slice(slash + 1) } : {}),
				});
				if (!this.isCurrent(epoch)) return false;
				if (!response.ok || !response.result?.sessionId) throw new Error(response.error ?? "session.create failed");
				sessionId = response.result.sessionId;
				this.update({ sessionId });
				try { this.storage.setItem(this.chatKey(), sessionId); } catch { /* In-memory binding is sufficient for the current run. */ }
				// 新线程首轮：带上角色铺垫 + 当天文件内容（之后靠会话记忆，不重复）。
				prefix = this.primer();
				void this.refreshStats();
			}
			optimisticEntry = { kind: "user", text, ...(images?.length ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}) };
			submittedRunRevision = this.runRevision;
			this.update({ entries: [...this.state.entries, optimisticEntry], running: true, retryStatus: null });
			const response = await this.client.request({
				type: "session.prompt",
				sessionId,
				message: prefix + text,
				...(images?.length ? { images } : {}),
				...(attachedPaths?.length ? { attachedPaths } : {}),
			});
			if (!this.isCurrent(epoch, sessionId)) return false;
			if (!response.ok) throw new Error(response.error ?? "send failed");
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = setTimeout(() => { void this.reconcileRunning(epoch).catch(() => {}); }, 2000);
			return true;
		} catch (error) {
			if (this.isCurrent(epoch)) this.update({
				error: error instanceof Error ? error.message : String(error), running: false, failedPrompt: { text, images, attachedPaths },
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
			if (!response.ok) throw new Error(response.error ?? "stop failed");
			await this.reconcileRunning(epoch);
		} catch (error) {
			if (this.isCurrent(epoch)) this.update({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	newThread(): boolean {
		if (this.state.running || this.state.busy || !this.state.connected) return false;
		this.epoch++;
		clearTimeout(this.reconcileTimer);
		try { this.storage.removeItem(this.chatKey()); } catch { /* Reset in-memory state even when storage is unavailable. */ }
		this.update({ sessionId: undefined, entries: [], running: false, stats: undefined, error: undefined, ready: true, retryStatus: null, failedPrompt: undefined });
		return true;
	}

	dismissRetry(): void { this.update({ retryStatus: null }); }

	async executeBuiltin(name: string, args: string): Promise<boolean> {
		if (!["new", "model", "thinking", "compact"].includes(name)) return false;
		if (this.state.running || this.state.busy || !this.state.ready || !this.state.connected) return true;
		if (name === "new") this.newThread();
		else if (name === "model") {
			if (args.trim().includes("/")) await this.setModel(args.trim());
			else this.update({ error: "用法：/model provider/model" });
		} else if (name === "thinking") {
			if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(args.trim())) await this.setThinkingLevel(args.trim());
			else this.update({ error: "用法：/thinking off|minimal|low|medium|high|xhigh|max" });
		} else if (this.state.sessionId) {
			await this.setting({ type: "session.compact", sessionId: this.state.sessionId }, {});
		}
		return true;
	}

	private async setting(request: DesktopClientRequestWithoutId, patch: Partial<MyselfChatPreferences>): Promise<void> {
		if (!this.state.connected || !this.state.ready || this.state.busy || this.state.running) return;
		const epoch = this.epoch;
		this.settingsRevision++;
		this.update({ busy: true, error: undefined });
		try {
			const response = await this.client.request<SessionStatsResult>(request);
			if (!this.isCurrent(epoch)) return;
			if (!response.ok) throw new Error(response.error ?? "settings failed");
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

/** Completed messages before the resume response are already in its atomic snapshot. */
function eventsAfterSnapshot(snapshot: SessionSnapshotPayload, events: ServerEventMessage[]): ServerEventMessage[] {
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
