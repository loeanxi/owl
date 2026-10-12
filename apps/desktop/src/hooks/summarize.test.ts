import assert from "node:assert/strict";
import { test } from "node:test";
import { exitCodeOf, splitLeadingCd, summarizeToolCall } from "./summarize.ts";

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

test("powershell summary keeps the whole command", () => {
	assert.equal(summarizeToolCall("powershell", { command: "cd C:\\x; dir" }).summary, "`cd C:\\x; dir`");
});

test("reads the last exit code from tool output", () => {
	assert.equal(exitCodeOf("FAIL a\nCommand exited with code 1"), 1);
	assert.equal(exitCodeOf("Command exited with code 2\nretry\nCommand exited with code 127 (missing)"), 127);
	assert.equal(exitCodeOf("ok"), undefined);
	assert.equal(exitCodeOf(undefined), undefined);
});
