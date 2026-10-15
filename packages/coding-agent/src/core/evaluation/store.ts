import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluationRun, EvaluationTask } from "./types.ts";

/** Evaluation data has its own directory and never writes chat or authentication files. */
export class EvaluationStore {
	private readonly root: string;
	private readonly runs = new Map<string, EvaluationRun>();
	private tasks: EvaluationTask[] = [];
	/** One unreadable file must not make every other evaluation unavailable. */
	readonly warnings: string[] = [];

	constructor(agentDir: string) {
		this.root = join(agentDir, "model-evaluations");
		mkdirSync(join(this.root, "runs"), { recursive: true });
		const taskPath = join(this.root, "tasks.json");
		if (existsSync(taskPath)) {
			try {
				const tasks: unknown = JSON.parse(readFileSync(taskPath, "utf8"));
				if (!Array.isArray(tasks)) throw new Error("not an array");
				this.tasks = tasks as EvaluationTask[];
			} catch {
				this.quarantine(taskPath, "自定义题库文件无法读取");
			}
		}
		for (const name of readdirSync(join(this.root, "runs"))) {
			if (!name.endsWith(".json")) continue;
			const path = join(this.root, "runs", name);
			let run: EvaluationRun;
			try {
				run = JSON.parse(readFileSync(path, "utf8")) as EvaluationRun;
				if (!run.id || !Array.isArray(run.results) || !Array.isArray(run.groups)) throw new Error("invalid run");
			} catch {
				this.quarantine(path, `测评记录 ${name} 无法读取`);
				continue;
			}
			this.runs.set(run.id, run);
			let changed = false;
			let initialInterrupted = false;
			for (const result of run.results) {
				if (result.status === "queued" || result.status === "running") {
					result.status = "interrupted";
					result.error = "应用重启，测评中断；可以重跑此结果";
					result.finishedAt = new Date().toISOString();
					delete result.generationPhase;
					changed = true;
					initialInterrupted = true;
				}
				for (const turn of result.followups ?? []) {
					if (turn.status !== "queued" && turn.status !== "running") continue;
					turn.status = "interrupted";
					turn.error = "应用重启，追问中断；可以重新追问";
					turn.finishedAt = new Date().toISOString();
					delete turn.generationPhase;
					changed = true;
				}
			}
			if (changed) {
				if (initialInterrupted) run.status = "interrupted";
				run.updatedAt = new Date().toISOString();
				this.saveRun(run);
			}
		}
	}

	listTasks(): EvaluationTask[] {
		return structuredClone(this.tasks);
	}

	saveTask(task: EvaluationTask): void {
		const index = this.tasks.findIndex((entry) => entry.id === task.id);
		if (index === -1) this.tasks.push(structuredClone(task));
		else this.tasks[index] = structuredClone(task);
		this.writeAtomic(join(this.root, "tasks.json"), this.tasks);
	}

	deleteTask(id: string): void {
		const remaining = this.tasks.filter((entry) => entry.id !== id);
		if (remaining.length === this.tasks.length) throw new Error("题目不存在");
		this.writeAtomic(join(this.root, "tasks.json"), remaining);
		this.tasks = remaining;
	}

	listRuns(): EvaluationRun[] {
		return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	getRun(id: string): EvaluationRun {
		const run = this.runs.get(id);
		if (!run) throw new Error("测评记录不存在");
		return run;
	}

	saveRun(run: EvaluationRun): void {
		if (!/^[a-zA-Z0-9_-]+$/.test(run.id)) throw new Error("测评记录编号无效");
		this.writeAtomic(join(this.root, "runs", `${run.id}.json`), run);
		this.runs.set(run.id, run);
	}

	deleteRun(id: string): void {
		const run = this.getRun(id);
		const path = join(this.root, "runs", `${run.id}.json`);
		if (existsSync(path)) unlinkSync(path);
		this.runs.delete(run.id);
	}

	private quarantine(path: string, description: string): void {
		const target = `${path}.corrupt-${Date.now()}`;
		try {
			renameSync(path, target);
			this.warnings.push(`${description}，已改名为 ${target} 保留原文件`);
		} catch {
			this.warnings.push(`${description}，已跳过`);
		}
	}

	private writeAtomic(path: string, value: unknown): void {
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			// Compact JSON: run files carry every answer and are rewritten while answers stream.
			writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
			renameSync(temporary, path);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}
}
