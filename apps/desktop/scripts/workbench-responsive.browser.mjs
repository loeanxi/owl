import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "esbuild";
import pw from "playwright-core";

// Production sidebar/workbench and CSS, isolated fake bridge; no app or provider is contacted.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const output = resolve(process.argv[2] ?? "D:/owl/.validation/short-drama-responsive/layout");
const browserPath = [process.env.OWL_BROWSER_TEST_EXECUTABLE,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium",
].find((candidate) => candidate && existsSync(candidate));
assert.ok(browserPath, "Set OWL_BROWSER_TEST_EXECUTABLE to an installed Chromium browser.");
await mkdir(output, { recursive: true });
const bundled = await build({
	entryPoints: [join(scriptDir, "fixtures/workbench-responsive.mjs")],
	outfile: join(output, "fixture.js"), bundle: true, platform: "browser", format: "esm",
	jsx: "automatic", minify: true, write: false, define: { "process.env.NODE_ENV": '"production"' },
	loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
	metafile: true,
});
for (const expected of ["SessionSidebar.tsx", "Workbench.tsx", "desktop-shell.css"])
	assert.ok(Object.keys(bundled.metafile.inputs).some((path) => path.endsWith(expected)), `Missing real ${expected}`);
const cssSource = join(repo, "apps/desktop/src/index.css");
const compiler = await compile(await readFile(cssSource, "utf8"), { base: dirname(cssSource), onDependency: () => {} });
const scanner = new Scanner({ sources: [{ base: join(repo, "apps/desktop/src"), pattern: "**/*.{ts,tsx}", negated: false }] });
const css = `${compiler.build(scanner.scan())}\n${bundled.outputFiles.find((file) => file.path.endsWith(".css")).text}\nhtml,body,#root{margin:0;height:100%}.test-message{padding:16px;flex:1;overflow:auto}.test-composer{min-height:70px;min-width:0;width:calc(100% - 24px);margin:12px;resize:none;padding:10px;border:1px solid #666}.test-video{height:100%;display:grid;place-items:center;background:#000;color:#eee;text-align:center;padding:12px}`;
const javascript = bundled.outputFiles.find((file) => file.path.endsWith(".js")).text;
const html = '<!doctype html><html data-owl-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>';
const server = createServer((request, response) => {
	response.writeHead(200, { "content-type": request.url === "/test.js" ? "text/javascript" : request.url === "/test.css" ? "text/css" : "text/html; charset=utf-8" });
	response.end(request.url === "/test.js" ? javascript : request.url === "/test.css" ? css : html);
});
await new Promise((listen) => server.listen(0, "127.0.0.1", listen));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
const result = { success: false, browserPath, cases: [], errors: [] };
const pause = () => new Promise((resume) => setTimeout(resume, 120));
async function geometry(page) {
	await pause();
	return page.evaluate(() => {
		const rect = (selector) => {
			const element = document.querySelector(selector);
			const box = element.getBoundingClientRect();
			return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
		};
		return {
			sidebar: rect(".owl-sidebar"), chat: rect(".owl-shell-conversation"),
			main: rect(".owl-shell-content"), tool: rect('.owl-workbench-shell[data-layout="tools"]'),
			composer: rect(".test-composer"), dock: document.querySelector('.owl-workbench-shell[data-layout="tools"]').dataset.dock,
			savedSidebar: localStorage.getItem("owl.sidebar.width"), savedWorkbench: localStorage.getItem("owl.workbench.width"),
		};
	});
}
function assertUsable(box, viewport) {
	assert.ok(box.chat.width >= 319, `Chat crushed to ${box.chat.width}px`);
	assert.ok(box.chat.height >= 179, `Chat height crushed to ${box.chat.height}px`);
	assert.ok(box.composer.width >= 295, `Composer crushed to ${box.composer.width}px`);
	assert.ok(box.tool.x >= box.main.x - 1 && box.tool.right <= viewport.width + 1, "Workbench escaped available workspace");
	assert.ok(box.tool.height > 100 && box.tool.bottom <= box.main.bottom + 1, "Workbench escaped workspace vertically");
	const overlaps = box.chat.x < box.tool.right - 1 && box.chat.right > box.tool.x + 1 && box.chat.y < box.tool.bottom - 1 && box.chat.bottom > box.tool.y + 1;
	assert.equal(overlaps, false, "Chat overlaps workbench");
}
try {
	for (const scenario of [
		{ name: "1280-restored-oversized-panes", width: 1280, height: 860, sidebar: 720, workbench: 950 },
		{ name: "1920-restored-oversized-panes", width: 1920, height: 1032, sidebar: 720, workbench: 950 },
		{ name: "1280-default-panes", width: 1280, height: 860, sidebar: 226, workbench: 380 },
		{ name: "800-compact-window", width: 800, height: 600, sidebar: 720, workbench: 950 },
	]) {
		const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height } });
		page.on("pageerror", (error) => result.errors.push(error.message));
		await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
		const entry = { name: scenario.name, success: false };
		try {
			await page.goto(`${origin}/?sidebar=${scenario.sidebar}&workbench=${scenario.workbench}`);
			await page.waitForSelector(".test-video");
			entry.geometry = await geometry(page);
			await page.screenshot({ path: join(output, `${scenario.name}.png`) });
			assertUsable(entry.geometry, scenario);
			assert.equal(entry.geometry.savedSidebar, String(scenario.sidebar), "Automatic fitting overwrote sidebar preference");
			assert.equal(entry.geometry.savedWorkbench, String(scenario.workbench), "Automatic fitting overwrote workbench preference");
			if (scenario.width === 800) {
				assert.equal(entry.geometry.dock, "bottom", "Compact workspace did not stack");
				assert.equal(entry.geometry.tool.height, 334, "Compact drama did not use the available height");
				await page.evaluate(() => localStorage.setItem("owl.workbench.compactHeight", "260"));
				await page.reload();
				assert.equal((await geometry(page)).tool.height, 260, "Automatic drama sizing replaced the explicit height preference");
				await page.evaluate(() => localStorage.removeItem("owl.workbench.compactHeight"));
				await page.reload();
			}
			else assert.equal(entry.geometry.dock, "right", "Desktop workspace unexpectedly stacked");
			await page.evaluate(() => window.responsiveHarness.setTerminalOpen(true));
			assertUsable(await geometry(page), scenario);
			await page.evaluate(() => window.responsiveHarness.setTerminalOpen(false));
			await page.setViewportSize({ width: 960, height: 720 });
			assertUsable(await geometry(page), { width: 960 });
			await page.setViewportSize({ width: 1920, height: 1032 });
			const restored = await geometry(page);
			assertUsable(restored, { width: 1920 });
			assert.equal(restored.sidebar.width, scenario.sidebar, "Widening did not restore sidebar preference");
			await page.setViewportSize({ width: 1280, height: 860 });
			await page.evaluate(() => window.responsiveHarness.setOpen(false));
			assert.equal((await geometry(page)).sidebar.width, scenario.sidebar, "Closing tools did not release sidebar reserve");
			await page.evaluate(() => window.responsiveHarness.setOpen(true));
			assertUsable(await geometry(page), { width: 1280 });
			await page.setViewportSize({ width: 1920, height: 1032 });
			await page.evaluate(() => window.responsiveHarness.setMinimized(true));
			const collapsed = await geometry(page);
			assertUsable(collapsed, { width: 1920 });
			assert.equal(collapsed.tool.width, scenario.workbench, "Collapsing navigation did not restore workbench preference");
			entry.success = true;
		} catch (error) { entry.failure = error.message; }
		finally { await page.close(); }
		result.cases.push(entry);
		process.stdout.write(`${entry.success ? "PASS" : "FAIL"} ${entry.name}${entry.failure ? `: ${entry.failure}` : ""}\n`);
	}
	for (const viewport of [{ width: 1280, height: 860 }, { width: 800, height: 600 }]) {
		const page = await browser.newPage({ viewport });
		page.on("pageerror", (error) => result.errors.push(error.message));
		const entry = { name: `${viewport.width}-pane-drag-and-reset`, success: false };
		try {
			await page.goto(`${origin}/?sidebar=226&workbench=380`);
			await page.waitForSelector(".test-video");
			const handle = page.locator('.owl-workbench-shell[data-layout="tools"] > [data-workbench-size-handle]');
			const handleBox = await handle.boundingBox();
			const before = await geometry(page);
			const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
			await page.mouse.move(start.x, start.y);
			await page.mouse.down();
			await page.mouse.move(before.dock === "right" ? before.main.x : start.x, before.dock === "bottom" ? before.main.y : start.y, { steps: 10 });
			await page.mouse.up();
			assertUsable(await geometry(page), viewport);
			assert.equal(await page.locator("[data-workbench-drag-shield]").count(), 0);
			const sidebarHandle = await page.locator(".owl-sidebar-resizer").boundingBox();
			await page.mouse.move(sidebarHandle.x + sidebarHandle.width / 2, sidebarHandle.y + 100);
			await page.mouse.down();
			await page.mouse.move(viewport.width - 50, sidebarHandle.y + 100, { steps: 10 });
			await page.mouse.up();
			assertUsable(await geometry(page), viewport);
			await page.locator(".owl-sidebar-resizer").dblclick();
			const reset = await geometry(page);
			assertUsable(reset, viewport);
			assert.equal(reset.savedSidebar, null, "Double click did not clear preference");
			assert.equal(reset.sidebar.width, viewport.width === 800 ? 200 : 226, "Double click did not restore fitted CSS default");
			entry.success = true;
		} catch (error) { entry.failure = error.message; }
		finally { await page.close(); }
		result.cases.push(entry);
		process.stdout.write(`${entry.success ? "PASS" : "FAIL"} ${entry.name}${entry.failure ? `: ${entry.failure}` : ""}\n`);
	}
	result.success = result.errors.length === 0 && result.cases.every((entry) => entry.success);
	if (!result.success) process.exitCode = 1;
} finally {
	await browser.close();
	await new Promise((closed) => server.close(closed));
	await writeFile(join(output, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
}
