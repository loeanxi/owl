import assert from "node:assert/strict";
import test from "node:test";
import type { SourceUpdateCheck } from "../bridge/native.ts";
import { describeSourceUpdate, readableUpdateError } from "./update-menu-state.ts";

const base: SourceUpdateCheck = {
	status: "upToDate",
	appVersion: "0.1.0",
	localCommit: "1111111111",
	remoteCommit: "1111111111",
	upstream: "origin/main",
	behind: 0,
	ahead: 0,
	updateAvailable: false,
};

test("describes all source update relationships without treating local-ahead as an update", () => {
	assert.equal(describeSourceUpdate(base).key, "rail.updateCurrent");
	assert.equal(describeSourceUpdate({ ...base, status: "updateAvailable", behind: 3, updateAvailable: true }).key, "rail.updateAvailable");
	assert.equal(describeSourceUpdate({ ...base, status: "localAhead", ahead: 2 }).key, "rail.updateLocalAhead");
	assert.equal(describeSourceUpdate({ ...base, status: "diverged", behind: 3, ahead: 2, updateAvailable: true }).key, "rail.updateDiverged");
});

test("keeps useful native errors and supplies a fallback for empty failures", () => {
	assert.equal(readableUpdateError(new Error("offline")), "offline");
	assert.equal(readableUpdateError("Git fetch failed"), "Git fetch failed");
	assert.equal(readableUpdateError(""), "unknown");
});
