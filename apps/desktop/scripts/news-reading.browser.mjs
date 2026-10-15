import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "esbuild";
import pw from "playwright-core";

const scripts = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scripts, "../../..");
const output = resolve(process.argv[2] ?? join(repo, ".validation/news-ready"));
const temporary = await mkdtemp(join(tmpdir(), "owl-news-browser-"));
await mkdir(output, { recursive: true });
const result = { actualNewsComponent: true, isolatedBridge: true, paidCalls: 0, cases: [], errors: [] };
const executablePath = [
	process.env.OWL_BROWSER_TEST_EXECUTABLE,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((path) => path && existsSync(path));
assert.ok(executablePath, "Installed Chromium browser required");
await build({
	entryPoints: [join(scripts, "fixtures/news-reading.mjs")],
	outfile: join(temporary, "app.js"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	define: { "process.env.NODE_ENV": '"production"' },
});
const compiled = await compile(await readFile(join(repo, "apps/desktop/src/index.css"), "utf8"), {
	base: join(repo, "apps/desktop/src"),
	onDependency() {},
});
const scanner = new Scanner({
	sources: [{ base: join(repo, "apps/desktop/src"), pattern: "**/*.{ts,tsx}", negated: false }],
});
const css =
	compiled.build(scanner.scan()) +
	(await readFile(join(temporary, "app.css"), "utf8")) +
	"html,body,#root{height:100%;margin:0}#root{display:flex;padding-top:28px}#fixture-label{position:fixed;top:0;left:0;right:0;height:28px;padding:4px 16px;font-size:11px;background:var(--owl-ui-sidebar);color:var(--owl-ui-muted);z-index:20}.owl-news-module{height:100%}";
const js = await readFile(join(temporary, "app.js"));
const server = createServer((request, response) => {
	response.setHeader(
		"Content-Type",
		request.url === "/app.js"
			? "text/javascript"
			: request.url === "/app.css"
				? "text/css"
				: "text/html; charset=utf-8",
	);
	response.end(
		request.url === "/app.js"
			? js
			: request.url === "/app.css"
				? css
				: '<!doctype html><html data-owl-theme="light" data-owl-preset="codex" lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body class="owl-desktop-shell"><div id="fixture-label">Owl 资讯 · 隔离 UI 验收 · 测试内容不会写入用户数据库</div><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
	);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await pw.chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
page.on("pageerror", (error) => result.errors.push(error.message));
async function check(name, fn) {
	await fn();
	result.cases.push(name);
}
try {
	await page.goto(`http://127.0.0.1:${server.address().port}`);
	await page.getByText("测试资讯：公开来源可以直接阅读", { exact: true }).waitFor();
	await check("latest feed opens without setup or assistant", async () => {
		assert.equal(await page.locator('.owl-news-sidebar button[aria-current="page"]').innerText(), "最新资讯");
		assert.equal(await page.locator(".owl-news-assistant").isVisible(), false);
		assert.equal(await page.locator(".owl-news-sidebar details").getAttribute("open"), null);
		assert.ok(
			await page.evaluate(() =>
				window.newsHarness.calls.some((call) => call.request?.action === "ready" && call.request.force === false),
			),
		);
	});
	await page.screenshot({ path: join(output, "news-latest-desktop.png") });
	await check("manual news update reaches the collector", async () => {
		await page.getByRole("button", { name: "更新资讯", exact: true }).first().click();
		assert.ok(
			await page.evaluate(() =>
				window.newsHarness.calls.some((call) => call.request?.action === "ready" && call.request.force === true),
			),
		);
	});
	await page.locator(".owl-news-sidebar").getByRole("button", { name: "模型排行榜", exact: true }).click();
	await page.getByRole("rowheader", { name: "测试模型 Alpha Test Lab" }).waitFor();
	await check("leaderboard supports rank-preserving search and source links", async () => {
		assert.equal(await page.locator(".owl-leaderboard tbody tr").count(), 20);
		await page.getByRole("searchbox").fill("Alpha");
		assert.equal(await page.locator(".owl-leaderboard tbody tr").count(), 1);
		await page.getByRole("searchbox").fill("");
		await page.getByRole("button", { name: "显示全部 (25)", exact: true }).click();
		assert.equal(await page.locator(".owl-leaderboard tbody tr").count(), 25);
		await page.getByRole("button", { name: "查看官方榜单", exact: true }).click();
		assert.ok(await page.evaluate(() => window.newsHarness.calls.some((call) => call.type === "open.external")));
	});
	await check("failed refresh retains the previous ranking and reveals stale status", async () => {
		await page.evaluate(() => window.newsHarness.setStale(true));
		await page.getByRole("button", { name: "同步榜单", exact: true }).click();
		await page.getByText("本次同步未成功，保留上次结果", { exact: true }).waitFor();
		assert.equal(await page.locator(".owl-leaderboard tbody tr").count(), 25);
		await page.evaluate(() => {
			window.newsHarness.setStale(false);
			window.newsHarness.setFailure(true);
		});
		await page.getByRole("button", { name: "同步榜单", exact: true }).click();
		await page.getByText("模拟断网：连接失败", { exact: false }).waitFor();
		assert.equal(await page.locator(".owl-leaderboard tbody tr").count(), 25);
		await page.evaluate(() => window.newsHarness.setFailure(false));
		await page.getByRole("button", { name: "同步榜单", exact: true }).click();
		await page.getByText("已同步 · 测试来源", { exact: true }).waitFor();
	});
	const capture = join(output, "leaderboard-live.json");
	if (existsSync(capture)) {
		await page.evaluate(
			(value) => window.newsHarness.setLeaderboard(value),
			JSON.parse(await readFile(capture, "utf8")),
		);
		await page.getByRole("button", { name: "同步榜单", exact: true }).click();
		await page.getByText("已同步 · 测试来源", { exact: true }).waitFor({ state: "hidden" });
	}
	await page.screenshot({ path: join(output, "leaderboard-desktop.png") });
	await check("compact viewport keeps all primary controls inside the page", async () => {
		await page.setViewportSize({ width: 900, height: 800 });
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
		await page.getByRole("searchbox").fill("no matching model");
		await page.getByText("没有匹配的模型", { exact: true }).waitFor();
		await page.getByRole("button", { name: "清空搜索", exact: true }).click();
	});
	await page.screenshot({ path: join(output, "leaderboard-compact.png") });
	await check("English labels update without losing board data", async () => {
		await page.evaluate(() => window.newsHarness.setUiLanguage("en"));
		await page.getByRole("heading", { name: "Model leaderboards", exact: true }).waitFor();
		assert.ok((await page.locator(".owl-leaderboard tbody tr").count()) > 0);
	});
	assert.deepEqual(result.errors, []);
} catch (error) {
	result.errors.push(error.stack ?? String(error));
	await page.screenshot({ path: join(output, "failure.png") });
	process.exitCode = 1;
} finally {
	await writeFile(join(output, "browser-results.json"), JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
	await rm(temporary, { recursive: true, force: true });
}
