import {
	fsyncSync,
	ftruncateSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DiffApprovalMutationIO, DiffApprovalStore } from "../../src/core/diff-approval/store.ts";

let cwd: string;
let file: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "owl-undo-write-failure-"));
	file = join(cwd, "file.txt");
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function setup(mutationIO: Partial<DiffApprovalMutationIO>) {
	const store = new DiffApprovalStore({ filePath: join(cwd, "approval.json"), workspaceDir: cwd, mutationIO });
	store.load();
	writeFileSync(file, "original agent line\nseparator\nmanual=old\n");
	const after = "changed agent line\nseparator\nmanual=old\n";
	store.stage("edit", file, { sessionId: "session", turnId: "turn", toolName: "write", input: { content: after } });
	store.recordMutationBefore("session:edit", after);
	writeFileSync(file, after);
	store.commit("edit", false, "session");
	// Manual work added after the captured operation must survive both undo and its failure path.
	const current = "changed agent line\nseparator\nmanual=MY OWN WORK\n";
	writeFileSync(file, current);
	const id = store.list(cwd)[0].id;
	const preview = store.preview([id]);
	expect(preview.files[0].canRevert).toBe(true);
	return { store, id, preview, current };
}

function backups() {
	return readdirSync(cwd)
		.filter((name) => name.includes(".owl-undo-backup-"))
		.map((name) => join(cwd, name));
}

describe("undo write failure recovery", () => {
	it("restores every original byte after writeSync partially writes and then throws", async () => {
		let failed = false;
		const { store, id, preview, current } = setup({
			write(fd, bytes, offset, length, position) {
				if (!failed) {
					failed = true;
					writeSync(fd, bytes, offset, Math.min(4, length), position);
					throw new Error("injected partial write failure");
				}
				return writeSync(fd, bytes, offset, length, position);
			},
		});
		const result = await store.resolve([id], "revert", preview.token);
		expect(result).toMatchObject({ resolved: 0, failed: [{ reason: expect.stringContaining("已恢复原文") }] });
		expect(readFileSync(file, "utf8")).toBe(current);
		expect(store.list(cwd)[0].status).toBe("pending");
		expect(backups()).toEqual([]);
	});

	it("restores bytes and length if ftruncateSync fails after truncating the target", async () => {
		let failed = false;
		const { store, id, preview, current } = setup({
			truncate(fd, size) {
				ftruncateSync(fd, size);
				if (!failed) {
					failed = true;
					throw new Error("injected truncate failure");
				}
			},
		});
		const result = await store.resolve([id], "revert", preview.token);
		expect(result.failed[0].reason).toContain("已恢复原文");
		expect(readFileSync(file)).toEqual(Buffer.from(current));
		expect(backups()).toEqual([]);
	});

	it("restores the pre-preview file if fsyncSync fails after the complete undo write", async () => {
		let failed = false;
		const { store, id, preview, current } = setup({
			sync(fd) {
				if (!failed) {
					failed = true;
					throw new Error("injected sync failure");
				}
				fsyncSync(fd);
			},
		});
		const result = await store.resolve([id], "revert", preview.token);
		expect(result.failed[0].reason).toContain("已恢复原文");
		expect(readFileSync(file, "utf8")).toBe(current);
		expect(backups()).toEqual([]);
	});

	it("retains a durable exact backup and reports its absolute path when rollback writes also fail", async () => {
		const { store, id, preview, current } = setup({
			write(fd, bytes, offset, length, position) {
				writeSync(fd, bytes, offset, Math.min(2, length), position);
				throw new Error("injected persistent disk failure");
			},
		});
		const result = await store.resolve([id], "revert", preview.token);
		const retained = backups();
		expect(result.resolved).toBe(0);
		expect(result.failed[0].reason).toContain("自动恢复失败");
		expect(retained).toHaveLength(1);
		expect(result.failed[0].reason).toContain(`原文备份：${retained[0]}`);
		expect(readFileSync(retained[0])).toEqual(Buffer.from(current));
		if (process.platform !== "win32") expect(statSync(retained[0]).mode & 0o777).toBe(0o600);
		expect(store.list(cwd)[0].status).toBe("pending");
	});

	it("keeps the backup if rollback bytes match but their durability cannot be confirmed", async () => {
		const { store, id, preview, current } = setup({
			sync() {
				throw new Error("disk sync unavailable");
			},
		});
		const result = await store.resolve([id], "revert", preview.token);
		expect(result.failed[0].reason).toContain("自动恢复失败");
		expect(readFileSync(file, "utf8")).toBe(current);
		expect(backups()).toHaveLength(1);
		expect(readFileSync(backups()[0], "utf8")).toBe(current);
	});

	it("does not overwrite a new file placed at the path while a failing write was in progress", async () => {
		const { store, id, preview, current } = setup({
			write(fd, bytes, offset, length, position) {
				writeSync(fd, bytes, offset, Math.min(2, length), position);
				renameSync(file, join(cwd, "replaced-original.txt"));
				writeFileSync(file, "a new manual file\n");
				throw new Error("file replaced during write");
			},
		});
		const result = await store.resolve([id], "revert", preview.token);
		expect(result.failed[0].reason).toContain("身份已变化");
		expect(readFileSync(file, "utf8")).toBe("a new manual file\n");
		expect(readFileSync(backups()[0], "utf8")).toBe(current);
	});

	it("removes the backup after a fully successful undo and keeps the same file identity", async () => {
		const { store, id, preview } = setup({});
		const before = statSync(file);
		const result = await store.resolve([id], "revert", preview.token);
		expect(result).toMatchObject({ resolved: 1, failed: [] });
		expect(backups()).toEqual([]);
		expect(statSync(file).ino).toBe(before.ino);
		expect(statSync(file).mode).toBe(before.mode);
		expect(readFileSync(file, "utf8")).toBe("original agent line\nseparator\nmanual=MY OWN WORK\n");
	});
});
