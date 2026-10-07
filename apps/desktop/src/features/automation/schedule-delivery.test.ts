import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScheduleDelivery } from "./schedule-delivery.ts";

test("新格式：带任务标记的到点投递", () => {
	const text = "〔owl-schedule:t-123〕（自动化任务「邮箱晨报」到点执行 · 每天 09:00 · 现在 2026-10-07 09:00）\n\n检查未读邮件，挑出 3 封最要紧的。";
	const info = parseScheduleDelivery(text);
	assert.ok(info);
	assert.equal(info.taskId, "t-123");
	assert.equal(info.name, "邮箱晨报");
	assert.equal(info.repeat, "每天 09:00");
	assert.equal(info.time, "2026-10-07 09:00");
	assert.equal(info.prompt, "检查未读邮件，挑出 3 封最要紧的。");
});

test("一次性任务：节奏里带 · 不干扰解析", () => {
	const text = "〔owl-schedule:t-9〕（自动化任务「提醒我打包」到点执行 · 一次性 · 2026-10-09 09:00 · 现在 2026-10-09 09:00）\n\n打包 v0.0.4";
	const info = parseScheduleDelivery(text);
	assert.ok(info);
	assert.equal(info.taskId, "t-9");
	assert.equal(info.repeat, "一次性 · 2026-10-09 09:00");
	assert.equal(info.prompt, "打包 v0.0.4");
});

test("旧格式：无标记的投递兜底解析（taskId 为 null）", () => {
	const text = "（自动化任务「晨报」到点执行 · 每天 08:30 · 现在 2026-10-01 08:30）\n\n正文";
	const info = parseScheduleDelivery(text);
	assert.ok(info);
	assert.equal(info.taskId, null);
	assert.equal(info.name, "晨报");
	assert.equal(info.prompt, "正文");
});

test("普通用户消息不误判", () => {
	assert.equal(parseScheduleDelivery("帮我看看这个项目的登录逻辑在哪里"), null);
	assert.equal(parseScheduleDelivery(""), null);
});
