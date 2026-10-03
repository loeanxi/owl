import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "../../node_modules/ws/wrapper.mjs";
import { buildHarness, output, repo } from "./build.mjs";

// Actual App, Composer, ChatStream and BridgeClient. Only this local server boundary is fake.
// No target model, credentials, user settings, existing sessions or external network are used.
const argument = process.argv.indexOf("--port");
const port = Number(argument >= 0 ? process.argv[argument + 1] : 19089);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use --port 1024..65535");
const host = "127.0.0.1";
const origin = `http://${host}:${port}`;
const evidence = await buildHarness();
const requests = [];
const emitted = [];
const sessions = new Map();
const running = new Set();
const pages = new Map();
const pendingQuestions = new Map();
const pendingPermissions = new Map();
const unsupported = new Set();
const modes = new Set(["auto", "crawl", "web", "model", "osint"]);
const settings = { theme: "dark", uiLanguage: "zh-CN", owlNotifications: { enabled: false }, plugins: [], owlWallpaper: { enabled: false } };
const model = { id: "offline", name: "隔离验证模型", contextWindow: 100000, maxTokens: 4000, reasoning: true, supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] };
const providers = [{ id: "local-fixture", name: "本地验证", authSource: "offline_fixture", models: [model] }];
const sourceData = [{ name: "OWL 本地样本 A", type: "文档", count: 3 }, { name: "OWL 本地样本 B", type: "目录", count: 2 }];
const sockets = new Set();
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2b8AAAAASUVORK5CYII=";

function send(ws, message) { if (ws.readyState === 1) ws.send(JSON.stringify(message)); }
function broadcast(message) {
  emitted.push(message);
  for (const ws of sockets) send(ws, message);
}
function event(sessionId, payload) { broadcast({ type: "event", sessionId, event: payload }); }
function response(ws, request, result, error) { send(ws, { type: "response", id: request.id, ok: !error, ...(error ? { error } : { result }) }); }
function snapshot(session) {
  return { sessionId: session.id, cwd: session.cwd, messages: session.messages, messageEntryIds: session.entryIds, thinkingLevel: session.thinkingLevel,
    header: { type: "session", id: session.id, cwd: session.cwd, timestamp: session.created }, ...(session.researchMode ? { researchMode: session.researchMode } : {}) };
}
function stats(session) {
  return { model: { provider: session.provider, id: session.model, name: model.name }, thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: model.supportedThinkingLevels, supportsThinking: true,
    contextUsage: { tokens: session.messages.length * 100, contextWindow: 100000, percent: session.messages.length / 10 },
    stats: { userMessages: session.messages.filter((message) => message.role === "user").length,
      assistantMessages: session.messages.filter((message) => message.role === "assistant").length,
      toolCalls: session.messages.filter((message) => message.role === "toolResult").length,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } };
}
function assistant(content, stopReason = "stop") {
  return { role: "assistant", content, api: "offline-fixture", provider: "local-fixture", model: "offline", stopReason,
    timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function append(session, message) {
  const entryId = randomUUID();
  session.messages.push(message); session.entryIds.push(entryId); session.modified = new Date().toISOString();
  return entryId;
}
async function step(session) {
  await new Promise((done) => setTimeout(done, session.slow ? 1800 : 250));
  if (session.cancelled) throw new Error("aborted");
}
function publishResult(session) {
  const mode = session.researchMode === "auto" ? "crawl" : session.researchMode;
  return { id: randomUUID(), createdAt: new Date().toISOString(), mode, status: "sample", title: "本地网页采集样本",
    summary: "已整理 2 条可核对的本地样本；这是隔离 UI 集成验证数据，没有调用大模型。",
    columns: [{ key: "name", label: "名称" }, { key: "type", label: "类型" }, { key: "count", label: "记录数" }], rows: sourceData,
    sources: [{ id: "local-source", title: "本地验证源页面", url: `${origin}/test-source`, note: "验证源，仅用于 UI/RPC 流程测试" }],
    findings: [{ kind: "fact", text: "本地源包含 2 条样本数据。", sourceIds: ["local-source"] },
      { kind: "unverified", text: "外部网站、真实模型和专用逆向工具未参与本验证。", sourceIds: [] }] };
}
async function completePrompt(session, request) {
  running.add(session.id); session.cancelled = false; session.slow = /慢速|slow/i.test(request.message);
  const user = { role: "user", content: [{ type: "text", text: request.message }, ...(request.images ?? [])], timestamp: Date.now() };
  const userId = append(session, user); const turn = [user];
  event(session.id, { type: "agent_start" });
  event(session.id, { type: "entry_appended", entry: { type: "message", id: userId, message: user } });
  try {
    await step(session);
    if (session.researchMode) {
      const result = publishResult(session);
      const { id, createdAt, ...input } = result;
      const callId = `publish-${randomUUID()}`;
      const introduction = "我先整理一份样本，并把来源与待确认的内容列出来。";
      const toolCall = { type: "toolCall", id: callId, name: "research_publish", arguments: input };
      const first = assistant([{ type: "text", text: introduction }, toolCall], "toolUse");
      event(session.id, { type: "message_start", message: assistant([]) });
      event(session.id, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: introduction } });
      event(session.id, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall } });
      event(session.id, { type: "message_end", message: first }); append(session, first); turn.push(first);
      event(session.id, { type: "tool_execution_start", toolCallId: callId, toolName: "research_publish", args: input });
      await step(session);
      const toolResult = { role: "toolResult", toolCallId: callId, toolName: "research_publish", content: [{ type: "text", text: "已发布本地研究样本。" }], details: { researchResult: result }, isError: false, timestamp: Date.now() };
      append(session, toolResult); turn.push(toolResult);
      event(session.id, { type: "tool_execution_end", toolCallId: callId, toolName: "research_publish", result: toolResult, isError: false });
      event(session.id, { type: "message_end", message: toolResult });
      await step(session);
    }
    const text = session.researchMode ? "样本已经整理好了。可以点结果卡查看数据和来源，也可以继续告诉我需要增加哪些字段。当前为隔离验证，未调用真实大模型。" : "这是普通聊天的隔离验证回复；它应留在普通聊天里，与研究会话分开。";
    const final = assistant([{ type: "text", text }]);
    event(session.id, { type: "message_start", message: assistant([]) });
    event(session.id, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
    event(session.id, { type: "message_end", message: final }); append(session, final); turn.push(final);
  } catch (error) {
    if (error.message !== "aborted") throw error;
    const stopped = { ...assistant([{ type: "text", text: "已停止本次验证任务。" }], "aborted"), errorMessage: "Operation aborted" };
    append(session, stopped); turn.push(stopped); event(session.id, { type: "message_end", message: stopped });
  } finally {
    event(session.id, { type: "agent_end", messages: turn });
    running.delete(session.id); event(session.id, { type: "agent_settled" });
  }
}

async function request(ws, value) {
  requests.push(value);
  const session = value.sessionId ? sessions.get(value.sessionId) : undefined;
  if (value.type.startsWith("session.") && !["session.create", "session.list", "session.running", "session.archiveConfig"].includes(value.type) && !session) {
    response(ws, value, undefined, "Unknown local validation session"); return;
  }
  switch (value.type) {
    case "models.list": response(ws, value, providers); return;
    case "settings.get": response(ws, value, { agentDir: "offline-validation", settings }); return;
    case "settings.set": Object.assign(settings, value.values); response(ws, value, { settings }); return;
    case "project.create": response(ws, value, { path: value.path }); return;
    case "commands.list": response(ws, value, { commands: [] }); return;
    case "session.running": response(ws, value, { running: [...running] }); return;
    case "session.list": response(ws, value, [...sessions.values()].map((item) => ({ id: item.id, cwd: item.cwd, created: item.created, modified: item.modified,
      name: item.researchMode ? "研究验证会话" : "普通聊天验证", messageCount: item.messages.length, firstMessage: item.messages.find((message) => message.role === "user")?.content[0]?.text,
      ...(item.researchMode ? { researchMode: item.researchMode } : {}) }))); return;
    case "session.archiveConfig": response(ws, value, { retentionDays: 30, sessions: [] }); return;
    case "session.create": {
      if (value.researchMode !== undefined && !modes.has(value.researchMode)) { response(ws, value, undefined, "Invalid research mode"); return; }
      const created = new Date().toISOString();
      const item = { id: randomUUID(), cwd: value.cwd ?? "D:/owl/Owl-def", messages: [], entryIds: [], created, modified: created,
        provider: value.provider ?? "local-fixture", model: value.model ?? "offline", thinkingLevel: value.thinkingLevel ?? "medium", approvalMode: value.approvalMode ?? "confirm",
        ...(value.researchMode ? { researchMode: value.researchMode } : {}) };
      sessions.set(item.id, item); response(ws, value, snapshot(item)); return;
    }
    case "session.resume": response(ws, value, snapshot(session)); return;
    case "session.stats": case "session.compact": response(ws, value, stats(session)); return;
    case "session.setModel": session.provider = value.provider; session.model = value.model; response(ws, value, stats(session)); return;
    case "session.setThinkingLevel": session.thinkingLevel = value.level; response(ws, value, stats(session)); return;
    case "session.setApprovalMode": session.approvalMode = value.approvalMode; response(ws, value, stats(session)); return;
    case "session.prompt":
      if (value.researchMode && !session.researchMode) { response(ws, value, undefined, "Ordinary conversation cannot become research"); return; }
      if (value.researchMode) session.researchMode = value.researchMode;
      response(ws, value, { accepted: true }); void completePrompt(session, value); return;
    case "session.abort": session.cancelled = true; running.delete(session.id); event(session.id, { type: "agent_settled" }); response(ws, value, {}); return;
    case "permission.response": pendingPermissions.delete(value.requestId); response(ws, value, {}); return;
    case "question.response": pendingQuestions.delete(value.requestId); response(ws, value, {}); return;
    case "evaluation.request":
      if (value.request.action === "bootstrap") response(ws, value, { tasks: [], models: [], runs: [], concurrency: 1 });
      else if (value.request.action === "run.list") response(ws, value, []);
      else response(ws, value, undefined, "Evaluation execution is outside this research UI fixture"); return;
    case "diffApproval.list": response(ws, value, { files: [] }); return;
    case "viewer.list": response(ws, value, { viewers: [] }); return;
    case "context.get": response(ws, value, { sessionId: value.sessionId, requests: [], events: [], tools: [] }); return;
    case "iab.state": response(ws, value, { pages: [...pages.values()] }); return;
    case "iab.open": {
      const page = pages.get(value.pageId) ?? { pageId: randomUUID(), sessionId: value.sessionId, url: value.url ?? `${origin}/test-source`, title: "本地浏览器验证", active: true, viewport: { width: 1280, height: 860 } };
      pages.set(page.pageId, page); response(ws, value, { page }); return;
    }
    case "iab.attach": response(ws, value, {}); setTimeout(() => send(ws, { type: "iab.frame", pageId: value.pageId, data: png, width: 1, height: 1 }), 50); return;
    case "iab.close": pages.delete(value.pageId); response(ws, value, {}); return;
    case "iab.detach": case "iab.viewport": case "iab.input": case "iab.nav": response(ws, value, {}); return;
    default: unsupported.add(value.type); response(ws, value, undefined, `Unsupported validation request: ${value.type}`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === "/test-state") { json({ fixture: true, paidCalls: 0, evidence, requests, emitted, unsupported: [...unsupported], running: [...running], sessions: [...sessions.values()], pendingQuestions: [...pendingQuestions.values()], pendingPermissions: [...pendingPermissions.values()] }); return; }
    if (url.pathname === "/test-action" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const action = JSON.parse(raw || "{}");
      if (action.action === "clear-requests") { requests.length = 0; emitted.length = 0; unsupported.clear(); json({ ok: true }); return; }
      const session = sessions.get(action.sessionId) ?? [...sessions.values()].findLast((item) => action.scope === "main" ? !item.researchMode : item.researchMode);
      if (!session) { json({ error: "Create the matching conversation first" }, 400); return; }
      if (action.action === "question") {
        const message = { type: "question_request", requestId: randomUUID(), sessionId: session.id, toolCallId: randomUUID(), questions: [{ header: "样本范围", question: "先看样本还是继续整理？", multiSelect: false, options: [{ label: "先看样本", description: "查看两条本地验证记录。" }, { label: "继续整理", description: "继续本地 UI 流程。" }] }] };
        pendingQuestions.set(message.requestId, message); broadcast(message); json({ ok: true, sessionId: session.id, requestId: message.requestId }); return;
      }
      if (action.action === "permission") {
        const message = { type: "permission_request", requestId: randomUUID(), sessionId: session.id, toolName: "research_publish", input: { title: "本地工具审批验证" } };
        pendingPermissions.set(message.requestId, message); broadcast(message); json({ ok: true, sessionId: session.id, requestId: message.requestId }); return;
      }
      if (action.action === "iab") {
        const page = { pageId: randomUUID(), sessionId: session.id, url: `${origin}/test-source`, title: `${session.researchMode ? "研究" : "普通聊天"}浏览器验证`, viewport: { width: 1280, height: 860 }, active: true };
        pages.set(page.pageId, page); broadcast({ type: "iab.pages", pages: [...pages.values()], origin: "agent", originSessionId: session.id }); json({ ok: true, page }); return;
      }
      json({ error: "Use question, permission, iab or clear-requests" }, 400); return;
    }
    if (url.pathname === "/test-source") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本地验证源页面</title><h1>本地网页采集样本</h1><p>只用于 OWL 研究页面的隔离验证。</p><table><tr><th>名称</th><th>类型</th><th>记录数</th></tr>' + sourceData.map((row) => `<tr><td>${row.name}</td><td>${row.type}</td><td>${row.count}</td></tr>`).join("") + "</table></html>"); return;
    }
    const known = { "/": [join(output, "index.html"), "text/html"], "/app.js": [join(output, "app.js"), "text/javascript"], "/app.css": [join(output, "app.css"), "text/css"], "/owl.svg": [join(repo, "apps/desktop/public/owl.svg"), "image/svg+xml"] };
    const asset = known[url.pathname] ?? (url.pathname === "/index.html" ? known["/"] : undefined);
    if (!asset) { json({ error: "Unknown local fixture resource" }, 404); return; }
    res.writeHead(200, { "content-type": `${asset[1]}; charset=utf-8`, "cache-control": "no-store" }); res.end(await readFile(asset[0]));
  } catch (error) { json({ error: error.message }, 500); }
});
const ws = new WebSocketServer({ server, path: "/ws" });
ws.on("connection", (socket) => {
  sockets.add(socket); socket.on("close", () => sockets.delete(socket));
  socket.on("message", (raw) => { const value = JSON.parse(String(raw)); void request(socket, value).catch((error) => response(socket, value, undefined, error.message)); });
});
server.listen(port, host, () => console.log(`Research UI validation: ${origin}\nActual App + offline bridge. /test-state captures requests. No paid calls.`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { for (const socket of sockets) socket.close(); ws.close(); server.close(() => process.exit(0)); });
