import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectUsageStats, type UsageDirs } from "../src/modes/desktop/usage-stats.ts";

// 合成会话 JSONL（与 Owl-history 落盘格式同构），直接驱动真实扫描/聚合/存储链路。

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): { root: string; sessionsDir: string; dirs: UsageDirs } {
	const root = mkdtempSync(join(tmpdir(), "owl-usage-stats-"));
	roots.push(root);
	const sessionsDir = join(root, "Owl-history");
	mkdirSync(sessionsDir, { recursive: true });
	return { root, sessionsDir, dirs: { sessionsDir, storePath: join(root, "usage-stats.json") } };
}

/** 本机时区某天某小时的 ISO 时间（daysAgo=0 表示今天）。 */
function localIso(daysAgo: number, hour: number): string {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(hour, 0, 0, 0);
	return date.toISOString();
}

function sessionHead(id: string, cwd: string, ts: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd });
}

function userLine(id: string, ts: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: "parent",
		timestamp: ts,
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

function assistantLine(id: string, ts: string, provider: string, model: string, usage: Record<string, number>): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: "parent",
		timestamp: ts,
		message: {
			role: "assistant",
			provider,
			model,
			responseModel: model,
			content: [{ type: "text", text: "ok" }],
			usage: { ...usage, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
		},
	});
}

/** in+out+cacheRead+cacheWrite，与 usage.totalTokens 同口径。 */
function tokensOf(usage: Record<string, number>): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function writeSession(path: string, lines: string[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
}

const U_A = { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, reasoning: 4, totalTokens: 115 };
const U_B = { input: 200, output: 20, cacheRead: 8, cacheWrite: 2, reasoning: 6, totalTokens: 230 };

/** 标准两项目三会话种子：项目 A 近期两场（模型 a/b），项目 B 一场 40 天前（模型 a）。 */
function seedStandard(sessionsDir: string): { projA: string; projB: string } {
	const projA = join(sessionsDir, "proj-a");
	const projB = join(sessionsDir, "proj-b");
	writeSession(join(projA, "s1.jsonl"), [
		sessionHead("s1", "D:\\proj-a", localIso(2, 9)),
		userLine("u1", localIso(2, 9), "早上好"),
		assistantLine("a1", localIso(2, 10), "prov", "model-a", U_A),
		userLine("u2", localIso(0, 15), "继续"),
		assistantLine("a2", localIso(0, 15), "prov", "model-b", U_B),
	]);
	writeSession(join(projA, "s2.jsonl"), [
		sessionHead("s2", "D:\\proj-a", localIso(3, 11)),
		userLine("u1", localIso(3, 11), "第二条会话"),
		assistantLine("a1", localIso(3, 12), "prov", "model-b", U_B),
	]);
	writeSession(join(projB, "s3.jsonl"), [
		sessionHead("s3", "D:\\proj-b", localIso(40, 20)),
		userLine("u1", localIso(40, 20), "很久以前"),
		assistantLine("a1", localIso(40, 20), "prov", "model-a", U_A),
	]);
	return { projA, projB };
}

describe("usage-stats 增量存储与聚合", () => {
	it("首扫聚合 totals/messages/activeDays/peakHour/favoriteModel，并落盘存储", async () => {
		const { dirs } = makeRoot();
		seedStandard(dirs.sessionsDir!);

		const result = await collectUsageStats(undefined, dirs);

		expect(result.totals.totalTokens).toBe(2 * tokensOf(U_A) + 2 * tokensOf(U_B));
		expect(result.totals.input).toBe(2 * U_A.input + 2 * U_B.input);
		expect(result.totals.reasoning).toBe(2 * U_A.reasoning + 2 * U_B.reasoning);
		expect(result.messages).toBe(8); // s1: 2u+2a，s2/s3 各 1u+1a
		expect(result.sessionCount).toBe(3);
		expect(result.activeDays).toBe(4); // 今天、2/3/40 天前
		expect(result.peakHour).toBe(15); // 15 点集中了 4 条消息
		expect(result.favoriteModel).toBe("prov/model-b"); // 2×230 > 2×115
		expect(result.allProjects.map((p) => p.cwd).sort()).toEqual(["D:\\proj-a", "D:\\proj-b"]);
		expect(result.byDay).toHaveLength(30); // 无参数 = 兼容旧口径（最近 30 天补零）
		expect(result.byDayModel).toHaveLength(30);
		expect(existsSync(dirs.storePath!)).toBe(true);
		// 兼容字段仍在（设置页卡片继续可用）
		expect(result.byModel.find((m) => m.key === "prov/model-a")?.totalTokens).toBe(2 * tokensOf(U_A));
		expect(result.today.totalTokens).toBe(tokensOf(U_B));
	});

	it("mtime+size 未变的文件不重扫，变了的重扫替换", async () => {
		const { dirs } = makeRoot();
		seedStandard(dirs.sessionsDir!);
		await collectUsageStats(undefined, dirs);

		const storePath = dirs.storePath!;
		const before = JSON.parse(readFileSync(storePath, "utf-8")) as { files: Record<string, { size: number }> };
		const s1Path = Object.keys(before.files).find((p) => p.includes("s1.jsonl"))!;
		expect(before.files[s1Path]!.size).toBeGreaterThan(0);

		// s1 追加一轮对话；s2 不动
		const s1Lines = readFileSync(s1Path, "utf-8")
			.split("\n")
			.filter(Boolean)
			.concat(
				userLine("u3", localIso(0, 16), "追加一轮"),
				assistantLine("a3", localIso(0, 16), "prov", "model-a", U_A),
			);
		writeFileSync(s1Path, `${s1Lines.join("\n")}\n`, "utf-8");
		const future = Date.now() / 1000 + 5;
		utimesSync(s1Path, future, future); // 确保 mtime 变化（绕开文件系统时间戳精度）

		const after = await collectUsageStats(undefined, dirs);
		const storeAfter = JSON.parse(readFileSync(storePath, "utf-8")) as { files: Record<string, { size: number }> };
		expect(storeAfter.files[s1Path]!.size).toBeGreaterThan(before.files[s1Path]!.size);
		expect(after.messages).toBe(10); // 8 + 新一轮 user+assistant
		expect(after.totals.totalTokens).toBe(3 * tokensOf(U_A) + 2 * tokensOf(U_B));
		expect(after.favoriteModel).toBe("prov/model-b"); // 2×230=460 > 3×115=345
	});

	it("会话文件删除后统计不回吐", async () => {
		const { dirs } = makeRoot();
		const { projB } = seedStandard(dirs.sessionsDir!);
		const before = await collectUsageStats(undefined, dirs);
		expect(before.totals.totalTokens).toBe(2 * tokensOf(U_A) + 2 * tokensOf(U_B));

		rmSync(join(projB, "s3.jsonl"));
		const after = await collectUsageStats(undefined, dirs);

		// 累积口径：40 天前那场的用量、消息数、会话数都保留
		expect(after.totals.totalTokens).toBe(before.totals.totalTokens);
		expect(after.messages).toBe(before.messages);
		expect(after.sessionCount).toBe(3);
	});

	it("days 过滤：7d 只折叠近 7 天，byDay 补零 7 格", async () => {
		const { dirs } = makeRoot();
		seedStandard(dirs.sessionsDir!);

		const result = await collectUsageStats({ days: "7d" }, dirs);

		expect(result.totals.totalTokens).toBe(tokensOf(U_A) + 2 * tokensOf(U_B)); // s1 全部 + s2；40 天前的不计
		expect(result.messages).toBe(6);
		expect(result.activeDays).toBe(3); // 今天、2 天前、3 天前
		expect(result.sessionCount).toBe(2); // 7d 内开始的会话：s1、s2（s3 是 40 天前）
		expect(result.byDay).toHaveLength(7);
		expect(result.byDayModel).toHaveLength(7);
		expect(result.favoriteModel).toBe("prov/model-b");
	});

	it("days=all：byDay 覆盖全史并按 366 天封顶截断", async () => {
		const { dirs } = makeRoot();
		const sessionsDir = dirs.sessionsDir!;
		writeSession(join(sessionsDir, "old", "s0.jsonl"), [
			sessionHead("s0", "D:\\old", localIso(400, 8)),
			userLine("u1", localIso(400, 8), "四百天前"),
			assistantLine("a1", localIso(400, 9), "prov", "model-a", U_A),
		]);
		writeSession(join(sessionsDir, "new", "s1.jsonl"), [
			sessionHead("s1", "D:\\new", localIso(0, 10)),
			userLine("u1", localIso(0, 10), "今天"),
			assistantLine("a1", localIso(0, 10), "prov", "model-b", U_B),
		]);

		const result = await collectUsageStats({ days: "all" }, dirs);

		expect(result.byDayTruncated).toBe(true);
		expect(result.byDay).toHaveLength(366);
		expect(result.byDay.at(-1)?.totalTokens).toBe(tokensOf(U_B)); // 最后一天是今天
		expect(result.totals.totalTokens).toBe(tokensOf(U_A) + tokensOf(U_B));
	});

	it("cwd 过滤：只折叠该项目，allProjects 仍列全项目", async () => {
		const { dirs } = makeRoot();
		seedStandard(dirs.sessionsDir!);

		const result = await collectUsageStats({ cwd: "D:\\proj-b" }, dirs);

		expect(result.sessionCount).toBe(1);
		expect(result.totals.totalTokens).toBe(tokensOf(U_A)); // 40 天前那场
		expect(result.messages).toBe(2);
		expect(result.allProjects).toHaveLength(2);
		expect(result.topSessions).toHaveLength(1);
	});

	it("存储损坏时备份为 .corrupt 并从盘上会话重建", async () => {
		const { dirs } = makeRoot();
		seedStandard(dirs.sessionsDir!);
		await collectUsageStats(undefined, dirs);
		writeFileSync(dirs.storePath!, "{broken json", "utf-8");

		// 重置模块注册表 = 模拟桥重启（模块级 store 缓存清零，走 readStore 的损坏路径）
		vi.resetModules();
		const fresh = await import("../src/modes/desktop/usage-stats.ts");
		const result = await fresh.collectUsageStats(undefined, dirs);

		expect(result.totals.totalTokens).toBe(2 * tokensOf(U_A) + 2 * tokensOf(U_B));
		expect(existsSync(`${dirs.storePath!}.corrupt`)).toBe(true);
	});
});
