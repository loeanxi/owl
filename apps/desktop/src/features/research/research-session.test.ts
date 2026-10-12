import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopClientRequestWithoutId, ResearchDiagnosis, ResearchResult, ServerEventMessage, SessionStatsResult } from "../../bridge/protocol.ts";
import { ResearchSessionController, researchSessionKey } from "./research-session.ts";
import { publishedResults, researchCsv, researchResultOf, safeSourceUrl } from "./research-results.ts";

type Response = { ok: boolean; result?: unknown; error?: string };
class FakeBridge {
	requests: DesktopClientRequestWithoutId[] = [];
	handlers = new Set<(event: ServerEventMessage) => void>();
	respond: (request: DesktopClientRequestWithoutId) => Response | Promise<Response>;
	constructor(respond: (request: DesktopClientRequestWithoutId) => Response | Promise<Response>) { this.respond = respond; }
	onSessionEvent(handler: (event: ServerEventMessage) => void): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
	async request<T>(request: DesktopClientRequestWithoutId): Promise<{ ok: boolean; result?: T; error?: string }> {
		this.requests.push(request);
		const response = await this.respond(request);
		return { ...response, result: response.result as T | undefined };
	}
	emit(sessionId: string, event: Record<string, unknown>): void { for (const handler of this.handlers) handler({ type: "event", sessionId, event }); }
}
class MemoryStorage {
	values = new Map<string, string>();
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	setItem(key: string, value: string): void { this.values.set(key, value); }
	removeItem(key: string): void { this.values.delete(key); }
}

const defaults = { model: "fixture/model", thinkingLevel: "high", approvalMode: "confirm" as const };
const stats: SessionStatsResult = { model: { provider: "fixture", id: "model" }, thinkingLevel: "high", availableThinkingLevels: ["off", "high"], supportsThinking: true };
const published: ResearchResult = { id: "result-1", createdAt: "2026-10-04T00:00:00Z", mode: "crawl", status: "sample", title: "真实样本", summary: "来自工具输出", columns: [{ key: "name", label: "名称" }], rows: [{ name: "记录" }], sources: [{ id: "source-1", title: "Example", url: "https://example.org" }], findings: [{ kind: "fact", text: "发现记录", sourceIds: ["source-1"] }] };
const diagnosis: ResearchDiagnosis = { id: "11111111-1111-4111-8111-111111111111", version: 1, createdAt: "2026-10-12T00:00:00.000Z", ownerSessionId: "research-1", status: "textual_refusal_candidate", summary: "文本提示需要核对；没有明确审核标记。", evidence: [{ source: "agent", text: "我无法帮助提供该分析" }] };

function fresh(respond?: FakeBridge["respond"]): { bridge: FakeBridge; store: MemoryStorage; controller: ResearchSessionController } {
	const bridge = new FakeBridge(respond ?? ((request) => request.type === "session.create" ? { ok: true, result: { sessionId: "research-1" } } : request.type === "session.running" ? { ok: true, result: { running: [] } } : request.type === "session.stats" ? { ok: true, result: stats } : { ok: true }));
	const store = new MemoryStorage();
	const controller = new ResearchSessionController(bridge, store, "D:/owl", defaults);
	controller.start();
	controller.setConnected(true);
	return { bridge, store, controller };
}

test("research forwards the chosen Home preset and displays the authoritative creation binding", async () => {
	const { controller, bridge } = fresh((request) => request.type === "session.create" ? { ok: true, result: { sessionId: "research-1", agentPreset: "ptc" } } : { ok: true });
	try {
		await controller.attach();
		await controller.setAgentPreset("ptc");
		assert.equal(await controller.send("整理资料"), true);
		const created = bridge.requests.find((request) => request.type === "session.create");
		assert.equal(created?.type === "session.create" && created.agentPreset, "ptc");
		assert.equal(controller.getSnapshot().sessionPreset, "ptc");
	} finally { controller.dispose(); }
});

test("restoring research displays its bound preset while later choices apply to the next conversation", async () => {
	const { controller, bridge, store } = fresh((request) => request.type === "session.resume" ? { ok: true, result: { sessionId: "research-1", cwd: "D:/owl", researchMode: "auto", agentPreset: "minimal", messages: [{ role: "user", content: "已发送的问题" }], messageEntryIds: [] } } : request.type === "session.running" ? { ok: true, result: { running: [] } } : { ok: true, result: stats });
	try {
		store.setItem(researchSessionKey("D:/owl"), "research-1");
		await controller.attach();
		assert.equal(controller.getSnapshot().sessionPreset, "minimal");
		await controller.setAgentPreset("cordis");
		assert.equal(controller.getSnapshot().sessionPreset, "minimal");
		assert.equal(controller.getSnapshot().agentPreset, "cordis");
		assert.equal(bridge.requests.some((request) => request.type === "session.setPreset"), false);
		assert.equal(controller.newThread(), true);
		assert.equal(controller.getSnapshot().sessionPreset, undefined);
		assert.equal(controller.getSnapshot().agentPreset, "cordis");
		const restored = new ResearchSessionController(bridge, store, "D:/owl", defaults);
		assert.equal(restored.getSnapshot().agentPreset, "cordis");
		restored.dispose();
	} finally { controller.dispose(); }
});

test("an empty research session changes its actual preset only after the bridge accepts", async () => {
	let rejected = false;
	const { controller, bridge, store } = fresh((request) => request.type === "session.resume" ? { ok: true, result: { sessionId: "research-1", cwd: "D:/owl", researchMode: "auto", agentPreset: "standard", messages: [], messageEntryIds: [] } } : request.type === "session.setPreset" ? rejected ? { ok: false, error: "preset rejected" } : { ok: true, result: { agentPreset: "ptc" } } : request.type === "session.running" ? { ok: true, result: { running: [] } } : { ok: true, result: stats });
	try {
		store.setItem(researchSessionKey("D:/owl"), "research-1");
		await controller.attach();
		await controller.setAgentPreset("ptc");
		assert.equal(controller.getSnapshot().sessionPreset, "ptc");
		assert.ok(bridge.requests.some((request) => request.type === "session.setPreset" && request.agentPreset === "ptc"));
		rejected = true;
		await controller.setAgentPreset("minimal");
		assert.equal(controller.getSnapshot().sessionPreset, "ptc");
		assert.equal(controller.getSnapshot().agentPreset, "ptc");
		assert.equal(controller.getSnapshot().error, "preset rejected");
	} finally { controller.dispose(); }
});

test("a cached preset that now uses the Pi runtime falls back when the Home roster arrives", async () => {
	const { controller, bridge, store } = fresh();
	store.setItem(`${researchSessionKey("D:/owl")}.preferences`, JSON.stringify({ ...defaults, agentPreset: "custom-pi" }));
	const restored = new ResearchSessionController(bridge, store, "D:/owl", { ...defaults, agentPreset: "standard" });
	restored.start(); restored.setConnected(true);
	try {
		await restored.attach();
		restored.setDefaultAgentPreset("standard", ["custom-pi"]);
		assert.equal(restored.getSnapshot().agentPreset, undefined);
		assert.equal(await restored.send("整理资料"), true);
		const created = bridge.requests.find((request) => request.type === "session.create");
		assert.equal(created?.type === "session.create" && created.agentPreset, "standard");
	} finally { restored.dispose(); controller.dispose(); }
});

test("legacy category preferences are ignored while research model, thinking and approval settings survive", async () => {
	const store = new MemoryStorage();
	const preferencesKey = `${researchSessionKey("D:/owl")}.preferences`;
	store.setItem(preferencesKey, JSON.stringify({ model: "saved/selected", thinkingLevel: "off", approvalMode: "plan", mode: "binary" }));
	const bridge = new FakeBridge((request) => request.type === "session.create" ? { ok: true, result: { sessionId: "research-1" } } : { ok: true });
	const controller = new ResearchSessionController(bridge, store, "D:/owl", defaults);
	controller.start(); controller.setConnected(true);
	try {
		assert.equal(controller.getSnapshot().model, "saved/selected");
		assert.equal(controller.getSnapshot().thinkingLevel, "off");
		assert.equal(controller.getSnapshot().approvalMode, "plan");
		assert.equal(Object.hasOwn(controller.getSnapshot(), "mode"), false);
		await controller.attach();
		await controller.setThinkingLevel("high");
		assert.deepEqual(JSON.parse(store.getItem(preferencesKey) ?? "null"), { model: "saved/selected", thinkingLevel: "high", approvalMode: "plan" });
		assert.equal(await controller.send("根据网址和文件组合分析"), true);
		assert.deepEqual(bridge.requests.find((request) => request.type === "session.create"), { type: "session.create", cwd: "D:/owl", approvalMode: "plan", thinkingLevel: "high", researchMode: "auto", provider: "saved", model: "selected" });
		assert.equal(bridge.requests.find((request) => request.type === "session.prompt")?.type === "session.prompt" && bridge.requests.find((request) => request.type === "session.prompt")?.researchMode, "auto");
	} finally { controller.dispose(); }
});

test("old crawl and web research threads retain result evidence and continue with automatic routing", async () => {
	for (const researchMode of ["crawl", "web"] as const) {
		const store = new MemoryStorage();
		store.setItem(researchSessionKey("D:/owl"), "research-1");
		const historical = { ...published, mode: researchMode };
		const bridge = new FakeBridge((request) => request.type === "session.resume" ? { ok: true, result: { sessionId: "research-1", cwd: "D:/owl", researchMode, messages: [{ role: "toolResult", toolName: "research_publish", details: { researchResult: historical } }], messageEntryIds: [] } } : request.type === "session.running" ? { ok: true, result: { running: [] } } : request.type === "session.stats" ? { ok: true, result: stats } : { ok: true });
		const controller = new ResearchSessionController(bridge, store, "D:/owl", defaults);
		controller.start(); controller.setConnected(true);
		try {
			await controller.attach();
			assert.deepEqual(controller.getSnapshot().results, [historical]);
			assert.equal(Object.hasOwn(controller.getSnapshot(), "mode"), false);
			assert.equal(await controller.send("结合程序和网页继续分析"), true);
			assert.deepEqual(bridge.requests.find((request) => request.type === "session.prompt"), { type: "session.prompt", sessionId: "research-1", message: "结合程序和网页继续分析", researchMode: "auto" });
			assert.equal(bridge.requests.some((request) => request.type === "session.create"), false);
			assert.deepEqual(controller.getSnapshot().results, [historical]);
		} finally { controller.dispose(); }
	}
});

test("rapid submissions create a single research thread with real settings and image data", async () => {
	let releaseCreate: ((response: Response) => void) | undefined;
	const { controller, bridge, store } = fresh((request) => request.type === "session.create" ? new Promise<Response>((resolve) => { releaseCreate = resolve; }) : request.type === "session.stats" ? { ok: true, result: stats } : { ok: true });
	try {
		await controller.attach();
		const images = [{ type: "image" as const, data: "fixture", mimeType: "image/png" }];
		const first = controller.send("整理资料", images);
		assert.equal(await controller.send("不应重复"), false);
		assert.equal(bridge.requests.filter((request) => request.type === "session.create").length, 1);
		assert.ok(releaseCreate);
		releaseCreate({ ok: true, result: { sessionId: "research-1" } });
		assert.equal(await first, true);
		assert.equal(store.getItem(researchSessionKey("d:\\owl\\")), "research-1");
		assert.deepEqual(bridge.requests.find((request) => request.type === "session.create"), { type: "session.create", cwd: "D:/owl", approvalMode: "confirm", thinkingLevel: "high", researchMode: "auto", provider: "fixture", model: "model" });
		assert.deepEqual(bridge.requests.find((request) => request.type === "session.prompt"), { type: "session.prompt", sessionId: "research-1", message: "整理资料", researchMode: "auto", images });
	} finally { controller.dispose(); }
});

test("foreign session events cannot pollute research, streamed publish survives agent_end", async () => {
	const { controller, bridge } = fresh();
	try {
		await controller.attach(); await controller.send("采集");
		bridge.emit("main-chat", { type: "agent_settled" });
		assert.equal(controller.getSnapshot().running, true);
		bridge.emit("research-1", { type: "agent_start" });
		bridge.emit("research-1", { type: "message_start", message: { role: "assistant", content: [] } });
		bridge.emit("research-1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "真实回复" } });
		const toolCall = { type: "toolCall", id: "publish-1", name: "research_publish", arguments: {} };
		bridge.emit("research-1", { type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name });
		const result = { role: "toolResult", toolName: "research_publish", toolCallId: toolCall.id, content: [{ type: "text", text: "样本已整理" }], details: { researchResult: published } };
		bridge.emit("research-1", { type: "tool_execution_end", toolName: toolCall.name, toolCallId: toolCall.id, result });
		assert.equal(controller.getSnapshot().results.length, 1);
		assert.deepEqual(controller.getSnapshot().entries.findLast((entry) => entry.kind === "assistant")?.tools[0].output?.researchResult, published);
		bridge.emit("research-1", { type: "agent_end", messages: [{ role: "user", content: "采集" }, { role: "assistant", content: [toolCall] }, result] });
		bridge.emit("research-1", { type: "agent_settled" });
		assert.equal(controller.getSnapshot().results.length, 1);
		assert.equal(controller.getSnapshot().running, false);
		assert.equal(controller.newThread(), true);
		assert.equal(controller.getSnapshot().sessionId, undefined);
	} finally { controller.dispose(); }
});

test("a new research chat can start while the previous thread keeps running", async () => {
	let created = 0;
	const store = new MemoryStorage();
	const bridge = new FakeBridge((request) => {
		if (request.type === "session.create") { created++; return { ok: true, result: { sessionId: `research-${created}` } }; }
		if (request.type === "session.resume") return { ok: true, result: { sessionId: request.sessionId, cwd: "D:/owl", researchMode: "auto", messages: [], messageEntryIds: [] } };
		if (request.type === "session.running") return { ok: true, result: { running: ["research-1"] } };
		if (request.type === "session.stats") return { ok: true, result: stats };
		return { ok: true };
	});
	const controller = new ResearchSessionController(bridge, store, "D:/owl", defaults);
	controller.start(); controller.setConnected(true);
	try {
		await controller.attach();
		assert.equal(await controller.send("长时间逆向"), true);
		assert.equal(controller.getSnapshot().sessionId, "research-1");
		assert.equal(controller.getSnapshot().running, true);
		assert.equal(controller.newThread(), true);
		assert.equal(controller.getSnapshot().sessionId, undefined);
		assert.equal(controller.getSnapshot().running, false);
		assert.equal(store.getItem(researchSessionKey("d:\\owl\\")), null);
		bridge.emit("research-1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "旧线程仍在产出" } });
		assert.equal(controller.getSnapshot().entries.length, 0);
		assert.equal(await controller.send("换个话题"), true);
		assert.equal(controller.getSnapshot().sessionId, "research-2");
		assert.equal(bridge.requests.filter((request) => request.type === "session.create").length, 2);
		// 切回仍在后台运行的旧会话：恢复绑定并带回运行状态。
		await controller.resume("research-1");
		assert.equal(controller.getSnapshot().sessionId, "research-1");
		assert.equal(controller.getSnapshot().running, true);
		assert.equal(store.getItem(researchSessionKey("d:\\owl\\")), "research-1");
	} finally { controller.dispose(); }
});

test("restore preserves real model, running state and historical evidence without restoring the old category", async () => {
	const store = new MemoryStorage();
	store.setItem(researchSessionKey("D:/owl"), "research-1");
	const bridge = new FakeBridge((request) => request.type === "session.resume" ? { ok: true, result: { sessionId: "research-1", cwd: "d:\\OWL", researchMode: "crawl", approvalMode: "plan", messages: [{ role: "toolResult", toolName: "research_publish", details: { researchResult: published } }], messageEntryIds: [], header: {} } } : request.type === "session.running" ? { ok: true, result: { running: ["research-1"] } } : { ok: true, result: { ...stats, model: { provider: "restored", id: "actual" }, thinkingLevel: "off" } });
	const controller = new ResearchSessionController(bridge, store, "D:/owl", defaults);
	controller.start(); controller.setConnected(true);
	try {
		await controller.attach();
		assert.equal(controller.getSnapshot().model, "restored/actual");
		assert.equal(controller.getSnapshot().thinkingLevel, "off");
		assert.equal(Object.hasOwn(controller.getSnapshot(), "mode"), false);
		assert.equal(controller.getSnapshot().approvalMode, "plan");
		assert.equal(controller.getSnapshot().running, true);
		assert.equal(controller.getSnapshot().results.length, 1);
		assert.equal(controller.getSnapshot().results[0].mode, "crawl");
		// 恢复出的运行中会话也允许切去新对话：旧任务留在后台，不立即创建新会话。
		assert.equal(controller.newThread(), true);
		assert.equal(bridge.requests.some((request) => request.type === "session.create"), false);
	} finally { controller.dispose(); }
});

test("settings call the bridge and failed model switches keep authoritative settings", async () => {
	const { controller, bridge } = fresh((request) => request.type === "session.create" ? { ok: true, result: { sessionId: "research-1" } } : request.type === "session.stats" ? { ok: true, result: stats } : request.type === "session.setModel" ? { ok: false, error: "fixture denied" } : request.type === "session.setThinkingLevel" ? { ok: true, result: { ...stats, thinkingLevel: "off" } } : { ok: true });
	try {
		await controller.attach(); await controller.send("分析"); bridge.emit("research-1", { type: "agent_settled" });
		await controller.setModel("other/model");
		assert.equal(controller.getSnapshot().model, "fixture/model");
		assert.equal(controller.getSnapshot().error, "fixture denied");
		await controller.setThinkingLevel("off");
		assert.equal(controller.getSnapshot().thinkingLevel, "off");
		await controller.setApprovalMode("plan");
		assert.equal(controller.getSnapshot().approvalMode, "plan");
		assert.ok(bridge.requests.some((request) => request.type === "session.setModel" && request.provider === "other"));
		assert.ok(bridge.requests.some((request) => request.type === "session.setThinkingLevel" && request.level === "off"));
		assert.ok(bridge.requests.some((request) => request.type === "session.setApprovalMode" && request.approvalMode === "plan"));
		const count = bridge.requests.filter((request) => request.type === "session.prompt").length;
		await controller.executeBuiltin("thinking", "off"); await controller.executeBuiltin("model", "invalid");
		assert.equal(bridge.requests.filter((request) => request.type === "session.prompt").length, count);
	} finally { controller.dispose(); }
});

test("reconnect reloads transcript after missed events without creating or restarting a run", async () => {
	let resumeCount = 0;
	const { controller, bridge } = fresh((request) => {
		if (request.type === "session.create") return { ok: true, result: { sessionId: "research-1" } };
		if (request.type === "session.stats") return { ok: true, result: stats };
		if (request.type === "session.running") return { ok: true, result: { running: [] } };
		if (request.type === "session.resume") { resumeCount++; return { ok: true, result: { sessionId: "research-1", cwd: "D:/owl", researchMode: "auto", messages: [{ role: "user", content: "旧问题" }, { role: "assistant", content: [{ type: "text", text: "断线期间已完成" }] }], messageEntryIds: [] } }; }
		return { ok: true };
	});
	try {
		await controller.attach(); await controller.send("旧问题");
		controller.setConnected(false); controller.setConnected(true); await controller.attach();
		assert.equal(resumeCount, 1);
		const answer = controller.getSnapshot().entries[1];
		assert.equal(answer?.kind === "assistant" && answer.text, "断线期间已完成");
		assert.equal(controller.getSnapshot().running, false);
		assert.equal(bridge.requests.filter((request) => request.type === "session.create").length, 1);
		assert.equal(bridge.requests.filter((request) => request.type === "session.prompt").length, 1);
	} finally { controller.dispose(); }
});

test("changing the restored thread ignores late responses and prohibits plain-chat bindings", async () => {
	let resolveOld: ((response: Response) => void) | undefined;
	const { controller, store } = fresh((request) => request.type === "session.resume" && request.sessionId === "old" ? new Promise<Response>((resolve) => { resolveOld = resolve; }) : request.type === "session.resume" ? { ok: true, result: { sessionId: "new", cwd: "D:/owl", messages: [], researchMode: "web", messageEntryIds: [] } } : request.type === "session.running" ? { ok: true, result: { running: [] } } : { ok: true, result: stats });
	try {
		store.setItem(researchSessionKey("D:/owl"), "old");
		const old = controller.attach();
		await controller.resume("new");
		assert.ok(resolveOld);
		resolveOld({ ok: true, result: { sessionId: "old", cwd: "D:/owl", messages: [], messageEntryIds: [] } });
		await old;
		assert.equal(controller.getSnapshot().sessionId, "new");
		assert.equal(Object.hasOwn(controller.getSnapshot(), "mode"), false);
	} finally { controller.dispose(); }
});

test("restore does not duplicate completed messages but retains incomplete stream events", async () => {
	const user = { role: "user", content: "问题" };
	const completed = { role: "assistant", content: [{ type: "text", text: "第一段" }] };
	const store = new MemoryStorage();
	store.setItem(researchSessionKey("D:/owl"), "research-1");
	const bridge = new FakeBridge((request) => {
		if (request.type === "session.resume") {
			bridge.emit("research-1", { type: "entry_appended", entry: { id: "entry-1", type: "message", message: user } });
			bridge.emit("research-1", { type: "message_start", message: { role: "assistant", content: [] } });
			bridge.emit("research-1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "第一段" } });
			bridge.emit("research-1", { type: "message_end", message: completed });
			bridge.emit("research-1", { type: "message_start", message: { role: "assistant", content: [] } });
			bridge.emit("research-1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "第二段正在流式" } });
			return { ok: true, result: { sessionId: "research-1", cwd: "D:/owl", researchMode: "auto", messages: [user, completed], messageEntryIds: ["entry-1", "entry-2"] } };
		}
		return request.type === "session.running" ? { ok: true, result: { running: ["research-1"] } } : { ok: true, result: stats };
	});
	const controller = new ResearchSessionController(bridge, store, "D:/owl", defaults);
	controller.start(); controller.setConnected(true);
	try {
		await controller.attach();
		const entries = controller.getSnapshot().entries;
		assert.equal(entries.length, 3);
		assert.equal(entries[1].kind === "assistant" && entries[1].text, "第一段");
		assert.equal(entries[2].kind === "assistant" && entries[2].text, "第二段正在流式");
	} finally { controller.dispose(); }
});

test("a rejected prompt retains attachments for retry without leaving a false user turn", async () => {
	let rejectPrompt = true;
	const { controller, bridge } = fresh((request) => request.type === "session.create" ? { ok: true, result: { sessionId: "research-1" } } : request.type === "session.prompt" ? { ok: !rejectPrompt, ...(rejectPrompt ? { error: "prompt rejected" } : {}) } : { ok: true, result: stats });
	try {
		await controller.attach();
		const images = [{ type: "image" as const, data: "attached", mimeType: "image/png" }];
		const attachedPaths = ["D:/owl/selected.exe"];
		assert.equal(await controller.send("图片资料", images, attachedPaths), false);
		assert.equal(controller.getSnapshot().entries.length, 0);
		assert.deepEqual(controller.getSnapshot().failedPrompt?.images, images);
		assert.deepEqual(controller.getSnapshot().failedPrompt?.attachedPaths, attachedPaths);
		rejectPrompt = false;
		const failed = controller.getSnapshot().failedPrompt;
		assert.ok(failed);
		assert.equal(await controller.send(failed.text, failed.images, failed.attachedPaths), true);
		assert.equal(controller.getSnapshot().entries.length, 1);
		assert.deepEqual(bridge.requests.findLast((request) => request.type === "session.prompt")?.type === "session.prompt" && bridge.requests.findLast((request) => request.type === "session.prompt")?.images, images);
		assert.deepEqual(bridge.requests.findLast((request) => request.type === "session.prompt")?.type === "session.prompt" && bridge.requests.findLast((request) => request.type === "session.prompt")?.attachedPaths, attachedPaths);
	} finally { controller.dispose(); }
});

test("late stats cannot undo an acknowledged model switch", async () => {
	let delayStats = false;
	let releaseStats: ((response: Response) => void) | undefined;
	const { controller, bridge } = fresh((request) => {
		if (request.type === "session.create") return { ok: true, result: { sessionId: "research-1" } };
		if (request.type === "session.stats") return delayStats ? new Promise<Response>((resolve) => { releaseStats = resolve; }) : { ok: true, result: stats };
		if (request.type === "session.setModel") return { ok: true, result: { ...stats, model: { provider: "new", id: "model" } } };
		return { ok: true };
	});
	try {
		await controller.attach(); await controller.send("资料");
		delayStats = true;
		bridge.emit("research-1", { type: "agent_settled" });
		await controller.setModel("new/model");
		assert.ok(releaseStats);
		releaseStats({ ok: true, result: stats });
		await Promise.resolve(); await Promise.resolve();
		assert.equal(controller.getSnapshot().model, "new/model");
	} finally { controller.dispose(); }
});

test("a plain chat snapshot is rejected without overwriting the research binding", async () => {
	const { controller, store } = fresh((request) => request.type === "session.resume" ? { ok: true, result: { sessionId: "main-chat", cwd: "D:/owl", messages: [], messageEntryIds: [] } } : { ok: true, result: stats });
	try {
		store.setItem(researchSessionKey("D:/owl"), "main-chat");
		await controller.attach();
		assert.equal(controller.getSnapshot().ready, false);
		assert.ok(controller.getSnapshot().error);
		assert.equal(store.getItem(researchSessionKey("D:/owl")), "main-chat");
	} finally { controller.dispose(); }
});

test("publish validation refuses fake prose, dangling evidence and malformed cells; CSV and links stay safe", () => {
	assert.equal(researchResultOf({ text: "I found three rows" }), undefined);
	assert.equal(researchResultOf({ ...published, findings: [{ kind: "fact", text: "claim", sourceIds: ["unknown"] }] }), undefined);
	assert.equal(researchResultOf({ ...published, rows: [{ name: { nested: true } }] }), undefined);
	assert.equal(researchResultOf({ ...published, rows: [{ name: "valid", extra: "unexpected" }] }), undefined);
	assert.equal(researchResultOf({ ...published, rows: [{}] }), undefined);
	assert.equal(researchResultOf({ ...published, columns: [{ key: "__proto__", label: "invalid" }], rows: [JSON.parse('{"__proto__":"value"}')] }), undefined);
	assert.equal(researchResultOf({ ...published, findings: [{ kind: "fact", text: "claim", sourceIds: [] }] }), undefined);
	assert.equal(researchResultOf({ ...published, sources: [{ id: "source-1", title: "unsafe", url: "javascript:alert(1)" }] }), undefined);
	assert.equal(publishedResults([{ role: "toolResult", toolName: "other", details: { researchResult: published } }]).length, 0);
	assert.equal(publishedResults([{ role: "toolResult", toolName: "research_publish", isError: true, details: { researchResult: published } }]).length, 0);
	assert.equal(safeSourceUrl("javascript:alert(1)"), undefined);
	assert.equal(safeSourceUrl("file:///D:/private.txt"), undefined);
	assert.equal(safeSourceUrl("https://user:secret@example.org"), undefined);
	assert.equal(safeSourceUrl("https://example.org"), "https://example.org/");
	const csv = researchCsv({ ...published, columns: [{ key: "name", label: "=header" }], rows: [{ name: " \t=WEBSERVICE(\"url\")" }, { name: "record,\"quoted\"" }, { name: -42 }] });
	assert.ok(csv.includes('"\'=header"'));
	assert.ok(csv.includes('"\' \t=WEBSERVICE(""url"")"'));
	assert.ok(csv.includes('"record,""quoted"""'));
	assert.ok(csv.endsWith('"-42"'));
});

test("research restores a session-owned diagnosis without inferring refusal from ordinary messages", async () => {
	const { controller, store } = fresh((request) => request.type === "session.resume" ? { ok: true, result: { sessionId: "research-1", cwd: "D:/owl", researchMode: "auto", researchDiagnosis: diagnosis, messages: [{ role: "assistant", content: [{ type: "text", text: "我无法帮助提供该分析" }] }], messageEntryIds: [] } } : request.type === "session.running" ? { ok: true, result: { running: [] } } : { ok: true, result: stats });
	try {
		store.setItem(researchSessionKey("D:/owl"), "research-1");
		await controller.attach();
		assert.deepEqual(controller.getSnapshot().diagnosis, diagnosis);
		assert.equal(controller.getSnapshot().diagnosis?.status, "textual_refusal_candidate");
		assert.equal(controller.newThread(), true);
		assert.equal(controller.getSnapshot().diagnosis, undefined);
	} finally { controller.dispose(); }
});

test("research consumes only well-formed diagnostic custom entries owned by this session", async () => {
	const { controller, bridge } = fresh();
	try {
		await controller.attach(); await controller.send("分析自己的源码");
		const append = (data: unknown): Record<string, unknown> => ({ type: "entry_appended", entry: { type: "custom", customType: "owl-research-diagnosis", data } });
		bridge.emit("ordinary-chat", append(diagnosis));
		bridge.emit("research-1", append({ ...diagnosis, ownerSessionId: "ordinary-chat" }));
		bridge.emit("research-1", append({ ...diagnosis, evidence: [{ source: "tool", text: { invented: true } }] }));
		bridge.emit("research-1", append({ ...diagnosis, status: "complete" }));
		assert.equal(controller.getSnapshot().diagnosis, undefined);
		bridge.emit("research-1", append(diagnosis));
		bridge.emit("research-1", { type: "agent_settled" });
		assert.deepEqual(controller.getSnapshot().diagnosis, diagnosis);
		assert.equal(controller.getSnapshot().entries.some((entry) => entry.kind === "assistant"), false);
	} finally { controller.dispose(); }
});

test("research clears the prior turn diagnosis when sending or starting another turn", async () => {
	const { controller, bridge } = fresh();
	try {
		await controller.attach(); await controller.send("第一轮");
		const append = { type: "entry_appended", entry: { type: "custom", customType: "owl-research-diagnosis", data: diagnosis } };
		bridge.emit("research-1", append); bridge.emit("research-1", { type: "agent_settled" });
		assert.ok(controller.getSnapshot().diagnosis);
		assert.equal(await controller.send("第二轮正常研究"), true);
		assert.equal(controller.getSnapshot().diagnosis, undefined);
		bridge.emit("research-1", append);
		bridge.emit("research-1", { type: "agent_start" });
		assert.equal(controller.getSnapshot().diagnosis, undefined);
		bridge.emit("research-1", { type: "entry_appended", entry: { type: "custom", customType: "owl-research-diagnosis", data: { ...diagnosis, status: "unverified" } } });
		bridge.emit("research-1", { type: "agent_settled" });
		assert.equal(controller.getSnapshot().diagnosis?.status, "unverified");
	} finally { controller.dispose(); }
});

test("reconnect keeps a diagnostic event newer than the atomic snapshot", async () => {
	const cancelled: ResearchDiagnosis = { ...diagnosis, id: "22222222-2222-4222-8222-222222222222", status: "cancelled", summary: "本轮已停止", evidence: [{ source: "provider", text: "Operation aborted", rawStopReason: "aborted" }] };
	const { controller, bridge, store } = fresh((request) => {
		if (request.type === "session.resume") {
			bridge.emit("research-1", { type: "entry_appended", entry: { type: "custom", customType: "owl-research-diagnosis", data: cancelled } });
			return { ok: true, result: { sessionId: "research-1", cwd: "D:/owl", researchMode: "auto", researchDiagnosis: diagnosis, messages: [], messageEntryIds: [] } };
		}
		return request.type === "session.running" ? { ok: true, result: { running: [] } } : { ok: true, result: stats };
	});
	try {
		store.setItem(researchSessionKey("D:/owl"), "research-1");
		await controller.attach();
		assert.deepEqual(controller.getSnapshot().diagnosis, cancelled);
	} finally { controller.dispose(); }
});

test("restoring plain refusal prose alone never creates a confirmed upstream refusal", async () => {
	const { controller, store } = fresh((request) => request.type === "session.resume" ? { ok: true, result: { sessionId: "research-1", cwd: "D:/owl", researchMode: "auto", messages: [{ role: "assistant", content: [{ type: "text", text: "我无法帮助提供该分析" }] }], messageEntryIds: [] } } : request.type === "session.running" ? { ok: true, result: { running: [] } } : { ok: true, result: stats });
	try {
		store.setItem(researchSessionKey("D:/owl"), "research-1");
		await controller.attach();
		assert.equal(controller.getSnapshot().diagnosis, undefined);
	} finally { controller.dispose(); }
});
