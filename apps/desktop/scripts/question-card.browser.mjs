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
for (const path of ["App.tsx", "components/QuestionDialog.tsx", "components/QuestionDock.tsx", "components/question-card.css", "components/question-dock.css", "components/ChatStream.tsx", "components/Composer.tsx", "sidebar/Workbench.tsx", "bridge/client.ts"])
  result.sourceSha256[path] = createHash("sha256").update(await readFile(join(repo, "apps/desktop/src", path))).digest("hex");
const built = await build({ entryPoints: [join(scriptDir, "fixtures/question-card.mjs")], outfile: join(output, "app.js"),
  bundle: true, platform: "browser", format: "esm", jsx: "automatic", minify: true,
  define: { "process.env.NODE_ENV": '"production"' }, metafile: true,
  loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
  plugins: [{ name: "baseline-source-snapshots", setup(build) {
    if (baselineOnly) build.onLoad({ filter: /(?:App|Composer|QuestionDialog|QuestionDock)\.tsx$|question-(?:card|dock)\.css$/ }, async (args) => {
      const filename = args.path.replace(/\\/g, "/").split("/").at(-1);
      const file = filename.replace(/\.(tsx|css)$/, ".before.$1");
      const contents = await readFile(join(output, file), "utf8");
      result.baselineSnapshots ??= {};
      result.baselineSnapshots[file] = createHash("sha256").update(contents).digest("hex");
      return { contents, loader: args.path.endsWith(".css") ? "css" : "tsx", resolveDir: dirname(args.path) };
    });
  }}],
});
result.actualInputs = Object.keys(built.metafile.inputs).filter((path) => /(?:App|QuestionDock|QuestionDialog|ChatStream|Composer|Workbench|client)\.tsx?$/.test(path));
for (const file of ["App.tsx", "QuestionDock.tsx", "QuestionDialog.tsx", "ChatStream.tsx", "Composer.tsx", "Workbench.tsx", "client.ts"])
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
const otherRow = { ...row, id: "other-session", name: "后台问题会话" };
const stats = { model: { provider: "faux", id: "test-model", name: "Faux test model" }, thinkingLevel: "medium", availableThinkingLevels: ["medium"], supportsThinking: true, contextUsage: { tokens: 100, contextWindow: 200000, percent: .05 } };
const transcript = [
  { role: "user", content: "请生成并审阅费用表" },
  { role: "assistant", content: [{ type: "text", text: "已生成 [费用测试.univer](费用测试.univer)，草稿等待审阅。\n\n" + Array.from({ length: 60 }, (_, i) => `- 检查 ${i + 1}：表头、数量、单价、金额与公式结果一致。`).join("\n") + "\n\n近期末尾提示：请确认需要保留的内容。" }], stopReason: "stop" },
];
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
    if (request.type === "session.list") value = [row, otherRow];
    if (request.type === "session.running") value = { running: [] };
    if (request.type === "settings.get") value = { agentDir: "fixture-only", settings: { theme: "dark", uiLanguage: "zh-CN", owlNotifications: { enabled: false } } };
    if (request.type === "commands.list") value = { commands: [] };
    if (request.type === "session.stats") value = stats;
    if (request.type === "session.resume") value = { sessionId: request.sessionId, cwd, messages: transcript, messageEntryIds: ["entry-0", "entry-1"] };
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
const compactQuestions = [
  { header: "问题领域", question: "你想问的问题属于哪个领域？", multiSelect: true, options: [
    { label: "代码语法", description: "Java/TS/Vue 等语法、框架用法疑问", preview: "### 语法示例\n保留选择、备注和预览状态。" },
    { label: "业务概念", description: "MES/QMS/WMS 等工业软件业务流程" },
    { label: "报错排查", description: "接口报错、环境问题、日志排查" },
    { label: "技术选型", description: "架构选型、工具对比、技术方案" },
  ] },
  { header: "具体问题", question: "需要哪一种帮助？", multiSelect: false, options: [
    { label: "解释", description: "说明问题和原因" }, { label: "修复", description: "完成具体修改" },
  ] },
];
const polishedQuestion = { header: "下一步", question: "接下来你想做什么？", multiSelect: false, options: [
  { label: "规范 commit message（推荐）", description: "约定 type/scope 格式（如 feat(desktop):），让历史可追溯，便于生成 changelog" },
  { label: "桌面端功能或 bug", description: "整理并检查最近改动过的桌面端文件，或继续修复发现的问题" },
  { label: "检查测试覆盖", description: "抽查桌面端/UI 相关代码的测试覆盖情况，给出改进清单" },
  { label: "其他任务", description: "你有其他想法或问题，直接告诉我" },
] };
const q = (requestId, questions = [officeQuestion], sessionId = "fixture-session") => ({ type: "question_request", requestId, sessionId, toolCallId: `tool-${requestId}`, questions });
const card = () => page.locator('.owl-question-card:visible').last();
const answerRequests = () => result.requests.filter((request) => request.type === "question.response");
const pause = () => page.waitForTimeout(100);
const composer = () => page.locator(".owl-composer-surface");
const environment = () => composer().getByRole("button", { name: "新建项目", exact: true });
async function customInput() {
  const input = card().getByPlaceholder("自由输入…", { exact: true });
  if (!(await input.isVisible())) await card().getByRole("button", { name: "其他", exact: true }).click();
  await input.waitFor({ state: "visible" });
  return input;
}
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
    const composerColumn = composer.querySelector(".max-w-3xl");
    const workbenchNode = document.querySelector(".owl-workbench-shell");
    const workbench = workbenchNode?.getBoundingClientRect().width > 0 && workbenchNode?.getBoundingClientRect().height > 0 ? workbenchNode : null;
    const chat = document.querySelector(".owl-chat-scroll");
    const body = element.querySelector(".owl-question-card__body");
    const options = [...element.querySelectorAll('[role="radio"], [role="checkbox"]')].map(rect);
    const ancestors = []; for (let parent = element; parent; parent = parent.parentElement) ancestors.push({ position: getComputedStyle(parent).position, bg: getComputedStyle(parent).backgroundColor, rect: rect(parent), className: parent.className });
    return { card: rect(element), body: { ...rect(body), clientHeight: body.clientHeight, scrollHeight: body.scrollHeight }, lane: rect(lane), composer: rect(composer), composerColumn: composerColumn ? rect(composerColumn) : null, workbench: workbench ? rect(workbench) : null, chat: rect(chat), options, ancestors, dock: workbench?.dataset.dock, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
  });
}
function assertAnchor(g) {
  assert.ok(g.card.x >= g.lane.x - 1 && g.card.right <= g.lane.right + 1, `Card [${g.card.x},${g.card.right}] exceeds chat lane [${g.lane.x},${g.lane.right}]`);
  assert.ok(Math.abs(g.card.bottom - g.composer.y) <= 20, `Card bottom ${g.card.bottom} should sit immediately above Composer ${g.composer.y}`);
  assert.ok(g.card.y >= g.lane.y - 1, `Card top ${g.card.y} clips chat lane ${g.lane.y}`);
  assert.ok(g.chat.bottom <= g.card.y + 1, `Card overlays chat viewport: chat bottom ${g.chat.bottom}, card top ${g.card.y}`);
  if (g.composerColumn) assert.ok(Math.abs(g.card.x - g.composerColumn.x) <= 1 && Math.abs(g.card.right - g.composerColumn.right) <= 1, "Card horizontal bounds differ from Composer inner column");
  if (g.dock === "right") assert.ok(g.card.right <= g.workbench.x + 1, "Card overlays right Office pane");
  else if (g.workbench) assert.ok(g.card.bottom < g.workbench.y, "Card overlays bottom workbench");
  assert.equal(g.ancestors.some((a) => a.position === "fixed" && a.rect.width >= g.viewport - 2), false, "Fullscreen layer remains");
}
async function cancel() { await card().getByRole("button", { name: "取消", exact: true }).click(); await pause(); }
async function submit() { await card().getByRole("button", { name: "提交回答", exact: true }).click(); await pause(); }
const chatScroll = () => page.locator(".owl-chat-scroll");
async function scrollState() {
  return await chatScroll().evaluate((element) => ({ top: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
}
async function assertChatAtLatest() {
  await page.waitForFunction(() => {
    const element = document.querySelector(".owl-chat-scroll");
    return element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
  });
}
try {
  await page.goto(origin);
  await page.getByRole("textbox", { name: "任务输入", exact: true }).waitFor();
  await page.getByRole("link", { name: "费用测试.univer", exact: true }).first().click();
  await page.waitForSelector(".owl-plugin-viewer iframe");
  await page.locator(".owl-chat-scroll").evaluate((element) => element.scrollTop = element.scrollHeight);
  await emitQuestion("baseline-anchor");
  await caseRun("office-question-is-anchored-above-composer-inside-chat-lane-without-dimmer", async () => {
    const g = await geometry();
    await page.screenshot({ path: join(output, "01-office-dark.png") });
    result.baselineGeometry = g;
    assertAnchor(g);
    return g;
  });
  await cancel();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.locator('.owl-workbench-dock-actions button').nth(2).click(); await pause();
  await emitQuestion("screenshot-question", [polishedQuestion]);
  result.polishedGeometry = await geometry();
  await page.screenshot({ path: join(output, "10-polished-four-options-dark.png") });
  await caseRun("single-question-long-short-options-have-equal-row-heights-and-clear-label-description", async () => {
    const g = await geometry(); assertAnchor(g);
    assert.ok(g.card.height <= 280, `Screenshot question is ${g.card.height}px tall`);
    assert.ok(g.body.scrollHeight <= g.body.clientHeight + 1, `Ordinary four choices should not require body scrolling: ${g.body.scrollHeight}/${g.body.clientHeight}`);
    assert.equal(g.options.length, 4);
    for (const [first, second] of [[0, 1], [2, 3]]) {
      assert.ok(Math.abs(g.options[first].y - g.options[second].y) <= 1, "Options do not share a row");
      assert.ok(Math.abs(g.options[first].height - g.options[second].height) <= 1, "Mixed-length descriptions leave uneven row heights");
      assert.ok(Math.abs(g.options[first].bottom - g.options[second].bottom) <= 1, "Option bottom edges are uneven");
    }
    const text = await card().evaluate((el) => {
      const labels = [...el.querySelectorAll(".owl-question-card__option-label")];
      const descriptions = [...el.querySelectorAll(".owl-question-card__description")];
      return { labels: labels.map((label) => ({ text: label.textContent, fontSize: parseFloat(getComputedStyle(label).fontSize), color: getComputedStyle(label).color })),
        descriptions: descriptions.map((description) => ({ text: description.textContent, fontSize: parseFloat(getComputedStyle(description).fontSize), color: getComputedStyle(description).color, overflow: getComputedStyle(description).overflow, textOverflow: getComputedStyle(description).textOverflow, lineClamp: getComputedStyle(description).webkitLineClamp, width: description.clientWidth, scrollWidth: description.scrollWidth, height: description.clientHeight, scrollHeight: description.scrollHeight })) };
    });
    for (let i = 0; i < 4; i++) {
      assert.equal(text.labels[i].text, polishedQuestion.options[i].label);
      assert.equal(text.descriptions[i].text, polishedQuestion.options[i].description);
      assert.ok(text.labels[i].fontSize >= text.descriptions[i].fontSize);
      assert.notEqual(text.labels[i].color, text.descriptions[i].color, "Label and secondary description need a visible hierarchy");
      assert.ok(text.descriptions[i].scrollWidth <= text.descriptions[i].width + 1 && text.descriptions[i].scrollHeight <= text.descriptions[i].height + 1, "Description is clipped within the option");
      assert.notEqual(text.descriptions[i].textOverflow, "ellipsis");
      assert.ok(text.descriptions[i].lineClamp === "none" || text.descriptions[i].lineClamp === "0");
    }
    assert.ok(g.scrollWidth <= g.viewport);
    return { ...g, text };
  });
  await caseRun("single-question-has-no-full-width-progress-and-optional-fields-start-hidden", async () => {
    const visibleBars = await card().locator('.owl-question-card__progress button[aria-current], .owl-question-card__progress [class*="rounded-full"]').evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().width > 0).map((node) => node.getBoundingClientRect().width));
    assert.deepEqual(visibleBars, [], "Single question should not display progress bars");
    assert.equal(await card().getByPlaceholder("自由输入…", { exact: true }).isVisible(), false);
    assert.equal(await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).isVisible(), false);
    await card().getByRole("button", { name: "其他", exact: true }).waitFor();
    await card().getByRole("button", { name: "＋ 添加备注", exact: true }).waitFor();
  });
  await caseRun("pending-current-question-hides-environment-row-without-hiding-composer-and-mode-model", async () => {
    assert.equal(await environment().count(), 0);
    assert.equal(await composer().locator(".owl-composer-environment").count(), 0);
    assert.equal(await composer().getByRole("textbox", { name: "任务输入", exact: true }).isVisible(), true);
    assert.equal(await composer().getByRole("button", { name: "发送", exact: true }).isVisible(), true);
    await composer().getByRole("button", { name: "标准模式", exact: false }).waitFor();
    await composer().getByRole("button", { name: "test-model", exact: false }).waitFor();
  });
  if (!baselineOnly) {
    await caseRun("optional-other-and-note-buttons-expand-preserve-inputs-and-submit-exact-answer", async () => {
      const input = await customInput(); await input.fill("  先做排版  ");
      await card().getByRole("button", { name: "＋ 添加备注", exact: true }).click();
      await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).fill("  降低视觉干扰  ");
      await card().getByRole("button", { name: "收起", exact: true }).click(); await pause();
      assert.equal(await environment().count(), 0, "Collapsing a pending question must keep the environment row hidden");
      await card().getByRole("button", { name: "展开", exact: true }).click(); await pause();
      assert.equal(await input.inputValue(), "  先做排版  ");
      assert.equal(await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).inputValue(), "  降低视觉干扰  ");
      await page.screenshot({ path: join(output, "11-polished-optional-fields.png") });
      await submit();
      assert.equal(answerRequests().at(-1).requestId, "screenshot-question");
      assert.deepEqual(answerRequests().at(-1).answers, [{ index: 0, customText: "先做排版", note: "降低视觉干扰" }]);
      assert.equal(await environment().isVisible(), true, "Environment should return after submitting");
    });
    await emitQuestion("polished-layout", [polishedQuestion]);
    await caseRun("polished-single-question-light-theme-and-narrow-layout-keep-descriptions-readable", async () => {
      await page.evaluate(() => document.documentElement.setAttribute("data-owl-theme", "light")); await pause();
      assertAnchor(await geometry());
      await page.screenshot({ path: join(output, "12-polished-four-options-light.png") });
      await page.setViewportSize({ width: 760, height: 760 }); await pause();
      const g = await geometry(); assertAnchor(g);
      assert.ok(g.card.width < 560 && g.scrollWidth <= g.viewport);
      for (let i = 1; i < 4; i++) {
        assert.ok(Math.abs(g.options[i].x - g.options[0].x) <= 1);
        assert.ok(g.options[i].y > g.options[i - 1].y);
      }
      await card().getByText(polishedQuestion.options[3].description, { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, "13-polished-four-options-narrow-light.png") });
      await page.evaluate(() => document.documentElement.setAttribute("data-owl-theme", "dark"));
      await page.screenshot({ path: join(output, "14-polished-four-options-narrow-dark.png") });
      return g;
    });
    await page.setViewportSize({ width: 1280, height: 860 }); await pause();
  }
  await cancel();
  if (!baselineOnly) await caseRun("cancelled-question-restores-environment-row-and-ordinary-running-hides-it", async () => {
    assert.equal(await environment().isVisible(), true);
    const draft = composer().getByRole("textbox", { name: "任务输入", exact: true });
    await draft.fill("保留的任务草稿");
    send({ type: "event", sessionId: "fixture-session", event: { type: "agent_start" } }); await pause();
    assert.equal(await environment().count(), 0);
    const stop = composer().getByRole("button", { name: "中止", exact: true });
    assert.equal(await stop.isVisible(), true); await stop.focus();
    assert.equal(await stop.evaluate((el) => el === document.activeElement), true);
    await stop.click(); await pause();
    assert.equal(result.requests.at(-1).type, "session.abort");
    send({ type: "event", sessionId: "fixture-session", event: { type: "agent_settled" } }); await pause();
    assert.equal(await environment().isVisible(), true);
    assert.equal(await draft.inputValue(), "保留的任务草稿"); await draft.fill("");
  });
  await emitQuestion("compact-questionnaire", compactQuestions);
  const compactGeometry = await geometry();
  result.compactGeometry = compactGeometry;
  await page.screenshot({ path: join(output, "05-compact-four-options-dark.png") });
  await caseRun("four-options-two-questions-card-height-is-at-most-280px", async () => {
    assert.ok(compactGeometry.card.height <= 280, `Four-option card is ${compactGeometry.card.height}px tall`);
    return compactGeometry;
  });
  await caseRun("compact-question-occupies-space-and-does-not-overlay-chat-viewport", async () => {
    assertAnchor(compactGeometry);
    assert.ok(compactGeometry.chat.height >= 280, `Insufficient readable chat viewport: ${compactGeometry.chat.height}px`);
    return compactGeometry;
  });
  await caseRun("four-options-use-two-columns-at-wide-card-width", async () => {
    assert.ok(compactGeometry.card.width >= 560);
    assert.equal(compactGeometry.options.length, 4);
    assert.ok(Math.abs(compactGeometry.options[0].y - compactGeometry.options[1].y) <= 1, "First two options should share a row");
    assert.ok(compactGeometry.options[1].x > compactGeometry.options[0].x + compactGeometry.options[0].width, "Second option should occupy a separate column");
    assert.ok(compactGeometry.options[2].y > compactGeometry.options[0].y, "Third option should occupy the second row");
    return { options: compactGeometry.options };
  });
  if (!baselineOnly) {
    await caseRun("folding-and-expanding-question-preserves-latest-message-scroll", async () => {
      await chatScroll().evaluate((element) => element.scrollTop = element.scrollHeight); await pause();
      const before = await scrollState(); assert.ok(before.scrollHeight > before.clientHeight);
      await card().getByRole("button", { name: "收起", exact: true }).click(); await pause();
      const collapsed = await scrollState(); await assertChatAtLatest();
      assert.ok(collapsed.clientHeight > before.clientHeight + 100, "Collapse should return real space to chat messages");
      assert.ok((await geometry()).card.height <= 40, "Collapsed question should occupy a compact single line");
      await page.screenshot({ path: join(output, "09-compact-collapsed.png") });
      await card().getByRole("button", { name: "展开", exact: true }).click(); await pause();
      await assertChatAtLatest();
      const expanded = await scrollState();
      assert.ok(Math.abs(expanded.clientHeight - before.clientHeight) <= 1);
      assertAnchor(await geometry());
      return { before, collapsed, expanded };
    });
    await caseRun("folding-and-expanding-question-preserves-historical-scroll-position", async () => {
      await chatScroll().evaluate((element) => element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 3)); await pause();
      const before = await scrollState(); assert.ok(before.gap > 200);
      await card().getByRole("button", { name: "收起", exact: true }).click(); await pause();
      const collapsed = await scrollState();
      assert.ok(Math.abs(collapsed.top - before.top) <= 1, "Collapsing jumped away from the chosen historical message");
      await card().getByRole("button", { name: "展开", exact: true }).click(); await pause();
      const expanded = await scrollState();
      assert.ok(Math.abs(expanded.top - before.top) <= 1, "Expanding jumped away from the chosen historical message");
      return { before, collapsed, expanded };
    });
    await caseRun("folded-question-hides-controls-keeps-draft-and-native-enter-restores-it", async () => {
      await card().getByRole("checkbox", { name: "代码语法", exact: false }).click();
      await (await customInput()).fill("补充问题");
      await card().getByRole("button", { name: "＋ 添加备注", exact: true }).click();
      await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).fill("保留备注");
      await card().getByRole("button", { name: "预览", exact: true }).click();
      await card().getByRole("button", { name: "下一题", exact: true }).click();
      await card().getByRole("radio", { name: "解释", exact: false }).click();
      await card().getByRole("button", { name: "收起", exact: true }).click(); await pause();
      const count = answerRequests().length;
      assert.equal(await card().locator(".owl-question-card__body").isVisible(), false);
      assert.equal(await card().locator(".owl-question-card__footer").isVisible(), false);
      const expand = card().getByRole("button", { name: "展开", exact: true });
      assert.equal(await expand.getAttribute("aria-expanded"), "false");
      await expand.focus(); await expand.press("Control+Enter"); await expand.press("Meta+Enter"); await pause();
      assert.equal(answerRequests().length, count, "Collapsed shortcuts must not submit or advance");
      assert.equal(await card().getAttribute("data-collapsed"), "true");
      await expand.focus(); await page.keyboard.press("Tab");
      assert.equal(await card().evaluate((element) => [...element.querySelectorAll('.owl-question-card__body *, .owl-question-card__footer *')].includes(document.activeElement)), false, "Tab entered hidden question controls");
      await expand.focus(); await expand.press("Enter"); await pause();
      await card().getByText("需要哪一种帮助？", { exact: true }).waitFor();
      assert.equal(await card().getByRole("radio", { name: "解释", exact: false }).getAttribute("aria-checked"), "true");
      await card().getByRole("button", { name: "上一题", exact: true }).click();
      assert.equal(await card().getByRole("checkbox", { name: "代码语法", exact: false }).getAttribute("aria-checked"), "true");
      assert.equal(await card().getByPlaceholder("自由输入…", { exact: true }).inputValue(), "补充问题");
      assert.equal(await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).inputValue(), "保留备注");
      await card().getByRole("heading", { name: "语法示例", exact: true }).waitFor();
      await cancel(); await emitQuestion("compact-questionnaire-restored", compactQuestions);
      return { answersSentDuringCollapse: answerRequests().length - count - 1 };
    });
    await caseRun("four-options-use-one-column-in-narrow-chat-lane", async () => {
      await page.setViewportSize({ width: 760, height: 760 }); await pause();
      const g = await geometry(); assertAnchor(g);
      assert.ok(g.card.width < 560);
      assert.equal(g.options.length, 4);
      for (let i = 1; i < g.options.length; i++) {
        assert.ok(Math.abs(g.options[i].x - g.options[0].x) <= 1, "Narrow options should share one column");
        assert.ok(g.options[i].y > g.options[i - 1].y, "Narrow options should form separate rows");
      }
      await page.screenshot({ path: join(output, "06-compact-four-options-narrow.png") });
      return g;
    });
    await page.setViewportSize({ width: 1280, height: 860 }); await pause();
    await caseRun("compact-question-light-theme-preserves-chat-and-form-alignment", async () => {
      await page.evaluate(() => document.documentElement.setAttribute("data-owl-theme", "light")); await pause();
      const g = await geometry(); assertAnchor(g);
      assert.ok(g.card.height <= 280);
      await page.screenshot({ path: join(output, "07-compact-four-options-light.png") });
      await page.evaluate(() => document.documentElement.setAttribute("data-owl-theme", "dark"));
      return g;
    });
    await cancel();
    const longDescription = "这是需要完整查看的选项说明。".repeat(90) + "完整说明末尾：保持全部描述。";
    await emitQuestion("long-description", [{ ...compactQuestions[0], options: compactQuestions[0].options.map((option, i) => i === 3 ? { ...option, description: longDescription } : option) }]);
    await caseRun("long-option-description-is-complete-and-scrollable-with-footer-visible", async () => {
      const description = card().getByText(longDescription, { exact: true });
      const details = await description.evaluate((element) => {
        const card = element.closest(".owl-question-card");
        const body = card.querySelector(".owl-question-card__body");
        const range = document.createRange();
        const text = element.firstChild;
        range.setStart(text, text.textContent.length - 12); range.setEnd(text, text.textContent.length);
        const before = range.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        body.scrollTop += before.bottom - bodyRect.bottom + 8;
        const tail = range.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        const footer = card.querySelector(".owl-question-card__footer").getBoundingClientRect();
        return { description: { top: rect.top, bottom: rect.bottom }, body: { top: bodyRect.top, bottom: bodyRect.bottom, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight }, tail: { top: tail.top, bottom: tail.bottom }, footer: { top: footer.top, bottom: footer.bottom }, cardBottom: card.getBoundingClientRect().bottom };
      });
      assert.ok(details.body.scrollHeight > details.body.clientHeight, "Long description should produce a scrollable question body");
      assert.ok(details.tail.top >= details.body.top && details.tail.bottom <= details.body.bottom, "Description tail cannot be read by scrolling");
      assert.ok(details.description.bottom >= details.tail.bottom - 1, "Description is truncated inside its own option");
      assert.ok(details.footer.bottom <= details.cardBottom + 1, "Footer is clipped");
      assertAnchor(await geometry());
      await page.screenshot({ path: join(output, "08-complete-long-description.png") });
      return details;
    });
    await cancel();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.getByRole("link", { name: "费用测试.univer", exact: true }).first().click(); await pause();
    await emitQuestion("baseline-anchor"); await cancel();
    await caseRun("single-office-question-cancels-with-accurate-wire-id", async () => {
      const answer = answerRequests().at(-1);
      assert.equal(answer.requestId, "baseline-anchor");
      assert.deepEqual(answer.answers, []);
      assert.equal(answer.cancelled, true);
      return { response: answer };
    });
    await emitQuestion("office-confirm");
    await caseRun("unanswered-submit-stays-in-card-and-does-not-send-response", async () => {
      const count = answerRequests().length;
      await submit();
      await card().getByText("先答这道题：选一个选项，或在「其他」里输入", { exact: true }).waitFor();
      assert.equal(answerRequests().length, count);
    });
    await caseRun("office-remains-readable-and-clickable-with-question-open", async () => {
      const iframe = page.frameLocator(".owl-plugin-viewer iframe");
      await iframe.locator("#office-action").click();
      assert.equal(await iframe.locator("body").getAttribute("data-clicked"), "yes");
    });
    await caseRun("outside-card-escape-and-control-enter-do-not-cancel-or-submit", async () => {
      const count = answerRequests().length;
      const input = page.getByRole("textbox", { name: "任务输入", exact: true });
      await input.focus(); await input.press("Escape"); await input.press("Control+Enter"); await pause();
      assert.equal(answerRequests().length, count);
      assert.ok(await card().isVisible());
    });
    await caseRun("single-choice-replaces-previous-choice-and-submits-wire-answer", async () => {
      await card().getByText("暂不处理", { exact: true }).click();
      await card().getByText("确认合入", { exact: true }).click();
      await submit();
      const answer = answerRequests().at(-1);
      assert.equal(answer.requestId, "office-confirm");
      assert.deepEqual(answer.answers, [{ index: 0, selectedLabels: ["确认合入"] }]);
      assert.equal(answer.cancelled, undefined);
      return { response: answer };
    });
    const questionnaire = [
      { header: "输出", question: "选择导出格式", multiSelect: false, options: [
        { label: "Excel", description: "导出可编辑表格", preview: "### Excel 预览\n金额 **360**\n\n<script>alert('unsafe')</script>" },
        { label: "PDF", description: "导出打印版" }] },
      { header: "内容", question: "选择需要交付的内容", multiSelect: true, options: [
        { label: "表格", description: "费用明细", preview: "### 表格预览\n- 设备：300\n- 耗材：60" },
        { label: "说明", description: "公式与口径" }, { label: "图表", description: "费用分布" }] },
      { header: "文件", question: "保留源文件吗？", multiSelect: false, options: [
        { label: "保留", description: "保留费用测试.univer" }, { label: "移除", description: "只保留交付文件" }] },
    ];
    await emitQuestion("three-questions", questionnaire);
    await caseRun("single-option-preview-and-custom-note-survive-next-previous", async () => {
      await card().getByText("Excel", { exact: true }).click();
      await card().getByRole("heading", { name: "Excel 预览" }).waitFor();
      assert.equal(await card().locator("script").count(), 0);
      await (await customInput()).fill("  CSV  ");
      await card().getByRole("button", { name: "＋ 添加备注", exact: true }).click();
      await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).fill("  便于导入  ");
      await card().getByRole("button", { name: "下一题", exact: true }).click();
      await card().getByRole("button", { name: "上一题", exact: true }).click();
      assert.equal(await card().getByPlaceholder("自由输入…", { exact: true }).inputValue(), "  CSV  ");
      assert.equal(await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).inputValue(), "  便于导入  ");
      assert.equal(await card().getByRole("heading", { name: "Excel 预览" }).count(), 0);
      await card().getByRole("button", { name: "下一题", exact: true }).click();
    });
    await caseRun("multi-select-preview-keyboard-enter-does-not-select-and-toggle-custom-note-are-preserved", async () => {
      const preview = card().getByRole("button", { name: "预览", exact: true });
      await preview.focus(); await preview.press("Enter");
      await card().getByRole("heading", { name: "表格预览" }).waitFor();
      assert.match(await card().locator(".owl-question-card__count").innerText(), /已答 1\/3/);
      await card().getByText("表格", { exact: true }).click();
      await card().getByText("说明", { exact: true }).click();
      await card().getByText("图表", { exact: true }).click();
      await card().getByText("图表", { exact: true }).click();
      await (await customInput()).fill("  CSV 校验  ");
      await card().getByRole("button", { name: "＋ 添加备注", exact: true }).click();
      await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).fill("  中文字段  ");
      await card().getByRole("button", { name: "下一题", exact: true }).click();
      await card().getByRole("button", { name: "上一题", exact: true }).click();
      assert.equal(await card().getByPlaceholder("自由输入…", { exact: true }).inputValue(), "  CSV 校验  ");
      await card().getByRole("button", { name: "下一题", exact: true }).click();
    });
    await caseRun("three-answers-submit-with-trimmed-custom-notes-and-exact-indices", async () => {
      await card().getByText("保留", { exact: true }).click();
      await submit();
      const answer = answerRequests().at(-1);
      assert.equal(answer.requestId, "three-questions");
      assert.deepEqual(answer.answers, [
        { index: 0, customText: "CSV", note: "便于导入" },
        { index: 1, selectedLabels: ["表格", "说明"], customText: "CSV 校验", note: "中文字段" },
        { index: 2, selectedLabels: ["保留"] },
      ]);
      return { response: answer };
    });
    await emitQuestion("skipped-question", questionnaire);
    await caseRun("final-submit-jumps-to-first-unanswered-question", async () => {
      await card().getByRole("button", { name: "第 3 / 3 题", exact: true }).click();
      await card().getByText("保留", { exact: true }).click();
      const count = answerRequests().length;
      await submit();
      assert.equal(answerRequests().length, count);
      await card().getByText("选择导出格式", { exact: true }).waitFor();
      await card().getByText("先答这道题：选一个选项，或在「其他」里输入", { exact: true }).waitFor();
      await cancel();
    });
    await emitQuestion("keyboard-submit");
    await caseRun("control-enter-inside-question-card-submits-selected-answer", async () => {
      await card().getByText("确认合入", { exact: true }).click();
      await (await customInput()).press("Control+Enter"); await pause();
      assert.equal(answerRequests().at(-1).requestId, "keyboard-submit");
      assert.deepEqual(answerRequests().at(-1).answers, [{ index: 0, selectedLabels: ["确认合入"] }]);
    });
    await emitQuestion("keyboard-cancel");
    await caseRun("escape-inside-question-card-cancels", async () => {
      await (await customInput()).press("Escape"); await pause();
      assert.equal(answerRequests().at(-1).requestId, "keyboard-cancel");
      assert.equal(answerRequests().at(-1).cancelled, true);
    });
    await emitQuestion("mouse-focus-shortcut");
    await caseRun("mouse-option-selection-focuses-card-so-control-enter-can-submit-directly", async () => {
      await card().getByRole("radio", { name: "确认合入", exact: false }).click();
      assert.equal(await card().getByRole("radio", { name: "确认合入", exact: false }).evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press("Control+Enter"); await pause();
      assert.equal(answerRequests().at(-1).requestId, "mouse-focus-shortcut");
      assert.deepEqual(answerRequests().at(-1).answers, [{ index: 0, selectedLabels: ["确认合入"] }]);
    });
    await emitQuestion("keyboard-option-controls", questionnaire);
    await caseRun("keyboard-space-radio-enter-checkbox-and-meta-enter-advance-and-submit", async () => {
      const excel = card().getByRole("radio", { name: "Excel", exact: false });
      await excel.focus(); await excel.press("Space");
      assert.equal(await excel.getAttribute("aria-checked"), "true");
      await excel.press("Control+Enter");
      const table = card().getByRole("checkbox", { name: "表格", exact: false });
      await table.focus(); await table.press("Space");
      const explanation = card().getByRole("checkbox", { name: "说明", exact: false });
      await explanation.focus(); await explanation.press("Enter");
      assert.equal(await table.getAttribute("aria-checked"), "true");
      assert.equal(await explanation.getAttribute("aria-checked"), "true");
      await explanation.press("Control+Enter");
      const preserve = card().getByRole("radio", { name: "保留", exact: false });
      await preserve.focus(); await preserve.press("Enter"); await preserve.press("Meta+Enter"); await pause();
      assert.equal(answerRequests().at(-1).requestId, "keyboard-option-controls");
      assert.deepEqual(answerRequests().at(-1).answers, [
        { index: 0, selectedLabels: ["Excel"] }, { index: 1, selectedLabels: ["表格", "说明"] }, { index: 2, selectedLabels: ["保留"] },
      ]);
    });
    await emitQuestion("queue-first", questionnaire);
    send(q("queue-second")); await pause();
    await caseRun("queued-request-id-resets-current-question-options-custom-note-and-preview", async () => {
      await card().getByText("Excel", { exact: true }).click();
      await card().getByRole("button", { name: "＋ 添加备注", exact: true }).click();
      await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).fill("old note");
      await card().getByRole("button", { name: "下一题", exact: true }).click();
      await (await customInput()).fill("old custom");
      await cancel();
      await card().getByText(officeQuestion.question, { exact: true }).waitFor();
      assert.equal(await card().getByPlaceholder("自由输入…", { exact: true }).isVisible(), false, "New request must reset the optional input's expanded state");
      assert.equal(await (await customInput()).inputValue(), "");
      assert.equal(await card().locator("textarea").count(), 0);
      assert.match(await card().locator(".owl-question-card__count").innerText(), /已答 0\/1/);
      await card().getByText("暂不处理", { exact: true }).click(); await submit();
      assert.equal(answerRequests().at(-2).requestId, "queue-first");
      assert.equal(answerRequests().at(-2).cancelled, true);
      assert.equal(answerRequests().at(-1).requestId, "queue-second");
      assert.deepEqual(answerRequests().at(-1).answers, [{ index: 0, selectedLabels: ["暂不处理"] }]);
    });
    await caseRun("background-question-does-not-cover-current-session-and-is-preserved-after-current-answer", async () => {
      send(q("background-request", [{ ...officeQuestion, question: "后台会话：是否保留草稿？" }], "other-session")); await pause();
      assert.equal(await card().count(), 0);
      await emitQuestion("current-ahead-of-background");
      await card().getByText(officeQuestion.question, { exact: true }).waitFor();
      await card().getByText("确认合入", { exact: true }).click(); await submit();
      assert.equal(answerRequests().at(-1).requestId, "current-ahead-of-background");
      assert.equal(await card().count(), 0);
      assert.equal(answerRequests().some((a) => a.requestId === "background-request"), false);
      await page.getByRole("button", { name: "后台问题会话", exact: false }).first().click(); await pause();
      await card().getByText("后台会话：是否保留草稿？", { exact: true }).waitFor();
      await cancel();
      assert.equal(answerRequests().at(-1).requestId, "background-request");
      assert.equal(answerRequests().at(-1).cancelled, true);
      await page.getByRole("button", { name: "费用测试审阅", exact: false }).first().click(); await pause();
    });
    await emitQuestion("preserved-draft", questionnaire);
    await caseRun("partial-answer-current-step-note-and-preview-survive-session-switch", async () => {
      await (await customInput()).fill("draft format");
      await card().getByRole("button", { name: "＋ 添加备注", exact: true }).click();
      await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).fill("draft note");
      await card().getByRole("button", { name: "下一题", exact: true }).click();
      await card().getByText("表格", { exact: true }).click();
      await card().getByRole("button", { name: "预览", exact: true }).click();
      send(q("preserved-background", [{ ...officeQuestion, question: "后台另一个问题" }], "other-session")); await pause();
      await page.getByRole("button", { name: "后台问题会话", exact: false }).first().click(); await pause();
      await card().getByText("后台另一个问题", { exact: true }).waitFor();
      await page.getByRole("button", { name: "费用测试审阅", exact: false }).first().click(); await pause();
      await card().getByText("选择需要交付的内容", { exact: true }).waitFor();
      await card().getByRole("heading", { name: "表格预览" }).waitFor();
      assert.equal(await card().getByRole("checkbox", { name: "表格", exact: true }).getAttribute("aria-checked"), "true");
      await card().getByRole("button", { name: "上一题", exact: true }).click();
      assert.equal(await card().getByPlaceholder("自由输入…", { exact: true }).inputValue(), "draft format");
      assert.equal(await card().getByPlaceholder("给这道题补充说明（随答案一起回给 agent）…", { exact: true }).inputValue(), "draft note");
      await cancel();
      await page.getByRole("button", { name: "后台问题会话", exact: false }).first().click(); await pause();
      await card().getByText("后台另一个问题", { exact: true }).waitFor(); await cancel();
      await page.getByRole("button", { name: "费用测试审阅", exact: false }).first().click(); await pause();
    });
    await emitQuestion("layout-matrix");
    for (const width of [1920, 1280, 960, 760]) {
      await page.setViewportSize({ width, height: width === 760 ? 760 : 1080 });
      if (width === 960) await page.locator(".owl-desktop-sidebar-toggle").click();
      if (width === 760) {
        const handle = await page.locator('[data-workbench-size-handle="right"]').boundingBox();
        await page.mouse.move(handle.x + 3, handle.y + 80); await page.mouse.down(); await page.mouse.move(handle.x + 173, handle.y + 80, { steps: 5 }); await page.mouse.up();
      }
      await pause();
      await caseRun(`right-dock-card-follows-chat-lane-at-${width}px`, async () => {
        const g = await geometry(); assertAnchor(g);
        const footer = await card().locator(".owl-question-card__footer").boundingBox();
        assert.ok(footer.y + footer.height <= g.card.bottom + 1);
        await page.screenshot({ path: join(output, `layout-right-${width}.png`) });
        return g;
      });
    }
    await page.setViewportSize({ width: 1280, height: 1080 }); await pause();
    await caseRun("light-theme-card-retains-contrast-and-anchor", async () => {
      await page.evaluate(() => document.documentElement.setAttribute("data-owl-theme", "light"));
      await page.waitForTimeout(250);
      const g = await geometry(); assertAnchor(g);
      const colors = await card().evaluate((el) => {
        const label = [...el.querySelectorAll("span")].find((node) => node.textContent === "确认合入");
        const ancestors = []; for (let node = label; node; node = node.parentElement) ancestors.push({ tag: node.tagName, className: node.className, color: getComputedStyle(node).color, textVar: getComputedStyle(node).getPropertyValue("--color-owl-text") });
        return { background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, labelAncestors: ancestors };
      });
      assert.notEqual(colors.background, colors.color);
      assert.equal(colors.labelAncestors[0].color, colors.color, "Option label should retain readable light-theme color after its transition");
      await page.screenshot({ path: join(output, "02-office-light.png") });
      return { ...g, colors };
    });
    await caseRun("bottom-dock-card-stays-above-composer-and-does-not-cover-workbench", async () => {
      await page.locator('.owl-workbench-dock-actions button').nth(1).click(); await pause();
      const g = await geometry(); assertAnchor(g);
      assert.equal(g.dock, "bottom");
      await page.screenshot({ path: join(output, "03-office-bottom.png") });
      return g;
    });
    await caseRun("bottom-dock-height-drag-keeps-question-footer-visible", async () => {
      const before = await geometry();
      const handle = await page.locator('[data-workbench-size-handle="bottom"]').boundingBox();
      await page.mouse.move(handle.x + 100, handle.y + 3); await page.mouse.down(); await page.mouse.move(handle.x + 100, handle.y - 230, { steps: 5 }); await page.mouse.up(); await pause();
      const g = await geometry(); assertAnchor(g);
      const sizing = await page.locator(".owl-workbench-shell").evaluate((element) => {
        const content = document.querySelector(".owl-shell-content");
        const reserved = Number.parseFloat(getComputedStyle(content).getPropertyValue("--owl-question-chat-min-height"));
        return { requested: Number.parseFloat(element.style.height), max: content.getBoundingClientRect().height - reserved, computedMax: getComputedStyle(element).maxHeight };
      });
      result.bottomHeightDrag = { ...g, beforeWorkbenchHeight: before.workbench.height, sizing };
      assert.ok(sizing.requested >= before.workbench.height + 200, "Bottom drag did not request the expected height");
      assert.ok(g.workbench.height >= before.workbench.height + 100, "Bottom workbench height did not change after drag");
      assert.ok(Math.abs(g.workbench.height - Math.min(sizing.requested, sizing.max)) <= 1, "Bottom workbench did not respect available chat space");
      const body = await card().locator(".owl-question-card__body").evaluate((el) => ({ clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }));
      await card().getByText("确认合入", { exact: true }).click(); await submit();
      assert.equal(answerRequests().at(-1).requestId, "layout-matrix");
      return { ...g, beforeWorkbenchHeight: before.workbench.height, sizing, body };
    });
    if (await card().count()) await cancel();
    await page.setViewportSize({ width: 1280, height: 720 });
    await emitQuestion("short-bottom", [{ ...officeQuestion, question: officeQuestion.question + " 以下是审阅说明。".repeat(20) }]);
    await caseRun("short-window-max-bottom-drag-retains-scrollable-question-and-clickable-submit", async () => {
      const handle = await page.locator('[data-workbench-size-handle="bottom"]').boundingBox();
      await page.mouse.move(handle.x + 100, handle.y + 3); await page.mouse.down(); await page.mouse.move(handle.x + 100, 5, { steps: 5 }); await page.mouse.up(); await pause();
      const details = await card().evaluate((el) => {
        const rect = el.getBoundingClientRect(); const body = el.querySelector(".owl-question-card__body"); const submit = el.querySelector(".owl-question-card__footer").getBoundingClientRect();
        return { cardHeight: rect.height, bodyHeight: body.clientHeight, bodyScroll: body.scrollHeight, footer: { y: submit.y, height: submit.height } };
      });
      result.shortWindowBottom = details;
      assert.ok(details.cardHeight >= 150 && details.bodyHeight > 40, `Question collapsed after maximum bottom drag: ${JSON.stringify(details)}`);
      assert.ok(details.bodyScroll > details.bodyHeight, "Long question body should scroll in short window");
      const g = await geometry(); assertAnchor(g);
      await card().getByText("确认合入", { exact: true }).click(); await submit();
      assert.equal(answerRequests().at(-1).requestId, "short-bottom");
      await page.screenshot({ path: join(output, "04-office-short-bottom.png") });
      return { ...g, details };
    });
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
