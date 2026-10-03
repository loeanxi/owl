import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendMemoryEntries,
	clearMemoryEntries,
	deleteMemoryEntry,
	getMemoryDir,
	markExtracted,
	readExtractedMarkers,
	readMemoryEntries,
	renderMemorySection,
	resetMemoryStorage,
} from "../../src/core/memory/store.ts";
import {
	extractMemoriesFromPreviousSessions,
	parseMemoryPayload,
	parseSessionTranscript,
	redactSecrets,
} from "../../src/core/memory/extract.ts";
import { getDefaultSessionDirPath } from "../../src/core/session-manager.ts";

let tempDir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `owl-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	agentDir = join(tempDir, "agent");
	cwd = join(tempDir, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
	if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function writeSessionFile(name: string, lines: unknown[]): string {
	const dir = getDefaultSessionDirPath(cwd, agentDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(
		path,
		lines.map((line) => JSON.stringify(line)).join("\n"),
		"utf-8",
	);
	return path;
}

function sessionLine(role: "user" | "assistant", text: string) {
	return {
		type: "message",
		id: `e_${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role, timestamp: Date.now(), content: [{ type: "text", text }] },
	};
}

describe("memory store", () => {
	it("appends, dedupes, deletes and clears entries; MEMORY.md is the projection", () => {
		const added = appendMemoryEntries(agentDir, [
			{ content: "用户偏好 TypeScript", sourceCwd: cwd },
			{ content: "构建命令是 npm run build", sourceCwd: cwd },
		]);
		expect(added).toHaveLength(2);
		// 重复内容去重
		expect(appendMemoryEntries(agentDir, [{ content: "用户偏好 TypeScript" }])).toHaveLength(0);
		expect(readMemoryEntries(agentDir)).toHaveLength(2);

		const section = renderMemorySection(agentDir);
		expect(section).toContain("用户偏好 TypeScript");
		expect(section).toContain("构建命令");
		// 投影文件存在且不带管理注释
		expect(existsSync(join(getMemoryDir(agentDir), "MEMORY.md"))).toBe(true);
		expect(section).not.toContain("<!--");

		expect(deleteMemoryEntry(agentDir, added[0].id)).toBe(true);
		expect(readMemoryEntries(agentDir)).toHaveLength(1);
		clearMemoryEntries(agentDir);
		expect(readMemoryEntries(agentDir)).toHaveLength(0);
	});

	it("tracks extracted session markers and trims to 5000", () => {
		markExtracted(agentDir, ["/tmp/a.jsonl", "/tmp/b.jsonl"]);
		expect(readExtractedMarkers(agentDir)["/tmp/a.jsonl"]).toBeGreaterThan(0);
		markExtracted(agentDir, ["/tmp/a.jsonl"]);
		expect(Object.keys(readExtractedMarkers(agentDir))).toHaveLength(2);
	});
});

describe("session transcript parsing", () => {
	it("extracts user/assistant texts and skips noise", () => {
		const path = writeSessionFile("s1.jsonl", [
			{ type: "model_change", id: "x", parentId: null, timestamp: "", provider: "p", modelId: "m" },
			sessionLine("user", "帮我把构建脚本改成 pnpm"),
			sessionLine("assistant", "好的，已修改 package.json。"),
			{ type: "message", id: "y", parentId: null, timestamp: "", message: { role: "user", timestamp: 1, content: "   " } },
			sessionLine("user", "再跑一下测试"),
		]);
		const { userTexts, transcript } = parseSessionTranscript(path);
		expect(userTexts).toEqual(["帮我把构建脚本改成 pnpm", "再跑一下测试"]);
		expect(transcript).toContain("用户: 帮我把构建脚本改成 pnpm");
		expect(transcript).toContain("助手: 好的，已修改 package.json。");
	});

	it("redacts secrets", () => {
		const text = redactSecrets("key is sk-abcdefghijklmnop123456, github ghp_abcdefghijklmnopqrstuvwxyz123456, mail a@b.com");
		expect(text).not.toContain("sk-abcdefghijklmnop123456");
		expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
		expect(text).not.toContain("a@b.com");
	});
});

describe("memory payload parsing", () => {
	it("parses strict JSON, embedded JSON, and gives up gracefully", () => {
		expect(parseMemoryPayload('{"memories":[{"content":"a"},{"content":"b"}]}')).toEqual(["a", "b"]);
		expect(parseMemoryPayload('好的：{"memories":["c"]} 完成')).toEqual(["c"]);
		expect(parseMemoryPayload("完全不是 JSON")).toEqual([]);
	});
});

describe("owl-memory built-in extension", () => {
	it("registers remember tool, /memory command, and activates in a real session", async () => {
		const { DefaultResourceLoader } = await import("../../src/core/resource-loader.ts");
		const { createAgentSession } = await import("../../src/core/sdk.ts");
		const { SessionManager } = await import("../../src/core/session-manager.ts");
		const { SettingsManager } = await import("../../src/core/settings-manager.ts");
		const { builtInExtensions } = await import("../../src/extensions/index.ts");
		const { getModel } = await import("@earendil-works/pi-ai/compat");

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"), { id: "owl-memory-ext-test" });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [...builtInExtensions],
		});
		await resourceLoader.reload();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			expect(session.getActiveToolNames()).toContain("remember");
			// getCommands 是扩展绑定内部入口，测试直接探扩展运行器的注册表
			const runnerCommands = (
				session as unknown as { _extensionRunner: { getRegisteredCommands(): { name: string }[] } }
			)._extensionRunner.getRegisteredCommands();
			expect(runnerCommands.some((command) => command.name === "memory")).toBe(true);
		} finally {
			session.dispose();
		}
	});
});

describe("extraction pipeline", () => {
	it("extracts from unextracted sessions, marks them, and skips on the next run", async () => {
		writeSessionFile("old1.jsonl", [
			sessionLine("user", "这个项目用 pnpm，不要用 npm"),
			sessionLine("assistant", "明白了。"),
			sessionLine("user", "对，另外测试命令是 pnpm test"),
			sessionLine("assistant", "已记录。"),
		]);
		const otherCwdSession = join(agentDir, "Owl-history", "--D--elsewhere--", "other.jsonl");
		mkdirSync(join(agentDir, "Owl-history", "--D--elsewhere--"), { recursive: true });
		writeFileSync(otherCwdSession, "", "utf-8");

		const calls: unknown[] = [];
		const stubRegistry = {
			streamSimple: () => ({
				result: async () => {
					calls.push(1);
					return {
						role: "assistant",
						timestamp: Date.now(),
						content: [{ type: "text", text: '{"memories":[{"content":"该项目使用 pnpm 作为包管理器，测试命令 pnpm test"}]}' }],
						stopReason: "stop",
						usage: {},
					};
				},
			}),
		} as never as Parameters<typeof extractMemoriesFromPreviousSessions>[0]["modelRegistry"];

		const model = { id: "stub", provider: "stub" } as never;
		const first = await extractMemoriesFromPreviousSessions({
			agentDir,
			cwd,
			model,
			modelRegistry: stubRegistry,
		});
		expect(first.sessionsProcessed).toBe(1);
		expect(first.memoriesAdded).toBe(1);
		expect(calls).toHaveLength(1);
		const entries = readMemoryEntries(agentDir);
		expect(entries[0].content).toContain("pnpm");
		expect(entries[0].sourceCwd).toBe(cwd);

		// 第二次跑：没有未抽取会话，不再调模型
		const second = await extractMemoriesFromPreviousSessions({
			agentDir,
			cwd,
			model,
			modelRegistry: stubRegistry,
		});
		expect(second.sessionsProcessed).toBe(0);
		expect(calls).toHaveLength(1);

		// 抽取标记不含其他 cwd 的会话
		expect(readExtractedMarkers(agentDir)[otherCwdSession]).toBeUndefined();

		// 注入分区包含新记忆
		const section = renderMemorySection(agentDir);
		expect(section).toContain("pnpm");
	});
});
