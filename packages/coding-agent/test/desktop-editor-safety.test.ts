import { randomUUID } from "node:crypto";
import {
	existsSync,
	fsyncSync,
	ftruncateSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { EditorDraftStore } from "../src/modes/desktop/editor-drafts.ts";
import { EDITOR_TEXT_LIMIT, readEditorFile, saveEditorFile } from "../src/modes/desktop/editor-files.ts";
import type { EditorDraftPutRequest, FsReadResult } from "../src/modes/desktop/protocol.ts";
import * as atomicFile from "../src/utils/atomic-file.ts";

let root: string;
let cwd: string;
let profile: string;
let file: string;
let base: FsReadResult;
const guard = () => {};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "owl-editor-safety-"));
	cwd = join(root, "workspace");
	profile = join(root, "profile");
	mkdirSync(cwd);
	mkdirSync(profile);
	file = join(cwd, "file.txt");
	writeFileSync(file, "\uFEFF名称=原文\r\nmanual work\r\n");
	base = readEditorFile(cwd, file);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function draftRequest(
	content: string,
	expectedDraftRevision: string | null = null,
): Omit<EditorDraftPutRequest, "type" | "id" | "expectedProfile"> {
	return {
		cwd,
		path: "file.txt",
		content,
		baseRevision: base.revision,
		baseContent: base.content,
		expectedDraftRevision,
		operationId: randomUUID(),
		editorId: "window-one",
	};
}

describe("lossless versioned file saves", () => {
	it("reads full BOM/CRLF bytes and returns a new usable revision while retaining inode and permissions", async () => {
		expect(base).toMatchObject({
			kind: "text",
			editable: true,
			truncated: false,
			content: "\uFEFF名称=原文\r\nmanual work\r\n",
		});
		const before = statSync(file);
		const content = "\uFEFF名称=修改\r\nmanual work\r\n";
		const saved = await saveEditorFile(cwd, file, content, base.revision, guard);
		expect(saved).toMatchObject({ status: "saved", size: Buffer.byteLength(content) });
		if (saved.status !== "saved") throw new Error("Save conflict");
		expect(saved.revision).not.toBe(base.revision);
		expect(saved.revision).toBe(readEditorFile(cwd, file).revision);
		expect(statSync(file).ino).toBe(before.ino);
		expect(statSync(file).mode).toBe(before.mode);
		expect(readFileSync(file)).toEqual(Buffer.from(content));
		expect(readdirSync(cwd)).toEqual(["file.txt"]);
	});

	it("rejects external edits even when the timestamp is reset to the originally read value", async () => {
		const before = statSync(file);
		const manual = "manual replacement is mine\n";
		writeFileSync(file, manual);
		utimesSync(file, before.atime, before.mtime);
		const result = await saveEditorFile(cwd, file, "old editor buffer", base.revision, guard);
		expect(result).toMatchObject({ status: "conflict", current: { content: manual } });
		expect(readFileSync(file, "utf8")).toBe(manual);
	});

	it("detects replacement by a different inode even if all visible bytes match", async () => {
		const replacement = join(cwd, "replacement.txt");
		writeFileSync(replacement, base.content);
		renameSync(replacement, file);
		expect((await saveEditorFile(cwd, file, "stale buffer", base.revision, guard)).status).toBe("conflict");
		expect(readFileSync(file, "utf8")).toBe(base.content);
	});

	it("does not recreate a deleted file, and null only creates a genuinely missing path", async () => {
		unlinkSync(file);
		expect(await saveEditorFile(cwd, file, "stale buffer", base.revision, guard)).toMatchObject({
			status: "conflict",
		});
		expect(existsSync(file)).toBe(false);
		expect((await saveEditorFile(cwd, file, "explicit new file", null, guard)).status).toBe("saved");
		expect((await saveEditorFile(cwd, file, "replace existing", null, guard)).status).toBe("conflict");
		expect(readFileSync(file, "utf8")).toBe("explicit new file");
	});

	it("refuses missing revision input and cannot overwrite binary, non-UTF8, or truncated preview files", async () => {
		await expect(saveEditorFile(cwd, file, "unsafe", undefined as unknown as string, guard)).rejects.toThrow("版本");
		for (const bytes of [
			Buffer.from([0, 1, 2]),
			Buffer.from([0xff, 0xfe, 0x61]),
			Buffer.alloc(EDITOR_TEXT_LIMIT + 1, 0x61),
		]) {
			writeFileSync(file, bytes);
			const read = readEditorFile(cwd, file);
			expect(read.editable).toBe(false);
			expect(read.revision).toBeNull();
			expect(read.readOnlyReason).toBeTruthy();
			expect((await saveEditorFile(cwd, file, "lossy overwrite", null, guard)).status).toBe("conflict");
			expect((await saveEditorFile(cwd, file, "lossy overwrite", base.revision, guard)).status).toBe("conflict");
			expect(readFileSync(file)).toEqual(bytes);
		}
	});

	it("rejects lossy JavaScript surrogate output and oversize content before changing disk", async () => {
		for (const content of ["bad\ud800text", "binary\0text", "a".repeat(EDITOR_TEXT_LIMIT + 1)]) {
			await expect(saveEditorFile(cwd, file, content, base.revision, guard)).rejects.toThrow("UTF-8");
			expect(readFileSync(file, "utf8")).toBe(base.content);
		}
	});

	it("uses the real shared Agent mutation queue and rejects an Agent update that completes first", async () => {
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const agentWrite = withFileMutationQueue(file, async () => {
			entered.resolve();
			await released.promise;
			writeFileSync(file, "Agent later work");
		});
		await entered.promise;
		const editorWrite = saveEditorFile(cwd, file, "old editor", base.revision, guard);
		released.resolve();
		await agentWrite;
		expect((await editorWrite).status).toBe("conflict");
		expect(readFileSync(file, "utf8")).toBe("Agent later work");
	});

	it("rechecks account identity after waiting for the file queue", async () => {
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		let currentProfile = "one";
		const blocking = withFileMutationQueue(file, async () => {
			entered.resolve();
			await released.promise;
		});
		await entered.promise;
		const saving = saveEditorFile(cwd, file, "old profile write", base.revision, () => {
			if (currentProfile !== "one") throw new Error("profile changed");
		});
		currentProfile = "two";
		released.resolve();
		await blocking;
		await expect(saving).rejects.toThrow("profile changed");
		expect(readFileSync(file, "utf8")).toBe(base.content);
	});

	it("refuses links and outside paths without altering their targets", async () => {
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside original");
		linkSync(file, join(root, "hardlink.txt"));
		expect(readEditorFile(cwd, file).editable).toBe(false);
		expect((await saveEditorFile(cwd, file, "overwrite", base.revision, guard)).status).toBe("conflict");
		await expect(saveEditorFile(cwd, outside, "overwrite", base.revision, guard)).rejects.toThrow("工作区");
		const sub = join(cwd, "sub");
		mkdirSync(sub);
		const nested = join(sub, "nested.txt");
		writeFileSync(nested, "inside");
		const read = readEditorFile(cwd, nested);
		rmSync(sub, { recursive: true });
		symlinkSync(root, sub, process.platform === "win32" ? "junction" : "dir");
		expect((await saveEditorFile(cwd, nested, "overwrite", read.revision, guard)).status).toBe("conflict");
		expect(readFileSync(outside, "utf8")).toBe("outside original");
	});
});

describe("write failure retains recoverable original bytes", () => {
	it.each(["write-throw", "sync-throw", "write-return", "truncate-return"] as const)(
		"preserves later same-inode external work during %s",
		async (phase) => {
			const external = "EXTERNAL NEWER MANUAL CONTENT - preserve every byte\n";
			const oldInode = statSync(file).ino;
			await expect(
				saveEditorFile(cwd, file, "edited output", base.revision, guard, {
					write(fd, bytes, offset, length, position) {
						const count = writeSync(
							fd,
							bytes,
							offset,
							phase === "write-throw" ? Math.min(2, length) : length,
							position,
						);
						if (phase === "write-throw" || phase === "write-return") {
							writeFileSync(file, external);
							if (phase === "write-throw") throw new Error("write failed after external update");
						}
						return count;
					},
					truncate(fd, size) {
						ftruncateSync(fd, size);
						if (phase === "truncate-return") writeFileSync(file, external);
					},
					sync(fd) {
						if (phase === "sync-throw") {
							writeFileSync(file, external);
							throw new Error("sync failed after external write");
						}
						fsyncSync(fd);
					},
				}),
			).rejects.toThrow("原文备份");
			expect(statSync(file).ino).toBe(oldInode);
			expect(readFileSync(file, "utf8")).toBe(external);
			const backup = readdirSync(cwd).find((name) => name.includes(".owl-editor-backup-"));
			expect(backup).toBeTruthy();
			expect(readFileSync(join(cwd, backup!), "utf8")).toBe(base.content);
		},
	);

	it("does not delete a new file changed by another editor during a failed creation", async () => {
		const fresh = join(cwd, "new.txt");
		await expect(
			saveEditorFile(cwd, fresh, "intended fresh text", null, guard, {
				write(fd, bytes, offset, length, position) {
					writeSync(fd, bytes, offset, Math.min(2, length), position);
					writeFileSync(fresh, "a different external file");
					throw new Error("create interrupted");
				},
			}),
		).rejects.toThrow("新文件保存失败");
		expect(readFileSync(fresh, "utf8")).toBe("a different external file");
	});
	it.each(["partial-write", "truncate", "sync"] as const)(
		"recovers exact original text after %s failure",
		async (phase) => {
			let failed = false;
			await expect(
				saveEditorFile(cwd, file, "changed", base.revision, guard, {
					write(fd, bytes, offset, length, position) {
						if (phase === "partial-write" && !failed) {
							failed = true;
							writeSync(fd, bytes, offset, Math.min(2, length), position);
							throw new Error("injected write");
						}
						return writeSync(fd, bytes, offset, length, position);
					},
					truncate(fd, size) {
						ftruncateSync(fd, size);
						if (phase === "truncate" && !failed) {
							failed = true;
							throw new Error("injected truncate");
						}
					},
					sync(fd) {
						if (phase === "sync" && !failed) {
							failed = true;
							throw new Error("injected sync");
						}
						fsyncSync(fd);
					},
				}),
			).rejects.toThrow("已恢复原文");
			expect(readFileSync(file)).toEqual(Buffer.from(base.content));
			expect(readdirSync(cwd)).toEqual(["file.txt"]);
		},
	);

	it("retains a full private backup and reports its path if automatic recovery also fails", async () => {
		let reason = "";
		try {
			await saveEditorFile(cwd, file, "changed", base.revision, guard, {
				write(fd, bytes, offset, length, position) {
					writeSync(fd, bytes, offset, Math.min(1, length), position);
					throw new Error("persistent write error");
				},
			});
		} catch (error) {
			reason = String(error);
		}
		const backup = readdirSync(cwd).find((name) => name.includes(".owl-editor-backup-"));
		expect(backup).toBeTruthy();
		expect(reason).toContain(join(cwd, backup!));
		expect(readFileSync(join(cwd, backup!))).toEqual(Buffer.from(base.content));
		if (process.platform !== "win32") expect(lstatSync(join(cwd, backup!)).mode & 0o777).toBe(0o600);
	});
});

describe("durable draft revision slots", () => {
	it("rejects profile-storage directory junctions into another profile before reading or writing drafts", () => {
		const otherProfile = join(root, "profile-b");
		mkdirSync(otherProfile);
		const other = new EditorDraftStore(otherProfile, guard);
		other.put(draftRequest("PROFILE B PRIVATE DATA"));
		symlinkSync(
			join(otherProfile, "editor-drafts"),
			join(profile, "editor-drafts"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const a = new EditorDraftStore(profile, guard);
		expect(() => a.get(cwd, "file.txt")).toThrow("链接");
		expect(() => a.list(cwd)).toThrow("链接");
		expect(() => a.put(draftRequest("A must not overwrite B"))).toThrow("链接");
		expect(other.get(cwd, "file.txt").draft?.content).toBe("PROFILE B PRIVATE DATA");
	});

	it("rejects namespace junctions, slot symlinks and hard-linked slots across profiles", () => {
		const otherProfile = join(root, "profile-b");
		mkdirSync(otherProfile);
		const other = new EditorDraftStore(otherProfile, guard);
		other.put(draftRequest("PROFILE B PRIVATE DATA"));
		const otherRoot = join(otherProfile, "editor-drafts");
		const namespace = readdirSync(otherRoot)[0];
		const slotName = readdirSync(join(otherRoot, namespace))[0];
		const aRoot = join(profile, "editor-drafts");
		mkdirSync(aRoot);
		const aNamespace = join(aRoot, namespace);
		symlinkSync(join(otherRoot, namespace), aNamespace, process.platform === "win32" ? "junction" : "dir");
		expect(() => new EditorDraftStore(profile, guard).get(cwd, "file.txt")).toThrow("链接");
		rmSync(aNamespace);
		mkdirSync(aNamespace);
		linkSync(join(otherRoot, namespace, slotName), join(aNamespace, slotName));
		expect(() => new EditorDraftStore(profile, guard).get(cwd, "file.txt")).toThrow("链接");
		unlinkSync(join(aNamespace, slotName));
		if (process.platform !== "win32") {
			symlinkSync(join(otherRoot, namespace, slotName), join(aNamespace, slotName));
			expect(() => new EditorDraftStore(profile, guard).get(cwd, "file.txt")).toThrow("链接");
		}
	});
	it("preserves a newer window's content against stale puts and stale save-confirmation removes", () => {
		const a = new EditorDraftStore(profile, guard);
		const b = new EditorDraftStore(profile, guard);
		const first = a.put(draftRequest("PRIVATE first draft"));
		if (first.status !== "saved") throw new Error("Draft conflict");
		expect(b.put(draftRequest("stale other-window draft"))).toMatchObject({
			status: "conflict",
			draft: { content: "PRIVATE first draft" },
		});
		const next = b.put(draftRequest("PRIVATE newer draft", first.draftRevision));
		if (next.status !== "saved") throw new Error("Draft conflict");
		expect(a.remove(cwd, "file.txt", first.draftRevision)).toMatchObject({
			status: "conflict",
			draft: { content: "PRIVATE newer draft" },
		});
		expect(new EditorDraftStore(profile, guard).get(cwd, "file.txt").draft?.content).toBe("PRIVATE newer draft");
		expect(JSON.stringify(a.list(cwd))).not.toContain("PRIVATE");
	});

	it("retries the same snapshot idempotently, refuses operation-token reuse, and never revives deleted drafts", () => {
		const store = new EditorDraftStore(profile, guard);
		const input = draftRequest("first");
		const saved = store.put(input);
		if (saved.status !== "saved") throw new Error("Draft conflict");
		expect(store.put(input)).toEqual(saved);
		expect(store.put({ ...input, content: "different", expectedDraftRevision: saved.draftRevision }).status).toBe(
			"conflict",
		);
		const removed = store.remove(cwd, "file.txt", saved.draftRevision);
		if (removed.status !== "removed") throw new Error("Draft conflict");
		expect(store.get(cwd, "file.txt")).toEqual({ draft: null, draftRevision: removed.draftRevision });
		expect(store.put(input).status).toBe("conflict");
		expect(store.put(draftRequest("stale initial create")).status).toBe("conflict");
		expect(store.put(draftRequest("new intentional draft", removed.draftRevision)).status).toBe("saved");
	});

	it("keeps complete baseline and editor content after the disk file is deleted or externally changed", () => {
		const store = new EditorDraftStore(profile, guard);
		store.put(draftRequest("retained unsaved text"));
		unlinkSync(file);
		const restored = new EditorDraftStore(profile, guard).get(cwd, "file.txt");
		expect(restored.draft).toMatchObject({
			content: "retained unsaved text",
			baseContent: base.content,
			baseRevision: base.revision,
		});
		expect(existsSync(file)).toBe(false);
		writeFileSync(file, Buffer.from([0xff, 0, 0x66]));
		expect(store.put(draftRequest("newer unsaved text", restored.draftRevision)).status).toBe("saved");
		expect(readFileSync(file)).toEqual(Buffer.from([0xff, 0, 0x66]));
	});

	it("isolates profiles and workspaces while canonical aliases find the same draft", () => {
		const store = new EditorDraftStore(profile, guard);
		const saved = store.put(draftRequest("account A only"));
		expect(saved.status).toBe("saved");
		expect(new EditorDraftStore(join(root, "other-profile"), guard).list().drafts).toEqual([]);
		const other = join(root, "other-workspace");
		mkdirSync(other);
		writeFileSync(join(other, "file.txt"), base.content);
		expect(store.get(other, "file.txt").draft).toBeNull();
		const alias = join(root, "workspace-alias");
		symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
		expect(store.get(alias, "file.txt").draft?.content).toBe("account A only");
	});

	it("rejects incomplete or fake baselines and never mutates files while storing material", () => {
		const store = new EditorDraftStore(profile, guard);
		expect(() => store.put({ ...draftRequest("text"), baseContent: "only a partial prefix" })).toThrow("完整基线");
		expect(() => store.put({ ...draftRequest("text"), baseRevision: null, baseContent: "" })).toThrow("已有文件");
		expect(() => store.put({ ...draftRequest("text"), path: "../escape" })).toThrow("相对");
		expect(readFileSync(file, "utf8")).toBe(base.content);
	});

	it("retains the prior draft if its durable write fails, and the same operation can retry safely", () => {
		const store = new EditorDraftStore(profile, guard);
		const first = store.put(draftRequest("retained first"));
		if (first.status !== "saved") throw new Error("Draft conflict");
		const input = draftRequest("failed new draft", first.draftRevision);
		const spy = vi.spyOn(atomicFile, "atomicWriteFileSync").mockImplementation(() => {
			throw new Error("disk full");
		});
		expect(() => store.put(input)).toThrow("disk full");
		expect(store.get(cwd, "file.txt").draft?.content).toBe("retained first");
		spy.mockRestore();
		expect(store.put(input).status).toBe("saved");
	});
});
