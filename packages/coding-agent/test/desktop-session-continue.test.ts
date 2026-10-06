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

type BridgeEvent = {
	sessionId: string;
	event: {
		type?: string;
		entry?: { type?: string; customType?: string; display?: boolean; message?: { role?: string } };
	};
};

/**
 * 真桥上的 session.continue（暂停后续跑）：以隐藏 custom 消息触发新回合——
 * custom_message 条目落盘（display:false）且不新增 user 条目，模型上下文由
 * buildSessionContext 转 user 角色；快照回放里也看不到伪造的「继续」用户消息。
 */
it("session.continue persists a hidden custom_message entry without appending a user message", async () => {
	const directory = await mkdtemp(join(tmpdir(), "owl-session-continue-test-"));
	const absolute = resolve(directory);
	if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-session-continue-test-"))
		throw new Error("Unsafe bridge cleanup target");
	const agentDir = join(directory, "profile");
	const cwd = join(directory, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);

	const iso = new Date().toISOString();
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	await mkdir(sessionDir, { recursive: true });
	const sourceFile = join(sessionDir, "2026-01-01-00-00-00_session-continue-src.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "session-continue-src", timestamp: iso, cwd },
		{
			type: "message",
			id: "e-user-1",
			parentId: null,
			timestamp: iso,
			message: { role: "user", content: "帮我整理这个目录", timestamp: 1 },
		},
		{
			type: "message",
			id: "e-assistant-1",
			parentId: "e-user-1",
			timestamp: iso,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "我先看一下目录结构" }],
				provider: "mock",
				modelId: "mock-model",
				stopReason: "aborted",
				errorMessage: "This operation was aborted",
				timestamp: 2,
			},
		},
		{
			// 让挂载恢复一个不存在的模型：续跑的 LLM 调用快速失败，测试不碰真实网络
			// （否则会话回落到全局默认模型，那台机器上的默认模型可能真的可用）。
			type: "model_change",
			id: "e-model-1",
			parentId: "e-assistant-1",
			timestamp: iso,
			provider: "owl-test-missing",
			modelId: "none",
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
			const message = JSON.parse(String(data)) as {
				type?: string;
				sessionId?: string;
				event?: BridgeEvent["event"];
			};
			if (message.type !== "event") return;
			events.push({ sessionId: message.sessionId ?? "", event: message.event ?? {} });
			notifyEvents?.();
			notifyEvents = undefined;
			eventWaiter = undefined;
		});
		async function nextEvent(predicate: (event: BridgeEvent) => boolean): Promise<BridgeEvent> {
			for (;;) {
				const index = events.findIndex(predicate);
				if (index >= 0) return events.splice(index, 1)[0]!;
				if (eventWaiter === undefined) {
					eventWaiter = new Promise<void>((done) => {
						notifyEvents = done;
					});
				}
				await eventWaiter;
			}
		}

		const resumed = await request<{ sessionId: string }>({
			type: "session.resume",
			sessionId: "session-continue-src",
		});
		expect(resumed.ok).toBe(true);

		// 未知会话：ok:false 明确报错
		const unknown = await request({ type: "session.continue", sessionId: "no-such-session", message: "继续" });
		expect(unknown.ok).toBe(false);
		expect(String(unknown.error)).toContain("Unknown session");

		// 暂停后续跑：回 ok 并触发新回合（agent_start）；custom 消息在任何 LLM 调用
		// 之前落盘（message_end 到达即已持久化），不等 run 收尾（避免重试节奏干扰）。
		const continued = await request({
			type: "session.continue",
			sessionId: "session-continue-src",
			message: "继续完成剩余工作",
		});
		expect(continued.ok).toBe(true);
		const started = await nextEvent(
			(event) => event.sessionId === "session-continue-src" && event.event.type === "agent_start",
		);
		expect(started.event.type).toBe("agent_start");
		const customEnded = await nextEvent(
			(event) =>
				event.sessionId === "session-continue-src" &&
				event.event.type === "message_end" &&
				(event.event as { message?: { role?: string; customType?: string; display?: boolean } }).message?.role ===
					"custom",
		);
		const customMessage = (customEnded.event as { message?: { customType?: string; display?: boolean } }).message;
		expect(customMessage?.customType).toBe("owl.resume");
		expect(customMessage?.display).toBe(false);

		// 快照回放：custom 消息在消息流里可见（buildSessionContext 转 user 给模型），
		// 但 user 消息仍然只有最初的一条——没有伪造的「继续」用户消息。
		const remounted = await request<{ messages: { role: string; customType?: string }[] }>({
			type: "session.resume",
			sessionId: "session-continue-src",
		});
		expect(remounted.ok).toBe(true);
		const messages = remounted.result?.messages ?? [];
		expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
		const customResume = messages.find((message) => message.role === "custom");
		expect(customResume?.customType).toBe("owl.resume");
	} finally {
		for (const open of sockets) open.terminate();
		await bridge.close();
		await rm(absolute, { recursive: true, force: true });
	}
});
