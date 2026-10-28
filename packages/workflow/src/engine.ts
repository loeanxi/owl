import { inputHash } from "./hash.js";
import type { Journal } from "./journal.js";
import type {
	ActorRef,
	AskSpec,
	ImportedActorCandidate,
	ImportedCache,
	WorkflowDriver,
	WorkflowEvent,
} from "./types.js";
import { ASK_REPAIR_BUDGET } from "./types.js";
import { extractJson, validateAgainstSchema } from "./validate.js";

interface ActorRecord {
	localId: string;
	siteId: string;
	ordinal: number;
	name?: string;
	persona?: string;
}

interface LiveAsk {
	instance: ActorRef;
	actor: ActorRecord;
	actorSeq: number;
	instructions: string;
	hash: string;
	settled: boolean;
	deferred: { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
}

/** Amend-imported cache for one named actor: completed asks keyed by their per-actor sequence. */
class ImportedActorState {
	private diverged = false;
	/** Amend-imported entries for this actor, consumed in sequence. */
	private readonly candidate: {
		entries: Map<number, { inputHash: string; result: unknown; worldToolCalls: number }>;
	};
	constructor(candidate: { entries: Map<number, { inputHash: string; result: unknown; worldToolCalls: number }> }) {
		this.candidate = candidate;
	}

	take(seq: number, hash: string, importClosed: boolean): unknown | undefined {
		if (this.diverged) return undefined;
		const entry = this.candidate.entries.get(seq);
		if (!entry || entry.inputHash !== hash || (importClosed && entry.worldToolCalls > 0)) {
			this.diverged = true;
			return undefined;
		}
		this.diverged = false;
		return entry.result;
	}
}

export interface EngineOptions {
	runId: string;
	journal: Journal;
	driver: WorkflowDriver;
	maxConcurrency: number;
	/** Hard cap on live agent dispatches per run (ZCode: 1000, "Workflow agent call limit exceeded"). */
	maxAskCalls?: number;
	importedCache?: ImportedCache;
	/** Per ask site: the ask<T> result contract (typed asks get validation + repair rounds). */
	askSpecs?: Record<string, AskSpec>;
	onEvent?: (event: WorkflowEvent) => void;
	/** Called with the sandbox handle so the runner can kill the child on stop. */
	onSandbox?: (handle: { kill(): void }) => void;
}

/**
 * Parent-side engine (ZCode's ZSe/AskScheduler, v1): consumes sandbox messages,
 * journals every effect, replays recorded results on resume, settles amend
 * imports until the first live side effect.
 */
export class WorkflowEngine {
	readonly journal: Journal;
	private driver: WorkflowDriver;
	private maxConcurrency: number;
	private onEvent?: (event: WorkflowEvent) => void;
	private onSandbox?: (handle: { kill(): void }) => void;

	private actorByLocal = new Map<string, ActorRecord>();
	private actorOrdinals = new Map<string, number>();
	private askOrdinals = new Map<string, number>();
	private actorSeqs = new Map<string, number>();
	private importedActors = new Map<string, ImportedActorState>();
	private importedCandidates = new Map<string, ImportedActorCandidate>();
	private importedWorld: ImportedCache["world"];
	private importClosed: boolean;
	private askSpecs?: Record<string, AskSpec>;
	private maxAskCalls: number;
	private askCallsDispatched = 0;

	private liveAsks = new Map<string, LiveAsk>();
	private actorQueues = new Map<string, LiveAsk[]>();
	private activeAsks = 0;

	private siteOrdinals = new Map<string, number>();
	private parkedHoles = new Map<string, Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>>();
	private settled = false;
	private settleDeferred: {
		promise: Promise<{ status: "completed" | "failed" | "cancelled"; value?: unknown; error?: string }>;
		resolve: (v: any) => void;
	};

	readonly runId: string;

	constructor(options: EngineOptions) {
		this.runId = options.runId;
		this.journal = options.journal;
		this.driver = options.driver;
		this.maxConcurrency = options.maxConcurrency;
		this.importedWorld = options.importedCache?.world ?? new Map();
		this.importClosed = options.importedCache === undefined;
		this.onEvent = options.onEvent;
		this.onSandbox = options.onSandbox;
		for (const [name, candidate] of options.importedCache?.actors ?? []) {
			this.importedCandidates.set(name, candidate);
			this.importedActors.set(
				name,
				new ImportedActorState({ entries: new Map(candidate.entries.map((e) => [e.actorSeq, e])) }),
			);
		}
		this.askSpecs = options.askSpecs;
		this.maxAskCalls = options.maxAskCalls ?? 256;
		let resolveSettle: (v: any) => void;
		const promise = new Promise<{ status: "completed" | "failed" | "cancelled"; value?: unknown; error?: string }>(
			(r) => {
				resolveSettle = r;
			},
		);
		this.settleDeferred = { promise, resolve: resolveSettle! };
	}

	get settledPromise(): Promise<{ status: "completed" | "failed" | "cancelled"; value?: unknown; error?: string }> {
		return this.settleDeferred.promise;
	}

	kill(): void {
		this.onSandbox?.({ kill: () => {} });
	}

	private record(event: WorkflowEvent): void {
		this.journal.appendEvent(event);
		this.onEvent?.(event);
	}

	// ---- child message intake ----

	handleCreateActor(localId: string, siteId: string, name?: string, persona?: string): void {
		// Ordinal per creation site, deterministic by stdio FIFO order; stable across resumes.
		const ordinal = (this.actorOrdinals.get(siteId) ?? 0) + 1;
		this.actorOrdinals.set(siteId, ordinal);
		const actor: ActorRecord = { localId, siteId, ordinal, name, persona };
		this.actorByLocal.set(localId, actor);
		this.journal.putActor({ siteId, ordinal, name, persona });
	}

	async handleRequest(msg: { id: string; type: string; siteId: string; [k: string]: unknown }): Promise<void> {
		try {
			let value: unknown;
			if (msg.type === "ask") value = await this.admitAsk(msg.siteId, String(msg.actor), String(msg.instructions));
			else if (msg.type === "world-read")
				value = await this.readWorld(msg.siteId, String(msg.op), (msg.args as unknown[]) ?? []);
			else if (msg.type === "hole")
				value = await this.reachHole(
					msg.siteId,
					String(msg.name),
					msg.prompt === undefined ? undefined : String(msg.prompt),
				);
			else if (msg.type === "publish-artifact")
				value = await this.publishArtifact(msg.siteId, String(msg.artifactOp), (msg.args as unknown[]) ?? []);
			else throw new Error(`unknown request type ${msg.type}`);
			this.respond(msg.id, true, value);
		} catch (e) {
			this.respond(msg.id, false, undefined, { message: e instanceof Error ? e.message : String(e) });
		}
	}

	handleEvent(msg: { type: string; [k: string]: unknown }): void {
		if (msg.type === "log") this.record({ type: "log", message: String(msg.message) });
		else if (msg.type === "phase-entered") this.record({ type: "phase-entered", name: String(msg.name) });
		else if (msg.type === "report") {
			const siteId = String(msg.siteId);
			const ordinal = this.nextSiteOrdinal(siteId);
			const item = msg.item;
			this.journal.putNode({
				runId: this.runId,
				siteId,
				ordinal,
				kind: "report",
				inputHash: inputHash(item),
				input: item,
				status: "completed",
				result: item,
				artifactId: msg.artifactId === undefined ? undefined : String(msg.artifactId),
			});
			this.record({
				type: "report",
				item,
				artifactId: msg.artifactId === undefined ? undefined : String(msg.artifactId),
			});
		} else if (msg.type === "declare-artifact") {
			const siteId = String(msg.siteId);
			const ordinal = this.nextSiteOrdinal(siteId);
			this.journal.putNode({
				runId: this.runId,
				siteId,
				ordinal,
				kind: "artifact",
				inputHash: inputHash({ op: msg.artifactOp, args: msg.args }),
				input: { op: msg.artifactOp, args: msg.args },
				status: "completed",
			});
		}
	}

	handleComplete(msg: {
		ok: boolean;
		value?: unknown;
		error?: { name?: string; message?: string; code?: string };
	}): void {
		if (msg.ok) this.settleCompleted(msg.value);
		else this.settleFailed(msg.error?.message ?? "workflow script failed", msg.error?.code);
	}

	private respond(id: string, ok: boolean, value?: unknown, error?: { code?: string; message: string }): void {
		this.respondFn?.({ id, ok, value, error });
	}
	respondFn?: (response: {
		id: string;
		ok: boolean;
		value?: unknown;
		error?: { code?: string; message: string };
	}) => void;

	// ---- ordinals ----

	private nextSiteOrdinal(siteId: string): number {
		const ordinal = (this.siteOrdinals.get(siteId) ?? 0) + 1;
		this.siteOrdinals.set(siteId, ordinal);
		return ordinal;
	}

	// ---- ask admission (journal replay → amend import → live) ----

	private async admitAsk(siteId: string, actorLocalId: string, instructions: string): Promise<unknown> {
		const actor = this.actorByLocal.get(actorLocalId);
		if (!actor) throw new Error(`ask before create-actor for ${actorLocalId}`);
		const ordinal = (this.askOrdinals.get(siteId) ?? 0) + 1;
		this.askOrdinals.set(siteId, ordinal);
		const instance: ActorRef = { siteId, ordinal };
		const hash = inputHash({ instructions, persona: actor.persona });
		// The ask's per-actor sequence, consumed exactly once whether it replays, imports or runs live.
		const actorSeq = (this.actorSeqs.get(actor.localId) ?? 0) + 1;
		this.actorSeqs.set(actor.localId, actorSeq);

		const recorded = this.journal.getNode(siteId, ordinal);
		if (recorded) {
			if (recorded.inputHash !== hash) {
				const error = `Replay hit at ${siteId}#${ordinal} but inputHash differs (expected ${recorded.inputHash}, got ${hash}): the script is not deterministic, so the journal cannot be replayed.`;
				this.settleFailed(error, "InputHashMismatch");
				throw new Error(error);
			}
			// Keep the recorded per-actor sequence authoritative across resumes.
			if ((recorded.actorSeq ?? 0) > 0) this.actorSeqs.set(actor.localId, Math.max(actorSeq, recorded.actorSeq!));
			if (recorded.status === "completed") {
				this.record({ type: "node-settled", instance, outcome: "ok", cached: true });
				return recorded.result;
			}
			if (recorded.status === "failed") {
				this.record({ type: "node-settled", instance, outcome: "failed", cached: true, error: recorded.error });
				throw new Error(recorded.error?.message ?? "recorded ask failed");
			}
			// status === "running": in flight when the run stopped — run live again.
		} else {
			const imported = actor.name ? this.importedActors.get(actor.name) : undefined;
			if (imported) {
				const result = imported.take(actorSeq, hash, this.importClosed);
				if (result !== undefined) {
					this.journal.putNode({
						runId: this.runId,
						siteId,
						ordinal,
						kind: "ask",
						actorSiteId: actor.siteId,
						actorOrdinal: actor.ordinal,
						actorSeq,
						inputHash: hash,
						input: instructions,
						status: "completed",
						result,
					});
					this.record({ type: "node-settled", instance, outcome: "ok", cached: true });
					return result;
				}
			}
		}

		return this.admitLive(instance, actor, instructions, hash, actorSeq);
	}

	private admitLive(
		instance: ActorRef,
		actor: ActorRecord,
		instructions: string,
		hash: string,
		actorSeq: number,
	): Promise<unknown> {
		this.askCallsDispatched += 1;
		if (this.askCallsDispatched > this.maxAskCalls) {
			const message = `Workflow agent call limit exceeded: ${this.maxAskCalls}`;
			this.settleFailed(message, "AskCallLimitExceeded");
			return Promise.reject(new Error(message));
		}
		this.journal.putNode({
			runId: this.runId,
			siteId: instance.siteId,
			ordinal: instance.ordinal,
			kind: "ask",
			actorSiteId: actor.siteId,
			actorOrdinal: actor.ordinal,
			actorSeq,
			inputHash: hash,
			input: instructions,
			status: "running",
		});
		this.record({ type: "node-queued", instance, kind: "ask" });

		let resolve!: (v: unknown) => void;
		let reject!: (e: unknown) => void;
		const promise = new Promise<unknown>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const live: LiveAsk = {
			instance,
			actor,
			actorSeq,
			instructions,
			hash,
			settled: false,
			deferred: { promise, resolve, reject },
		};
		const key = `${actor.siteId}#${actor.ordinal}`;
		const queue = this.actorQueues.get(key) ?? [];
		queue.push(live);
		this.actorQueues.set(key, queue);
		this.track(live);
		this.pump();
		return promise;
	}

	/** One ask per actor at a time (FIFO); global cap on live asks. */
	private pump(): void {
		for (const queue of this.actorQueues.values()) {
			if (this.activeAsks >= this.maxConcurrency) return;
			const next = queue.shift();
			if (!next) continue;
			this.activeAsks += 1;
			this.record({ type: "node-dispatched", instance: next.instance });
			void this.dispatchAsk(next).then(
				(outcome) => this.settleLiveAsk(next, outcome),
				(e) => this.failLiveAsk(next, e),
			);
		}
	}

	/**
	 * ZCode's submit seam: a typed ask carries its output contract; a reply that
	 * fails schema validation goes back to the SAME actor session as a repair
	 * round (budget ASK_REPAIR_BUDGET), then the node fails as ValidationFailed.
	 */
	private async dispatchAsk(
		live: LiveAsk,
	): Promise<{ result: unknown; stats?: { worldToolCalls?: number; tokens?: number; sessionId?: string } }> {
		const spec = this.askSpecs?.[live.instance.siteId];
		const actorKey = `${live.actor.siteId}#${live.actor.ordinal}`;
		// Imported actors continue the predecessor's session (context survives the amend).
		const resumeSessionId =
			live.actor.name === undefined
				? undefined
				: this.importedCandidates.get(live.actor.name)?.transcriptSourceSessionId;
		let instructions = live.instructions;
		if (spec?.typed && spec.contract) instructions += `\n\n${spec.contract}`;

		let outcome = await this.driver.executeAsk({
			actorKey,
			actorName: live.actor.name,
			persona: live.actor.persona,
			instructions,
			resumeSessionId,
		});
		if (!spec?.typed) return outcome;

		for (let attempt = 1; attempt <= ASK_REPAIR_BUDGET; attempt += 1) {
			const parsed = extractJson(String(outcome.result ?? ""));
			const violations =
				parsed === undefined
					? ["the reply was not parseable as a JSON value"]
					: validateAgainstSchema(spec.schema, parsed);
			if (violations.length === 0) return { result: parsed, stats: outcome.stats };
			this.record({ type: "node-repairing", instance: live.instance, attempt });
			instructions =
				`Your previous reply failed schema validation:\n${violations.map((v) => `- ${v}`).join("\n")}\n` +
				`Reply again with ONLY the corrected JSON object (no markdown fences, no prose).`;
			outcome = await this.driver.executeAsk({
				actorKey,
				actorName: live.actor.name,
				persona: live.actor.persona,
				instructions,
			});
		}
		const error = new Error("submit_result failed schema validation repeatedly and the repair budget is exhausted.");
		(error as any).code = "ValidationFailed";
		throw error;
	}

	private settleLiveAsk(
		live: LiveAsk,
		outcome: { result: unknown; stats?: { worldToolCalls?: number; tokens?: number } },
	): void {
		if (live.settled || this.settled) return;
		live.settled = true;
		this.activeAsks -= 1;
		this.journal.putNode({
			runId: this.runId,
			siteId: live.instance.siteId,
			ordinal: live.instance.ordinal,
			kind: "ask",
			inputHash: live.hash,
			status: "completed",
			result: outcome.result,
			stats: outcome.stats,
		});
		// A live subagent that touched the world invalidates everything the amend cache still describes.
		if ((outcome.stats?.worldToolCalls ?? 0) > 0 && !this.importClosed) {
			this.importClosed = true;
			this.record({ type: "import-cache-closed", cause: "agent-write" });
		}
		this.record({ type: "node-settled", instance: live.instance, outcome: "ok" });
		live.deferred.resolve(outcome.result);
		this.pump();
	}

	private failLiveAsk(live: LiveAsk, e: unknown): void {
		if (live.settled || this.settled) return;
		live.settled = true;
		this.activeAsks -= 1;
		const error = { code: "AskFailed", message: e instanceof Error ? e.message : String(e) };
		this.journal.putNode({
			runId: this.runId,
			siteId: live.instance.siteId,
			ordinal: live.instance.ordinal,
			kind: "ask",
			inputHash: live.hash,
			status: "failed",
			error,
		});
		this.record({ type: "node-settled", instance: live.instance, outcome: "failed", error });
		live.deferred.reject(new Error(error.message));
		this.pump();
	}

	// ---- world reads (journal replay → amend import → live) ----

	private async readWorld(siteId: string, op: string, args: unknown[]): Promise<unknown> {
		const ordinal = this.nextSiteOrdinal(siteId);
		const hash = inputHash({ op, args });

		const recorded = this.journal.getNode(siteId, ordinal);
		if (recorded?.status === "completed" && recorded.inputHash === hash) {
			this.record({ type: "node-settled", instance: { siteId, ordinal }, outcome: "ok", cached: true });
			return recorded.result;
		}
		if (!recorded) {
			if (!this.importClosed) {
				const queue = this.importedWorld.get(hash);
				const entry = queue?.shift();
				if (entry !== undefined) {
					this.journal.putNode({
						runId: this.runId,
						siteId,
						ordinal,
						kind: op === "world.run" ? "world-run" : "world-read",
						inputHash: hash,
						input: { op, args },
						status: "completed",
						result: entry.result,
					});
					this.record({ type: "node-settled", instance: { siteId, ordinal }, outcome: "ok", cached: true });
					return entry.result;
				}
			}
			if (op === "world.run" && !this.importClosed) {
				this.importClosed = true;
				this.record({ type: "import-cache-closed", cause: "world-run" });
			}
		}

		this.journal.putNode({
			runId: this.runId,
			siteId,
			ordinal,
			kind: op === "world.run" ? "world-run" : "world-read",
			inputHash: hash,
			input: { op, args },
			status: "running",
		});
		this.record({
			type: "node-queued",
			instance: { siteId, ordinal },
			kind: op === "world.run" ? "world-run" : "world-read",
		});
		this.record({ type: "node-dispatched", instance: { siteId, ordinal } });
		try {
			const result = await this.driver.executeWorldRead(op, args);
			this.journal.putNode({
				runId: this.runId,
				siteId,
				ordinal,
				kind: op === "world.run" ? "world-run" : "world-read",
				inputHash: hash,
				status: "completed",
				result,
			});
			this.record({ type: "node-settled", instance: { siteId, ordinal }, outcome: "ok" });
			return result;
		} catch (e) {
			const error = { code: "WorldReadFailed", message: e instanceof Error ? e.message : String(e) };
			this.journal.putNode({
				runId: this.runId,
				siteId,
				ordinal,
				kind: op === "world.run" ? "world-run" : "world-read",
				inputHash: hash,
				status: "failed",
				error,
			});
			this.record({ type: "node-settled", instance: { siteId, ordinal }, outcome: "failed", error });
			throw e;
		}
	}

	// ---- holes ----

	private reachHole(siteId: string, name: string, prompt?: string): Promise<unknown> {
		const ordinal = this.nextSiteOrdinal(siteId);
		let resolve!: (v: unknown) => void;
		let reject!: (e: unknown) => void;
		const promise = new Promise<unknown>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		this.record({
			type: "hole-reached",
			siteId,
			ordinal,
			name,
			...(prompt === undefined ? {} : { prompt: prompt.slice(0, 4000) }),
		});
		const parked = this.parkedHoles.get(siteId) ?? [];
		parked.push({ resolve, reject });
		this.parkedHoles.set(siteId, parked);
		return promise;
	}

	/** Fill a waiting hole: release the parked branch and record the effective script. */
	fillHole(siteId: string, code: string, effectiveScript?: { text: string; hash: string }): boolean {
		const parked = this.parkedHoles.get(siteId);
		if (!parked || parked.length === 0) return false;
		this.parkedHoles.delete(siteId);
		if (effectiveScript) {
			this.journal.updateRun({ scriptText: effectiveScript.text, scriptHash: effectiveScript.hash });
		}
		this.record({ type: "hole-filled", siteId, filledAt: Date.now() });
		for (const waiter of parked) waiter.resolve({ code });
		return true;
	}

	// ---- artifacts ----

	private async publishArtifact(siteId: string, artifactOp: string, args: unknown[]): Promise<unknown> {
		const ordinal = this.nextSiteOrdinal(siteId);
		const artifactId = args[0] === undefined ? undefined : String(args[0]);
		this.journal.putNode({
			runId: this.runId,
			siteId,
			ordinal,
			kind: "artifact",
			inputHash: inputHash({ op: artifactOp, args }),
			input: { op: artifactOp, args },
			status: "completed",
			artifactId,
		});
		return { artifactId, version: 1 };
	}

	// ---- settlement ----

	private settleCompleted(value: unknown): void {
		if (this.settled) return;
		this.settled = true;
		this.abortInFlight();
		this.journal.updateRun({ status: "completed", result: value });
		this.record({ type: "run-settled", status: "completed" });
		this.settleDeferred.resolve({ status: "completed", value });
	}

	private settleFailed(message: string, code?: string): void {
		if (this.settled) return;
		this.settled = true;
		this.abortInFlight();
		this.journal.updateRun({ status: "failed", failure: { code, message } });
		this.record({ type: "run-settled", status: "failed", error: { code, message } });
		this.settleDeferred.resolve({ status: "failed", error: message });
	}

	/** Stop from outside (user / supersede / process exit): sandbox is killed by the runner. */
	settleCancelled(
		stopReason: "user" | "model" | "interrupted" | "superseded" | "provider",
		supersededBy?: string,
	): void {
		if (this.settled) return;
		this.settled = true;
		this.abortInFlight();
		this.journal.updateRun({ status: "cancelled", stopReason, ...(supersededBy ? { supersededBy } : {}) });
		this.record({ type: "run-settled", status: "cancelled", stopReason, ...(supersededBy ? { supersededBy } : {}) });
		this.settleDeferred.resolve({ status: "cancelled" });
	}

	private abortInFlight(): void {
		for (const live of this.liveAsks.values()) {
			if (!live.settled) {
				live.settled = true;
				live.deferred.reject(new Error("Run settled; in-flight ask abandoned"));
			}
		}
		this.liveAsks.clear();
		this.activeAsks = 0;
		for (const parked of this.parkedHoles.values())
			for (const waiter of parked) waiter.reject(new Error("Run settled; hole abandoned"));
		this.parkedHoles.clear();
	}

	/** Path for external callers to track in-flight asks (future: cancellation plumbing). */
	protected track(live: LiveAsk): void {
		this.liveAsks.set(`${live.instance.siteId}#${live.instance.ordinal}`, live);
	}
}
