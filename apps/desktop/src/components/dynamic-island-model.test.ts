import assert from "node:assert/strict";
import test from "node:test";
import {
	dismissFinished,
	formatRunClock,
	islandCompactAction,
	islandCanReply,
	islandFace,
	islandJumpTarget,
	islandQuestionChoices,
	islandPips,
	islandSessionTitle,
	islandWhisper,
	rememberFinished,
	visibleFinished,
	type IslandSession,
} from "./dynamic-island-model.ts";

function session(id: string, at: number, waiting = false, waitKind: IslandSession["waitKind"] = ""): IslandSession {
	return { id, title: id, lastActivityAt: at, startedAt: at, step: "", waiting: waiting || waitKind !== "", waitKind, whisper: "" };
}

function done(id: string, at: number, outcome: "done" | "aborted" | "error" = "done") {
	return { id, title: id, finishedAt: at, outcome };
}

test("idle when nothing is running and nothing is waiting to be opened", () => {
	assert.deepEqual(islandFace([], []), { kind: "idle" });
	assert.deepEqual(islandCompactAction({ kind: "idle" }), { type: "none" });
});

test("compact names the session that most recently produced, with a total count", () => {
	const face = islandFace([session("a", 10), session("b", 30), session("c", 20)], []);
	assert.deepEqual(face, { kind: "live", id: "b", title: "b", waiting: false, waitKind: "", count: 3 });
	assert.deepEqual(islandCompactAction(face), { type: "toggle" });
});

test("equal activity timestamps break ties by id", () => {
	const face = islandFace([session("b", 5), session("a", 5)], []);
	assert.equal(face.kind === "live" && face.id, "a");
});

test("waiting follows the session on the pill", () => {
	const face = islandFace([session("a", 1), session("b", 9, true)], []);
	assert.equal(face.kind === "live" && face.waiting, true);
});

test("a session waiting on you outranks one that is still producing", () => {
	const face = islandFace([session("streaming", 50), session("blocked", 10, true)], []);
	assert.equal(face.kind === "live" && face.id, "blocked");
});

test("a permission wait outranks a newer question", () => {
	const face = islandFace([
		session("ask", 50, false, "question"),
		session("gate", 10, false, "permission"),
	], []);
	assert.equal(face.kind === "live" && face.id, "gate");
	assert.equal(face.kind === "live" && face.waitKind, "permission");
});

test("the shortcut opens whoever the pill is naming", () => {
	assert.equal(islandJumpTarget({ kind: "idle" }), null);
	assert.equal(islandJumpTarget({ kind: "live", id: "gate", title: "gate", waiting: true, waitKind: "permission", count: 2 }), "gate");
	assert.equal(islandJumpTarget({ kind: "done", id: "c", title: "c", count: 3, outcome: "done" }), "c");
});

test("several running sessions become a short row of lights", () => {
	assert.deepEqual(islandPips([session("only", 1)]), []);
	const pips = islandPips([
		session("stream", 40),
		session("ask", 30, false, "question"),
		session("other", 20),
		session("extra", 10),
		session("overflow", 5),
	]);
	assert.deepEqual(pips.map((pip) => pip.id), ["ask", "stream", "other", "extra"]);
	assert.equal(pips[0]?.lead, true);
	assert.equal(pips[0]?.waiting, true);
	assert.equal(pips[1]?.lead, false);
});

test("a question is clipped to one short line", () => {
	assert.equal(islandWhisper("  要不要\n继续  "), "要不要 继续");
	assert.equal(islandWhisper("1234567890123456789"), "123456789012345678…");
	assert.equal(islandWhisper("   "), "");
});

test("the run clock stays compact", () => {
	assert.equal(formatRunClock(1_000, 1_000), "0:00");
	assert.equal(formatRunClock(0, 12_000), "0:12");
	assert.equal(formatRunClock(0, 75_000), "1:15");
	assert.equal(formatRunClock(0, 3_661_000), "1:01:01");
});

test("a finished session stays beside work that is still running", () => {
	const running = [session("a", 10), session("b", 20)];
	const finished = [done("c", 30)];
	assert.deepEqual(islandFace(running, finished), { kind: "live", id: "b", title: "b", waiting: false, waitKind: "", count: 2 });
	assert.deepEqual(visibleFinished(running, finished).map((item) => item.id), ["c"]);
});

test("with nothing running, the pill stays on the latest unchecked completion", () => {
	const face = islandFace([], [done("a", 1), done("c", 5)]);
	assert.deepEqual(face, { kind: "done", id: "c", title: "c", count: 2, outcome: "done" });
	assert.deepEqual(islandCompactAction(face), { type: "toggle" });
	assert.deepEqual(islandCompactAction({ kind: "done", id: "c", title: "c", count: 1, outcome: "done" }), { type: "open", id: "c" });
});

test("a stopped or failed run keeps its own mark", () => {
	const face = islandFace([], [done("ok", 1), done("stop", 4, "aborted")]);
	assert.equal(face.kind === "done" && face.outcome, "aborted");
	assert.equal(islandCanReply("done"), true);
	assert.equal(islandCanReply("aborted"), false);
	assert.equal(islandCanReply("error"), false);
});

test("the island only offers choices for a single short question", () => {
	assert.deepEqual(islandQuestionChoices({ count: 1, multi: false, labels: [" 继续 ", "停"] }), ["继续", "停"]);
	assert.deepEqual(islandQuestionChoices({ count: 2, multi: false, labels: ["继续"] }), []);
	assert.deepEqual(islandQuestionChoices({ count: 1, multi: true, labels: ["甲", "乙"] }), []);
	assert.deepEqual(islandQuestionChoices({ count: 1, multi: false, labels: ["1", "2", "3", "4", "5"] }), []);
});

test("checking off a completion removes only that one", () => {
	const kept = rememberFinished(rememberFinished([], "a", 1), "b", 2);
	assert.deepEqual(kept.map((item) => item.id), ["a", "b"]);
	const next = dismissFinished(kept, "a");
	assert.deepEqual(next.map((item) => item.id), ["b"]);
	assert.equal(dismissFinished(next, "missing"), next);
});

test("a session that starts again is no longer listed as finished", () => {
	assert.deepEqual(visibleFinished([session("a", 9)], [done("a", 1), done("b", 2)]).map((item) => item.id), ["b"]);
});

test("session titles prefer a custom name, then the first message", () => {
	const text = { unnamed: "未命名", branch: "分支", fallback: "会话 ab" };
	assert.equal(islandSessionTitle({ name: " 自定义 " }, text), "自定义");
	assert.equal(islandSessionTitle({ firstMessage: "你好\n世界", parentSessionPath: "parent" }, text), "你好 世界 · 分支");
	assert.equal(islandSessionTitle({ id: "abcdef12" }, text), "会话 ab");
	assert.equal(islandSessionTitle({}, text), "未命名");
});
