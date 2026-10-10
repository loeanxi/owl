import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectUsageStats } from "../../coding-agent/src/modes/desktop/usage-stats.ts";
import { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../../coding-agent/src/utils/atomic-file.ts";
import { type CareerDirs, type CareerHost, collectCareerStats } from "../src/career-stats.ts";

// 合成本机各 agent 的会话数据（与真实落盘格式同构），驱动多 Agent 扫描/聚合链路。
// owl 侧注入空目录（totals=0 占位），不碰本机真实 ~/.owl。

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): CareerDirs {
	const root = mkdtempSync(join(tmpdir(), "owl-career-stats-"));
	roots.push(root);
	mkdirSync(join(root, "claude", "projects", "D--proj"), { recursive: true });
	mkdirSync(join(root, "codex", "sessions", "2026", "06", "22"), { recursive: true });
	mkdirSync(join(root, "codex", "archived_sessions", "2026", "01", "01"), { recursive: true });
	mkdirSync(join(root, "kimi", "sessions", "wd_x", "session_abc12345", "agents", "main"), { recursive: true });
	mkdirSync(join(root, "opencode"), { recursive: true });
	mkdirSync(join(root, "owl-agent", "Owl-history"), { recursive: true });
	return {
		agentDir: join(root, "owl-agent"),
		claudeDir: join(root, "claude"),
		codexDir: join(root, "codex"),
		kimiDir: join(root, "kimi"),
		opencodeDir: join(root, "opencode"),
		geminiDir: join(root, "gemini"),
		// SQLite 类数据源默认指向不存在的路径：测试按需建 fixture，不碰真实机器数据
		qoderDb: join(root, "qoder", "local.db"),
		kiloDb: join(root, "kilo", "kilo.db"),
		copilotDb: join(root, "copilot", "session-store.db"),
		extensionHosts: [join(root, "ext-hosts")],
		detectRoot: root,
		owl: {
			sessionsDir: join(root, "owl-agent", "Owl-history"),
			storePath: join(root, "owl-agent", "usage-stats.json"),
		},
		piSessions: {
			sessionsDir: join(root, "pi", "agent", "sessions"),
			storePath: join(root, "pi", "usage-stats-pi.json"),
		},
		zcodeDb: join(root, "zcode", "db.sqlite"),
		dshDir: join(root, "dsh", "sessions"),
		mimoDb: join(root, "mimo", "mimocode.db"),
		cursorSessionsDir: join(root, "cursor", "acp-sessions"),
		kimiDesktopDir: join(root, "kimi-desktop", "sessions"),
		mavisDir: join(root, "mavis", "sessions"),
		reasonixDir: join(root, "reasonix", "projects"),
		workbuddyDir: join(root, "workbuddy", "projects"),
	};
}

/** 本机时区某天的 ISO 时间（daysAgo=0 表示今天）。 */
function localIso(daysAgo: number): string {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(10, 0, 0, 0);
	return date.toISOString();
}

function claudeAssistantLine(ts: string, model: string, usage: Record<string, number>): string {
	return JSON.stringify({
		parentUuid: "p0",
		isSidechain: false,
		type: "assistant",
		uuid: "u0",
		timestamp: ts,
		cwd: "D:\\proj",
		sessionId: "s-claude-1",
		version: "2.1.286",
		message: {
			id: "msg_0",
			type: "message",
			role: "assistant",
			model,
			usage: { ...usage, output_tokens_details: { reasoning_tokens: 0 } },
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
		},
	});
}

function codexEnvelope(type: string, payload: Record<string, unknown>, ts: string): string {
	return JSON.stringify({ timestamp: ts, ordinal: 1, type, payload });
}

const CODEX_TOTAL_1 = {
	input_tokens: 1000,
	cached_input_tokens: 400,
	cache_write_input_tokens: 0,
	output_tokens: 50,
	reasoning_output_tokens: 10,
	total_tokens: 1050,
};
const CODEX_TOTAL_2 = {
	input_tokens: 2500,
	cached_input_tokens: 900,
	cache_write_input_tokens: 0,
	output_tokens: 120,
	reasoning_output_tokens: 30,
	total_tokens: 2620,
};

function kimiUsageRecord(
	timeMs: number,
	usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number },
): string {
	return JSON.stringify({
		type: "usage.record",
		model: "moonshot-cn/kimi-k3",
		usage,
		usageScope: "turn",
		time: timeMs,
	});
}

async function scan(dirs: CareerDirs) {
	const host: CareerHost = {
		agentDir: dirs.agentDir!,
		collectUsageStats,
		files: { atomicWriteFileSync, backupCorruptFile, withFileLockSync },
	};
	const result = await collectCareerStats(host, dirs);
	const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
	return { result, byId };
}

describe("career stats", () => {
	it("aggregates Claude Code / Codex / Kimi JSONL into one board", async () => {
		const dirs = makeRoot();
		writeFileSync(
			join(dirs.claudeDir!, "projects", "D--proj", "s-claude-1.jsonl"),
			`${[
				JSON.stringify({ type: "file-history-snapshot", snapshot: { messageId: "m-0" } }),
				claudeAssistantLine(localIso(3), "claude-sonnet-5.5", {
					input_tokens: 100,
					output_tokens: 10,
					cache_read_input_tokens: 500,
					cache_creation_input_tokens: 20,
				}),
				JSON.stringify({
					type: "user",
					message: { role: "user", content: [{ type: "text", text: 'what is "usage"?' }] },
				}),
				claudeAssistantLine(localIso(1), "claude-sonnet-5.5", {
					input_tokens: 200,
					output_tokens: 30,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				}),
			].join("\n")}\n`,
		);
		writeFileSync(
			join(dirs.codexDir!, "sessions", "2026", "06", "22", "rollout-2026-06-22-codex-1.jsonl"),
			[
				codexEnvelope(
					"session_meta",
					{
						session_id: "s-codex-1",
						cwd: "D:\\proj",
						timestamp: localIso(2),
						originator: "codex-cli",
						cli_version: "0.5.0",
					},
					localIso(2),
				),
				codexEnvelope("turn_context", { turn_id: "t1", cwd: "D:\\proj", model: "mimo-v2.5-pro" }, localIso(2)),
				codexEnvelope(
					"event_msg",
					{ type: "token_count", info: { total_token_usage: CODEX_TOTAL_1 } },
					localIso(2),
				),
				codexEnvelope(
					"event_msg",
					{ type: "token_count", info: { total_token_usage: CODEX_TOTAL_2 } },
					localIso(2),
				),
			].join("\n") + "\n",
		);
		// 归档目录里的老会话也要计入
		writeFileSync(
			join(dirs.codexDir!, "archived_sessions", "2026", "01", "01", "rollout-2026-01-01-old.jsonl"),
			[
				codexEnvelope(
					"session_meta",
					{ session_id: "s-codex-old", cwd: "D:\\proj", timestamp: localIso(30) },
					localIso(30),
				),
				codexEnvelope("turn_context", { turn_id: "t0", cwd: "D:\\proj", model: "old-model" }, localIso(30)),
				codexEnvelope(
					"event_msg",
					{ type: "token_count", info: { total_token_usage: CODEX_TOTAL_1 } },
					localIso(30),
				),
			].join("\n") + "\n",
		);
		// Kimi：wire.jsonl 的 usage.record 按 turn 逐条累加
		writeFileSync(
			join(dirs.kimiDir!, "sessions", "wd_x", "session_abc12345", "agents", "main", "wire.jsonl"),
			[
				JSON.stringify({ type: "metadata", protocol_version: "1.4", created_at: 1784964853020 }),
				kimiUsageRecord(Date.parse(localIso(2)), {
					inputOther: 100,
					output: 10,
					inputCacheRead: 200,
					inputCacheCreation: 5,
				}),
				kimiUsageRecord(Date.parse(localIso(1)), {
					inputOther: 50,
					output: 20,
					inputCacheRead: 300,
					inputCacheCreation: 0,
				}),
			].join("\n") + "\n",
		);

		const { result, byId } = await scan(dirs);
		// pi 目录不存在 → 不出现；zcode/dsh/mimo 注入路径不存在 → unavailable/nodata
		expect(result.agents.slice(0, 17).map((agent) => agent.id)).toEqual([
			"owl",
			"zcode",
			"claude",
			"codex",
			"kimi",
			"opencode",
			"kilo",
			"qoder",
			"copilot",
			"roo",
			"cline",
			"workbuddy",
			"mimo",
			"dsh",
			"mavis",
			"reasonix",
			"gemini",
		]);

		// Claude：逐条 assistant 用量相加（不是取尾），cache_creation → cacheWrite
		const claude = byId.get("claude")!;
		expect(claude.status).toBe("ok");
		expect(claude.sessions).toBe(1);
		expect(claude.totals.input).toBe(300);
		expect(claude.totals.output).toBe(40);
		expect(claude.totals.cacheRead).toBe(500);
		expect(claude.totals.cacheWrite).toBe(20);
		expect(claude.totals.totalTokens).toBe(860);
		expect(claude.byModel).toEqual([{ key: "claude-sonnet-5.5", totalTokens: 860 }]);

		// Codex：老版本只有 total → 差分累加（1050 + 1570）；归档会话（1050）也计入
		const codex = byId.get("codex")!;
		expect(codex.totals.totalTokens).toBe(1050 + 1570 + 1050);
		expect(codex.sessions).toBe(2);
		expect(codex.byModel.map((model) => model.key)).toEqual(["mimo-v2.5-pro", "old-model"]);

		// Kimi：usage.record 逐条累加（inputOther=非缓存输入）
		const kimi = byId.get("kimi")!;
		expect(kimi.status).toBe("ok");
		expect(kimi.totals.input).toBe(150);
		expect(kimi.totals.output).toBe(30);
		expect(kimi.totals.cacheRead).toBe(500);
		expect(kimi.totals.cacheWrite).toBe(5);
		expect(kimi.totals.totalTokens).toBe(685);
		expect(kimi.byModel).toEqual([{ key: "moonshot-cn/kimi-k3", totalTokens: 685 }]);

		// Gemini：目录不存在 → 未检测到
		expect(byId.get("gemini")!.status).toBe("unavailable");
		expect(result.generatedAt).toBeTruthy();
	});

	it("aggregates OpenCode from its SQLite session/message tables", async () => {
		const dirs = makeRoot();
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(join(dirs.opencodeDir!, "opencode.db"));
		db.exec(`
			create table session (id text primary key, directory text, title text, cost real, tokens_input integer, tokens_output integer, tokens_cache_read integer, tokens_cache_write integer, tokens_reasoning integer, time_created integer, time_updated integer);
			create table message (id text primary key, session_id text, time_created integer, data text);
		`);
		const now = Date.now();
		db.prepare("insert into session values (?,?,?,?,?,?,?,?,?,?,?)").run(
			"ses_1",
			"C:/proj",
			"hello",
			0.01,
			1000,
			100,
			2000,
			50,
			5,
			now - 86_400_000,
			now - 3_600_000,
		);
		const msg = (id: string, time: number, tokens: Record<string, unknown>, model: string): void => {
			db.prepare("insert into message values (?,?,?,?)").run(
				id,
				"ses_1",
				time,
				JSON.stringify({ role: "assistant", providerID: "deepseek", modelID: model, cost: 0.005, tokens }),
			);
		};
		msg(
			"m1",
			now - 86_400_000,
			{ input: 600, output: 60, reasoning: 5, cache: { read: 1200, write: 30 }, total: 1895 },
			"deepseek-v4-pro",
		);
		msg(
			"m2",
			now - 3_600_000,
			{ input: 400, output: 40, reasoning: 0, cache: { read: 800, write: 20 }, total: 1260 },
			"deepseek-v4-pro",
		);
		db.close(); // 不关会锁住目录，afterEach 清理 EPERM

		const { byId } = await scan(dirs);
		const opencode = byId.get("opencode")!;
		expect(opencode.status).toBe("ok");
		// totals 来自 session 表的官方聚合列
		expect(opencode.totals.input).toBe(1000);
		expect(opencode.totals.output).toBe(100);
		expect(opencode.totals.cacheRead).toBe(2000);
		expect(opencode.totals.cacheWrite).toBe(50);
		expect(opencode.totals.reasoning).toBe(5);
		expect(opencode.totals.cost).toBeCloseTo(0.01, 6);
		expect(opencode.sessions).toBe(1);
		// 按天/按模型来自 message 表
		expect(opencode.byModel).toEqual([{ key: "deepseek/deepseek-v4-pro", totalTokens: 3155 }]);
		expect(opencode.byDay).toHaveLength(2);
	});

	it("aggregates Kilo Code from its OpenCode-style SQLite session tables", async () => {
		const dirs = makeRoot();
		mkdirSync(dirname(dirs.kiloDb!), { recursive: true });
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dirs.kiloDb!);
		db.exec(
			"create table session (id text primary key, directory text, cost real, tokens_input integer, tokens_output integer, tokens_cache_read integer, tokens_cache_write integer, tokens_reasoning integer, time_created integer, time_updated integer); create table message (id text primary key, session_id text, time_created integer, data text);",
		);
		const now = Date.now();
		db.prepare("insert into session values (?,?,?,?,?,?,?,?,?,?)").run(
			"ks1",
			"C:/proj",
			0.02,
			500,
			50,
			1000,
			25,
			3,
			now - 86_400_000,
			now,
		);
		db.prepare("insert into message values (?,?,?,?)").run(
			"km1",
			"ks1",
			now,
			JSON.stringify({
				role: "assistant",
				providerID: "anthropic",
				modelID: "claude-sonnet-5.5",
				cost: 0.01,
				tokens: { input: 500, output: 50, reasoning: 3, cache: { read: 1000, write: 25 }, total: 1575 },
			}),
		);
		db.close();

		const { byId } = await scan(dirs);
		const kilo = byId.get("kilo")!;
		expect(kilo.status).toBe("ok");
		expect(kilo.totals.totalTokens).toBe(500 + 50 + 1000 + 25);
		expect(kilo.totals.cost).toBeCloseTo(0.02, 6);
		expect(kilo.byModel).toEqual([{ key: "anthropic/claude-sonnet-5.5", totalTokens: 1575 }]);
	});

	it("sums Claude measured cost from its own costs.jsonl snapshots (last per session)", async () => {
		const dirs = makeRoot();
		mkdirSync(join(dirs.claudeDir!, "metrics"), { recursive: true });
		writeFileSync(
			join(dirs.claudeDir!, "projects", "D--proj", "s-claude-1.jsonl"),
			`${claudeAssistantLine(localIso(1), "claude-sonnet-5.5", { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })}\n`,
		);
		writeFileSync(
			join(dirs.claudeDir!, "metrics", "costs.jsonl"),
			[
				JSON.stringify({
					timestamp: localIso(2),
					session_id: "a",
					transcript_path: "x",
					model: "m",
					input_tokens: 100,
					output_tokens: 10,
					cache_write_tokens: 0,
					cache_read_tokens: 0,
					estimated_cost_usd: 1,
				}),
				JSON.stringify({
					timestamp: localIso(1),
					session_id: "a",
					transcript_path: "x",
					model: "m",
					input_tokens: 200,
					output_tokens: 20,
					cache_write_tokens: 0,
					cache_read_tokens: 0,
					estimated_cost_usd: 2,
				}),
				JSON.stringify({
					timestamp: localIso(1),
					session_id: "b",
					transcript_path: "y",
					model: "m",
					input_tokens: 50,
					output_tokens: 5,
					cache_write_tokens: 0,
					cache_read_tokens: 0,
					estimated_cost_usd: 0.5,
				}),
			].join("\n") + "\n",
		);

		const { byId } = await scan(dirs);
		// 会话 a 取末条（$2，不是 1+2=3），b 一条（$0.5）
		expect(byId.get("claude")!.totals.cost).toBeCloseTo(2.5, 6);
	});

	it("reports detected-but-unparsed agents without fabricating numbers", async () => {
		const dirs = makeRoot();
		mkdirSync(join(dirs.detectRoot!, ".cursor"), { recursive: true });
		mkdirSync(join(dirs.detectRoot!, ".trae-cn"), { recursive: true });

		const { result } = await scan(dirs);
		const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
		// Cursor：本地各库核验过都不落用量 → nodata（不再是待解析）
		const cursor = byId.get("cursor")!;
		expect(cursor.status).toBe("nodata");
		expect(cursor.totals.totalTokens).toBe(0);
		expect(cursor.note).toContain("服务端");
		// Trae：加密私有格式 → 待解析
		expect(byId.get("trae")!.status).toBe("detected");
		// 未检测到的产品不出现（Qoder/Copilot/Kilo 已是解析行，不归检测表）
		expect(byId.has("minimax")).toBe(false);
		expect(existsSync(join(dirs.detectRoot!, ".cursor"))).toBe(true);
	});

	it("aggregates Qoder from chat_message.token_info", async () => {
		const dirs = makeRoot();
		mkdirSync(dirname(dirs.qoderDb!), { recursive: true });
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dirs.qoderDb!);
		db.exec(
			"create table chat_session (session_id text primary key); create table chat_message (id integer primary key, role text, token_info text, model_info text, gmt_create integer);",
		);
		db.prepare("insert into chat_session values (?)").run("qs1");
		db.prepare("insert into chat_message (role, token_info, model_info, gmt_create) values (?,?,?,?)").run(
			"assistant",
			JSON.stringify({ prompt_tokens: 23332, completion_tokens: 159, cached_tokens: 23018 }),
			JSON.stringify({ model_key: "qmodel" }),
			Date.parse(localIso(2)),
		);
		db.prepare("insert into chat_message (role, token_info, model_info, gmt_create) values (?,?,?,?)").run(
			"assistant",
			JSON.stringify({ prompt_tokens: 22878, completion_tokens: 48, cached_tokens: 0 }),
			JSON.stringify({ model_key: "auto" }),
			Date.parse(localIso(1)),
		);
		db.close();

		const { byId } = await scan(dirs);
		const qoder = byId.get("qoder")!;
		expect(qoder.status).toBe("ok");
		expect(qoder.sessions).toBe(1);
		// cached>0 时从 prompt 里扣除重叠，四桶之和 = prompt + completion
		expect(qoder.totals.input).toBe(23332 - 23018 + 22878);
		expect(qoder.totals.output).toBe(159 + 48);
		expect(qoder.totals.cacheRead).toBe(23018);
		expect(qoder.totals.totalTokens).toBe(23332 + 159 + 22878 + 48);
		expect(qoder.byModel.map((model) => model.key)).toEqual(["qmodel", "auto"]);
	});

	it("aggregates GitHub Copilot from assistant_usage_events", async () => {
		const dirs = makeRoot();
		mkdirSync(dirname(dirs.copilotDb!), { recursive: true });
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dirs.copilotDb!);
		db.exec(
			"create table sessions (id text primary key); create table assistant_usage_events (id integer primary key, model text, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer, created_at integer);",
		);
		db.prepare("insert into sessions values (?)").run("cs1");
		db.prepare(
			"insert into assistant_usage_events (model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at) values (?,?,?,?,?,?,?)",
		).run("mai-code-1.1-flash", 29077, 617, 4992, 0, 384, Date.parse(localIso(1)));
		db.close();

		const { byId } = await scan(dirs);
		const copilot = byId.get("copilot")!;
		expect(copilot.status).toBe("ok");
		expect(copilot.sessions).toBe(1);
		expect(copilot.totals.input).toBe(29077);
		expect(copilot.totals.output).toBe(617);
		expect(copilot.totals.cacheRead).toBe(4992);
		expect(copilot.totals.reasoning).toBe(384);
		expect(copilot.totals.totalTokens).toBe(29077 + 617 + 4992);
		expect(copilot.byModel).toEqual([{ key: "mai-code-1.1-flash", totalTokens: 29077 + 617 + 4992 }]);
	});

	it("sums Codex last_token_usage deltas across total resets", async () => {
		const dirs = makeRoot();
		writeFileSync(
			join(dirs.codexDir!, "sessions", "2026", "06", "22", "rollout-reset.jsonl"),
			[
				codexEnvelope(
					"session_meta",
					{ session_id: "s-reset", cwd: "D:\\proj", timestamp: localIso(2) },
					localIso(2),
				),
				codexEnvelope("turn_context", { turn_id: "t1", cwd: "D:\\proj", model: "gpt-6.1-sol" }, localIso(2)),
				// 重置前：total=1000，last 是本次增量
				codexEnvelope(
					"event_msg",
					{
						type: "token_count",
						info: {
							total_token_usage: {
								input_tokens: 900,
								cached_input_tokens: 800,
								output_tokens: 60,
								reasoning_output_tokens: 5,
								total_tokens: 1000,
							},
							last_token_usage: {
								input_tokens: 900,
								cached_input_tokens: 800,
								output_tokens: 60,
								reasoning_output_tokens: 5,
								total_tokens: 1000,
							},
						},
					},
					localIso(2),
				),
				// resume 后 total 重置为 400（非单调），last 仍是本轮增量
				codexEnvelope(
					"event_msg",
					{
						type: "token_count",
						info: {
							total_token_usage: {
								input_tokens: 350,
								cached_input_tokens: 300,
								output_tokens: 40,
								reasoning_output_tokens: 2,
								total_tokens: 400,
							},
							last_token_usage: {
								input_tokens: 350,
								cached_input_tokens: 300,
								output_tokens: 40,
								reasoning_output_tokens: 2,
								total_tokens: 400,
							},
						},
					},
					localIso(1),
				),
			].join("\n") + "\n",
		);

		const { byId } = await scan(dirs);
		const codex = byId.get("codex")!;
		// 取尾口径会得 400；增量口径应收全 1000 + 400
		expect(codex.totals.totalTokens).toBe(1400);
		expect(codex.totals.output).toBe(100);
		expect(codex.byModel.map((model) => model.key)).toEqual(["gpt-6.1-sol"]);
	});

	it("keeps owl and pi as independent rows (no cross-merging)", async () => {
		const dirs = makeRoot();
		mkdirSync(join(dirs.owl!.sessionsDir!, "proj"), { recursive: true });
		mkdirSync(join(dirs.piSessions!.sessionsDir!, "proj"), { recursive: true });
		const owlLine = (id: string, ts: string, usage: Record<string, number>): string =>
			JSON.stringify({
				type: "message",
				id,
				parentId: "parent",
				timestamp: ts,
				message: {
					role: "assistant",
					provider: "zai-coding-cn",
					model: "glm-5.3",
					responseModel: "glm-5.3",
					content: [{ type: "text", text: "ok" }],
					usage,
				},
			});
		const head = (id: string, ts: string): string =>
			JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: "D:\\proj" });
		// owl：今天，100 万
		writeFileSync(
			join(dirs.owl!.sessionsDir!, "proj", "new.jsonl"),
			[
				head("owl-new", localIso(0)),
				owlLine("m1", localIso(0), { input: 900_000, output: 10_000, cacheRead: 50_000, cacheWrite: 40_000 }),
			].join("\n") + "\n",
		);
		// pi：3 天前，200 万——独立 agent，独立一行，不得混入 owl
		writeFileSync(
			join(dirs.piSessions!.sessionsDir!, "proj", "old.jsonl"),
			[
				head("pi-old", localIso(3)),
				owlLine("m2", localIso(3), { input: 1_900_000, output: 20_000, cacheRead: 60_000, cacheWrite: 20_000 }),
			].join("\n") + "\n",
		);

		const { byId } = await scan(dirs);
		const owl = byId.get("owl")!;
		expect(owl.name).toBe("owl");
		expect(owl.sessions).toBe(1);
		expect(owl.totals.totalTokens).toBe(1_000_000);
		expect(owl.byDay).toHaveLength(1);
		const pi = byId.get("pi")!;
		expect(pi.sessions).toBe(1);
		expect(pi.totals.totalTokens).toBe(2_000_000);
		expect(pi.firstAt).toBe(localIso(3));
	});

	it("aggregates WorkBuddy from providerData.usage (camelCase, input includes cache)", async () => {
		const dirs = makeRoot();
		const taskDir = join(dirs.workbuddyDir!, "c-Users-WorkBuddy-2026-06-28");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, "wb-1.jsonl"),
			[
				JSON.stringify({
					id: "w1",
					parentId: null,
					timestamp: Date.parse(localIso(2)),
					type: "function_call",
					sessionId: "wb-sess-1",
					cwd: "D:\\proj",
					providerData: {
						model: "hy3",
						usage: {
							requests: 1,
							inputTokens: 32_357,
							outputTokens: 287,
							totalTokens: 32_644,
							inputTokensDetails: [{ cached_tokens: 16_320 }],
							outputTokensDetails: [{ reasoning_tokens: 208 }],
						},
					},
				}),
				JSON.stringify({
					id: "w2",
					timestamp: Date.parse(localIso(1)),
					type: "function_call",
					sessionId: "wb-sess-1",
					cwd: "D:\\proj",
					providerData: {
						model: "auto",
						usage: {
							requests: 1,
							inputTokens: 10_000,
							outputTokens: 500,
							totalTokens: 10_500,
							inputTokensDetails: [],
							outputTokensDetails: [],
						},
					},
				}),
			].join("\n") + "\n",
		);

		const { byId } = await scan(dirs);
		const wb = byId.get("workbuddy")!;
		expect(wb.status).toBe("ok");
		expect(wb.sessions).toBe(1);
		// inputTokens 含缓存：非缓存输入 = 32357 - 16320
		expect(wb.totals.input).toBe(32_357 - 16_320 + 10_000);
		expect(wb.totals.cacheRead).toBe(16_320);
		expect(wb.totals.reasoning).toBe(208);
		expect(wb.totals.totalTokens).toBe(32_644 + 10_500);
		expect(wb.byModel.map((model) => model.key)).toEqual(["hy3", "auto"]);
	});

	it("aggregates DeepSeek Harness from multi-frame zstd sessions", async () => {
		const dirs = makeRoot();
		const sessionDir = join(dirs.dshDir!, "--D-proj", "session-abc");
		mkdirSync(sessionDir, { recursive: true });
		const { zstdCompressSync } = await import("node:zlib");
		const lines = [
			JSON.stringify({ type: "session", seq: 0, time: Date.parse(localIso(2)), data: { cwd: "D:\\proj" } }),
			JSON.stringify({
				type: "assistant/message",
				seq: 16,
				time: Date.parse(localIso(2)),
				data: {
					usage: { inputTokens: 9720, outputTokens: 111, totalTokens: 10_855, cacheReadTokens: 1024 },
					message: { source: { kind: "model", provider: "manger", model: "wb/deepseek-v4.1-flash" } },
				},
			}),
			// 重置后的第二轮
			JSON.stringify({
				type: "assistant/message",
				seq: 40,
				time: Date.parse(localIso(1)),
				data: {
					usage: { inputTokens: 5000, outputTokens: 200, totalTokens: 5200, cacheReadTokens: 0 },
					message: { source: { kind: "model", provider: "manger", model: "wb/deepseek-v4.1-flash" } },
				},
			}),
		];
		// 多帧拼接：每行独立一帧（解析器逐帧解压后拼接）
		const frames = lines.map((line) => zstdCompressSync(Buffer.from(line, "utf-8")));
		writeFileSync(join(sessionDir, "session.v4.jsonl.zstd"), Buffer.concat(frames));

		const { byId } = await scan(dirs);
		const dsh = byId.get("dsh")!;
		expect(dsh.status).toBe("ok");
		expect(dsh.sessions).toBe(1);
		// input 含缓存读：非缓存输入 = 9720 - 1024 + 5000
		expect(dsh.totals.input).toBe(9720 - 1024 + 5000);
		expect(dsh.totals.cacheRead).toBe(1024);
		expect(dsh.totals.input).toBe(9720 - 1024 + 5000);
		expect(dsh.totals.cacheRead).toBe(1024);
		expect(dsh.totals.totalTokens).toBe(10_855 + 5200);
		expect(dsh.byModel).toEqual([{ key: "wb/deepseek-v4.1-flash", totalTokens: 16_055 }]);
	});

	it("aggregates Mavis (MiniMax Code) and Reasonix telemetry", async () => {
		const dirs = makeRoot();
		const mavisDir = join(dirs.mavisDir!, "2026", "10", "01");
		mkdirSync(mavisDir, { recursive: true });
		writeFileSync(
			join(mavisDir, "messages.jsonl"),
			[
				JSON.stringify({
					message_id: "msg-1",
					turn_id: "t1",
					message: {
						role: "assistant",
						model: "MiniMax-M3",
						timestamp: localIso(2),
						usage: {
							input: 27_367,
							output: 725,
							cacheRead: 128,
							cacheWrite: 0,
							totalTokens: 28_220,
							cost: { total: 0.01 },
						},
					},
				}),
			].join("\n") + "\n",
		);
		const reasonixDir = join(dirs.reasonixDir!, "D--proj", "sessions");
		mkdirSync(reasonixDir, { recursive: true });
		writeFileSync(
			join(reasonixDir, "20260628-170121.201523000-deepseek-v4-flash-session.jsonl.telemetry.json"),
			JSON.stringify({
				usage: {
					promptTokens: 15_000_617,
					completionTokens: 82_861,
					totalTokens: 15_083_478,
					reasoningTokens: 32_369,
					cacheHitTokens: 14_827_776,
					cacheMissTokens: 172_841,
					sessionCostUsd: 0.635,
				},
			}),
		);

		const { byId } = await scan(dirs);
		const mavis = byId.get("mavis")!;
		expect(mavis.status).toBe("ok");
		expect(mavis.totals.input).toBe(27_367);
		expect(mavis.totals.cacheRead).toBe(128);
		expect(mavis.totals.totalTokens).toBe(28_220);
		expect(mavis.byModel).toEqual([{ key: "MiniMax-M3", totalTokens: 28_220 }]);

		// Reasonix：promptTokens = cacheHit + cacheMiss（含缓存），扣重叠后四桶之和 = total
		const reasonix = byId.get("reasonix")!;
		expect(reasonix.status).toBe("ok");
		expect(reasonix.totals.input).toBe(172_841);
		expect(reasonix.totals.cacheRead).toBe(14_827_776);
		expect(reasonix.totals.totalTokens).toBe(15_083_478);
		expect(reasonix.totals.cost).toBeCloseTo(0.635, 6);
		expect(reasonix.byModel).toEqual([{ key: "deepseek-v4-flash", totalTokens: 15_083_478 }]);
	});

	it("aggregates MimoCode from its OpenCode-style db without official aggregate columns", async () => {
		const dirs = makeRoot();
		mkdirSync(dirname(dirs.mimoDb!), { recursive: true });
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dirs.mimoDb!);
		db.exec(`
			create table session (id text primary key, directory text, title text, time_created integer, time_updated integer);
			create table message (id text primary key, session_id text, time_created integer, data text);
		`);
		const now = Date.now();
		db.prepare("insert into session values (?,?,?,?,?)").run("ms1", "C:/proj", "hello", now - 86_400_000, now);
		db.prepare("insert into message values (?,?,?,?)").run(
			"mm1",
			"ms1",
			now - 3_600_000,
			JSON.stringify({
				role: "assistant",
				providerID: "mimo-desktop",
				modelID: "mimo-v2.6-pro",
				cost: 0.004,
				tokens: { input: 700, output: 60, reasoning: 4, cache: { read: 900, write: 20 }, total: 1680 },
			}),
		);
		db.close();

		const { byId } = await scan(dirs);
		const mimo = byId.get("mimo")!;
		expect(mimo.status).toBe("ok");
		// 无官方聚合列：totals 从 message 行折叠，sessions 按去重会话数
		expect(mimo.sessions).toBe(1);
		expect(mimo.totals.totalTokens).toBe(700 + 60 + 900 + 20);
		expect(mimo.totals.cost).toBeCloseTo(0.004, 6);
		expect(mimo.byModel).toEqual([{ key: "mimo-desktop/mimo-v2.6-pro", totalTokens: 1680 }]);
	});

	it("estimates Cursor usage from acp-session conversation history", async () => {
		const dirs = makeRoot();
		const sessionDir = join(dirs.cursorSessionsDir!, "abc123");
		mkdirSync(sessionDir, { recursive: true });
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(join(sessionDir, "store.db"));
		db.exec("create table blobs (id text primary key, data text)");
		db.prepare("insert into blobs values (?,?)").run(
			"b1",
			JSON.stringify({ role: "user", content: [{ type: "text", text: "帮我重构登录模块，注意超时处理" }] }),
		);
		db.prepare("insert into blobs values (?,?)").run(
			"b2",
			JSON.stringify({
				role: "assistant",
				content: [
					{ type: "text", text: "OK, I will refactor the login module and adjust the timeout handling now." },
				],
			}),
		);
		db.close();

		const { byId } = await scan(dirs);
		const cursor = byId.get("cursor")!;
		expect(cursor.status).toBe("ok");
		expect(cursor.sessions).toBe(1);
		expect(cursor.totals.output).toBeGreaterThan(0);
		// 输入 = 重放的用户上下文（中文按 1 字符/token），输出 = 助手文本
		expect(cursor.totals.input).toBeGreaterThan(0);
		expect(cursor.totals.totalTokens).toBe(cursor.totals.input + cursor.totals.output);
		expect(cursor.note).toContain("估算");
	});

	it("keeps the last snapshot when a SQLite source app is deleted (never deletes history)", async () => {
		const dirs = makeRoot();
		mkdirSync(dirname(dirs.mimoDb!), { recursive: true });
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dirs.mimoDb!);
		db.exec(`
			create table session (id text primary key, directory text, title text, cost real, tokens_input integer, tokens_output integer, tokens_cache_read integer, tokens_cache_write integer, tokens_reasoning integer, time_created integer, time_updated integer);
			create table message (id text primary key, session_id text, time_created integer, data text);
		`);
		const now = Date.now();
		db.prepare("insert into session values (?,?,?,?,?,?,?,?,?,?,?)").run(
			"ms9",
			"C:/proj",
			"t",
			0.03,
			4000,
			400,
			6000,
			100,
			40,
			now - 86_400_000,
			now,
		);
		db.close();

		const first = await scan(dirs);
		expect(first.byId.get("mimo")!.status).toBe("ok");
		expect(first.byId.get("mimo")!.totals.totalTokens).toBe(10_500);

		// 用户卸载 MimoCode：库文件整个消失
		rmSync(dirs.mimoDb!, { force: true });

		const second = await scan(dirs);
		const mimo = second.byId.get("mimo")!;
		// 历史从持久化快照回退展示：数字分毫不差，note 注明快照口径
		expect(mimo.status).toBe("ok");
		expect(mimo.totals.totalTokens).toBe(10_500);
		expect(mimo.note).toContain("最后同步快照");
	});

	it("restores records from *.corrupt when the store file is damaged (never deletes history)", async () => {
		const dirs = makeRoot();
		const claudeFile = join(dirs.claudeDir!, "projects", "D--proj", "s-claude-1.jsonl");
		writeFileSync(
			claudeFile,
			`${claudeAssistantLine(localIso(1), "claude-sonnet-5.5", { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })}\n`,
		);

		// 第一轮：正常扫描落库
		const first = await scan(dirs);
		expect(first.byId.get("claude")!.totals.totalTokens).toBe(110);

		// 读取持久化快照（含已删除文件的历史），然后把它改名成 .corrupt（模拟损坏现场）
		const storePath = join(dirs.agentDir!, "career-stats.json");
		const healthy = readFileSync(storePath, "utf-8");
		rmSync(claudeFile, { force: true }); // 会话文件也被清掉
		writeFileSync(storePath, "{ broken json");
		renameSync(storePath, `${storePath}.corrupt`);
		writeFileSync(storePath, healthy);

		// 损坏重建：从 .corrupt 回填历史，Claude 记录不丢
		const second = await scan(dirs);
		expect(second.byId.get("claude")!.totals.totalTokens).toBe(110);
	});

	it("aggregates ZCode from turn_usage/model_usage SQLite tables", async () => {
		const dirs = makeRoot();
		mkdirSync(dirname(dirs.zcodeDb!), { recursive: true });
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dirs.zcodeDb!);
		db.exec(`
			create table turn_usage (session_id text, turn_id text, status text, started_at integer, completed_at integer,
				input_tokens integer, output_tokens integer, reasoning_tokens integer,
				cache_creation_input_tokens integer, cache_read_input_tokens integer, computed_total_tokens integer);
			create table model_usage (id text primary key, session_id text, provider_id text, model_id text, computed_total_tokens integer);
		`);
		// 一轮：input 含缓存读（非缓存输入 = 20,000）
		db.prepare("insert into turn_usage values (?,?,?,?,?,?,?,?,?,?,?)").run(
			"sess_1",
			"t1",
			"completed",
			Date.parse(localIso(1)),
			Date.parse(localIso(1)),
			1_020_000,
			5_000,
			100,
			0,
			1_000_000,
			1_025_000,
		);
		db.prepare("insert into model_usage values (?,?,?,?,?)").run(
			"mu1",
			"sess_1",
			"account:bigmodel-individual-coding-plan",
			"GLM-5.3-Flash",
			1_025_000,
		);
		db.close(); // 不关会锁目录，afterEach 清理 EPERM

		const { byId } = await scan(dirs);
		const zcode = byId.get("zcode")!;
		expect(zcode.status).toBe("ok");
		expect(zcode.sessions).toBe(1);
		// 四桶之和 = computed_total（缓存重叠已从 input 扣除）
		expect(zcode.totals.input).toBe(20_000);
		expect(zcode.totals.cacheRead).toBe(1_000_000);
		expect(zcode.totals.totalTokens).toBe(1_025_000);
		expect(zcode.byModel).toEqual([
			{ key: "account:bigmodel-individual-coding-plan/GLM-5.3-Flash", totalTokens: 1_025_000 },
		]);
	});

	it("aggregates Roo Code from history_item.json task summaries", async () => {
		const dirs = makeRoot();
		const taskDir = join(dirs.extensionHosts![0], "rooveterinaryinc.roo-cline", "tasks", "019f8577");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, "history_item.json"),
			JSON.stringify({
				id: "019f8577",
				number: 1,
				ts: Date.parse(localIso(2)),
				task: "你好",
				tokensIn: 13127,
				tokensOut: 665,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0,
				size: 7763336,
				workspace: "d:\\work\\proj",
			}),
		);

		const { byId } = await scan(dirs);
		const roo = byId.get("roo")!;
		expect(roo.status).toBe("ok");
		expect(roo.sessions).toBe(1);
		expect(roo.totals.totalTokens).toBe(13127 + 665);
		expect(roo.totals.input).toBe(13127);
		expect(roo.totals.output).toBe(665);
		expect(roo.byDay).toHaveLength(1);
	});

	it("aggregates Cline from ui_messages api_req_started usage", async () => {
		const dirs = makeRoot();
		const taskDir = join(dirs.extensionHosts![0], "saoudrizwan.claude-dev", "tasks", "1788448346172");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, "ui_messages.json"),
			JSON.stringify([
				{
					ts: Date.parse(localIso(1)),
					type: "say",
					say: "task",
					text: "hi",
					modelInfo: { providerId: "cline", modelId: "z-ai/glm-5.3-flash" },
				},
				{
					ts: Date.parse(localIso(1)),
					type: "say",
					say: "api_req_started",
					text: JSON.stringify({
						apiProtocol: "openai",
						tokensIn: 13127,
						tokensOut: 665,
						cacheWrites: 0,
						cacheReads: 0,
						cost: 0,
					}),
				},
				// 失败请求没有用量字段，不参与累加
				{ ts: Date.parse(localIso(0)), type: "ask", ask: "api_req_failed", text: "OpenAI completion error: 400" },
			]),
		);

		const { byId } = await scan(dirs);
		const cline = byId.get("cline")!;
		expect(cline.status).toBe("ok");
		expect(cline.totals.totalTokens).toBe(13127 + 665);
		expect(cline.byModel).toEqual([{ key: "z-ai/glm-5.3-flash", totalTokens: 13127 + 665 }]);
	});

	it("treats existing Gemini records as nodata (no token fields locally) and counts sessions", async () => {
		const dirs = makeRoot();
		mkdirSync(join(dirs.geminiDir!, "tmp", "projhash", "chats"), { recursive: true });
		writeFileSync(join(dirs.geminiDir!, "tmp", "projhash", "chats", "session-2026-08-22-x.jsonl"), "{}\n");

		const { byId } = await scan(dirs);
		const gemini = byId.get("gemini")!;
		expect(gemini.status).toBe("nodata");
		expect(gemini.sessions).toBe(1);
		expect(gemini.totals.totalTokens).toBe(0);
	});

	it("rescans changed files incrementally (mtime+size cache)", async () => {
		const dirs = makeRoot();
		const claudeFile = join(dirs.claudeDir!, "projects", "D--proj", "s-claude-1.jsonl");
		writeFileSync(
			claudeFile,
			`${claudeAssistantLine(localIso(0), "claude-sonnet-5.5", { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })}\n`,
		);

		const first = await scan(dirs);
		expect(first.byId.get("claude")!.totals.totalTokens).toBe(110);

		// 追加一条用量：mtime/size 变化 → 整文件重扫替换，记录替换而非累加
		appendFileSync(
			claudeFile,
			`${claudeAssistantLine(localIso(0), "claude-opus-4-6", {
				input_tokens: 50,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			})}\n`,
		);
		const second = await scan(dirs);
		expect(second.byId.get("claude")!.totals.totalTokens).toBe(165);
		expect(second.byId.get("claude")!.byModel.map((model) => model.key)).toEqual([
			"claude-sonnet-5.5",
			"claude-opus-4-6",
		]);
	});
});
