import assert from "node:assert/strict";
import test from "node:test";
import {
	emptyIslandMemory,
	islandMemoryKey,
	loadIslandMemory,
	mergeIslandMemory,
	parseIslandMemory,
	reconcileIslandMemory,
	rememberIslandCompletion,
	saveIslandMemory,
} from "./dynamic-island-memory.ts";
import { dismissFinished, type IslandSession, islandFace } from "./dynamic-island-model.ts";

function session(id: string, startedAt = 10): IslandSession {
	return {
		id,
		title: `任务 ${id}`,
		startedAt,
		lastActivityAt: 20,
		step: "writing",
		waiting: false,
		waitKind: "",
		whisper: "",
	};
}

function storage() {
	const saved = new Map<string, string>();
	return {
		saved,
		getItem: (key: string): string | null => saved.get(key) ?? null,
		setItem: (key: string, value: string): void => {
			saved.set(key, value);
		},
	};
}

test("profile paths normalize without sharing memory between profiles or session scopes", () => {
	assert.equal(islandMemoryKey(" D:\\owl\\data\\owl\\ "), islandMemoryKey("d:/owl/data/owl"));
	assert.notEqual(islandMemoryKey("d:/owl/one"), islandMemoryKey("d:/owl/two"));
	assert.notEqual(islandMemoryKey("d:/owl/one", "chat"), islandMemoryKey("d:/owl/one", "research"));
	const local = storage();
	assert.equal(saveIslandMemory(local, "", emptyIslandMemory()), false);
	assert.equal(local.saved.size, 0);
	assert.equal(loadIslandMemory(local, ""), null);
});

test("reload restores task titles, elapsed start, completion and an unfinished reply", () => {
	const local = storage();
	const memory = {
		...rememberIslandCompletion(emptyIslandMemory(), "done", "完成的任务", 30, "done"),
		running: [session("live")],
		expanded: true,
		replyFor: "done",
		replyDraft: "继续处理下一段",
	};
	assert.equal(saveIslandMemory(local, "d:/owl/local", memory), true);
	assert.deepEqual(loadIslandMemory(local, "d:/owl/local"), memory);
	assert.equal(loadIslandMemory(local, "d:/owl/other"), null);
});

test("empty startup or a transient disconnect preserves running contents until backend confirmation", () => {
	const memory = { ...emptyIslandMemory(), running: [session("live")], expanded: true };
	const next = reconcileIslandMemory(memory, [], false, 1_000);
	assert.equal(next, memory);
	assert.equal(islandFace(next.running, next.finished).kind, "live");
	assert.equal(next.running[0]?.startedAt, 10);
});

test("backend confirmation removes an absent running task and leaves an interrupted completion", () => {
	const memory = { ...emptyIslandMemory(), running: [session("gone")], expanded: true };
	const next = reconcileIslandMemory(memory, [], true, 1_000);
	assert.deepEqual(next.running, []);
	assert.deepEqual(next.finished, [{ id: "gone", title: "任务 gone", finishedAt: 1_000, outcome: "aborted" }]);
	assert.equal(reconcileIslandMemory(next, [], true, 2_000), next);
});

test("a genuine completion notice replaces a restored interruption and can still be acknowledged", () => {
	const missing = reconcileIslandMemory({ ...emptyIslandMemory(), running: [session("gone")] }, [], true, 1_000);
	const done = rememberIslandCompletion(missing, "gone", "任务 gone", 1_100, "done");
	assert.equal(done.finished.length, 1);
	assert.equal(done.finished[0]?.outcome, "done");
	const acknowledged = { ...done, finished: dismissFinished(done.finished, "gone") };
	const local = storage();
	saveIslandMemory(local, "profile", acknowledged);
	assert.deepEqual(loadIslandMemory(local, "profile")?.finished, []);
});

test("live task ids are authoritative once ready and same-run metadata survives incomplete hydration", () => {
	const memory = { ...emptyIslandMemory(), running: [session("live"), session("gone")] };
	const live = { ...session("live"), startedAt: 0, lastActivityAt: 0, title: "", step: "" };
	const next = reconcileIslandMemory(memory, [live], true, 50);
	assert.deepEqual(next.running, [session("live")]);
	assert.equal(next.finished[0]?.id, "gone");
	assert.equal(next.finished[0]?.outcome, "aborted");
});

test("starting a new run drops an old completion, old step and stale reply draft", () => {
	const prior = {
		...rememberIslandCompletion(emptyIslandMemory(), "same", "旧任务", 15, "done"),
		running: [session("same")],
		replyFor: "same",
		replyDraft: "尚未发送",
	};
	const next = reconcileIslandMemory(prior, [{ ...session("same", 100), step: "" }], true, 100);
	assert.deepEqual(next.finished, []);
	assert.equal(next.running[0]?.step, "");
	assert.equal(next.replyFor, null);
	assert.equal(next.replyDraft, "");
});

test("malformed storage never prevents island startup", () => {
	const local = storage();
	local.setItem(islandMemoryKey("profile"), "{invalid");
	assert.equal(loadIslandMemory(local, "profile"), null);
	assert.equal(parseIslandMemory({ version: 2, running: [], finished: [] }), null);
	assert.equal(
		loadIslandMemory(
			{
				getItem: () => {
					throw new Error("blocked");
				},
			},
			"profile",
		),
		null,
	);
	assert.equal(
		saveIslandMemory(
			{
				setItem: () => {
					throw new Error("full");
				},
			},
			"profile",
			emptyIslandMemory(),
		),
		false,
	);
});

test("an early completion before profile hydration is merged without resurrecting its cached running task", () => {
	const saved = {
		...rememberIslandCompletion(emptyIslandMemory(), "older", "已有完成", 5, "done"),
		running: [session("early")],
		expanded: true,
	};
	const pending = rememberIslandCompletion(emptyIslandMemory(), "early", "刚完成的任务", 50, "done");
	const next = mergeIslandMemory(saved, pending);
	assert.deepEqual(next.running, []);
	assert.deepEqual(
		next.finished.map((row) => row.id),
		["older", "early"],
	);
	assert.equal(next.expanded, true);
	assert.equal(next.finished.find((row) => row.id === "early")?.outcome, "done");
});

test("late profile hydration does not replace a saved run start with an unknown clock", () => {
	const saved = { ...emptyIslandMemory(), running: [session("live", 1_000)] };
	const pending = { ...emptyIslandMemory(), running: [{ ...session("live", 0), step: "" }] };
	assert.equal(mergeIslandMemory(saved, pending).running[0]?.startedAt, 1_000);
});

test("backend titles update remembered completions while unavailable titles leave the memory intact", () => {
	const memory = rememberIslandCompletion(emptyIslandMemory(), "done", "原名", 50, "done");
	assert.equal(reconcileIslandMemory(memory, [], true, 100), memory);
	const renamed = reconcileIslandMemory(memory, [], true, 100, new Map([["done", "新名"]]));
	assert.equal(renamed.finished[0]?.title, "新名");
	assert.equal(reconcileIslandMemory(renamed, [], true, 200, new Map()), renamed);
});

test("invalid entries and unsafe reply states are scrubbed without discarding healthy items", () => {
	const parsed = parseIslandMemory({
		version: 1,
		running: [session("healthy"), { ...session("invalid"), startedAt: -1 }],
		finished: [
			{ id: "error", title: "失败任务", finishedAt: 40, outcome: "error" },
			{ id: "bad", title: "坏记录", finishedAt: 40, outcome: "unknown" },
		],
		expanded: true,
		replyFor: "error",
		replyDraft: "禁止恢复到失败任务",
	});
	assert.deepEqual(parsed?.running, [session("healthy")]);
	assert.equal(parsed?.finished.length, 1);
	assert.equal(parsed?.replyFor, null);
	assert.equal(parsed?.replyDraft, "");
});
