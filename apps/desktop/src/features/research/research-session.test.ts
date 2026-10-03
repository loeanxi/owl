import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopClientRequestWithoutId, ResearchResult, ServerEventMessage, SessionStatsResult } from "../../bridge/protocol.ts";
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

const defaults = { model: "fixture/model", thinkingLevel: "high", approvalMode: "confirm" as const, mode: "auto" as const };
const stats: SessionStatsResult = { model: { provider: "fixture", id: "model" }, thinkingLevel: "high", availableThinkingLevels: ["off", "high"], supportsThinking: true };
const published: ResearchResult = { id: "result-1", createdAt: "2026-10-04T00:00:00Z", mode: "crawl", status: "sample", title: "真实样本", summary: "来自工具输出", columns: [{ key: "name", label: "名称" }], rows: [{ name: "记录" }], sources: [{ id: "source-1", title: "Example", url: "https://example.org" }], findings: [{ kind: "fact", text: "发现记录", sourceIds: ["source-1"] }] };

function fresh(respond?: FakeBridge["respond"]): { bridge: FakeBridge; store: MemoryStorage; controller: ResearchSessionController } {
	const bridge = new FakeBridge(respond ?? ((request) => request.type === "session.create" ? { ok: true, result: { sessionId: "research-1" } } : request.type === "session.running" ? { ok: true, result: { running: [] } } : request.type === "session.stats" ? { ok: true, result: stats } : { ok: true }));
	const store = new MemoryStorage();
	const controller = new ResearchSessionController(bridge, store, "D:/owl", defaults);
	controller.start();
	controller.setConnected(true);
	return { bridge, store, controller };
}

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
		assert.equal(controller.newThread(), false);
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

test("restore preserves real model, running state, research direction and persisted evidence", async () => {
	const store = new MemoryStorage();
	store.setItem(researchSessionKey("D:/owl"), "research-1");
	const bridge = new FakeBridge((request) => request.type === "session.resume" ? { ok: true, result: { sessionId: "research-1", cwd: "d:\\OWL", researchMode: "crawl", approvalMode: "plan", messages: [{ role: "toolResult", toolName: "research_publish", details: { researchResult: published } }], messageEntryIds: [], header: {} } } : request.type === "session.running" ? { ok: true, result: { running: ["research-1"] } } : { ok: true, result: { ...stats, model: { provider: "restored", id: "actual" }, thinkingLevel: "off" } });
	const controller = new ResearchSessionController(bridge, store, "D:/owl", defaults);
	controller.start(); controller.setConnected(true);
	try {
		await controller.attach();
		assert.equal(controller.getSnapshot().model, "restored/actual");
		assert.equal(controller.getSnapshot().thinkingLevel, "off");
		assert.equal(controller.getSnapshot().mode, "crawl");
		assert.equal(controller.getSnapshot().approvalMode, "plan");
		assert.equal(controller.getSnapshot().running, true);
		assert.equal(controller.getSnapshot().results.length, 1);
		assert.equal(controller.newThread(), false);
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
		assert.equal(controller.getSnapshot().mode, "web");
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
		assert.equal(await controller.send("图片资料", images), false);
		assert.equal(controller.getSnapshot().entries.length, 0);
		assert.deepEqual(controller.getSnapshot().failedPrompt?.images, images);
		rejectPrompt = false;
		const failed = controller.getSnapshot().failedPrompt;
		assert.ok(failed);
		assert.equal(await controller.send(failed.text, failed.images), true);
		assert.equal(controller.getSnapshot().entries.length, 1);
		assert.deepEqual(bridge.requests.findLast((request) => request.type === "session.prompt")?.type === "session.prompt" && bridge.requests.findLast((request) => request.type === "session.prompt")?.images, images);
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
