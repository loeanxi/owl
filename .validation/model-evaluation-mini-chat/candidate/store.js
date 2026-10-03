import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
class EvaluationStore {
  root;
  runs = /* @__PURE__ */ new Map();
  tasks = [];
  constructor(agentDir) {
    this.root = join(agentDir, "model-evaluations");
    mkdirSync(join(this.root, "runs"), { recursive: true });
    const taskPath = join(this.root, "tasks.json");
    if (existsSync(taskPath)) {
      const tasks = JSON.parse(readFileSync(taskPath, "utf8"));
      if (!Array.isArray(tasks)) throw new Error("\u6A21\u578B\u6D4B\u8BC4\u9898\u5E93\u6587\u4EF6\u683C\u5F0F\u9519\u8BEF");
      this.tasks = tasks;
    }
    for (const name of readdirSync(join(this.root, "runs"))) {
      if (!name.endsWith(".json")) continue;
      const run = JSON.parse(readFileSync(join(this.root, "runs", name), "utf8"));
      if (!run.id || !Array.isArray(run.results)) throw new Error(`\u6A21\u578B\u6D4B\u8BC4\u8BB0\u5F55\u683C\u5F0F\u9519\u8BEF\uFF1A${name}`);
      this.runs.set(run.id, run);
      let changed = false;
      let initialInterrupted = false;
      for (const result of run.results) {
        if (result.status === "queued" || result.status === "running") {
          result.status = "interrupted";
          result.error = "\u5E94\u7528\u91CD\u542F\uFF0C\u6D4B\u8BC4\u4E2D\u65AD\uFF1B\u53EF\u4EE5\u91CD\u8DD1\u6B64\u7ED3\u679C";
          result.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
          delete result.generationPhase;
          changed = true;
          initialInterrupted = true;
        }
        for (const turn of result.followups ?? []) {
          if (turn.status !== "queued" && turn.status !== "running") continue;
          turn.status = "interrupted";
          turn.error = "\u5E94\u7528\u91CD\u542F\uFF0C\u8FFD\u95EE\u4E2D\u65AD\uFF1B\u53EF\u4EE5\u91CD\u65B0\u8FFD\u95EE";
          turn.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
          delete turn.generationPhase;
          changed = true;
        }
      }
      if (changed) {
        if (initialInterrupted) run.status = "interrupted";
        run.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        this.saveRun(run);
      }
    }
  }
  listTasks() {
    return structuredClone(this.tasks);
  }
  saveTask(task) {
    const index = this.tasks.findIndex((entry) => entry.id === task.id);
    if (index === -1) this.tasks.push(structuredClone(task));
    else this.tasks[index] = structuredClone(task);
    this.writeAtomic(join(this.root, "tasks.json"), this.tasks);
  }
  listRuns() {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  getRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error("\u6D4B\u8BC4\u8BB0\u5F55\u4E0D\u5B58\u5728");
    return run;
  }
  saveRun(run) {
    if (!/^[a-zA-Z0-9_-]+$/.test(run.id)) throw new Error("\u6D4B\u8BC4\u8BB0\u5F55\u7F16\u53F7\u65E0\u6548");
    this.writeAtomic(join(this.root, "runs", `${run.id}.json`), run);
    this.runs.set(run.id, run);
  }
  writeAtomic(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: "utf8", mode: 384 });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
export {
  EvaluationStore
};
