import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import pw from "playwright-core";
import { createServer as createViteServer } from "vite";
import { WebSocket } from "ws";

// Real App/WS/EvaluationService, with manually advanced fake model stages. No paid calls.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktop = join(repo, "apps/desktop");
const output = resolve(process.argv[2] ?? join(repo, ".validation/model-evaluation-stream"));
await mkdir(output, { recursive: true });
const browserPath = [process.env.OWL_BROWSER_TEST_EXECUTABLE, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium"].find((path) => path && existsSync(path));
assert.ok(browserPath, "An installed Chromium browser is required; never downloads one.");
const temporary = await mkdtemp(join(tmpdir(), "owl-evaluation-stream-browser-"));
assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
assert.ok(basename(temporary).startsWith("owl-evaluation-stream-browser-"));
const agentDir = join(temporary, "agent");
const cwd = join(temporary, "workspace");
await mkdir(agentDir); await mkdir(cwd);
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ plugins: [], theme: "dark", uiLanguage: "zh-CN", cacheWarming: { mode: "off" }, owlNotifications: { enabled: false } }));
const previousEnvironment = Object.fromEntries(["OWL_CODING_AGENT_DIR", "PI_OFFLINE", "PI_RE_BRIDGE"].map((key) => [key, process.env[key]]));
for (const key of Object.keys(process.env)) if (/(?:API_KEY|TOKEN|SECRET|OPENAI|ANTHROPIC|AWS_|GOOGLE_|GEMINI|AZURE_|COPILOT)/i.test(key)) { previousEnvironment[key] = process.env[key]; delete process.env[key]; }
process.env.OWL_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1";
const loader = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-ai/compat": join(repo, "packages/ai/src/compat.ts"), "@earendil-works/pi-ai/oauth": join(repo, "packages/ai/src/oauth.ts"),
  "@earendil-works/pi-ai/bedrock-provider": join(repo, "packages/ai/src/bedrock-provider.ts"), "@earendil-works/pi-ai/bun-oauth": join(repo, "packages/ai/src/bun-oauth.ts"),
  "@earendil-works/pi-ai/providers/all": join(repo, "packages/ai/src/providers/all.ts"), "@earendil-works/pi-ai/providers/radius-config": join(repo, "packages/ai/src/providers/radius-config.ts"),
  "@earendil-works/pi-ai/utils/model-operations": join(repo, "packages/ai/src/utils/model-operations.ts"), "@earendil-works/pi-ai/utils/provider-env": join(repo, "packages/ai/src/utils/provider-env.ts"),
  "@earendil-works/pi-ai": join(repo, "packages/ai/src/index.ts"), "@earendil-works/pi-agent-core": join(repo, "packages/agent/src/index.ts"),
  "@earendil-works/pi-codemode/declarations": join(repo, "packages/codemode/src/declarations.ts"), "@earendil-works/pi-codemode/source": join(repo, "packages/codemode/src/source.ts"), "@earendil-works/pi-codemode": join(repo, "packages/codemode/src/index.ts"),
} });
const result = { success: false, actualApp: true, actualDesktopWebSocket: true, actualEvaluationService: true, manualStageGates: true, paidCalls: 0, cases: [], errors: [], requests: [], snapshots: [], screenshots: [], sourceSha256: {} };
for (const path of ["apps/desktop/src/App.tsx", "apps/desktop/src/features/evaluation/EvaluationResults.tsx", "apps/desktop/src/features/evaluation/useEvaluation.ts", "apps/desktop/src/features/evaluation/evaluation-copy.ts", "packages/coding-agent/src/core/evaluation/service.ts"])
  result.sourceSha256[path] = createHash("sha256").update(await readFile(join(repo, path))).digest("hex");
const pending = [];
const finishes = new Map();
let checkingCount = 0;
let checkingResolve;
const checkingReady = new Promise((done) => { checkingResolve = done; });
let readyResolve;
const ready = new Promise((done) => { readyResolve = done; });
let providerThinking = "";
const forbiddenFetch = async () => { throw new Error("Remote model/network requests forbidden in isolated streaming test"); };
const models = ["one", "two"].map((modelId) => ({ provider: "offline-stream", modelId, name: `Offline stream ${modelId}`, sourceName: "Offline fixture", supportedThinkingLevels: ["default"], contextWindow: 100000, maxTokens: 1000, pricing: null }));
let bridge, vite, browser, page, rpcSocket, runId;
const area = () => page.locator(".owl-eval:visible");
const cards = () => area().locator(".eval-result-card");
const text = (index) => cards().nth(index).locator(".eval-messages");
const entry = () => page.locator('[data-fd-id="model-evaluation-entry"]');
async function rpc(request) {
  const id = randomUUID();
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { rpcSocket.off("message", receive); reject(new Error(`Fixture RPC timed out: ${request.action}`)); }, 5000);
    const receive = (bytes) => { const value = JSON.parse(String(bytes)); if (value.id !== id) return; clearTimeout(timer); rpcSocket.off("message", receive); if (!value.ok) reject(new Error(value.error)); else done(value.result); };
    rpcSocket.on("message", receive); rpcSocket.send(JSON.stringify({ type: "evaluation.request", id, request }));
  });
}
async function check(name, operation) {
  const item = { name, success: false }; result.cases.push(item);
  try { Object.assign(item, await operation()); item.success = true; console.log(`PASS ${name}`); }
  catch (error) { item.failure = error.message; console.error(`FAIL ${name}: ${error.message}`); throw error; }
}
async function screenshot(name) { await page.screenshot({ path: join(output, name) }); result.screenshots.push(name); }
async function snapshot() {
  const run = await rpc({ action: "run.get", runId });
  result.snapshots.push({ status: run.status, results: run.results.map((item) => ({ id: item.id, status: item.status, phase: item.generationPhase, outputChars: item.output.length, thinkingChars: item.thinking.length, keys: Object.keys(item) })) });
  return run;
}
function publish(body, thinking = providerThinking) { providerThinking = thinking; for (const request of pending) request.onPartial(body, thinking); }
async function seeBody(marker) { for (let index = 0; index < 2; index++) await text(index).filter({ hasText: marker }).waitFor(); }
function longBody(marker, lines) { return `${marker}\n\n${Array.from({ length: lines }, (_, index) => `段落 ${index + 1}：这是隔离模型逐步输出的正文，只用来验收真实页面实时显示。`).join("\n")}\n`; }
async function scrollState(index) { return await text(index).evaluate((element) => ({ top: element.scrollTop, gap: element.scrollHeight - element.scrollTop - element.clientHeight, scrollHeight: element.scrollHeight })); }
try {
  const { startDesktopServer } = await loader.import(join(repo, "packages/coding-agent/src/modes/desktop/serve.ts"));
  bridge = await startDesktopServer({ port: 0, host: "127.0.0.1", agentDir, cwd, mcpServers: {}, onDiagnostic: () => {},
    news: { fetch: forbiddenFetch, listModels: () => [], callModel: forbiddenFetch, resolveModel: forbiddenFetch },
    evaluation: { timeoutMs: 120000, listModels: async () => structuredClone(models), invoke: async (request) => {
      pending.push(request); request.onPartial("", ""); if (pending.length === 2) readyResolve();
      return new Promise((done) => { finishes.set(request, done); });
    }, check: async () => { checkingCount++; if (checkingCount === 2) checkingResolve(); return new Promise(() => {}); } },
  });
  process.env.PI_RE_BRIDGE = `ws://127.0.0.1:${bridge.port}`;
  for (const port of [5189, 5191]) { try { vite = await createViteServer({ root: desktop, configFile: join(desktop, "vite.config.ts"), server: { host: "127.0.0.1", port, strictPort: true } }); await vite.listen(); break; } catch (error) { await vite?.close(); vite = undefined; if (port === 5191) throw error; } }
  const origin = vite.resolvedUrls.local[0]; result.origin = origin; result.bridgePort = bridge.port;
  rpcSocket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`); await new Promise((done, reject) => { rpcSocket.once("open", done); rpcSocket.once("error", reject); });
  browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => result.errors.push(error.stack ?? error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => { try { const value = JSON.parse(String(payload)); if (value.type === "evaluation.request") result.requests.push({ ...value, sentAt: Date.now() }); } catch {} }));
  await page.route("**/*", (route) => { const url = new URL(route.request().url()); if (url.origin === new URL(origin).origin) return route.continue(); result.errors.push(`External request blocked: ${url.origin}`); return route.abort(); });
  await page.addInitScript(({ workspace }) => { if (window !== window.top) return; localStorage.setItem("owl.workspaceDir", workspace); localStorage.setItem("owl.uiLanguage", "zh-CN"); localStorage.setItem("owl.workbench.open", "0"); }, { workspace: cwd });
  await page.goto(origin); await entry().click({ timeout: 30000 });
  await area().getByText("开始你的第一次模型测评", { exact: true }).waitFor();
  await area().locator(".eval-main-head").getByRole("button", { name: "新建测评", exact: true }).click();
  await area().getByRole("button", { name: "清空选择", exact: true }).click(); await area().locator("#eval-select-G08").check();
  for (const model of models) await area().locator(".eval-model-choice").filter({ hasText: model.name }).getByText("默认", { exact: true }).click();
  await area().getByRole("textbox", { name: "测评名称", exact: true }).fill("Streaming isolated fixture");
  await area().getByRole("button", { name: "开始测评", exact: true }).click();
  let readyTimer;
  try { await Promise.race([ready, new Promise((_done, reject) => { readyTimer = setTimeout(() => reject(new Error("Fake invocation stage gates did not become ready")), 10000); })]); }
  finally { clearTimeout(readyTimer); }
  await cards().nth(1).waitFor(); runId = (await rpc({ action: "run.list" }))[0].id;
  await check("waiting stage uses separate conversation streams and still hides model identity", async () => {
    const run = await snapshot(); assert.equal(run.status, "running");
    for (let index = 0; index < 2; index++) await cards().nth(index).locator(".eval-chat-status[data-generation-phase=waiting]").waitFor();
    for (const item of run.results) { assert.equal(item.output, ""); assert.equal(item.thinking, ""); assert.equal(item.generationPhase, "waiting"); for (const field of ["profile", "profileId", "usage", "costUsd", "durationMs", "actualModel"]) assert.equal(Object.hasOwn(item, field), false); }
    for (const model of models) assert.equal(await cards().filter({ hasText: model.name }).count(), 0);
    await screenshot("01-waiting.png");
  });
  await check("provider thinking grows visibly before either model produces an answer", async () => {
    const thinkingOne = longBody("第一批模型思考", 65);
    publish("", thinkingOne); await seeBody("第一批模型思考");
    const thinkingTwo = `${thinkingOne}\n${longBody("第二批模型思考", 40)}`;
    publish("", thinkingTwo); await seeBody("第二批模型思考");
    const run = await snapshot(); assert.ok(run.results.every((item) => item.status === "running" && item.generationPhase === "thinking" && item.output === "" && item.thinking === thinkingTwo));
    for (let index = 0; index < 2; index++) { await cards().nth(index).locator(".eval-thinking-body").filter({ hasText: "第二批模型思考" }).waitFor(); assert.ok((await scrollState(index)).gap <= 2); }
    await screenshot("01-thinking-live.png");
  });
  const bodyOne = longBody("第一批正文", 65);
  await check("two cards receive growing body while their real service run is unfinished", async () => {
    publish(bodyOne); await seeBody("第一批正文"); const run = await snapshot(); assert.equal(run.status, "running"); assert.ok(run.results.every((item) => item.output === bodyOne && item.status === "running" && item.generationPhase === "answering"));
    for (let index = 0; index < 2; index++) await cards().nth(index).locator(".eval-chat-answer").filter({ hasText: "第一批正文" }).waitFor();
    for (let index = 0; index < 2; index++) assert.ok((await scrollState(index)).gap <= 2);
    await screenshot("02-growing-body.png");
  });
  const bodyTwo = `${bodyOne}\n${longBody("第二批新增正文", 40)}`;
  await check("scrolling upward pauses only that card; continuing follows the next output", async () => {
    await text(0).evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); }); await cards().nth(0).locator(".eval-follow-bottom").waitFor();
    publish(bodyTwo); await seeBody("第二批新增正文"); assert.ok((await scrollState(0)).top <= 2); assert.ok((await scrollState(1)).gap <= 2); assert.equal((await snapshot()).status, "running");
    await cards().nth(0).locator(".eval-thinking summary").click();
    assert.ok((await scrollState(0)).top <= 2);
    await screenshot("03-paused-reading.png");
    await cards().nth(0).locator(".eval-follow-bottom").click(); assert.ok((await scrollState(0)).gap <= 2);
  });
  const bodyThree = `${bodyTwo}\n${longBody("第三批源码正文", 20)}`;
  await check("explicitly collapsed thinking remains collapsed as the body grows", async () => {
    publish(bodyThree); await seeBody("第三批源码正文");
    assert.equal(await cards().nth(0).locator(".eval-thinking").getAttribute("open"), null); assert.equal((await snapshot()).status, "running");
  });
  const bodyFour = `${bodyThree}\n${longBody("第四批后台正文", 10)}`;
  await check("chat navigation preserves background stream and catches up on return", async () => {
    await page.locator(".owl-activity-rail").getByRole("button", { name: "聊天", exact: true }).click(); assert.equal(await area().count(), 0);
    publish(bodyFour); const run = await snapshot(); assert.ok(run.results.every((item) => item.output === bodyFour));
    await entry().click(); await seeBody("第四批后台正文"); assert.equal(await cards().nth(0).locator(".eval-thinking").getAttribute("open"), null);
  });
  await check("the process reports artifact checking after the producer finishes", async () => {
    for (const request of pending) finishes.get(request)({ text: bodyFour, thinking: providerThinking, stopReason: "stop", error: null, usage: null, costUsd: null });
    let checkingTimer;
    try { await Promise.race([checkingReady, new Promise((_done, reject) => { checkingTimer = setTimeout(() => reject(new Error("Checking stage did not start")), 8000); })]); }
    finally { clearTimeout(checkingTimer); }
    for (let index = 0; index < 2; index++) await cards().nth(index).locator('.eval-chat-status[data-generation-phase="checking"]').waitFor();
    assert.ok((await snapshot()).results.every((item) => item.status === "running" && item.generationPhase === "checking"));
    await screenshot("04-checking-stage.png");
  });
  await check("cancelling retains every received body paragraph and ignores late producer callbacks", async () => {
    await area().getByRole("button", { name: "取消剩余运行", exact: true }).click(); await area().locator('[role="progressbar"]').waitFor({ state: "hidden" });
    const run = await snapshot(); assert.equal(run.status, "cancelled"); assert.ok(run.results.every((item) => item.status === "cancelled" && item.output === bodyFour)); assert.ok(pending.every((request) => request.signal.aborted));
    publish("LATE_BODY_MUST_BE_IGNORED"); assert.ok((await snapshot()).results.every((item) => item.output === bodyFour)); await seeBody("第四批后台正文");
    assert.equal(await area().getByText("LATE_BODY_MUST_BE_IGNORED", { exact: false }).count(), 0);
    const stored = JSON.parse(await readFile(join(agentDir, "model-evaluations", "runs", `${runId}.json`), "utf8")); assert.ok(stored.results.every((item) => item.output === bodyFour && item.thinking === providerThinking));
    await screenshot("04-cancelled-retained.png");
  });
  assert.equal(result.errors.length, 0, result.errors.join("\n")); result.success = result.cases.every((item) => item.success);
} catch (error) { result.failure = error.stack ?? error.message; process.exitCode = 1; if (page) await screenshot("failure.png").catch(() => {}); }
finally {
  await browser?.close(); rpcSocket?.terminate(); await vite?.close(); await bridge?.close();
  for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(join(output, "stream-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(output, "stream-report.md"), `# Evaluation streaming browser validation\n\nSuccess: ${result.success}\n\nActual App, WebSocket and EvaluationService; manually gated offline producer, zero paid calls. No actual user auth, data, or existing server was touched.\n\n${result.cases.map((item) => `- ${item.success ? "PASS" : "FAIL"}: ${item.name}${item.failure ? ` — ${item.failure}` : ""}`).join("\n")}\n\n${result.failure ?? ""}\n`);
}
