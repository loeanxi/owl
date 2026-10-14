import assert from "node:assert/strict";
import test from "node:test";
import { formatRunClock } from "./components/dynamic-island-model.ts";
import { resolveSessionRunTiming } from "./session-run-timing.ts";

test("a recovered duplicate agent_start keeps the original 12:28 clock instead of restart 0:24", () => {
	const originalStartedAt = 1_000_000;
	const restartStartedAt = originalStartedAt + 724_000;
	const now = originalStartedAt + 748_000;
	const restored = resolveSessionRunTiming({ startedAt: originalStartedAt }, {}, restartStartedAt);
	assert.equal(formatRunClock(restored.startedAt, now), "12:28");
});

test("backend original start repairs a cached restart timestamp for the same run", () => {
	const repaired = resolveSessionRunTiming({ runId: "original", startedAt: 1_724_000 }, { runId: "original", startedAt: 1_000_000 });
	assert.deepEqual(repaired, { runId: "original", startedAt: 1_000_000 });
	assert.equal(formatRunClock(repaired.startedAt, 1_748_000), "12:28");
});

test("an older bridge running snapshot without timing preserves the cached start", () => {
	assert.deepEqual(resolveSessionRunTiming({ startedAt: 1_000 }, {}, 0), { startedAt: 1_000 });
});

test("repeated start notifications for the same run preserve its known identity and clock", () => {
	assert.deepEqual(resolveSessionRunTiming({ runId: "one", startedAt: 1_000 }, { runId: "one" }, 9_000), { runId: "one", startedAt: 1_000 });
});

test("a real new run replaces the previous identity and clock", () => {
	assert.deepEqual(resolveSessionRunTiming({ runId: "one", startedAt: 1_000 }, { runId: "two", startedAt: 9_000 }, 10_000), { runId: "two", startedAt: 9_000 });
	assert.deepEqual(resolveSessionRunTiming({ runId: "one", startedAt: 1_000 }, { runId: "two" }, 10_000), { runId: "two", startedAt: 10_000 });
});

test("a legacy genuine new start after settlement uses its own timestamp", () => {
	assert.deepEqual(resolveSessionRunTiming(undefined, {}, 10_000), { startedAt: 10_000 });
});

test("unknown snapshot timing stays unknown until cache or authority is available", () => {
	assert.deepEqual(resolveSessionRunTiming(undefined, {}), { startedAt: 0 });
});

test("invalid wire timing cannot replace a healthy existing run", () => {
	for (const startedAt of [NaN, Infinity, -1, 0, "1_000", undefined]) {
		assert.deepEqual(resolveSessionRunTiming({ runId: "one", startedAt: 1_000 }, { runId: "", startedAt }, 9_000), { runId: "one", startedAt: 1_000 });
	}
});
