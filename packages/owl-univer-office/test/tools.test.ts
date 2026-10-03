import assert from "node:assert/strict";
import { test } from "node:test";
import { executeOfficeOperation, type OfficeToolRuntime } from "../src/tools.ts";

test("a model cannot bypass merge approval through a userConfirmed argument", async () => {
	let calls = 0;
	const runtime: OfficeToolRuntime = { async call() { calls += 1; return {}; } };
	await assert.rejects(executeOfficeOperation(runtime, "worktree", { action: "merge", file: "report.univer", worktreeId: "draft", userConfirmed: true }, {
		cwd: "/workspace", hasUI: true, ui: { confirm: async () => false },
	}), /用户未确认/);
	assert.equal(calls, 0);
	await assert.rejects(executeOfficeOperation(runtime, "worktree", { action: "discard", file: "report.univer", worktreeId: "draft" }, {
		cwd: "/workspace", hasUI: false, ui: { confirm: async () => true },
	}), /已连接的 Owl 界面/);
	assert.equal(calls, 0);
});

test("approval supplies a trusted action marker and cancellation does not invoke the runtime", async () => {
	const invocations: Record<string, unknown>[] = [];
	const runtime: OfficeToolRuntime = { async call(_operation, args) { invocations.push(args); return { ok: true }; } };
	const ctx = { cwd: "/workspace", hasUI: true, ui: { confirm: async () => true } };
	await executeOfficeOperation(runtime, "worktree", { action: "merge", file: "report.univer", worktreeId: "draft" }, ctx);
	assert.equal(invocations[0].userConfirmed, true);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(executeOfficeOperation(runtime, "new", { file: "cancelled.univer" }, ctx, controller.signal));
	assert.equal(invocations.length, 1);
});

test("successful exports supply structured artifact metadata and failed exports do not", async () => {
	const ctx = { cwd: "/workspace", hasUI: true, ui: { confirm: async () => false } };
	const result = await executeOfficeOperation({ async call() { return { output: "/workspace/result.xlsx" }; } }, "export", { output: "result.xlsx" }, ctx);
	assert.deepEqual(result.details.artifacts, [{ path: "result.xlsx", action: "written" }]);
	assert.deepEqual(result.structuredContent, { output: "/workspace/result.xlsx" });
	await assert.rejects(executeOfficeOperation({ async call() { throw new Error("export failed"); } }, "export", { output: "failed.xlsx" }, ctx), /export failed/);
});
