import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

type Snapshot = {
	sessionId: string;
	cwd: string;
	messages: Array<{ role: string }>;
	messageEntryIds?: Array<string | undefined>;
	name?: string;
};

/** 真桥上的 session.fork：以目标条目为末梢复制新会话文件并挂载，原文件一字不动。 */
it("session.fork branches at the target entry into a new mounted session and leaves the source untouched", async () => {
	const directory = await mkdtemp(join(tmpdir(), "owl-session-fork-test-"));
	const absolute = resolve(directory);
	if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-session-fork-test-"))
		throw new Error("Unsafe bridge cleanup target");
	const agentDir = join(directory, "profile");
	const cwd = join(directory, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);

	// 手工落一份两轮的最小会话（用户 + assistant 各一条），分支点 = assistant 条目
	const iso = new Date().toISOString();
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	await mkdir(sessionDir, { recursive: true });
	const sourceFile = join(sessionDir, "2026-01-01-00-00-00_session-fork-src.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "session-fork-src", timestamp: iso, cwd },
		{
			type: "message",
			id: "e-user-1",
			parentId: null,
			timestamp: iso,
			message: { role: "user", content: "你好", timestamp: 1 },
		},
		{
			type: "message",
			id: "e-asst-1",
			parentId: "e-user-1",
			timestamp: iso,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "您好！有什么可以帮您？" }],
				api: "openai-completions",
				provider: "fake",
				model: "isolated",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
				stopReason: "turnEnd",
				timestamp: 2,
			},
		},
	];
	await writeFile(sourceFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

	const bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	const sockets: WebSocket[] = [];
	try {
		async function connect() {
			const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, {
				headers: { Origin: `http://127.0.0.1:${bridge.port}` },
			});
			sockets.push(socket);
			await new Promise<void>((done, reject) => {
				socket.once("open", done);
				socket.once("error", reject);
			});
			return socket;
		}
		function request<T>(
			socket: WebSocket,
			payload: DesktopClientRequestWithoutId,
		): Promise<ServerResponseMessage & { result?: T }> {
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

		const first = await connect();

		// 恢复原会话：两条消息、条目 id 对齐（分支按钮靠它定位目标）
		const resumed = await request<Snapshot>(first, { type: "session.resume", sessionId: "session-fork-src" });
		expect(resumed.ok).toBe(true);
		expect(resumed.result?.messages).toHaveLength(2);
		expect(resumed.result?.messageEntryIds).toEqual(["e-user-1", "e-asst-1"]);

		// 以 assistant 条目为末梢分支：新会话 id 不同、历史同构、名字 = fork1 · 来自「源会话全名」
		const forked = await request<Snapshot>(first, {
			type: "session.fork",
			sessionId: "session-fork-src",
			entryId: "e-asst-1",
		});
		expect(forked.ok).toBe(true);
		const forkedId = forked.result?.sessionId;
		expect(forkedId).toBeDefined();
		expect(forkedId).not.toBe("session-fork-src");
		expect(forked.result?.messages).toHaveLength(2);
		expect(forked.result?.messageEntryIds).toEqual(["e-user-1", "e-asst-1"]);
		expect(forked.result?.name).toBe("fork1 · 来自「你好」");

		// 磁盘：恰好多一个会话文件；头部 parentSession 指回原文件、消息按序拷贝；原文件一字未动
		const files = (await readdir(sessionDir)).filter((file) => file.endsWith(".jsonl")).sort();
		expect(files).toHaveLength(2);
		const branchFile = files.find((file) => file !== basename(sourceFile));
		expect(branchFile).toBeDefined();
		const branchLines = (await readFile(join(sessionDir, branchFile!), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(branchLines[0]).toMatchObject({ type: "session", id: forkedId, parentSession: resolve(sourceFile) });
		expect(branchLines[1]).toMatchObject({ type: "message", id: "e-user-1" });
		expect(branchLines[2]).toMatchObject({ type: "message", id: "e-asst-1" });
		// 名字落在 session_info 条目里（持久化，重启后仍在）
		expect(branchLines[3]).toMatchObject({ type: "session_info", name: "fork1 · 来自「你好」" });
		// 原文件：原有条目原样保留；挂载期间的 setup 只允许追加状态条目，绝不能动消息
		const sourceLines = (await readFile(sourceFile, "utf8")).trim().split("\n");
		expect(sourceLines.slice(0, lines.length).map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual(
			lines,
		);
		for (const extra of sourceLines.slice(lines.length)) {
			expect((JSON.parse(extra) as { type?: string }).type).not.toBe("message");
		}

		// 同源再分支一次：像真实使用那样先从侧边栏重新打开源会话（fork 时源运行时已卸载），
		// 再分支 → 序号自然递增（fork2），不会与 fork1 撞号
		const remounted = await request<Snapshot>(first, { type: "session.resume", sessionId: "session-fork-src" });
		expect(remounted.ok).toBe(true);
		const forkedAgain = await request<Snapshot>(first, {
			type: "session.fork",
			sessionId: "session-fork-src",
			entryId: "e-asst-1",
		});
		expect(forkedAgain.ok).toBe(true);
		expect(forkedAgain.result?.name).toBe("fork2 · 来自「你好」");
		expect(forkedAgain.result?.sessionId).not.toBe(forkedId);

		// 分支点不存在 → 明确报错而不是静默
		const missing = await request<{ sessionId?: string }>(first, {
			type: "session.fork",
			sessionId: forkedAgain.result!.sessionId,
			entryId: "e-missing",
		});
		expect(missing.ok).toBe(false);
		expect(missing.error).toContain("分支目标消息不存在");

		// 原会话仍可恢复（分支时旧运行时已卸载，文件未动）；源会话没有自定义名
		const resumedAgain = await request<Snapshot>(first, { type: "session.resume", sessionId: "session-fork-src" });
		expect(resumedAgain.ok).toBe(true);
		expect(resumedAgain.result?.sessionId).toBe("session-fork-src");
		expect(resumedAgain.result?.messages).toHaveLength(2);
		expect(resumedAgain.result?.name).toBeUndefined();
	} finally {
		for (const socket of sockets.splice(0)) socket.close();
		await bridge.close();
		await rm(directory, { recursive: true, force: true });
	}
});
