import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliveryText, type ScheduleRun, ScheduleService, type ScheduleTask } from "./schedule-service.ts";

/** 可手拨的假时钟 + 录制型投递器。 */
function harness(now: () => number) {
	const delivered: { sessionId: string; text: string }[] = [];
	const diagnostics: string[] = [];
	const dir = mkdtempSync(join(tmpdir(), "owl-schedule-"));
	let changed = 0;
	const service = new ScheduleService({
		agentDir: dir,
		tickMs: 5,
		now,
		deliver: async (sessionId, text) => {
			delivered.push({ sessionId, text });
			return sessionId;
		},
		onDiagnostic: (message) => diagnostics.push(message),
		onChanged: () => {
			changed += 1;
		},
	});
	return {
		service,
		delivered,
		diagnostics,
		dir,
		get changed(): number {
			return changed;
		},
		store: (): { tasks: ScheduleTask[]; runs: Record<string, ScheduleRun[]> } =>
			JSON.parse(readFileSync(join(dir, "schedule", "tasks.json"), "utf8")),
	};
}

const BASE = new Date(2026, 9, 7, 10, 0, 0, 0).getTime();
const daily = { kind: "daily" as const, time: "10:30" };

function createTask(
	service: ScheduleService,
	overrides?: Partial<Parameters<ScheduleService["create"]>[0]>,
): ScheduleTask {
	return service.create({
		name: "晨报",
		prompt: "检查未读邮件",
		sessionId: "sess-1",
		targetLabel: "邮件晨报会话",
		repeat: daily,
		...overrides,
	});
}

test("create: 校验 + 下次时刻 + 落盘", () => {
	const clock = { value: BASE };
	const h = harness(() => clock.value);
	assert.throws(() => createTask(h.service, { name: "  " }), /任务名/);
	assert.throws(() => createTask(h.service, { prompt: "" }), /提示词/);
	assert.throws(() => createTask(h.service, { repeat: { kind: "cron", expr: "bad" } }), /五段/);
	const task = createTask(h.service);
	assert.equal(task.enabled, true);
	assert.equal(task.nextRunAt, new Date(2026, 9, 7, 10, 30).getTime());
	assert.equal(h.store().tasks.length, 1);
});

test("tick: 到点投递，文本带时间感知前缀", async () => {
	const clock = { value: BASE };
	const h = harness(() => clock.value);
	const task = createTask(h.service);
	h.service.start();
	clock.value = new Date(2026, 9, 7, 10, 30, 30).getTime();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(h.delivered.length, 1);
	assert.equal(h.delivered[0]!.sessionId, "sess-1");
	assert.match(h.delivered[0]!.text, /自动化任务「晨报」到点执行 · 每天 10:30 · 现在 2026-10-07 10:30/);
	assert.match(h.delivered[0]!.text, /检查未读邮件/);
	assert.match(h.delivered[0]!.text, /^〔owl-schedule:[0-9a-f-]+〕（自动化任务「晨报」/);
	const { tasks, runs } = h.store();
	assert.equal(tasks[0]!.lastRunAt !== null, true);
	assert.equal(runs[task.id]![0]!.status, "ok");
	assert.equal(tasks[0]!.nextRunAt, new Date(2026, 9, 8, 10, 30).getTime());
	h.service.stop();
});

test("错过策略 catch-up：重启后留 pending，会话挂载时补投", async () => {
	const clock = { value: BASE };
	const h = harness(() => clock.value);
	createTask(h.service, { repeat: { kind: "once", at: BASE + 60_000 } });
	h.service.start();
	// 进程「死掉」期间错过：新实例从晚得多的时刻启动，且目标会话还没挂载
	const clock2 = { value: BASE + 3_600_000 };
	let online = false;
	const delivered2: string[] = [];
	const service2 = new ScheduleService({
		agentDir: h.dir,
		tickMs: 5,
		now: () => clock2.value,
		deliver: async (sessionId) => {
			if (!online) return null;
			delivered2.push(sessionId);
			return sessionId;
		},
	});
	service2.start();
	const { runs } = h.store();
	const taskId = Object.keys(runs)[0]!;
	assert.equal(runs[taskId]![0]!.status, "pending");
	assert.equal(delivered2.length, 0);
	// 会话挂载：pending 立即补投
	online = true;
	await service2.onSessionMounted("sess-1");
	assert.equal(delivered2.length, 1);
	assert.equal(delivered2[0], "sess-1");
	const after = h.store().runs[taskId]![0]!;
	assert.equal(after.status, "ok");
	assert.equal(after.note, "错过待补投（等会话打开）");
	service2.stop();
	h.service.stop();
});

test("错过策略 skip：重启后跳过并推进", () => {
	const clock = { value: BASE };
	const h = harness(() => clock.value);
	createTask(h.service, { missed: "skip" });
	h.service.start();
	const clock2 = { value: BASE + 3_600_000 }; // 错过 10:30，现在 11:00
	const service2 = new ScheduleService({
		agentDir: h.dir,
		tickMs: 5,
		now: () => clock2.value,
		deliver: async (sessionId) => sessionId,
	});
	service2.start();
	const { tasks, runs } = h.store();
	assert.equal(tasks[0]!.nextRunAt, new Date(2026, 9, 8, 10, 30).getTime());
	assert.equal(runs[tasks[0]!.id]![0]!.status, "skipped");
	service2.stop();
	h.service.stop();
});

test("update: 暂停冻结时刻，恢复从当下重算；一次性到点自动完成", async () => {
	const clock = { value: BASE };
	const h = harness(() => clock.value);
	const task = createTask(h.service);
	h.service.update({ id: task.id, enabled: false });
	clock.value = BASE + 86_400_000;
	assert.equal(h.store().tasks[0]!.nextRunAt, new Date(2026, 9, 7, 10, 30).getTime());
	h.service.update({ id: task.id, enabled: true });
	assert.equal(h.store().tasks[0]!.nextRunAt, new Date(2026, 9, 8, 10, 30).getTime());

	// 注意此时时钟已被拨到 BASE + 1 天：一次性时刻按当前时钟取未来。
	const fireAt = clock.value + 60_000;
	const once = createTask(h.service, { name: "提醒", repeat: { kind: "once", at: fireAt } });
	h.service.start();
	clock.value = fireAt + 60_000;
	await new Promise((resolve) => setTimeout(resolve, 30));
	const stored = h.store().tasks.find((candidate) => candidate.id === once.id)!;
	assert.equal(stored.enabled, false);
	assert.equal(stored.nextRunAt, null);
	h.service.stop();
});

test("runNow: 立即投递且不动 nextRunAt；remove 清历史", async () => {
	const clock = { value: BASE };
	const h = harness(() => clock.value);
	const task = createTask(h.service);
	const run = await h.service.runNow(task.id);
	assert.equal(run.status, "ok");
	assert.equal(h.delivered.length, 1);
	assert.equal(h.store().tasks[0]!.nextRunAt, task.nextRunAt);
	h.service.remove(task.id);
	assert.equal(h.store().tasks.length, 0);
	assert.equal(h.store().runs[task.id], undefined);
});

test("deliveryText: 展示名与重复说明进前缀", () => {
	const task = createTask(harness(() => BASE).service, { name: "周报" });
	assert.match(deliveryText(task, BASE), /「周报」/);
	assert.match(deliveryText(task, BASE), /每天 10:30/);
});

test("新会话任务：deliver 返回新建 id 时记「新会话」备注", async () => {
	const clock = { value: BASE };
	const h = harness(() => clock.value);
	// 覆写 deliver：模拟桥端为 "__new__" 新建会话
	const service = new ScheduleService({
		agentDir: h.dir,
		tickMs: 5,
		now: () => clock.value,
		deliver: async (sessionId) => (sessionId === "__new__" ? "ab12cd34-5678-90ab-cdef" : sessionId),
	});
	const task = service.create({
		name: "周报",
		prompt: "盘点",
		sessionId: "__new__",
		targetLabel: "新会话（每次新建）",
		repeat: { kind: "weekly", weekday: 1, time: "09:00" },
	});
	const run = await service.runNow(task.id);
	assert.equal(run.status, "ok");
	assert.match(run.note ?? "", /新会话 ab12cd34/);
});
