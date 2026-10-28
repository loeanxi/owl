import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { type CompileResult, compileScript } from "./compile.js";
import { WorkflowEngine } from "./engine.js";
import { inputHash } from "./hash.js";
import { Journal } from "./journal.js";
import { type ChildMessage, type SandboxHandle, spawnSandbox, writeResponse } from "./sandbox.js";
import type { ImportedCache, RunRecord, StopReason, WorkflowDriver, WorkflowEvent } from "./types.js";

export interface RunHandle {
	runId: string;
	compile: CompileResult;
	events: Array<WorkflowEvent & { seq: number }>;
	settled: Promise<{ status: "completed" | "failed" | "cancelled"; value?: unknown; error?: string }>;
	stop(reason?: StopReason, supersededBy?: string): void;
	fillHole(siteId: string, code: string, effectiveScript?: { text: string; hash: string }): boolean;
}

export interface StartRunOptions {
	script: string;
	args?: Record<string, unknown>;
	driver: WorkflowDriver;
	runsDir: string;
	name?: string;
	maxConcurrency?: number;
	maxAskCalls?: number;
	parentRunId?: string;
	importedCache?: ImportedCache;
	onEvent?: (event: WorkflowEvent) => void;
}

/** Compile + journal + sandbox + engine: the whole launch path. */
export function startRun(options: StartRunOptions): RunHandle {
	const compile = compileScript(options.script);
	if (!compile.ok || !compile.lowered) {
		const lines = compile.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("; ");
		throw new Error(`workflow script failed to compile (${compile.diagnostics.length} diagnostics): ${lines}`);
	}
	const runId = `wf_${randomUUID().slice(0, 12)}`;
	mkdirSync(options.runsDir, { recursive: true });
	const journal = new Journal(options.runsDir, runId);
	journal.initRun({
		id: runId,
		status: "running",
		name: options.name,
		scriptHash: compile.scriptHash,
		scriptText: options.script,
		maxConcurrency: options.maxConcurrency ?? 8,
		spentTokens: 0,
		...(options.importedCache ? { resumedFrom: options.importedCache.resumedFrom } : {}),
	});

	const engine = new WorkflowEngine({
		runId,
		journal,
		driver: options.driver,
		maxConcurrency: options.maxConcurrency ?? 8,
		maxAskCalls: options.maxAskCalls,
		importedCache: options.importedCache,
		askSpecs: compile.lowered.askSpecs,
		onEvent: options.onEvent,
	});

	let sandbox: SandboxHandle | undefined;
	let stopped = false;
	engine.respondFn = (response) => {
		if (sandbox) writeResponse(sandbox, response.id, response.ok, response.value, response.error);
	};

	sandbox = spawnSandbox(
		{ runId, lowered: compile.lowered.code, args: options.args ?? {} },
		options.runsDir,
		(msg: ChildMessage) => {
			if (msg.kind === "create-actor") {
				engine.handleCreateActor(
					String(msg.localId),
					String(msg.siteId),
					msg.name === undefined ? undefined : String(msg.name),
					msg.persona === undefined ? undefined : String(msg.persona),
				);
			} else if (msg.kind === "request") {
				void engine.handleRequest(msg as any);
			} else if (msg.kind === "event") {
				engine.handleEvent(msg as any);
			} else if (msg.kind === "complete") {
				engine.handleComplete(msg as any);
			}
		},
	);

	journal.appendEvent({ type: "run-started", runId });

	const handle: RunHandle = {
		runId,
		compile,
		get events() {
			return journal.listEvents();
		},
		settled: engine.settledPromise.finally(() => {
			sandbox?.child.kill();
		}),
		stop(reason: StopReason = "user", supersededBy?: string) {
			if (stopped) return;
			stopped = true;
			sandbox?.child.kill();
			engine.settleCancelled(
				reason === "superseded" ? "superseded" : reason === "provider" ? "provider" : reason,
				supersededBy,
			);
		},
		fillHole(siteId, code, effectiveScript) {
			return engine.fillHole(siteId, code, effectiveScript);
		},
	};
	liveRuns.set(runId, handle);
	return handle;
}

/** Resume a stopped run with the byte-identical script; journal replays, in-flight asks re-run. */
export function resumeRun(options: {
	runId: string;
	driver: WorkflowDriver;
	runsDir: string;
	onEvent?: (event: WorkflowEvent) => void;
}): RunHandle {
	const prior = Journal.load(options.runsDir, options.runId);
	if (!prior) throw new Error(`no journal for run ${options.runId}`);
	if (!prior.run.scriptText || !prior.run.scriptHash) throw new Error(`run ${options.runId} has no recorded script`);
	if (!["cancelled", "running"].includes(prior.run.status)) {
		throw new Error(
			`run ${options.runId} is ${prior.run.status}; only stopped runs can be resumed (a failed script must be amended, not replayed)`,
		);
	}
	const compile = compileOrThrow(prior.run.scriptText);
	if (compile.scriptHash !== prior.run.scriptHash) {
		throw new Error(
			`ScriptHashMismatch: cannot resume run ${options.runId} — its script changed (recorded ${prior.run.scriptHash}, got ${compile.scriptHash}). Resume needs the byte-identical script; to run a revised script, use amendRun.`,
		);
	}
	return launchWithJournal({
		scriptText: prior.run.scriptText,
		scriptHash: prior.run.scriptHash,
		driver: options.driver,
		runsDir: options.runsDir,
		journal: prior,
		maxConcurrency: prior.run.maxConcurrency,
		importedCache: undefined,
		onEvent: options.onEvent,
		existing: true,
	});
}

/** Live runs this process owns, so amendRun can supersede one in a single call (ZCode semantics). */
const liveRuns = new Map<string, RunHandle>();

/**
 * Amend: start a revision that imports the predecessor's finished work as a
 * cache — named actors matched by name, their asks matched in order by input
 * hash; world reads matched by input hash. The import stays open until a live
 * side effect (a world-run or a subagent that touched the workspace),
 * mirroring ZCode's closeImportCache rule. A predecessor that is still running
 * in THIS process is stopped and superseded in the same call; a running run
 * owned by another process is refused.
 */
export async function amendRun(options: {
	runId: string;
	newScript: string;
	driver: WorkflowDriver;
	runsDir: string;
	maxConcurrency?: number;
	maxAskCalls?: number;
	onEvent?: (event: WorkflowEvent) => void;
}): Promise<RunHandle> {
	const prior = Journal.load(options.runsDir, options.runId);
	if (!prior) throw new Error(`no journal for run ${options.runId}`);
	const supersededBy = `wf_${randomUUID().slice(0, 12)}`;
	const live = liveRuns.get(options.runId);
	if (live) {
		live.stop("superseded", supersededBy);
		await live.settled;
	} else if (prior.run.status === "running") {
		throw new Error(`run ${options.runId} is running in another process; stop it there before amending`);
	}
	const cache = buildImportedCache(prior);
	const runId = supersededBy;
	mkdirSync(options.runsDir, { recursive: true });
	const journal = new Journal(options.runsDir, runId);
	const compile = compileScript(options.newScript);
	if (!compile.ok || !compile.lowered) {
		const lines = compile.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("; ");
		throw new Error(`amended script failed to compile (${compile.diagnostics.length} diagnostics): ${lines}`);
	}
	journal.initRun({
		id: runId,
		status: "running",
		scriptHash: compile.scriptHash,
		scriptText: options.newScript,
		maxConcurrency: options.maxConcurrency ?? prior.run.maxConcurrency,
		spentTokens: prior.run.spentTokens,
		resumedFrom: options.runId,
	});

	return launchWithJournal({
		scriptText: options.newScript,
		scriptHash: compile.scriptHash!,
		driver: options.driver,
		runsDir: options.runsDir,
		journal,
		maxConcurrency: journal.run.maxConcurrency,
		maxAskCalls: options.maxAskCalls,
		importedCache: { ...cache, resumedFrom: options.runId },
		onEvent: options.onEvent,
		existing: false,
	});
}

interface LaunchWithJournalOptions {
	scriptText: string;
	scriptHash: string;
	driver: WorkflowDriver;
	runsDir: string;
	journal: Journal;
	maxConcurrency: number;
	maxAskCalls?: number;
	importedCache?: ImportedCache;
	onEvent?: (event: WorkflowEvent) => void;
	existing: boolean;
}

function launchWithJournal(options: LaunchWithJournalOptions): RunHandle {
	const compile = compileOrThrow(options.scriptText);
	const engine = new WorkflowEngine({
		runId: options.journal.run.id,
		journal: options.journal,
		driver: options.driver,
		maxConcurrency: options.maxConcurrency,
		maxAskCalls: options.maxAskCalls,
		importedCache: options.importedCache,
		askSpecs: compile.lowered!.askSpecs,
		onEvent: options.onEvent,
	});
	engine.respondFn = (response) => {
		if (sandbox) writeResponse(sandbox, response.id, response.ok, response.value, response.error);
	};
	let sandbox: SandboxHandle | undefined;
	let stopped = false;
	options.journal.setStatus("running");
	options.journal.appendEvent({ type: "run-started", runId: options.journal.run.id });

	sandbox = spawnSandbox(
		{ runId: options.journal.run.id, lowered: compile.lowered!.code, args: {} },
		options.runsDir,
		(msg: ChildMessage) => {
			if (msg.kind === "create-actor") {
				engine.handleCreateActor(
					String(msg.localId),
					String(msg.siteId),
					msg.name === undefined ? undefined : String(msg.name),
					msg.persona === undefined ? undefined : String(msg.persona),
				);
			} else if (msg.kind === "request") {
				void engine.handleRequest(msg as any);
			} else if (msg.kind === "event") {
				engine.handleEvent(msg as any);
			} else if (msg.kind === "complete") {
				engine.handleComplete(msg as any);
			}
		},
	);

	const handle: RunHandle = {
		runId: options.journal.run.id,
		compile,
		get events() {
			return options.journal.listEvents();
		},
		settled: engine.settledPromise.finally(() => {
			sandbox?.child.kill();
			liveRuns.delete(options.journal.run.id);
		}),
		stop(reason: StopReason = "user", supersededBy?: string) {
			if (stopped) return;
			stopped = true;
			sandbox?.child.kill();
			engine.settleCancelled(
				reason === "superseded" ? "superseded" : reason === "provider" ? "provider" : reason,
				supersededBy,
			);
		},
		fillHole(siteId, code, effectiveScript) {
			return engine.fillHole(siteId, code, effectiveScript);
		},
	};
	liveRuns.set(handle.runId, handle);
	return handle;
}

function compileOrThrow(scriptText: string): CompileResult {
	const compile = compileScript(scriptText);
	if (!compile.ok || !compile.lowered) {
		const lines = compile.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("; ");
		throw new Error(`workflow script failed to compile (${compile.diagnostics.length} diagnostics): ${lines}`);
	}
	return compile;
}

/**
 * ZCode's buildImportedCache: named actors grouped from journal ask nodes,
 * completed asks keyed by per-actor sequence with their input hash; world
 * reads grouped by input hash as a FIFO queue. Duplicate actor names are
 * skipped wholesale. The actor's last observed agent sessionId travels along
 * as transcriptSourceSessionId, so a live ask in the revised run continues the
 * same session (context survives the amend). In-flight ask carry-over from the
 * transcript boundary remains a documented gap: a stopped in-flight ask re-runs.
 */
export function buildImportedCache(journal: Journal): ImportedCache {
	const actors = new Map<
		string,
		{
			entries: Map<number, { inputHash: string; result: unknown; worldToolCalls: number }>;
			persona?: string;
			sessionId?: string;
		}
	>();
	const nameCounts = new Map<string, number>();
	for (const actor of journal.listActors()) {
		if (!actor.name) continue;
		nameCounts.set(actor.name, (nameCounts.get(actor.name) ?? 0) + 1);
	}
	const askNodes = journal.listNodes("ask");
	askNodes.sort((a, b) => (a.actorSeq ?? 0) - (b.actorSeq ?? 0));
	for (const node of askNodes) {
		if (node.status !== "completed" || node.actorSiteId === undefined) continue;
		const actorRow = journal
			.listActors()
			.find((a) => a.siteId === node.actorSiteId && a.ordinal === node.actorOrdinal);
		const name = actorRow?.name;
		if (!name || (nameCounts.get(name) ?? 0) > 1) continue;
		const entry: {
			entries: Map<number, { inputHash: string; result: unknown; worldToolCalls: number }>;
			persona?: string;
			sessionId?: string;
		} = actors.get(name) ?? { entries: new Map(), persona: actorRow?.persona };
		entry.entries.set(node.actorSeq ?? 0, {
			inputHash: node.inputHash,
			result: node.result,
			worldToolCalls: node.stats?.worldToolCalls ?? 0,
		});
		if (node.stats?.sessionId) entry.sessionId = node.stats.sessionId;
		actors.set(name, entry);
	}
	const world = new Map<string, Array<{ inputHash: string; result: unknown }>>();
	for (const node of journal.listNodes()) {
		if ((node.kind !== "world-read" && node.kind !== "world-run") || node.status !== "completed") continue;
		const queue = world.get(node.inputHash) ?? [];
		queue.push({ inputHash: node.inputHash, result: node.result });
		world.set(node.inputHash, queue);
	}
	void inputHash; // kept imported for symmetry with future hash-aware world keys
	return {
		resumedFrom: journal.run.id,
		actors: new Map(
			[...actors.entries()].map(([name, v]) => [
				name,
				{
					name,
					persona: v.persona,
					entries: [...v.entries.entries()].map(([actorSeq, e]) => ({ actorSeq, ...e })),
					transcriptSourceSessionId: v.sessionId,
				},
			]),
		),
		world,
	};
}

export type { RunRecord };
