import { spawn } from "child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createProcessToolDefinition } from "../../src/core/tools/process.ts";
import {
	getSessionProcess,
	HeadTailBuffer,
	listSessionProcesses,
	registerSessionProcess,
	terminateSessionProcesses,
} from "../../src/core/tools/process-store.ts";

const cwd = process.cwd();

describe("HeadTailBuffer", () => {
	it("keeps everything when under the limit", () => {
		const buffer = new HeadTailBuffer();
		buffer.append("hello\n");
		buffer.append("world\n");
		const snapshot = buffer.snapshot();
		expect(snapshot.content).toBe("hello\nworld\n");
		expect(snapshot.omittedBytes).toBe(0);
	});

	it("keeps head and tail with an omission marker when overflowing", () => {
		const buffer = new HeadTailBuffer();
		const chunk = "a".repeat(600 * 1024) + "b".repeat(600 * 1024);
		buffer.append(chunk);
		const snapshot = buffer.snapshot();
		expect(snapshot.omittedBytes).toBeGreaterThan(0);
		expect(snapshot.content).toContain("bytes omitted");
		expect(snapshot.content.startsWith("a")).toBe(true);
		expect(snapshot.content.endsWith("b")).toBe(true);
	});
});

describe("process store", () => {
	afterAll(() => {
		terminateSessionProcesses("test-session");
	});

	it("registers, tracks exit, and cleans up by session", async () => {
		const child = spawn("node", ["-e", "console.log('bye'); process.exit(0)"], { cwd });
		const entry = registerSessionProcess({
			child,
			sessionId: "test-session",
			command: "node -e bye",
			cwd,
			acceptsStdin: true,
		});
		await entry.exitPromise;
		expect(entry.exitCode).toBe(0);
		expect(entry.recent.snapshot().content).toContain("bye");
		terminateSessionProcesses("test-session");
		expect(getSessionProcess(entry.id, "test-session")).toBeUndefined();
	});

	it("terminateSessionProcesses leaves other sessions alone", async () => {
		const a = registerSessionProcess({
			child: spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { cwd }),
			sessionId: "test-session",
			command: "long-a",
			cwd,
			acceptsStdin: true,
		});
		const b = registerSessionProcess({
			child: spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { cwd }),
			sessionId: "other-session",
			command: "long-b",
			cwd,
			acceptsStdin: true,
		});
		terminateSessionProcesses("test-session");
		expect(getSessionProcess(a.id, "test-session")).toBeUndefined();
		expect(getSessionProcess(b.id, "other-session")).toBeDefined();
		expect(b.exitCode).toBeUndefined();
		terminateSessionProcesses("other-session");
	});
});

describe("unified-exec via bash tool", () => {
	const sessionId = "test-bash-tool";

	it("returns full result for fast commands (compat)", async () => {
		const tool = createBashToolDefinition(cwd);
		const result = await tool.execute(
			"call-1",
			{ command: "echo fast-output" },
			undefined,
			undefined,
			// 最小 ctx：只需要 sessionManager.getSessionId()
			{
				sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
			} as never,
		);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ exit_code: 0 });
		terminateSessionProcesses(sessionId);
	});

	it("returns a session_id for slow commands and supports poll/kill", async () => {
		const tool = createBashToolDefinition(cwd);
		const result = await tool.execute(
			"call-2",
			{ command: "echo line-one; sleep 30; echo line-two", yield_time_ms: 800 },
			undefined,
			undefined,
			{ sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined } } as never,
		);
		const structured = result.structuredContent as { session_id?: number; status?: string };
		expect(structured.status).toBe("running");
		expect(typeof structured.session_id).toBe("number");
		const id = structured.session_id!;
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("still running");

		// process.poll 收到已有输出
		const processTool = createProcessToolDefinition();
		const poll = await processTool.execute(
			"call-3",
			{ action: "poll", session_id: id, yield_time_ms: 1000 },
			undefined,
			undefined,
			{} as never,
		);
		expect((poll.content[0] as { text: string }).text).toContain("line-one");

		// kill 终止
		const kill = await processTool.execute(
			"call-4",
			{ action: "kill", session_id: id },
			undefined,
			undefined,
			{} as never,
		);
		expect(kill.content[0]).toMatchObject({ type: "text" });
		// 等待退出事件落地
		const entry = getSessionProcess(id, sessionId);
		if (entry) await entry.exitPromise;
		expect(listSessionProcesses(sessionId).find((e) => e.id === id)?.exitCode === undefined).toBe(false);
		terminateSessionProcesses(sessionId);
	});
});
