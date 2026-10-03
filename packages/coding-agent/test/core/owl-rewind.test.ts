import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SessionRewindTracker,
	listRewindTargets,
	type RewindAnchorSource,
	type RewindBranchEntry,
} from "../../src/core/rewind/engine.ts";
import { RewindSnapshotStore, captureFileState } from "../../src/core/rewind/store.ts";

let tempDir: string;
let workspace: string;
let agentDir: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `owl-rewind-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	workspace = join(tempDir, "workspace");
	agentDir = join(tempDir, "agent");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function newStore(sessionId = "s1"): RewindSnapshotStore {
	return new RewindSnapshotStore(join(agentDir, "rewind-snapshots", sessionId));
}

/** 构造一条线性分支：U1 < U2 < U3（三条用户消息，时间戳单调递增）。 */
function branchOf(...ids: string[]): RewindAnchorSource {
	const entries: RewindBranchEntry[] = ids.map((id, index) => ({
		id,
		parentId: index === 0 ? null : ids[index - 1]!,
		type: "message",
		timestamp: new Date(Date.parse("2026-01-01T00:00:00Z") + index * 60_000).toISOString(),
		message: { role: "user" },
	}));
	return { getBranch: () => entries };
}

describe("captureFileState", () => {
	it("缺文件 = existed:false；普通文件带内容 hash", () => {
		const missing = captureFileState(join(workspace, "nope.txt"), 1024);
		expect(missing.existed).toBe(false);
		expect(missing.content).toBeNull();

		const file = join(workspace, "a.txt");
		writeFileSync(file, "hello");
		const state = captureFileState(file, 1024);
		expect(state.existed).toBe(true);
		expect(state.content?.toString()).toBe("hello");
		expect(state.skipped).toBeUndefined();
	});

	// Windows 无特权建不了符号链接（EPERM）：只在有能力的平台上验证
	const itSymlink = process.platform === "win32" ? it.skip : it;
	itSymlink("软链接拒绝追踪", () => {
		const file = join(workspace, "a.txt");
		writeFileSync(file, "hello");
		const link = join(workspace, "link.txt");
		symlinkSync(file, link);
		const linkState = captureFileState(link, 1024);
		expect(linkState.skipped).toBe("link");
	});

	it("超过大小上限的文件标记 skipped", () => {
		const big = join(workspace, "big.bin");
		writeFileSync(big, Buffer.alloc(64, 1));
		const state = captureFileState(big, 16);
		expect(state.skipped).toBe("too-large");
	});
});

describe("RewindSnapshotStore", () => {
	it("追加的记录重载后完整可读；坏行被丢弃", () => {
		const store = newStore();
		store.recordCapture({ path: "p1", dirRealPath: workspace, anchorId: "u1", content: Buffer.from("v1"), source: "write" });
		store.recordCapture({ path: "p2", dirRealPath: workspace, anchorId: "u1", content: null, source: "write" });

		const reloaded = newStore();
		expect(reloaded.getRecords()).toHaveLength(2);
		expect(reloaded.getRecords()[0]?.existed).toBe(true);
		expect(reloaded.getRecords()[1]?.existed).toBe(false);
		expect(reloaded.readContent(reloaded.getRecords()[0]!)?.toString()).toBe("v1");
	});

	it("相同内容只存一份 blob；修剪按锚点组丢弃并回收无引用 blob", () => {
		const store = newStore();
		store.recordCapture({ path: "p1", dirRealPath: workspace, anchorId: "u1", content: Buffer.from("same"), source: "write" });
		store.recordCapture({ path: "p2", dirRealPath: workspace, anchorId: "u2", content: Buffer.from("same"), source: "write" });
		// 两个记录、一个 blob
		const blobs = readFileSync(join(store.sessionDir, "index.jsonl"), "utf-8").trim().split("\n");
		expect(blobs).toHaveLength(2);

		store.prune(1);
		expect(store.getRecords()).toHaveLength(1);
		expect(store.getRecords()[0]?.anchorId).toBe("u2");
		// u1 的 blob 与 u2 内容相同：内容寻址同一文件，不会被回收
		expect(store.readContent(store.getRecords()[0]!)?.toString()).toBe("same");
	});

	it("还原日志可写入读取清空；存在日志时 prune 跳过", () => {
		const store = newStore();
		expect(store.readJournal()).toBeNull();
		store.writeJournal({ v: 1, targetId: "u1", startedAt: "t", actions: [{ path: "p", action: "restore", done: false, hash: "h", dirRealPath: workspace }] });
		expect(store.readJournal()?.actions).toHaveLength(1);
		store.recordCapture({ path: "p3", dirRealPath: workspace, anchorId: "u1", content: Buffer.from("x"), source: "scan" });
		expect(store.prune(0)).toBe(0);
		store.writeJournal(null);
		expect(store.readJournal()).toBeNull();
	});
});

describe("SessionRewindTracker 追踪", () => {
	it("写前捕获 + 成功提交 → 记录写前内容；失败调用丢弃", () => {
		const store = newStore();
		const tracker = new SessionRewindTracker({ store, maxFileBytes: 1024 });
		const source = branchOf("u1");
		const file = join(workspace, "f.txt");
		writeFileSync(file, "before");

		tracker.stageCapture("t1", file, source);
		tracker.commitCapture("t1", false);
		expect(store.getRecords()).toHaveLength(1);
		expect(store.readContent(store.getRecords()[0]!)?.toString()).toBe("before");

		// 失败的 write 不留记录
		tracker.stageCapture("t2", file, source);
		tracker.commitCapture("t2", true);
		expect(store.getRecords()).toHaveLength(1);
	});

	it("新建文件的写前捕获（existed:false）成功后落记录", () => {
		const store = newStore();
		const tracker = new SessionRewindTracker({ store, maxFileBytes: 1024 });
		const file = join(workspace, "new.txt");
		tracker.stageCapture("t1", file, branchOf("u1"));
		writeFileSync(file, "created");
		tracker.commitCapture("t1", false);
		expect(store.getRecords()[0]?.existed).toBe(false);
	});

	it("边界重扫在磁盘未变时不新增记录（不变不存）", () => {
		const store = newStore();
		const tracker = new SessionRewindTracker({ store, maxFileBytes: 1024 });
		const file = join(workspace, "f.txt");
		writeFileSync(file, "v1");
		tracker.stageCapture("t1", file, branchOf("u1"));
		tracker.commitCapture("t1", false); // 记录 v1（u1 锚点）

		// u2 轮开始时磁盘仍是 v1：重扫不新增记录
		const u2 = branchOf("u1", "u2");
		tracker.stageBoundaryRescan();
		tracker.ensureBoundaryCommitted(u2);
		expect(store.getRecords()).toHaveLength(1);
	});

	it("重扫捕获边界时的外部改动内容", () => {
		const store = newStore();
		const tracker = new SessionRewindTracker({ store, maxFileBytes: 1024 });
		const file = join(workspace, "f.txt");
		writeFileSync(file, "v1");
		tracker.stageCapture("t1", file, branchOf("u1"));
		tracker.commitCapture("t1", false);

		writeFileSync(file, "bash-changed-it"); // u1 轮内 bash 改的
		const u2 = branchOf("u1", "u2");
		tracker.stageBoundaryRescan();
		tracker.ensureBoundaryCommitted(u2);
		const records = store.getRecords();
		expect(records).toHaveLength(2);
		expect(records[1]?.source).toBe("scan");
		expect(records[1]?.anchorId).toBe("u2");
		expect(store.readContent(records[1]!)?.toString()).toBe("bash-changed-it");
	});
});

describe("planRestore / applyRestore", () => {
	function trackerWith(records: Array<{ path: string; anchorId: string; content: string | null; source?: "write" | "scan" }>): SessionRewindTracker {
		const store = newStore();
		const tracker = new SessionRewindTracker({ store, maxFileBytes: 1024 });
		for (const record of records) {
			store.recordCapture({
				path: join(workspace, record.path),
				dirRealPath: workspace,
				anchorId: record.anchorId,
				content: record.content === null ? null : Buffer.from(record.content),
				source: record.source ?? "write",
			});
		}
		return tracker;
	}

	it("目标之后的第一条记录决定目标状态：还原到写前内容", () => {
		const file = "f.txt";
		const tracker = trackerWith([
			{ path: file, anchorId: "u2", content: "pre-edit" },
			{ path: file, anchorId: "u3", content: "pre-edit2" },
		]);
		writeFileSync(join(workspace, file), "current");
		const plan = tracker.planRestore({ entryId: "u2", time: new Date(Date.parse("2026-01-01T00:01:00Z")).toISOString() }, branchOf("u1", "u2", "u3"));
		expect(plan.actions).toHaveLength(1);
		expect(plan.actions[0]?.action).toBe("restore");

		const result = tracker.applyRestore(plan);
		expect(result.restored).toBe(1);
		expect(readFileSync(join(workspace, file), "utf-8")).toBe("pre-edit");
	});

	it("目标早于首次追踪 = 回到从未被工具改过的状态（用最早记录的写前态）", () => {
		const file = "g.txt";
		const tracker = trackerWith([{ path: file, anchorId: "u3", content: "original" }]);
		writeFileSync(join(workspace, file), "edited-by-tool");
		const plan = tracker.planRestore({ entryId: "u1", time: new Date(Date.parse("2026-01-01T00:00:00Z")).toISOString() }, branchOf("u1", "u2", "u3"));
		expect(plan.actions).toHaveLength(1);
		tracker.applyRestore(plan);
		expect(readFileSync(join(workspace, file), "utf-8")).toBe("original");
	});

	it("目标之后新建的文件（existed:false）回退时删除；已不在则跳过", () => {
		const created = "created.txt";
		const tracker = trackerWith([{ path: created, anchorId: "u3", content: null }]);
		writeFileSync(join(workspace, created), "tool-made");
		const plan = tracker.planRestore({ entryId: "u2", time: new Date(Date.parse("2026-01-01T00:01:00Z")).toISOString() }, branchOf("u1", "u2", "u3"));
		expect(plan.actions[0]?.action).toBe("delete");
		tracker.applyRestore(plan);
		expect(existsSync(join(workspace, created))).toBe(false);

		const plan2 = tracker.planRestore({ entryId: "u2", time: new Date(Date.parse("2026-01-01T00:01:00Z")).toISOString() }, branchOf("u1", "u2", "u3"));
		expect(plan2.actions).toHaveLength(0); // 幂等：再算一次已无事可做
		expect(plan2.unchanged).toBe(1);
	});

	it("被回退掉的旧未来的记录按时间戳参与比较，不影响更早目标的还原", () => {
		const file = "h.txt";
		const store = newStore();
		const tracker = new SessionRewindTracker({ store, maxFileBytes: 1024 });
		// u3 轮的写前记录（wall-clock 晚于 u2）
		store.recordCapture({
			path: join(workspace, file),
			dirRealPath: workspace,
			anchorId: "u3",
			content: Buffer.from("before-u3-write"),
			source: "write",
			time: new Date(Date.parse("2026-01-01T00:02:30Z")).toISOString(),
		});
		writeFileSync(join(workspace, file), "after-u3-write");
		// 回退到 u1（锚点不在当前分支也无所谓，时间戳说了算）
		const plan = tracker.planRestore({ entryId: "u1", time: new Date(Date.parse("2026-01-01T00:00:00Z")).toISOString() }, branchOf("u1"));
		expect(plan.actions).toHaveLength(1);
		tracker.applyRestore(plan);
		expect(readFileSync(join(workspace, file), "utf-8")).toBe("before-u3-write");
	});

	it("符号链接目标跳过还原并在结果里报告（仅非 Windows）", () => {
		if (process.platform === "win32") return; // 无特权建不了符号链接
		const real = join(workspace, "real.txt");
		const link = join(workspace, "alias.txt");
		writeFileSync(real, "data");
		symlinkSync(real, link);
		const store = newStore();
		const tracker = new SessionRewindTracker({ store, maxFileBytes: 1024 });
		store.recordCapture({ path: link, dirRealPath: workspace, anchorId: "u2", content: Buffer.from("older"), source: "write" });
		const plan = tracker.planRestore({ entryId: "u1", time: new Date(Date.parse("2026-01-01T00:00:00Z")).toISOString() }, branchOf("u1", "u2"));
		expect(plan.actions).toHaveLength(1);
		const result = tracker.applyRestore(plan);
		expect(result.restored).toBe(0);
		expect(result.skipped).toHaveLength(1);
		expect(readFileSync(real, "utf-8")).toBe("data");
	});

	it("半截还原日志在新追踪器上续做（崩溃安全）", () => {
		const file = join(workspace, "j.txt");
		writeFileSync(file, "current");
		const store = newStore();
		store.writeJournal({
			v: 1,
			targetId: "u1",
			startedAt: new Date().toISOString(),
			actions: [{ path: file, action: "restore", done: false, hash: null, dirRealPath: workspace }],
		});
		// 直接把内容写进 blob 再在日志里引用它
		const blobHash = "manual-hash";
		mkdirSync(join(store.sessionDir, "blobs"), { recursive: true });
		writeFileSync(join(store.sessionDir, "blobs", blobHash), "rescued-content");
		store.writeJournal({
			v: 1,
			targetId: "u1",
			startedAt: new Date().toISOString(),
			actions: [{ path: file, action: "restore", done: false, hash: blobHash, dirRealPath: workspace }],
		});

		const tracker = new SessionRewindTracker({ store, maxFileBytes: 1024 });
		const resumed = tracker.resumeInterruptedRestore();
		expect(resumed?.restored).toBe(1);
		expect(readFileSync(file, "utf-8")).toBe("rescued-content");
		expect(store.readJournal()).toBeNull();
	});
});

describe("listRewindTargets", () => {
	it("只收当前投影里的用户消息，跳过空文本", () => {
		const entries = [
			{ id: "e1", type: "message", timestamp: "t1", message: { role: "user", content: "第一条" } },
			{ id: "e2", type: "message", timestamp: "t2", message: { role: "assistant", content: "回答" } },
			{ id: "e3", type: "message", timestamp: "t3", message: { role: "user", content: [{ type: "text", text: "带图消息" }] } },
			{ id: "e4", type: "custom", timestamp: "t4" },
			{ id: "e5", type: "message", timestamp: "t5", message: { role: "user", content: "   " } },
		];
		const targets = listRewindTargets(entries);
		expect(targets.map((target) => target.entryId)).toEqual(["e1", "e3"]);
		expect(targets[1]?.text).toBe("带图消息");
	});
});
