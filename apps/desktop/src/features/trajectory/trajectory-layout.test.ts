import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEntry } from "../hooks/transcript.ts";
import { deriveTrajectoryLayout } from "./trajectory-layout.ts";
import { deriveTrajectoryTimeline } from "./trajectory-timeline.ts";

const BASE = 1_760_000_000_000;

function userEntry(text: string, timestamp: number, queued = false): ChatEntry {
	return { kind: "user", text, timestamp, ...(queued ? { queued: true } : {}) };
}

function assistantEntry(overrides: Partial<Extract<ChatEntry, { kind: "assistant" }>> & { timestamp: number }): ChatEntry {
	return {
		kind: "assistant",
		text: "",
		thinking: "",
		tools: [],
		segments: [],
		...overrides,
	};
}

test("fold: sealed user messages split turns; queued follow-ups stay in turn", () => {
	const snapshot = deriveTrajectoryLayout([
		userEntry("第一问", BASE),
		assistantEntry({ text: "答一", timestamp: BASE + 1000, endedAt: BASE + 3000 }),
		userEntry("排队跟进", BASE + 4000, true),
		assistantEntry({ text: "答二", timestamp: BASE + 5000 }),
		userEntry("第二问", BASE + 6000),
	]);
	assert.equal(snapshot.turns.length, 2);
	assert.equal(snapshot.turns[0]!.turn, 1);
	assert.equal(snapshot.turns[1]!.turn, 2);
	// 第 1 轮含两条用户行（开场白 + 排队跟进）
	const turn1Users = snapshot.turns[0]!.groups.flatMap((group) => group.cells).filter((cell) => cell.kind === "user");
	assert.equal(turn1Users.length, 2);
});

test("fold: tool cards become cells with own duration and status", () => {
	const snapshot = deriveTrajectoryLayout([
		userEntry("查一下", BASE),
		assistantEntry({
			timestamp: BASE + 1000,
			endedAt: BASE + 9000,
			text: "结论",
			thinking: "想一想",
			usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0 },
			tools: [
				{ id: "t1", name: "grep", args: '{"pattern":"x"}', summary: "搜索 x", status: "ok", startedAt: BASE + 2000, finishedAt: BASE + 2500 },
				{ id: "t2", name: "bash", args: '{"command":"exit 1"}', summary: "执行", status: "error", startedAt: BASE + 3000, finishedAt: BASE + 3200 },
			],
		}),
	]);
	const cells = snapshot.turns[0]!.groups.flatMap((group) => group.cells);
	const grep = cells.find((cell) => cell.title === "grep");
	const bash = cells.find((cell) => cell.title === "bash");
	assert.equal(grep?.timeSeconds, 0.5);
	assert.equal(grep?.streaming, undefined);
	assert.equal(bash?.isError, true);
	assert.equal(bash?.timeSeconds, 0.2);
	const message = cells.find((cell) => cell.kind === "message");
	assert.equal(message?.timeSeconds, 8);
	assert.equal(message?.thinkingDetail, "想一想");
	assert.equal(message?.usage?.output, 20);
	assert.equal(snapshot.stats.calls, 2);
	assert.equal(snapshot.stats.steps, 1);
	assert.equal(snapshot.stats.tokens.input, 100);
});

test("fold: codemode subtools follow their parent", () => {
	const snapshot = deriveTrajectoryLayout([
		userEntry("跑一段代码", BASE),
		assistantEntry({
			timestamp: BASE,
			tools: [
				{ id: "p", name: "run_code", args: "{}", summary: "跑代码", status: "ok", startedAt: BASE + 100, finishedAt: BASE + 500 },
				{ id: "c", name: "bash", args: "{}", summary: "子调用", status: "ok", startedAt: BASE + 200, finishedAt: BASE + 300, parentToolCallId: "p" },
			],
		}),
	]);
	const cells = snapshot.turns[0]!.groups.at(-1)!.cells;
	const kinds = cells.map((cell) => cell.kind);
	assert.deepEqual(kinds, ["message", "tool", "subtool"]);
});

test("timeline: sequence mode lays equal unit spans on three lanes with turn boundaries", () => {
	const snapshot = deriveTrajectoryLayout([
		userEntry("一", BASE),
		assistantEntry({ timestamp: BASE + 1000, text: "答", tools: [{ id: "t", name: "grep", args: "", summary: "s", status: "ok", startedAt: BASE + 1200, finishedAt: BASE + 1400 }] }),
		userEntry("二", BASE + 9000),
	]);
	const model = deriveTrajectoryTimeline(snapshot.turns, "sequence");
	assert.ok(model);
	assert.equal(model.spans.length, 4);
	assert.equal(model.start, 0);
	assert.equal(model.end, 4);
	const lanes = model.spans.map((span) => span.lane);
	assert.deepEqual(lanes, [0, 1, 2, 0]);
	assert.equal(model.turnBoundaries.length, 2);
	assert.equal(model.turnBoundaries[1]!.position, 3);
	// span 带回台账行锚点
	assert.match(model.spans[0]!.recordId, /^user\u0000/);
});

test("timeline: actual mode projects wall-clock spans, empty history yields null", () => {
	const snapshot = deriveTrajectoryLayout([
		userEntry("一", BASE),
		assistantEntry({ timestamp: BASE + 1000, endedAt: BASE + 5000, text: "答" }),
	]);
	const model = deriveTrajectoryTimeline(snapshot.turns, "actual");
	assert.ok(model);
	assert.equal(model.start, BASE);
	assert.equal(model.end, BASE + 5000);
	const message = model.spans.find((span) => span.kind === "message");
	assert.ok(message);
	assert.equal(message!.end - message!.start, 4000);
	assert.equal(deriveTrajectoryTimeline([], "actual"), null);
});
