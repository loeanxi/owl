import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { JournalNode, NodeKind, RunRecord, RunStatus, WorkflowEvent } from "./types.js";

/**
 * Append-only JSONL journal: one file per run. Line kinds fold in order on load:
 * "run" (header), "run-update" (status/terminal fields), "node" (upsert by
 * siteId+ordinal), "actor", "event". No native deps; swap for SQLite later
 * without touching the engine.
 */
export class Journal {
	readonly path: string;
	run!: RunRecord;
	private nodes = new Map<string, JournalNode>();
	private actors: Array<{ siteId: string; ordinal: number; name?: string; persona?: string }> = [];
	private events: Array<WorkflowEvent & { seq: number }> = [];

	constructor(runsDir: string, runId: string) {
		const dir = join(runsDir, runId);
		mkdirSync(dir, { recursive: true });
		this.path = join(dir, "journal.jsonl");
	}

	static load(runsDir: string, runId: string): Journal | undefined {
		const path = join(runsDir, runId, "journal.jsonl");
		if (!existsSync(path)) return undefined;
		const journal = new Journal(runsDir, runId);
		journal.run = {
			id: runId,
			status: "pending",
			maxConcurrency: 8,
			spentTokens: 0,
			timeCreated: 0,
			timeUpdated: 0,
		};
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			journal.fold(JSON.parse(line));
		}
		return journal;
	}

	static exists(runsDir: string, runId: string): boolean {
		return existsSync(join(runsDir, runId, "journal.jsonl"));
	}

	private append(line: unknown): void {
		appendFileSync(this.path, `${JSON.stringify(line)}\n`, "utf8");
	}

	private fold(line: any): void {
		if (line.type === "run") {
			this.run = line.run;
		} else if (line.type === "run-update") {
			this.run = { ...this.run, ...line.patch };
		} else if (line.type === "node") {
			const key = `${line.node.siteId}#${line.node.ordinal}`;
			const existing = this.nodes.get(key);
			this.nodes.set(key, existing ? { ...existing, ...line.node } : line.node);
		} else if (line.type === "actor") {
			this.actors.push(line.actor);
		} else if (line.type === "event") {
			this.events.push(line.event);
		}
	}

	initRun(run: Omit<RunRecord, "timeCreated" | "timeUpdated">): void {
		this.run = { ...run, timeCreated: Date.now(), timeUpdated: Date.now() };
		this.append({ type: "run", run: this.run });
	}

	updateRun(patch: Partial<RunRecord>): void {
		this.run = { ...this.run, ...patch, timeUpdated: Date.now() };
		this.append({ type: "run-update", patch });
	}

	getNode(siteId: string, ordinal: number): JournalNode | undefined {
		return this.nodes.get(`${siteId}#${ordinal}`);
	}

	putNode(node: JournalNode): void {
		const key = `${node.siteId}#${node.ordinal}`;
		const existing = this.nodes.get(key);
		this.nodes.set(key, existing ? { ...existing, ...node } : node);
		this.append({ type: "node", node });
	}

	listNodes(kind?: NodeKind): JournalNode[] {
		return [...this.nodes.values()].filter((n) => kind === undefined || n.kind === kind);
	}

	putActor(actor: { siteId: string; ordinal: number; name?: string; persona?: string }): void {
		this.actors.push(actor);
		this.append({ type: "actor", actor });
	}

	listActors(): Array<{ siteId: string; ordinal: number; name?: string; persona?: string }> {
		return this.actors;
	}

	appendEvent(event: WorkflowEvent): void {
		this.events.push({ ...event, seq: this.events.length + 1 });
		this.append({ type: "event", event: { ...event, seq: this.events.length } });
	}

	listEvents(): Array<WorkflowEvent & { seq: number }> {
		return this.events;
	}

	setStatus(status: RunStatus): void {
		this.updateRun({ status });
	}
}
