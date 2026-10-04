import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import pw from "playwright-core";
import { createServer as createViteServer } from "vite";
import { WebSocket } from "ws";

// Real App, desktop WebSocket, EvaluationService and store. Only model/check boundaries
// are offline fixtures. Never reads user auth, calls paid models, or restarts user services.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktop = join(repo, "apps/desktop");
const output = resolve(process.argv[2] ?? join(repo, ".validation/model-evaluation-mini-chat"));
await mkdir(output, { recursive: true });
const browserPath = [process.env.OWL_BROWSER_TEST_EXECUTABLE, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium"].find((path) => path && existsSync(path));
assert.ok(browserPath, "An installed Chromium browser is required; no browser downloads.");
const temporary = await mkdtemp(join(tmpdir(), "owl-evaluation-mini-chat-"));
assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
assert.ok(basename(temporary).startsWith("owl-evaluation-mini-chat-"));
const agentDir = join(temporary, "agent");
const cwd = join(temporary, "workspace");
await mkdir(agentDir);
await mkdir(cwd);
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ plugins: [], theme: "dark", uiLanguage: "zh-CN", cacheWarming: { mode: "off" }, owlNotifications: { enabled: false } }));
const previousEnvironment = Object.fromEntries(["OWL_CODING_AGENT_DIR", "PI_OFFLINE", "PI_RE_BRIDGE"].map((key) => [key, process.env[key]]));
for (const key of Object.keys(process.env)) {
  if (!/(?:API_KEY|TOKEN|SECRET|OPENAI|ANTHROPIC|AWS_|GOOGLE_|GEMINI|AZURE_|COPILOT)/i.test(key)) continue;
  previousEnvironment[key] = process.env[key];
  delete process.env[key];
}
process.env.OWL_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const loader = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-ai/compat": join(repo, "packages/ai/src/compat.ts"),
  "@earendil-works/pi-ai/oauth": join(repo, "packages/ai/src/oauth.ts"),
  "@earendil-works/pi-ai/bedrock-provider": join(repo, "packages/ai/src/bedrock-provider.ts"),
  "@earendil-works/pi-ai/bun-oauth": join(repo, "packages/ai/src/bun-oauth.ts"),
  "@earendil-works/pi-ai/providers/all": join(repo, "packages/ai/src/providers/all.ts"),
  "@earendil-works/pi-ai/providers/radius-config": join(repo, "packages/ai/src/providers/radius-config.ts"),
  "@earendil-works/pi-ai/utils/model-operations": join(repo, "packages/ai/src/utils/model-operations.ts"),
  "@earendil-works/pi-ai/utils/provider-env": join(repo, "packages/ai/src/utils/provider-env.ts"),
  "@earendil-works/pi-ai": join(repo, "packages/ai/src/index.ts"),
  "@earendil-works/pi-agent-core": join(repo, "packages/agent/src/index.ts"),
  "@earendil-works/pi-codemode/declarations": join(repo, "packages/codemode/src/declarations.ts"),
  "@earendil-works/pi-codemode/source": join(repo, "packages/codemode/src/source.ts"),
  "@earendil-works/pi-codemode": join(repo, "packages/codemode/src/index.ts"),
} });
const report = { success: false, actualApp: true, actualDesktopWebSocket: true, actualEvaluationService: true, manualStageGates: true, fakeModelAndChecks: true, paidCalls: 0, cases: [], errors: [], requests: [], modelCalls: [], screenshots: [], sourceSha256: {} };
for (const path of ["apps/desktop/src/features/evaluation/EvaluationResults.tsx", "apps/desktop/src/features/evaluation/EvaluationResultCard.tsx", "apps/desktop/src/features/evaluation/EvaluationElapsed.tsx", "apps/desktop/src/features/evaluation/useEvaluation.ts", "packages/coding-agent/src/core/evaluation/service.ts"])
  if (existsSync(join(repo, path))) report.sourceSha256[path] = createHash("sha256").update(await readFile(join(repo, path))).digest("hex");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><rect width="400" height="260" fill="#d0efff"/><g><circle cx="110" cy="190" r="45" fill="none" stroke="#263a32" stroke-width="4"/><circle cx="280" cy="190" r="45" fill="none" stroke="#263a32" stroke-width="4"/><path d="M110 190 160 110 210 190 110 190M210 190 260 100 280 190" fill="none" stroke="#e45555" stroke-width="6"/><ellipse cx="170" cy="90" rx="46" ry="23" fill="white"/><path d="M200 90Q220 24 247 43L300 55 247 67" fill="white" stroke="#263a32"/><circle cx="244" cy="45" r="3" fill="#263a32"/><path d="m248 48 52 7-51 11" fill="#e6ae60"/><animateTransform attributeName="transform" type="translate" values="0 0;2 0;0 0" dur="4s" repeatCount="indefinite"/></g></svg>';
const originalBody = `我会先建立车架和轮子，再让脚蹬围绕曲柄转动。\n\n**首次回答的作品**\n\n\`\`\`svg\n${svg}\n\`\`\``;
const originalThinking = "先确认轮轴、曲柄和脚的位置关系，再生成 SVG 动画。";
const pendingOriginals = [];
const pendingFollowups = [];
let autoOriginals = false;
let failNextOriginal = false;
let bridge, vite, browser, page, rpcSocket, runId, startDesktopServer;
const models = ["alpha", "beta"].map((modelId) => ({ provider: "offline-mini-chat", modelId, name: `Offline ${modelId}`, sourceName: "Offline fixture", supportedThinkingLevels: ["default"], contextWindow: 1000000, maxTokens: 4096, pricing: null }));
const forbiddenFetch = async () => { throw new Error("Remote calls are forbidden in mini-chat validation"); };
function finishedResponse(request, text, thinking = originalThinking, error = null) {
  return { text, thinking, stopReason: error ? "error" : "stop", error, usage: null, costUsd: null, actualModel: { provider: request.profile.provider, modelId: request.profile.modelId, responseModel: null, forwardedThinkingLevel: null, providerThinkingLevel: null } };
}
const options = {
  port: 0, host: "127.0.0.1", agentDir, cwd, mcpServers: {}, onDiagnostic: () => {},
  news: { fetch: forbiddenFetch, listModels: () => [], callModel: forbiddenFetch, resolveModel: forbiddenFetch },
  evaluation: {
    timeoutMs: 120000,
    listModels: async () => structuredClone(models),
    invoke: async (request) => {
      report.modelCalls.push({ taskId: request.task.id, modelId: request.profile.modelId, conversation: request.conversation ? structuredClone(request.conversation) : null });
      if (!request.conversation && autoOriginals) {
        const failure = failNextOriginal;
        failNextOriginal = false;
        if (failure) { await new Promise((done) => setTimeout(done, 1250)); request.signal.throwIfAborted(); }
        request.onPartial(failure ? "已收到部分正文，但这次生成失败。" : originalBody, originalThinking);
        return finishedResponse(request, failure ? "已收到部分正文，但这次生成失败。" : originalBody, originalThinking, failure ? "Offline intentional provider failure" : null);
      }
      return new Promise((done, reject) => {
        const pending = { request, finish: (body, thinking) => done(finishedResponse(request, body, thinking)), publish: (body, thinking) => request.onPartial(body, thinking) };
        (request.conversation ? pendingFollowups : pendingOriginals).push(pending);
        request.signal.addEventListener("abort", () => reject(request.signal.reason ?? new Error("Cancelled fixture")), { once: true });
      });
    },
    check: async (task, text) => {
      const content = text.match(/<svg[\s\S]*<\/svg>/)?.[0];
      return { artifact: content ? { type: "svg", content, previewAllowed: true } : null, checks: [{ id: "offline-first-answer", label: "隔离检查", status: content ? "passed" : "unchecked", detail: "仅用于验收真实 UI 和 RPC，不评价模型质量。" }] };
    },
  },
};
const area = () => page.locator(".owl-eval:visible");
const cards = () => area().locator(".eval-result-card");
const card = (index) => cards().nth(index);
const stream = (index) => card(index).locator(".eval-messages");
const composer = (index) => card(index).locator(".eval-composer textarea");
const replyTimer = (index, replyId) => card(index).locator(`.eval-assistant-message[data-message-id="${replyId}"] .eval-reply-elapsed`);
const entry = () => page.locator('[data-fd-id="model-evaluation-entry"]');
async function connectRpc() {
  rpcSocket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
  await new Promise((done, reject) => { rpcSocket.once("open", done); rpcSocket.once("error", reject); });
}
async function rpc(request) {
  const id = randomUUID();
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { rpcSocket.off("message", receive); reject(new Error(`RPC timed out: ${request.action}`)); }, 5000);
    const receive = (raw) => { const value = JSON.parse(String(raw)); if (value.id !== id) return; clearTimeout(timer); rpcSocket.off("message", receive); if (!value.ok) reject(new Error(value.error)); else done(value.result); };
    rpcSocket.on("message", receive);
    rpcSocket.send(JSON.stringify({ type: "evaluation.request", id, request }));
  });
}
async function until(operation, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await operation(); if (value) return value; await page.waitForTimeout(50); }
  throw new Error(message);
}
async function snapshot() { return await rpc({ action: "run.get", runId }); }
async function check(name, operation) {
  const item = { name, success: false }; report.cases.push(item);
  try { Object.assign(item, await operation()); item.success = true; console.log(`PASS ${name}`); }
  catch (error) { item.failure = error.message; console.error(`FAIL ${name}: ${error.message}`); throw error; }
}
async function screenshot(name) { await page.screenshot({ path: join(output, name) }); report.screenshots.push(name); }
async function scrollState(index) { return await stream(index).evaluate((element) => ({ top: element.scrollTop, gap: element.scrollHeight - element.scrollTop - element.clientHeight, height: element.clientHeight })); }
function longText(marker, count) { return `${marker}\n\n${Array.from({ length: count }, (_, index) => `段落 ${index + 1}：这是真实页面里的离线流式验收文字，用来检查独立阅读位置。`).join("\n\n")}`; }
function originalSnapshot(value) {
  const { followups, ...original } = value;
  return original;
}
async function closeDrawer() { await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click(); }
async function expandThinking(details) { if ((await details.getAttribute("open")) === null) await details.locator("summary").click(); }
async function timerSnapshot(timer) {
  await timer.waitFor();
  return await timer.evaluate((element) => ({ ms: element.dataset.elapsedMs === undefined ? null : Number(element.dataset.elapsedMs), state: element.dataset.elapsedState, text: element.textContent.trim() }));
}
async function frozenTimer(timer, expectedMs) {
  const before = await until(async () => { const value = await timerSnapshot(timer); return value.state === "finished" ? value : null; }, "Terminal elapsed state must be finished");
  assert.equal(before.ms, Math.floor(expectedMs)); assert.match(before.text, /^耗时 (?:\d+:)?\d{2}:\d{2}$/);
  await page.waitForTimeout(1150);
  assert.deepEqual(await timerSnapshot(timer), before, "A terminal timer must stop advancing");
  return before;
}
async function historyRun(name) {
  await area().locator(".eval-main-head").getByRole("button", { name: "刷新", exact: true }).click();
  await area().locator(".eval-nav").getByRole("button", { name: /运行记录/ }).click();
  const row = area().locator("tr").filter({ hasText: name }); await row.waitFor(); await row.getByRole("button").first().click();
  await card(0).waitFor();
}
async function availablePort() {
  const server = createNetServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}
try {
  ({ startDesktopServer } = await loader.import(join(repo, "packages/coding-agent/src/modes/desktop/serve.ts")));
  bridge = await startDesktopServer(options);
  process.env.PI_RE_BRIDGE = `ws://127.0.0.1:${bridge.port}`;
  vite = await createViteServer({ root: desktop, configFile: join(desktop, "vite.config.ts"), server: { host: "127.0.0.1", port: await availablePort(), strictPort: true } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0]; report.origin = origin; report.bridgePort = bridge.port;
  await connectRpc();
  browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => report.errors.push(error.stack ?? error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => { try { const value = JSON.parse(String(payload)); if (value.type === "evaluation.request") report.requests.push(value); } catch {} }));
  await page.route("**/*", (route) => { const url = new URL(route.request().url()); if (url.origin === new URL(origin).origin) return route.continue(); report.errors.push(`Blocked external request: ${url.origin}`); return route.abort(); });
  await page.addInitScript(({ workspace }) => { if (window !== window.top) return; localStorage.setItem("owl.workspaceDir", workspace); localStorage.setItem("owl.uiLanguage", "zh-CN"); localStorage.setItem("owl.sidebar.minimized", "0"); localStorage.setItem("owl.workbench.open", "0"); }, { workspace: cwd });
  await page.goto(origin);
  await entry().click({ timeout: 30000 });
  await area().getByText("开始你的第一次模型测评", { exact: true }).waitFor();
  await area().locator(".eval-main-head").getByRole("button", { name: "新建测评", exact: true }).click();
  await area().getByRole("button", { name: "清空选择", exact: true }).click();
  await area().locator("#eval-select-G08").check();
  for (const model of models) await area().locator(".eval-model-choice").filter({ hasText: model.name }).getByText("默认", { exact: true }).click();
  await area().getByRole("textbox", { name: "测评名称", exact: true }).fill("Mini-chat isolated fixture");
  await area().getByRole("button", { name: "开始测评", exact: true }).click();
  await until(() => pendingOriginals.length === 2, "Both fake original calls must start");
  runId = (await rpc({ action: "run.list" }))[0].id;
  await card(1).waitFor();
  await check("each anonymous model has its own original prompt, stream and composer", async () => {
    const run = await snapshot(); assert.equal(run.status, "running"); assert.equal(run.results.length, 2);
    for (let index = 0; index < 2; index++) {
      assert.ok((await card(index).locator(".eval-user-bubble").textContent()).includes(run.tasks[0].prompt));
      assert.equal(await stream(index).count(), 1); assert.equal(await composer(index).isDisabled(), true);
    }
    for (const value of run.results) for (const field of ["profile", "profileId", "usage", "costUsd", "durationMs", "actualModel"]) assert.equal(Object.hasOwn(value, field), false, `Anonymous wire leaked ${field}`);
    for (const model of models) assert.equal(await cards().filter({ hasText: model.name }).count(), 0);
    await screenshot("01-independent-waiting.png");
  });
  await check("queued requests show queue status without a fabricated runtime", async () => {
    const queued = await rpc({ action: "run.start", name: "Elapsed queued fixture", taskIds: ["G08"], profiles: [{ id: "queued-profile", provider: models[0].provider, modelId: models[0].modelId, thinkingLevel: "default" }], samples: 1 });
    assert.equal(queued.results[0].status, "queued"); assert.equal(queued.results[0].elapsedMs, null);
    await historyRun("Elapsed queued fixture");
    const timer = await timerSnapshot(replyTimer(0, queued.results[0].id)); assert.equal(timer.state, "queued"); assert.equal(timer.ms, null); assert.match(timer.text, /排队|待运行/); assert.doesNotMatch(timer.text, /\d{2}:\d{2}/);
    await screenshot("11-queued-no-runtime.png");
    await rpc({ action: "run.cancel", runId: queued.id });
    await historyRun("Mini-chat isolated fixture");
    assert.equal(await cards().count(), 2); assert.equal(pendingOriginals.length, 2);
    return { queuedTimer: timer };
  });
  await check("provider thinking and Markdown reply appear while the original run is unfinished", async () => {
    for (const pending of pendingOriginals) pending.publish("", originalThinking);
    for (let index = 0; index < 2; index++) await card(index).locator(".eval-thinking-body").filter({ hasText: originalThinking }).waitFor({ state: "attached" });
    await check("anonymous thinking timers advance without revealing identity or usage", async () => {
      const run = await snapshot(); const ids = await cards().evaluateAll((elements) => elements.map((element) => element.dataset.resultId));
      assert.ok(run.results.every((value) => value.generationPhase === "thinking" && value.output === "" && typeof value.elapsedMs === "number"));
      const before = await Promise.all(ids.map((id, index) => timerSnapshot(replyTimer(index, id))));
      await page.waitForTimeout(1250);
      const after = await Promise.all(ids.map((id, index) => timerSnapshot(replyTimer(index, id))));
      for (const [index, value] of after.entries()) { assert.equal(value.state, "running"); assert.ok(value.ms >= before[index].ms + 800); assert.match(value.text, /^已运行 (?:\d+:)?\d{2}:\d{2}$/); }
      for (const value of (await snapshot()).results) for (const field of ["profile", "profileId", "usage", "costUsd", "durationMs", "actualModel"]) assert.equal(Object.hasOwn(value, field), false);
      await screenshot("12-anonymous-thinking-runtime.png"); return { before, after };
    });
    const growingThinking = `${longText("第一批模型思考", 70)}\n\n思考最新尾段`;
    const thinkingTailGeometry = [];
    for (const pending of pendingOriginals) pending.publish("", growingThinking);
    for (let index = 0; index < 2; index++) {
      await card(index).locator(".eval-thinking-body").filter({ hasText: "思考最新尾段" }).waitFor({ state: "attached" });
      await expandThinking(card(index).locator(".eval-thinking").first());
      const thought = card(index).locator(".eval-thinking-body");
      const geometry = await until(async () => {
        const value = await thought.evaluate((element) => {
          const node = element.lastChild; if (!node?.textContent) return null;
          const range = document.createRange(); range.setStart(node, Math.max(0, node.textContent.length - 8)); range.setEnd(node, node.textContent.length);
          const tail = range.getBoundingClientRect(); const viewport = element.closest(".eval-messages").getBoundingClientRect();
          return { top: tail.top, bottom: tail.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom, height: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY };
        });
        return value && value.top >= value.viewportTop - 1 && value.bottom <= value.viewportBottom + 1 ? value : null;
      }, "The latest thinking tail must be inside its conversation viewport");
      assert.ok(Math.abs(geometry.height - geometry.scrollHeight) <= 2, `Thinking has a second vertical scroll region: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.overflowY, "visible");
      thinkingTailGeometry.push(geometry);
    }
    await screenshot("02a-visible-thinking-tail.png");
    const body = `**正在逐段回答**\n\n${longText("第一批正文", 45)}`;
    for (const pending of pendingOriginals) pending.publish(body, originalThinking);
    for (let index = 0; index < 2; index++) await card(index).locator(".eval-chat-answer strong").filter({ hasText: "正在逐段回答" }).waitFor();
    assert.equal((await snapshot()).status, "running");
    assert.equal(await cards().locator("iframe").count(), 0, "An unfinished response must not claim to have a final artifact");
    await screenshot("02-thinking-and-answer.png");
    return { thinkingTailGeometry };
  });
  await check("one reader can pause scrolling without affecting the other conversation", async () => {
    await stream(0).evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
    const top = (await scrollState(0)).top;
    for (const pending of pendingOriginals) pending.publish(`${longText("第一批正文", 45)}\n\n${longText("第二批新正文", 30)}`, originalThinking);
    for (let index = 0; index < 2; index++) await card(index).locator(".eval-chat-answer").filter({ hasText: "第二批新正文" }).waitFor();
    assert.ok(Math.abs((await scrollState(0)).top - top) <= 2); assert.ok((await scrollState(1)).gap <= 3);
    await page.locator(".owl-activity-rail").getByRole("button", { name: "聊天", exact: true }).click();
    await entry().click();
    assert.ok((await scrollState(0)).top <= 2);
    await screenshot("03-independent-scroll.png");
  });
  let initialSnapshot;
  await check("completed inline artifacts and drawers grade only the first answer", async () => {
    autoOriginals = true;
    for (const pending of pendingOriginals) pending.finish(originalBody, originalThinking);
    await until(async () => (await snapshot()).status === "completed", "Original run must complete");
    await cards().locator("iframe").first().waitFor();
    await check("completed anonymous timers freeze at their own server runtime", async () => {
      const run = await snapshot(); const timers = [];
      for (let index = 0; index < 2; index++) { const id = await card(index).getAttribute("data-result-id"); const value = run.results.find((item) => item.id === id); timers.push(await frozenTimer(replyTimer(index, id), value.elapsedMs)); }
      assert.ok(run.results.every((value) => !value.revealed && !Object.hasOwn(value, "usage")));
      await screenshot("13-completed-runtime-frozen.png"); return { timers };
    });
    for (let index = 0; index < 2; index++) {
      assert.equal(await composer(index).isDisabled(), false);
      await card(index).locator('[data-action="checks"]').click();
      await page.getByRole("dialog").locator(".eval-check-item").filter({ hasText: "隔离检查" }).waitFor();
      await closeDrawer();
      await card(index).locator('[data-action="rating"]').click();
      const dialog = page.getByRole("dialog");
      for (const [criterion, group] of (await dialog.locator(".eval-rating").all()).entries()) await group.getByRole("button", { name: `${[5, 3, 4][criterion]} 分`, exact: true }).click();
      await dialog.locator(".eval-score-note").fill(`首次回答 ${index} 的评价`);
      await closeDrawer();
    }
    await area().getByRole("button", { name: "提交评分并揭晓", exact: true }).click();
    await cards().filter({ hasText: "Offline alpha" }).waitFor();
    initialSnapshot = await snapshot();
    assert.ok(initialSnapshot.results.every((value) => value.revealed && value.usage === null && value.costUsd === null && Object.keys(value.rating.scores).length === 3));
    for (let index = 0; index < 2; index++) await stream(index).evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
    await screenshot("04-final-mini-conversations.png");
    const geometry = await page.frameLocator(".owl-eval .eval-result-card iframe").first().locator("svg").evaluate((element) => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight }; });
    assert.ok(geometry.x >= -1 && geometry.y >= -1 && geometry.right <= geometry.width + 1 && geometry.bottom <= geometry.height + 1);
    return { previewGeometry: geometry };
  });
  let aId, bId, firstFollowupOutput;
  await check("A sends a real follow-up request, streams in its chat, and leaves B unchanged", async () => {
    aId = await card(0).getAttribute("data-result-id"); bId = await card(1).getAttribute("data-result-id");
    const before = await snapshot(); const a = before.results.find((value) => value.id === aId); const b = before.results.find((value) => value.id === bId);
    const prompt = "只解释脚蹬如何绕曲柄转动。";
    await composer(0).fill(prompt); await card(0).locator('[data-action="send-followup"]').click();
    await until(() => pendingFollowups.length === 1, "A follow-up must reach actual service invoker");
    const pending = pendingFollowups[0];
    assert.equal(pending.request.profile.modelId, a.profile.modelId); assert.equal(pending.request.conversation.prompt, prompt); assert.equal(pending.request.conversation.originalAnswer, a.output); assert.deepEqual(pending.request.conversation.turns, []);
    pending.publish("", "追问思考：解释圆周运动。");
    await card(0).locator(".eval-thinking-body").filter({ hasText: "追问思考：解释圆周运动。" }).waitFor({ state: "attached" });
    await expandThinking(card(0).locator(".eval-thinking").last());
    await card(0).locator(".eval-thinking-body").filter({ hasText: "追问思考：解释圆周运动。" }).waitFor();
    await check("a follow-up has its own advancing clock while the first answer stays frozen", async () => {
      const run = await snapshot(); const followup = run.results.find((item) => item.id === aId).followups[0];
      const first = await timerSnapshot(replyTimer(0, aId)); const before = await timerSnapshot(replyTimer(0, followup.id));
      assert.equal(before.state, "running"); assert.ok(before.ms < first.ms);
      await page.waitForTimeout(1250); const after = await timerSnapshot(replyTimer(0, followup.id)); assert.ok(after.ms >= before.ms + 800);
      assert.deepEqual(await timerSnapshot(replyTimer(0, aId)), first); assert.equal((await snapshot()).status, "completed");
      await screenshot("14-independent-followup-runtime.png"); return { original: first, before, after };
    });
    pending.publish("追问第一段：脚蹬沿圆周运动。", "追问思考：解释圆周运动。");
    await card(0).locator(".eval-chat-answer").filter({ hasText: "追问第一段" }).waitFor();
    const during = await snapshot(); assert.equal(during.status, "completed"); assert.deepEqual(during.results.find((value) => value.id === bId), b);
    assert.ok(report.requests.some((value) => value.request.action === "conversation.send" && value.request.resultId === aId && value.request.prompt === prompt));
    firstFollowupOutput = "**脚蹬运动**：曲柄中心固定，脚蹬绕中心转动。";
    pending.finish(firstFollowupOutput, "追问思考：解释圆周运动。");
    await until(async () => (await snapshot()).results.find((value) => value.id === aId).followups[0].status === "completed", "First follow-up must finish");
    await card(0).locator(".eval-chat-answer strong").filter({ hasText: "脚蹬运动" }).waitFor();
    await screenshot("05-followup-a-only.png");
  });
  await check("follow-up cancellation retains text and the next request forwards completed history only", async () => {
    await composer(0).fill("第二次追问，稍后取消。 "); await card(0).locator('[data-action="send-followup"]').click();
    await until(() => pendingFollowups.length === 2, "Second follow-up must start");
    const pending = pendingFollowups[1];
    assert.deepEqual(pending.request.conversation.turns, [{ prompt: "只解释脚蹬如何绕曲柄转动。", output: firstFollowupOutput }]);
    pending.publish("取消前已经收到的内容。", "取消前的思考。");
    await card(0).locator(".eval-chat-answer").filter({ hasText: "取消前已经收到的内容。" }).waitFor();
    await card(0).locator('[data-action="cancel-followup"]').click();
    await until(async () => (await snapshot()).results.find((value) => value.id === aId).followups[1].status === "cancelled", "Only current follow-up must cancel");
    await card(0).locator(".eval-chat-status").filter({ hasText: "已取消" }).waitFor();
    assert.equal(pending.request.signal.aborted, true);
    await check("cancelled follow-up timers freeze without changing the original rating", async () => {
      const run = await snapshot(); const value = run.results.find((item) => item.id === aId); const cancelled = value.followups[1];
      const timer = await frozenTimer(replyTimer(0, cancelled.id), cancelled.elapsedMs);
      assert.deepEqual(originalSnapshot(value), originalSnapshot(initialSnapshot.results.find((item) => item.id === aId)));
      await screenshot("15-cancelled-runtime-frozen.png"); return { timer };
    });
    pending.publish("迟到内容不应出现", "迟到思考");
    const cancelled = (await snapshot()).results.find((value) => value.id === aId).followups[1]; assert.equal(cancelled.output, "取消前已经收到的内容。");
    assert.equal(await card(0).getByText("迟到内容不应出现").count(), 0);
    await composer(0).fill("第三次追问，接着第一次完成的回答。 "); await card(0).locator('[data-action="send-followup"]').click();
    await until(() => pendingFollowups.length === 3, "Third follow-up must start");
    assert.deepEqual(pendingFollowups[2].request.conversation.turns, [{ prompt: "只解释脚蹬如何绕曲柄转动。", output: firstFollowupOutput }]);
    pendingFollowups[2].finish("第三次追问完成。", "第三次追问思考。");
    await until(async () => (await snapshot()).results.find((value) => value.id === aId).followups[2].status === "completed", "Third follow-up must finish");
    const after = await snapshot(); assert.deepEqual(after.results.map(originalSnapshot), initialSnapshot.results.map(originalSnapshot));
    await screenshot("06-cancelled-and-completed-followups.png");
  });
  await check("sample and chat navigation preserve the unsent message and first-answer summary", async () => {
    const draft = "这是一段尚未发送的 A 独立草稿。"; await composer(0).fill(draft);
    await stream(0).evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
    await area().getByRole("button", { name: "追加到 3 次", exact: true }).click();
    await until(async () => (await snapshot()).status === "completed" && (await snapshot()).results.length === 6, "Three samples must finish");
    const samples = area().getByRole("combobox", { name: "每题运行次数", exact: true }); await samples.selectOption("2"); assert.equal(await composer(0).inputValue(), ""); await samples.selectOption("1");
    assert.equal(await composer(0).inputValue(), draft);
    assert.ok((await scrollState(0)).top <= 2);
    await page.locator(".owl-activity-rail").getByRole("button", { name: "聊天", exact: true }).click(); await entry().click(); assert.equal(await composer(0).inputValue(), draft);
    await area().getByRole("button", { name: "测评汇总", exact: true }).click();
    await area().locator(".eval-criterion-stat").first().waitFor();
    const means = await area().locator(".eval-criterion-mean").allTextContents(); assert.deepEqual(means.map((text) => text.trim()), ["5.00 / 5", "3.00 / 5", "4.00 / 5", "5.00 / 5", "3.00 / 5", "4.00 / 5"]);
    assert.equal(await area().getByText("人工评价均分", { exact: true }).count(), 0);
    await screenshot("07-first-answer-summary.png");
    await area().getByRole("button", { name: "结果对比", exact: true }).click();
    assert.equal(await composer(0).inputValue(), draft);
    await area().locator(".eval-nav").getByRole("button", { name: /题库/ }).click();
    await area().locator(".eval-library-row").first().waitFor();
    await area().locator(".eval-nav").getByRole("button", { name: "测评", exact: true }).click();
    assert.equal(await composer(0).inputValue(), draft);
    assert.ok((await scrollState(0)).top <= 2);
  });
  await check("a failed attempt keeps its partial answer and retry appends a separate attempt", async () => {
    const before = await snapshot(); const source = before.groups.find((value) => value.sample === 3).resultIds[0]; failNextOriginal = true;
    await rpc({ action: "run.retry", runId, resultId: source });
    await until(async () => (await snapshot()).results.some((value) => value.status === "failed"), "Intentional fake failure must be retained");
    await area().locator(".eval-main-head").getByRole("button", { name: "刷新", exact: true }).click();
    await area().getByRole("combobox", { name: "每题运行次数", exact: true }).selectOption("3");
    const failed = (await snapshot()).results.find((value) => value.status === "failed");
    const retry = area().getByRole("button", { name: "重试此结果", exact: true });
    if (!(await retry.isVisible())) await area().locator(".eval-attempt-bar select").filter({ has: page.locator(`option[value="${failed.id}"]`) }).selectOption(failed.id);
    await retry.waitFor(); assert.equal(await cards().filter({ hasText: "已收到部分正文，但这次生成失败。" }).count(), 1);
    await retry.click(); await until(async () => (await snapshot()).status === "completed" && (await snapshot()).results.length === 8, "Retry must append and finish");
    const after = await snapshot(); assert.equal(after.results.find((value) => value.id === failed.id).status, "failed"); assert.equal(after.results.filter((value) => value.retryOf === failed.id).length, 1);
    await check("switching retained attempts selects the runtime of that exact answer", async () => {
      const success = after.results.find((value) => value.retryOf === failed.id); const original = after.results.find((value) => value.id === source);
      assert.ok(failed.elapsedMs >= 1000, "Intentional failure fixture should have a distinguishable runtime");
      const picker = area().locator(".eval-attempt-bar select").filter({ has: page.locator(`option[value="${failed.id}"]`) }); const selected = [];
      for (const value of [original, failed, success]) { await picker.selectOption(value.id); const active = cards().filter({ has: page.locator(`.eval-assistant-message[data-message-id="${value.id}"][data-benchmark-answer]`) }); const timer = await timerSnapshot(active.locator(".eval-reply-elapsed")); assert.equal(timer.state, "finished"); assert.equal(timer.ms, value.elapsedMs); selected.push({ id: value.id, runtime: timer }); }
      assert.notEqual(selected[0].runtime.ms, selected[1].runtime.ms); await screenshot("16-corresponding-attempt-runtime.png"); return { selected };
    });
    await screenshot("08-retained-retry-attempts.png");
  });
  await check("at 1280 by 860 both mini-chat composers stay inside the visible viewport", async () => {
    await area().getByRole("combobox", { name: "每题运行次数", exact: true }).selectOption("1");
    const geometry = await cards().locator(".eval-composer").evaluateAll((elements) => elements.map((element) => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height, viewport: innerHeight }; }));
    assert.equal(geometry.length, 2); for (const item of geometry) { assert.ok(item.top > 0 && item.bottom <= item.viewport && item.height > 45, `Composer clipped: ${JSON.stringify(item)}`); }
    await screenshot("09-1280-composers.png"); return { composerGeometry: geometry };
  });
  await check("isolated server restart restores followups, original scores, samples and attempt order", async () => {
    const before = await snapshot(); const port = bridge.port; rpcSocket.terminate(); rpcSocket = undefined; await bridge.close(); bridge = undefined;
    bridge = await startDesktopServer({ ...options, port }); await connectRpc();
    const after = await snapshot(); assert.deepEqual(after, before);
    await page.reload(); await entry().click();
    await area().locator(".eval-nav").getByRole("button", { name: /运行记录/ }).click();
    const row = area().locator("tr").filter({ hasText: "Mini-chat isolated fixture" }); await row.waitFor(); await row.getByRole("button").first().click();
    await card(0).waitFor(); await card(0).locator(".eval-chat-answer").filter({ hasText: "第三次追问完成。" }).waitFor();
    await screenshot("10-restored-conversations.png");
  });
  await check("legacy results with unknown timestamps display unknown runtime honestly", async () => {
    const path = join(agentDir, "model-evaluations", "runs", `${runId}.json`); const stored = JSON.parse(await readFile(path, "utf8"));
    const original = stored.results.find((value) => value.id === aId); original.startedAt = null; original.finishedAt = null; original.durationMs = null;
    const port = bridge.port; rpcSocket.terminate(); rpcSocket = undefined; await bridge.close(); bridge = undefined;
    await writeFile(path, JSON.stringify(stored));
    bridge = await startDesktopServer({ ...options, port }); await connectRpc();
    await page.reload(); await entry().click(); await historyRun("Mini-chat isolated fixture");
    const index = await card(0).getAttribute("data-result-id") === aId ? 0 : 1;
    const timer = await timerSnapshot(replyTimer(index, aId)); assert.equal(timer.state, "unknown"); assert.equal(timer.ms, null); assert.equal(timer.text, "耗时未知"); assert.doesNotMatch(timer.text, /\d{2}:\d{2}/);
    assert.deepEqual((await snapshot()).results.find((value) => value.id === aId).rating, initialSnapshot.results.find((value) => value.id === aId).rating);
    await screenshot("17-unknown-runtime.png"); return { timer };
  });
  assert.equal(report.errors.length, 0, report.errors.join("\n")); report.success = report.cases.every((value) => value.success);
} catch (error) {
  report.failure = error.stack ?? error.message; process.exitCode = 1;
  if (page) await screenshot("failure.png").catch(() => {});
} finally {
  await browser?.close(); rpcSocket?.terminate(); await vite?.close(); await bridge?.close();
  for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(join(output, "mini-chat-results.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(output, "mini-chat-report.md"), `# Mini-chat evaluation browser validation\n\nSuccess: ${report.success}\n\nActual App, desktop WebSocket, EvaluationService and store. Manually gated offline provider; checks are fake UI/RPC boundaries. Zero paid calls, no real user data/auth, and no production server was restarted.\n\n${report.cases.map((value) => `- ${value.success ? "PASS" : "FAIL"}: ${value.name}${value.failure ? ` — ${value.failure}` : ""}`).join("\n")}\n\n${report.failure ?? ""}\n`);
}
