import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as runtimeModule from "../src/core/agent-session-runtime.ts";
import { getDefaultSessionDirPath } from "../src/core/session-manager.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerResponseMessage,
	SessionSearchMessageResult,
	SessionSearchResult,
} from "../src/modes/desktop/protocol.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";
import { DesktopSessionSearch } from "../src/modes/desktop/session-search.ts";

const instant = "2026-10-15T00:00:00.000Z";
let directory: string;
let agentDir: string;
let cwd: string;
let search: DesktopSessionSearch;
const links: string[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "owl-session-search-"));
	agentDir = join(directory, "account-one");
	cwd = join(directory, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	search = new DesktopSessionSearch(agentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const link of links.splice(0)) await unlink(link);
	const target = resolve(directory);
	if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("owl-session-search-")) {
		throw new Error("Unsafe search fixture cleanup target");
	}
	await rm(target, { recursive: true, force: true });
});

function message(id: string, parentId: string | null, role: string, content: unknown): Record<string, unknown> {
	return { type: "message", id, parentId, timestamp: instant, message: { role, content, timestamp: 1 } };
}

function state(id: string, parentId: string | null, extra: Record<string, unknown>): Record<string, unknown> {
	return { id, parentId, timestamp: instant, ...extra };
}

async function fixture(
	id: string,
	entries: Record<string, unknown>[],
	options: { cwd?: string; agentDir?: string; newline?: boolean } = {},
): Promise<string> {
	const project = options.cwd ?? cwd;
	const path = getDefaultSessionDirPath(project, options.agentDir ?? agentDir);
	await mkdir(path, { recursive: true });
	const file = join(path, `2026-10-15_${id}.jsonl`);
	const header = { type: "session", version: 3, id, cwd: project, timestamp: instant };
	await writeFile(
		file,
		[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + (options.newline === false ? "" : "\n"),
	);
	return file;
}

describe("read-only session body search", () => {
	it("finds later rounds and assistant text with stable entry IDs, literal symbols and highlight offsets", async () => {
		await fixture("later-round", [
			message("u1", null, "user", "最初只说整理文件"),
			message("a1", "u1", "assistant", [{ type: "text", text: "开始整理" }]),
			message("u2", "a1", "user", "后来才出现：TypeError: Cannot read properties；检查物料编码"),
			message("a2", "u2", "assistant", [
				{ type: "text", text: "İ 前缀，[a-z]+(x)? C:\\work\\demo.ts；TYPEERROR 已处理" },
			]),
		]);
		const result = await search.search({ query: "typeerror" });
		expect(result.hits.map((hit) => [hit.entryId, hit.role])).toEqual([
			["u2", "user"],
			["a2", "assistant"],
		]);
		expect(result.hits[0]).toMatchObject({
			sessionId: "later-round",
			title: "最初只说整理文件",
			cwd,
			scope: "chat",
			archived: false,
		});
		for (const hit of result.hits) {
			expect(hit.matchRanges.map((range) => hit.excerpt.slice(range.start, range.end).toLowerCase())).toEqual([
				"typeerror",
			]);
		}
		for (const query of ["物料编码", "[a-z]+(x)?", "C:\\work\\demo.ts", "İ"]) {
			const found = await search.search({ query });
			expect(found.hits).toHaveLength(1);
			expect(
				found.hits[0]!.excerpt.slice(found.hits[0]!.matchRanges[0]!.start, found.hits[0]!.matchRanges[0]!.end),
			).toBe(query);
		}
	});

	it("does not search reasoning, tool calls/results, system or hidden custom messages", async () => {
		await fixture("private-content", [
			message("u1", null, "user", "visible"),
			message("a1", "u1", "assistant", [
				{ type: "thinking", thinking: "hidden-marker" },
				{ type: "toolCall", name: "read", arguments: { path: "hidden-marker" } },
			]),
			message("t1", "a1", "toolResult", [{ type: "text", text: "hidden-marker" }]),
			message("s1", "t1", "system", "hidden-marker"),
			state("c1", "s1", {
				type: "custom_message",
				customType: "continue",
				content: "hidden-marker",
				display: false,
			}),
		]);
		expect(await search.search({ query: "hidden-marker" })).toEqual({ hits: [], hasMore: false });
		expect((await search.search({ query: "visible" })).hits[0]?.entryId).toBe("u1");
	});

	it("follows the persisted rewind branch and excludes abandoned messages", async () => {
		await fixture("rewound", [
			message("u1", null, "user", "共同起点"),
			message("old-a", "u1", "assistant", [{ type: "text", text: "废弃分支独有词" }]),
			message("old-u", "old-a", "user", "废弃分支独有词"),
			state("rewind", "u1", { type: "custom", customType: "owl-rewind", data: { target: "u1" } }),
			message("new-u", "rewind", "user", "现在分支独有词"),
		]);
		expect((await search.search({ query: "废弃分支独有词" })).hits).toEqual([]);
		expect((await search.search({ query: "现在分支独有词" })).hits[0]?.entryId).toBe("new-u");
		expect((await search.search({ query: "共同起点" })).hits[0]?.entryId).toBe("u1");
	});

	it("applies active-branch context edits while retaining text from before compaction", async () => {
		await fixture("edited", [
			message("u1", null, "user", "被替换内容"),
			message("a1", "u1", "assistant", [{ type: "text", text: "被移除内容" }]),
			state("edit-u", "a1", { type: "context_edit", targetId: "u1", replacement: { content: "替换后的内容" } }),
			state("edit-a", "edit-u", { type: "context_edit", targetId: "a1", replacement: null }),
		]);
		expect((await search.search({ query: "被替换内容" })).hits).toEqual([]);
		expect((await search.search({ query: "被移除内容" })).hits).toEqual([]);
		expect((await search.search({ query: "替换后的内容" })).hits[0]?.entryId).toBe("u1");
		await fixture("compacted", [
			message("u1", null, "user", "已压缩隐藏正文"),
			message("u2", "u1", "user", "仍然保留正文"),
			state("compact", "u2", {
				type: "compaction",
				summary: "已压缩隐藏正文",
				firstKeptEntryId: "u2",
				tokensBefore: 100,
			}),
		]);
		expect((await search.search({ query: "已压缩隐藏正文" })).hits[0]?.entryId).toBe("u1");
		expect((await search.search({ query: "仍然保留正文" })).hits[0]?.entryId).toBe("u2");
		expect(await search.readMessage({ sessionId: "compacted", entryId: "u1" })).toMatchObject({
			entryId: "u1",
			message: { role: "user", content: "已压缩隐藏正文" },
		});
	});

	it("reads compacted text without hidden assistant content, original images or file writes", async () => {
		const file = await fixture(
			"old-text",
			[
				message("u1", null, "user", [
					{ type: "text", text: "原始用户正文" },
					{ type: "image", mimeType: "image/png", data: "private-binary" },
				]),
				message("a1", "u1", "assistant", [
					{ type: "thinking", thinking: "secret-reasoning" },
					{ type: "text", text: "原始助手正文" },
					{ type: "toolCall", name: "read", arguments: { path: "secret-path" } },
				]),
				message("u2", "a1", "user", "新一轮"),
				state("compact", "u2", { type: "compaction", summary: "摘要", firstKeptEntryId: "u2", tokensBefore: 10 }),
			],
			{ newline: false },
		);
		const before = await readFile(file);
		const hit = (await search.search({ query: "原始助手正文" })).hits[0]!;
		const result = await search.readMessage({ sessionId: hit.sessionId, entryId: hit.entryId });
		expect(result).toEqual({
			entryId: "a1",
			message: { role: "assistant", content: [{ type: "text", text: "原始助手正文" }], timestamp: 1 },
		});
		expect(await search.readMessage({ sessionId: "old-text", entryId: "u1" })).toMatchObject({
			message: { content: [{ type: "text", text: "原始用户正文" }] },
		});
		expect(await readFile(file)).toEqual(before);
		// Mutating a caller's display result must not modify the cached history.
		result.message.content = "modified externally";
		expect((await search.readMessage({ sessionId: "old-text", entryId: "a1" })).message.content).toEqual([
			{ type: "text", text: "原始助手正文" },
		]);
	});

	it("revalidates old hits after rewind, context removal and deletion", async () => {
		const file = await fixture("stale-hit", [
			message("u1", null, "user", "起始消息"),
			message("a1", "u1", "assistant", [{ type: "text", text: "稍后撤回的命中正文" }]),
		]);
		expect((await search.search({ query: "命中正文" })).hits[0]?.entryId).toBe("a1");
		await appendFile(
			file,
			JSON.stringify(state("rewind", "u1", { type: "custom", customType: "owl-rewind" })) + "\n",
		);
		await expect(search.readMessage({ sessionId: "stale-hit", entryId: "a1" })).rejects.toThrow("当前会话分支");
		await appendFile(
			file,
			JSON.stringify(state("remove", "rewind", { type: "context_edit", targetId: "u1", replacement: null })) + "\n",
		);
		await expect(search.readMessage({ sessionId: "stale-hit", entryId: "u1" })).rejects.toThrow("当前会话分支");
		await unlink(file);
		await expect(search.readMessage({ sessionId: "stale-hit", entryId: "u1" })).rejects.toThrow("当前会话分支");
	});

	it("filters archive state afresh and retains old archived sessions despite legacy expiry settings", async () => {
		await fixture("archived-session", [message("u1", null, "user", "历史归档关键字")]);
		await writeFile(
			join(agentDir, "Owl-history", "archive.json"),
			JSON.stringify({
				retentionDays: 1,
				sessions: { "archived-session": { archivedAt: "2020-01-01", path: "outside.jsonl" } },
			}),
		);
		expect((await search.search({ query: "历史归档" })).hits).toEqual([]);
		expect((await search.search({ query: "历史归档", includeArchived: true })).hits[0]?.archived).toBe(true);
		await writeFile(join(agentDir, "Owl-history", "archive.json"), JSON.stringify({ sessions: {} }));
		expect((await search.search({ query: "历史归档" })).hits[0]?.archived).toBe(false);
	});

	it("filters cwd exactly and distinguishes ordinary chats from research", async () => {
		await fixture("chat", [message("u1", null, "user", "共同搜索词")]);
		await fixture("research", [
			state("mode", null, { type: "custom", customType: "owl-research-mode", data: { mode: "research" } }),
			message("r-u", "mode", "user", "共同搜索词"),
		]);
		await fixture("child-project", [message("child-u", null, "user", "共同搜索词")], { cwd: join(cwd, "child") });
		expect((await search.search({ query: "共同搜索词", cwd })).hits).toHaveLength(2);
		expect(
			(await search.search({ query: "共同搜索词", cwd, scope: "research" })).hits.map((hit) => hit.sessionId),
		).toEqual(["research"]);
		expect(
			(await search.search({ query: "共同搜索词", cwd, scope: "chat" })).hits.map((hit) => hit.sessionId),
		).toEqual(["chat"]);
	});

	it("never reads another account or follows a history junction into it", async () => {
		const otherAgentDir = join(directory, "account-two");
		await fixture("public", [message("u1", null, "user", "公开会话")]);
		const privateFile = await fixture("private", [message("secret", null, "user", "另一账号的私有正文")], {
			agentDir: otherAgentDir,
		});
		const link = join(agentDir, "Owl-history", "foreign-project");
		await symlink(dirname(privateFile), link, process.platform === "win32" ? "junction" : "dir");
		links.push(link);
		expect((await search.search({ query: "私有正文", includeArchived: true })).hits).toEqual([]);
		expect((await new DesktopSessionSearch(otherAgentDir).search({ query: "私有正文" })).hits).toHaveLength(1);
		await expect(search.readMessage({ sessionId: "private", entryId: "secret" })).rejects.toThrow("当前会话分支");
		await expect(search.readMessage({ sessionId: privateFile, entryId: "secret" })).rejects.toThrow("当前会话分支");
	});

	it("skips malformed history without modifying files or adding a missing newline", async () => {
		const file = await fixture("no-newline", [message("u1", null, "user", "完整末行仍可搜")], { newline: false });
		const broken = join(dirname(file), "broken.jsonl");
		await writeFile(broken, '{"type":"not-session"}\nnot json\n');
		const before = await readFile(file);
		expect((await search.search({ query: "仍可搜" })).hits[0]?.sessionId).toBe("no-newline");
		expect(await readFile(file)).toEqual(before);
		await fixture("cyclic", [message("u1", "u1", "user", "非法循环正文")]);
		expect((await search.search({ query: "非法循环正文" })).hits).toEqual([]);
	});

	it("refreshes appended/replaced/deleted files and accurately reports the requested limit", async () => {
		const file = await fixture("changing", [message("u1", null, "user", "初始正文")]);
		expect((await search.search({ query: "新增正文" })).hits).toEqual([]);
		await appendFile(file, JSON.stringify(message("u2", "u1", "user", "新增正文")) + "\n");
		expect((await search.search({ query: "新增正文" })).hits[0]?.entryId).toBe("u2");
		await fixture("changing", [message("u3", null, "user", "替换正文")]);
		expect((await search.search({ query: "新增正文" })).hits).toEqual([]);
		expect((await search.search({ query: "替换正文" })).hits[0]?.entryId).toBe("u3");
		await fixture("second", [message("x1", null, "user", "替换正文"), message("x2", "x1", "user", "替换正文")]);
		expect(await search.search({ query: "替换正文", limit: 2 })).toMatchObject({
			hits: expect.arrayContaining([expect.objectContaining({ role: "user" })]),
			hasMore: true,
		});
		expect((await search.search({ query: "替换正文", limit: 2 })).hits).toHaveLength(2);
		expect((await search.search({ query: "替换正文", limit: 3 })).hasMore).toBe(false);
		await unlink(file);
		expect((await search.search({ query: "替换正文" })).hits.every((hit) => hit.sessionId === "second")).toBe(true);
	});

	it("returns a bounded excerpt containing every highlighted literal occurrence", async () => {
		await fixture("long", [message("u1", null, "user", "前".repeat(300) + "目标 目标" + "后".repeat(300))]);
		const hit = (await search.search({ query: "目标" })).hits[0]!;
		expect(hit.excerpt.length).toBeLessThanOrEqual(202);
		expect(hit.excerpt.startsWith("…")).toBe(true);
		expect(hit.excerpt.endsWith("…")).toBe(true);
		expect(hit.matchRanges).toHaveLength(2);
		for (const range of hit.matchRanges) expect(hit.excerpt.slice(range.start, range.end)).toBe("目标");
	});

	it("rejects invalid filters instead of silently widening to all projects", async () => {
		await expect(search.search({ query: "test", cwd: " " })).rejects.toThrow("路径");
		await expect(search.search({ query: "test", limit: 0 })).rejects.toThrow("数量");
		await expect(search.search({ query: "test", limit: 201 })).rejects.toThrow("数量");
		await expect(search.search({ query: "test", scope: "mail" as "chat" })).rejects.toThrow("目录类型");
		expect(await search.search({ query: "  " })).toEqual({ hits: [], hasMore: false });
		await expect(search.readMessage({ sessionId: "", entryId: "x" })).rejects.toThrow("标识");
	});
});

it("routes session.search over the real bridge without mounting or executing a session", async () => {
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	await fixture("bridge-search", [
		message("u1", null, "user", "桥接正文关键字"),
		message("u2", "u1", "user", "当前回合"),
		state("compact", "u2", { type: "compaction", summary: "旧消息摘要", firstKeptEntryId: "u2", tokensBefore: 10 }),
	]);
	const createRuntime = vi.spyOn(runtimeModule, "createAgentSessionRuntime");
	const bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, {
		headers: { Origin: `http://127.0.0.1:${bridge.port}` },
	});
	try {
		await new Promise<void>((done, reject) => {
			socket.once("open", done);
			socket.once("error", reject);
		});
		async function request(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage> {
			const id = randomUUID();
			return new Promise((done, reject) => {
				const timer = setTimeout(() => {
					socket.off("message", receive);
					reject(new Error("Search request timeout"));
				}, 8000);
				function receive(data: unknown) {
					const response = JSON.parse(String(data)) as ServerResponseMessage;
					if (response.type !== "response" || response.id !== id) return;
					clearTimeout(timer);
					socket.off("message", receive);
					done(response);
				}
				socket.on("message", receive);
				socket.send(JSON.stringify({ ...payload, id }));
			});
		}
		const result = await request({ type: "session.search", query: "正文关键字", cwd });
		expect(result.ok).toBe(true);
		expect((result.result as SessionSearchResult).hits[0]?.entryId).toBe("u1");
		const read = await request({ type: "session.searchMessage", sessionId: "bridge-search", entryId: "u1" });
		expect(read.ok).toBe(true);
		expect((read.result as SessionSearchMessageResult).message).toEqual({
			role: "user",
			content: "桥接正文关键字",
			timestamp: 1,
		});
		expect(
			(await request({ type: "session.searchMessage", sessionId: "bridge-search", entryId: "not-current" })).ok,
		).toBe(false);
		expect((await request({ type: "session.search", query: "test", cwd: "" })).ok).toBe(false);
		expect(createRuntime).not.toHaveBeenCalled();
	} finally {
		socket.terminate();
		await bridge.close();
	}
});
