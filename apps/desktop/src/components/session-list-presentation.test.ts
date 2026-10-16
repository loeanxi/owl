import assert from "node:assert/strict";
import test from "node:test";
import { groupSessionsByPeriod, sessionDisplayTitle } from "./session-list-presentation.ts";

const titleOf = (row: Parameters<typeof sessionDisplayTitle>[0]): string => sessionDisplayTitle(row, "未命名会话", "分支");

test("manual names win over automatic cleanup, including path-like names and branch names", () => {
	assert.equal(titleOf({ name: "  D:\\work\\my-title  ", firstMessage: "自动标题", parentSessionPath: "parent.jsonl" }), "D:\\work\\my-title");
	assert.equal(titleOf({ name: "自己起的名字", firstMessage: '<owl-myself-turn>{"text":"其他名字"}</owl-myself-turn>' }), "自己起的名字");
});

test("myself envelopes expose only the user's text, including attachments and literal closing tags", () => {
	const text = "复查周五日程 </owl-myself-turn> 不要改掉这句话";
	const firstMessage = `[Attached files for this turn]\r\n- old-notes.md\r\n\r\n<owl-myself-turn>${JSON.stringify({ date: "2026-10-15", intent: "plan", text })}</owl-myself-turn>\n\n内部日程指令`;
	const row = { id: "original-session-id", firstMessage };
	assert.equal(titleOf(row), text);
	assert.equal(row.firstMessage, firstMessage);
	assert.equal(row.id, "original-session-id");
	assert.equal(titleOf({ firstMessage: '<owl-myself-turn>{"text":"不完整的元信息' }), "未命名会话");
});

test("skill invocation arguments replace the instruction body, falling back to the skill name", () => {
	assert.equal(titleOf({ firstMessage: '<skill name="code-review" location="D:/skills/review/SKILL.md">\n大量内部操作步骤\n</skill>\n\n复查登录异常' }), "复查登录异常");
	assert.equal(titleOf({ firstMessage: '<skill name="code-review" location="D:/skills/review/SKILL.md">\n大量内部操作步骤\n</skill>' }), "code-review");
});

test("scheduled deliveries use the task's readable name rather than its id and delivery metadata", () => {
	assert.equal(titleOf({ firstMessage: "〔owl-schedule:t-123〕（自动化任务「邮箱晨报」到点执行 · 每天 09:00 · 现在 2026-10-15 09:00）\n\n检查未读邮件。" }), "邮箱晨报");
	assert.equal(titleOf({ firstMessage: "〔owl-schedule:t-123〕检查未读邮件" }), "检查未读邮件");
});

test("automatic path and uuid-only titles do not fill the navigation with storage identifiers", () => {
	assert.equal(titleOf({ firstMessage: "D:\\work\\owl\\fix-login.md" }), "fix-login.md");
	assert.equal(titleOf({ firstMessage: "D:\\history\\2026-10-11T21-43-00-635Z_01a12ceb-4d1a-7123-925b-4dd4a7711532.jsonl 查看这个任务 这个任务中有许多失败的情况" }), "查看这个任务 这个任务中有许多失败的情况");
	assert.equal(titleOf({ firstMessage: "/home/user/project/" }), "project");
	assert.equal(titleOf({ firstMessage: "019a1234-abcd-7123-8abc-0123456789ab" }), "未命名会话");
	assert.equal(titleOf({ firstMessage: "D:/history/019a1234-abcd-7123-8abc-0123456789ab.jsonl" }), "未命名会话");
	assert.equal(titleOf({ firstMessage: "D:/history/2026-10-11T21-43-00-635Z_01a12ceb-4d1a-7123-925b-4dd4a7711532.jsonl" }), "未命名会话 · 2026-10-11");
	assert.equal(titleOf({ id: "019a1234-abcd-7123-8abc-0123456789ab" }), "未命名会话");
	assert.equal(titleOf({ firstMessage: "正常的\n多行问题", parentSessionPath: "parent.jsonl" }), "正常的 多行问题 · 分支");
});

test("time groups respect local midnight and calendar yesterday rather than the last 24 hours", () => {
	const now = new Date(2026, 9, 15, 0, 5).getTime();
	const rows = [
		{ id: "today", modified: new Date(2026, 9, 15, 0, 1).toISOString() },
		{ id: "yesterday", modified: new Date(2026, 9, 14, 23, 59).toISOString() },
		{ id: "earlier", created: new Date(2026, 9, 13, 23, 59).toISOString() },
		{ id: "unknown", modified: "invalid" },
	];
	const snapshot = JSON.stringify(rows);
	assert.deepEqual(groupSessionsByPeriod(rows, now).map(({ period, rows: group }) => [period, group.map((row) => row.id)]), [
		["today", ["today"]], ["yesterday", ["yesterday"]], ["earlier", ["earlier", "unknown"]],
	]);
	assert.equal(JSON.stringify(rows), snapshot);
	assert.deepEqual(groupSessionsByPeriod([], now), []);
});
