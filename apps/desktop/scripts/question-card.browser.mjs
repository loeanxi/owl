import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "esbuild";
import pw from "playwright-core";
import { WebSocketServer } from "ws";

// Only local fake bridge/viewer servers; no provider calls or user session files.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), "owl-question-card-results"));
const baselineOnly = process.argv.includes("--baseline");
await mkdir(output, { recursive: true });
const browserPath = [process.env.OWL_BROWSER_TEST_EXECUTABLE,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"]
  .find((candidate) => candidate && existsSync(candidate));
assert.ok(browserPath, "Set OWL_BROWSER_TEST_EXECUTABLE to an installed browser; never downloads one.");
const cwd = join(output, "fake-workspace").replace(/\\/g, "/");
const sockets = new Set();
const result = { success: false, productionMinify: true, actualApp: true, fakeWebSocket: true,
  cases: [], errors: [], requests: [], browserPath, sourceSha256: {}, fixtureFallbacks: [] };
for (const path of ["App.tsx", "components/QuestionDialog.tsx", "components/Composer.tsx", "sidebar/Workbench.tsx", "bridge/client.ts"])
  result.sourceSha256[path] = createHash("sha256").update(await readFile(join(repo, "apps/desktop/src", path))).digest("hex");
const built = await build({ entryPoints: [join(scriptDir, "fixtures/question-card.mjs")], outfile: join(output, "app.js"),
  bundle: true, platform: "browser", format: "esm", jsx: "automatic", minify: true,
  define: { "process.env.NODE_ENV": '"production"' }, metafile: true,
  loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
  plugins: [{ name: "explicit-fixture-fallbacks-and-baseline", setup(build) {
    build.onLoad({ filter: /(?:components|sidebar)[\\/]icons\.tsx$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");
      for (const name of ["IconChevron", "IconLoader", "IconPencil", "IconUndo"]) {
        if (new RegExp(`export (?:function|const) ${name}\\b`).test(contents)) continue;
        result.fixtureFallbacks.push(`Missing unrelated ${name} SVG export in ${args.path}`);
        contents += `\nexport function ${name}({className}) { return <svg className={className} aria-hidden="true"/>; }\n`;
      }
      return { contents, loader: "tsx", resolveDir: dirname(args.path) };
    });
    if (baselineOnly) build.onLoad({ filter: /(?:App|QuestionDialog)\.tsx$/ }, async (args) => {
      const file = args.path.endsWith("QuestionDialog.tsx") ? "QuestionDialog.before.tsx" : "App.before.tsx";
      const contents = await readFile(join(output, file), "utf8");
      result.baselineSnapshots ??= {};
      result.baselineSnapshots[file] = createHash("sha256").update(contents).digest("hex");
      return { contents, loader: "tsx", resolveDir: dirname(args.path) };
    });
    build.onResolve({ filter: /^\.\/mail\.css$/ }, (args) => {
      if (existsSync(join(args.resolveDir, args.path))) return undefined;
      result.fixtureFallbacks.push(join(args.resolveDir, args.path));
      return { path: "fixture-empty-mail-css", namespace: "fixture" };
    });
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "", loader: "css" }));
  }}],
});
result.actualInputs = Object.keys(built.metafile.inputs).filter((path) => /(?:App|QuestionDialog|Composer|Workbench|client)\.tsx?$/.test(path));
for (const file of ["App.tsx", "QuestionDialog.tsx", "Composer.tsx", "Workbench.tsx", "client.ts"])
  assert.ok(result.actualInputs.some((path) => path.endsWith(file)), `Actual ${file} absent`);
const cssSource = join(repo, "apps/desktop/src/index.css");
const compiler = await compile(await readFile(cssSource, "utf8"), { base: dirname(cssSource), onDependency: () => {} });
const scanner = new Scanner({ sources: [{ base: join(repo, "apps/desktop/src"), pattern: "**/*.{ts,tsx}", negated: false }, ...(baselineOnly ? [{ base: output, pattern: "*.before.tsx", negated: false }] : [])] });
const css = `${compiler.build(scanner.scan())}\n${await readFile(join(output, "app.css"), "utf8")}`;
await writeFile(join(output, "app.css"), css);
const javascript = await readFile(join(output, "app.js"));
const html = '<!doctype html><html><head><meta charset="UTF-8"><title>Owl question card regression</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".svg") ? "image/svg+xml" : "text/html;charset=utf-8" });
  response.end(path === "/app.js" ? javascript : path === "/app.css" ? css : path.endsWith(".svg") ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' : html);
});
const office = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html;charset=utf-8" });
  response.end('<!doctype html><html><head><meta charset="UTF-8"></head><body style="background:white;color:#222"><h2>费用测试</h2><button id="office-action">查看 Office</button><p>Office 内容与交互保留可见</p><script>document.querySelector("button").onclick=()=>document.body.dataset.clicked="yes"</script></body></html>');
});
await new Promise((done) => office.listen(0, "127.0.0.1", done));
const ws = new WebSocketServer({ server, path: "/ws" });
const row = { id: "fixture-session", name: "费用测试审阅", cwd, messageCount: 2, modified: "2026-10-03T11:00:00.000Z" };
const stats = { model: { provider: "faux", id: "test-model", name: "Faux test model" }, thinkingLevel: "medium", availableThinkingLevels: ["medium"], supportsThinking: true, contextUsage: { tokens: 100, contextWindow: 200000, percent: .05 } };
ws.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("message", (raw) => {
    const request = JSON.parse(String(raw));
    result.requests.push(request);
    let value = {};
    if (request.type === "models.list") value = [];
    if (request.type === "viewer.list") value = { viewers: [{ id: "fixture-office", title: "Office", extensions: ["univer", "xlsx"] }] };
    if (request.type === "viewer.open") value = { url: `http://127.0.0.1:${office.address().port}/?path=${encodeURIComponent(request.path)}`, title: request.path };
    if (request.type === "git.status") value = { repo: false, entries: [] };
    if (request.type === "session.list") value = [row];
    if (request.type === "session.running") value = { running: [] };
    if (request.type === "settings.get") value = { agentDir: "fixture-only", settings: { theme: "dark", uiLanguage: "zh-CN", owlNotifications: { enabled: false } } };
    if (request.type === "commands.list") value = { commands: [] };
    if (request.type === "session.stats") value = stats;
    if (request.type === "session.resume") value = { sessionId: request.sessionId, cwd, messages: [{ role: "user", content: "请生成并审阅费用表" }, { role: "assistant", content: [{ type: "text", text: "已生成 [费用测试.univer](费用测试.univer)，草稿等待审阅。" }], stopReason: "stop" }], messageEntryIds: ["entry-0", "entry-1"] };
    socket.send(JSON.stringify({ type: "response", id: request.id, ok: request.type !== "news.request", result: value, error: request.type === "news.request" ? "News disabled in isolated fixture" : undefined }));
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
result.origin = origin;
const browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
const page = await browser.newPage({ viewport: { width: baselineOnly ? 1280 : 1920, height: 1080 } });
page.setDefaultTimeout(3500);
page.on("pageerror", (error) => result.errors.push(error.message));
const allowedOrigins = new Set([origin, `http://127.0.0.1:${office.address().port}`]);
await page.route("**/*", (route) => {
  const requestedOrigin = new URL(route.request().url()).origin;
  if (allowedOrigins.has(requestedOrigin)) return route.continue();
  result.errors.push(`Unexpected request outside the fixture: ${requestedOrigin}`);
  return route.abort();
});
await page.addInitScript(({ cwd }) => {
  localStorage.setItem("owl.workspaceDir", cwd);
  localStorage.setItem("owl.model", "faux/test-model");
  localStorage.setItem("owl.uiLanguage", "zh-CN");
  localStorage.setItem("owl.workbench.open", "1");
  localStorage.setItem("owl.workbench.dock", "right");
  localStorage.setItem("owl.workbench.width", "550");
}, { cwd });
function send(message) { for (const socket of sockets) socket.send(JSON.stringify(message)); }
const officeQuestion = { header: "Office 审阅", question: "确认 Office 修改 费用测试.univer 草稿，是否合入当前版本？", multiSelect: false,
  options: [{ label: "确认合入", description: "将已审阅的草稿合入当前版本。" }, { label: "暂不处理", description: "保留草稿，继续查看或修改。" }] };
const q = (requestId, questions = [officeQuestion], sessionId = "fixture-session") => ({ type: "question_request", requestId, sessionId, toolCallId: `tool-${requestId}`, questions });
const card = () => page.locator('.owl-question-card, div.bg-owl-panel').filter({ hasText: /第 \d+ \/ \d+ 题/ }).last();
const answerRequests = () => result.requests.filter((request) => request.type === "question.response");
const pause = () => page.waitForTimeout(100);
async function emitQuestion(requestId, questions) { send(q(requestId, questions)); await card().waitFor({ state: "visible" }); await pause(); }
async function caseRun(name, operation) {
  const entry = { name, success: false };
  try { Object.assign(entry, await operation()); entry.success = true; }
  catch (error) { entry.failure = error.message; }
  result.cases.push(entry);
  console.log(`${entry.success ? "PASS" : "FAIL"} ${name}${entry.failure ? ": " + entry.failure : ""}`);
}
async function geometry() {
  return await card().evaluate((element) => {
    const rect = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const lane = document.querySelector(".owl-shell-conversation");
    const composer = document.querySelector(".owl-composer-surface");
    const workbench = document.querySelector(".owl-workbench-shell");
    const ancestors = []; for (let parent = element; parent; parent = parent.parentElement) ancestors.push({ position: getComputedStyle(parent).position, bg: getComputedStyle(parent).backgroundColor, rect: rect(parent), className: parent.className });
    return { card: rect(element), lane: rect(lane), composer: rect(composer), workbench: rect(workbench), ancestors, dock: workbench.dataset.dock, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
  });
}
function assertAnchor(g) {
  assert.ok(g.card.x >= g.lane.x - 1 && g.card.right <= g.lane.right + 1, `Card [${g.card.x},${g.card.right}] exceeds chat lane [${g.lane.x},${g.lane.right}]`);
  assert.ok(Math.abs(g.card.bottom - g.composer.y) <= 20, `Card bottom ${g.card.bottom} should sit immediately above Composer ${g.composer.y}`);
  assert.ok(g.card.y >= g.lane.y - 1, `Card top ${g.card.y} clips chat lane ${g.lane.y}`);
  if (g.dock === "right") assert.ok(g.card.right <= g.workbench.x + 1, "Card overlays right Office pane");
  else assert.ok(g.card.bottom < g.workbench.y, "Card overlays bottom workbench");
  assert.equal(g.ancestors.some((a) => a.position === "fixed" && a.rect.width >= g.viewport - 2), false, "Fullscreen layer remains");
}
async function cancel() { await card().getByRole("button", { name: "取消", exact: true }).click(); await pause(); }
async function submit() { await card().getByRole("button", { name: "提交回答", exact: true }).click(); await pause(); }
try {
  await page.goto(origin);
  await page.getByRole("textbox", { name: "任务输入", exact: true }).waitFor();
  await page.getByRole("link", { name: "费用测试.univer", exact: true }).first().click();
  await page.waitForSelector(".owl-plugin-viewer iframe");
  await emitQuestion("baseline-anchor");
  await caseRun("office-question-is-anchored-above-composer-inside-chat-lane-without-dimmer", async () => {
    const g = await geometry();
    await page.screenshot({ path: join(output, "01-office-dark.png") });
    result.baselineGeometry = g;
    assertAnchor(g);
    return g;
  });
  if (!baselineOnly) {
    // Further control and layout cases are populated below.
    await cancel();
  }
  assert.equal(result.errors.length, 0, result.errors.join("\n"));
  result.success = result.cases.every((entry) => entry.success);
  if (!result.success) process.exitCode = 1;
} finally {
  await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n");
  await browser.close();
  for (const socket of sockets) socket.terminate();
  await new Promise((done) => ws.close(done));
  await new Promise((done) => server.close(done));
  await new Promise((done) => office.close(done));
}
