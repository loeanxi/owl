/**
 * 自动化任务调度服务（桥命令 schedule.*）。
 *
 * 对应 DSH 的 schedule 三件套里的「任务调度」+「时间感知」：任务落盘在
 * ~/.owl/agent/schedule/tasks.json，跨重启存活；桥进程内 15s 一跳，到点把
 * 提示词（带「现在几点」前缀）作为普通跟进消息送回目标会话——与手打消息
 * 同一条链路（session.prompt + followUp），不另起通知通道。
 *
 * 会话未挂载时的行为由任务的错过策略决定：
 * - catch-up（打开时补跑）：记一条 pending 运行，目标会话挂载时立即补投；
 * - skip：跳过这次，直接推进到下一个合法时刻；
 * - wake：进程内等同 catch-up（真正的系统级唤醒需要 OS 计划任务，后续接）。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	describeRepeat,
	formatLocal,
	isExpired,
	nextRunAt,
	type ScheduleRepeat,
	validateRepeat,
} from "./schedule-cron.ts";

export interface ScheduleTask {
	id: string;
	name: string;
	/** 任务卡 emoji（演示数据 🌱📮📊；空则 UI 回退默认图标）。 */
	emoji: string;
	/** 到点执行的提示词；可含 / 命令。 */
	prompt: string;
	/** 投递目标会话；"__new__" 表示每次开新会话（v1 先要求具体会话）。 */
	sessionId: string;
	/** 目标的展示名（创建时由 UI 带入会话标题，任务卡直接显示）。 */
	targetLabel: string;
	repeat: ScheduleRepeat;
	missed: "catch-up" | "skip" | "wake";
	enabled: boolean;
	createdAt: number;
	/** 下一次应跑时刻；一次性完成后置 null。 */
	nextRunAt: number | null;
	lastRunAt: number | null;
}

export interface ScheduleRun {
	id: string;
	taskId: string;
	/** 计划触发时刻。 */
	scheduledAt: number;
	/** 实际投递时刻（补跑时晚于 scheduledAt）。 */
	deliveredAt: number | null;
	status: "ok" | "error" | "skipped" | "pending";
	/** 投递耗时（ms）。 */
	durationMs?: number;
	/** 实际投递到的会话 id（跟投原会话或另起新会话时记录）。 */
	sessionId?: string;
	/** 人类可读备注（失败原因 / 补跑标记 / 跳过原因）。 */
	note?: string;
}

export interface ScheduleListResult {
	tasks: ScheduleTask[];
	runs: Record<string, ScheduleRun[]>;
}

interface ScheduleStore {
	version: 1;
	tasks: ScheduleTask[];
	runs: Record<string, ScheduleRun[]>;
}

const MAX_RUNS_PER_TASK = 20;
const TICK_MS = 15_000;

export interface ScheduleServiceOptions {
	agentDir: string;
	now?: () => number;
	/** 跳表间隔；生产 15s，测试可调小。 */
	tickMs?: number;
	/**
	 * 投递一条到点消息。返回实际收到消息的会话 id（"__new__" 任务由桥端新建会话，
	 * 返回新建 id）；会话不可达（未挂载且无法新建）返回 null，由错过策略接手。
	 */
	deliver: (sessionId: string, text: string) => Promise<string | null>;
	onDiagnostic?: (message: string) => void;
	onChanged?: () => void;
}

/**
 * 投递给模型的文本：机器可读任务标记 + 时间感知前缀（模型不用猜「现在几点」）
 * + 原提示词。〔owl-schedule:<id>〕标记随消息一起落盘，桌面端 ChatStream 靠它
 * 把这条用户消息渲染成会话内任务卡（可暂停）；旧消息没有标记也能兜底解析。
 */
export function deliveryText(task: ScheduleTask, now: number): string {
	const prefix = `〔owl-schedule:${task.id}〕（自动化任务「${task.name}」到点执行 · ${describeRepeat(task.repeat)} · 现在 ${formatLocal(now)}）`;
	return `${prefix}\n\n${task.prompt}`;
}

export class ScheduleService {
	private readonly file: string;
	private readonly now: () => number;
	private readonly deliver: (sessionId: string, text: string) => Promise<string | null>;
	private readonly tickMs: number;
	private readonly onDiagnostic?: (message: string) => void;
	private readonly onChanged?: () => void;
	private store: ScheduleStore = { version: 1, tasks: [], runs: {} };
	private timer: ReturnType<typeof setInterval> | null = null;
	private ticking = false;
	private started = false;

	constructor(options: ScheduleServiceOptions) {
		this.file = join(options.agentDir, "schedule", "tasks.json");
		this.now = options.now ?? Date.now;
		this.tickMs = options.tickMs ?? TICK_MS;
		this.deliver = options.deliver;
		this.onDiagnostic = options.onDiagnostic;
		this.onChanged = options.onChanged;
	}

	/** 读盘 + 应用错过策略 + 启动跳表；幂等。 */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.load();
		const now = this.now();
		let dirty = false;
		for (const task of this.store.tasks) {
			if (!task.enabled || task.nextRunAt === null || task.nextRunAt > now) continue;
			// 桥进程没开着错过的运行：按策略处理（wake 在进程内等同 catch-up）。
			if (task.missed === "skip") {
				this.pushRun(task.id, {
					id: randomUUID(),
					taskId: task.id,
					scheduledAt: task.nextRunAt,
					deliveredAt: null,
					status: "skipped",
					note: "owl 没开着，按策略跳过",
				});
				task.nextRunAt = nextRunAt(task.repeat, now);
				if (task.nextRunAt === null) task.enabled = false;
				dirty = true;
			} else {
				// catch-up：保留原计划时刻记 pending，等目标会话挂载时补投。
				this.pushRun(task.id, {
					id: randomUUID(),
					taskId: task.id,
					scheduledAt: task.nextRunAt,
					deliveredAt: null,
					status: "pending",
					note: "错过待补投（等会话打开）",
				});
				task.nextRunAt = nextRunAt(task.repeat, now);
				if (task.nextRunAt === null) task.enabled = false;
				dirty = true;
			}
		}
		if (dirty) this.save();
		this.timer = setInterval(() => void this.tick(), this.tickMs);
		void this.tick();
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		this.started = false;
	}

	/** 会话挂载（resume/create）时调用：把 pending 的补投立即送出去。 */
	async onSessionMounted(sessionId: string): Promise<void> {
		const now = this.now();
		for (const task of this.store.tasks) {
			if (task.sessionId !== sessionId) continue;
			const pending = (this.store.runs[task.id] ?? []).find((run) => run.status === "pending");
			if (!pending) continue;
			await this.deliverRun(task, pending, now);
		}
	}

	// ── 桥命令 ────────────────────────────────────────────────────

	list(): ScheduleListResult {
		this.load();
		return { tasks: this.store.tasks, runs: this.store.runs };
	}

	create(input: {
		name: string;
		prompt: string;
		sessionId: string;
		targetLabel: string;
		repeat: ScheduleRepeat;
		missed?: ScheduleTask["missed"];
		emoji?: string;
	}): ScheduleTask {
		const error = this.validateInput(input);
		if (error) throw new Error(error);
		const now = this.now();
		const task: ScheduleTask = {
			id: randomUUID(),
			name: input.name.trim(),
			emoji: input.emoji?.trim() ?? "",
			prompt: input.prompt.trim(),
			sessionId: input.sessionId,
			targetLabel: input.targetLabel.trim(),
			repeat: input.repeat,
			missed: input.missed ?? "catch-up",
			enabled: true,
			createdAt: now,
			nextRunAt: nextRunAt(input.repeat, now),
			lastRunAt: null,
		};
		this.store.tasks.push(task);
		this.save();
		this.onChanged?.();
		return task;
	}

	update(input: Partial<ScheduleTask> & { id: string }): ScheduleTask {
		const task = this.store.tasks.find((candidate) => candidate.id === input.id);
		if (!task) throw new Error("任务不存在");
		const next: ScheduleTask = {
			...task,
			...input,
			repeat: input.repeat ?? task.repeat,
		};
		if (input.repeat !== undefined) {
			const error = validateRepeat(input.repeat);
			if (error) throw new Error(error);
		}
		if (!next.enabled) {
			// 暂停不推进时刻；恢复时从当下重新计算。
		} else if (input.enabled === true && task.enabled === false) {
			next.nextRunAt = isExpired(next.repeat, this.now()) ? null : nextRunAt(next.repeat, this.now());
		} else if (input.repeat !== undefined || next.nextRunAt === null) {
			next.nextRunAt = isExpired(next.repeat, this.now()) ? null : nextRunAt(next.repeat, this.now());
		}
		Object.assign(task, next);
		this.save();
		this.onChanged?.();
		return task;
	}

	remove(id: string): void {
		const before = this.store.tasks.length;
		this.store.tasks = this.store.tasks.filter((task) => task.id !== id);
		delete this.store.runs[id];
		if (this.store.tasks.length === before) throw new Error("任务不存在");
		this.save();
		this.onChanged?.();
	}

	/** 立即运行：不等时刻，直接投递一次（不改 nextRunAt）。 */
	async runNow(id: string): Promise<ScheduleRun> {
		const task = this.store.tasks.find((candidate) => candidate.id === id);
		if (!task) throw new Error("任务不存在");
		const run: ScheduleRun = {
			id: randomUUID(),
			taskId: id,
			scheduledAt: this.now(),
			deliveredAt: null,
			status: "pending",
			note: "手动立即运行",
		};
		this.pushRun(id, run);
		await this.deliverRun(task, run, this.now());
		return run;
	}

	history(taskId: string): ScheduleRun[] {
		return this.store.runs[taskId] ?? [];
	}

	// ── 内部 ──────────────────────────────────────────────────────

	private async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const now = this.now();
			const due = this.store.tasks.filter(
				(task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now,
			);
			for (const task of due) {
				const scheduledAt = task.nextRunAt!;
				const run: ScheduleRun = {
					id: randomUUID(),
					taskId: task.id,
					scheduledAt,
					deliveredAt: null,
					status: "pending",
				};
				this.pushRun(task.id, run);
				await this.deliverRun(task, run, now);
				// 一次性到点即完成。
				if (task.repeat.kind === "once") {
					task.enabled = false;
					task.nextRunAt = null;
				} else {
					task.nextRunAt = nextRunAt(task.repeat, this.now());
					if (task.nextRunAt === null) task.enabled = false;
				}
			}
			if (due.length > 0) {
				this.save();
				this.onChanged?.();
			}
		} catch (error) {
			this.onDiagnostic?.(`schedule tick failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.ticking = false;
		}
	}

	/** 投递一次并落历史；会话不在线时按策略收尾（catch-up 留 pending 等 mount）。 */
	private async deliverRun(task: ScheduleTask, run: ScheduleRun, now: number): Promise<void> {
		const startedAt = this.now();
		try {
			const target = await this.deliver(task.sessionId, deliveryText(task, now));
			if (target !== null) {
				run.status = "ok";
				run.deliveredAt = this.now();
				run.durationMs = Math.max(0, this.now() - startedAt);
				run.sessionId = target;
				task.lastRunAt = run.deliveredAt;
				if (target !== task.sessionId) run.note = `新会话 ${target.slice(0, 8)}`;
			} else {
				// 会话未挂载：catch-up/wake 留 pending 等挂载补投；skip 直接跳过。
				if (task.missed === "skip") {
					run.status = "skipped";
					run.note = "会话没开着，按策略跳过";
				} else {
					run.status = "pending";
					run.note = run.note ?? "等会话打开后补投";
				}
			}
		} catch (error) {
			run.status = "error";
			run.deliveredAt = this.now();
			run.note = error instanceof Error ? error.message : String(error);
		}
		this.save();
		this.onChanged?.();
	}

	private pushRun(taskId: string, run: ScheduleRun): void {
		const runs = this.store.runs[taskId] ?? [];
		runs.unshift(run);
		this.store.runs[taskId] = runs.slice(0, MAX_RUNS_PER_TASK);
		this.save();
	}

	private validateInput(input: {
		name: string;
		prompt: string;
		sessionId: string;
		targetLabel: string;
		repeat: ScheduleRepeat;
	}): string | null {
		if (!input.name?.trim()) return "任务名不能为空";
		if (!input.prompt?.trim()) return "提示词不能为空";
		if (!input.sessionId?.trim()) return "投递目标会话不能为空";
		if (!input.targetLabel?.trim()) return "投递目标会话缺少展示名";
		return validateRepeat(input.repeat);
	}

	private load(): void {
		try {
			if (!existsSync(this.file)) return;
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as ScheduleStore;
			if (raw.version !== 1 || !Array.isArray(raw.tasks)) return;
			this.store = { version: 1, tasks: raw.tasks, runs: raw.runs ?? {} };
		} catch (error) {
			this.onDiagnostic?.(`schedule store load failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private save(): void {
		try {
			mkdirSync(join(this.file, ".."), { recursive: true });
			writeFileSync(this.file, JSON.stringify(this.store, null, "\t"));
		} catch (error) {
			this.onDiagnostic?.(`schedule store save failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
