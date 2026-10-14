import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "../../core/session-manager.ts";
import { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../../utils/atomic-file.ts";
import type { DesktopRunTiming, SessionSnapshotPayload } from "./protocol.ts";

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
	message: UserMessage & { owlQueueId: string };
}

/** Public queue APIs are synchronous, so no model turn can drain these queues during the snapshot. */
export function desktopQueuedMessages(agent: Agent): { steering: AgentMessage[]; followUp: AgentMessage[] } {
	const steering: AgentMessage[] = [];
	const followUp: AgentMessage[] = [];
	try {
		for (;;) {
			const message = agent.takeSteeringAt(0);
			if (!message) break;
			steering.push(message);
		}
		for (;;) {
			const message = agent.takeFollowUpAt(0);
			if (!message) break;
			followUp.push(message);
		}
		return { steering, followUp };
	} finally {
		for (const message of steering) agent.steer(message);
		for (const message of followUp) agent.followUp(message);
	}
}

interface RecoveryFile {
	version: 1;
	runs: Record<string, InterruptedDesktopRun>;
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
			const run = file.runs[sessionManager.getSessionId()];
			if (run?.ownerId !== this.ownerId) return;
			for (const message of sessionManager.buildSessionProjection().messages) {
				if (message.role === "toolResult") delete run.completedTools[message.toolCallId];
				if ("owlQueueId" in message && typeof message.owlQueueId === "string") {
					run.pendingMessages = run.pendingMessages?.filter(
						(queued) => queued.message.owlQueueId !== message.owlQueueId,
					);
				}
			}
			run.updatedAt = Date.now();
		});
	}

	captureQueue(sessionManager: SessionManager, agent: Agent, discardedIds: readonly string[] = []): void {
		if (this.frozen) return;
		const queues = desktopQueuedMessages(agent);
		const pending: DesktopQueuedMessage[] = [];
		for (const lane of ["steering", "followUp"] as const) {
			for (const message of queues[lane]) {
				if (message.role !== "user") continue;
				const queued = message as UserMessage & { owlQueueId?: string };
				queued.owlQueueId ??= randomUUID();
				pending.push({ lane, message: queued as DesktopQueuedMessage["message"] });
			}
		}
		this.update((file) => {
			const run = file.runs[sessionManager.getSessionId()];
			if (run?.ownerId !== this.ownerId) return;
			const delivered = new Set(
				sessionManager
					.buildSessionProjection()
					.messages.flatMap((message) =>
						"owlQueueId" in message && typeof message.owlQueueId === "string" ? [message.owlQueueId] : [],
					),
			);
			const current = new Set(pending.map((queued) => queued.message.owlQueueId));
			// A queue can be drained before its messages append; retain those until their durable entry arrives.
			const inFlight = (run.pendingMessages ?? []).filter(
				(queued) =>
					!current.has(queued.message.owlQueueId) &&
					!delivered.has(queued.message.owlQueueId) &&
					!discardedIds.includes(queued.message.owlQueueId),
			);
			run.pendingMessages = [...inFlight, ...pending];
			run.updatedAt = Date.now();
		});
	}

	queue(sessionId: string): { steering: string[]; followUp: string[] } | undefined {
		const run = this.read().runs[sessionId];
		if (!run) return undefined;
		const snapshot = { steering: [] as string[], followUp: [] as string[] };
		for (const queued of run.pendingMessages ?? []) {
			const content = queued.message.content;
			snapshot[queued.lane].push(
				typeof content === "string"
					? content
					: content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
			);
		}
		return snapshot;
	}

	finish(sessionId: string): void {
		if (this.frozen) return;
		this.update((file) => {
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
