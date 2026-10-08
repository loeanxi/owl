import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "esbuild";
import pw from "playwright-core";

// Real React component and current source CSS. Native RPCs and JPEG frames are local mocks.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), "owl-mirror-responsive-results"));
const targetedCase = process.argv.find((argument) => argument.startsWith("--case="))?.slice(7);
const browserPath = [
	process.env.OWL_BROWSER_TEST_EXECUTABLE,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
].find((candidate) => candidate && existsSync(candidate));
assert.ok(
	browserPath,
	"Set OWL_BROWSER_TEST_EXECUTABLE to an installed Chromium browser; this test never downloads one.",
);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "owl-mirror-responsive-"));
const sourcePath = join(repo, "apps/desktop/src/sidebar/tabs/MirrorTab.tsx");
const source = await readFile(sourcePath, "utf8");
const result = {
	actualComponent: sourcePath,
	sourceSha256: createHash("sha256").update(source).digest("hex"),
	cases: [],
	errors: [],
	browserPath,
};
const buildOptions = {
	entryPoints: [join(scriptDir, "fixtures/mirror-responsive.mjs")],
	outfile: join(temporary, "harness.js"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	minify: true,
	nodePaths: [join(repo, "node_modules")],
	define: { "process.env.NODE_ENV": '"production"' },
};
const bundled = await build({ ...buildOptions, metafile: true });
result.bundleInputs = Object.keys(bundled.metafile.inputs).filter((path) => /MirrorTab|mirror-geometry/.test(path));
assert.ok(
	result.bundleInputs.some((path) => path.endsWith("MirrorTab.tsx")),
	"Actual MirrorTab was not bundled",
);
await build({
	...buildOptions,
	outfile: join(temporary, "strict.js"),
	define: { "process.env.NODE_ENV": '"development"' },
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
	`html,body{margin:0;height:100%;overflow:hidden;background:#efeee9;font-family:Segoe UI,sans-serif;color:#222}#top{position:absolute;top:0;left:0;right:0;height:48px;padding:12px 20px;background:#e3e1da;box-sizing:border-box}#chat{position:absolute;top:90px;left:30px;width:260px;color:#666}#panel{position:absolute;left:340px;top:100px;width:600px;height:700px;border:1px solid #b8b5aa;overflow:hidden}#mirror-root{position:relative;width:100%;height:100%}`;
const js = await readFile(join(temporary, "harness.js"));
const strictJs = await readFile(join(temporary, "strict.js"));
const server = createServer((req, res) => {
	if (req.url === "/strict.js") {
		res.writeHead(200, { "content-type": "text/javascript" });
		res.end(strictJs);
		return;
	}
	if (req.url === "/harness.js") {
		res.writeHead(200, { "content-type": "text/javascript" });
		res.end(js);
		return;
	}
	if (req.url === "/harness.css") {
		res.writeHead(200, { "content-type": "text/css" });
		res.end(css);
		return;
	}
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	const html =
		'<!doctype html><html data-owl-theme="light" data-owl-preset="codex"><head><link rel="stylesheet" href="/harness.css"></head><body><header id="top">Owl · 短剧自适应回归验收 · 原生调用已隔离为本地 Mock</header><article id="chat"><h2>短剧</h2><p>真实 MirrorTab React 组件</p><p>每个画面中心的青色正方形用于检测拉伸。</p><p>舞台尺寸根据窗口变化。</p></article><section id="panel"><div id="mirror-root"></div></section><script type="module" src="/harness.js"></script></body></html>';
	res.end(req.url?.includes("strict=1") ? html.replace("/harness.js", "/strict.js") : html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
function record(name, pass, details) {
	result.cases.push({ name, pass, ...details });
	process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(details)}\n`);
}
async function open(mode, viewport = { width: 1280, height: 860, deviceScaleFactor: 1 }, strict = false, virtualClock = false) {
	const page = await browser.newPage({
		viewport: { width: viewport.width, height: viewport.height },
		deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
	});
	if (virtualClock) await page.clock.install();
	page.on("pageerror", (error) => result.errors.push(error.message));
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.hostname !== "127.0.0.1") {
			result.errors.push(`Unexpected external request: ${url.origin}`);
			return route.abort();
		}
		return route.continue();
	});
	await page.goto(`${origin}/?mode=${mode}${strict ? "&strict=1" : ""}`, { waitUntil: "networkidle" });
	await page.waitForFunction(() =>
		window.harness?.calls.some((call) => call.type === "mirror.project" && call.visible !== false),
	);
	if (virtualClock) await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
	return page;
}
async function advanceRecoveryClock(page, milliseconds) {
	await page.clock.runFor(milliseconds);
	await sleep(40);
}
async function ready(mode = "project", viewport, strict = false) {
	const page = await open(mode, viewport, strict);
	if (mode !== "pending" && mode !== "no-frame")
		await page.waitForFunction(() => document.querySelector("canvas")?.width === 640);
	return page;
}
async function center(page, u = 0.5, v = 0.5) {
	return page.$eval(
		"canvas",
		(canvas, point) => {
			const box = canvas.getBoundingClientRect();
			const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
			return {
				x: box.left + (box.width - canvas.width * scale) / 2 + canvas.width * scale * point.u,
				y: box.top + (box.height - canvas.height * scale) / 2 + canvas.height * scale * point.v,
			};
		},
		{ u, v },
	);
}
async function inputCalls(page) {
	return page.evaluate(() => window.harness.calls.filter((call) => call.type === "mirror.input"));
}
async function runCase(name, body) {
	if (targetedCase && !name.includes(targetedCase)) return;
	try {
		const detail = await body();
		record(name, true, detail ?? {});
	} catch (error) {
		record(name, false, { error: error.message });
	}
}
try {
	browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
	await runCase("recovery-first-frame-timeout-is-ordered-and-bounded", async () => {
		const page = await open("no-frame", undefined, false, true);
		await advanceRecoveryClock(page, 7000);
		assert.equal(await page.evaluate(() => window.harness.calls.filter(call => call.type === "mirror.attach").length), 1);
		for (const milliseconds of [2500, 11000, 13000, 60000]) await advanceRecoveryClock(page, milliseconds);
		const calls = await page.evaluate(() => window.harness.calls.filter(call => call.type !== "mirror.list"));
		assert.equal(calls.filter(call => call.type === "mirror.attach").length, 4, "Missing or unbounded automatic recovery");
		assert.deepEqual(calls.map(call => call.type === "mirror.project" ? `${call.type}:${call.visible}` : call.type), [
			"mirror.project:true", "mirror.attach",
			...Array.from({ length: 3 }, () => ["mirror.detach", "mirror.project:false", "mirror.project:true", "mirror.attach"]).flat(),
		]);
		await page.close();
		return { attachCount: 4, orderedLifecycle: true };
	});
	await runCase("recovery-valid-first-frame-stops-timeouts", async () => {
		const page = await open("no-frame", undefined, false, true);
		await page.evaluate(() => window.harness.emitFrame());
		await sleep(100);
		assert.equal(await page.$eval("canvas", canvas => canvas.width), 640);
		await advanceRecoveryClock(page, 60000);
		const attaches = await page.evaluate(() => window.harness.calls.filter(call => call.type === "mirror.attach").length);
		assert.equal(attaches, 1, "A static valid image triggered needless recovery");
		await page.close();
		return { attaches };
	});
	await runCase("recovery-invalid-frame-does-not-cancel-timeout", async () => {
		const page = await open("no-frame", undefined, false, true);
		await page.evaluate(() => window.harness.emitFrame(640, 360, { invalid: true }));
		await advanceRecoveryClock(page, 10000);
		assert.equal(await page.evaluate(() => window.harness.calls.filter(call => call.type === "mirror.attach").length), 2);
		await page.close();
	});
	await runCase("recovery-timers-stop-on-hide-unmount-restore-disconnect", async () => {
		for (const reason of ["hide", "unmount", "restore", "disconnect"]) {
			const page = await open("no-frame", undefined, false, true);
			if (reason === "restore") await page.evaluate(() => document.querySelector('button[title="恢复窗口"]').click());
			else await page.evaluate(reason => {
				if (reason === "hide") { document.getElementById("panel").style.display = "none"; window.dispatchEvent(new Event("resize")); }
				else if (reason === "disconnect") window.harness.emitStatus(false);
				else window.harness.unmount();
			}, reason);
			await sleep(80);
			await advanceRecoveryClock(page, 60000);
			assert.equal(await page.evaluate(() => window.harness.calls.filter(call => call.type === "mirror.attach").length), 1, `${reason} still restarted capture`);
			await page.close();
		}
	});
	await runCase("recovery-waits-until-preparation-finishes", async () => {
		const page = await open("pending", undefined, false, true);
		await advanceRecoveryClock(page, 30000);
		assert.equal(await page.evaluate(() => window.harness.calls.filter(call => call.type === "mirror.project" && call.visible).length), 1);
		assert.equal(await page.evaluate(() => window.harness.calls.filter(call => call.type === "mirror.attach").length), 0);
		await page.close();
	});
	for (const scenario of [
		{
			name: "1920-wide",
			viewport: { width: 1920, height: 1080 },
			panel: { left: 957, top: 160, width: 953, height: 860 },
		},
		{
			name: "1280-normal",
			viewport: { width: 1280, height: 860 },
			panel: { left: 657, top: 160, width: 613, height: 664 },
		},
		{
			name: "1024-compact",
			viewport: { width: 1024, height: 768 },
			panel: { left: 530, top: 130, width: 484, height: 618 },
		},
		{
			name: "800-small",
			viewport: { width: 800, height: 600 },
			panel: { left: 410, top: 110, width: 380, height: 470 },
		},
		{
			name: "1280-dpr125",
			viewport: { width: 1280, height: 860, deviceScaleFactor: 1.25 },
			panel: { left: 650, top: 150, width: 620, height: 680 },
		},
		{
			name: "1280-portrait",
			viewport: { width: 1280, height: 860 },
			panel: { left: 657, top: 160, width: 613, height: 664 },
			frame: { width: 360, height: 640 },
		},
		{
			name: "1280-short-panel",
			viewport: { width: 1280, height: 860 },
			panel: { left: 340, top: 530, width: 930, height: 280 },
		},
	])
		await runCase(`projection-aspect-and-click-${scenario.name}`, async () => {
			const page = await ready("project", scenario.viewport);
			await page.evaluate((scenario) => {
				window.harness.setPanel(scenario.panel);
				window.harness.emitFrame(scenario.frame?.width, scenario.frame?.height);
			}, scenario);
			await sleep(150);
			const shot = (await (await page.$("canvas")).screenshot()).toString("base64");
			const pixels = await page.evaluate(async (shot) => {
				const image = new Image();
				image.src = `data:image/png;base64,${shot}`;
				await image.decode();
				const canvas = document.createElement("canvas");
				canvas.width = image.width;
				canvas.height = image.height;
				const ctx = canvas.getContext("2d");
				ctx.drawImage(image, 0, 0);
				const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
				let x0 = canvas.width,
					x1 = -1,
					y0 = canvas.height,
					y1 = -1,
					toolbarPixels = 0,
					navigationPixels = 0;
				for (let y = 0; y < canvas.height; y++)
					for (let x = 0; x < canvas.width; x++) {
						const i = (y * canvas.width + x) * 4;
						if (data[i] < 35 && data[i + 1] > 210 && data[i + 2] > 210) {
							x0 = Math.min(x0, x);
							x1 = Math.max(x1, x);
							y0 = Math.min(y0, y);
							y1 = Math.max(y1, y);
						}
						if (data[i] > 180 && data[i + 1] < 60 && data[i + 2] > 180) toolbarPixels++;
						if (data[i] < 35 && data[i + 1] > 150 && data[i + 2] < 110) navigationPixels++;
					}
				return { marker: { width: x1 - x0 + 1, height: y1 - y0 + 1 }, toolbarPixels, navigationPixels };
			}, shot);
			assert.ok(Math.abs(pixels.marker.width / pixels.marker.height - 1) < 0.035, "Frame was stretched");
			assert.equal(pixels.toolbarPixels, 0, "App-store toolbar/bottom margin leaked into image");
			assert.ok(pixels.navigationPixels > 30, "Drama navigation was cropped away");
			const point = await center(page, 0.5, 0.95);
			await page.evaluate(() => window.harness.clearCalls());
			await page.mouse.click(point.x, point.y);
			await sleep(60);
			const clicks = (await inputCalls(page)).filter((call) => call.action === "click");
			assert.equal(clicks.length, 1);
			assert.ok(Math.abs(clicks[0].u - 0.5) < 0.003);
			assert.ok(Math.abs(clicks[0].v - 0.95) < 0.003);
			await page.screenshot({ path: join(output, `${scenario.name}.png`) });
			await page.close();
			return { ...pixels, click: clicks[0] };
		});
	await runCase("stream-cleanup-on-unmount", async () => {
		const page = await ready();
		await page.evaluate(() => {
			window.harness.clearCalls();
			window.harness.unmount();
		});
		await sleep(80);
		const actual = await page.evaluate(() => ({
			calls: window.harness.calls,
			listeners: window.harness.listenerCount(),
		}));
		assert.equal(actual.listeners, 0);
		assert.equal(actual.calls.filter((call) => call.type === "mirror.detach").length, 1);
		assert.equal(actual.calls.filter((call) => call.type === "mirror.project" && call.visible === false).length, 1);
		assert.ok(!actual.calls.some((call) => call.type === "mirror.unembed"));
		await page.close();
		return actual;
	});
	await runCase("black-bars-and-empty-frame-ignore-input", async () => {
		for (const mode of ["project", "no-frame"]) {
			const page = await ready(mode);
			const box = await page.locator("canvas").boundingBox();
			await page.evaluate(() => window.harness.clearCalls());
			await page.mouse.click(box.x + box.width / 2, box.y + 3);
			if (mode === "no-frame") await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			await sleep(60);
			assert.equal((await inputCalls(page)).length, 0);
			await page.close();
		}
	});
	await runCase("resize-and-dpi-change-never-resize-source", async () => {
		const page = await ready();
		await page.evaluate(() => {
			window.harness.clearCalls();
			window.harness.setPanel({ left: 480, top: 120, width: 400, height: 450 });
			Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
			window.dispatchEvent(new Event("resize"));
		});
		await sleep(300);
		const point = await center(page);
		await page.mouse.click(point.x, point.y);
		await sleep(60);
		const calls = await page.evaluate(() => window.harness.calls);
		assert.ok(!calls.some((call) => ["mirror.embed", "mirror.layout", "mirror.project"].includes(call.type)));
		const click = calls.find((call) => call.action === "click");
		assert.ok(Math.abs(click.u - 0.5) < 0.003 && Math.abs(click.v - 0.5) < 0.003);
		await page.close();
		return { calls };
	});
	for (const hide of ["offscreen", "display-none"])
		await runCase(`hidden-${hide}-releases-and-reconnects`, async () => {
			const page = await ready();
			await page.evaluate((hide) => {
				window.harness.clearCalls();
				if (hide === "offscreen") window.harness.setPanel({ left: 1400, top: 100, width: 600, height: 700 });
				else document.getElementById("panel").style.display = "none";
			}, hide);
			await sleep(350);
			const hidden = await page.evaluate(() => window.harness.calls);
			assert.ok(hidden.some((call) => call.type === "mirror.detach"));
			assert.ok(hidden.some((call) => call.type === "mirror.project" && call.visible === false));
			assert.ok(!hidden.some((call) => call.type === "mirror.unembed"));
			await page.evaluate(() => {
				document.getElementById("panel").style.display = "";
				window.harness.setPanel({ left: 340, top: 100, width: 600, height: 700 });
			});
			await sleep(350);
			const resumed = await page.evaluate(() => window.harness.calls);
			assert.ok(resumed.some((call) => call.type === "mirror.project" && call.visible === true));
			assert.ok(resumed.some((call) => call.type === "mirror.attach"));
			await page.close();
			return { hidden, resumed };
		});
	await runCase("restore-remains-independent", async () => {
		const page = await ready();
		await page.evaluate(() => window.harness.clearCalls());
		await page.click('button[title="恢复窗口"]');
		await sleep(150);
		const calls = await page.evaluate(() => window.harness.calls);
		assert.deepEqual(
			calls.map((call) => call.type),
			["mirror.detach", "mirror.unembed", "fixture.closeTab"],
		);
		await page.close();
		return { calls };
	});
	for (const scenario of [
		{ action: "hide", strict: false },
		{ action: "unmount", strict: false },
		{ action: "unmount", strict: true },
	])
		await runCase(
			`${scenario.strict ? "strict-" : ""}pending-project-${scenario.action}-completion-cleans`,
			async () => {
				const page = await ready("pending", undefined, scenario.strict);
				await page.evaluate((action) => {
					if (action === "hide") document.getElementById("panel").style.display = "none";
					else window.harness.unmount();
				}, scenario.action);
				await sleep(350);
				await page.evaluate(() => {
					window.harness.clearCalls();
					window.harness.completeProject();
				});
				await sleep(100);
				const calls = await page.evaluate(() => window.harness.calls);
				assert.ok(calls.some((call) => call.type === "mirror.project" && call.visible === false));
				assert.ok(!calls.some((call) => call.type === "mirror.attach"));
				await page.close();
				return { calls };
			},
		);
	await runCase("pending-project-close-and-reopen-orders-old-cleanup", async () => {
		const page = await ready("pending");
		await page.evaluate(() => {
			window.harness.unmount();
			window.harness.remount();
		});
		await sleep(100);
		await page.evaluate(() => window.harness.completeProject());
		await sleep(100);
		await page.evaluate(() => window.harness.completeProject());
		await sleep(100);
		const calls = await page.evaluate(() => window.harness.calls);
		const hides = calls
			.map((call, index) => (call.type === "mirror.project" && call.visible === false ? index : -1))
			.filter((index) => index >= 0);
		const projects = calls
			.map((call, index) => (call.type === "mirror.project" && call.visible ? index : -1))
			.filter((index) => index >= 0);
		assert.equal(projects.length, 2);
		assert.ok(
			hides.length === 1 && hides[0] < projects[1],
			`Old cleanup overtook reopened project: ${JSON.stringify(calls)}`,
		);
		assert.equal(calls.at(-1).type, "mirror.attach");
		await page.close();
		return { calls };
	});
	await runCase("window-replacement-reconnects-without-launch", async () => {
		const page = await ready();
		await page.evaluate(() => {
			window.harness.clearCalls();
			window.harness.emitWindows(["fixture-window"]);
		});
		await sleep(50);
		assert.ok(!(await page.evaluate(() => window.harness.calls)).some((call) => call.type === "mirror.project"));
		await page.evaluate(() => window.harness.emitWindows([]));
		await sleep(60);
		await page.evaluate(() => window.harness.emitWindows(["replacement-window"]));
		await sleep(180);
		const calls = await page.evaluate(() => window.harness.calls);
		assert.ok(
			calls.some((call) => call.type === "mirror.project" && call.windowId === "replacement-window" && call.visible),
		);
		assert.ok(!calls.some((call) => call.type === "mirror.launch"));
		const oldPause = calls.findIndex(
			(call) => call.type === "mirror.project" && call.windowId === "fixture-window" && call.visible === false,
		);
		const newPrepare = calls.findIndex(
			(call) => call.type === "mirror.project" && call.windowId === "replacement-window" && call.visible,
		);
		assert.ok(oldPause >= 0 && oldPause < newPrepare);
		await page.close();
		return { calls };
	});
	await runCase("websocket-reconnect-projects-and-attaches-again", async () => {
		const page = await ready();
		await page.evaluate(() => {
			window.harness.clearCalls();
			window.harness.emitStatus(false);
		});
		await sleep(70);
		await page.evaluate(() => window.harness.emitStatus(true));
		await sleep(200);
		const calls = await page.evaluate(() => window.harness.calls);
		assert.ok(calls.some((call) => call.type === "mirror.project" && call.visible));
		assert.ok(calls.some((call) => call.type === "mirror.attach"));
		const point = await center(page);
		await page.mouse.click(point.x, point.y);
		await sleep(50);
		assert.ok((await inputCalls(page)).some((call) => call.action === "click"));
		await page.close();
		return { calls };
	});
	for (const direction of ["up", "down"]) await runCase(`vertical-page-${direction}-commits-once-at-start`, async () => {
		const page = await ready(); const start = await center(page, 0.4, 0.52); const end = await center(page, 0.4, direction === "up" ? 0.12 : 0.9);
		await page.evaluate(() => window.harness.clearCalls()); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 12 }); await sleep(30);
		const beforeRelease = await inputCalls(page); await page.mouse.up(); await sleep(30); const calls = await inputCalls(page); await page.close();
		assert.equal(beforeRelease.length, 1); assert.equal(calls.length, 1); assert.equal(calls[0].action, "wheel"); assert.equal(calls[0].deltaY, direction === "up" ? 120 : -120);
		assert.ok(Math.abs(calls[0].u - 0.4) < 0.003 && Math.abs(calls[0].v - 0.52) < 0.003); return { calls };
	});
	await runCase("vertical-page-thresholds-never-toggle-play", async () => {
		const page = await ready();
		for (const scenario of ["classify-only", "normalized-short", "pixel-short"]) {
			if (scenario === "pixel-short") { await page.evaluate(() => window.harness.setPanel({ left: 340, top: 100, width: 320, height: 180 })); await sleep(60); }
			const start = await center(page, 0.5, 0.52); const target = await center(page, 0.5, scenario === "normalized-short" ? 0.44 : 0.4);
			await page.evaluate(() => window.harness.clearCalls()); await page.mouse.move(start.x, start.y); await page.mouse.down();
			await page.mouse.move(start.x, start.y - 5); assert.equal((await inputCalls(page)).length, 0);
			await page.mouse.move(target.x, scenario === "classify-only" ? start.y - 10 : target.y); await page.mouse.up(); await sleep(30);
			assert.deepEqual(await inputCalls(page), [], `${scenario} forwarded native input before both thresholds`);
		}
		await page.close();
	});
	await runCase("vertical-page-long-and-reversed-drag-remains-one-page", async () => {
		const page = await ready(); const start = await center(page, 0.5, 0.52); const top = await center(page, 0.5, 0.05); const bottom = await center(page, 0.5, 0.95);
		await page.evaluate(() => window.harness.clearCalls()); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(top.x, top.y, { steps: 20 }); await page.mouse.move(bottom.x, bottom.y, { steps: 20 }); await page.mouse.move(top.x, top.y, { steps: 20 }); await page.mouse.up(); await sleep(30);
		const calls = await inputCalls(page); await page.close(); assert.equal(calls.length, 1); assert.equal(calls[0].action, "wheel"); assert.equal(calls[0].deltaY, 120); return { calls };
	});
	await runCase("vertical-page-cancel-never-sends-native-pointer", async () => {
		const page = await ready(); const start = await center(page, 0.5, 0.52); const end = await center(page, 0.5, 0.15);
		await page.evaluate(() => window.harness.clearCalls()); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y);
		await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel"))); await page.mouse.up(); await sleep(30);
		const calls = await inputCalls(page); await page.close(); assert.equal(calls.length, 1); assert.equal(calls[0].action, "wheel"); return { calls };
	});
	await runCase("vertical-page-click-and-horizontal-still-work", async () => {
		const page = await ready(); const start = await center(page, 0.3, 0.5); const end = await center(page, 0.7, 0.5);
		await page.evaluate(() => window.harness.clearCalls()); await page.mouse.click(start.x, start.y); await sleep(20); const click = await inputCalls(page); assert.equal(click.length, 1); assert.equal(click[0].action, "click");
		await page.evaluate(() => window.harness.clearCalls()); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up(); await sleep(50);
		const calls = await inputCalls(page); await page.close(); assert.equal(calls[0].action, "down"); assert.equal(calls.at(-1).action, "up"); assert.ok(!calls.some(call => call.action === "wheel" || call.action === "click")); return { click, calls };
	});
	await runCase("drag-outside-clamps-and-always-releases", async () => {
		const page = await ready("slow-input");
		const point = await center(page);
		await page.evaluate(() => window.harness.clearCalls());
		await page.mouse.move(point.x, point.y);
		await page.mouse.down();
		await page.mouse.move(point.x + 480, point.y + 60, { steps: 30 });
		await page.mouse.up();
		await sleep(350);
		const calls = await inputCalls(page);
		assert.equal(calls[0].action, "down");
		assert.equal(calls.at(-1).action, "up");
		assert.ok(calls.at(-1).u > 0.99 && calls.at(-1).u < 1);
		assert.ok(calls.every((call) => call.u >= 0 && call.u < 1 && call.v >= 0 && call.v < 1));
		assert.ok(!calls.some((call) => call.action === "click"));
		assert.ok(calls.filter((call) => call.action === "move").length < 30);
		await page.close();
		return { calls };
	});
	for (const reason of ["cancel", "blur", "hide", "unmount"])
		await runCase(`drag-${reason}-releases`, async () => {
			const page = await ready();
			const point = await center(page);
			await page.evaluate(() => window.harness.clearCalls());
			await page.mouse.move(point.x, point.y);
			await page.mouse.down();
			await page.mouse.move(point.x + 30, point.y + 10);
			await sleep(30);
			await page.evaluate((reason) => {
				if (reason === "cancel") window.dispatchEvent(new PointerEvent("pointercancel"));
				else if (reason === "blur") window.dispatchEvent(new Event("blur"));
				else if (reason === "hide") document.getElementById("panel").style.display = "none";
				else window.harness.unmount();
			}, reason);
			await sleep(300);
			await page.mouse.up();
			await sleep(50);
			const calls = await inputCalls(page);
			assert.ok(calls.some((call) => call.action === "cancel"));
			assert.ok(!calls.some((call) => call.action === "click"));
			await page.close();
			return { calls };
		});
	await runCase("wheel-content-only-normalizes-direction", async () => {
		const page = await ready();
		const point = await center(page);
		const box = await page.locator("canvas").boundingBox();
		await page.evaluate(() => window.harness.clearCalls());
		await page.mouse.move(point.x, point.y);
		await page.mouse.wheel(0, 120);
		await sleep(70);
		await page.mouse.move(box.x + box.width / 2, box.y + 3);
		await page.mouse.wheel(0, 120);
		await sleep(70);
		const calls = await inputCalls(page);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].action, "wheel");
		assert.equal(calls[0].deltaY, 120);
		await page.close();
		return { calls };
	});
	await runCase("stale-geometry-and-invalid-crop-never-replace-display", async () => {
		const page = await ready();
		const original = await page.evaluate(() => window.harness.geometry().geometryId);
		await page.evaluate(() => {
			document.getElementById("panel").style.display = "none";
		});
		await sleep(300);
		await page.evaluate(() => {
			document.getElementById("panel").style.display = "";
		});
		await sleep(300);
		const current = await page.evaluate(() => window.harness.geometry().geometryId);
		assert.notEqual(current, original);
		await page.evaluate((original) => {
			window.harness.emitFrame(300, 600, { geometryId: original });
			window.harness.emitFrame(320, 400, { invalid: true });
			window.harness.clearCalls();
		}, original);
		await sleep(100);
		const dimensions = await page.$eval("canvas", (canvas) => ({ width: canvas.width, height: canvas.height }));
		assert.deepEqual(dimensions, { width: 640, height: 360 });
		const point = await center(page);
		await page.mouse.click(point.x, point.y);
		await sleep(50);
		const calls = await inputCalls(page);
		assert.equal(calls[0].geometryId, current);
		await page.close();
		return { dimensions, original, current, calls };
	});
	result.performance = {};
	for (const { latency, delta } of [
		{ latency: 30, delta: 120 },
		{ latency: 60, delta: 120 },
		{ latency: 60, delta: 2 },
	])
		await runCase(`performance-wheel-60hz-rpc-${latency}ms${delta === 2 ? "-small-delta" : ""}`, async () => {
			const page = await ready();
			const point = await center(page);
			const stopped = await page.evaluate(
				async ({ point, latency, delta }) => {
					window.harness.configurePerformance({ inputDelayMs: latency });
					const canvas = document.querySelector("canvas");
					const started = performance.now();
					for (let index = 0; index < 60; index++) {
						canvas.dispatchEvent(
							new WheelEvent("wheel", {
								clientX: point.x,
								clientY: point.y,
								deltaY: delta,
								bubbles: true,
								cancelable: true,
							}),
						);
						await new Promise((resolve) =>
							setTimeout(resolve, Math.max(0, started + ((index + 1) * 1000) / 60 - performance.now())),
						);
					}
					return performance.now();
				},
				{ point, latency, delta },
			);
			await page.mouse.click(point.x, point.y);
			await page.waitForFunction(
				() => window.harness.calls.some((call) => call.action === "click" && call.completedAt),
				undefined,
				{ timeout: 7000 },
			);
			const metrics = await page.evaluate((stopped) => {
				const wheels = window.harness.calls.filter((call) => call.action === "wheel");
				const click = window.harness.calls.find((call) => call.action === "click");
				return {
					generatedEvents: 60,
					wheelRequests: wheels.length,
					delayedWheelRequests: wheels.filter((call) => call.at > stopped).length,
					clickTailMs: click.completedAt - stopped,
					completedDelta: wheels.reduce((sum, call) => sum + call.deltaY, 0),
				};
			}, stopped);
			result.performance[`wheel-${latency}-${delta}`] = metrics;
			await page.close();
			assert.ok(metrics.delayedWheelRequests <= 1, `Wheel backlog after gesture: ${JSON.stringify(metrics)}`);
			assert.ok(
				metrics.clickTailMs <= latency * 3 + 100,
				`Click waited for old wheel events: ${JSON.stringify(metrics)}`,
			);
			assert.equal(metrics.completedDelta, 60 * delta, "Coalescing changed wheel distance before the next click");
			return metrics;
		});
	await runCase("performance-wheel-aggregated-6000-keeps-distance", async () => {
		const page = await ready();
		const point = await center(page);
		await page.evaluate(async (point) => {
			window.harness.configurePerformance({ inputDelayMs: 60 });
			const canvas = document.querySelector("canvas");
			canvas.dispatchEvent(
				new WheelEvent("wheel", { clientX: point.x, clientY: point.y, deltaY: 2, bubbles: true, cancelable: true }),
			);
			await new Promise((resolve) => setTimeout(resolve, 5));
			for (let index = 0; index < 10; index++)
				canvas.dispatchEvent(
					new WheelEvent("wheel", {
						clientX: point.x,
						clientY: point.y,
						deltaY: 600,
						bubbles: true,
						cancelable: true,
					}),
				);
		}, point);
		await page.mouse.click(point.x, point.y);
		await page.waitForFunction(() =>
			window.harness.calls.some((call) => call.action === "click" && call.completedAt),
		);
		const wheels = (await inputCalls(page)).filter((call) => call.action === "wheel");
		const deltas = wheels.map((call) => call.deltaY);
		result.performance.wheelLargeBatch = { deltas };
		await page.close();
		assert.deepEqual(deltas, [2, 6000]);
		return { deltas };
	});
	await runCase("wheel-boundary-subpixel-continuous-gestures", async () => {
		const page = await ready();
		const point = await center(page);
		const sums = [];
		for (const delta of [0.1, -0.1]) {
			await page.evaluate(
				async ({ point, delta }) => {
					window.harness.configurePerformance({ inputDelayMs: 0 });
					const canvas = document.querySelector("canvas");
					for (let index = 0; index < 60; index++) {
						canvas.dispatchEvent(
							new WheelEvent("wheel", {
								clientX: point.x,
								clientY: point.y,
								deltaY: delta,
								bubbles: true,
								cancelable: true,
							}),
						);
						await new Promise((resolve) => setTimeout(resolve, 4));
					}
				},
				{ point, delta },
			);
			await page.mouse.click(point.x, point.y);
			await sleep(20);
			const calls = await inputCalls(page);
			const wheels = calls.filter((call) => call.action === "wheel");
			const applied = wheels.reduce((sum, call) => sum + call.appliedDeltaY, 0);
			sums.push({ delta, requests: wheels.length, applied });
			assert.ok(
				wheels.every((call) => Number.isInteger(call.deltaY)),
				`Fractional input reached native integer rounding: ${JSON.stringify(sums)}`,
			);
			assert.equal(applied, Math.round(60 * delta));
			assert.equal(calls.at(-1).action, "click");
		}
		await page.close();
		return { sums };
	});
	await runCase("wheel-boundary-direction-before-following-click", async () => {
		const page = await ready();
		const point = await center(page);
		await page.evaluate(async (point) => {
			window.harness.configurePerformance({ inputDelayMs: 60 });
			const canvas = document.querySelector("canvas");
			const wheel = (deltaY) =>
				canvas.dispatchEvent(
					new WheelEvent("wheel", { clientX: point.x, clientY: point.y, deltaY, bubbles: true, cancelable: true }),
				);
			wheel(2);
			await new Promise((resolve) => setTimeout(resolve, 5));
			wheel(600);
			wheel(600);
			wheel(-400);
			wheel(-200);
		}, point);
		await page.mouse.click(point.x, point.y);
		await page.waitForFunction(() =>
			window.harness.calls.some((call) => call.action === "click" && call.completedAt),
		);
		const calls = await inputCalls(page);
		const deltas = calls.filter((call) => call.action === "wheel").map((call) => call.deltaY);
		await page.close();
		assert.deepEqual(deltas, [2, 1200, -600]);
		assert.equal(calls.at(-1).action, "click");
		return { deltas };
	});
	await runCase("wheel-boundary-alternating-60hz-stays-bounded", async () => {
		const page = await ready();
		const point = await center(page);
		const stopped = await page.evaluate(async (point) => {
			window.harness.configurePerformance({ inputDelayMs: 60 });
			const canvas = document.querySelector("canvas");
			const started = performance.now();
			for (let index = 0; index < 60; index++) {
				canvas.dispatchEvent(
					new WheelEvent("wheel", {
						clientX: point.x,
						clientY: point.y,
						deltaY: index % 2 === 0 ? 120 : -120,
						bubbles: true,
						cancelable: true,
					}),
				);
				await new Promise((resolve) =>
					setTimeout(resolve, Math.max(0, started + ((index + 1) * 1000) / 60 - performance.now())),
				);
			}
			return performance.now();
		}, point);
		await page.mouse.click(point.x, point.y);
		await page.waitForFunction(() =>
			window.harness.calls.some((call) => call.action === "click" && call.completedAt),
		);
		const metrics = await page.evaluate((stopped) => {
			const wheels = window.harness.calls.filter((call) => call.action === "wheel");
			const click = window.harness.calls.find((call) => call.action === "click");
			return {
				requests: wheels.length,
				delayedRequests: wheels.filter((call) => call.at > stopped).length,
				sum: wheels.reduce((sum, call) => sum + call.deltaY, 0),
				lastDirection: Math.sign(wheels.at(-1).deltaY),
				clickTailMs: click.completedAt - stopped,
				clickDispatchTailMs: click.at - stopped,
			};
		}, stopped);
		await page.close();
		assert.equal(metrics.sum, 0);
		assert.equal(metrics.lastDirection, -1);
		assert.ok(
			metrics.delayedRequests <= 2 && metrics.clickDispatchTailMs < 200 && metrics.clickTailMs < 270,
			JSON.stringify(metrics),
		);
		return metrics;
	});
	await runCase("performance-drag-60hz-rpc-60ms", async () => {
		const page = await ready();
		const start = await center(page, 0.2, 0.5);
		const finish = await center(page, 0.8, 0.5);
		await page.evaluate(() => window.harness.configurePerformance({ inputDelayMs: 60 }));
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		const stopped = await page.evaluate(
			async ({ start, finish }) => {
				const canvas = document.querySelector("canvas");
				const started = performance.now();
				for (let index = 1; index <= 60; index++) {
					canvas.dispatchEvent(
						new PointerEvent("pointermove", {
							pointerId: 1,
							pointerType: "mouse",
							buttons: 1,
							clientX: start.x + ((finish.x - start.x) * index) / 60,
							clientY: start.y,
							bubbles: true,
						}),
					);
					await new Promise((resolve) =>
						setTimeout(resolve, Math.max(0, started + (index * 1000) / 60 - performance.now())),
					);
				}
				window.dispatchEvent(
					new PointerEvent("pointerup", {
						pointerId: 1,
						pointerType: "mouse",
						buttons: 0,
						clientX: finish.x,
						clientY: finish.y,
						bubbles: true,
					}),
				);
				return performance.now();
			},
			{ start, finish },
		);
		await page.mouse.up();
		await page.waitForFunction(() => window.harness.calls.some((call) => call.action === "up" && call.completedAt));
		const metrics = await page.evaluate((stopped) => {
			const calls = window.harness.calls.filter((call) => call.type === "mirror.input");
			const up = calls.find((call) => call.action === "up");
			return {
				generatedMoves: 60,
				movesSent: calls.filter((call) => call.action === "move").length,
				releaseTailMs: up.completedAt - stopped,
				finalU: up.u,
				finalAction: calls.at(-1).action,
			};
		}, stopped);
		result.performance.drag = metrics;
		await page.close();
		assert.ok(metrics.movesSent < 25 && metrics.releaseTailMs < 230, JSON.stringify(metrics));
		assert.ok(Math.abs(metrics.finalU - 0.8) < 0.003);
		assert.equal(metrics.finalAction, "up");
		return metrics;
	});
	await runCase("performance-60fps-delayed-image-decode-stays-live", async () => {
		const page = await ready();
		const stopped = await page.evaluate(async () => {
			window.harness.configurePerformance({ decodeDelayMs: 55 });
			const started = performance.now();
			for (let index = 0; index < 60; index++) {
				window.harness.emitFrame();
				await new Promise((resolve) =>
					setTimeout(resolve, Math.max(0, started + ((index + 1) * 1000) / 60 - performance.now())),
				);
			}
			return performance.now();
		});
		await page.waitForFunction(
			() => {
				const metrics = window.harness.performanceMetrics();
				return metrics.draws.at(-1)?.sequence === metrics.receivedFrames;
			},
			undefined,
			{ timeout: 2000 },
		);
		const metrics = await page.evaluate((stopped) => {
			const value = window.harness.performanceMetrics();
			const during = value.draws.filter((draw) => draw.at < stopped);
			return {
				receivedFrames: value.receivedFrames,
				decodedImages: value.images,
				peakDecodes: value.maxDecodes,
				drawsDuringStream: during.length,
				totalDraws: value.draws.length,
				droppedFrames: value.receivedFrames - value.draws.length,
				maxDrawAgeMs: Math.max(...value.draws.map((draw) => draw.at - draw.frameAt)),
				lastSequence: value.draws.at(-1)?.sequence,
				drawSequences: value.draws.map((draw) => draw.sequence),
			};
		}, stopped);
		result.performance.decode = metrics;
		await page.close();
		assert.ok(metrics.drawsDuringStream >= 8, `Image decoding starved playback: ${JSON.stringify(metrics)}`);
		assert.equal(metrics.peakDecodes, 1, `Unbounded parallel Image decoding: ${JSON.stringify(metrics)}`);
		assert.ok(metrics.maxDrawAgeMs < 180);
		assert.equal(metrics.lastSequence, 60);
		assert.ok(metrics.drawSequences.every((sequence, index, all) => index === 0 || sequence > all[index - 1]));
		return metrics;
	});
} catch (error) {
	result.errors.push(error.stack ?? String(error));
	process.exitCode = 1;
} finally {
	if (browser) await browser.close();
	await new Promise((resolve) => server.close(resolve));
	result.success = result.errors.length === 0 && result.cases.every((entry) => entry.pass);
	if (!result.success) process.exitCode = 1;
	await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n");
	assert.equal(dirname(temporary), resolve(tmpdir()));
	assert.ok(basename(temporary).startsWith("owl-mirror-responsive-"));
	await rm(temporary, { recursive: true, force: true });
	process.stdout.write(
		`RESULT ${result.success ? "PASS" : "FAIL"}; ${result.cases.filter((entry) => entry.pass).length}/${result.cases.length}; errors=${JSON.stringify(result.errors)}\n`,
	);
}
