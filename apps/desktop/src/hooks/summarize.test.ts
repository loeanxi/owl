import assert from "node:assert/strict";
import { test } from "node:test";
import { errorKindOf, exitCodeOf, splitLeadingCd, summarizeToolCall } from "./summarize.ts";

test("splits a leading cd off the command", () => {
	assert.deepEqual(splitLeadingCd("cd D:/owl/owl-mono && npx vitest --run"), {
		dir: "D:/owl/owl-mono",
		rest: "npx vitest --run",
	});
	assert.deepEqual(splitLeadingCd('cd "D:/my dir"; ls'), { dir: "D:/my dir", rest: "ls" });
});

test("leaves commands without a separable cd untouched", () => {
	assert.deepEqual(splitLeadingCd("cd /d D:\\owl && dir"), { rest: "cd /d D:\\owl && dir" });
	assert.deepEqual(splitLeadingCd("cd src"), { rest: "cd src" });
	assert.deepEqual(splitLeadingCd("cd src && "), { rest: "cd src && " });
	assert.deepEqual(splitLeadingCd("npm test"), { rest: "npm test" });
});

test("bash summary shows the real command and the directory separately", () => {
	const { summary, detail } = summarizeToolCall("bash", {
		command: "cd D:/owl/owl-re-v1/owl-mono/packages/coding-agent && npx vitest --run test/a.test.ts",
	});
	assert.match(summary, /^`npx vitest --run test\/a\.test\.ts`/);
	assert.match(summary, /…\/packages\/coding-agent/);
	assert.equal(detail, "cd D:/owl/owl-re-v1/owl-mono/packages/coding-agent && npx vitest --run test/a.test.ts");
});

test("subagent summary names an inline workflow script instead of quoting it", () => {
	const script = "const jobs = [\n  { key: 'structure', agent: 'scout', task: `勘察 packages/coding-agent/src/core/agent-session.ts` },\n];";
	assert.equal(summarizeToolCall("subagent", { workflow: script, task: "勘察" }).summary, "subagent workflow");
	assert.equal(summarizeToolCall("subagent", { workflow: "./recon.js" }).summary, "subagent `./recon.js`");
	assert.equal(summarizeToolCall("subagent", { agent: "scout", task: "读文件" }).summary, "subagent scout");
});

test("powershell summary keeps the whole command", () => {
	assert.equal(summarizeToolCall("powershell", { command: "cd C:\\x; dir" }).summary, "`cd C:\\x; dir`");
});

test("reads the last exit code from tool output", () => {
	assert.equal(exitCodeOf("FAIL a\nCommand exited with code 1"), 1);
	assert.equal(exitCodeOf("Command exited with code 2\nretry\nCommand exited with code 127 (missing)"), 127);
	assert.equal(exitCodeOf("ok"), undefined);
	assert.equal(exitCodeOf(undefined), undefined);
});

test("separates non-zero exits and gate refusals from real failures", () => {
	assert.equal(errorKindOf("bash", "=== 检查残留 ===\n(无输出=已清理)\n\nCommand exited with code 1"), "exit");
	assert.equal(errorKindOf("bash", "\n\nCommand exited with code 1"), "failed");
	assert.equal(errorKindOf("bash", "mysql: command not found\n\nCommand exited with code 127"), "failed");
	assert.equal(errorKindOf("bash", "BLOCKED by Owl Safety Net"), "failed");
	assert.equal(errorKindOf("read", "x\nCommand exited with code 1"), "failed");
	assert.equal(
		errorKindOf(
			"write",
			"Refusing to overwrite a.md: no read of the whole current file is in context.\n\n[Current file content follows. It counts as your read of this file: retry the call against it, do not call read again.]\nbody",
		),
		"blocked",
	);
	assert.equal(errorKindOf("edit", "Could not find edits[2] in CLAUDE.md."), "failed");
});
