import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluationRun, EvaluationTask } from "./types.ts";

/** Evaluation data has its own directory and never writes chat or authentication files. */
export class EvaluationStore {
	private readonly root: string;
	private readonly runs = new Map<string, EvaluationRun>();
	private tasks: EvaluationTask[] = [];

	constructor(agentDir: string) {
		this.root = join(agentDir, "model-evaluations");
		mkdirSync(join(this.root, "runs"), { recursive: true });
		const taskPath = join(this.root, "tasks.json");
		if (existsSync(taskPath)) {
			const tasks: unknown = JSON.parse(readFileSync(taskPath, "utf8"));
			if (!Array.isArray(tasks)) throw new Error("模型测评题库文件格式错误");
			this.tasks = tasks as EvaluationTask[];
		}
		for (const name of readdirSync(join(this.root, "runs"))) {
			if (!name.endsWith(".json")) continue;
			const run = JSON.parse(readFileSync(join(this.root, "runs", name), "utf8")) as EvaluationRun;
			if (!run.id || !Array.isArray(run.results)) throw new Error(`模型测评记录格式错误：${name}`);
			this.runs.set(run.id, run);
			let changed = false;
			for (const result of run.results) {
				if (result.status !== "queued" && result.status !== "running") continue;
				result.status = "interrupted";
				result.error = "应用重启，测评中断；可以重跑此结果";
				result.finishedAt = new Date().toISOString();
				changed = true;
			}
			if (changed) {
				run.status = "interrupted";
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

	private writeAtomic(path: string, value: unknown): void {
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			renameSync(temporary, path);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}
}
