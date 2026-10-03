import { randomInt, randomUUID } from "node:crypto";
import { getAgentDir } from "../../config.ts";
import { checkEvaluationArtifact } from "./checkers.ts";
import { createEvaluationModelAccess, type EvaluationInvocationResult, type EvaluationInvoker } from "./model.ts";
import { EvaluationStore } from "./store.ts";
import { BUILTIN_EVALUATION_TASKS } from "./tasks.ts";
import type {
	EvaluationArtifact,
	EvaluationCheck,
	EvaluationGroup,
	EvaluationModel,
	EvaluationProfile,
	EvaluationRating,
	EvaluationRequest,
	EvaluationResult,
	EvaluationResultView,
	EvaluationRun,
	EvaluationRunSummary,
	EvaluationRunView,
	EvaluationTask,
} from "./types.ts";

export interface EvaluationServiceOptions {
	agentDir?: string;
	builtinTasks?: EvaluationTask[];
	listModels?: () => Promise<EvaluationModel[]>;
	invoke?: EvaluationInvoker;
	check?: (
		task: EvaluationTask,
		output: string,
		signal?: AbortSignal,
	) => Promise<{ artifact: EvaluationArtifact | null; checks: EvaluationCheck[] }>;
	/** The production limit is two simultaneous model calls. */
	concurrency?: number;
	timeoutMs?: number;
}

function runSummary(run: EvaluationRun): EvaluationRunSummary {
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
		revealed: run.groups.filter((group) => group.revealed).length,
	};
}

/** The stored run contains identities; every browser response goes through this projection. */
export function evaluationRunView(run: EvaluationRun): EvaluationRunView {
	const results: EvaluationResultView[] = [];
	for (const group of run.groups) {
		for (const [index, id] of group.resultIds.entries()) {
			const result = run.results.find((entry) => entry.id === id);
			if (!result) continue;
			const { profileId, thinking, startedAt, finishedAt, durationMs, usage, costUsd, ...anonymous } = result;
			results.push({
				...structuredClone(anonymous),
				error: !group.revealed && result.error ? "本次生成未完成；揭晓后可查看详细原因" : result.error,
				anonymousLabel: `结果 ${String.fromCharCode(65 + index)}`,
				revealed: group.revealed,
				...(group.revealed
					? {
							profile: structuredClone(run.profiles.find((profile) => profile.id === profileId)),
							thinking,
							startedAt,
							finishedAt,
							durationMs,
							usage: structuredClone(usage),
							costUsd,
						}
					: {}),
			});
		}
	}
	const { profiles, results: _results, ...publicRun } = run;
	return { ...structuredClone(publicRun), profileCount: profiles.length, results };
}

function validateTask(task: EvaluationTask): void {
	if (!task || typeof task.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(task.id)) throw new Error("题目编号无效");
	if (typeof task.title !== "string" || !task.title.trim() || task.title.length > 200)
		throw new Error("题目名称不能为空且最多 200 字");
	if (typeof task.prompt !== "string" || !task.prompt.trim() || task.prompt.length > 100_000)
		throw new Error("提示词不能为空且最多 100000 字");
	if (task.input !== undefined && (typeof task.input !== "string" || task.input.length > 100_000))
		throw new Error("固定输入过长或格式错误");
	if (!["svg", "html", "code"].includes(task.category) || !["svg", "html", "code", "json"].includes(task.outputType))
		throw new Error("题目类型无效");
	if (!Array.isArray(task.rubric) || task.rubric.length !== 3) throw new Error("请填写三个评价项");
	const rubricIds = new Set<string>();
	for (const item of task.rubric) {
		if (
			!item ||
			typeof item.id !== "string" ||
			!item.id ||
			rubricIds.has(item.id) ||
			typeof item.label !== "string" ||
			!item.label.trim() ||
			typeof item.description !== "string"
		)
			throw new Error("评价项格式错误或编号重复");
		rubricIds.add(item.id);
	}
	if (!Array.isArray(task.checks) || task.checks.length > 30) throw new Error("检查项格式错误");
}

/** Durable background queue. Disconnecting or changing desktop pages does not stop model calls. */
export class EvaluationService {
	private readonly store: EvaluationStore;
	private readonly builtinTasks: EvaluationTask[];
	private readonly listModels: () => Promise<EvaluationModel[]>;
	private readonly invoke: EvaluationInvoker;
	private readonly check: NonNullable<EvaluationServiceOptions["check"]>;
	private readonly concurrency: number;
	private readonly timeoutMs: number;
	private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
	private closing = false;

	constructor(options: EvaluationServiceOptions = {}) {
		const agentDir = options.agentDir ?? getAgentDir();
		this.store = new EvaluationStore(agentDir);
		this.builtinTasks = options.builtinTasks ?? BUILTIN_EVALUATION_TASKS;
		const access = createEvaluationModelAccess(agentDir);
		this.listModels = options.listModels ?? access.listModels;
		this.invoke = options.invoke ?? access.invoke;
		this.check = options.check ?? checkEvaluationArtifact;
		this.concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 2));
		this.timeoutMs = options.timeoutMs ?? 600_000;
	}

	async handle(request: EvaluationRequest): Promise<unknown> {
		if (this.closing) throw new Error("模型测评服务正在关闭");
		switch (request.action) {
			case "bootstrap":
				return {
					tasks: this.tasks(),
					models: await this.listModels(),
					runs: this.store.listRuns().map(runSummary),
				};
			case "task.save": {
				validateTask(request.task);
				if (this.builtinTasks.some((task) => task.id === request.task.id))
					throw new Error("内置题只允许复制后修改");
				const old = this.store.listTasks().find((task) => task.id === request.task.id);
				const task: EvaluationTask = {
					...structuredClone(request.task),
					builtin: false,
					version: (old?.version ?? 0) + 1,
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
						result.error = "用户取消测评";
						result.finishedAt = new Date().toISOString();
					}
					if (result.status === "running") this.active.get(result.id)?.controller.abort(new Error("用户取消测评"));
				}
				run.status = "cancelled";
				this.persist(run);
				return evaluationRunView(run);
			}
			case "run.append": {
				const run = this.store.getRun(request.runId);
				if (![3, 5].includes(request.samples) || request.samples <= run.samples)
					throw new Error("追加次数必须为 3 或 5，且大于当前次数");
				for (let sample = run.samples + 1; sample <= request.samples; sample++) this.addSample(run, sample);
				run.samples = request.samples;
				run.status = "running";
				this.persist(run);
				queueMicrotask(() => this.pump());
				return evaluationRunView(run);
			}
			case "run.retry": {
				const run = this.store.getRun(request.runId);
				const previous = run.results.find((result) => result.id === request.resultId);
				if (!previous || previous.status === "queued" || previous.status === "running")
					throw new Error("该结果还在运行或不存在");
				const group = run.groups.find(
					(entry) => entry.taskId === previous.taskId && entry.sample === previous.sample,
				);
				if (!group) throw new Error("结果分组不存在");
				const result = this.newResult(
					previous.taskId,
					previous.profileId,
					previous.sample,
					previous.attempt + 1,
					previous.id,
				);
				run.results.push(result);
				// Keep earlier anonymous labels and order stable when an attempt is added.
				group.resultIds.push(result.id);
				// Previously exposed identities cannot be made blind again; retained attempts keep that fact.
				run.status = "running";
				this.persist(run);
				queueMicrotask(() => this.pump());
				return evaluationRunView(run);
			}
			case "run.reveal":
				return this.reveal(request);
			default:
				throw new Error("未知模型测评请求");
		}
	}

	private tasks(): EvaluationTask[] {
		return structuredClone([...this.builtinTasks, ...this.store.listTasks()]);
	}

	private async start(request: Extract<EvaluationRequest, { action: "run.start" }>): Promise<EvaluationRunView> {
		if (![1, 3, 5].includes(request.samples)) throw new Error("采样次数必须为 1、3 或 5");
		if (typeof request.name !== "string" || !request.name.trim() || request.name.length > 200)
			throw new Error("请填写测评名称，最多 200 字");
		if (
			!Array.isArray(request.taskIds) ||
			!request.taskIds.length ||
			request.taskIds.length > 30 ||
			new Set(request.taskIds).size !== request.taskIds.length
		)
			throw new Error("请选择 1 至 30 道题目");
		if (!Array.isArray(request.profiles) || !request.profiles.length || request.profiles.length > 12)
			throw new Error("请选择 1 至 12 个模型配置");
		const tasks = request.taskIds.map((id) => {
			const task = this.tasks().find((entry) => entry.id === id);
			if (!task) throw new Error("题目已不存在，请刷新题库");
			return task;
		});
		const models = await this.listModels();
		const ids = new Set<string>();
		const configurations = new Set<string>();
		const profiles: EvaluationProfile[] = request.profiles.map((input) => {
			const model = models.find((entry) => entry.provider === input.provider && entry.modelId === input.modelId);
			if (!model || !model.supportedThinkingLevels.includes(input.thinkingLevel))
				throw new Error("模型不可用或思考档位不支持，请刷新配置");
			if (typeof input.id !== "string" || !input.id || ids.has(input.id)) throw new Error("模型配置编号重复或无效");
			const key = `${input.provider}\0${input.modelId}\0${input.thinkingLevel}`;
			if (configurations.has(key)) throw new Error("同一个模型与思考档位不能重复选择");
			ids.add(input.id);
			configurations.add(key);
			return {
				...structuredClone(input),
				model: structuredClone(model),
				maxTokens: Math.min(model.maxTokens, 32_768),
				timeoutMs: this.timeoutMs,
			};
		});
		const now = new Date().toISOString();
		const run: EvaluationRun = {
			id: randomUUID(),
			name: request.name.trim(),
			createdAt: now,
			updatedAt: now,
			status: "running",
			samples: request.samples,
			tasks,
			profiles,
			results: [],
			groups: [],
		};
		for (let sample = 1; sample <= request.samples; sample++) this.addSample(run, sample);
		this.store.saveRun(run);
		queueMicrotask(() => this.pump());
		return evaluationRunView(run);
	}

	private newResult(
		taskId: string,
		profileId: string,
		sample: number,
		attempt: number,
		retryOf: string | null,
	): EvaluationResult {
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
			artifact: null,
			checks: [],
			error: null,
			startedAt: null,
			finishedAt: null,
			durationMs: null,
			usage: null,
			costUsd: null,
			rating: null,
		};
	}

	private addSample(run: EvaluationRun, sample: number): void {
		for (const task of run.tasks) {
			const group: EvaluationGroup = { taskId: task.id, sample, resultIds: [], revealed: false };
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

	private reveal(request: Extract<EvaluationRequest, { action: "run.reveal" }>): EvaluationRunView {
		const run = this.store.getRun(request.runId);
		const group = run.groups.find((entry) => entry.taskId === request.taskId && entry.sample === request.sample);
		if (!group) throw new Error("题目分组不存在");
		const results = run.results.filter((result) => group.resultIds.includes(result.id));
		if (results.some((result) => result.status === "queued" || result.status === "running"))
			throw new Error("请等这一题的所有结果完成后再揭晓");
		if (request.mode === "score") {
			const task = run.tasks.find((entry) => entry.id === request.taskId);
			if (!task) throw new Error("题目不存在");
			const validated = new Map<string, EvaluationRating>();
			for (const result of results.filter((entry) => entry.status === "completed")) {
				const rating = request.ratings?.[result.id] ?? result.rating;
				if (!rating || !rating.scores || typeof rating.note !== "string" || rating.note.length > 10_000)
					throw new Error("请完成所有成功结果的分项评分");
				if (
					Object.keys(rating.scores).length !== task.rubric.length ||
					task.rubric.some(
						(item) =>
							!Number.isInteger(rating.scores[item.id]) ||
							rating.scores[item.id] < 1 ||
							rating.scores[item.id] > 5,
					)
				)
					throw new Error("每项评分必须为 1 至 5 的整数");
				validated.set(result.id, structuredClone(rating));
			}
			for (const result of results) result.rating = validated.get(result.id) ?? result.rating;
		} else if (request.mode !== "skip") throw new Error("揭晓方式无效");
		group.revealed = true;
		this.persist(run);
		return evaluationRunView(run);
	}

	private persist(run: EvaluationRun): void {
		run.updatedAt = new Date().toISOString();
		this.store.saveRun(run);
	}

	private pump(): void {
		if (this.closing) return;
		while (this.active.size < this.concurrency) {
			const run = this.store
				.listRuns()
				.find((entry) => entry.status === "running" && entry.results.some((result) => result.status === "queued"));
			const result = run?.results.find((entry) => entry.status === "queued");
			if (!run || !result) return;
			const controller = new AbortController();
			result.status = "running";
			result.startedAt = new Date().toISOString();
			this.persist(run);
			const promise = this.execute(run, result, controller).finally(() => {
				this.active.delete(result.id);
				this.pump();
			});
			this.active.set(result.id, { controller, promise });
			// Disk failures are exceptional; terminate this work item without an unhandled rejection.
			void promise.catch(() => {});
		}
	}

	private async execute(run: EvaluationRun, result: EvaluationResult, controller: AbortController): Promise<void> {
		const started = Date.now();
		let lastSave = 0;
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error("模型测评请求超时"));
		}, this.timeoutMs);
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(controller.signal.reason);
			controller.signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const task = run.tasks.find((entry) => entry.id === result.taskId);
			const profile = run.profiles.find((entry) => entry.id === result.profileId);
			if (!task || !profile) throw new Error("题目或模型快照丢失");
			const invoked: EvaluationInvocationResult = await Promise.race([
				this.invoke({
					task: structuredClone(task),
					profile: structuredClone(profile),
					signal: controller.signal,
					onPartial: (text, thinking) => {
						if (controller.signal.aborted) return;
						result.output = text;
						result.thinking = thinking;
						if (Date.now() - lastSave > 500) {
							lastSave = Date.now();
							this.persist(run);
						}
					},
				}),
				aborted,
			]);
			controller.signal.throwIfAborted();
			result.output = invoked.text;
			result.thinking = invoked.thinking;
			result.usage = invoked.usage;
			result.costUsd = invoked.costUsd;
			if (invoked.stopReason !== "stop") {
				throw new Error(
					invoked.error ??
						(invoked.stopReason === "length"
							? "输出达到长度限制，答案可能不完整"
							: `生成未正常完成：${invoked.stopReason}`),
				);
			}
			if (!result.output.trim()) throw new Error("模型未输出答案");
			const checked = await Promise.race([this.check(task, result.output, controller.signal), aborted]);
			result.artifact = checked.artifact;
			result.checks = checked.checks;
			result.status = "completed";
		} catch (error) {
			result.status =
				controller.signal.aborted && !timedOut ? (this.closing ? "interrupted" : "cancelled") : "failed";
			result.error = timedOut ? "模型测评请求超时" : error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timeout);
			if (onAbort) controller.signal.removeEventListener("abort", onAbort);
			result.finishedAt = new Date().toISOString();
			result.durationMs = Date.now() - started;
			if (!run.results.some((entry) => entry.status === "queued" || entry.status === "running")) {
				if (run.status === "running") run.status = this.closing ? "interrupted" : "completed";
			}
			this.persist(run);
		}
	}

	async close(): Promise<void> {
		this.closing = true;
		for (const run of this.store.listRuns()) {
			if (run.status !== "running") continue;
			for (const result of run.results) {
				if (result.status === "queued") {
					result.status = "interrupted";
					result.error = "应用关闭，测评中断";
					result.finishedAt = new Date().toISOString();
				}
			}
			run.status = "interrupted";
			this.persist(run);
		}
		for (const { controller } of this.active.values()) controller.abort(new Error("应用关闭，测评中断"));
		await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
	}
}
