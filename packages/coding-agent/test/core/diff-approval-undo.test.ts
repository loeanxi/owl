import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceDiffApprovalStore } from "../../src/core/diff-approval/registry.ts";
import { DiffApprovalStore, diffApprovalStorePath } from "../../src/core/diff-approval/store.ts";
import { createEditTool } from "../../src/core/tools/edit.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";

let root: string;
let cwd: string;
let file: string;
let storePath: string;
let store: DiffApprovalStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "owl-safe-undo-"));
	cwd = join(root, "workspace");
	mkdirSync(cwd);
	file = join(cwd, "file.txt");
	storePath = diffApprovalStorePath(root, cwd);
	store = getWorkspaceDiffApprovalStore(root, cwd);
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

function capture(content: string, toolCallId = "edit-1", sessionId = "session-a", path = file): string {
	store.stage(toolCallId, path, {
		sessionId,
		turnId: `turn-${toolCallId}`,
		toolName: "write",
		input: { content },
	});
	store.recordMutationBefore(`${sessionId}:${toolCallId}`, content);
	writeFileSync(path, content);
	store.commit(toolCallId, false, sessionId);
	const row = store.list(cwd, { sessionId, toolCallIds: [toolCallId] })[0];
	if (!row) throw new Error("No operation captured");
	return row.id;
}

async function revert(ids: string[]) {
	const preview = store.preview(ids);
	return { preview, result: await store.resolve(ids, "revert", preview.token) };
}

describe("operation-scoped undo preserves the working file", () => {
	it("undoes the first round while retaining a second round in the same file", async () => {
		writeFileSync(file, "header\nfirst: old\nmiddle\nsecond: old\nfooter\n");
		const first = capture("header\nfirst: agent\nmiddle\nsecond: old\nfooter\n", "first");
		const second = capture("header\nfirst: agent\nmiddle\nsecond: later\nfooter\n", "second");
		const { preview, result } = await revert([first]);
		expect(preview.files[0]).toMatchObject({ entryIds: [first], canRevert: true });
		expect(preview.files[0].diff).toContain("-first: agent");
		expect(preview.files[0].diff).toContain("+first: old");
		expect(result).toMatchObject({ resolved: 1, resolvedIds: [first], failed: [] });
		expect(readFileSync(file, "utf8")).toBe("header\nfirst: old\nmiddle\nsecond: later\nfooter\n");
		expect(store.list(cwd).find((row) => row.id === second)?.status).toBe("pending");
		// The later operation remains independently undoable after the first was removed.
		expect((await revert([second])).result.failed).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("header\nfirst: old\nmiddle\nsecond: old\nfooter\n");
	});

	it("retains disjoint manual changes and exact CRLF/BOM bytes", async () => {
		writeFileSync(file, "\uFEFFtitle\r\nagent=old\r\nspacer\r\nmanual=old\r\n");
		const id = capture("\uFEFFtitle\r\nagent=new\r\nspacer\r\nmanual=old\r\n");
		writeFileSync(file, "\uFEFFtitle\r\nagent=new\r\nspacer\r\nmanual=mine\r\n");
		expect((await revert([id])).result.failed).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("\uFEFFtitle\r\nagent=old\r\nspacer\r\nmanual=mine\r\n");
	});

	it("preserves manual insertions that shift the undo position", async () => {
		writeFileSync(file, "one\ntwo\nthree\nfour\n");
		const id = capture("one\nTWO\nthree\nfour\n");
		writeFileSync(file, "manual\none\nTWO\nthree\nfour\nextra\n");
		expect((await revert([id])).result.failed).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("manual\none\ntwo\nthree\nfour\nextra\n");
	});

	it("refuses overlapping manual edits and leaves both content and pending status unchanged", async () => {
		writeFileSync(file, "value=old\n");
		const id = capture("value=agent\n");
		writeFileSync(file, "value=mine\n");
		const { preview, result } = await revert([id]);
		expect(preview.files[0]).toMatchObject({ canRevert: false, reason: expect.stringContaining("重叠") });
		expect(result.resolved).toBe(0);
		expect(result.failed[0].reason).toContain("重叠");
		expect(readFileSync(file, "utf8")).toBe("value=mine\n");
		expect(store.list(cwd)[0].status).toBe("pending");
	});

	it("does not remove a later manual edit even when it is on a different column of one line", async () => {
		writeFileSync(file, "a=old; b=old;\n");
		const id = capture("a=new; b=old;\n");
		writeFileSync(file, "a=new; b=mine;\n");
		expect((await revert([id])).result.resolved).toBe(0);
		expect(readFileSync(file, "utf8")).toBe("a=new; b=mine;\n");
	});

	it("refuses ambiguous insertion when manual deletion chose between identical blocks", async () => {
		writeFileSync(file, "A\ndeleted by agent\nB\nA\nB\n");
		const id = capture("A\nB\nA\nB\n");
		writeFileSync(file, "A\nB\n");
		expect((await revert([id])).result.resolved).toBe(0);
		expect(readFileSync(file, "utf8")).toBe("A\nB\n");
	});

	it("does not cross a later operation that edited the same line and then changed it back", async () => {
		writeFileSync(file, "original\n");
		const first = capture("agent\n", "first");
		capture("later\n", "second");
		capture("agent\n", "third");
		expect((await revert([first])).result.failed[0].reason).toContain("重叠");
		expect(readFileSync(file, "utf8")).toBe("agent\n");
	});

	it("retains later kept disjoint changes even after completed rows are cleared", async () => {
		writeFileSync(file, "one=old\nspacer\ntwo=old\n");
		const first = capture("one=first\nspacer\ntwo=old\n", "first");
		const later = capture("one=first\nspacer\ntwo=kept\n", "later");
		expect((await store.resolve([later], "keep")).failed).toEqual([]);
		expect(store.clearResolved()).toBe(1);
		expect(store.list(cwd).map((row) => row.id)).toEqual([first]);
		expect((await revert([first])).result.failed).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("one=old\nspacer\ntwo=kept\n");
	});

	it("keeps the net-zero later-operation protection after keep and clear", async () => {
		writeFileSync(file, "original\n");
		const first = capture("agent\n", "first");
		const second = capture("later\n", "second");
		const third = capture("agent\n", "third");
		await store.resolve([second, third], "keep");
		expect(store.clearResolved()).toBe(2);
		expect((await revert([first])).result.failed[0].reason).toContain("重叠");
		expect(readFileSync(file, "utf8")).toBe("agent\n");
	});

	it("does not delete a creation with unselected later operations even when their net change is zero", async () => {
		const first = capture("agent\n", "first");
		capture("later\n", "second");
		capture("agent\n", "third");
		expect((await revert([first])).result.failed[0].reason).toContain("未选中的后续操作");
		expect(readFileSync(file, "utf8")).toBe("agent\n");
	});

	it("simulates all selected same-file operations before writing, preventing partial undo on conflict", async () => {
		writeFileSync(file, "one=old\nspacer\ntwo=old\n");
		const first = capture("one=first\nspacer\ntwo=old\n", "first");
		const second = capture("one=first\nspacer\ntwo=second\n", "second");
		const current = "one=mine\nspacer\ntwo=second\n";
		writeFileSync(file, current);
		const { result } = await revert([first, second]);
		expect(result.resolved).toBe(0);
		expect(result.failed).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe(current);
		expect(store.list(cwd).map((row) => row.status)).toEqual(["pending", "pending"]);
	});

	it("reverses a complete selected chain in capture order even with identical timestamps and shuffled IDs", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
		writeFileSync(file, "old\n");
		const first = capture("first\n", "first");
		const second = capture("second\n", "second");
		const preview = store.preview([second, first], "baseline");
		expect(preview.files[0].canRevert).toBe(true);
		expect((await store.resolve([first, second], "revert", preview.token)).failed).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("old\n");
	});

	it("refuses new-file deletion when later manual text exists", async () => {
		const id = capture("agent\n");
		writeFileSync(file, "agent\nmy work\n");
		expect((await revert([id])).result.failed[0].reason).toContain("不能删除");
		expect(readFileSync(file, "utf8")).toBe("agent\nmy work\n");
	});

	it("deletes an unchanged new file only after a matching preview", async () => {
		const id = capture("agent\n");
		const { preview, result } = await revert([id]);
		expect(preview.files[0]).toMatchObject({ targetExists: false, canRevert: true });
		expect(result.failed).toEqual([]);
		expect(existsSync(file)).toBe(false);
	});

	it("never recreates a file manually deleted after the agent edited it", async () => {
		writeFileSync(file, "old\n");
		const id = capture("agent\n");
		unlinkSync(file);
		expect((await revert([id])).result.failed[0].reason).toContain("不会自动重建");
		expect(existsSync(file)).toBe(false);
	});

	it("does not remove unselected later changes when a creation and its selected edit are undone together", async () => {
		const creation = capture("original\n", "create");
		const editing = capture("edited\n", "edit");
		const { result } = await revert([creation, editing]);
		expect(result.resolved).toBe(2);
		expect(existsSync(file)).toBe(false);
	});

	it("returns per-file partial failures while applying independent safe files", async () => {
		const other = join(cwd, "other.txt");
		writeFileSync(file, "one\n");
		writeFileSync(other, "two\n");
		const first = capture("ONE\n", "first");
		const second = capture("TWO\n", "second", "session-a", other);
		writeFileSync(other, "mine\n");
		const { result } = await revert([first, second]);
		expect(result).toMatchObject({ resolved: 1, resolvedIds: [first] });
		expect(result.failed).toEqual([{ path: other, reason: expect.stringContaining("重叠") }]);
		expect(readFileSync(file, "utf8")).toBe("one\n");
		expect(readFileSync(other, "utf8")).toBe("mine\n");
	});

	it("repeated successful undo is idempotent and does not touch a later manual edit", async () => {
		writeFileSync(file, "old\n");
		const id = capture("agent\n");
		const preview = store.preview([id]);
		expect((await store.resolve([id], "revert", preview.token)).resolved).toBe(1);
		writeFileSync(file, "manual after undo\n");
		expect(await store.resolve([id], "revert", preview.token)).toMatchObject({ resolved: 1, failed: [] });
		expect(readFileSync(file, "utf8")).toBe("manual after undo\n");
	});
});

describe("preview compare-and-swap", () => {
	it("requires a preview token and rejects a token for a different selection", async () => {
		writeFileSync(file, "old\n");
		const first = capture("one\n", "first");
		const second = capture("two\n", "second");
		expect((await store.resolve([first], "revert")).failed[0].reason).toContain("预览已失效");
		const preview = store.preview([second]);
		expect((await store.resolve([first], "revert", preview.token)).resolved).toBe(0);
		expect(readFileSync(file, "utf8")).toBe("two\n");
	});

	it("rejects disk changes after preview even if they are disjoint", async () => {
		writeFileSync(file, "old\nspacer\nend\n");
		const id = capture("agent\nspacer\nend\n");
		const preview = store.preview([id]);
		writeFileSync(file, "agent\nspacer\nmanual\n");
		expect((await store.resolve([id], "revert", preview.token)).failed[0].reason).toContain("预览后文件已变化");
		expect(readFileSync(file, "utf8")).toBe("agent\nspacer\nmanual\n");
		expect((await revert([id])).result.failed).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("old\nspacer\nmanual\n");
	});

	it("rejects a replaced inode with the same contents", async () => {
		writeFileSync(file, "old\n");
		const id = capture("agent\n");
		const preview = store.preview([id]);
		unlinkSync(file);
		writeFileSync(file, "agent\n");
		expect((await store.resolve([id], "revert", preview.token)).resolved).toBe(0);
		expect(readFileSync(file, "utf8")).toBe("agent\n");
	});

	it("expires previews", async () => {
		vi.useFakeTimers();
		writeFileSync(file, "old\n");
		const id = capture("agent\n");
		const preview = store.preview([id]);
		vi.setSystemTime(Date.now() + 6 * 60 * 1000);
		expect((await store.resolve([id], "revert", preview.token)).failed[0].reason).toContain("预览已失效");
	});

	it("rejects a preview if another store changed the path's operation history", async () => {
		writeFileSync(file, "old\nspacer\nend\n");
		const first = capture("agent\nspacer\nend\n", "first");
		const preview = store.preview([first]);
		const another = new DiffApprovalStore({ filePath: storePath, workspaceDir: cwd });
		another.load();
		another.stage("other", file, { sessionId: "other", turnId: "turn", toolName: "write", input: {} });
		another.recordMutationBefore("other:other", "agent\nspacer\nother\n");
		writeFileSync(file, "agent\nspacer\nother\n");
		another.commit("other", false, "other");
		expect((await store.resolve([first], "revert", preview.token)).failed[0].reason).toContain("条目已变化");
		expect(readFileSync(file, "utf8")).toBe("agent\nspacer\nother\n");
	});
});

describe("provenance and capture safety", () => {
	it("scopes same-path and same-tool-ID operations to their owning session", () => {
		writeFileSync(file, "base\n");
		const first = capture("one\n", "same-id", "a");
		const second = capture("two\n", "same-id", "b");
		expect(first).not.toBe(second);
		expect(store.list(cwd, { sessionId: "a", toolCallIds: ["same-id"] }).map((row) => row.id)).toEqual([first]);
		expect(store.list(cwd, { sessionId: "b", toolCallIds: ["same-id"] }).map((row) => row.id)).toEqual([second]);
		expect(store.list(cwd, { sessionId: "a", toolCallIds: [] })).toEqual([]);
	});

	it("includes nested operations for the exact parent tool ID, not similarly prefixed IDs", () => {
		writeFileSync(file, "base\n");
		const id = capture("one\n", "code/0");
		capture("two\n", "codex/0");
		expect(store.list(cwd, { sessionId: "session-a", toolCallIds: ["code"] }).map((row) => row.id)).toEqual([id]);
	});

	it("does not adopt external content written before tool_result as the tool's after-image", () => {
		writeFileSync(file, "base\n");
		store.stage("call", file, { sessionId: "a", turnId: "turn", toolName: "write", input: { content: "agent\n" } });
		store.recordMutationBefore("a:call", "agent\n");
		writeFileSync(file, "agent plus manual\n");
		store.commit("call", false, "a");
		const row = store.list(cwd)[0];
		expect(row).toMatchObject({ revertible: false, revertReason: expect.stringContaining("执行期间") });
		expect(store.preview([row.id]).files[0].canRevert).toBe(false);
	});

	it("does not record failed calls or consume a different session's staged call", () => {
		writeFileSync(file, "base\n");
		store.stage("call", file, { sessionId: "a", turnId: "turn", toolName: "write", input: { content: "agent\n" } });
		store.commit("call", false, "b");
		expect(store.list(cwd)).toEqual([]);
		store.commit("call", true, "a");
		expect(store.list(cwd)).toEqual([]);
	});

	it("checks predicted edit output with the real tool including fuzzy text, BOM and mixed line endings", async () => {
		const original = "\uFEFFheading\r\nvalue = ‘old’\nuntouched\r\n";
		writeFileSync(file, original);
		const input = { path: file, edits: [{ oldText: "value = 'old'", newText: "value = 'new'" }] };
		store.stage("edit", file, { sessionId: "a", turnId: "turn", toolName: "edit", input });
		await createEditTool(cwd).execute("edit", input);
		store.commit("edit", false, "a");
		const row = store.list(cwd)[0];
		expect(row.revertible).toBe(true);
		expect((await revert([row.id])).result.failed).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("checks captured write output against the real write tool", async () => {
		const input = { path: file, content: "actual tool output\n" };
		store.stage("write", file, { sessionId: "a", turnId: "turn", toolName: "write", input });
		await createWriteTool(cwd).execute("write", input);
		store.commit("write", false, "a");
		expect(store.list(cwd)[0]).toMatchObject({ revertible: true, originalExisted: false });
	});

	it("captures write's real before-image when manual work changed after tool_call", async () => {
		writeFileSync(file, "before stage\n");
		const input = { path: file, content: "agent output\n" };
		store.stage("write", file, { sessionId: "a", turnId: "turn", toolName: "write", input });
		writeFileSync(file, "manual made after stage\n");
		await createWriteTool(cwd).execute("write", input);
		store.commit("write", false, "a");
		const row = store.list(cwd)[0];
		expect(row.revertible).toBe(true);
		expect((await revert([row.id])).result.failed).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("manual made after stage\n");
	});

	it("fails closed on tool-call ownership ambiguity across sessions", async () => {
		writeFileSync(file, "before\n");
		const input = { path: file, content: "agent\n" };
		for (const sessionId of ["a", "b"]) {
			store.stage("same", file, { sessionId, turnId: "turn", toolName: "write", input });
		}
		await createWriteTool(cwd).execute("same", input);
		for (const sessionId of ["a", "b"]) store.commit("same", false, sessionId);
		expect(store.list(cwd)).toHaveLength(2);
		expect(store.list(cwd).every((row) => row.revertible === false && row.revertReason?.includes("归属不唯一"))).toBe(
			true,
		);
	});

	it("rejects any record without a trusted tool mutation boundary", () => {
		writeFileSync(file, "before\n");
		store.stage("call", file, { sessionId: "a", turnId: "turn", toolName: "write", input: { content: "agent\n" } });
		writeFileSync(file, "agent\n");
		store.commit("call", false, "a");
		expect(store.list(cwd)[0]).toMatchObject({
			revertible: false,
			revertReason: expect.stringContaining("准确快照"),
		});
	});

	it("does not treat custom remote write operations as proof of a local mutation", async () => {
		writeFileSync(file, "already matches remote output\n");
		const input = { path: file, content: "already matches remote output\n" };
		store.stage("custom", file, { sessionId: "a", turnId: "turn", toolName: "write", input });
		await createWriteTool(cwd, {
			operations: {
				writeFile: async () => {},
				mkdir: async () => {},
				exists: async () => false,
			},
		}).execute("custom", input);
		store.commit("custom", false, "a");
		expect(store.list(cwd)[0]).toMatchObject({
			revertible: false,
			revertReason: expect.stringContaining("准确快照"),
		});
	});

	it("refuses an edit's stale read source without writing over an intervening manual edit", () => {
		writeFileSync(file, "original\n");
		store.stage("edit", file, { sessionId: "a", turnId: "turn", toolName: "edit", input: {} });
		writeFileSync(file, "manual\n");
		expect(() => store.recordMutationBefore("a:edit", "agent\n", "original\n")).toThrow("已停止写入");
		expect(readFileSync(file, "utf8")).toBe("manual\n");
	});

	it("loads legacy baselines visibly but refuses automatic overwrite; keep remains available", async () => {
		writeFileSync(file, "latest manual\n");
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				version: 1,
				workspaceDir: cwd,
				entries: [
					{
						id: "legacy",
						path: file,
						status: "pending",
						originalExisted: true,
						originalContent: "very old\n",
						baselineAt: "2026-01-01T00:00:00Z",
						resolvedAt: null,
					},
				],
			}),
		);
		store = new DiffApprovalStore({ filePath: storePath, workspaceDir: cwd });
		store.load();
		expect(store.list(cwd)[0]).toMatchObject({ scope: "legacy", revertible: false });
		expect((await revert(["legacy"])).result.failed[0].reason).toContain("旧记录");
		expect(readFileSync(file, "utf8")).toBe("latest manual\n");
		expect((await store.resolve(["legacy"], "keep")).resolved).toBe(1);
	});

	it("persists per-operation after snapshots across restart", async () => {
		writeFileSync(file, "base\n");
		const id = capture("agent\n");
		store = new DiffApprovalStore({ filePath: storePath, workspaceDir: cwd });
		store.load();
		expect(store.list(cwd)[0]).toMatchObject({ id, toolCallId: "edit-1", revertible: true });
		expect((await revert([id])).result.failed).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("base\n");
	});

	it("isolates different account stores for the same workspace", () => {
		const one = getWorkspaceDiffApprovalStore(join(root, "account-a"), cwd);
		const two = getWorkspaceDiffApprovalStore(join(root, "account-b"), cwd);
		expect(one).not.toBe(two);
	});

	it("preserves records from two stores loaded before either saves, and allocates a single capture order", async () => {
		writeFileSync(file, "base\nspacer\nend\n");
		const another = new DiffApprovalStore({ filePath: storePath, workspaceDir: cwd });
		another.load();
		const first = capture("first\nspacer\nend\n", "first");
		another.stage("second", file, { sessionId: "b", turnId: "turn", toolName: "write", input: {} });
		another.recordMutationBefore("b:second", "first\nspacer\nsecond\n");
		writeFileSync(file, "first\nspacer\nsecond\n");
		another.commit("second", false, "b");
		expect(store.list(cwd)).toHaveLength(2);
		const records = JSON.parse(readFileSync(storePath, "utf8")) as { entries: Array<{ sequence: number }> };
		expect(records.entries.map((row) => row.sequence).sort()).toEqual([1, 2]);
		await store.resolve([first], "keep");
		expect(another.list(cwd)).toHaveLength(2);
		expect(another.list(cwd).find((row) => row.id === first)?.status).toBe("kept");
	});
});

describe("filesystem boundaries", () => {
	it("rejects paths outside the workspace", async () => {
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "mine\n");
		const id = capture("agent\n", "outside", "a", outside);
		expect(store.list(cwd)[0].revertReason).toContain("工作区");
		expect((await revert([id])).result.resolved).toBe(0);
		expect(readFileSync(outside, "utf8")).toBe("agent\n");
	});

	it("rejects binary and invalid UTF-8 files without changing their bytes", async () => {
		writeFileSync(file, "old\n");
		const id = capture("agent\n");
		for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe, 0x61])]) {
			writeFileSync(file, bytes);
			expect((await revert([id])).result.failed[0].reason).toContain("二进制");
			expect(readFileSync(file)).toEqual(bytes);
		}
	});

	it("rejects hard links so undo cannot alter another path outside the workspace", async () => {
		writeFileSync(file, "old\n");
		const id = capture("agent\n");
		const outside = join(root, "hardlinked.txt");
		linkSync(file, outside);
		expect((await revert([id])).result.failed[0].reason).toContain("普通独立文件");
		expect(readFileSync(outside, "utf8")).toBe("agent\n");
	});

	it("rejects a parent directory replaced by a junction", async () => {
		const sub = join(cwd, "sub");
		const outside = join(root, "outside");
		mkdirSync(sub);
		mkdirSync(outside);
		const nested = join(sub, "file.txt");
		writeFileSync(nested, "old\n");
		const id = capture("agent\n", "nested", "a", nested);
		const preview = store.preview([id]);
		unlinkSync(nested);
		rmSync(sub, { recursive: true });
		writeFileSync(join(outside, "file.txt"), "manual outside\n");
		symlinkSync(outside, sub, process.platform === "win32" ? "junction" : "dir");
		expect((await store.resolve([id], "revert", preview.token)).failed[0].reason).toContain("符号链接");
		expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("manual outside\n");
	});
});
