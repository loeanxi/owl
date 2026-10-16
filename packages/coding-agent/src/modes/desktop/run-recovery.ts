import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "../../core/session-manager.ts";
import { type QueuedUserMessage, queuedInputOf, snapshotAgentQueue } from "../../core/session-queue.ts";
import { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../../utils/atomic-file.ts";
import type {
	DesktopRunTiming,
	SessionQueueInput,
	SessionQueueItem,
	SessionQueueReturnedInput,
	SessionQueueReturnedSummary,
	SessionQueueSnapshot,
	SessionSnapshotPayload,
} from "./protocol.ts";

export interface InterruptedDesktopRun {
	sessionId: string;
	sessionPath: string;
	agentDir: string;
	runId: string;
	ownerId: string;
	ownerPid: number;
	ownerReleased?: boolean;
	startedAt: number;
	/** Legacy checkpoints are calibrated from their original persisted input once. */
	timingVersion?: 1;
	updatedAt: number;
	/** The leaf before the first input of this run; no input is copied or resent. */
	initialLeafId: string | null;
	/** Tool completion is saved before the following message_end appends its result. */
	completedTools: Record<string, ToolResultMessage>;
	pendingMessages?: DesktopQueuedMessage[];
}

export interface DesktopQueuedMessage {
	lane: "steering" | "followUp";
	message: QueuedUserMessage;
}

/** Public queue APIs are synchronous, so no model turn can drain these queues during the snapshot. */
export function desktopQueuedMessages(agent: Agent): { steering: AgentMessage[]; followUp: AgentMessage[] } {
	return snapshotAgentQueue(agent);
}

export function desktopQueueInput(message: QueuedUserMessage, state: "queued" | "delivering"): SessionQueueInput {
	const input = queuedInputOf(message);
	return {
		messageId: message.owlQueueId,
		text: input.text,
		images: input.images ?? [],
		attachedPaths: input.attachedPaths ?? [],
		state,
	};
}

function queueItem(input: SessionQueueInput): SessionQueueItem {
	return {
		messageId: input.messageId,
		text: input.text.slice(0, 500),
		textTruncated: input.text.length > 500,
		imageCount: input.images.length,
		attachedPaths: [...input.attachedPaths],
		state: input.state,
	};
}

function pendingQueueEntries(agent: Agent): DesktopQueuedMessage[] {
	const raw = desktopQueuedMessages(agent);
	return (["steering", "followUp"] as const).flatMap((lane) =>
		raw[lane].flatMap((message) =>
			message.role === "user" ? [{ lane, message: message as QueuedUserMessage }] : [],
		),
	);
}

interface RecoveryFile {
	version: 1;
	runs: Record<string, InterruptedDesktopRun>;
	/** Durable hand-off receipts survive session shutdown/deletion and contain the only returned binary material. */
	returnedInputs?: Record<string, SessionQueueReturnedInput>;
	/** Permanent identity tombstones prevent restart replay even after a receipt is explicitly removed. */
	removedQueueIds?: Record<string, { removedAt: number; receiptId?: string }>;
	/** Pending input is retained independently from permission to automatically resume an active run. */
	pendingQueues?: Record<string, DesktopQueuedMessage[]>;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Lack of permission is not proof that the other bridge stopped.
		return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
	}
}

/** Durable running intent, independent of UI connections and the transcript's current branch. */
export class DesktopRunRecovery {
	private readonly path: string;
	private readonly ownerId = randomUUID();
	private readonly agentDir: string;
	private readonly onDiagnostic: (message: string) => void;
	private frozen = false;

	constructor(agentDir: string, onDiagnostic: (message: string) => void) {
		this.agentDir = agentDir;
		this.path = join(agentDir, "desktop-run-checkpoints.json");
		this.onDiagnostic = onDiagnostic;
	}

	private read(): RecoveryFile {
		if (!existsSync(this.path)) return { version: 1, runs: {} };
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as RecoveryFile;
			if (parsed.version !== 1 || !parsed.runs || typeof parsed.runs !== "object")
				throw new Error("Invalid run checkpoint file");
			for (const [id, run] of Object.entries(parsed.runs)) {
				if (
					!run ||
					run.sessionId !== id ||
					typeof run.sessionPath !== "string" ||
					typeof run.agentDir !== "string" ||
					typeof run.ownerId !== "string" ||
					!Number.isInteger(run.ownerPid) ||
					run.ownerPid <= 0 ||
					typeof run.runId !== "string" ||
					!Number.isFinite(run.startedAt) ||
					!Number.isFinite(run.updatedAt) ||
					(run.initialLeafId !== null && typeof run.initialLeafId !== "string") ||
					!run.completedTools ||
					typeof run.completedTools !== "object" ||
					(run.pendingMessages !== undefined &&
						(!Array.isArray(run.pendingMessages) ||
							run.pendingMessages.some(
								(queued) =>
									!queued ||
									(queued.lane !== "steering" && queued.lane !== "followUp") ||
									queued.message?.role !== "user" ||
									typeof queued.message.owlQueueId !== "string",
							)))
				)
					throw new Error("Invalid run checkpoint");
			}
			return parsed;
		} catch (error) {
			backupCorruptFile(this.path);
			this.onDiagnostic(`运行检查点读取失败：${error instanceof Error ? error.message : String(error)}`);
			return { version: 1, runs: {} };
		}
	}

	private update<T>(mutate: (file: RecoveryFile) => T): T {
		return withFileLockSync(this.path, () => {
			const file = this.read();
			const result = mutate(file);
			atomicWriteFileSync(this.path, JSON.stringify(file));
			return result;
		});
	}

	begin(sessionManager: SessionManager, agentDir = this.agentDir): void {
		if (this.frozen || !sessionManager.isPersisted()) return;
		const sessionPath = sessionManager.getSessionFile();
		if (!sessionPath) return;
		const sessionId = sessionManager.getSessionId();
		this.update((file) => {
			const existing = file.runs[sessionId];
			if (existing?.ownerId === this.ownerId) return;
			if (existing && !existing.ownerReleased && processExists(existing.ownerPid))
				throw new Error("Another bridge owns the active session run");
			const now = Date.now();
			file.runs[sessionId] = {
				sessionId,
				sessionPath,
				agentDir,
				runId: randomUUID(),
				ownerId: this.ownerId,
				ownerPid: process.pid,
				startedAt: now,
				timingVersion: 1,
				updatedAt: now,
				initialLeafId: sessionManager.getLeafId(),
				completedTools: {},
				pendingMessages: [],
			};
		});
	}

	timing(sessionId: string): DesktopRunTiming | undefined {
		const run = this.read().runs[sessionId];
		return run ? { runId: run.runId, startedAt: run.startedAt } : undefined;
	}

	toolCompleted(sessionId: string, result: ToolResultMessage): void {
		if (this.frozen) return;
		this.update((file) => {
			const run = file.runs[sessionId];
			if (run?.ownerId !== this.ownerId) return;
			run.completedTools[result.toolCallId] = result;
			run.updatedAt = Date.now();
		});
	}

	/** Called only after the transcript has persisted a boundary, never on pre-persistence message_end. */
	boundary(sessionManager: SessionManager): void {
		if (this.frozen) return;
		this.update((file) => {
			const sessionId = sessionManager.getSessionId();
			const run = file.runs[sessionId];
			if (run && run.ownerId !== this.ownerId) return;
			for (const message of sessionManager.buildSessionProjection().messages) {
				if (run && message.role === "toolResult") delete run.completedTools[message.toolCallId];
				if ("owlQueueId" in message && typeof message.owlQueueId === "string") {
					if (run)
						run.pendingMessages = run.pendingMessages?.filter(
							(queued) => queued.message.owlQueueId !== message.owlQueueId,
						);
					if (file.pendingQueues?.[sessionId])
						file.pendingQueues[sessionId] = file.pendingQueues[sessionId].filter(
							(queued) => queued.message.owlQueueId !== message.owlQueueId,
						);
				}
			}
			if (run) run.updatedAt = Date.now();
		});
	}

	captureQueue(sessionManager: SessionManager, agent: Agent, discardedIds: readonly string[] = []): void {
		if (this.frozen) return;
		const pending = pendingQueueEntries(agent);
		this.update((file) => {
			const sessionId = sessionManager.getSessionId();
			const run = file.runs[sessionId];
			if (run && run.ownerId !== this.ownerId) return;
			const delivered = new Set(
				sessionManager
					.buildSessionProjection()
					.messages.flatMap((message) =>
						"owlQueueId" in message && typeof message.owlQueueId === "string" ? [message.owlQueueId] : [],
					),
			);
			const removed = (id: string) => Boolean(file.removedQueueIds?.[`${sessionId}:${id}`]);
			const retainedPending = pending.filter(
				(queued) => !removed(queued.message.owlQueueId) && !delivered.has(queued.message.owlQueueId),
			);
			file.pendingQueues ??= {};
			file.pendingQueues[sessionId] = retainedPending;
			if (!run) return;
			const current = new Set(retainedPending.map((queued) => queued.message.owlQueueId));
			// A queue can be drained before its messages append; retain those until their durable entry arrives.
			const inFlight = (run.pendingMessages ?? []).filter(
				(queued) =>
					!current.has(queued.message.owlQueueId) &&
					!delivered.has(queued.message.owlQueueId) &&
					!removed(queued.message.owlQueueId) &&
					!discardedIds.includes(queued.message.owlQueueId),
			);
			run.pendingMessages = [...inFlight, ...retainedPending];
			run.updatedAt = Date.now();
		});
	}

	queue(sessionId: string, agent?: Agent): SessionQueueSnapshot | undefined {
		const file = this.read();
		const run = file.runs[sessionId];
		if (!run && !agent && !file.pendingQueues?.[sessionId]) return undefined;
		const raw = agent ? desktopQueuedMessages(agent) : undefined;
		const actual = new Map<string, DesktopQueuedMessage>();
		if (raw)
			for (const lane of ["steering", "followUp"] as const)
				for (const message of raw[lane]) {
					if (message.role === "user" && "owlQueueId" in message && typeof message.owlQueueId === "string") {
						actual.set(message.owlQueueId, { lane, message: message as QueuedUserMessage });
					}
				}
		const snapshot: SessionQueueSnapshot = { steering: [], followUp: [] };
		const seen = new Set<string>();
		for (const queued of run?.pendingMessages ?? file.pendingQueues?.[sessionId] ?? []) {
			if (file.removedQueueIds?.[`${sessionId}:${queued.message.owlQueueId}`]) continue;
			const live = actual.get(queued.message.owlQueueId);
			const source = live ?? queued;
			snapshot[source.lane].push(
				queueItem(desktopQueueInput(source.message, raw && !live ? "delivering" : "queued")),
			);
			seen.add(queued.message.owlQueueId);
		}
		for (const [id, source] of actual) {
			if (!seen.has(id) && !file.removedQueueIds?.[`${sessionId}:${id}`]) {
				snapshot[source.lane].push(queueItem(desktopQueueInput(source.message, "queued")));
			}
		}
		return snapshot;
	}

	queuedInput(sessionId: string, messageId: string): SessionQueueInput | undefined {
		const file = this.read();
		if (file.removedQueueIds?.[`${sessionId}:${messageId}`]) return undefined;
		const active = file.runs[sessionId]?.pendingMessages?.find((item) => item.message.owlQueueId === messageId);
		if (active) return desktopQueueInput(active.message, "delivering");
		const passive = file.pendingQueues?.[sessionId]?.find((item) => item.message.owlQueueId === messageId);
		return passive ? desktopQueueInput(passive.message, "queued") : undefined;
	}

	/** Restore editor material on an explicit mount, without starting or continuing the agent. */
	restoreQueue(sessionManager: SessionManager, agent: Agent): void {
		const sessionId = sessionManager.getSessionId();
		const file = this.read();
		const delivered = new Set(
			sessionManager
				.buildSessionProjection()
				.messages.flatMap((message) =>
					"owlQueueId" in message && typeof message.owlQueueId === "string" ? [message.owlQueueId] : [],
				),
		);
		const existing = new Set(pendingQueueEntries(agent).map((item) => item.message.owlQueueId));
		for (const queued of file.pendingQueues?.[sessionId] ?? []) {
			const id = queued.message.owlQueueId;
			if (existing.has(id) || delivered.has(id) || file.removedQueueIds?.[`${sessionId}:${id}`]) continue;
			if (queued.lane === "steering") agent.steer(structuredClone(queued.message));
			else agent.followUp(structuredClone(queued.message));
			existing.add(id);
		}
	}

	deletePendingQueue(sessionId: string): void {
		this.update((file) => {
			if (file.pendingQueues) delete file.pendingQueues[sessionId];
		});
	}

	removeQueuedInput(sessionId: string, messageId: string): void {
		if (this.frozen) throw new Error("桥正在关闭，队列操作未执行");
		this.update((file) => {
			const run = file.runs[sessionId];
			if (run && run.ownerId !== this.ownerId) throw new Error("当前运行由另一个桥拥有");
			file.removedQueueIds ??= {};
			file.removedQueueIds[`${sessionId}:${messageId}`] ??= { removedAt: Date.now() };
			if (run) run.pendingMessages = run.pendingMessages?.filter((item) => item.message.owlQueueId !== messageId);
			if (file.pendingQueues?.[sessionId])
				file.pendingQueues[sessionId] = file.pendingQueues[sessionId].filter(
					(item) => item.message.owlQueueId !== messageId,
				);
		});
	}

	promoteQueuedInput(sessionId: string, messageId: string): void {
		if (this.frozen) throw new Error("桥正在关闭，队列操作未执行");
		this.update((file) => {
			const run = file.runs[sessionId];
			if (run && run.ownerId !== this.ownerId) throw new Error("当前运行由另一个桥拥有");
			const queued = run?.pendingMessages?.find((item) => item.message.owlQueueId === messageId);
			if (queued) queued.lane = "steering";
			const passive = file.pendingQueues?.[sessionId]?.find((item) => item.message.owlQueueId === messageId);
			if (passive) passive.lane = "steering";
		});
	}

	/** Write the complete receipt and replay tombstone atomically before the live queue is touched. */
	takeQueuedInput(
		sessionManager: SessionManager,
		agent: Agent,
		messageId: string,
		operationId: string,
	): SessionQueueReturnedInput {
		if (this.frozen) throw new Error("桥正在关闭，取回未执行");
		if (!/^[a-zA-Z0-9_-]{1,200}$/.test(operationId)) throw new Error("无效的取回操作标识");
		const sessionId = sessionManager.getSessionId();
		return this.update((file) => {
			const receiptKey = `receipt:${operationId}`;
			const previous = file.returnedInputs?.[receiptKey];
			if (previous) {
				if (previous.sourceSessionId !== sessionId || previous.input.messageId !== messageId)
					throw new Error("取回操作标识已用于另一条输入");
				return structuredClone(previous);
			}
			if (Object.values(file.removedQueueIds ?? {}).some((removed) => removed.receiptId === operationId)) {
				throw new Error("这份取回原件已被显式移除，操作标识不能用于另一条输入");
			}
			if (file.removedQueueIds?.[`${sessionId}:${messageId}`])
				throw new Error("这条输入已移除或取回，请查看已取回输入");
			const queues = desktopQueuedMessages(agent);
			const message = [...queues.steering, ...queues.followUp].find(
				(item) => item.role === "user" && "owlQueueId" in item && item.owlQueueId === messageId,
			);
			if (!message || message.role !== "user") throw new Error("这条输入已开始处理或已不在队列，不能取回");
			const run = file.runs[sessionId];
			if (run && run.ownerId !== this.ownerId) throw new Error("当前运行由另一个桥拥有");
			const receipt: SessionQueueReturnedInput = {
				receiptId: operationId,
				sourceSessionId: sessionId,
				sourceCwd: sessionManager.getCwd(),
				createdAt: Date.now(),
				input: desktopQueueInput(message as QueuedUserMessage, "queued"),
			};
			file.returnedInputs ??= {};
			file.returnedInputs[receiptKey] = receipt;
			file.removedQueueIds ??= {};
			file.removedQueueIds[`${sessionId}:${messageId}`] = { removedAt: receipt.createdAt, receiptId: operationId };
			if (run) run.pendingMessages = run.pendingMessages?.filter((item) => item.message.owlQueueId !== messageId);
			if (file.pendingQueues?.[sessionId])
				file.pendingQueues[sessionId] = file.pendingQueues[sessionId].filter(
					(item) => item.message.owlQueueId !== messageId,
				);
			return structuredClone(receipt);
		});
	}

	returnedInput(receiptId: string): SessionQueueReturnedInput | undefined {
		const found = this.read().returnedInputs?.[`receipt:${receiptId}`];
		return found ? structuredClone(found) : undefined;
	}

	returnedInputs(sessionId?: string): SessionQueueReturnedSummary[] {
		return Object.values(this.read().returnedInputs ?? {})
			.filter((item) => sessionId === undefined || item.sourceSessionId === sessionId)
			.sort((a, b) => b.createdAt - a.createdAt)
			.map((item) => ({
				receiptId: item.receiptId,
				sourceSessionId: item.sourceSessionId,
				sourceCwd: item.sourceCwd,
				createdAt: item.createdAt,
				...queueItem(item.input),
			}));
	}

	removeReturnedInput(receiptId: string): void {
		this.update((file) => {
			if (!file.returnedInputs?.[`receipt:${receiptId}`]) throw new Error("这份已取回输入不存在");
			delete file.returnedInputs[`receipt:${receiptId}`];
		});
	}

	finish(sessionId: string, current?: { sessionManager: SessionManager; agent: Agent }): void {
		if (this.frozen) return;
		const pending = current ? pendingQueueEntries(current.agent) : undefined;
		let delivered = current
			? new Set(
					current.sessionManager
						.buildSessionProjection()
						.messages.flatMap((message) =>
							"owlQueueId" in message && typeof message.owlQueueId === "string" ? [message.owlQueueId] : [],
						),
				)
			: undefined;
		this.update((file) => {
			const run = file.runs[sessionId];
			if (run && run.ownerId !== this.ownerId) return;
			if (!delivered && run && existsSync(run.sessionPath)) {
				try {
					delivered = new Set(
						SessionManager.open(run.sessionPath)
							.buildSessionProjection()
							.messages.flatMap((message) =>
								"owlQueueId" in message && typeof message.owlQueueId === "string" ? [message.owlQueueId] : [],
							),
					);
				} catch {
					// Uncertain material stays passive; it never grants automatic execution permission.
				}
			}
			if (pending || run) {
				file.pendingQueues ??= {};
				const retained = new Map<string, DesktopQueuedMessage>();
				for (const item of [
					...(file.pendingQueues[sessionId] ?? []),
					...(run?.pendingMessages ?? []),
					...(pending ?? []),
				]) {
					retained.set(item.message.owlQueueId, item);
				}
				file.pendingQueues[sessionId] = [...retained.values()].filter(
					(item) =>
						!file.removedQueueIds?.[`${sessionId}:${item.message.owlQueueId}`] &&
						!delivered?.has(item.message.owlQueueId),
				);
			}
			if (file.runs[sessionId]?.ownerId === this.ownerId) delete file.runs[sessionId];
		});
	}

	claimInterrupted(): InterruptedDesktopRun[] {
		return this.update((file) => {
			const claimed: InterruptedDesktopRun[] = [];
			for (const run of Object.values(file.runs)) {
				if (!run.ownerReleased && processExists(run.ownerPid)) continue;
				if (run.timingVersion === undefined && existsSync(run.sessionPath)) {
					try {
						const manager = SessionManager.open(run.sessionPath);
						if (manager.getSessionId() !== run.sessionId) throw new Error("会话检查点与文件不匹配");
						const branch = manager.getBranch();
						const boundary =
							run.initialLeafId === null ? -1 : branch.findIndex((entry) => entry.id === run.initialLeafId);
						if (run.initialLeafId !== null && boundary < 0) throw new Error("运行分支已变化");
						const entries = branch.slice(boundary + 1);
						// Queued inputs and hidden restart messages must not replace the original user's clock.
						const user = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
						const custom = user ? undefined : entries.find((entry) => entry.type === "custom_message");
						const startedAt =
							user?.type === "message"
								? user.message.timestamp
								: custom
									? Date.parse(custom.timestamp)
									: undefined;
						if (startedAt !== undefined && Number.isFinite(startedAt)) {
							run.startedAt = startedAt;
							run.timingVersion = 1;
						}
					} catch (error) {
						this.onDiagnostic(
							`运行计时校准失败（${run.sessionId}）：${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				run.ownerId = this.ownerId;
				run.ownerPid = process.pid;
				delete run.ownerReleased;
				run.pendingMessages = run.pendingMessages?.filter(
					(item) => !file.removedQueueIds?.[`${run.sessionId}:${item.message.owlQueueId}`],
				);
				claimed.push(structuredClone(run));
			}
			return claimed;
		});
	}

	/** One-time upgrade handoff: call only with a freshly verified running snapshot from the old bridge. */
	importLegacyRuns(runs: readonly InterruptedDesktopRun[]): void {
		this.update((file) => {
			for (const run of runs) {
				if (file.runs[run.sessionId]) throw new Error(`会话已有运行检查点：${run.sessionId}`);
				file.runs[run.sessionId] = run;
			}
		});
	}

	/** Freeze before shutdown aborts and permission cancellation can emit settlement events. */
	preserveForRestart(): void {
		this.frozen = true;
	}

	/** Release ownership after every old runtime stopped, including in same-process test restarts. */
	releaseAfterShutdown(): void {
		this.update((file) => {
			for (const run of Object.values(file.runs)) {
				if (run.ownerId === this.ownerId) run.ownerReleased = true;
			}
		});
	}
}

/** Build an upgrade checkpoint from live evidence, never from idle transcript heuristics. */
export function legacyDesktopRunCheckpoint(
	sessionManager: SessionManager,
	snapshot: SessionSnapshotPayload,
	ownerPid: number,
	agentDir: string,
	capturedAt: number,
): InterruptedDesktopRun {
	if (snapshot.running !== true || snapshot.sessionId !== sessionManager.getSessionId())
		throw new Error("迁移只接受旧桥仍在运行的同一会话快照");
	const boundary = snapshot.runStartMessageIndex;
	if (
		boundary === undefined ||
		!Number.isInteger(boundary) ||
		boundary < 0 ||
		boundary > snapshot.messages.length ||
		snapshot.messageEntryIds.length !== snapshot.messages.length ||
		!Number.isInteger(ownerPid) ||
		ownerPid <= 0 ||
		!Number.isFinite(capturedAt)
	)
		throw new Error("旧桥快照缺少有效的运行边界");
	let inputEntryId: string | undefined;
	for (let index = boundary - 1; index >= 0; index--) {
		const message = snapshot.messages[index];
		if (
			message &&
			typeof message === "object" &&
			"role" in message &&
			(message.role === "user" || message.role === "custom")
		) {
			inputEntryId = snapshot.messageEntryIds[index];
			break;
		}
	}
	const entry = inputEntryId ? sessionManager.getEntry(inputEntryId) : undefined;
	if (
		!entry ||
		!sessionManager.getBranch().some((item) => item.id === entry.id) ||
		!((entry.type === "message" && entry.message.role === "user") || entry.type === "custom_message")
	)
		throw new Error("旧桥本轮输入无法与会话文件对应");
	const sessionPath = sessionManager.getSessionFile();
	if (!sessionPath || !existsSync(sessionPath)) throw new Error("旧桥会话尚未落盘");
	return {
		sessionId: snapshot.sessionId,
		sessionPath,
		agentDir,
		runId: randomUUID(),
		ownerId: `legacy-${ownerPid}-${randomUUID()}`,
		ownerPid,
		startedAt: Date.parse(entry.timestamp),
		updatedAt: capturedAt,
		initialLeafId: entry.parentId,
		completedTools: {},
		pendingMessages: [],
	};
}

/** Repair result gaps without executing the old tool calls or inventing a successful result. */
export function prepareInterruptedRun(sessionManager: SessionManager, run: InterruptedDesktopRun): void {
	const branch = sessionManager.getBranch();
	const boundary = run.initialLeafId === null ? -1 : branch.findIndex((entry) => entry.id === run.initialLeafId);
	if (run.initialLeafId !== null && boundary < 0) throw new Error("运行分支已变化，无法自动续跑");
	const inputExists = branch
		.slice(boundary + 1)
		.some((entry) => (entry.type === "message" && entry.message.role === "user") || entry.type === "custom_message");
	if (!inputExists) throw new Error("中断前的输入尚未落盘，无法自动续跑");
	const activeIds = new Set(branch.slice(boundary + 1).map((entry) => entry.id));
	const messages = sessionManager
		.buildSessionProjection()
		.entries.filter((entry) => activeIds.has(entry.sourceEntry.id))
		.flatMap((entry) => entry.messages);
	const delivered = new Set(
		messages.flatMap((message) =>
			"owlQueueId" in message && typeof message.owlQueueId === "string" ? [message.owlQueueId] : [],
		),
	);
	run.pendingMessages = run.pendingMessages?.filter((queued) => !delivered.has(queued.message.owlQueueId));
	const results = new Set(
		messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
	);
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || results.has(part.id)) continue;
			const saved = run.completedTools[part.id];
			sessionManager.appendMessage(
				saved ?? {
					role: "toolResult",
					toolCallId: part.id,
					toolName: part.name,
					isError: true,
					timestamp: Date.now(),
					content: [
						{
							type: "text",
							text: "Owl 重启中断了此工具调用，最终结果未确认。不要自动重放；先检查当前状态确认是否已经执行，再决定下一步。",
						},
					],
				},
			);
			results.add(part.id);
		}
	}
}

export const RESTART_RESUME_MESSAGE =
	"Owl 因调试更新或重启中断了上一轮任务，现在自动恢复。继续完成原任务剩余工作，保留所有已完成的步骤和工具结果，不要重做已确认完成的操作。标为重启中断或结果未确认的工具调用可能已产生副作用，必须先检查当前状态确认结果，再决定下一步；不要直接重放。当前工具与页面状态以重新查询的结果为准。";
