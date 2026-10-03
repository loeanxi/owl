import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import pw from "playwright-core";
import { createServer as createViteServer } from "vite";
import { WebSocket } from "ws";

// Actual App + actual desktop WebSocket server. Only evaluation model/check boundaries are fake.
// No existing server, account, auth file, browser profile, or paid model is used.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktop = join(repo, "apps/desktop");
const output = resolve(process.argv[2] ?? join(repo, ".validation/model-evaluation"));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "owl-evaluation-browser-"));
const temporaryAbsolute = resolve(temporary);
assert.equal(dirname(temporaryAbsolute), resolve(tmpdir()));
assert.ok(basename(temporaryAbsolute).startsWith("owl-evaluation-browser-"));
const agentDir = join(temporary, "agent");
const cwd = join(temporary, "workspace");
await mkdir(agentDir);
await mkdir(cwd);
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ plugins: [], theme: "dark", uiLanguage: "zh-CN", cacheWarming: { mode: "off" }, owlNotifications: { enabled: false } }));
const previousEnvironment = Object.fromEntries(["OWL_CODING_AGENT_DIR", "PI_OFFLINE", "PI_RE_BRIDGE"].map((key) => [key, process.env[key]]));
// The App also queries model settings on connect. Remove ambient credential variables in this
// child process so the otherwise real desktop model-list path cannot discover user credentials.
for (const key of Object.keys(process.env)) {
  if (!/(?:API_KEY|TOKEN|SECRET|OPENAI|ANTHROPIC|AWS_|GOOGLE_|GEMINI|AZURE_|COPILOT)/i.test(key)) continue;
  previousEnvironment[key] = process.env[key];
  delete process.env[key];
}
process.env.OWL_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const loader = createJiti(import.meta.url, {
  alias: {
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
  },
});
const browserPath = [process.env.OWL_BROWSER_TEST_EXECUTABLE, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((path) => path && existsSync(path));
assert.ok(browserPath, "An installed Chromium browser is required; no browser will be downloaded.");
const result = { success: false, actualApp: true, actualDesktopWebSocket: true, actualEvaluationService: true, fakeModelAndChecks: true, paidCalls: 0, fixtureFallbacks: [], cases: [], errors: [], diagnostics: [], requests: [], responses: [], modelCalls: [], screenshots: [], sourceSha256: {} };
for (const path of ["apps/desktop/src/App.tsx", "apps/desktop/src/components/DesktopTitlebar.tsx", "apps/desktop/src/features/evaluation/EvaluationPage.tsx", "apps/desktop/src/features/evaluation/EvaluationResults.tsx", "apps/desktop/src/features/evaluation/EvaluationSummary.tsx", "apps/desktop/src/features/evaluation/evaluation-model.ts", "apps/desktop/src/features/evaluation/evaluation.css", "packages/coding-agent/src/core/evaluation/service.ts"])
  result.sourceSha256[path] = createHash("sha256").update(await readFile(join(repo, path))).digest("hex");
let bridge;
let vite;
let browser;
let page;
let rpcSocket;
let failNext = false;
let startDesktopServer;
const models = [
  { provider: "isolated-fixture", modelId: "alpha", name: "Fixture Alpha", sourceName: "Offline fixture", supportedThinkingLevels: ["default", "high"], contextWindow: 100000, maxTokens: 1000, pricing: null },
  { provider: "isolated-fixture", modelId: "beta", name: "Fixture Beta", sourceName: "Offline fixture", supportedThinkingLevels: ["default"], contextWindow: 100000, maxTokens: 1000, pricing: null },
];
const forbiddenFetch = async () => { throw new Error("Network/model calls are forbidden outside the local browser fixture"); };
const options = {
  agentDir, cwd, host: "127.0.0.1", mcpServers: {}, onDiagnostic: (message) => result.diagnostics.push(message),
  news: { fetch: forbiddenFetch, listModels: () => [], callModel: forbiddenFetch, resolveModel: forbiddenFetch },
  evaluation: {
    listModels: async () => structuredClone(models),
    invoke: async (request) => {
      result.modelCalls.push({ taskId: request.task.id, profileId: request.profile.id, thinkingLevel: request.profile.thinkingLevel });
      const failure = failNext;
      failNext = false;
      request.onPartial("offline partial answer", "fixture reasoning");
      await new Promise((done) => setTimeout(done, 120));
      request.signal.throwIfAborted();
      const content = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><rect width="400" height="260" fill="#f4f0df"/><circle cx="115" cy="180" r="52" fill="none" stroke="#263a32" stroke-width="5"/><circle cx="285" cy="180" r="52" fill="none" stroke="#263a32" stroke-width="5"/><path d="M115 180 170 112 220 180 115 180M220 180 267 111 285 180M165 108h34M254 106h29" fill="none" stroke="#478267" stroke-width="7"/><ellipse cx="186" cy="88" rx="46" ry="23" fill="white" stroke="#263a32" stroke-width="3"/><path d="M214 83Q226 32 252 36L302 55 252 65M177 108 212 140 217 180M159 85 232 112" fill="none" stroke="#263a32" stroke-width="5"/><path d="m258 47 44 8-47 15" fill="#e6ae60"/><circle cx="253" cy="44" r="3" fill="#263a32"/></svg>';
      return { text: failure ? "retained fixture failure" : request.task.outputType === "json" ? JSON.stringify({ fixture: true, source: "Offline UI integration fixture" }) : content, thinking: "fixture reasoning", stopReason: failure ? "error" : "stop", error: failure ? "Offline fixture intentional failure" : null, usage: null, costUsd: null,
        actualModel: { provider: request.profile.provider, modelId: request.profile.modelId, responseModel: null, forwardedThinkingLevel: request.profile.thinkingLevel === "default" ? null : request.profile.thinkingLevel, providerThinkingLevel: null } };
    },
    check: async (task, text) => ({ artifact: { type: task.outputType, content: text, previewAllowed: task.outputType === "svg" }, checks: [{ id: "fixture-format", label: "隔离流程检查", status: "passed", detail: "假检查边界，仅验证 UI/RPC，不代表真实模型质量。" }] }),
  },
};
async function connectRpc() {
  rpcSocket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
  await new Promise((done, reject) => { rpcSocket.once("open", done); rpcSocket.once("error", reject); });
}
async function rpc(request) {
  const id = crypto.randomUUID();
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { rpcSocket.off("message", receive); reject(new Error(`RPC timed out: ${request.action}`)); }, 4000);
    const receive = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== id) return;
      clearTimeout(timer); rpcSocket.off("message", receive);
      if (!message.ok) reject(new Error(message.error)); else done(message.result);
    };
    rpcSocket.on("message", receive);
    rpcSocket.send(JSON.stringify({ type: "evaluation.request", id, request }));
  });
}
async function check(name, operation) {
  const entry = { name, success: false };
  result.cases.push(entry);
  try { Object.assign(entry, await operation()); entry.success = true; console.log(`PASS ${name}`); }
  catch (error) { entry.failure = error.message; console.error(`FAIL ${name}: ${error.message}`); throw error; }
}
async function screenshot(name) {
  await page.screenshot({ path: join(output, name), fullPage: true });
  result.screenshots.push(name);
}
const entryButton = () => page.locator('[data-fd-id="model-evaluation-entry"]');
const area = () => page.locator(".owl-eval:visible");
const latestStart = () => result.requests.filter((request) => request.type === "evaluation.request" && request.request.action === "run.start").at(-1);
const latestRun = async () => (await rpc({ action: "run.list" }))[0];
const waitFinished = async (runId) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const run = await rpc({ action: "run.get", runId });
    if (run.status !== "running") { await area().locator('[role="progressbar"]').waitFor({ state: "hidden" }); return run; }
    await page.waitForTimeout(50);
  }
  throw new Error("Offline run did not finish");
};
async function newRun(name, twoModels = false, samples = 1, taskIds = ["G01"]) {
  await area().locator(".eval-main-head").getByRole("button", { name: "新建测评", exact: true }).click();
  await area().getByRole("button", { name: "清空选择", exact: true }).click();
  for (const taskId of taskIds) await area().locator(`#eval-select-${taskId}`).check();
  await area().locator(".eval-model-choice").filter({ hasText: "Fixture Alpha" }).getByText("默认", { exact: true }).click();
  if (twoModels) await area().locator(".eval-model-choice").filter({ hasText: "Fixture Beta" }).getByText("默认", { exact: true }).click();
  await area().getByRole("textbox", { name: "测评名称", exact: true }).fill(name);
  if (!twoModels && samples === 1) {
    await area().getByRole("group", { name: "每题运行次数", exact: true }).getByRole("button", { name: "3", exact: true }).click();
    assert.equal(await area().locator(".eval-config-row").filter({ hasText: "调用次数" }).locator("strong").innerText(), String(3 * taskIds.length));
    await screenshot(`create-${3 * taskIds.length}-calls.png`);
  }
  await area().getByRole("group", { name: "每题运行次数", exact: true }).getByRole("button", { name: String(samples), exact: true }).click();
  await page.locator(".owl-activity-rail").getByRole("button", { name: "聊天", exact: true }).click();
  await entryButton().click();
  assert.equal(await area().getByRole("textbox", { name: "测评名称", exact: true }).inputValue(), name);
  assert.equal(await area().locator("#eval-select-G01").isChecked(), true);
  await area().getByRole("group", { name: "每题运行次数", exact: true }).getByRole("button", { name: String(samples), exact: true, pressed: true }).waitFor();
  await screenshot(`create-${samples}-${twoModels ? "two" : "one"}${taskIds.length > 1 ? `-tasks${taskIds.length}` : ""}.png`);
  await area().getByRole("button", { name: "开始测评", exact: true }).click();
  await area().locator(".eval-result-card").first().waitFor();
  const summary = await latestRun();
  await waitFinished(summary.id);
  return summary.id;
}
async function summaryDimensions(runId, expectedByTask) {
  const run = await rpc({ action: "run.get", runId });
  await area().getByRole("button", { name: "测评汇总", exact: true }).click();
  await area().locator(".eval-criterion-stat").first().waitFor();
  const dimensions = await area().locator(".eval-criterion-stat").evaluateAll((elements) => elements.map((element) => ({
    id: element.dataset.criterionId, label: element.dataset.criterionLabel, description: element.dataset.criterionDescription,
    taskIds: element.dataset.taskIds, mean: element.querySelector(".eval-criterion-mean")?.textContent.trim(),
    count: element.querySelector(".eval-criterion-count")?.textContent.trim(),
  })));
  assert.equal(dimensions.length, Object.keys(expectedByTask).length * 3);
  for (const [taskId, scores] of Object.entries(expectedByTask)) {
    const task = run.tasks.find((item) => item.id === taskId);
    assert.ok(task);
    for (const [index, criterion] of task.rubric.entries()) {
      const matches = dimensions.filter((item) => item.id === criterion.id && item.label === criterion.label && item.description === criterion.description);
      assert.equal(matches.length, 1, `Missing or mixed rubric signature: ${taskId}/${criterion.id}/${criterion.label}`);
      assert.equal(matches[0].mean, `${scores[index].toFixed(2)} / 5`);
      assert.match(matches[0].count, /^1\s*\/\s*1\s*已评分(?:\s*·|$)/);
      assert.ok(matches[0].taskIds.includes(taskId));
      for (const otherId of Object.keys(expectedByTask).filter((id) => id !== taskId)) assert.equal(matches[0].taskIds.includes(otherId), false);
    }
  }
  assert.equal(await area().getByText("人工评价均分", { exact: true }).count(), 0);
  return dimensions;
}
try {
  ({ startDesktopServer } = await loader.import(join(repo, "packages/coding-agent/src/modes/desktop/serve.ts")));
  bridge = await startDesktopServer({ ...options, port: 0 });
  process.env.PI_RE_BRIDGE = `ws://127.0.0.1:${bridge.port}`;
  for (const port of [5189, 5190]) {
    try { vite = await createViteServer({ root: desktop, configFile: join(desktop, "vite.config.ts"), server: { host: "127.0.0.1", port, strictPort: true } }); await vite.listen(); break; }
    catch (error) { await vite?.close(); vite = undefined; if (port === 5190) throw error; }
  }
  const origin = vite.resolvedUrls.local[0];
  result.origin = origin;
  result.bridgePort = bridge.port;
  await connectRpc();
  browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => result.errors.push(error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => { try { const value = JSON.parse(String(payload)); if (value.type === "evaluation.request") result.requests.push(value); } catch {} });
    socket.on("framereceived", ({ payload }) => { try { const value = JSON.parse(String(payload)); if (value.type === "response" && result.requests.some((request) => request.id === value.id)) result.responses.push(value); } catch {} });
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin || url.hostname === "127.0.0.1" && Number(url.port) === bridge.port) return route.continue();
    result.errors.push(`External request blocked: ${url.origin}`); return route.abort();
  });
  await page.addInitScript(({ workspace }) => { if (window.top !== window) return; localStorage.setItem("owl.workspaceDir", workspace); localStorage.setItem("owl.uiLanguage", "zh-CN"); localStorage.setItem("owl.sidebar.minimized", "0"); localStorage.setItem("owl.workbench.open", "0"); }, { workspace: cwd });
  await page.goto(origin);
  await check("actual top-menu entry and 24 real built-in tasks", async () => {
    await entryButton().waitFor(); await entryButton().click();
    await area().getByText("开始你的第一次模型测评", { exact: true }).waitFor();
    const bootstrap = await rpc({ action: "bootstrap" });
    assert.equal(bootstrap.tasks.length, 24); assert.equal(bootstrap.models.length, 2);
    await area().locator(".eval-nav").getByRole("button", { name: /题库/ }).click();
    assert.equal(await area().locator(".eval-library-card").count(), 24);
    await screenshot("01-library.png");
  });
  let firstRunId;
  await check("new-run sample selector updates 1 and 3 call counts, actual start uses one call", async () => {
    firstRunId = await newRun("Browser one-call fixture");
    assert.equal(latestStart().request.samples, 1); assert.equal(latestStart().request.taskIds.length * latestStart().request.profiles.length, 1);
    assert.equal((await rpc({ action: "run.get", runId: firstRunId })).results.length, 1);
    const geometry = await page.frameLocator(".owl-eval .eval-artifact iframe").first().locator("svg").evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      return { x: rectangle.x, y: rectangle.y, right: rectangle.right, bottom: rectangle.bottom, width: rectangle.width, height: rectangle.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(geometry.x >= -1 && geometry.y >= -1 && geometry.right <= geometry.viewportWidth + 1 && geometry.bottom <= geometry.viewportHeight + 1, `SVG preview canvas is clipped: ${JSON.stringify(geometry)}`);
    await screenshot("02-anonymous.png");
    return { svgPreviewGeometry: geometry };
  });
  await check("anonymous wire and DOM hide metadata; scoring draft survives chat/evaluation switches", async () => {
    const run = await rpc({ action: "run.get", runId: firstRunId });
    for (const value of run.results) for (const key of ["profile", "profileId", "usage", "costUsd", "thinking", "durationMs", "actualModel"]) assert.equal(Object.hasOwn(value, key), false, `Anonymous result leaked ${key}`);
    assert.equal(await area().locator(".eval-result-card").filter({ hasText: "Fixture Alpha" }).count(), 0);
    const group = area().locator(".eval-rating").first();
    await group.getByRole("button", { name: "4 分", exact: true }).click();
    await page.locator(".owl-activity-rail").getByRole("button", { name: "聊天", exact: true }).click();
    assert.equal(await area().count(), 0);
    await entryButton().click();
    await area().locator(".eval-rating").first().getByRole("button", { name: "4 分", exact: true, pressed: true }).waitFor();
    await area().getByRole("button", { name: "提交评分并揭晓", exact: true }).click();
    await area().getByRole("alert").filter({ hasText: "每个评价项" }).waitFor();
    assert.equal((await rpc({ action: "run.get", runId: firstRunId })).groups[0].revealed, false);
    await screenshot("03-incomplete-score.png");
  });
  await check("three criteria scoring reveals real identities without changing order", async () => {
    const before = await rpc({ action: "run.get", runId: firstRunId });
    for (const [index, group] of (await area().locator(".eval-rating").all()).entries()) await group.getByRole("button", { name: `${[5, 3, 4][index]} 分`, exact: true }).click();
    await area().locator(".eval-score-note").fill("Offline browser fixture review");
    await area().getByRole("button", { name: "提交评分并揭晓", exact: true }).click();
    await area().locator(".eval-result-name").filter({ hasText: "Fixture Alpha" }).waitFor();
    const after = await rpc({ action: "run.get", runId: firstRunId });
    assert.deepEqual(after.groups[0].resultIds, before.groups[0].resultIds); assert.equal(Object.keys(after.results[0].rating.scores).length, 3);
    assert.equal(after.results[0].usage, null); assert.equal(after.results[0].costUsd, null);
    await screenshot("04-revealed.png");
  });
  await check("Summary keeps distinct 5/3/4 criterion means and each 1/1 denominator", async () => {
    const dimensions = await summaryDimensions(firstRunId, { G01: [5, 3, 4] });
    await screenshot("04-summary-dimensions.png");
    await area().getByRole("button", { name: "结果对比", exact: true }).click();
    return { dimensions };
  });
  let comparedRunId;
  await check("two-model comparison, extra samples, and retained failure retry", async () => {
    comparedRunId = await newRun("Browser comparison fixture", true);
    const before = await rpc({ action: "run.get", runId: comparedRunId });
    assert.equal(before.results.length, 2);
    assert.equal(before.results.every((item) => !item.profile && !item.actualModel), true);
    for (const group of await area().locator(".eval-rating").all()) await group.getByRole("button", { name: "4 分", exact: true }).click();
    await area().getByRole("button", { name: "提交评分并揭晓", exact: true }).click();
    await area().locator(".eval-result-name").filter({ hasText: "Fixture Alpha" }).waitFor();
    const scored = await rpc({ action: "run.get", runId: comparedRunId });
    assert.equal(scored.results.every((item) => item.profile && Object.keys(item.rating.scores).length === 3), true);
    assert.deepEqual(scored.groups[0].resultIds, before.groups[0].resultIds);
    await screenshot("04-two-model-revealed.png");
    await area().getByRole("button", { name: "追加到 3 次", exact: true }).click();
    await area().getByRole("combobox", { name: "每题运行次数", exact: true }).locator('option[value="3"]').waitFor({ state: "attached" });
    await waitFinished(comparedRunId);
    const appended = await rpc({ action: "run.get", runId: comparedRunId });
    assert.equal(appended.results.length, 6); assert.deepEqual(appended.groups[0].resultIds, before.groups[0].resultIds);
    await area().getByRole("combobox", { name: "每题运行次数", exact: true }).selectOption("3");
    failNext = true;
    const failure = await rpc({ action: "run.retry", runId: comparedRunId, resultId: appended.groups[2].resultIds[0] });
    await area().locator(".eval-main-head").getByRole("button", { name: "刷新", exact: true }).click();
    await area().getByRole("button", { name: "重试此结果", exact: true }).waitFor();
    const failed = (await rpc({ action: "run.get", runId: comparedRunId })).results.find((item) => item.status === "failed");
    assert.ok(failed);
    const previousCount = failure.results.length;
    await area().getByRole("button", { name: "重试此结果", exact: true }).click();
    await area().locator(".eval-main-head").getByRole("button", { name: "刷新", exact: true }).click();
    await waitFinished(comparedRunId);
    const retried = await rpc({ action: "run.get", runId: comparedRunId });
    assert.equal(retried.results.length, previousCount + 1); assert.equal(retried.results.find((item) => item.id === failed.id).status, "failed");
    await screenshot("05-retry.png");
  });
  await check("new three-sample run performs exactly three isolated calls", async () => {
    const beforeCount = result.modelCalls.length;
    const runId = await newRun("Browser three-sample fixture", false, 3);
    const run = await rpc({ action: "run.get", runId });
    assert.equal(latestStart().request.samples, 3);
    assert.equal(run.results.length, 3);
    assert.equal(result.modelCalls.length - beforeCount, 3);
    await screenshot("06-three-samples.png");
  });
  await check("Summary never mixes G01 and G07 criteria sharing the SVG category", async () => {
    const runId = await newRun("Browser distinct-rubric fixture", false, 1, ["G01", "G07"]);
    for (const [taskId, scores] of Object.entries({ G01: [5, 3, 4], G07: [1, 2, 5] })) {
      await area().locator(".eval-side-task").filter({ hasText: taskId }).click();
      await area().locator(".eval-rating").first().waitFor();
      for (const [index, group] of (await area().locator(".eval-rating").all()).entries()) await group.getByRole("button", { name: `${scores[index]} 分`, exact: true }).click();
      await area().getByRole("button", { name: "提交评分并揭晓", exact: true }).click();
      await area().locator(".eval-result-name").filter({ hasText: "Fixture Alpha" }).waitFor();
    }
    const dimensions = await summaryDimensions(runId, { G01: [5, 3, 4], G07: [1, 2, 5] });
    await screenshot("06-summary-distinct-rubrics.png");
    return { dimensions };
  });
  await check("custom-task required fields and actual persisted save", async () => {
    await area().locator(".eval-nav").getByRole("button", { name: /题库/ }).click();
    await area().getByRole("button", { name: "新建自定义题", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建自定义题", exact: true });
    await dialog.getByRole("button", { name: "保存题目", exact: true }).click();
    await dialog.getByRole("alert").waitFor();
    await dialog.getByRole("textbox", { name: "题目名称", exact: true }).fill("Browser custom task");
    await dialog.getByRole("textbox", { name: "完整提示词", exact: true }).fill("Generate a simple local SVG circle.");
    for (let number = 1; number <= 3; number++) await dialog.getByRole("textbox", { name: `评价项 ${number}`, exact: true }).fill(`Criterion ${number}`);
    await screenshot("06-custom-editor.png");
    await dialog.getByRole("button", { name: "保存题目", exact: true }).click();
    await area().locator(".eval-library-card").filter({ hasText: "Browser custom task" }).waitFor();
    const bootstrap = await rpc({ action: "bootstrap" });
    assert.equal(bootstrap.tasks.length, 25); assert.ok(bootstrap.tasks.find((task) => task.title === "Browser custom task" && !task.builtin));
  });
  await check("run history refresh retains real records and browser reload", async () => {
    await area().locator(".eval-nav").getByRole("button", { name: /运行记录/ }).click();
    await area().locator("tr").filter({ hasText: "Browser one-call fixture" }).waitFor();
    assert.equal(await area().locator("tbody tr").count(), 4);
    await screenshot("07-history.png");
    await page.reload(); await entryButton().click();
    await area().locator(".eval-nav").getByRole("button", { name: /运行记录/ }).click();
    await area().locator("tr").filter({ hasText: "Browser one-call fixture" }).waitFor();
  });
  await check("real server restart restores scores, order, custom tasks, and all attempts", async () => {
    const before = await rpc({ action: "run.get", runId: firstRunId });
    const port = bridge.port;
    rpcSocket.terminate(); rpcSocket = undefined;
    await bridge.close(); bridge = undefined;
    await area().locator(".eval-error").waitFor();
    assert.match(await area().locator(".eval-error").innerText(), /本地服务未连接|disconnected|未连接/);
    await screenshot("08-disconnected.png");
    bridge = await startDesktopServer({ ...options, port });
    await connectRpc();
    const after = await rpc({ action: "run.get", runId: firstRunId });
    assert.deepEqual(after.groups, before.groups); assert.deepEqual(after.results[0].rating, before.results[0].rating);
    assert.equal((await rpc({ action: "bootstrap" })).tasks.length, 25);
    assert.equal((await rpc({ action: "run.get", runId: comparedRunId })).results.length, 8);
    await page.reload(); await entryButton().click();
    await area().locator(".eval-nav").getByRole("button", { name: /运行记录/ }).click();
    await area().locator("tr").filter({ hasText: "Browser comparison fixture" }).waitFor();
    await screenshot("08-restarted-history.png");
  });
  assert.equal(result.fixtureFallbacks.length, 0);
  assert.equal(result.errors.length, 0, result.errors.join("\n"));
  result.success = result.cases.every((entry) => entry.success);
} catch (error) {
  result.failure = error.stack ?? error.message;
  process.exitCode = 1;
  if (page) await screenshot("failure.png").catch(() => {});
} finally {
  await browser?.close();
  rpcSocket?.terminate();
  await vite?.close();
  await bridge?.close();
  for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(temporaryAbsolute, { recursive: true, force: true });
  await writeFile(join(output, "browser-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(output, "browser-report.md"), `# Model evaluation browser integration\n\nSuccess: ${result.success}\n\nActual Vite App, DesktopServer WebSocket and EvaluationService; fake offline model and check boundaries. No paid calls, user auth, user data, existing processes, or production build.\n\n${result.cases.map((entry) => `- ${entry.success ? "PASS" : "FAIL"}: ${entry.name}${entry.failure ? ` — ${entry.failure}` : ""}`).join("\n")}\n\n${result.failure ?? ""}\n`);
}
