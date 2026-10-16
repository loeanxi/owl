import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorController, type DraftSlot, type EditorDraft, type EditorFileApi, type EditorRead, type EditorSaveResult } from "./editor-controller.ts";
import { applyEditorTextChanges, editorDisplayText } from "./editor-text.ts";
import { beginEditorAccountTransition, cancelEditorAccountTransition, prepareEditorExit, registerEditorExitGuard } from "./editor-exit-guard.ts";

function memoryStorage() {
	const values = new Map<string, string>();
	return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function harness() {
	let disk: EditorRead = { kind: "text", content: "base\n", size: 5, truncated: false, editable: true, revision: "base-revision" };
	let slot: DraftSlot = { draft: null, draftRevision: "deleted-slot-v0" };
	let serial = 0;
	const api: EditorFileApi = {
		fsRead: vi.fn(async () => disk),
		editorDraftGet: vi.fn(async () => slot),
		editorFileSave: vi.fn(async (_cwd, path, content, expectedRevision) => { if (path === "a.txt" && disk.revision !== expectedRevision) return { status: "conflict", reason: "file changed", current: disk }; const revision = `saved-${++serial}`; if (path === "a.txt") disk = { ...disk, content, revision }; return { status: "saved", path, size: content.length, revision }; }),
		editorDraftPut: vi.fn(async (cwd, path, value) => { if (slot.draftRevision !== value.expectedDraftRevision) return { status: "conflict", reason: "newer draft", ...slot }; const draft: EditorDraft = { cwd, path, ...value, updatedAt: Date.now(), draftRevision: `draft-${++serial}` }; slot = { draft, draftRevision: draft.draftRevision }; return { status: "saved", draft, draftRevision: draft.draftRevision }; }),
		editorDraftRemove: vi.fn(async (_cwd, _path, expected) => { if (slot.draftRevision !== expected) return { status: "conflict", reason: "newer draft", ...slot }; slot = { draft: null, draftRevision: `deleted-${++serial}` }; return { status: "removed", draft: null, draftRevision: slot.draftRevision! }; }),
	};
	const storage = memoryStorage();
	const controller = new EditorController(api, "D:/project", "a.txt", "D:/profile", storage);
	return { api, storage, controller, disk: () => disk, setDisk: (next: Partial<EditorRead>) => { disk = { ...disk, ...next }; }, slot: () => slot, setSlot: (next: DraftSlot) => { slot = next; } };
}

describe("editor save and draft ownership", () => {
	it("blocks empty/loading and read-only saves including truncated, binary and non-UTF8 reads", async () => {
		const h = harness(); expect(await h.controller.save()).toBe(false); expect(h.api.editorFileSave).not.toHaveBeenCalled();
		for (const value of [{ truncated: true }, { kind: "binary" as const }, { editable: false, readOnlyReason: "not UTF-8" }]) {
			const fixture = harness(); fixture.setDisk(value); await fixture.controller.load(); fixture.controller.change("bad"); expect(await fixture.controller.save()).toBe(false); expect(fixture.api.editorFileSave).not.toHaveBeenCalled();
		}
	});
	it("serializes save clicks and only clears the submitted buffer version after its acknowledgement", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("v1");
		const response = Promise.withResolvers<EditorSaveResult>(); vi.mocked(h.api.editorFileSave).mockReturnValueOnce(response.promise);
		const save = h.controller.save(); expect(await h.controller.save()).toBe(false); h.controller.change("v2"); response.resolve({ status: "saved", path: "a.txt", size: 2, revision: "v1-on-disk" });
		expect(await save).toBe(false); expect(h.controller.getSnapshot().text).toBe("v2"); expect(h.controller.isDirty()).toBe(true); expect(h.controller.getSnapshot().baseRevision).toBe("v1-on-disk"); expect(h.api.editorFileSave).toHaveBeenCalledTimes(1);
	});
	it("does not delete a newer acknowledged draft when an older disk save returns", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("v1"); await h.controller.preserveDraft();
		const response = Promise.withResolvers<EditorSaveResult>(); vi.mocked(h.api.editorFileSave).mockReturnValueOnce(response.promise); const save = h.controller.save();
		h.controller.change("v2"); await h.controller.preserveDraft();
		response.resolve({ status: "saved", path: "a.txt", size: 2, revision: "v1-on-disk" }); await save;
		expect(h.slot().draft).toMatchObject({ content: "v2", baseContent: "v1", baseRevision: "v1-on-disk" }); expect(h.api.editorDraftRemove).not.toHaveBeenCalled();
		const wal = [...h.storage.values.values()].map((raw) => JSON.parse(raw)).find((record) => record.content === "v2"); expect(wal).toMatchObject({ baseContent: "v1", baseRevision: "v1-on-disk", localRevision: h.controller.revision() });
	});
	it("a draft put in flight followed by more typing eventually persists the latest buffer", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("v1");
		const first = Promise.withResolvers<Awaited<ReturnType<EditorFileApi["editorDraftPut"]>>>(); const base = vi.mocked(h.api.editorDraftPut).getMockImplementation()!; vi.mocked(h.api.editorDraftPut).mockImplementationOnce(() => first.promise);
		const saving = h.controller.preserveDraft(); h.controller.change("v2");
		first.resolve(await base("D:/project", "a.txt", { content: "v1", baseContent: "base\n", baseRevision: "base-revision", expectedDraftRevision: "deleted-slot-v0", operationId: "first" }, "D:/profile")); await saving;
		await vi.waitFor(() => expect(h.slot().draft?.content).toBe("v2")); expect(h.controller.getSnapshot().text).toBe("v2"); expect(h.controller.getSnapshot().serverSavedVersion).toBe(h.controller.revision());
	});
	it("uses a tombstone slot revision and retries an uncertain put with the same operation ID", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("mine"); vi.mocked(h.api.editorDraftPut).mockRejectedValueOnce(new Error("offline"));
		expect(await h.controller.preserveDraft()).toBe(false); expect(h.controller.getSnapshot().draftStatus).toBe("error"); expect(await h.controller.preserveDraft()).toBe(true);
		const calls = vi.mocked(h.api.editorDraftPut).mock.calls; expect(calls[0][2].expectedDraftRevision).toBe("deleted-slot-v0"); expect(calls[1][2].operationId).toBe(calls[0][2].operationId);
	});
	it("does not replace dirty text when reloading a changed disk and does not blindly rebase a restored draft", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("mine"); h.setDisk({ content: "other", revision: "other-revision" });
		expect(await h.controller.reload()).toBe(false); expect(h.controller.getSnapshot().text).toBe("mine"); expect(h.controller.getSnapshot().conflict?.content).toBe("other"); expect(await h.controller.save()).toBe(false); expect(h.api.editorFileSave).not.toHaveBeenCalled();
	});
	it("restores server drafts only into the editor, detects changed baselines and saves a new file with expected null", async () => {
		const h = harness(); h.setSlot({ draftRevision: "remote", draft: { cwd: "D:/project", path: "a.txt", content: "recovered", baseContent: "old", baseRevision: "old-revision", updatedAt: 1, draftRevision: "remote", operationId: "remote" } });
		await h.controller.load(); expect(h.controller.getSnapshot().text).toBe("base\n"); expect(h.controller.restore("server")).toBe(true); expect(h.controller.getSnapshot().text).toBe("recovered"); expect(h.api.editorFileSave).not.toHaveBeenCalled(); expect(await h.controller.save()).toBe(false);
		expect(await h.controller.saveAs("rescue.txt")).toBe(true); expect(h.api.editorFileSave).toHaveBeenCalledWith("D:/project", "rescue.txt", "recovered", null, "D:/profile"); expect(h.disk().content).toBe("base\n");
	});
	it("retains recovered content for save-as when the original file has disappeared", async () => {
		const h = harness(); vi.mocked(h.api.fsRead).mockRejectedValueOnce(new Error("ENOENT")); h.setSlot({ draftRevision: "remote", draft: { cwd: "D:/project", path: "a.txt", content: "irreplaceable", baseContent: "base", baseRevision: "gone", updatedAt: 1, draftRevision: "remote", operationId: "remote" } });
		await h.controller.load(); h.controller.restore("server"); expect(h.controller.getSnapshot().text).toBe("irreplaceable"); expect(await h.controller.save()).toBe(false); expect(await h.controller.saveAs("rescue.txt")).toBe(true);
	});
	it.each(["save", "discard"] as const)("two writers at version one keep separate WALs when A's %s acknowledges late", async (action) => {
		const h = harness(); const second = new EditorController(h.api, "D:/project", "a.txt", "D:/profile", h.storage); await h.controller.load(); await second.load(); h.controller.change("writer A"); second.change("writer B"); expect(h.controller.revision()).toBe(1); expect(second.revision()).toBe(1); expect(h.storage.length).toBe(2);
		const wait = Promise.withResolvers<EditorSaveResult>(); if (action === "save") vi.mocked(h.api.editorFileSave).mockReturnValueOnce(wait.promise);
		const operation = action === "save" ? h.controller.save() : h.controller.discard();
		if (action === "save") wait.resolve({ status: "saved", path: "a.txt", size: 8, revision: "A-saved" }); await operation;
		expect(second.isProtected()).toBe(true); expect([...h.storage.values.values()].some((raw) => JSON.parse(raw).content === "writer B")).toBe(true);
		const refreshed = new EditorController(h.api, "D:/project", "a.txt", "D:/profile", h.storage); expect(refreshed.getSnapshot().localRecoveries?.some((draft) => draft.content === "writer B")).toBe(true);
	});
	it("does not claim protection when a WAL is removed or localStorage fills", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("mine"); expect(h.controller.isProtected()).toBe(true); h.storage.values.clear(); expect(h.controller.isProtected()).toBe(false);
		vi.spyOn(h.storage, "setItem").mockImplementationOnce(() => { throw new Error("quota exceeded"); }); h.controller.change("latest"); expect(h.controller.isProtected()).toBe(false); expect(h.controller.getSnapshot().walError).toContain("quota"); expect(h.controller.getSnapshot().text).toBe("latest");
	});
	it("freezes new input and recovery mutations after preparing an account switch, while protection actions remain usable", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("protected departure input");
		const dispose = registerEditorExitGuard({ prepare: () => h.controller.preserveDraft(), needsWarning: () => !h.controller.isProtected() }); const transition = beginEditorAccountTransition();
		try {
			expect(transition).toBeTypeOf("number"); expect(await prepareEditorExit()).toBe(true); const version = h.controller.revision();
			h.controller.change("late input after prepare"); expect(h.controller.getSnapshot().text).toBe("protected departure input"); expect(h.controller.revision()).toBe(version); expect(h.slot().draft?.content).toBe("protected departure input");
			expect(await h.controller.reload()).toBe(false); expect(h.controller.restore("server")).toBe(false); expect(await h.controller.useDiskAfterPreserve()).toBe(false); expect(await h.controller.saveAs("late.txt")).toBe(false);
			expect(await h.controller.preserveDraft()).toBe(true); expect(await h.controller.save()).toBe(true);
		} finally { cancelEditorAccountTransition(transition); dispose(); }
		h.controller.change("typing resumes after a failed switch"); expect(h.controller.getSnapshot().text).toContain("typing resumes");
	});
	it("finds valid WAL candidates even when another writer contains malformed JSON", async () => {
		const h = harness(); const bad = 'owl.editor.wal.["D:/profile","D:/project","a.txt"].broken'; h.storage.setItem(bad, "{not-json"); await h.controller.load(); h.controller.change("valid writer draft");
		const refreshed = new EditorController(h.api, "D:/project", "a.txt", "D:/profile", h.storage); expect(refreshed.getSnapshot().localRecoveries?.map((draft) => draft.content)).toEqual(["valid writer draft"]); expect(refreshed.getSnapshot().walError).toBeTruthy(); expect(h.storage.getItem(bad)).toBe("{not-json");
	});
	it("preserves local edits after a remote draft CAS conflict and does not delete that remote draft", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("mine"); const remote: EditorDraft = { cwd: "D:/project", path: "a.txt", content: "other window", baseContent: "base\n", baseRevision: "base-revision", updatedAt: 1, draftRevision: "other-slot", operationId: "other" }; h.setSlot({ draft: remote, draftRevision: "other-slot" });
		expect(await h.controller.preserveDraft()).toBe(false); expect(h.controller.getSnapshot().text).toBe("mine"); expect(h.controller.getSnapshot().recovery?.content).toBe("other window"); expect(h.controller.isProtected()).toBe(true); expect(h.api.editorDraftRemove).not.toHaveBeenCalled();
	});
	it("discarding a new buffer cannot remove another writer's draft loaded before editing", async () => {
		const h = harness(); const writerB = new EditorController(h.api, "D:/project", "a.txt", "D:/profile", h.storage); await writerB.load(); writerB.change("B's saved draft"); await writerB.preserveDraft(); const original = h.slot();
		await h.controller.load(); expect(h.controller.getSnapshot().recovery?.content).toBe("B's saved draft"); h.controller.change("A's temporary input"); expect(await h.controller.discard()).toBe(true);
		expect(h.api.editorDraftRemove).not.toHaveBeenCalled(); expect(h.slot()).toEqual(original); expect(h.controller.getSnapshot().recovery?.content).toBe("B's saved draft"); expect(writerB.isProtected()).toBe(true);
	});
	it("removes only an explicitly selected unchanged WAL and refuses a writer updated since preview", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("A's recovery"); const writerB = new EditorController(h.api, "D:/project", "a.txt", "D:/profile", h.storage); await writerB.load(); writerB.change("B's recovery");
		const reviewer = new EditorController(h.api, "D:/project", "a.txt", "D:/profile", h.storage); const a = reviewer.getSnapshot().localRecoveries!.find((draft) => draft.content === "A's recovery")!; const b = reviewer.getSnapshot().localRecoveries!.find((draft) => draft.content === "B's recovery")!;
		writerB.change("B's newer input"); expect(reviewer.removeLocalRecovery(b.walKey!)).toBe(false); expect(writerB.isProtected()).toBe(true); expect(reviewer.getSnapshot().walError).toBeTruthy();
		expect(reviewer.removeLocalRecovery(a.walKey!)).toBe(true); expect(h.storage.getItem(a.walKey!)).toBeNull(); expect(h.storage.getItem(b.walKey!)).toContain("B's newer input"); expect(reviewer.getSnapshot().localRecoveries).toHaveLength(1);
		const refreshed = new EditorController(h.api, "D:/project", "a.txt", "D:/profile", h.storage); expect(refreshed.getSnapshot().localRecoveries?.map((draft) => draft.content)).toEqual(["B's newer input"]);
	});
	it("recovers an offline local draft and resumes editing after reconnect reads the matching baseline", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("offline work"); const refreshed = new EditorController(h.api, "D:/project", "a.txt", "D:/profile", h.storage); vi.mocked(h.api.fsRead).mockRejectedValueOnce(new Error("offline")); await refreshed.load();
		expect(refreshed.restore("local")).toBe(true); expect(refreshed.getSnapshot()).toMatchObject({ text: "offline work", editable: false, dirty: true }); expect(await refreshed.save()).toBe(false);
		await refreshed.load(); expect(refreshed.getSnapshot()).toMatchObject({ text: "offline work", editable: true, dirty: true, stale: false }); refreshed.change("continued work"); expect(await refreshed.save()).toBe(true); expect(h.disk().content).toBe("continued work");
	});
	it("ignores late acknowledgements after disposal and always sends the controller's original profile", async () => {
		const h = harness(); await h.controller.load(); h.controller.change("mine"); const response = Promise.withResolvers<EditorSaveResult>(); vi.mocked(h.api.editorFileSave).mockReturnValueOnce(response.promise); const save = h.controller.save(); h.controller.dispose(); response.resolve({ status: "saved", path: "a.txt", size: 4, revision: "old-profile-ack" }); expect(await save).toBe(false); expect(h.controller.getSnapshot().dirty).toBe(true); expect(h.api.editorFileSave).toHaveBeenCalledWith("D:/project", "a.txt", "mine", "base-revision", "D:/profile");
	});
});

describe("real CodeMirror text transactions preserve source bytes", () => {
	it.each(["\uFEFFfirst\r\nsecond\r\n", "\uFEFFfirst\r\nsecond\nthird\rfourth\r\n"])("changes one word without normalizing untouched BOM/EOLs", (raw) => {
		const state = EditorState.create({ doc: editorDisplayText(raw) }); const transaction = state.update({ changes: { from: 0, to: 5, insert: "FIRST" } }); const changes: Array<{ from: number; to: number; insert: string }> = []; transaction.changes.iterChanges((from, to, _fromB, _toB, insert) => changes.push({ from, to, insert: insert.toString() })); expect(applyEditorTextChanges(raw, changes)).toBe(raw.replace("first", "FIRST"));
	});
	it("inserts a CRLF line without changing existing mixed endings", () => { expect(applyEditorTextChanges("a\r\nb\nc\r\n", [{ from: 1, to: 1, insert: "\nnew" }])).toBe("a\r\nnew\r\nb\nc\r\n"); });
});
