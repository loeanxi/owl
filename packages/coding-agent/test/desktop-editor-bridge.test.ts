import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import type {
	DesktopClientRequestWithoutId,
	EditorDraftGetResult,
	EditorDraftListResult,
	EditorDraftPutResult,
	EditorDraftRemoveResult,
	FsReadResult,
	FsWriteResult,
} from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

let root: string;
let cwd: string;
let profile: string;
let otherProfile: string;
let file: string;
let bridge: DesktopServerHandle;
let socket: WebSocket;
let noFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
	root = resolve(await mkdtemp(join(tmpdir(), "owl-editor-bridge-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-editor-bridge-"))
		throw new Error("Unsafe cleanup");
	cwd = join(root, "workspace");
	profile = join(root, "profile");
	otherProfile = join(root, "other-profile");
	await Promise.all([mkdir(cwd), mkdir(profile), mkdir(otherProfile)]);
	file = join(cwd, "file.txt");
	await writeFile(file, "原始正文\r\n");
	await writeFile(
		join(profile, "settings.json"),
		JSON.stringify({ plugins: [], owlMemory: { enabled: false }, cacheWarming: "off" }),
	);
	vi.stubEnv("OWL_CODING_AGENT_DIR", profile);
	noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("Provider requests forbidden in editor bridge test");
	});
	vi.stubGlobal("fetch", noFetch);
	bridge = await startDesktopServer({ port: 0, cwd, mcpServers: {}, onDiagnostic: () => {} });
	socket = await connect(bridge.port);
});
afterEach(async () => {
	socket?.terminate();
	await bridge?.close();
	expect(noFetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

async function connect(port: number): Promise<WebSocket> {
	const opened = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	await new Promise<void>((done, reject) => {
		opened.once("open", done);
		opened.once("error", reject);
	});
	return opened;
}

function rpc<T = unknown>(payload: DesktopClientRequestWithoutId | Record<string, unknown>) {
	const id = randomUUID();
	return new Promise<{ ok: boolean; error?: string; result?: T }>((done, reject) => {
		const receive = (data: unknown) => {
			const message = JSON.parse(String(data)) as {
				type: string;
				id: string;
				ok: boolean;
				error?: string;
				result?: T;
			};
			if (message.type !== "response" || message.id !== id) return;
			clearTimeout(timer);
			socket.off("message", receive);
			done(message);
		};
		const timer = setTimeout(() => {
			socket.off("message", receive);
			reject(new Error(`RPC timeout ${payload.type}`));
		}, 8000);
		socket.on("message", receive);
		socket.send(JSON.stringify({ ...payload, id }));
	});
}

async function initialRead(): Promise<FsReadResult> {
	const read = await rpc<FsReadResult>({ type: "fs.read", cwd, path: "file.txt" });
	expect(read.ok).toBe(true);
	return read.result!;
}

describe("real bridge editor CAS and durable drafts", () => {
	it("refuses an old file revision and unsafe unversioned editor writes", async () => {
		const read = await initialRead();
		await writeFile(file, "user changed outside Owl");
		const old = await rpc<FsWriteResult>({
			type: "editor.file.save",
			expectedProfile: profile,
			cwd,
			path: "file.txt",
			content: "old buffer",
			expectedRevision: read.revision,
		});
		expect(old).toMatchObject({
			ok: true,
			result: { status: "conflict", current: { content: "user changed outside Owl" } },
		});
		const unversioned = await rpc({
			type: "editor.file.save",
			expectedProfile: profile,
			cwd,
			path: "file.txt",
			content: "old buffer",
		});
		expect(unversioned.ok).toBe(false);
		expect(unversioned.error).toContain("版本");
		expect(await readFile(file, "utf8")).toBe("user changed outside Owl");
	});

	it("returns a new saved revision usable for a second exact save, while null never overwrites", async () => {
		const read = await initialRead();
		const saved = await rpc<FsWriteResult>({
			type: "editor.file.save",
			expectedProfile: profile,
			cwd,
			path: "file.txt",
			content: "first edit",
			expectedRevision: read.revision,
		});
		if (saved.result?.status !== "saved") throw new Error("Save conflict");
		expect(saved.result.revision).not.toBe(read.revision);
		expect(
			(
				await rpc<FsWriteResult>({
					type: "editor.file.save",
					expectedProfile: profile,
					cwd,
					path: "file.txt",
					content: "second edit",
					expectedRevision: saved.result.revision,
				})
			).result?.status,
		).toBe("saved");
		expect(
			(
				await rpc<FsWriteResult>({
					type: "editor.file.save",
					expectedProfile: profile,
					cwd,
					path: "file.txt",
					content: "create-only",
					expectedRevision: null,
				})
			).result?.status,
		).toBe("conflict");
		expect(await readFile(file, "utf8")).toBe("second edit");
	});

	it("persists full draft baselines across reconnect/restart and protects a second window from stale cleanup", async () => {
		const base = await initialRead();
		const put = {
			type: "editor.draft.put" as const,
			expectedProfile: profile,
			cwd,
			path: "file.txt",
			content: "first window draft",
			baseRevision: base.revision,
			baseContent: base.content,
			expectedDraftRevision: null,
			operationId: randomUUID(),
			editorId: "window-one",
		};
		const first = await rpc<EditorDraftPutResult>(put);
		if (first.result?.status !== "saved") throw new Error("Draft conflict");
		expect((await rpc<EditorDraftPutResult>(put)).result).toEqual(first.result);
		const second = await rpc<EditorDraftPutResult>({
			...put,
			content: "newer other-window draft",
			editorId: "window-two",
			expectedDraftRevision: first.result.draftRevision,
			operationId: randomUUID(),
		});
		if (second.result?.status !== "saved") throw new Error("Draft conflict");
		const cleanup = await rpc<EditorDraftRemoveResult>({
			type: "editor.draft.remove",
			expectedProfile: profile,
			cwd,
			path: "file.txt",
			expectedDraftRevision: first.result.draftRevision,
		});
		expect(cleanup.result).toMatchObject({ status: "conflict", draft: { content: "newer other-window draft" } });
		socket.terminate();
		await bridge.close();
		bridge = await startDesktopServer({ port: 0, cwd, mcpServers: {}, onDiagnostic: () => {} });
		socket = await connect(bridge.port);
		const restored = await rpc<EditorDraftGetResult>({
			type: "editor.draft.get",
			expectedProfile: profile,
			cwd,
			path: "file.txt",
		});
		expect(restored.result?.draft).toMatchObject({
			content: "newer other-window draft",
			baseContent: base.content,
			baseRevision: base.revision,
			editorId: "window-two",
		});
		const list = await rpc<EditorDraftListResult>({ type: "editor.draft.list", expectedProfile: profile, cwd });
		expect(list.result?.drafts).toHaveLength(1);
		expect(JSON.stringify(list.result)).not.toContain("newer other-window draft");
		expect(await readFile(file, "utf8")).toBe(base.content);
	});

	it("refuses wrong-profile reads and drafts without creating anything in the newly selected account", async () => {
		const base = await initialRead();
		vi.stubEnv("OWL_CODING_AGENT_DIR", otherProfile);
		for (const payload of [
			{ type: "editor.draft.list", expectedProfile: profile, cwd },
			{ type: "editor.draft.get", expectedProfile: profile, cwd, path: "file.txt" },
			{
				type: "editor.draft.put",
				expectedProfile: profile,
				cwd,
				path: "file.txt",
				content: "old-account draft",
				baseRevision: base.revision,
				baseContent: base.content,
				expectedDraftRevision: null,
				operationId: randomUUID(),
			},
			{
				type: "editor.file.save",
				expectedProfile: profile,
				cwd,
				path: "file.txt",
				content: "old-account disk write",
				expectedRevision: base.revision,
			},
		]) {
			const response = await rpc(payload);
			expect(response.ok).toBe(false);
			expect(response.error).toContain("账号已变化");
		}
		expect(
			(await rpc<EditorDraftListResult>({ type: "editor.draft.list", expectedProfile: otherProfile, cwd })).result
				?.drafts,
		).toEqual([]);
		expect(await readFile(file, "utf8")).toBe(base.content);
	});

	it("rechecks the active account when an old request was queued behind an Agent file operation", async () => {
		const base = await initialRead();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocking = withFileMutationQueue(file, async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const saving = rpc({
			type: "editor.file.save",
			expectedProfile: profile,
			cwd,
			path: "file.txt",
			content: "late old-account write",
			expectedRevision: base.revision,
		});
		await rpc({ type: "ping" });
		vi.stubEnv("OWL_CODING_AGENT_DIR", otherProfile);
		release.resolve();
		await blocking;
		const response = await saving;
		expect(response.ok).toBe(false);
		expect(response.error).toContain("账号已变化");
		expect(await readFile(file, "utf8")).toBe(base.content);
	});
});
