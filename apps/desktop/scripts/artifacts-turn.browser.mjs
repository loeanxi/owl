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

// Only local fake bridge/viewer servers are used; no provider APIs or user data.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), "owl-artifacts-turn-results"));
await mkdir(output, { recursive: true });
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
const cwd = join(output, "fake-workspace").replace(/\\/g, "/");
const oldUser = { role: "user", content: "生成费用测试表" };
const oldAssistant = {
	role: "assistant",
	content: [
		{ type: "text", text: "费用测试表已创建。" },
		{ type: "toolCall", id: "old-office", name: "univer_execute", arguments: { documentPath: "费用测试.univer" } },
	],
	stopReason: "toolUse",
};
const oldTool = {
	role: "toolResult",
	toolCallId: "old-office",
	toolName: "univer_execute",
	content: [{ type: "text", text: "已写入公式，设备300，耗材60，合计360。" }],
	details: { artifacts: [{ path: "费用测试.univer", action: "edited" }] },
};
const oldFinal = {
	role: "assistant",
	content: [{ type: "text", text: "请审阅 [费用测试.univer](费用测试.univer)，合计360。" }],
	stopReason: "stop",
};
const initial = [oldUser, oldAssistant, oldTool, oldFinal];
let snapshot = [...initial];
let running = false;
let sockets = new Set();
let promptCount = 0;
const result = {
	success: false,
	production: true,
	actualApp: true,
	cases: [],
	errors: [],
	requests: [],
	browserPath,
	sourceSha256: {},
	fixtureFallbacks: [],
};
for (const path of [
	"App.tsx",
	"components/ChatStream.tsx",
	"components/Artifacts.tsx",
	"hooks/artifacts.ts",
	"hooks/transcript.ts",
])
	result.sourceSha256[path] = createHash("sha256")
		.update(await readFile(join(repo, "apps/desktop/src", path)))
		.digest("hex");

const built = await build({
	entryPoints: [join(scriptDir, "fixtures/artifacts-turn.mjs")],
	outfile: join(output, "app.js"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	minify: true,
	define: { "process.env.NODE_ENV": '"production"' },
	metafile: true,
	loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
	plugins: [
		{
			name: "missing-unrelated-mail-css",
			setup(build) {
				build.onResolve({ filter: /^\.\/mail\.css$/ }, (args) => {
					if (existsSync(join(args.resolveDir, args.path))) return undefined;
					result.fixtureFallbacks.push(join(args.resolveDir, args.path));
					return { path: "fixture-empty-mail-css", namespace: "fixture" };
				});
				build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "", loader: "css" }));
			},
		},
	],
});
result.actualInputs = Object.keys(built.metafile.inputs).filter((path) =>
	/(?:App|ChatStream|Artifacts|artifacts|transcript|client)\.(?:tsx?|mjs)$/.test(path),
);
for (const component of ["App.tsx", "ChatStream.tsx", "Artifacts.tsx", "artifacts.ts", "transcript.ts", "client.ts"])
	assert.ok(
		result.actualInputs.some((path) => path.endsWith(component)),
		`Actual ${component} absent`,
	);
const cssSource = join(repo, "apps/desktop/src/index.css");
const compiler = await compile(await readFile(cssSource, "utf8"), { base: dirname(cssSource), onDependency: () => {} });
const scanner = new Scanner({
	sources: [{ base: join(repo, "apps/desktop/src"), pattern: "**/*.{ts,tsx}", negated: false }],
});
const css = `${compiler.build(scanner.scan())}\n${await readFile(join(output, "app.css"), "utf8")}`;
await writeFile(join(output, "app.css"), css);
const javascript = await readFile(join(output, "app.js"));
const html =
	'<!doctype html><html><head><meta charset="UTF-8"><title>Owl artifacts turn regression</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
const server = createServer((request, response) => {
	const path = new URL(request.url, "http://127.0.0.1").pathname;
	response.writeHead(200, {
		"content-type": path.endsWith(".js")
			? "text/javascript"
			: path.endsWith(".css")
				? "text/css"
				: path.endsWith(".svg")
					? "image/svg+xml"
					: "text/html; charset=utf-8",
	});
	response.end(
		path === "/app.js"
			? javascript
			: path === "/app.css"
				? css
				: path.endsWith(".svg")
					? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="green"/></svg>'
					: html,
	);
});
const office = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html;charset=utf-8" });
	response.end(
		'<!doctype html><html><meta charset="utf-8"><title>Isolated Office callback fixture</title><body><p>费用测试.univer 保留原文件</p></body></html>',
	);
});
await new Promise((done) => office.listen(0, "127.0.0.1", done));
const ws = new WebSocketServer({ server, path: "/ws" });
const row = {
	id: "fixture-session",
	name: "费用表回归会话",
	cwd,
	messageCount: 4,
	modified: "2026-10-03T11:00:00.000Z",
};
const otherRow = {
	id: "other-session",
	name: "另一轮普通问答",
	cwd,
	messageCount: 2,
	modified: "2026-10-03T10:00:00.000Z",
};
const stats = {
	model: { provider: "faux", id: "test-model", name: "Faux test model" },
	thinkingLevel: "medium",
	availableThinkingLevels: ["medium"],
	supportsThinking: true,
	contextUsage: { tokens: 100, contextWindow: 200000, percent: 0.05 },
};
ws.on("connection", (socket) => {
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
	socket.on("message", (raw) => {
		const request = JSON.parse(String(raw));
		result.requests.push({
			type: request.type,
			sessionId: request.sessionId,
			message: request.message,
			path: request.path,
		});
		let value = {};
		if (request.type === "models.list") value = [];
		if (request.type === "viewer.list")
			value = { viewers: [{ id: "fixture-office", title: "Office", extensions: ["univer", "xlsx"] }] };
		if (request.type === "viewer.open")
			value = {
				url: `http://127.0.0.1:${office.address().port}/?path=${encodeURIComponent(request.path)}`,
				title: request.path,
			};
		if (request.type === "git.status") value = { repo: false, entries: [] };
		if (request.type === "session.list") value = [row, otherRow];
		if (request.type === "session.running") value = { running: running ? ["fixture-session"] : [] };
		if (request.type === "settings.get")
			value = {
				agentDir: "fixture-only",
				settings: { theme: "dark", uiLanguage: "zh-CN", owlNotifications: { enabled: false } },
			};
		if (request.type === "project.create") value = { path: cwd };
		if (request.type === "commands.list") value = { commands: [] };
		if (request.type === "session.stats") value = stats;
		if (request.type === "session.resume")
			value = {
				sessionId: request.sessionId,
				cwd,
				messages:
					request.sessionId === "other-session"
						? [
								{ role: "user", content: "另一轮问答" },
								{ role: "assistant", content: [{ type: "text", text: "另一轮没有产物。" }] },
							]
						: snapshot,
				messageEntryIds: snapshot.map((_, index) => "entry-" + index),
			};
		if (request.type === "session.create") value = { sessionId: "new-fixture" };
		if (request.type === "session.prompt") {
			promptCount++;
			snapshot.push({ role: "user", content: request.message });
			running = true;
		}
		socket.send(
			JSON.stringify({
				type: "response",
				id: request.id,
				ok: request.type !== "news.request",
				result: value,
				error: request.type === "news.request" ? "News disabled in isolated chat fixture" : undefined,
			}),
		);
	});
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
result.origin = origin;
const browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.on("pageerror", (error) => result.errors.push(error.message));
await page.route("**/*", (route) =>
	new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
);
await page.addInitScript(
	({ cwd }) => {
		localStorage.setItem("owl.workspaceDir", cwd);
		localStorage.setItem("owl.model", "faux/test-model");
		localStorage.setItem("owl.uiLanguage", "zh-CN");
		localStorage.setItem("owl.workbench.open", "0");
	},
	{ cwd },
);
function emit(event) {
	for (const socket of sockets) socket.send(JSON.stringify({ type: "event", sessionId: "fixture-session", event }));
}
async function pause() {
	await new Promise((done) => setTimeout(done, 100));
}
async function paths() {
	return await page
		.locator(".owl-chat-column > .owl-artifacts .owl-artifact-file")
		.evaluateAll((elements) => elements.map((element) => element.getAttribute("title")));
}
async function historicalPaths() {
	return await page
		.locator(".owl-chat-column .owl-chat-row .owl-artifact-file")
		.evaluateAll((elements) => elements.map((element) => element.getAttribute("title")));
}
async function assertHistoricalBeforeNewUser() {
	const state = await page.locator(".owl-chat-column").evaluate((element) => {
		const old = [...element.querySelectorAll(".owl-artifact-file")].find((node) => node.title === "费用测试.univer");
		const latestUser = [...element.querySelectorAll("[data-qidx]")].find((node) =>
			node.textContent.includes("你是什么模型"),
		);
		return {
			oldCount: [...element.querySelectorAll(".owl-artifact-file")].filter((node) => node.title === "费用测试.univer")
				.length,
			before: !!old && !!latestUser && !!(old.compareDocumentPosition(latestUser) & Node.DOCUMENT_POSITION_FOLLOWING),
		};
	});
	assert.deepEqual(state, { oldCount: 1, before: true });
}
async function caseRun(name, operation) {
	const entry = { name, success: false };
	try {
		Object.assign(entry, await operation());
		entry.success = true;
	} catch (error) {
		entry.failure = error.message;
	}
	result.cases.push(entry);
	console.log(`${entry.success ? "PASS" : "FAIL"} ${name}${entry.failure ? ": " + entry.failure : ""}`);
}
async function submit(text) {
	const before = promptCount;
	await page.getByRole("textbox", { name: "任务输入", exact: true }).fill(text);
	await page.getByRole("textbox", { name: "任务输入", exact: true }).press("Enter");
	await page.waitForFunction((text) => document.querySelector(".owl-chat-scroll")?.textContent.includes(text), text);
	assert.equal(promptCount, before + 1);
	await pause();
}
function settle(user, assistant, extra = []) {
	snapshot.push(...extra, assistant);
	emit({ type: "message_end", message: assistant });
	emit({ type: "agent_end", messages: [{ role: "user", content: user }, ...extra, assistant] });
	running = false;
	emit({ type: "agent_settled" });
}
try {
	await page.goto(origin);
	await page.waitForSelector(".owl-artifact-file");
	await caseRun("historical-last-turn-office-visible", async () => {
		assert.deepEqual(await paths(), ["费用测试.univer"]);
		await page.screenshot({ path: join(output, "01-previous-turn.png") });
		return { paths: await paths() };
	});
	await submit("你是什么模型");
	await caseRun(
		"new-user-immediately-clears-previous-footer-before-agent-start-and-retains-historical-card",
		async () => {
			const actual = await paths();
			await page.screenshot({ path: join(output, "02-new-question.png") });
			assert.deepEqual(actual, []);
			assert.match(await page.locator(".owl-chat-scroll").innerText(), /费用测试表已创建/);
			await assertHistoricalBeforeNewUser();
			return { paths: actual, historicalPaths: await historicalPaths(), historyPreserved: true };
		},
	);
	await caseRun("historical-card-still-opens-original-office-file", async () => {
		await page.locator('.owl-chat-row .owl-artifact-file[title="费用测试.univer"]').click({ timeout: 2000 });
		await page.waitForSelector(".owl-plugin-viewer iframe");
		assert.equal(result.requests.findLast((request) => request.type === "viewer.open")?.path, "费用测试.univer");
		await page.getByRole("button", { name: "关闭工作台", exact: true }).click();
		return { opened: "费用测试.univer", actualAppOpenCallback: true };
	});
	emit({ type: "agent_start" });
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "我是 Faux 测试模型。" } });
	await pause();
	await caseRun("qa-streaming-has-no-previous-deliverable", async () => {
		assert.deepEqual(await paths(), []);
		return { paths: await paths() };
	});
	settle("你是什么模型", {
		role: "assistant",
		content: [{ type: "text", text: "我是 Faux 测试模型。" }],
		stopReason: "stop",
	});
	await pause();
	await caseRun("qa-authoritative-agent-end-keeps-history-without-footer-artifacts", async () => {
		assert.deepEqual(await paths(), []);
		assert.match(await page.locator(".owl-chat-scroll").innerText(), /费用测试表已创建/);
		await assertHistoricalBeforeNewUser();
		return { historyPreserved: true, historicalPaths: await historicalPaths() };
	});
	await page.reload();
	await page.waitForSelector(".owl-chat-scroll");
	await page.waitForFunction(() =>
		document.querySelector(".owl-chat-scroll")?.textContent.includes("我是 Faux 测试模型。"),
	);
	await caseRun("qa-snapshot-restore-keeps-old-artifact-in-original-history-row", async () => {
		assert.deepEqual(await paths(), []);
		await assertHistoricalBeforeNewUser();
		return { paths: await paths(), historicalPaths: await historicalPaths() };
	});
	await submit("导出新一轮费用表");
	emit({ type: "agent_start" });
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({
		type: "tool_execution_start",
		toolCallId: "new-output",
		toolName: "univer_export",
		args: { outputPath: "费用测试-v2.xlsx" },
	});
	await pause();
	await caseRun("current-tool-pending-does-not-show-old-or-unfinished-artifacts", async () => {
		assert.deepEqual(await paths(), []);
		return { paths: await paths() };
	});
	emit({
		type: "tool_execution_start",
		toolCallId: "failed-output",
		toolName: "univer_export",
		args: { outputPath: "失败的.xlsx" },
	});
	emit({
		type: "tool_execution_end",
		toolCallId: "failed-output",
		result: {
			content: [{ type: "text", text: "导出失败" }],
			details: { artifacts: [{ path: "失败的.xlsx", action: "written" }] },
		},
		isError: true,
	});
	await pause();
	await caseRun("failed-current-output-never-creates-artifact-card", async () => {
		assert.deepEqual(await paths(), []);
		return { paths: await paths() };
	});
	const newAssistant = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "new-output", name: "univer_export", arguments: { outputPath: "费用测试-v2.xlsx" } },
		],
		stopReason: "toolUse",
	};
	const newTool = {
		role: "toolResult",
		toolCallId: "new-output",
		content: [{ type: "text", text: "导出完成" }],
		details: { artifacts: [{ path: "费用测试-v2.xlsx", action: "written" }] },
	};
	emit({ type: "tool_execution_end", toolCallId: "new-output", result: newTool, isError: false });
	await pause();
	await caseRun("only-current-successful-tool-artifact-visible", async () => {
		assert.deepEqual(await paths(), ["费用测试-v2.xlsx"]);
		return { paths: await paths() };
	});
	settle(
		"导出新一轮费用表",
		{ role: "assistant", content: [{ type: "text", text: "本轮导出成功。" }], stopReason: "stop" },
		[newAssistant, newTool],
	);
	await pause();
	await caseRun("current-artifact-survives-agent-end", async () => {
		assert.deepEqual(await paths(), ["费用测试-v2.xlsx"]);
		await page.screenshot({ path: join(output, "03-current-artifact.png") });
		return { paths: await paths() };
	});
	await page.reload();
	await page.waitForSelector(".owl-artifact-file");
	await caseRun("snapshot-restore-only-restores-last-turn-artifact", async () => {
		assert.deepEqual(await paths(), ["费用测试-v2.xlsx"]);
		assert.match(await page.locator(".owl-chat-scroll").innerText(), /费用测试表已创建/);
		return { paths: await paths(), historyPreserved: true };
	});
	await submit("本轮继续修改费用测试.univer");
	emit({ type: "agent_start" });
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({
		type: "tool_execution_start",
		toolCallId: "same-file",
		toolName: "univer_execute",
		args: { documentPath: "费用测试.univer" },
	});
	emit({
		type: "tool_execution_end",
		toolCallId: "same-file",
		result: {
			content: [{ type: "text", text: "本轮修改成功" }],
			details: { artifacts: [{ path: "费用测试.univer", action: "edited" }] },
		},
		isError: false,
	});
	await pause();
	await caseRun("same-old-file-becomes-artifact-when-edited-in-current-turn", async () => {
		assert.deepEqual(await paths(), ["费用测试.univer"]);
		assert.match(await page.locator(".owl-chat-column > .owl-artifacts").innerText(), /已更新/);
		assert.deepEqual(await historicalPaths(), ["费用测试.univer", "费用测试-v2.xlsx"]);
		assert.equal(await page.locator('.owl-artifact-file[title="费用测试.univer"]').count(), 2);
		return { paths: await paths(), historicalPaths: await historicalPaths() };
	});
	emit({
		type: "tool_execution_start",
		toolCallId: "repeat-file",
		toolName: "univer_execute",
		args: { documentPath: "费用测试.univer" },
	});
	emit({
		type: "tool_execution_end",
		toolCallId: "repeat-file",
		result: {
			content: [{ type: "text", text: "同轮再次修改成功" }],
			details: { artifacts: [{ path: "费用测试.univer", action: "edited" }] },
		},
		isError: false,
	});
	await pause();
	await caseRun("same-turn-repeated-file-edits-remain-one-card-per-turn", async () => {
		assert.deepEqual(await paths(), ["费用测试.univer"]);
		assert.equal(await page.locator('.owl-artifact-file[title="费用测试.univer"]').count(), 2);
		return { currentCount: 1, historicalCount: 1 };
	});
	running = false;
	emit({ type: "agent_settled" });
	await pause();
	await page.getByRole("button", { name: "另一轮普通问答", exact: false }).first().click();
	await pause();
	await caseRun("switching-to-no-artifact-session-does-not-leak-previous-output", async () => {
		assert.deepEqual(await paths(), []);
		assert.match(await page.locator(".owl-chat-scroll").innerText(), /另一轮没有产物/);
		await page.screenshot({ path: join(output, "04-switched-session.png") });
		return { paths: await paths() };
	});
	result.success = result.errors.length === 0 && result.cases.every((entry) => entry.success);
	if (!result.success) process.exitCode = 1;
} finally {
	await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n");
	await browser.close();
	for (const socket of sockets) socket.terminate();
	await new Promise((done) => ws.close(done));
	await new Promise((done) => server.close(done));
	await new Promise((done) => office.close(done));
}
