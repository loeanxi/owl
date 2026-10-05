import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { getDefaultSessionDirPath } from "../src/core/session-manager.ts";
import type { DesktopClientRequestWithoutId, ServerResponseMessage } from "../src/modes/desktop/protocol.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

type BridgeEvent = { sessionId: string; event: { type?: string } };

/**
 * 真桥上的 session.abort：空闲会话立即回包并补发合成 agent_settled（断线窗口
 * 丢过 settled 事件时，前端的运行态靠它解开）；未知会话回 ok:false 而不是挂起。
 */
it("session.abort replies immediately, synthesizes agent_settled for idle sessions, and rejects unknown sessions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "owl-session-abort-test-"));
	const absolute = resolve(directory);
	if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-session-abort-test-"))
		throw new Error("Unsafe bridge cleanup target");
	const agentDir = join(directory, "profile");
	const cwd = join(directory, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);

	const iso = new Date().toISOString();
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	await mkdir(sessionDir, { recursive: true });
	const sourceFile = join(sessionDir, "2026-01-01-00-00-00_session-abort-src.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "session-abort-src", timestamp: iso, cwd },
		{
			type: "message",
			id: "e-user-1",
			parentId: null,
			timestamp: iso,
			message: { role: "user", content: "你好", timestamp: 1 },
		},
	];
	await writeFile(sourceFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

	const bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	const sockets: WebSocket[] = [];
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, {
			headers: { Origin: `http://127.0.0.1:${bridge.port}` },
		});
		sockets.push(socket);
		await new Promise<void>((done, reject) => {
			socket.once("open", done);
			socket.once("error", reject);
		});
		function request<T>(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage & { result?: T }> {
			const id = randomUUID();
			return new Promise((done, reject) => {
				const timer = setTimeout(() => {
					socket.off("message", receive);
					reject(new Error("Fake bridge request timed out"));
				}, 8000);
				const receive = (data: unknown) => {
					const response = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
					if (response.type !== "response" || response.id !== id) return;
					clearTimeout(timer);
					socket.off("message", receive);
					done(response);
				};
				socket.on("message", receive);
				socket.send(JSON.stringify({ ...payload, id }));
			});
		}
		const events: BridgeEvent[] = [];
		let notifyEvents: (() => void) | undefined;
		let eventWaiter: Promise<void> | undefined;
		socket.on("message", (data) => {
			const message = JSON.parse(String(data)) as { type?: string; sessionId?: string; event?: { type?: string } };
			if (message.type !== "event") return;
			events.push({ sessionId: message.sessionId ?? "", event: message.event ?? {} });
			notifyEvents?.();
			notifyEvents = undefined;
			eventWaiter = undefined;
		});
		async function nextEvent(): Promise<BridgeEvent> {
			while (events.length === 0) {
				if (eventWaiter === undefined) {
					eventWaiter = new Promise<void>((done) => {
						notifyEvents = done;
					});
				}
				await eventWaiter;
			}
			return events.shift()!;
		}

		const resumed = await request<{ sessionId: string }>({ type: "session.resume", sessionId: "session-abort-src" });
		expect(resumed.ok).toBe(true);

		// 空闲会话中止：立即回包 + 恰好一条合成 agent_settled（前端运行态靠它解开）
		const aborted = await request({ type: "session.abort", sessionId: "session-abort-src" });
		expect(aborted.ok).toBe(true);
		const settled = await nextEvent();
		expect(settled.sessionId).toBe("session-abort-src");
		expect(settled.event.type).toBe("agent_settled");

		// 未知会话：ok:false 明确报错，而不是让请求挂死
		const unknown = await request({ type: "session.abort", sessionId: "no-such-session" });
		expect(unknown.ok).toBe(false);
		expect(String(unknown.error)).toContain("Unknown session");
	} finally {
		for (const open of sockets) open.terminate();
		await bridge.close();
		await rm(absolute, { recursive: true, force: true });
	}
});
