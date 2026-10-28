export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type NodeKind = "ask" | "world-read" | "world-run" | "report" | "artifact";
export type NodeStatus = "running" | "completed" | "failed";
export type StopReason = "user" | "model" | "interrupted" | "provider" | "superseded";

export interface ActorRef {
	siteId: string;
	ordinal: number;
}

export interface ActorInfo extends ActorRef {
	localId: string;
	name?: string;
	persona?: string;
}

/** One journal step. Identity is (siteId, ordinal); replay guards on inputHash. */
export interface JournalNode {
	runId: string;
	siteId: string;
	ordinal: number;
	kind: NodeKind;
	actorSiteId?: string;
	actorOrdinal?: number;
	actorSeq?: number;
	inputHash: string;
	input?: unknown;
	status: NodeStatus;
	result?: unknown;
	error?: { code?: string; message: string };
	stats?: { worldToolCalls?: number; tokens?: number; sessionId?: string };
	/** Message count of the actor session when this ask completed (session seeding on amend). */
	messageBoundary?: number;
	artifactId?: string;
}

export interface RunRecord {
	id: string;
	status: RunStatus;
	name?: string;
	cwd?: string;
	scriptHash?: string;
	scriptText?: string;
	resumedFrom?: string;
	maxConcurrency: number;
	spentTokens: number;
	result?: unknown;
	failure?: { code?: string; message: string };
	stopReason?: StopReason;
	supersededBy?: string;
	timeCreated: number;
	timeUpdated: number;
}

export type WorkflowEvent =
	| { type: "run-started"; runId: string }
	| { type: "node-queued"; instance: ActorRef; kind: NodeKind }
	| { type: "node-dispatched"; instance: ActorRef }
	| {
			type: "node-settled";
			instance: ActorRef;
			outcome: "ok" | "failed" | "cancelled";
			cached?: boolean;
			error?: { code?: string; message: string };
	  }
	| { type: "node-repairing"; instance: ActorRef; attempt: number }
	| { type: "hole-reached"; siteId: string; ordinal: number; name: string; prompt?: string }
	| { type: "hole-filled"; siteId: string; filledAt: number }
	| { type: "import-cache-closed"; cause: string }
	| { type: "log"; message: string }
	| { type: "phase-entered"; name: string }
	| { type: "report"; item: unknown; artifactId?: string }
	| {
			type: "run-settled";
			status: RunStatus;
			stopReason?: StopReason;
			supersededBy?: string;
			error?: { code?: string; message: string };
	  };

export interface AskRequest {
	/** Stable identity of the actor within the run ("siteId#ordinal"); the session-continuity key. */
	actorKey: string;
	actorName?: string;
	persona?: string;
	instructions: string;
	/** Resume this existing agent session (amend carry-over) instead of creating one. */
	resumeSessionId?: string;
}

export interface AskOutcome {
	result: unknown;
	/** World-touching tool calls close the amend import cache; sessionId enables continuity. */
	stats?: { worldToolCalls?: number; tokens?: number; sessionId?: string };
}

/** Result contract for a typed ask, extracted from the T of ask<T> at compile time. */
export interface AskSpec {
	typed: boolean;
	/** JSON-schema-ish contract: {type:"object", properties:{name:{type,description?,enum?}}, required:[…]}. */
	schema?: unknown;
	/** Human-readable contract block appended to the ask instructions. */
	contract?: string;
}

/** Max validation-repair rounds for a typed ask (ZCode: repairsRemaining = 3). */
export const ASK_REPAIR_BUDGET = 3;

/**
 * The bridge to real work. The engine calls this for anything the sandbox
 * cannot do itself: subagent turns and world reads. Session continuity for
 * amend (fork the transcript at messageBoundary) plugs in here.
 */
export interface WorkflowDriver {
	executeAsk(req: AskRequest): Promise<AskOutcome>;
	executeWorldRead(op: string, args: unknown[]): Promise<unknown>;
}

export interface ImportedActorCandidate {
	name: string;
	persona?: string;
	/** Completed asks of this actor in its own sequence, keyed by actorSeq. */
	entries: Array<{
		actorSeq: number;
		inputHash: string;
		result: unknown;
		worldToolCalls: number;
		messageBoundary?: number;
	}>;
	transcriptSourceSessionId?: string;
}

export interface ImportedCache {
	resumedFrom: string;
	actors: Map<string, ImportedActorCandidate>;
	world: Map<string, Array<{ inputHash: string; result: unknown }>>;
}
