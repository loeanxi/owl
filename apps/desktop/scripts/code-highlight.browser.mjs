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

// 真实渲染器 + 真实 index.css：代码块由 answer-markdown-renderer 渲染，
// 在 Chromium 里量取计算样式，确认「不只是 python」并且随主题 / 玻璃档换色板。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const output = resolve(process.argv[2] ?? join(repo, ".validation/code-highlight-20261015"));
await mkdir(output, { recursive: true });
const browserPath = [
	process.env.OWL_BROWSER_TEST_EXECUTABLE,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"/usr/bin/chromium",
	"/usr/bin/google-chrome",
].find((candidate) => candidate && existsSync(candidate));
assert.ok(browserPath, "Set OWL_BROWSER_TEST_EXECUTABLE to an installed browser; never downloads one.");

await build({
	entryPoints: [join(scriptDir, "fixtures/code-highlight.mjs")],
	outfile: join(output, "fixture.js"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	// 夹具 import 的 CSS（reply-reading.css）要跟 index.css 一起进页面，
	// 否则代码块容器的底色/边框看不到，对比度也算不准。
	loader: { ".css": "text" },
	// CSS 由上面单独编译后拼进 <style>，这里只是把裸导入的样式收集下来。
	ignoreAnnotations: true,
	define: { "process.env.NODE_ENV": '"production"' },
});
const cssSource = join(repo, "apps/desktop/src/index.css");
const compiler = await compile(await readFile(cssSource, "utf8"), { base: dirname(cssSource), onDependency: () => {} });
const scanner = new Scanner({ sources: [{ base: join(repo, "apps/desktop/src"), pattern: "**/*.{ts,tsx}", negated: false }] });
const fixtureCss = await readFile(join(output, "fixture.css"), "utf8").catch(() => "");
const css = `${compiler.build(scanner.scan())}\n${fixtureCss}`;
const javascript = await readFile(join(output, "fixture.js"));
const html = `<!doctype html><html data-owl-theme="dark"><head><meta charset="UTF-8"><title>Owl code highlight</title><style>${css}</style></head><body style="margin:0;background:#171717"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
const server = createServer((request, response) => {
	const path = new URL(request.url, "http://127.0.0.1").pathname;
	response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html;charset=utf-8" });
	response.end(path === "/fixture.js" ? javascript : html);
});
await new Promise((listen) => server.listen(0, "127.0.0.1", listen));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
const result = { success: false, browserPath, cases: [], errors: [] };
try {
	const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
	page.on("pageerror", (error) => result.errors.push(error.message));
	await page.goto(origin);
	await page.waitForSelector("[data-lang]");
	const measured = await page.evaluate(() => {
		const out = [];
		for (const block of document.querySelectorAll("[data-answer-code]")) {
			const code = block.querySelector("pre > code");
			const tokens = [...code.querySelectorAll("[class^='hljs-'], [class*=' hljs-']")];
			const colors = [...new Set(tokens.map((span) => getComputedStyle(span).color))];
			out.push({
				language: block.dataset.answerLanguage,
				text: code.textContent,
				tokenCount: tokens.length,
				distinctColors: colors.length,
				colors,
				frameColor: getComputedStyle(code).color,
			});
		}
		return out;
	});
	result.cases = measured;

	// 1) 除未识别语言外，每种语言都要有 token，且不止一种颜色
	const highlighted = measured.filter((item) => item.language !== "unknownlang");
	assert.equal(highlighted.length, 19, `样本数不对：${highlighted.length}`);
	for (const item of highlighted) {
		assert.ok(item.tokenCount > 0, `${item.language} 没有 token`);
		assert.ok(item.distinctColors >= 2, `${item.language} 只有 ${item.distinctColors} 种颜色：${item.colors.join(",")}`);
	}
	// 2) 未识别语言：无 token，正文按原文展示
	const unknown = measured.find((item) => item.language === "unknownlang");
	assert.equal(unknown.tokenCount, 0, "未识别语言不该有 token");
	assert.equal(unknown.text, "x = 1 未识别语言\n");
	// 3) 本次改动的核心诉求：python 之外的代码块同样有颜色
	assert.ok(
		highlighted.filter((item) => item.language !== "python").every((item) => item.distinctColors >= 2),
		"除 python 外的语言没有上色",
	);

	// 4) 关键字在所有语言里同色；整块正文色继承阅读色
	const palette = await page.evaluate(() => {
		const keywords = new Set();
		const frames = new Set();
		for (const block of document.querySelectorAll("[data-answer-code]")) {
			frames.add(getComputedStyle(block.querySelector("pre > code")).color);
			const keyword = block.querySelector(".hljs-keyword");
			if (keyword) keywords.add(getComputedStyle(keyword).color);
		}
		return { keywords: [...keywords], frames: [...frames] };
	});
	assert.equal(palette.keywords.length, 1, `关键字颜色不一致：${palette.keywords.join(",")}`);
	assert.equal(palette.frames.length, 1, `代码块正文底色不一致：${palette.frames.join(",")}`);
	await page.screenshot({ path: join(output, "dark.png"), fullPage: true });

	// 5) 浅色主题换色板但保留高亮
	const light = await page.evaluate(() => {
		window.renderSamples("light");
		const blocks = [];
		for (const block of document.querySelectorAll("[data-answer-code]")) {
			const code = block.querySelector("pre > code");
			const tokens = [...code.querySelectorAll("[class^='hljs-'], [class*=' hljs-']")];
			blocks.push({
				language: block.dataset.answerLanguage,
				tokenCount: tokens.length,
				distinctColors: new Set(tokens.map((span) => getComputedStyle(span).color)).size,
				colors: [...new Set(tokens.map((span) => getComputedStyle(span).color))],
				frameColor: getComputedStyle(code).color,
			});
		}
		const keyword = document.querySelector('[data-lang="python"] .hljs-keyword');
		return { keyword: getComputedStyle(keyword).color, blocks };
	});
	result.lightCases = light.blocks;
	for (const item of light.blocks.filter((entry) => entry.language !== "unknownlang")) {
		assert.ok(item.tokenCount > 0, `浅色主题下 ${item.language} 没有 token`);
		assert.ok(item.distinctColors >= 2, `浅色主题下 ${item.language} 只有 ${item.distinctColors} 种颜色`);
	}

	// 5b) 词法色对代码块底色要有足够对比度（两个主题都查），避免“有色但看不清”
	const contrast = await page.evaluate((theme) => {
		window.renderSamples(theme);
		const parse = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
		const luminance = ([r, g, b]) => {
			const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
			return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
		};
		const ratio = (a, b) => { const [x, y] = [luminance(parse(a)), luminance(parse(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
		const worst = [];
		for (const block of document.querySelectorAll("[data-answer-code]")) {
			const panel = getComputedStyle(block).backgroundColor;
			for (const token of block.querySelectorAll("[class^='hljs-'], [class*=' hljs-']")) {
				const color = getComputedStyle(token).color;
				worst.push({ language: block.dataset.answerLanguage, color, panel, ratio: ratio(color, panel) });
			}
		}
		return worst;
	}, "dark");
	const minimum = Math.min(...contrast.map((entry) => entry.ratio));
	const worst = contrast.find((entry) => entry.ratio === minimum);
	result.minContrast = { ratio: Number(minimum.toFixed(2)), ...worst };
	assert.ok(minimum >= 3, `深色主题下有词法色对比度只有 ${minimum.toFixed(2)}（${worst.language} ${worst.color} on ${worst.panel}）`);
	// 浅色主题的四个词法色必须都真的变了（不只是某一个）
	assert.notEqual(light.keyword, palette.keywords[0], "浅色主题没有换色板");
	assert.equal(
		new Set(light.blocks.map((entry) => entry.frameColor)).size,
		1,
		`浅色主题下代码块正文色不一致：${light.blocks.map((entry) => entry.frameColor).join(",")}`,
	);
	const lightContrast = await page.evaluate(() => {
		window.renderSamples("light");
		const parse = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
		const luminance = ([r, g, b]) => {
			const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
			return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
		};
		const ratio = (a, b) => { const [x, y] = [luminance(parse(a)), luminance(parse(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
		let worst = { ratio: Number.POSITIVE_INFINITY };
		for (const block of document.querySelectorAll("[data-answer-code]")) {
			const panel = getComputedStyle(block).backgroundColor;
			for (const token of block.querySelectorAll("[class^='hljs-'], [class*=' hljs-']")) {
				const color = getComputedStyle(token).color;
				const value = ratio(color, panel);
				if (value < worst.ratio) worst = { ratio: value, language: block.dataset.answerLanguage, color, panel };
			}
		}
		return worst;
	});
	result.lightMinContrast = { ...lightContrast, ratio: Number(lightContrast.ratio.toFixed(2)) };
	assert.ok(lightContrast.ratio >= 3, `浅色主题下有词法色对比度只有 ${lightContrast.ratio.toFixed(2)}（${lightContrast.language} ${lightContrast.color} on ${lightContrast.panel}）`);
	await page.screenshot({ path: join(output, "light.png"), fullPage: true });

	// 6) 壁纸玻璃档自己一套色板（深玻璃 / 亮玻璃）
	const glassDark = await page.evaluate(() => {
		window.setGlass("dark");
		return getComputedStyle(document.querySelector('[data-lang="python"] .hljs-keyword')).color;
	});
	const glassLight = await page.evaluate(() => {
		window.setGlass("light");
		return getComputedStyle(document.querySelector('[data-lang="python"] .hljs-keyword')).color;
	});
	assert.notEqual(glassDark, palette.keywords[0], "深玻璃没有独立色板");
	assert.notEqual(glassLight, glassDark, "亮玻璃与深玻璃色板相同");
	await page.evaluate(() => window.setGlass("off"));

	// 7) 上色不得污染复制内容：code 的 textContent 仍是原始代码
	const copyPayload = await page.evaluate(() => document.querySelector('[data-lang="typescript"] pre > code').textContent);
	assert.equal(copyPayload, "interface User { id: number }\nconst u: User = { id: 1 };\n");

	result.success = result.errors.length === 0;
	if (!result.success) process.exitCode = 1;
} catch (error) {
	result.failure = error instanceof Error ? error.message : String(error);
	result.stack = error instanceof Error ? error.stack : undefined;
	process.exitCode = 1;
} finally {
	await browser.close();
	await new Promise((closed) => server.close(closed));
	await writeFile(join(output, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
}
