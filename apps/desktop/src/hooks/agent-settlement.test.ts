import assert from "node:assert/strict";
import { test } from "node:test";
import { settledRunStatus } from "./agent-settlement.ts";

test("a stopped run cannot display done or trigger a completion notification after a successful reply", () => {
	assert.deepEqual(settledRunStatus({ aborted: true }, "done"), { outcome: "aborted", notifyDone: false });
	assert.deepEqual(settledRunStatus({ aborted: true }), { outcome: "aborted", notifyDone: false });
});

test("normal completion still triggers the existing done notification", () => {
	assert.deepEqual(settledRunStatus({ aborted: false }, "done"), { outcome: "done", notifyDone: true });
	assert.deepEqual(settledRunStatus({ aborted: false }), { outcome: "done", notifyDone: true });
});

test("a previously failed or aborted run keeps its real outcome without completion notifications", () => {
	for (const aborted of [true, false, undefined]) {
		assert.deepEqual(settledRunStatus({ aborted }, "error"), { outcome: "error", notifyDone: false });
		assert.deepEqual(settledRunStatus({ aborted }, "aborted"), { outcome: "aborted", notifyDone: false });
	}
});

test("old bridge events without aborted retain the outcome supplied by stopReason", () => {
	assert.deepEqual(settledRunStatus({}, "aborted"), { outcome: "aborted", notifyDone: false });
	assert.deepEqual(settledRunStatus({}, "error"), { outcome: "error", notifyDone: false });
	assert.deepEqual(settledRunStatus({}), { outcome: "done", notifyDone: true });
	assert.deepEqual(settledRunStatus({ aborted: "true" }), { outcome: "done", notifyDone: true });
});
