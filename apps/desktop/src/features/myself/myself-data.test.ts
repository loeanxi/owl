import assert from "node:assert/strict";
import test from "node:test";
import { appendChatLine, myselfPrimer, newDayTemplate, parseDay, toggleTodoInRaw } from "./myself-data.ts";

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
	assert.deepEqual(day.todos.map((todo) => [todo.text, todo.done]), [
		["跑测试", true],
		["给原型", false],
		["打电话", false],
	]);
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
	assert.deepEqual(day2.chat.map((line) => [line.time, line.who, line.text]), [["09:00", "我", "早"]]);
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
