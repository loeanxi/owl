import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerResponseMessage,
	SessionSnapshotPayload,
	SessionStatsResult,
} from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

/**
 * 模型被悄悄替换时的回归测试。
 *
 * 以前：会话保存的模型下线/账号切换后，桥端直接换到「目录里第一个模型」，
 * 原因只写进日志，桌面端收到的统计里没有任何痕迹 —— 用户只看到「模型变笨了」。
 * 现在：替换按显式顺序选、原因结构化送到 session.stats，UI 有能力说清发生了什么。
 */

let directory: string;
let cwd: string;
let bridge: DesktopServerHandle;
let socket: WebSocket;
let noFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
	directory = resolve(await mkdtemp(join(tmpdir(), "owl-model-fallback-")));
	if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith("owl-model-fallback-")) {
		throw new Error("Unsafe fixture cleanup target");
	}
	const agentDir = join(directory, "profile");
	cwd = join(directory, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	// 用户在设置里选定的默认模型：b/preferred 在目录里排在 a/unrelated 之后，
	// 所以「按目录顺序挑第一个」和「用用户的选择」会落在不同模型上 —— 正好能测出区别。
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			plugins: [],
			cacheWarming: "off",
			owlMemory: { enabled: false },
			defaultProvider: "preferred",
			defaultModel: "chosen",
		}),
	);
	// 被删掉的那家提供商不在了，正是「模型下线」现场。
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				unrelated: {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					apiKey: "offline-fixture-key",
					models: [{ id: "survivor", name: "Survivor", reasoning: true, contextWindow: 128000, maxTokens: 4096 }],
				},
				preferred: {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					apiKey: "offline-fixture-key",
					models: [{ id: "chosen", name: "Chosen", reasoning: true, contextWindow: 128000, maxTokens: 4096 }],
				},
			},
		}),
	);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	// 环境里有真实 Key 时，目录外厂商的模型也会变「可用」，掩盖本次要测的替换顺序。
	for (const key of ["DEEPSEEK_API_KEY", "KIMI_API_KEY", "ALIYUN_API_KEY", "QINGJIAN_API_KEY", "TAVILY_API_KEY"]) {
		vi.stubEnv(key, "");
	}
	noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("Provider requests forbidden in model fallback test");
	});
	vi.stubGlobal("fetch", noFetch);
	bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
	await new Promise<void>((done, reject) => {
		socket.once("open", done);
		socket.once("error", reject);
	});
});

afterEach(async () => {
	socket?.terminate();
	await bridge?.close();
	expect(noFetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

function rpc<T = unknown>(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage & { result?: T }> {
	const id = randomUUID();
	return new Promise((done, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", receive);
			reject(new Error(`Fixture RPC timed out: ${payload.type}`));
		}, 15_000);
		const receive = (data: unknown) => {
			const message = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
			if (message.type !== "response" || message.id !== id) return;
			clearTimeout(timer);
			socket.off("message", receive);
			done(message);
		};
		socket.on("message", receive);
		socket.send(JSON.stringify({ ...payload, id }));
	});
}

/** 写一条「上次用的是 retired-model，而它已经不在目录里」的历史会话。 */
function historyWithRetiredModel(): SessionManager {
	const manager = SessionManager.create(cwd);
	manager.appendModelChange("retired-provider", "retired-model");
	manager.appendMessage({ role: "user", content: "上次聊到一半", timestamp: 1 });
	return manager;
}

it("session.stats reports why a saved model was replaced instead of hiding it", async () => {
	const history = historyWithRetiredModel();

	const resumed = await rpc<SessionSnapshotPayload>({ type: "session.resume", sessionId: history.getSessionId() });
	expect(resumed.ok).toBe(true);
	const sessionId = resumed.result?.sessionId;
	expect(sessionId).toBeTruthy();

	const stats = await rpc<SessionStatsResult>({ type: "session.stats", sessionId: sessionId! });
	expect(stats.ok).toBe(true);
	// 替换发生了什么：原模型、现在用的模型、原因、是否换厂商，全部可读。
	// 替换落在用户设置里的默认模型上，而不是目录里排第一的那个。
	expect(stats.result?.model).toMatchObject({ provider: "preferred", id: "chosen" });
	expect(stats.result?.modelFallback).toMatchObject({
		reason: "model-missing",
		saved: { provider: "retired-provider", id: "retired-model" },
		used: { provider: "preferred", id: "chosen" },
		crossProvider: true,
	});
	expect(stats.result?.modelFallback?.message).toContain("retired-provider/retired-model");
	expect(stats.result?.modelFallback?.message).toContain("preferred/chosen");
});

it("keeps reporting the same replacement so parallel windows agree", async () => {
	const history = historyWithRetiredModel();
	const resumed = await rpc<SessionSnapshotPayload>({ type: "session.resume", sessionId: history.getSessionId() });
	const sessionId = resumed.result!.sessionId;

	const first = await rpc<SessionStatsResult>({ type: "session.stats", sessionId });
	const second = await rpc<SessionStatsResult>({ type: "session.stats", sessionId });

	// 一次性消费会让第二个窗口（或刷新）看到空字段、显示不一致，所以这里必须稳定。
	expect(first.result?.modelFallback).toEqual(second.result?.modelFallback);
});

it("reports no fallback when the session's model is still available", async () => {
	const manager = SessionManager.create(cwd);
	manager.appendModelChange("unrelated", "survivor");
	manager.appendMessage({ role: "user", content: "正常会话", timestamp: 1 });

	const resumed = await rpc<SessionSnapshotPayload>({ type: "session.resume", sessionId: manager.getSessionId() });
	const stats = await rpc<SessionStatsResult>({ type: "session.stats", sessionId: resumed.result!.sessionId });

	expect(stats.result?.model).toMatchObject({ provider: "unrelated", id: "survivor" });
	expect(stats.result?.modelFallback).toBeUndefined();
});
