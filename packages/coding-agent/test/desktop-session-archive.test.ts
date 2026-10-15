import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { getDefaultSessionDirPath } from "../src/core/session-manager.ts";
import { archiveMetaPath, readArchiveMeta } from "../src/modes/desktop/archive-meta.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerResponseMessage,
	SessionArchiveConfigResult,
} from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

describe("desktop session archives", () => {
	let root: string;
	let agentDir: string;
	let archivedFile: string;
	let activeFile: string;
	let originalArchived: string;
	let originalActive: string;
	let bridge: DesktopServerHandle | undefined;
	let socket: WebSocket | undefined;
	const archivedAt = "2000-01-01T00:00:00.000Z";
	const archivedId = "legacy-expired-archive";
	const activeId = "archive-actions";
	const noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("External requests forbidden in archive tests");
	});
	const noModel = vi.fn(async () => {
		throw new Error("Model calls forbidden in archive tests");
	});

	beforeEach(async () => {
		root = resolve(await mkdtemp(join(tmpdir(), "owl-session-archive-")));
		if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-session-archive-")) {
			throw new Error("Unsafe archive test cleanup target");
		}
		agentDir = join(root, "profile");
		const cwd = join(root, "workspace");
		await mkdir(agentDir);
		await mkdir(cwd);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ plugins: [], cacheWarming: { mode: "off" } }));
		vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
		vi.stubGlobal("fetch", noFetch);
		noFetch.mockClear();
		noModel.mockClear();
		// Keep real I/O timers for the WebSocket bridge while advancing every service interval.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
		await mkdir(sessionDir, { recursive: true });
		for (const sessionId of [archivedId, activeId]) {
			const path = join(sessionDir, `${sessionId}.jsonl`);
			const text = `${[
				{ type: "session", version: 3, id: sessionId, timestamp: archivedAt, cwd },
				{
					type: "message",
					id: "user-entry",
					parentId: null,
					timestamp: archivedAt,
					message: { role: "user", content: `Keep ${sessionId}`, timestamp: Date.parse(archivedAt) },
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`;
			await writeFile(path, text);
			if (sessionId === archivedId) {
				archivedFile = path;
				originalArchived = text;
			} else {
				activeFile = path;
				originalActive = text;
			}
		}
		// Deliberately retain the obsolete field on disk to exercise existing user profiles.
		await writeFile(
			archiveMetaPath(agentDir),
			JSON.stringify({ retentionDays: 1, sessions: { [archivedId]: { archivedAt, path: archivedFile } } }),
		);
		bridge = await startDesktopServer({
			port: 0,
			agentDir,
			cwd,
			mcpServers: {},
			onDiagnostic: () => {},
			news: { fetch: noFetch, listModels: () => [], callModel: noModel, resolveModel: noModel },
		});
		socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
		const connected = socket;
		await new Promise<void>((done, reject) => {
			connected.once("open", done);
			connected.once("error", reject);
		});
	});

	afterEach(async () => {
		socket?.terminate();
		await bridge?.close();
		socket = undefined;
		bridge = undefined;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	function request<T>(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage & { result?: T }> {
		const connected = socket;
		if (!connected) throw new Error("Archive bridge is not connected");
		const id = randomUUID();
		return new Promise((done, reject) => {
			const timer = setTimeout(() => {
				connected.off("message", receive);
				reject(new Error("Archive bridge request timed out"));
			}, 5000);
			const receive = (data: unknown) => {
				const response = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
				if (response.type !== "response" || response.id !== id) return;
				clearTimeout(timer);
				connected.off("message", receive);
				done(response);
			};
			connected.on("message", receive);
			connected.send(JSON.stringify({ ...payload, id }));
		});
	}

	it("keeps expired legacy archives at startup, after former purge intervals, and after legacy retention requests", async () => {
		const expected = { sessions: [{ sessionId: archivedId, archivedAt }] };
		const initial = await request<SessionArchiveConfigResult>({ type: "session.archiveConfig" });
		expect(initial).toMatchObject({ ok: true, result: expected });
		expect(initial.result).not.toHaveProperty("retentionDays");
		expect(await readFile(archivedFile, "utf8")).toBe(originalArchived);
		await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
		expect(await readFile(archivedFile, "utf8")).toBe(originalArchived);
		// Simulate an old UI sending its obsolete setting over the wire.
		const legacyRequest = { type: "session.archiveConfig" as const, retentionDays: 1 };
		expect(await request(legacyRequest)).toMatchObject({ ok: true, result: expected });
		expect(await readFile(archivedFile, "utf8")).toBe(originalArchived);
		expect(readArchiveMeta(agentDir).sessions?.[archivedId]).toMatchObject({ archivedAt, path: archivedFile });
		expect(noFetch).not.toHaveBeenCalled();
		expect(noModel).not.toHaveBeenCalled();
	});

	it("archives and restores without changing history, then deletes only on an explicit request", async () => {
		expect(await request({ type: "session.archive", sessionId: activeId })).toMatchObject({ ok: true });
		expect(await readFile(activeFile, "utf8")).toBe(originalActive);
		const archived = await request<Array<{ id: string; archivedAt?: string }>>({ type: "session.list" });
		expect(archived.result?.find((row) => row.id === activeId)?.archivedAt).toBeTypeOf("string");
		const metadata = JSON.parse(await readFile(archiveMetaPath(agentDir), "utf8"));
		expect(metadata).not.toHaveProperty("retentionDays");
		expect(await request({ type: "session.unarchive", sessionId: activeId })).toMatchObject({ ok: true });
		const restored = await request<Array<{ id: string; archivedAt?: string }>>({ type: "session.list" });
		expect(restored.result?.find((row) => row.id === activeId)).not.toHaveProperty("archivedAt");
		expect(await readFile(activeFile, "utf8")).toBe(originalActive);
		expect(await request({ type: "session.archive", sessionId: activeId })).toMatchObject({ ok: true });
		expect(await request({ type: "session.delete", sessionId: activeId })).toMatchObject({ ok: true });
		expect(existsSync(activeFile)).toBe(false);
		expect(readArchiveMeta(agentDir).sessions).not.toHaveProperty(activeId);
		expect(await request<SessionArchiveConfigResult>({ type: "session.archiveConfig" })).toMatchObject({
			ok: true,
			result: { sessions: [{ sessionId: archivedId, archivedAt }] },
		});
		expect(await readFile(archivedFile, "utf8")).toBe(originalArchived);
		expect(noFetch).not.toHaveBeenCalled();
		expect(noModel).not.toHaveBeenCalled();
	});
});
