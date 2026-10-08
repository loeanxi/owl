import assert from "node:assert/strict";
import test from "node:test";
import {
	addTodoInRaw,
	appendChatLine,
	moveTodoToTomorrow,
	myselfPrimer,
	newDayTemplate,
	nextDayKey,
	parseDay,
	toggleTodoInRaw,
	updateSummaryInRaw,
	updateTodoMetadataInRaw,
	updateTodoStatusInRaw,
	weekDaysOf,
} from "./myself-data.ts";

const SAMPLE = `# 2026-10-07（周二）

## 待办（手记）

- [ ] 跑测试
- [ ] 给原型
- [ ] 打电话

## AI 提炼（自动）

1. **上午先修测试** —— 周三有评审
2. **晚上清邮件**

## 对话

> 13:42 我：今天最重要的是什么？
> 13:43 Owl Si：先跑测试。

## 完成情况

- [x] 跑测试
- [ ] 给原型
- [ ] 打电话
`;

test("待办与完成情况合并去重，状态以完成情况为准", () => {
	const day = parseDay(SAMPLE, "2026-10-07");
	assert.deepEqual(
		day.todos.map((todo) => [todo.text, todo.done]),
		[
			["跑测试", true],
			["给原型", false],
			["打电话", false],
		],
	);
});

test("完成情况里多出来的条目追加到清单尾部", () => {
	const day = parseDay(`${SAMPLE}\n- [x] 顺手修了 icons\n`, "2026-10-07");
	assert.equal(day.todos.length, 4);
	assert.equal(day.todos[3]!.text, "顺手修了 icons");
	assert.equal(day.todos[3]!.done, true);
});

test("提炼行解析加粗标题与说明，也容忍普通编号行", () => {
	const day = parseDay(SAMPLE, "2026-10-07");
	assert.deepEqual(day.distilled, [
		{ title: "上午先修测试", detail: "周三有评审" },
		{ title: "晚上清邮件", detail: "" },
	]);
});

test("对话行解析时间/说话人/正文", () => {
	const day = parseDay(SAMPLE, "2026-10-07");
	assert.deepEqual(day.chat, [
		{ time: "13:42", who: "我", text: "今天最重要的是什么？" },
		{ time: "13:43", who: "Owl Si", text: "先跑测试。" },
	]);
});

test("勾选回写同时翻转待办与完成情况里的同名行，其余内容不动", () => {
	const toggled = toggleTodoInRaw(SAMPLE, "给原型", true);
	assert.equal(toggled.match(/- \[x\] 给原型/g)?.length, 2);
	assert.equal(toggled.match(/- \[ \] 给原型/g) ?? null, null);
	assert.equal(toggled.includes("1. **上午先修测试** —— 周三有评审"), true);
	assert.equal(toggled.includes("# 2026-10-07（周二）"), true);
	// 翻回去要回到原样
	assert.equal(toggleTodoInRaw(toggled, "给原型", false), SAMPLE);
});

test("空白差异不影响同名匹配", () => {
	const toggled = toggleTodoInRaw(SAMPLE, "跑 测试", false);
	assert.equal(toggled.match(/- \[ \] 跑测试/g)?.length, 2);
});

test("新一天模板可被自己的解析器读回", () => {
	const day = parseDay(newDayTemplate("2026-10-08", "zh"), "2026-10-08");
	assert.equal(day.todos.length, 1);
	// 空的「1. 」行解析不出提炼条目——面板会隐藏空段落。
	assert.equal(day.distilled.length, 0);
});

test("对话行追加进「对话」段，没有该段时补一个", () => {
	const withSection = appendChatLine(SAMPLE, "14:00", "我", "帮我排一下下午");
	assert.equal(withSection.includes("> 14:00 我：帮我排一下下午"), true);
	const idxChat = withSection.indexOf("## 对话");
	const idxDone = withSection.indexOf("## 完成情况");
	assert.ok(idxChat < withSection.indexOf("> 14:00") && withSection.indexOf("> 14:00") < idxDone);
	// 多行正文压成单行
	assert.equal(appendChatLine(SAMPLE, "14:01", "Owl Si", "第一行\n第二行").includes("第一行 第二行"), true);
	// 没有对话段的文件：文末补段
	const bare = parseDay("# 2026-10-08\n\n随手一记\n", "2026-10-08");
	assert.equal(bare.chat.length, 0);
	const added = appendChatLine("# 2026-10-08\n\n随手一记\n", "09:00", "我", "早");
	const day2 = parseDay(added, "2026-10-08");
	assert.deepEqual(
		day2.chat.map((line) => [line.time, line.who, line.text]),
		[["09:00", "我", "早"]],
	);
	assert.equal(added.includes("随手一记"), true);
});

test("对话行追加落在「对话」段内而不是完成情况之后", () => {
	// 「对话」段在中间时，插入点应是下一个段标题之前
	const out = appendChatLine(SAMPLE, "15:30", "Owl Si", "好");
	const lines = out.split("\n");
	const insert = lines.findIndex((line) => line.includes("> 15:30"));
	const doneHead = lines.findIndex((line) => line.startsWith("## 完成情况"));
	assert.ok(insert > 0 && insert < doneHead);
});

test("myselfPrimer 带上日期、文件内容与角色说明", () => {
	const primer = myselfPrimer("2026-10-07", SAMPLE, "zh");
	assert.equal(primer.includes("2026-10-07.md"), true);
	assert.equal(primer.includes("上午先修测试"), true);
	assert.equal(primer.includes("Owl Si"), true);
});

test("旧完成投影仍优先，进行中和等待状态不被未勾选镜像抹掉", () => {
	const raw = `## 待办（手记）
- [ ] 检查供应商 <!-- owl-task:{"status":"doing","time":"14:00","category":"工作","goal":"配置清楚"} -->
- [ ] 等咨询答复 <!-- owl-task:{"status":"waiting"} -->
- [ ] 旧的已完成项
## 完成情况
- [ ] 检查供应商
- [ ] 等咨询答复
- [x] 旧的已完成项
- [x] 额外完成项
- [x] 额外完成项
`;
	const day = parseDay(raw, "2026-10-08");
	assert.deepEqual(
		day.todos.map((todo) => [todo.text, todo.status]),
		[
			["检查供应商", "doing"],
			["等咨询答复", "waiting"],
			["旧的已完成项", "done"],
			["额外完成项", "done"],
		],
	);
	assert.deepEqual(day.todos[0], {
		text: "检查供应商",
		done: false,
		status: "doing",
		time: "14:00",
		category: "工作",
		goal: "配置清楚",
	});
	assert.equal(day.todos[1]!.time, undefined);
});

test("元数据损坏或未知状态不影响任务显示，不虚构可选字段", () => {
	const day = parseDay(
		'## Todos\n- [ ] 原任务 <!-- owl-task:{bad} -->\n- [x] 已完成 <!-- owl-task:{"status":"unknown","time":null} -->',
		"2026-10-08",
	);
	assert.deepEqual(day.todos, [
		{ text: "原任务", done: false, status: "todo" },
		{ text: "已完成", done: true, status: "done" },
	]);
});

test("状态与详情只修改清单，保留文本、CRLF及无关段落", () => {
	const raw =
		"# 今日\r\n## 待办（手记）\r\n* [ ]   检查  供应商  \r\n## 对话\r\n> 10:00 我：保留原话\r\n## 完成情况\r\n* [ ] 检查 供应商\r\n\r\n### 今日总结\r\n- [ ] 检查供应商\r\n";
	const doing = updateTodoStatusInRaw(raw, "检查供应商", "doing");
	assert.ok(doing.includes("* [ ]   检查  供应商   <!-- owl-task:"));
	assert.equal(doing.includes("\n") && !doing.replaceAll("\r\n", "").includes("\n"), true);
	assert.ok(doing.includes("### 今日总结\r\n- [ ] 检查供应商"));
	assert.ok(doing.includes("> 10:00 我：保留原话"));
	const done = updateTodoStatusInRaw(doing, "检查供应商", "done");
	assert.equal(parseDay(done, "2026-10-08").todos[0]!.status, "done");
	const metadata = updateTodoMetadataInRaw(done, "检查供应商", {
		time: "15:30",
		category: "工作",
		goal: "配置 --> 完整",
	});
	assert.equal(parseDay(metadata, "2026-10-08").todos[0]!.goal, "配置 --> 完整");
	assert.ok(metadata.includes("\\u003e"));
	const cleared = updateTodoMetadataInRaw(metadata, "检查供应商", { time: "", category: undefined });
	assert.equal(parseDay(cleared, "2026-10-08").todos[0]!.time, undefined);
	assert.equal(parseDay(cleared, "2026-10-08").todos[0]!.category, undefined);
	assert.equal(updateTodoMetadataInRaw(raw, "检查供应商", {}), raw);
	assert.equal(updateTodoStatusInRaw(raw, "不存在", "waiting"), raw);
});

test("新增待办只写待办段，重复提交不会复制旧完成投影", () => {
	const added = addTodoInRaw(SAMPLE, "检查供应商", { status: "waiting", time: "下午", goal: "上午先修测试" });
	assert.equal(parseDay(added, "2026-10-07").todos.find((todo) => todo.text === "检查供应商")!.status, "waiting");
	assert.equal(added.slice(added.indexOf("## 完成情况")), SAMPLE.slice(SAMPLE.indexOf("## 完成情况")));
	assert.equal(addTodoInRaw(added, "检查 供应商"), added);
	assert.equal(addTodoInRaw(SAMPLE, "\n  "), SAMPLE);
	const blankFields = parseDay(addTodoInRaw(SAMPLE, "空字段任务"), "2026-10-07").todos.find(
		(todo) => todo.text === "空字段任务",
	);
	assert.deepEqual(blankFields, { text: "空字段任务", done: false, status: "todo" });
});

test("迁移同时移走两段旧清单，保留原日对话与总结及目标日已有内容", () => {
	const source = updateSummaryInRaw(
		updateTodoMetadataInRaw(SAMPLE, "给原型", { time: "14:00", goal: "上午先修测试" }),
		"给原型尚未完成，移到明天。\n- [ ] 这里是总结里的核对项",
	);
	const target =
		"# 2026-10-08\n\n## 待办（手记）\n\n- [ ] 目标日已有任务\n\n## 对话\n\n> 09:00 我：明天原本安排\n\n## 完成情况\n\n保留自由记录\n";
	const moved = moveTodoToTomorrow(source, target, "给原型", "2026-10-07");
	assert.equal(moved.targetDate, "2026-10-08");
	assert.equal(
		parseDay(moved.sourceRaw, "2026-10-07").todos.some((todo) => todo.text === "给原型"),
		false,
	);
	assert.equal(moved.sourceRaw.includes("> 13:43 Owl Si：先跑测试。"), true);
	assert.equal(
		parseDay(moved.sourceRaw, "2026-10-07").summary,
		"给原型尚未完成，移到明天。\n- [ ] 这里是总结里的核对项",
	);
	const task = parseDay(moved.targetRaw, "2026-10-08").todos.find((todo) => todo.text === "给原型");
	assert.equal(task?.time, "14:00");
	assert.equal(task?.goal, "上午先修测试");
	assert.equal(moved.targetRaw.includes("> 09:00 我：明天原本安排"), true);
	assert.equal(moved.targetRaw.includes("保留自由记录"), true);
	assert.equal(moved.targetRaw.match(/给原型/g)?.length, 1);
});

test("目标日已有同名完成项时不降级，也不复制任务或覆盖已填详情", () => {
	const source = updateTodoStatusInRaw(
		updateTodoMetadataInRaw(SAMPLE, "给原型", { time: "下午", category: "工作" }),
		"给原型",
		"doing",
	);
	const target = addTodoInRaw("## Todos\n", "给原型", { status: "done", time: "上午" });
	const moved = moveTodoToTomorrow(source, target, "给原型", "2026-10-07");
	const day = parseDay(moved.targetRaw, "2026-10-08");
	assert.equal(day.todos.length, 1);
	assert.equal(day.todos[0]!.status, "done");
	assert.equal(day.todos[0]!.time, "上午");
	assert.equal(day.todos[0]!.category, "工作");
	assert.equal(
		parseDay(moved.sourceRaw, "2026-10-07").todos.some((todo) => todo.text === "给原型"),
		false,
	);
	const absent = moveTodoToTomorrow(source, target, "不存在", "2026-10-07");
	assert.equal(absent.sourceRaw, source);
	assert.equal(absent.targetRaw, target);
});

test("七日周历包含周末并按本地日期跨月跨年", () => {
	assert.deepEqual(weekDaysOf("2026-10-03"), [
		"2026-09-28",
		"2026-09-29",
		"2026-09-30",
		"2026-10-01",
		"2026-10-02",
		"2026-10-03",
		"2026-10-04",
	]);
	assert.deepEqual(weekDaysOf("2027-01-03"), [
		"2026-12-28",
		"2026-12-29",
		"2026-12-30",
		"2026-12-31",
		"2027-01-01",
		"2027-01-02",
		"2027-01-03",
	]);
	assert.equal(nextDayKey("2026-12-31"), "2027-01-01");
	assert.equal(nextDayKey("2028-02-28"), "2028-02-29");
	assert.throws(() => weekDaysOf("2026-02-30"), /invalid day/);
});

test("独立总结中的 checklist 不合并任务，更新不动旧完成状态和自由记录", () => {
	const raw = `${SAMPLE}\n自由记录原文\n\n### 今日总结\n\n- [ ] 跑测试\n今天已核对测试结果。\n\n### 补充\n\n保留这个子段\n`;
	const day = parseDay(raw, "2026-10-07");
	assert.equal(day.todos[0]!.done, true);
	assert.equal(day.summary, "- [ ] 跑测试\n今天已核对测试结果。");
	const updated = updateSummaryInRaw(raw, "真实完成了跑测试，其他事项还未完成。");
	assert.deepEqual(parseDay(updated, "2026-10-07").todos, day.todos);
	assert.equal(parseDay(updated, "2026-10-07").summary, "真实完成了跑测试，其他事项还未完成。");
	assert.equal(updated.includes("自由记录原文"), true);
	assert.equal(updated.includes("### 补充\n\n保留这个子段"), true);
	assert.equal(updated.match(/## /g)?.length, raw.match(/## /g)?.length);
	const fromEmpty = updateSummaryInRaw(newDayTemplate("2026-10-08", "zh"), "今天没有确认完成事项。");
	assert.equal(fromEmpty.split("\n").filter((line) => line.startsWith("## ")).length, 4);
	assert.equal(parseDay(fromEmpty, "2026-10-08").summary, "今天没有确认完成事项。");
});

test("目标来自提炼段，支持明确的目标文本但不从待办生成目标", () => {
	const raw =
		"## 待办（手记）\n- [ ] 修复供应商\n## AI 提炼（自动）\n1. **配置清楚** —— 检查字段\n- 目标：咨询有明确入口\n";
	assert.deepEqual(parseDay(raw, "2026-10-08").goals, [
		{ title: "配置清楚", detail: "检查字段" },
		{ title: "咨询有明确入口", detail: "" },
	]);
	assert.deepEqual(parseDay("## Todos\n- [ ] 独立任务\n", "2026-10-08").goals, []);
	assert.equal(parseDay("## AI distilled\n1. A real goal\n", "2026-10-08").goals[0]!.title, "A real goal");
});
