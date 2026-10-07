import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { getDefaultSessionDirPath } from "../src/core/session-manager.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerResponseMessage,
	SessionExportLogResult,
	SessionTurnsResult,
} from "../src/modes/desktop/protocol.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * 真桥上的 session.exportLog：未挂载会话走 findSessionFile 定位原始 JSONL；
 * resume 后走挂载运行时的 getSessionFile。jsonl 必须与源文件逐字节一致，
 * markdown 只排当前分支的可读转录；未知会话回 ok:false。
 */
it("session.exportLog returns raw jsonl and markdown before and after mounting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "owl-session-export-test-"));
	const absolute = resolve(directory);
	if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-session-export-test-"))
		throw new Error("Unsafe bridge cleanup target");
	const agentDir = join(directory, "profile");
	const cwd = join(directory, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	// 导出落盘目录走测试覆盖，不写真实下载文件夹
	const exportDir = join(directory, "downloads");
	await mkdir(exportDir);
	vi.stubEnv("OWL_EXPORT_DIR", exportDir);

	const iso = "2026-01-01T00:00:00.000Z";
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	await mkdir(sessionDir, { recursive: true });
	const sourceFile = join(sessionDir, "2026-01-01-00-00-00_session-export-src.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "session-export-src", timestamp: iso, cwd },
		{ type: "session_info", id: "e-info-1", parentId: null, timestamp: iso, name: "导出测试会话" },
		{
			type: "message",
			id: "e-user-1",
			parentId: "e-info-1",
			timestamp: iso,
			message: { role: "user", content: "列出目录", timestamp: 1 },
		},
		{
			type: "message",
			id: "e-assistant-1",
			parentId: "e-user-1",
			timestamp: iso,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
				provider: "mock",
				modelId: "mock-model",
				stopReason: "toolUse",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "e-tool-1",
			parentId: "e-assistant-1",
			timestamp: iso,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "total 0" }],
				isError: false,
				timestamp: 3,
			},
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

		// 未知会话：ok:false 明确报错
		const unknown = await request({ type: "session.exportLog", sessionId: "no-such-session", format: "jsonl" });
		expect(unknown.ok).toBe(false);

		// 未挂载：jsonl 原样等于源文件全文，文件名带会话显示名
		const raw = await request<SessionExportLogResult>({
			type: "session.exportLog",
			sessionId: "session-export-src",
			format: "jsonl",
		});
		expect(raw.ok).toBe(true);
		expect(raw.result?.content).toBe(await readFile(sourceFile, "utf8"));
		expect(raw.result?.path).toBe(sourceFile);
		expect(raw.result?.filename.startsWith("导出测试会话-")).toBe(true);
		expect(raw.result?.filename.endsWith(".jsonl")).toBe(true);
		expect(raw.result?.savedPath).toBe(join(exportDir, raw.result?.filename ?? ""));
		expect(await readFile(raw.result?.savedPath ?? "", "utf8")).toBe(raw.result?.content);

		// 未挂载：markdown 转录含会话名、用户消息、工具调用与结果、用量汇总
		const md = await request<SessionExportLogResult>({
			type: "session.exportLog",
			sessionId: "session-export-src",
			format: "markdown",
		});
		expect(md.ok).toBe(true);
		expect(md.result?.filename.endsWith(".md")).toBe(true);
		expect(md.result?.savedPath).toBe(join(exportDir, md.result?.filename ?? ""));
		expect(md.result?.content).toContain("# Owl 会话：导出测试会话");
		expect(md.result?.content).toContain("列出目录");
		expect(md.result?.content).toContain("**🔧 工具调用 `bash`**");
		expect(md.result?.content).toContain("**🔧 工具结果 · `bash`**");
		expect(md.result?.content).toContain("## 汇总");

		// 挂载后导出：走运行时 getSessionFile，内容仍是源文件全文；同名防覆盖改存序号副本
		const resumed = await request({ type: "session.resume", sessionId: "session-export-src" });
		expect(resumed.ok).toBe(true);
		const mounted = await request<SessionExportLogResult>({
			type: "session.exportLog",
			sessionId: "session-export-src",
			format: "jsonl",
		});
		expect(mounted.ok).toBe(true);
		expect(mounted.result?.content).toBe(await readFile(sourceFile, "utf8"));
		expect(mounted.result?.savedPath).not.toBe(raw.result?.savedPath);
		expect(mounted.result?.savedPath?.startsWith(join(exportDir, "导出测试会话-"))).toBe(true);
	} finally {
		for (const open of sockets) open.terminate();
		await bridge.close();
		await rm(absolute, { recursive: true, force: true });
	}
});

/**
 * 勾选历史分享（桌面下载菜单第三项）：
 * session.turns 按用户消息把当前分支切成轮次；session.exportLog 带 turnEntryIds
 * 时 markdown 只排所选轮次（会话名从完整分支补齐），空选择明确报错。
 */
it("session.turns lists user-message turns and exportLog honours turnEntryIds", async () => {
	const directory = await mkdtemp(join(tmpdir(), "owl-session-turns-test-"));
	const absolute = resolve(directory);
	if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-session-turns-test-"))
		throw new Error("Unsafe bridge cleanup target");
	const agentDir = join(directory, "profile");
	const cwd = join(directory, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	const exportDir = join(directory, "downloads");
	await mkdir(exportDir);
	vi.stubEnv("OWL_EXPORT_DIR", exportDir);

	const iso = "2026-01-01T00:00:00.000Z";
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	await mkdir(sessionDir, { recursive: true });
	const sourceFile = join(sessionDir, "2026-01-01-00-00-00_session-turns-src.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "session-turns-src", timestamp: iso, cwd },
		{ type: "session_info", id: "t-info-1", parentId: null, timestamp: iso, name: "轮次测试会话" },
		{
			type: "message",
			id: "t-user-1",
			parentId: "t-info-1",
			timestamp: iso,
			message: { role: "user", content: "第一轮提问", timestamp: 1 },
		},
		{
			type: "message",
			id: "t-assistant-1",
			parentId: "t-user-1",
			timestamp: iso,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "第一轮回答" }],
				provider: "mock",
				modelId: "mock-model",
				stopReason: "endTurn",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "t-user-2",
			parentId: "t-assistant-1",
			timestamp: iso,
			message: { role: "user", content: "第二轮提问", timestamp: 3 },
		},
		{
			type: "message",
			id: "t-assistant-2",
			parentId: "t-user-2",
			timestamp: iso,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "第二轮回答" }],
				provider: "mock",
				modelId: "mock-model",
				stopReason: "endTurn",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 4,
			},
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

		// 轮次清单：两条用户消息各成一轮，序条（session_info）不计入任何轮
		const turns = await request<SessionTurnsResult>({ type: "session.turns", sessionId: "session-turns-src" });
		expect(turns.ok).toBe(true);
		expect(turns.result?.turns).toHaveLength(2);
		expect(turns.result?.turns[0]).toMatchObject({ entryId: "t-user-1", text: "第一轮提问", entryCount: 2 });
		expect(turns.result?.turns[1]).toMatchObject({ entryId: "t-user-2", text: "第二轮提问", entryCount: 2 });

		// 只勾第一轮：正文含第一轮问答、不含第二轮；会话名仍从完整分支解析
		const picked = await request<SessionExportLogResult>({
			type: "session.exportLog",
			sessionId: "session-turns-src",
			format: "markdown",
			turnEntryIds: ["t-user-1"],
		});
		expect(picked.ok).toBe(true);
		expect(picked.result?.content).toContain("# Owl 会话：轮次测试会话");
		expect(picked.result?.content).toContain("第一轮提问");
		expect(picked.result?.content).toContain("第一轮回答");
		expect(picked.result?.content).not.toContain("第二轮提问");
		expect(picked.result?.content).not.toContain("第二轮回答");

		// 不带 turnEntryIds：整支导出，两轮都在
		const full = await request<SessionExportLogResult>({
			type: "session.exportLog",
			sessionId: "session-turns-src",
			format: "markdown",
		});
		expect(full.ok).toBe(true);
		expect(full.result?.content).toContain("第一轮提问");
		expect(full.result?.content).toContain("第二轮提问");

		// 空选择是调用方 bug：明确报错而不是导出空壳文件
		const empty = await request({
			type: "session.exportLog",
			sessionId: "session-turns-src",
			format: "markdown",
			turnEntryIds: [],
		});
		expect(empty.ok).toBe(false);
	} finally {
		for (const open of sockets) open.terminate();
		await bridge.close();
		await rm(absolute, { recursive: true, force: true });
	}
});
