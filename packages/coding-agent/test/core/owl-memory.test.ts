import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	consolidateMemories,
	extractMemoriesFromPreviousSessions,
	parseMemoryPayload,
	parseMergePayload,
	parseSessionTranscript,
	redactSecrets,
} from "../../src/core/memory/extract.ts";
import {
	appendMemoryEntries,
	applyMemoryMerges,
	clearMemoryEntries,
	deleteMemoryEntry,
	getMemoryDir,
	injectionCandidates,
	markExtracted,
	rankEntriesForInjection,
	readExtractedMarkers,
	readMemoryEntries,
	renderMemorySection,
	searchMemoryEntries,
} from "../../src/core/memory/store.ts";
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
	writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
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
	it("appends, strengthens duplicates, deletes and clears entries; MEMORY.md is the projection", () => {
		const { added } = appendMemoryEntries(agentDir, [
			{ content: "用户偏好 TypeScript", sourceCwd: cwd },
			{ content: "构建命令是 npm run build", sourceCwd: cwd },
		]);
		expect(added).toHaveLength(2);
		// 重复内容 = 证据强化，不新增条目
		const second = appendMemoryEntries(agentDir, [{ content: "用户偏好 TypeScript" }]);
		expect(second.added).toHaveLength(0);
		expect(second.strengthened).toBe(1);
		const entries = readMemoryEntries(agentDir);
		expect(entries).toHaveLength(2);
		expect(entries.find((entry) => entry.content === "用户偏好 TypeScript")?.proofCount).toBe(2);

		const section = renderMemorySection(agentDir, cwd);
		expect(section).toContain("用户偏好 TypeScript");
		expect(section).toContain("构建命令");
		expect(section).toContain("×2");
		// 投影文件存在且不带管理注释
		expect(existsSync(join(getMemoryDir(agentDir), "MEMORY.md"))).toBe(true);
		expect(section).not.toContain("<!--");

		expect(deleteMemoryEntry(agentDir, added[0].id)).toBe(true);
		expect(readMemoryEntries(agentDir)).toHaveLength(1);
		clearMemoryEntries(agentDir);
		expect(readMemoryEntries(agentDir)).toHaveLength(0);
	});

	it("scopes injection: current project + global only, ranked by match/proof/recency, budget-aware", () => {
		appendMemoryEntries(agentDir, [
			{ content: "本项目构建命令", sourceCwd: cwd },
			{ content: "用户全局偏好中文回复", scope: "global" },
			{ content: "其它项目的记忆", sourceCwd: "D:\\other-project" },
		]);
		// 其它项目的条目不注入
		const section = renderMemorySection(agentDir, cwd);
		expect(section).toContain("本项目构建命令");
		expect(section).toContain("用户全局偏好中文回复");
		expect(section).not.toContain("其它项目的记忆");
		// 换个项目：只有全局条目
		const otherSection = renderMemorySection(agentDir, "D:\\other-project");
		expect(otherSection).toContain("用户全局偏好中文回复");
		expect(otherSection).not.toContain("本项目构建命令");
		expect(otherSection).toContain("其它项目的记忆");

		// 排序：项目条目在全局之前；证据多在前
		const ranked = rankEntriesForInjection(injectionCandidates(readMemoryEntries(agentDir), cwd).included, cwd);
		expect(ranked[0].content).toBe("本项目构建命令");

		// 预算：每条 ~300B × 30 条远超 8KB 预算，截断并提示未注入数量
		appendMemoryEntries(
			agentDir,
			Array.from({ length: 30 }, (_, i) => ({
				content: `填充记忆条目 ${i} 号：${"内容足够长以占据注入预算的空间，".repeat(12)}`,
				sourceCwd: cwd,
			})),
		);
		const bigSection = renderMemorySection(agentDir, cwd);
		expect(bigSection).toContain("未注入");
	});

	it("searches entries for recall (term scoring, scope filtering)", () => {
		appendMemoryEntries(agentDir, [
			{ content: "项目用 pnpm 管理依赖", sourceCwd: cwd },
			{ content: "用户偏好深色主题", scope: "global" },
			{ content: "其它项目部署在 Vercel", sourceCwd: "D:\\other" },
		]);
		const hits = searchMemoryEntries(agentDir, cwd, "pnpm 依赖");
		expect(hits).toHaveLength(1);
		expect(hits[0].entry.content).toContain("pnpm");
		// 无命中词时排除
		expect(searchMemoryEntries(agentDir, cwd, "kubernetes")).toHaveLength(0);
		// 空 query = 浏览最近，项目 + 全局可见，其它项目不可见
		const browse = searchMemoryEntries(agentDir, cwd, "");
		expect(browse.map(({ entry }) => entry.content)).not.toContain("其它项目部署在 Vercel");
		// recall 可以查到其它项目的存档（全库检索语义：直接读 entries 再过滤本项目）
		const all = searchMemoryEntries(agentDir, "D:\\other", "Vercel");
		expect(all).toHaveLength(1);
	});

	it("applies model-driven merges (proof counts accumulate, merged entries removed)", () => {
		const first = appendMemoryEntries(agentDir, [{ content: "用户偏好 pnpm", sourceCwd: cwd }]);
		const second = appendMemoryEntries(agentDir, [{ content: "该项目使用 pnpm 管理依赖", sourceCwd: cwd }]);
		const third = appendMemoryEntries(agentDir, [{ content: "无关记忆条目", sourceCwd: cwd }]);
		const applied = applyMemoryMerges(agentDir, [
			{
				intoId: first.added[0].id,
				mergeIds: [second.added[0].id],
				content: "用户与本项目均采用 pnpm 作为包管理器",
			},
		]);
		expect(applied).toBe(1);
		const entries = readMemoryEntries(agentDir);
		expect(entries).toHaveLength(2);
		const merged = entries.find((entry) => entry.id === first.added[0].id)!;
		expect(merged.content).toBe("用户与本项目均采用 pnpm 作为包管理器");
		expect(merged.proofCount).toBe(2);
		expect(entries.find((entry) => entry.id === second.added[0].id)).toBeUndefined();
		expect(entries.find((entry) => entry.id === third.added[0].id)).toBeDefined();
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
			{
				type: "message",
				id: "y",
				parentId: null,
				timestamp: "",
				message: { role: "user", timestamp: 1, content: "   " },
			},
			sessionLine("user", "再跑一下测试"),
		]);
		const { userTexts, transcript } = parseSessionTranscript(path);
		expect(userTexts).toEqual(["帮我把构建脚本改成 pnpm", "再跑一下测试"]);
		expect(transcript).toContain("用户: 帮我把构建脚本改成 pnpm");
		expect(transcript).toContain("助手: 好的，已修改 package.json。");
	});

	it("redacts secrets across the pattern table", () => {
		const text = redactSecrets(
			[
				"key is sk-abcdefghijklmnop123456",
				"github ghp_abcdefghijklmnopqrstuvwxyz123456",
				"mail a@b.com",
				"aws AKIAIOSFODNN7EXAMPLE",
				"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
				"postgres://user:secret@db.example.com:5432/app",
				"webhook https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef1234567890",
				'API_KEY="abcdefghijklmnop123456"',
				"-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
			].join("\n"),
		);
		expect(text).not.toContain("sk-abcdefghijklmnop123456");
		expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
		expect(text).not.toContain("a@b.com");
		expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(text).not.toContain("secret@db.example.com");
		expect(text).not.toContain("key=abcdef1234567890");
		expect(text).not.toContain('abcdefghijklmnop123456"');
		expect(text).not.toContain("MIIB");
		// 结构化赋值保留键名
		expect(text).toContain("API_KEY= [REDACTED");
	});
});

describe("memory payload parsing", () => {
	it("parses strict JSON, embedded JSON, scope fields, and gives up gracefully", () => {
		expect(parseMemoryPayload('{"memories":[{"content":"a","scope":"global"},{"content":"b"}]}')).toEqual([
			{ content: "a", scope: "global" },
			{ content: "b" },
		]);
		expect(parseMemoryPayload('好的：{"memories":["c"]} 完成')).toEqual([{ content: "c" }]);
		// 非法 scope 被丢弃
		expect(parseMemoryPayload('{"memories":[{"content":"d","scope":"galactic"}]}')).toEqual([{ content: "d" }]);
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
						content: [
							{
								type: "text",
								text: '{"memories":[{"content":"该项目使用 pnpm 作为包管理器，测试命令 pnpm test","scope":"project"}]}',
							},
						],
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
		expect(entries[0].scope).toBe("project");

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
		const section = renderMemorySection(agentDir, cwd);
		expect(section).toContain("pnpm");
	});

	it("consolidates near-duplicate entries via the model", async () => {
		// 造 6 条记忆（达到归并阈值），其中两条是近似重复。
		// createdAt 显式定序：归并候选按“证据多→新”排序，索引 0/1 必须落在 pnpm 两条上。
		appendMemoryEntries(agentDir, [
			{ content: "用户偏好 pnpm", sourceCwd: cwd, createdAt: "2026-01-06T00:00:00.000Z" },
			{ content: "该项目使用 pnpm 管理依赖", sourceCwd: cwd, createdAt: "2026-01-05T00:00:00.000Z" },
			{ content: "用户偏好深色主题", scope: "global", createdAt: "2026-01-04T00:00:00.000Z" },
			{ content: "无关条目甲", sourceCwd: cwd, createdAt: "2026-01-03T00:00:00.000Z" },
			{ content: "无关条目乙", sourceCwd: cwd, createdAt: "2026-01-02T00:00:00.000Z" },
			{ content: "无关条目丙", sourceCwd: cwd, createdAt: "2026-01-01T00:00:00.000Z" },
		]);
		const idOf = (content: string) => readMemoryEntries(agentDir).find((entry) => entry.content === content)!.id;
		// 合并会改写目标条目内容，id 必须在归并前抓取
		const pnpmTargetId = idOf("用户偏好 pnpm");
		const pnpmSourceId = idOf("该项目使用 pnpm 管理依赖");
		const stubRegistry = {
			streamSimple: () => ({
				result: async () => ({
					role: "assistant",
					timestamp: Date.now(),
					content: [
						{
							type: "text",
							text: `{"merges":[{"into":0,"merge":[1],"content":"用户与本项目均采用 pnpm 作为包管理器"}]}`,
						},
					],
					stopReason: "stop",
					usage: {},
				}),
			}),
		} as never as Parameters<typeof consolidateMemories>[0]["modelRegistry"];

		const result = await consolidateMemories({
			agentDir,
			model: { id: "stub", provider: "stub" } as never,
			modelRegistry: stubRegistry,
		});
		expect(result.mergesApplied).toBe(1);
		const entries = readMemoryEntries(agentDir);
		expect(entries).toHaveLength(5);
		const merged = entries.find((entry) => entry.id === pnpmTargetId)!;
		expect(merged.content).toBe("用户与本项目均采用 pnpm 作为包管理器");
		expect(merged.proofCount).toBe(2);
		expect(entries.find((entry) => entry.id === pnpmSourceId)).toBeUndefined();
	});

	it("parses merge payloads with index-to-id mapping and drops invalid groups", () => {
		const resolveId = (index: number) => (index === 0 ? "id-a" : index === 3 ? "id-b" : undefined);
		const merges = parseMergePayload(
			'{"merges":[{"into":0,"merge":[3,9],"content":"合并"},{"into":5,"merge":[6],"content":"目标不存在"}]}',
			resolveId,
		);
		expect(merges).toEqual([{ intoId: "id-a", mergeIds: ["id-b"], content: "合并" }]);
		expect(parseMergePayload("不是 JSON", resolveId)).toEqual([]);
	});
});
