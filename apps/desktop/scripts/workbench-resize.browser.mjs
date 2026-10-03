import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// Specific production-browser regression only. No real bridge, model, Office worker or provider API.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), "owl-workbench-resize-results"));
const browserPath = [
	process.env.OWL_BROWSER_TEST_EXECUTABLE,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
].find((candidate) => candidate && existsSync(candidate));
assert.ok(browserPath, "Set OWL_BROWSER_TEST_EXECUTABLE to an installed Chromium browser; this test never downloads one.");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "owl-workbench-resize-"));
const sourcePaths = ["Workbench.tsx", "pointer-drag.ts", "tabs/PluginViewerTab.tsx"];
const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, createHash("sha256").update(await readFile(join(repo, "apps/desktop/src/sidebar", path))).digest("hex")])));
const result = { success: false, production: true, sourceSha256, cases: [], errors: [], browserPath };
let browser;
let parent;
let iframe;
const pause = () => new Promise((resolvePause) => setTimeout(resolvePause, 80));
const layoutCss = `html,body,#root{height:100%;margin:0}.test-layout{position:fixed;inset:80px 18px 20px 278px;display:flex;min-width:0;min-height:0;overflow:hidden}.test-layout[data-dock=bottom]{flex-direction:column}.test-chat{flex:1;min-width:0;min-height:0;padding:22px;background:#1b211b;color:#ddd;overflow:auto}.test-layout[data-dock=right]>.owl-workbench-shell{height:100%}`;
const html = '<!doctype html><html><head><title>Workbench resize regression</title><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>';
const officeHtml = `<!doctype html><html><style>html,body{margin:0;height:100%;color:#222;background:#fff;font:14px Arial}header{padding:20px;border-bottom:1px solid #ddd}main{padding:24px}td,th{border:1px solid #ddd;padding:15px}</style><header>费用测试.univer · 草稿</header><main><table><tr><th>项目</th><th>数量</th><th>金额</th></tr><tr><td>设备</td><td>2</td><td>300</td></tr></table><button id="office-action">Office 操作</button></main><script>window.mouseEvents={move:0,up:0,clicks:0};addEventListener('mousemove',()=>mouseEvents.move++);addEventListener('mouseup',()=>mouseEvents.up++);document.querySelector('#office-action').onclick=()=>mouseEvents.clicks++;</script></html>`;

async function dimensions(page) {
	return page.$eval(".owl-workbench-shell", (element) => {
		const rectangle = element.getBoundingClientRect();
		return { left: rectangle.left, top: rectangle.top, width: rectangle.width, height: rectangle.height };
	});
}

async function newPage(dock = "right") {
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.on("pageerror", (error) => result.errors.push(error.message));
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.hostname !== "127.0.0.1") { result.errors.push(`Unexpected external request: ${url.origin}`); return route.abort(); }
		return route.continue();
	});
	await page.goto(`${result.parentOrigin}/?dock=${dock}&viewer=${encodeURIComponent(result.iframeOrigin)}`);
	await page.waitForSelector(".owl-plugin-viewer iframe");
	await (await (await page.$(".owl-plugin-viewer iframe")).contentFrame()).waitForSelector("#office-action");
	await page.evaluate(() => {
		window.pointerTrace = [];
		for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
			document.addEventListener(type, (event) => window.pointerTrace.push({ type, pointerId: event.pointerId, buttons: event.buttons, x: event.clientX, y: event.clientY }), true);
		}
	});
	return page;
}

async function runCase(name, operation) {
	const entry = { name, success: false };
	try { Object.assign(entry, await operation()); entry.success = true; }
	catch (error) { entry.failure = error.message; }
	result.cases.push(entry);
	process.stdout.write(`${entry.success ? "PASS" : "FAIL"} ${name}${entry.failure ? `: ${entry.failure}` : ""}\n`);
}

async function assertReleased(page, horizontal, expected) {
	await pause();
	const size = (await dimensions(page))[horizontal ? "width" : "height"];
	assert.ok(Math.abs(size - expected) <= 1, `Expected ${expected}px, received ${size}px`);
	assert.equal(await page.locator("[data-workbench-drag-shield]").count(), 0, "Gesture shield remained after release");
	await page.mouse.move(470, 180);
	await pause();
	assert.equal((await dimensions(page))[horizontal ? "width" : "height"], size, "Workbench continued moving without a pressed button");
	const persisted = Number(await page.evaluate((key) => localStorage.getItem(key), horizontal ? "owl.workbench.width" : "owl.workbench.height"));
	assert.equal(persisted, size, "Released dimension was not persisted");
	const frame = await (await page.$(".owl-plugin-viewer iframe")).contentFrame();
	await frame.click("#office-action");
	assert.equal(await frame.evaluate(() => window.mouseEvents.clicks), 1, "Office iframe stayed blocked after release");
	return size;
}

try {
	const bundled = await build({ entryPoints: [join(scriptDir, "fixtures/workbench-resize.mjs")], outfile: join(temporary, "test.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic", minify: true, define: { "process.env.NODE_ENV": '"production"' }, metafile: true });
	result.bundleInputs = Object.keys(bundled.metafile.inputs).filter((path) => /Workbench|PluginViewerTab|pointer-drag|plugin-viewers|store\.ts/.test(path));
	for (const expected of ["Workbench.tsx", "PluginViewerTab.tsx", "pointer-drag.ts"]) assert.ok(result.bundleInputs.some((path) => path.endsWith(expected)), `Actual ${expected} was not bundled`);
	const cssSource = join(repo, "apps/desktop/src/index.css");
	const compiler = await compile(await readFile(cssSource, "utf8"), { base: dirname(cssSource), onDependency: () => {} });
	const scanner = new Scanner({ sources: [{ base: join(repo, "apps/desktop/src"), pattern: "**/*.{ts,tsx}", negated: false }] });
	const [javascript, componentCss] = await Promise.all([readFile(join(temporary, "test.js")), readFile(join(temporary, "test.css"), "utf8")]);
	const css = `${compiler.build(scanner.scan())}\n${componentCss}\n${layoutCss}`;
	iframe = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(officeHtml); });
	parent = createServer((request, response) => {
		response.writeHead(200, { "content-type": request.url === "/test.js" ? "text/javascript" : request.url === "/test.css" ? "text/css" : "text/html; charset=utf-8" });
		response.end(request.url === "/test.js" ? javascript : request.url === "/test.css" ? css : html);
	});
	await Promise.all([new Promise((listen) => parent.listen(0, "127.0.0.1", listen)), new Promise((listen) => iframe.listen(0, "127.0.0.1", listen))]);
	result.parentOrigin = `http://127.0.0.1:${parent.address().port}`;
	result.iframeOrigin = `http://127.0.0.1:${iframe.address().port}`;
	assert.notEqual(result.parentOrigin, result.iframeOrigin);
	browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
	for (const scenario of [{ name: "right-narrow", dock: "right", delta: 320 }, { name: "right-expand", dock: "right", delta: -60 }, { name: "bottom-shrink", dock: "bottom", delta: 230 }, { name: "bottom-expand", dock: "bottom", delta: -80 }, { name: "bottom-fast-iframe-crossing", dock: "bottom", delta: 230, steps: 1 }]) {
		await runCase(scenario.name, async () => {
			const page = await newPage(scenario.dock);
			try {
				const before = await dimensions(page);
				const horizontal = scenario.dock === "right";
				const start = horizontal ? { x: before.left + 2, y: 540 } : { x: 1100, y: before.top + 2 };
				const target = horizontal ? { x: start.x + scenario.delta, y: start.y } : { x: start.x, y: start.y + scenario.delta };
				const expected = (horizontal ? before.width : before.height) - scenario.delta;
				await page.mouse.move(start.x, start.y); await page.mouse.down();
				await page.mouse.move(target.x, target.y, { steps: scenario.steps ?? 12 }); await page.mouse.up();
				const released = await assertReleased(page, horizontal, expected);
				await page.screenshot({ path: join(output, `${scenario.name}.png`) });
				const repeatBefore = await dimensions(page);
				const repeatStart = horizontal ? { x: repeatBefore.left + 2, y: 540 } : { x: 1100, y: repeatBefore.top + 2 };
				const delta = horizontal ? 100 : -60;
				await page.mouse.move(repeatStart.x, repeatStart.y); await page.mouse.down();
				await page.mouse.move(repeatStart.x + (horizontal ? delta : 0), repeatStart.y + (horizontal ? 0 : delta), { steps: 12 }); await page.mouse.up();
				const repeated = (await dimensions(page))[horizontal ? "width" : "height"];
				assert.equal(repeated, released - delta, "Second drag used a stale size");
				await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set("restore", "1"); history.replaceState(null, "", url); });
				await page.reload(); await page.waitForSelector(".owl-plugin-viewer iframe");
				assert.equal((await dimensions(page))[horizontal ? "width" : "height"], repeated, "Refresh did not restore the released dimension");
				return { before, expected, released, repeated };
			} finally { await page.close(); }
		});
	}
	for (const termination of ["blur", "cancel", "lost-capture", "zero-buttons", "hide", "dock-switch", "unmount"]) {
		await runCase(`cleanup-${termination}`, async () => {
			const page = await newPage();
			try {
				const before = await dimensions(page);
				await page.mouse.move(before.left + 2, 540); await page.mouse.down(); await page.mouse.move(before.left + 82, 540);
				const dragged = (await dimensions(page)).width;
				assert.equal(await page.locator("[data-workbench-drag-shield]").count(), 1);
				await page.evaluate((termination) => {
					const handle = document.querySelector("[data-workbench-size-handle]");
					const pointerId = window.pointerTrace.find((event) => event.type === "pointerdown").pointerId;
					if (termination === "blur") window.dispatchEvent(new Event("blur"));
					else if (termination === "cancel") handle.dispatchEvent(new PointerEvent("pointercancel", { pointerId, bubbles: true }));
					else if (termination === "lost-capture") handle.releasePointerCapture(pointerId);
					else if (termination === "zero-buttons") handle.dispatchEvent(new PointerEvent("pointermove", { pointerId, pointerType: "mouse", buttons: 0, bubbles: true }));
					else if (termination === "hide") window.workbenchHarness.setOpen(false);
					else if (termination === "dock-switch") window.workbenchHarness.setDock("bottom");
					else window.workbenchHarness.unmount();
				}, termination);
				await page.mouse.move(470, 180); await pause(); await page.mouse.up();
				assert.equal(await page.locator("[data-workbench-drag-shield]").count(), 0, "Shield survived cancelled gesture");
				assert.deepEqual(await page.evaluate(() => ({ cursor: document.body.style.cursor, selection: document.body.style.userSelect })), { cursor: "", selection: "" });
				const persisted = Number(await page.evaluate(() => localStorage.getItem("owl.workbench.width")));
				assert.equal(persisted, dragged, "Cancellation persisted another dock's dimension");
				if (!["hide", "dock-switch", "unmount"].includes(termination)) await assertReleased(page, true, dragged);
				return { dragged, persisted };
			} finally { await page.close(); }
		});
	}
	await runCase("split-divider-crosses-office-iframe", async () => {
		const page = await newPage();
		try {
			await page.evaluate(() => { const store = window.workbenchHarness.store; const leaf = store.getState().activePane; store.openFileTab("plugin-viewer:office-fixture", "第二份.univer", "第二份.univer"); store.moveTab(store.getState().activeId, leaf, "right"); });
			await page.waitForSelector('.owl-workbench-shell [role="separator"]:not([data-workbench-size-handle])');
			const divider = await page.$eval('.owl-workbench-shell [role="separator"]:not([data-workbench-size-handle])', (element) => { const rect = element.getBoundingClientRect(); const parent = element.parentElement.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: 540, left: parent.left, width: parent.width }; });
			await page.mouse.move(divider.x, divider.y); await page.mouse.down(); await page.mouse.move(divider.x + 140, divider.y, { steps: 1 }); await page.mouse.up();
			const ratio = await page.evaluate(() => window.workbenchHarness.store.getState().tree.ratio);
			assert.ok(Math.abs(ratio - (divider.x + 140 - divider.left) / divider.width) < 0.005);
			await page.mouse.move(470, 180); await pause();
			assert.equal(await page.evaluate(() => window.workbenchHarness.store.getState().tree.ratio), ratio);
			assert.equal(await page.locator("[data-workbench-drag-shield]").count(), 0);
			return { ratio };
		} finally { await page.close(); }
	});
	await runCase("tab-splits-panel-over-office-iframe", async () => {
		const page = await newPage();
		try {
			await page.evaluate(() => window.workbenchHarness.store.openFileTab("plugin-viewer:office-fixture", "第二份.univer", "第二份.univer"));
			const tab = await page.$eval('.owl-workbench-tab[aria-label="第二份.univer"]', (element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + 20, y: rect.top + rect.height / 2 }; });
			const pane = await page.$eval(".owl-workbench-leaf", (element) => { const rect = element.getBoundingClientRect(); return { x: rect.right - 20, y: rect.top + rect.height / 2 }; });
			await page.mouse.move(tab.x, tab.y); await page.mouse.down(); await page.mouse.move(pane.x, pane.y, { steps: 1 }); await page.mouse.up(); await pause();
			const tree = await page.evaluate(() => window.workbenchHarness.store.getState().tree);
			assert.equal(tree.kind, "split"); assert.equal(tree.dir, "row"); assert.equal(tree.b.tabs[0].path, "第二份.univer");
			assert.equal(await page.locator("[data-workbench-drag-shield]").count(), 0);
			return { kind: tree.kind, direction: tree.dir };
		} finally { await page.close(); }
	});
	result.success = result.errors.length === 0 && result.cases.every((entry) => entry.success);
	if (!result.success) process.exitCode = 1;
} finally {
	if (browser) await browser.close();
	await Promise.all([parent, iframe].filter(Boolean).map((server) => new Promise((closed) => server.close(closed))));
	await writeFile(join(output, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
	await rm(temporary, { recursive: true, force: true });
}
