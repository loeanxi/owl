import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { SessionManager } from "../src/core/session-manager.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import { terminateSessionProcesses } from "../src/core/tools/process-store.ts";
import type {
	DesktopClientRequestWithoutId,
	DesktopProcessDetail,
	DesktopProcessSummary,
	ServerResponseMessage,
} from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";
import * as toolsManager from "../src/utils/tools-manager.ts";

let fixture: string;
let bridge: DesktopServerHandle | undefined;
let socket: WebSocket | undefined;
const owners = new Set<string>();

beforeEach(async () => {
	fixture = resolve(await mkdtemp(join(tmpdir(), "owl-process-bridge-")));
	const agentDir = join(fixture, "agent");
	await mkdir(agentDir);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ plugins: [], cacheWarming: { mode: "off" }, owlMemory: { enabled: false } }),
	);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("Network forbidden in execution bridge fixture");
		}),
	);
	vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
	bridge = await startDesktopServer({ port: 0, agentDir, cwd: fixture, mcpServers: {}, onDiagnostic: () => {} });
	socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
	await new Promise<void>((done, reject) => {
		socket!.once("open", done);
		socket!.once("error", reject);
	});
});

afterEach(async () => {
	for (const owner of owners) terminateSessionProcesses(owner);
	owners.clear();
	socket?.terminate();
	socket = undefined;
	await bridge?.close();
	bridge = undefined;
	expect(fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	if (dirname(fixture) !== resolve(tmpdir()) || !basename(fixture).startsWith("owl-process-bridge-"))
		throw new Error("Unsafe process bridge cleanup path");
	await rm(fixture, { recursive: true, force: true });
});

function rpc<T>(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage & { result?: T }> {
	const ws = socket;
	if (!ws) throw new Error("Fixture socket missing");
	const id = randomUUID();
	return new Promise((done, reject) => {
		const receive = (data: unknown): void => {
			const message = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
			if (message.type !== "response" || message.id !== id) return;
			clearTimeout(timer);
			ws.off("message", receive);
			done(message);
		};
		const timer = setTimeout(() => {
			ws.off("message", receive);
			reject(new Error(`RPC timed out: ${payload.type}`));
		}, 10_000);
		ws.on("message", receive);
		ws.send(JSON.stringify({ ...payload, id }));
	});
}

describe("real desktop background process bridge", () => {
	it.skipIf(process.platform !== "win32")(
		"routes PowerShell output and stop to its actual owner without mounting an agent",
		async () => {
			const manager = SessionManager.create(fixture);
			manager.appendMessage({ role: "user", content: "Offline process fixture", timestamp: Date.now() });
			const sessionId = manager.getSessionId();
			owners.add(sessionId);
			const foreign = SessionManager.create(fixture);
			foreign.appendMessage({ role: "user", content: "Foreign process fixture", timestamp: Date.now() });
			const tool = createPowerShellToolDefinition(fixture);
			await tool.execute(
				"fixture-shell",
				{ command: "Write-Output 'bridge output'; Start-Sleep -Seconds 30", yield_time_ms: 1000 },
				undefined,
				undefined,
				{ cwd: fixture, sessionManager: manager } as never,
			);
			const listed = await rpc<DesktopProcessSummary[]>({ type: "process.list", sessionId });
			expect(listed.ok).toBe(true);
			expect(listed.result).toHaveLength(1);
			const processId = listed.result![0].id;
			expect(await rpc<DesktopProcessDetail>({ type: "process.get", sessionId, processId })).toMatchObject({
				ok: true,
				result: { id: processId, output: expect.stringContaining("bridge output"), status: "running" },
			});
			expect(await rpc({ type: "process.kill", sessionId: foreign.getSessionId(), processId })).toMatchObject({
				ok: false,
				error: expect.stringContaining("not found"),
			});
			expect(await rpc({ type: "process.kill", sessionId, processId })).toMatchObject({
				ok: true,
				result: { status: "stopped" },
			});
			expect(await rpc({ type: "process.list", sessionId: "nonexistent-session" })).toMatchObject({
				ok: false,
				error: expect.stringContaining("Unknown session"),
			});
			expect(await rpc<{ running: string[] }>({ type: "session.running" })).toMatchObject({
				ok: true,
				result: { running: [] },
			});
		},
	);
});
