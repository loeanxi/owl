import { randomInt, randomUUID } from "node:crypto";
import { getAgentDir } from "../../config.js";
import { checkEvaluationArtifact, extractEvaluationArtifact } from "./checkers.js";
import {
  createEvaluationModelAccess,
  validateEvaluationConversation
} from "./model.js";
import { EvaluationStore } from "./store.js";
import { BUILTIN_EVALUATION_TASKS } from "./tasks.js";
function runSummary(run) {
  return {
    id: run.id,
    name: run.name,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: run.status,
    taskCount: run.tasks.length,
    profileCount: run.profiles.length,
    samples: run.samples,
    total: run.results.length,
    completed: run.results.filter((result) => result.status === "completed").length,
    failed: run.results.filter((result) => ["failed", "cancelled", "interrupted"].includes(result.status)).length,
    pending: run.results.filter((result) => result.status === "queued" || result.status === "running").length,
    rated: run.results.filter((result) => result.rating !== null).length,
    revealed: run.groups.filter((group) => group.revealed).length
  };
}
function followupView(turn, revealed) {
  const { startedAt, finishedAt, durationMs, usage, costUsd, actualModel, generationPhase, ...publicTurn } = turn;
  return {
    ...structuredClone(publicTurn),
    thinking: turn.thinking ?? "",
    error: !revealed && turn.error ? "\u672C\u6B21\u8FFD\u95EE\u672A\u5B8C\u6210\uFF1B\u63ED\u6653\u540E\u53EF\u67E5\u770B\u8BE6\u7EC6\u539F\u56E0" : turn.error,
    ...turn.status === "queued" || turn.status === "running" ? { generationPhase: generationPhase ?? (turn.output ? "answering" : turn.thinking ? "thinking" : "waiting") } : {},
    ...revealed ? {
      startedAt,
      finishedAt,
      durationMs,
      usage: structuredClone(usage),
      costUsd,
      ...actualModel ? { actualModel: structuredClone(actualModel) } : {}
    } : {}
  };
}
function evaluationRunView(run) {
  const results = [];
  for (const group of run.groups) {
    for (const [index, id] of group.resultIds.entries()) {
      const result = run.results.find((entry) => entry.id === id);
      if (!result) continue;
      let anonymousLabel = "";
      for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
        anonymousLabel = String.fromCharCode(65 + (number - 1) % 26) + anonymousLabel;
      }
      const {
        profileId,
        thinking,
        generationPhase,
        startedAt,
        finishedAt,
        durationMs,
        usage,
        costUsd,
        actualModel,
        followups,
        ...anonymous
      } = result;
      results.push({
        ...structuredClone(anonymous),
        // The user requested live supplier reasoning as well as live answer text.
        thinking: thinking ?? "",
        followups: (followups ?? []).map((turn) => followupView(turn, group.revealed)),
        ...result.status === "queued" || result.status === "running" ? {
          generationPhase: generationPhase ?? (result.output ? "answering" : thinking ? "thinking" : "waiting")
        } : {},
        error: !group.revealed && result.error ? "\u672C\u6B21\u751F\u6210\u672A\u5B8C\u6210\uFF1B\u63ED\u6653\u540E\u53EF\u67E5\u770B\u8BE6\u7EC6\u539F\u56E0" : result.error,
        anonymousLabel,
        revealed: group.revealed,
        ...group.revealed ? {
          profile: structuredClone(run.profiles.find((profile) => profile.id === profileId)),
          startedAt,
          finishedAt,
          durationMs,
          usage: structuredClone(usage),
          costUsd,
          ...actualModel ? { actualModel: structuredClone(actualModel) } : {}
        } : {}
      });
    }
  }
  const { profiles, results: _results, ...publicRun } = run;
  return { ...structuredClone(publicRun), profileCount: profiles.length, results };
}
function validateTask(task) {
  if (!task || typeof task.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(task.id)) throw new Error("\u9898\u76EE\u7F16\u53F7\u65E0\u6548");
  if (typeof task.title !== "string" || !task.title.trim() || task.title.length > 200)
    throw new Error("\u9898\u76EE\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u4E14\u6700\u591A 200 \u5B57");
  if (typeof task.prompt !== "string" || !task.prompt.trim() || task.prompt.length > 1e5)
    throw new Error("\u63D0\u793A\u8BCD\u4E0D\u80FD\u4E3A\u7A7A\u4E14\u6700\u591A 100000 \u5B57");
  if (task.input !== void 0 && (typeof task.input !== "string" || task.input.length > 1e5))
    throw new Error("\u56FA\u5B9A\u8F93\u5165\u8FC7\u957F\u6216\u683C\u5F0F\u9519\u8BEF");
  if (!["svg", "html", "code"].includes(task.category) || !["svg", "html", "code", "json"].includes(task.outputType))
    throw new Error("\u9898\u76EE\u7C7B\u578B\u65E0\u6548");
  if (!Array.isArray(task.rubric) || task.rubric.length !== 3) throw new Error("\u8BF7\u586B\u5199\u4E09\u4E2A\u8BC4\u4EF7\u9879");
  const rubricIds = /* @__PURE__ */ new Set();
  for (const item of task.rubric) {
    if (!item || typeof item.id !== "string" || !item.id || rubricIds.has(item.id) || typeof item.label !== "string" || !item.label.trim() || typeof item.description !== "string")
      throw new Error("\u8BC4\u4EF7\u9879\u683C\u5F0F\u9519\u8BEF\u6216\u7F16\u53F7\u91CD\u590D");
    rubricIds.add(item.id);
  }
  if (!Array.isArray(task.checks) || task.checks.length > 30) throw new Error("\u68C0\u67E5\u9879\u683C\u5F0F\u9519\u8BEF");
  for (const check of task.checks) {
    if (!check || typeof check.id !== "string" || !check.id || typeof check.label !== "string" || typeof check.kind !== "string" || !check.kind)
      throw new Error("\u68C0\u67E5\u9879\u683C\u5F0F\u9519\u8BEF");
  }
  if (task.source && (typeof task.source.label !== "string" || typeof task.source.url !== "string" || !/^https?:\/\//i.test(task.source.url)))
    throw new Error("\u9898\u76EE\u6765\u6E90\u94FE\u63A5\u5FC5\u987B\u4E3A HTTP \u6216 HTTPS");
}
class EvaluationService {
  store;
  builtinTasks;
  listModels;
  invoke;
  check;
  concurrency;
  timeoutMs;
  active = /* @__PURE__ */ new Map();
  closing = false;
  constructor(options = {}) {
    const agentDir = options.agentDir ?? getAgentDir();
    this.store = new EvaluationStore(agentDir);
    this.builtinTasks = options.builtinTasks ?? BUILTIN_EVALUATION_TASKS;
    const access = createEvaluationModelAccess(agentDir);
    this.listModels = options.listModels ?? access.listModels;
    this.invoke = options.invoke ?? access.invoke;
    this.check = options.check ?? checkEvaluationArtifact;
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 2));
    this.timeoutMs = options.timeoutMs ?? 6e5;
  }
  async handle(request) {
    if (this.closing) throw new Error("\u6A21\u578B\u6D4B\u8BC4\u670D\u52A1\u6B63\u5728\u5173\u95ED");
    switch (request.action) {
      case "bootstrap":
        return {
          tasks: this.tasks(),
          models: await this.listModels(),
          runs: this.store.listRuns().map(runSummary)
        };
      case "task.save": {
        validateTask(request.task);
        if (this.builtinTasks.some((task2) => task2.id === request.task.id))
          throw new Error("\u5185\u7F6E\u9898\u53EA\u5141\u8BB8\u590D\u5236\u540E\u4FEE\u6539");
        const old = this.store.listTasks().find((task2) => task2.id === request.task.id);
        const task = {
          id: request.task.id,
          title: request.task.title.trim(),
          category: request.task.category,
          outputType: request.task.outputType,
          prompt: request.task.prompt,
          ...request.task.input === void 0 ? {} : { input: request.task.input },
          ...request.task.source ? { source: { label: request.task.source.label, url: request.task.source.url } } : {},
          rubric: request.task.rubric.map((item) => ({
            id: item.id,
            label: item.label,
            description: item.description
          })),
          checks: request.task.checks.map((item) => ({
            id: item.id,
            label: item.label,
            kind: item.kind,
            ...item.config ? { config: structuredClone(item.config) } : {}
          })),
          builtin: false,
          version: (old?.version ?? 0) + 1
        };
        this.store.saveTask(task);
        return task;
      }
      case "run.start":
        return this.start(request);
      case "run.list":
        return this.store.listRuns().map(runSummary);
      case "run.get":
        return evaluationRunView(this.store.getRun(request.runId));
      case "run.cancel": {
        const run = this.store.getRun(request.runId);
        for (const result of run.results) {
          if (result.status === "queued") {
            result.status = "cancelled";
            result.error = "\u7528\u6237\u53D6\u6D88\u6D4B\u8BC4";
            result.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
          }
          if (result.status === "running") this.active.get(result.id)?.controller.abort(new Error("\u7528\u6237\u53D6\u6D88\u6D4B\u8BC4"));
        }
        run.status = "cancelled";
        this.persist(run);
        return evaluationRunView(run);
      }
      case "run.append": {
        const run = this.store.getRun(request.runId);
        if (![3, 5].includes(request.samples) || request.samples <= run.samples)
          throw new Error("\u8FFD\u52A0\u6B21\u6570\u5FC5\u987B\u4E3A 3 \u6216 5\uFF0C\u4E14\u5927\u4E8E\u5F53\u524D\u6B21\u6570");
        for (let sample = run.samples + 1; sample <= request.samples; sample++) this.addSample(run, sample);
        run.samples = request.samples;
        run.status = "running";
        this.persist(run);
        queueMicrotask(() => this.pump());
        return evaluationRunView(run);
      }
      case "run.retry": {
        const run = this.store.getRun(request.runId);
        const previous = run.results.find((result2) => result2.id === request.resultId);
        if (!previous || previous.status === "queued" || previous.status === "running")
          throw new Error("\u8BE5\u7ED3\u679C\u8FD8\u5728\u8FD0\u884C\u6216\u4E0D\u5B58\u5728");
        const group = run.groups.find(
          (entry) => entry.taskId === previous.taskId && entry.sample === previous.sample
        );
        if (!group) throw new Error("\u7ED3\u679C\u5206\u7EC4\u4E0D\u5B58\u5728");
        const result = this.newResult(
          previous.taskId,
          previous.profileId,
          previous.sample,
          previous.attempt + 1,
          previous.id
        );
        run.results.push(result);
        group.resultIds.push(result.id);
        run.status = "running";
        this.persist(run);
        queueMicrotask(() => this.pump());
        return evaluationRunView(run);
      }
      case "run.reveal":
        return this.reveal(request);
      case "conversation.send":
        return this.sendFollowup(request);
      case "conversation.cancel": {
        const run = this.store.getRun(request.runId);
        const result = run.results.find((entry) => entry.id === request.resultId);
        const turn = result?.followups?.find((entry) => entry.id === request.followupId);
        if (!turn) throw new Error("\u8FFD\u95EE\u4E0D\u5B58\u5728");
        if (turn.status === "queued") {
          turn.status = "cancelled";
          turn.error = "\u7528\u6237\u505C\u6B62\u8FFD\u95EE";
          turn.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
          delete turn.generationPhase;
          this.persist(run);
        } else if (turn.status === "running") {
          this.active.get(turn.id)?.controller.abort(new Error("\u7528\u6237\u505C\u6B62\u8FFD\u95EE"));
        }
        return evaluationRunView(run);
      }
      default:
        throw new Error("\u672A\u77E5\u6A21\u578B\u6D4B\u8BC4\u8BF7\u6C42");
    }
  }
  tasks() {
    return structuredClone([...this.builtinTasks, ...this.store.listTasks()]);
  }
  async start(request) {
    if (![1, 3, 5].includes(request.samples)) throw new Error("\u91C7\u6837\u6B21\u6570\u5FC5\u987B\u4E3A 1\u30013 \u6216 5");
    if (typeof request.name !== "string" || !request.name.trim() || request.name.length > 200)
      throw new Error("\u8BF7\u586B\u5199\u6D4B\u8BC4\u540D\u79F0\uFF0C\u6700\u591A 200 \u5B57");
    if (!Array.isArray(request.taskIds) || !request.taskIds.length || request.taskIds.length > 30 || new Set(request.taskIds).size !== request.taskIds.length)
      throw new Error("\u8BF7\u9009\u62E9 1 \u81F3 30 \u9053\u9898\u76EE");
    if (!Array.isArray(request.profiles) || !request.profiles.length || request.profiles.length > 12)
      throw new Error("\u8BF7\u9009\u62E9 1 \u81F3 12 \u4E2A\u6A21\u578B\u914D\u7F6E");
    const tasks = request.taskIds.map((id) => {
      const task = this.tasks().find((entry) => entry.id === id);
      if (!task) throw new Error("\u9898\u76EE\u5DF2\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u9898\u5E93");
      return task;
    });
    const models = await this.listModels();
    const ids = /* @__PURE__ */ new Set();
    const configurations = /* @__PURE__ */ new Set();
    const profiles = request.profiles.map((input) => {
      const model = models.find((entry) => entry.provider === input.provider && entry.modelId === input.modelId);
      if (!model || !model.supportedThinkingLevels.includes(input.thinkingLevel))
        throw new Error("\u6A21\u578B\u4E0D\u53EF\u7528\u6216\u601D\u8003\u6863\u4F4D\u4E0D\u652F\u6301\uFF0C\u8BF7\u5237\u65B0\u914D\u7F6E");
      if (typeof input.id !== "string" || !input.id || ids.has(input.id)) throw new Error("\u6A21\u578B\u914D\u7F6E\u7F16\u53F7\u91CD\u590D\u6216\u65E0\u6548");
      const key = `${input.provider}\0${input.modelId}\0${input.thinkingLevel}`;
      if (configurations.has(key)) throw new Error("\u540C\u4E00\u4E2A\u6A21\u578B\u4E0E\u601D\u8003\u6863\u4F4D\u4E0D\u80FD\u91CD\u590D\u9009\u62E9");
      ids.add(input.id);
      configurations.add(key);
      return {
        id: input.id,
        provider: input.provider,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
        model: structuredClone(model),
        maxTokens: Math.min(model.maxTokens, 32768),
        timeoutMs: this.timeoutMs
      };
    });
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const run = {
      id: randomUUID(),
      name: request.name.trim(),
      createdAt: now,
      updatedAt: now,
      status: "running",
      samples: request.samples,
      tasks,
      profiles,
      results: [],
      groups: []
    };
    for (let sample = 1; sample <= request.samples; sample++) this.addSample(run, sample);
    this.store.saveRun(run);
    queueMicrotask(() => this.pump());
    return evaluationRunView(run);
  }
  newResult(taskId, profileId, sample, attempt, retryOf) {
    return {
      id: randomUUID(),
      taskId,
      profileId,
      sample,
      attempt,
      retryOf,
      status: "queued",
      output: "",
      thinking: "",
      generationPhase: "waiting",
      artifact: null,
      checks: [],
      error: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      usage: null,
      costUsd: null,
      rating: null
    };
  }
  addSample(run, sample) {
    for (const task of run.tasks) {
      const group = { taskId: task.id, sample, resultIds: [], revealed: false };
      for (const profile of run.profiles) {
        const result = this.newResult(task.id, profile.id, sample, 1, null);
        run.results.push(result);
        group.resultIds.push(result.id);
      }
      for (let index = group.resultIds.length - 1; index > 0; index--) {
        const other = randomInt(index + 1);
        [group.resultIds[index], group.resultIds[other]] = [group.resultIds[other], group.resultIds[index]];
      }
      run.groups.push(group);
    }
  }
  reveal(request) {
    const run = this.store.getRun(request.runId);
    const group = run.groups.find((entry) => entry.taskId === request.taskId && entry.sample === request.sample);
    if (!group) throw new Error("\u9898\u76EE\u5206\u7EC4\u4E0D\u5B58\u5728");
    const results = run.results.filter((result) => group.resultIds.includes(result.id));
    if (results.some((result) => result.status === "queued" || result.status === "running"))
      throw new Error("\u8BF7\u7B49\u8FD9\u4E00\u9898\u7684\u6240\u6709\u7ED3\u679C\u5B8C\u6210\u540E\u518D\u63ED\u6653");
    if (request.mode === "score") {
      const task = run.tasks.find((entry) => entry.id === request.taskId);
      if (!task) throw new Error("\u9898\u76EE\u4E0D\u5B58\u5728");
      const validated = /* @__PURE__ */ new Map();
      for (const result of results.filter((entry) => entry.status === "completed")) {
        const rating = request.ratings?.[result.id] ?? result.rating;
        if (!rating || !rating.scores || typeof rating.note !== "string" || rating.note.length > 1e4)
          throw new Error("\u8BF7\u5B8C\u6210\u6240\u6709\u6210\u529F\u7ED3\u679C\u7684\u5206\u9879\u8BC4\u5206");
        if (Object.keys(rating.scores).length !== task.rubric.length || task.rubric.some(
          (item) => !Number.isInteger(rating.scores[item.id]) || rating.scores[item.id] < 1 || rating.scores[item.id] > 5
        ))
          throw new Error("\u6BCF\u9879\u8BC4\u5206\u5FC5\u987B\u4E3A 1 \u81F3 5 \u7684\u6574\u6570");
        validated.set(result.id, structuredClone(rating));
      }
      for (const result of results) result.rating = validated.get(result.id) ?? result.rating;
    } else if (request.mode !== "skip") throw new Error("\u63ED\u6653\u65B9\u5F0F\u65E0\u6548");
    group.revealed = true;
    this.persist(run);
    return evaluationRunView(run);
  }
  persist(run) {
    run.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.store.saveRun(run);
  }
  conversation(result, turn) {
    const earlier = (result.followups ?? []).slice(
      0,
      (result.followups ?? []).findIndex((entry) => entry.id === turn.id)
    );
    return {
      originalAnswer: result.output,
      turns: earlier.filter((entry) => entry.status === "completed" && entry.output.trim()).map((entry) => ({ prompt: entry.prompt, output: entry.output })),
      prompt: turn.prompt
    };
  }
  sendFollowup(request) {
    if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 1e4)
      throw new Error("\u8FFD\u95EE\u4E0D\u80FD\u4E3A\u7A7A\u4E14\u6700\u591A 10000 \u5B57");
    const run = this.store.getRun(request.runId);
    const result = run.results.find((entry) => entry.id === request.resultId);
    if (!result || result.status === "queued" || result.status === "running" || !result.output.trim())
      throw new Error("\u8BF7\u7B49\u9996\u6B21\u4F5C\u7B54\u7ED3\u675F\u4E14\u6536\u5230\u6B63\u6587\u540E\u518D\u8FFD\u95EE");
    const previous = result.followups ?? [];
    if (previous.some((turn2) => turn2.status === "queued" || turn2.status === "running"))
      throw new Error("\u8FD9\u6BB5\u4F1A\u8BDD\u5DF2\u6709\u8FFD\u95EE\u6B63\u5728\u751F\u6210");
    if (previous.length >= 20) throw new Error("\u6BCF\u6BB5\u4F1A\u8BDD\u6700\u591A\u8FFD\u95EE 20 \u6B21\uFF0C\u8BF7\u65B0\u5EFA\u6D4B\u8BC4\u7EE7\u7EED");
    const task = run.tasks.find((entry) => entry.id === result.taskId);
    const profile = run.profiles.find((entry) => entry.id === result.profileId);
    if (!task || !profile) throw new Error("\u9898\u76EE\u6216\u6A21\u578B\u5FEB\u7167\u4E22\u5931");
    const turn = {
      id: randomUUID(),
      prompt: request.prompt.trim(),
      status: "queued",
      output: "",
      thinking: "",
      generationPhase: "waiting",
      artifact: null,
      checks: [],
      error: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      usage: null,
      costUsd: null
    };
    const conversation = {
      originalAnswer: result.output,
      turns: previous.filter((entry) => entry.status === "completed" && entry.output.trim()).map((entry) => ({ prompt: entry.prompt, output: entry.output })),
      prompt: turn.prompt
    };
    validateEvaluationConversation(profile, task, conversation);
    result.followups = [...previous, turn];
    this.persist(run);
    queueMicrotask(() => this.pump());
    return evaluationRunView(run);
  }
  pump() {
    if (this.closing) return;
    while (this.active.size < this.concurrency) {
      const runs = this.store.listRuns();
      let run;
      let result;
      let followup;
      for (const entry of runs) {
        const candidate = entry.results.find(
          (original) => original.followups?.some((turn) => turn.status === "queued")
        );
        if (!candidate) continue;
        run = entry;
        result = candidate;
        followup = candidate.followups?.find((turn) => turn.status === "queued");
        break;
      }
      if (!result) {
        run = runs.find(
          (entry) => entry.status === "running" && entry.results.some((item) => item.status === "queued")
        );
        result = run?.results.find((entry) => entry.status === "queued");
      }
      if (!run || !result) return;
      const target = followup ?? result;
      const controller = new AbortController();
      target.status = "running";
      target.startedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.persist(run);
      const promise = this.execute(run, result, controller, followup).finally(() => {
        this.active.delete(target.id);
        this.pump();
      });
      this.active.set(target.id, { controller, promise });
      void promise.catch(() => {
      });
    }
  }
  async execute(run, original, controller, followup) {
    const result = followup ?? original;
    const started = Date.now();
    let lastSave = 0;
    let timedOut = false;
    let acceptingPartials = true;
    let generationEnded;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        controller.abort(new Error("\u6A21\u578B\u6D4B\u8BC4\u8BF7\u6C42\u8D85\u65F6"));
      },
      run.profiles.find((profile) => profile.id === original.profileId)?.timeoutMs ?? this.timeoutMs
    );
    let onAbort;
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const task = run.tasks.find((entry) => entry.id === original.taskId);
      const profile = run.profiles.find((entry) => entry.id === original.profileId);
      if (!task || !profile) throw new Error("\u9898\u76EE\u6216\u6A21\u578B\u5FEB\u7167\u4E22\u5931");
      const invoked = await Promise.race([
        this.invoke({
          task: structuredClone(task),
          profile: structuredClone(profile),
          ...followup ? { conversation: this.conversation(original, followup) } : {},
          signal: controller.signal,
          onPartial: (text, thinking) => {
            if (controller.signal.aborted || !acceptingPartials) return;
            result.output = text;
            result.thinking = thinking;
            result.generationPhase = text ? "answering" : thinking ? "thinking" : "waiting";
            if (Date.now() - lastSave > 500) {
              lastSave = Date.now();
              this.persist(run);
            }
          }
        }),
        aborted
      ]);
      acceptingPartials = false;
      generationEnded = Date.now();
      controller.signal.throwIfAborted();
      result.output = invoked.text;
      result.thinking = invoked.thinking;
      result.usage = invoked.usage;
      result.costUsd = invoked.costUsd;
      result.actualModel = invoked.actualModel;
      if (invoked.stopReason !== "stop") {
        throw new Error(
          invoked.error ?? (invoked.stopReason === "length" ? "\u8F93\u51FA\u8FBE\u5230\u957F\u5EA6\u9650\u5236\uFF0C\u7B54\u6848\u53EF\u80FD\u4E0D\u5B8C\u6574" : `\u751F\u6210\u672A\u6B63\u5E38\u5B8C\u6210\uFF1A${invoked.stopReason}`)
        );
      }
      if (!result.output.trim()) throw new Error("\u6A21\u578B\u672A\u8F93\u51FA\u7B54\u6848");
      const previewTask = followup ? {
        ...task,
        id: `conversation-${task.id}`,
        builtin: false,
        checks: task.checks.filter((spec) => ["format", "safe", "render"].includes(spec.kind))
      } : task;
      const artifactCandidate = followup ? extractEvaluationArtifact(previewTask, result.output) : null;
      let validJson = false;
      if (artifactCandidate?.type === "json") {
        try {
          JSON.parse(artifactCandidate.content);
          validJson = true;
        } catch {
        }
      }
      const containsArtifact = !followup || artifactCandidate !== null && (task.outputType === "svg" || task.outputType === "html" || validJson || /```/.test(result.output));
      if (containsArtifact) {
        result.generationPhase = "checking";
        this.persist(run);
        const checked = await Promise.race([this.check(previewTask, result.output, controller.signal), aborted]);
        controller.signal.throwIfAborted();
        result.artifact = checked.artifact;
        result.checks = checked.checks;
      }
      result.status = "completed";
    } catch (error) {
      result.status = controller.signal.aborted && !timedOut ? this.closing ? "interrupted" : "cancelled" : "failed";
      result.error = timedOut ? "\u6A21\u578B\u6D4B\u8BC4\u8BF7\u6C42\u8D85\u65F6" : error instanceof Error ? error.message : String(error);
    } finally {
      acceptingPartials = false;
      clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      result.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      result.durationMs = (generationEnded ?? Date.now()) - started;
      delete result.generationPhase;
      if (!followup && !run.results.some((entry) => entry.status === "queued" || entry.status === "running")) {
        if (run.status === "running") run.status = this.closing ? "interrupted" : "completed";
      }
      this.persist(run);
    }
  }
  async close() {
    this.closing = true;
    for (const run of this.store.listRuns()) {
      let changed = false;
      for (const result of run.results) {
        if (result.status === "queued") {
          result.status = "interrupted";
          result.error = "\u5E94\u7528\u5173\u95ED\uFF0C\u6D4B\u8BC4\u4E2D\u65AD";
          result.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
          delete result.generationPhase;
          changed = true;
        }
        for (const turn of result.followups ?? []) {
          if (turn.status !== "queued") continue;
          turn.status = "interrupted";
          turn.error = "\u5E94\u7528\u5173\u95ED\uFF0C\u8FFD\u95EE\u4E2D\u65AD";
          turn.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
          delete turn.generationPhase;
          changed = true;
        }
      }
      if (run.status === "running") {
        run.status = "interrupted";
        changed = true;
      }
      if (changed) this.persist(run);
    }
    for (const { controller } of this.active.values()) controller.abort(new Error("\u5E94\u7528\u5173\u95ED\uFF0C\u6D4B\u8BC4\u4E2D\u65AD"));
    await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
  }
}
export {
  EvaluationService,
  evaluationRunView
};
