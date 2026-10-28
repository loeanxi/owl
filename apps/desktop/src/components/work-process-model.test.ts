import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCard } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { workProcessText } from "./work-process-copy.ts";
import { type WorkAction, workActionFacts, workActionTitle } from "./work-process-model.ts";

function action(key: string, status: ToolCard["status"], args = '{"path":"src/chat.tsx"}', name = "read"): WorkAction {
	return { key, card: { id: key, name, args, summary: `summary ${key}`, status } };
}

afterEach(() => setUiLanguage("zh"));

test("selects the latest unfinished running action before a pending action", () => {
	const running = action("running", "running");
	const pending = action("pending", "pending");
	const sealed = action("sealed", "running");
	sealed.card.finishedAt = 100;
	assert.equal(workActionFacts([running, pending, sealed]).current, running);
	assert.equal(workActionFacts([pending, sealed]).current, pending);
	assert.equal(workActionFacts([sealed]).current, undefined);
});

test("keeps only the last three settled actions in their original order", () => {
	const actions = [
		action("old", "ok"),
		action("error", "error"),
		action("running", "running"),
		action("cancelled", "cancelled"),
		action("done", "ok"),
	];
	const facts = workActionFacts(actions);
	assert.deepEqual(
		facts.recent.map(({ key }) => key),
		["error", "cancelled", "done"],
	);
	assert.equal(actions.length, 5);
});

test("a later unrelated success does not recover a failed operation", () => {
	const failed = action("failed", "error");
	const facts = workActionFacts([
		failed,
		action("other-path", "ok", '{"path":"src/other.tsx"}'),
		action("other-tool", "ok", failed.card.args, "write"),
	]);
	assert.deepEqual(facts.issues, [failed]);
	assert.deepEqual(facts.recovered, []);
});

test("recovers only a later identical operation while normalizing nested object key order", () => {
	const failed = action("failed", "error", '{"path":"src/chat.tsx","options":{"offset":1,"limit":20}}');
	const retried = action("retried", "ok", '{ "options": {"limit":20, "offset":1}, "path":"src/chat.tsx" }');
	assert.deepEqual(workActionFacts([failed, retried]).recovered, [failed]);
	assert.deepEqual(workActionFacts([failed, retried]).issues, []);
	assert.deepEqual(workActionFacts([failed]).issues, [failed]);
	assert.deepEqual(workActionFacts([retried, failed]).issues, [failed]);
});

test("identical later successes in a different run scope cannot hide an earlier failure", () => {
	const failed = { ...action("failed", "error"), scope: "sealed-run" };
	const otherRun = { ...action("retried", "ok"), scope: "continued-run" };
	assert.deepEqual(workActionFacts([failed, otherRun]).issues, [failed]);
	assert.deepEqual(workActionFacts([failed, otherRun]).recovered, []);
	const sameRun = { ...otherRun, scope: "sealed-run" };
	assert.deepEqual(workActionFacts([failed, sameRun]).issues, []);
	assert.deepEqual(workActionFacts([failed, sameRun]).recovered, [failed]);
});

test("different write contents, commands and array order cannot confirm recovery", () => {
	for (const [name, before, after] of [
		["write", '{"path":"a","content":"old"}', '{"path":"a","content":"new"}'],
		["bash", '{"command":"npm run check"}', '{"command":"npm run check; echo done"}'],
		["edit", '{"path":"a","edits":[1,2]}', '{"path":"a","edits":[2,1]}'],
	]) {
		const failed = action("failed", "error", before, name);
		assert.deepEqual(workActionFacts([failed, action("retried", "ok", after, name)]).issues, [failed]);
	}
});

test("invalid or non-object JSON arguments cannot establish retry identity", () => {
	for (const args of ["", "{", "null", "[]", '"path"', "42", '{"limit":1e999}']) {
		const failed = action("failed", "error", args);
		assert.deepEqual(workActionFacts([failed, action("retried", "ok", args)]).issues, [failed]);
	}
});

test("every error remains reviewable even with non-zero shell output or a guard snapshot", () => {
	const shell = action("shell", "error", '{"command":"npm run check"}', "bash");
	shell.card.output = { text: "type errors\nCommand exited with code 1", totalLines: 2 };
	const guard = action("guard", "error", '{"path":"a","content":"x"}', "write");
	guard.card.output = { text: "[Current file content follows. It counts as your read of this file", totalLines: 1 };
	assert.deepEqual(workActionFacts([shell, guard, action("other", "ok")]).issues, [shell, guard]);
});

test("cancelled and pending retries do not resolve issues and later errors remain issues", () => {
	const failed = action("failed", "error");
	assert.deepEqual(workActionFacts([failed, action("cancelled", "cancelled"), action("pending", "pending")]).issues, [
		failed,
	]);
	const laterFailed = action("later-failed", "error");
	const facts = workActionFacts([failed, action("ok", "ok"), laterFailed]);
	assert.deepEqual(facts.recovered, [failed]);
	assert.deepEqual(facts.issues, [laterFailed]);
});

test("uses existing path summaries and recognizes only the complete project-check command", () => {
	setUiLanguage("zh");
	assert.equal(workActionTitle(action("read", "running").card), "读取 chat.tsx");
	assert.equal(
		workActionTitle(action("check", "running", '{"command":"npm run check"}', "bash").card),
		"运行项目检查",
	);
	for (const command of ["npm run check && echo done", "echo npm run check", "npm\nrun\ncheck"]) {
		const shell = action("shell", "running", JSON.stringify({ command }), "powershell").card;
		const title = workActionTitle({ ...shell, summary: shell.name });
		assert.notEqual(title, "运行项目检查");
		assert.ok(
			title.includes(command.replace(/\s+/g, " ")),
			"the concrete command remains identifiable without opening raw details",
		);
	}
	const unknown = action("unknown", "running", "{}", "browser_custom");
	assert.equal(workActionTitle(unknown.card), unknown.card.summary);
});

test("a meaningful shell summary remains the human title instead of being rebuilt from the raw command", () => {
	const shell = action(
		"shell",
		"running",
		'{"command":"git diff -- src/safe.ts && echo raw-command-detail"}',
		"bash",
	).card;
	const summary = "核对 src/safe.ts 的代码差异";
	assert.equal(workActionTitle({ ...shell, summary }), summary);
	assert.ok(!workActionTitle({ ...shell, summary }).includes("raw-command-detail"));
});

test("localized labels interpolate counts without claiming task success", () => {
	setUiLanguage("en");
	const described = action("shell", "running", "{}", "powershell");
	assert.equal(workActionTitle(described.card), described.card.summary);
	assert.equal(workActionTitle({ ...described.card, summary: "" }), "Run command");
	assert.equal(workProcessText("issueCount", { n: 2 }), "Failed records: 2");
	assert.equal(workProcessText("finished"), "Execution ended");
	setUiLanguage("zh");
	assert.equal(workProcessText("recoveredCount", { n: 1 }), "1 项操作重试成功");
});
