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

/**
 * Claude 式回答流的可见内容回归：
 * 单行说明 / 单行思考是否把整轮压成几行灰字（用户实测「上半屏一片空白」）。
 *
 * 只打包真实的 ChatStream 与当前样式，喂固定的会话结构，量出可见行数与被隐藏的高度。
 * 不连真实 bridge、不读用户会话、不发模型请求。
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), "owl-claude-flow-visibility"));
await mkdir(output, { recursive: true });

const browserPath = [
	process.env.OWL_BROWSER_TEST_EXECUTABLE,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((candidate) => candidate && existsSync(candidate));
assert.ok(browserPath, "Set OWL_BROWSER_TEST_EXECUTABLE to an installed browser.");

const result = { cases: [], errors: [], browserPath, sourceSha256: {} };
const srcDir = join(repo, "apps/desktop/src");
for (const path of ["components/ChatStream.tsx", "components/ClaudeNoteRow.tsx", "components/claude-narration.ts", "components/claude-thinking-shape.ts"])
	result.sourceSha256[path] = createHash("sha256").update(await readFile(join(srcDir, path))).digest("hex");

const built = await build({
	entryPoints: [join(scriptDir, "fixtures/claude-flow-visibility.mjs")],
	outfile: join(output, "app.js"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	minify: true,
	define: { "process.env.NODE_ENV": '"production"', "import.meta.env.BASE_URL": '"/"' },
	metafile: true,
	loader: { ".svg": "dataurl", ".png": "dataurl", ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".eot": "dataurl" },
});
result.actualInputs = Object.keys(built.metafile.inputs).filter((path) => /ChatStream\.tsx$|ClaudeNoteRow\.tsx$/.test(path));
assert.ok(result.actualInputs.some((p) => p.endsWith("ChatStream.tsx")), "Actual ChatStream absent");

const cssSource = join(srcDir, "index.css");
const compiler = await compile(await readFile(cssSource, "utf8"), { base: dirname(cssSource), onDependency: () => {} });
const scanner = new Scanner({ sources: [{ base: srcDir, pattern: "**/*.{ts,tsx}", negated: false }] });
const css = compiler.build(scanner.scan());
await writeFile(join(output, "app.css"), css);
const javascript = await readFile(join(output, "app.js"));
const html = '<!doctype html><html data-owl-claude-flow="on" data-owl-thinking-style="claude" data-theme="dark"><head><meta charset="UTF-8"><title>Claude flow visibility</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';

const server = createServer((request, response) => {
	const path = new URL(request.url, "http://127.0.0.1").pathname;
	response.writeHead(200, {
		"content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html;charset=utf-8",
	});
	response.end(path === "/app.js" ? javascript : path === "/app.css" ? css : html);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(5000);
page.on("pageerror", (error) => result.errors.push(error.message));
await page.route("**/*", (route) => {
	let sameOrigin = false;
	try {
		sameOrigin = new URL(route.request().url()).origin === origin;
	} catch {
		sameOrigin = false;
	}
	if (sameOrigin) return route.continue();
	result.errors.push(`Unexpected request: ${route.request().url()}`);
	return route.abort();
});

await page.goto(`${origin}/`, { waitUntil: "load" });
try {
	await page.waitForSelector(".owl-chat-scroll", { state: "attached", timeout: 8000 });
} catch (error) {
	const body = await page.evaluate(() => document.body.innerHTML.slice(0, 800)).catch(() => "<unreadable>");
	result.errors.push(`chat surface missing: ${error instanceof Error ? error.message : String(error)}`);
	result.errors.push(`body: ${body}`);
	await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
	await browser.close();
	server.close();
	console.log(JSON.stringify({ success: false, errors: result.errors }, null, 2));
	process.exitCode = 1;
	process.exit(1);
}
await page.waitForTimeout(400);

const measure = () =>
	page.evaluate(() => {
		const surface = document.querySelector(".owl-chat-surface");
		const scroll = document.querySelector(".owl-chat-scroll");
		const column = document.querySelector(".owl-chat-column");
		const visibleText = (el) => {
			if (!el) return "";
			const style = getComputedStyle(el);
			if (style.display === "none" || style.visibility === "hidden") return "";
			const rect = el.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) return "";
			return (el.textContent ?? "").trim();
		};
		const rows = [...document.querySelectorAll(".owl-chat-column > *")];
		const rowInfo = rows.map((row) => {
			const rect = row.getBoundingClientRect();
			return {
				text: (row.textContent ?? "").trim().slice(0, 70),
				height: Math.round(rect.height),
				top: Math.round(rect.top),
			};
		});
		// 可见的说明行 / 思考行 / 工具组头
		const notes = [...document.querySelectorAll(".owl-claude-note")].map(visibleText).filter(Boolean);
		const thinks = [...document.querySelectorAll(".owl-claude-thinking")].map(visibleText).filter(Boolean);
		const groups = [...document.querySelectorAll(".owl-claude-group")].map(visibleText).filter(Boolean);
		const answers = [...document.querySelectorAll("[data-owl-answer='true'] .owl-answer-reading")].map(visibleText).filter(Boolean);
		// 从滚动区顶到第一行可见内容的空白高度
		const firstRow = rows.find((row) => (row.textContent ?? "").trim() !== "" && row.getBoundingClientRect().height > 1);
		const contentTop = scroll ? scroll.getBoundingClientRect().top + scroll.clientTop : 0;
		const firstTop = firstRow ? firstRow.getBoundingClientRect().top : 0;
		return {
			noteCount: notes.length,
			thinkCount: thinks.length,
			groupCount: groups.length,
			answerCount: answers.length,
			notes,
			thinks,
			groups,
			answers: answers.map((t) => t.slice(0, 60)),
			rowCount: rows.length,
			rowInfo,
			blankBeforeFirstContent: Math.round(firstTop - contentTop),
			contentHeight: Math.round(column?.getBoundingClientRect().height ?? 0),
			scrollHeight: scroll?.scrollHeight ?? 0,
			clientHeight: scroll?.clientHeight ?? 0,
			surfaceActivity: surface?.getAttribute("data-activity") ?? "",
		};
	});

const before = await measure();
result.cases.push({ name: "claude-flow-visibility", ...before });
// 收起态就是用户看到的界面，先留一张。
await page.screenshot({ path: join(output, "claude-flow.png"), fullPage: false });

// 思考行点开后必须还是全部原文 —— 合成一行只是折叠，不能把内容弄丢。
await page.click(".owl-claude-thinking-head").catch(() => {});
await page.waitForTimeout(150);
result.mergedThinkingPanel = await page.evaluate(() => (document.querySelector(".owl-claude-thinking-panel")?.textContent ?? "").trim());
await page.screenshot({ path: join(output, "claude-flow-expanded.png"), fullPage: false });
result.thinkingDebug = await page.evaluate(() => {
	const all = [...document.querySelectorAll(".owl-claude-thinking")];
	return {
		total: all.length,
		details: all.map((el) => {
			const rect = el.getBoundingClientRect();
			const style = getComputedStyle(el);
			return {
				label: (el.querySelector(".owl-claude-thinking-label")?.textContent ?? "").slice(0, 50),
				h: Math.round(rect.height),
				w: Math.round(rect.width),
				display: style.display,
				visibility: style.visibility,
				opacity: style.opacity,
				dataOpen: el.getAttribute("data-open"),
			};
		}),
	};
});

// 期望：这一轮的中间内容不能被压成几行灰字 —— 至少每段说明都要有一条可见的落点。
const expectations = {
	// 整轮的思考合成**一行**（Claude 的 "Thought for 12s"）：一轮十几次工具往返
	// 不再是十几行碎行。展开后原文必须一条不少（见下面的 thinkingMerged）。
	minThink: 1,
	// 夹具里 5 段单行说明：修复前全部不渲染（0 段），这是用户「内容凭空消失」的主因。
	minNote: 5,
	// 10 次工具调用聚成 4 个组，组头应可见
	minGroup: 1,
	// 必须有最终答案
	minAnswer: 1,
	// 合成的那一行点开后，要能看到本轮各段思考的原文（抽两段互不相邻的做判据）。
	thinkingMerged: result.mergedThinkingPanel.includes("subagents_enable 不在可用工具里") && result.mergedThinkingPanel.includes("Third line."),
};
result.expectations = expectations;
result.pass = {
	thinks: before.thinkCount >= expectations.minThink,
	notes: before.noteCount >= expectations.minNote,
	groups: before.groupCount >= expectations.minGroup,
	answers: before.answerCount >= expectations.minAnswer,
	thinkingMerged: expectations.thinkingMerged,
};
result.success = Object.values(result.pass).every(Boolean) && result.errors.length === 0;

await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
await browser.close();
server.close();
console.log(JSON.stringify({
	success: result.success,
	pass: result.pass,
	measured: {
		thinks: before.thinkCount,
		notes: before.noteCount,
		groups: before.groupCount,
		answers: before.answerCount,
		blankBeforeFirstContent: before.blankBeforeFirstContent,
		mergedThinkingChars: result.mergedThinkingPanel.length,
	},
	errors: result.errors,
	output,
}, null, 2));
if (!result.success) process.exitCode = 1;
