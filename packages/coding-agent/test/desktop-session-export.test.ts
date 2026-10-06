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
