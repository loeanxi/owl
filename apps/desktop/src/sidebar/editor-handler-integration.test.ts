import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
	type FsRequest,
	handleFsRequest,
	type WorkspaceHandlerContext,
} from "../../../../packages/coding-agent/src/modes/desktop/handlers/workspace.ts";
import { BridgeClient } from "../bridge/client.ts";
import type { DesktopClientRequestWithoutId } from "../bridge/protocol.ts";
import { createSidebarApi } from "./api.ts";
import { EditorController } from "./editor-controller.ts";
import { applyEditorTextChanges } from "./editor-text.ts";

let root: string;
let cwd: string;
let profile: string;
let currentProfile: string;
let file: string;
let calls: DesktopClientRequestWithoutId[];
let client: BridgeClient;
let afterFileSave: (() => Promise<void>) | undefined;
let noProvider: ReturnType<typeof vi.fn>;

beforeEach(() => {
	root = resolve(mkdtempSync(join(tmpdir(), "owl-editor-controller-integration-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-editor-controller-integration-"))
		throw new Error("Unsafe fixture cleanup");
	cwd = join(root, "workspace");
	profile = join(root, "profile");
	currentProfile = profile;
	mkdirSync(cwd);
	mkdirSync(profile);
	file = join(cwd, "a.txt");
	writeFileSync(file, "\uFEFFfirst\r\nsecond\r\n");
	calls = [];
	afterFileSave = undefined;
	noProvider = vi.fn(() => {
		throw new Error("Provider calls forbidden in editor integration");
	});
	vi.stubGlobal("fetch", noProvider);
	client = new BridgeClient("ws://127.0.0.1/editor-test-no-connect");
	const ws = {} as WebSocket;
	vi.spyOn(client, "request").mockImplementation(async (payload) => {
		calls.push(payload);
		let response: { ok: boolean; result?: unknown; error?: string } | undefined;
		const context: WorkspaceHandlerContext = {
			defaultAgentDir: () => currentProfile,
			reply: (_socket, _id, result) => {
				response = result;
			},
			onDiagnostic: () => {},
			broadcast: () => {},
			sidebarWatchers: new Map(),
			viewerRequests: new WeakMap(),
		};
		try {
			await handleFsRequest(ws, { ...payload, id: randomUUID() } as FsRequest, context);
		} catch (error) {
			response = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (payload.type === "editor.file.save" && response?.ok && afterFileSave) await afterFileSave();
		if (!response) throw new Error("Handler did not acknowledge request");
		return response;
	});
});
afterEach(() => {
	expect(noProvider).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-editor-controller-integration-"))
		throw new Error("Unsafe fixture cleanup");
	rmSync(root, { recursive: true, force: true });
});

describe("editor controller through real sidebar API and workspace handlers", () => {
	it("preserves original BOM/CRLF, acknowledges durable drafts, rejects disk conflicts and rescues a new file", async () => {
		const api = createSidebarApi(client);
		const editor = new EditorController(api, cwd, "a.txt", profile);
		await editor.load();
		const raw = readFileSync(file, "utf8");
		expect(await editor.save()).toBe(true);
		expect(calls.filter((call) => call.type === "editor.file.save")).toHaveLength(0);
		editor.change(applyEditorTextChanges(raw, [{ from: 0, to: 5, insert: "FIRST" }]));
		expect(await editor.preserveDraft()).toBe(true);
		const recovered = await api.editorDraftGet(cwd, "a.txt", profile);
		expect(recovered.draft).toMatchObject({
			content: raw.replace("first", "FIRST"),
			baseContent: raw,
			baseRevision: editor.getSnapshot().baseRevision,
		});
		expect(await editor.save()).toBe(true);
		expect(readFileSync(file, "utf8")).toBe(raw.replace("first", "FIRST"));
		expect((await api.editorDraftGet(cwd, "a.txt", profile)).draft).toBeNull();
		editor.change("my pending work\r\n");
		writeFileSync(file, "manual external edit\r\n");
		expect(await editor.save()).toBe(false);
		expect(editor.getSnapshot().conflict?.content).toBe("manual external edit\r\n");
		expect(editor.getSnapshot().text).toBe("my pending work\r\n");
		expect(await editor.saveAs("rescue.txt")).toBe(true);
		expect(readFileSync(join(cwd, "rescue.txt"), "utf8")).toBe("my pending work\r\n");
		expect(readFileSync(file, "utf8")).toBe("manual external edit\r\n");
		expect(calls.some((call) => call.type === "fs.write")).toBe(false);
		expect(
			calls
				.filter((call) => call.type.startsWith("editor."))
				.every((call) => "expectedProfile" in call && call.expectedProfile === profile),
		).toBe(true);
	});
	it("rebases B's already acknowledged draft after A's disk save acknowledgement arrives late", async () => {
		const api = createSidebarApi(client);
		const editor = new EditorController(api, cwd, "a.txt", profile);
		await editor.load();
		editor.change("A on disk\r\n");
		const savedOnDisk = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		afterFileSave = async () => {
			savedOnDisk.resolve();
			await release.promise;
		};
		const saving = editor.save();
		await savedOnDisk.promise;
		editor.change("B still editing\r\n");
		expect(await editor.preserveDraft()).toBe(true);
		const oldDraft = await api.editorDraftGet(cwd, "a.txt", profile);
		expect(oldDraft.draft?.baseContent).toContain("first");
		release.resolve();
		expect(await saving).toBe(false);
		const latest = await api.editorDraftGet(cwd, "a.txt", profile);
		expect(latest.draft).toMatchObject({
			content: "B still editing\r\n",
			baseContent: "A on disk\r\n",
			baseRevision: editor.getSnapshot().baseRevision,
		});
		expect(readFileSync(file, "utf8")).toBe("A on disk\r\n");
		const refreshed = new EditorController(api, cwd, "a.txt", profile);
		await refreshed.load();
		expect(refreshed.restore("server")).toBe(true);
		expect(refreshed.getSnapshot()).toMatchObject({ text: "B still editing\r\n", stale: false, dirty: true });
	});
	it("does not delete a known other-writer draft on discard and rejects old-account late requests", async () => {
		const api = createSidebarApi(client);
		const writerB = new EditorController(api, cwd, "a.txt", profile);
		await writerB.load();
		writerB.change("B kept draft");
		expect(await writerB.preserveDraft()).toBe(true);
		const writerA = new EditorController(api, cwd, "a.txt", profile);
		await writerA.load();
		writerA.change("A discarded input");
		expect(await writerA.discard()).toBe(true);
		expect((await api.editorDraftGet(cwd, "a.txt", profile)).draft?.content).toBe("B kept draft");
		expect(calls.filter((call) => call.type === "editor.draft.remove")).toHaveLength(0);
		writerA.change("old account work");
		currentProfile = join(root, "other-profile");
		mkdirSync(currentProfile);
		expect(await writerA.save()).toBe(false);
		expect(writerA.getSnapshot().error).toContain("账号已变化");
		expect(readFileSync(file, "utf8")).toContain("first");
		expect((await api.editorDraftList(currentProfile, cwd)).drafts).toEqual([]);
	});
});
