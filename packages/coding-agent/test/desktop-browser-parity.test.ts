import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { BrowserHub } from "../src/modes/desktop/browser-hub.ts";
import { initializeBrowserInteraction } from "../src/modes/desktop/browser-interaction.ts";

const browserPath = [
	process.env.OWL_BROWSER_TEST_EXECUTABLE,
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

const firstPage = `<!doctype html><html><head><title>Owl 浏览器能力验收</title></head><body>
<h1 id="title">Owl 浏览器能力验收</h1>
<p id="intro">右侧边栏浏览器的静态读取与交互。</p>
<input id="name" type="text" placeholder="请输入名称">
<input id="agree" type="checkbox">
<button id="go">前往下一页</button>
<div id="source" draggable="true" style="width:80px;height:30px;background:#333;color:#fff">拖我</div>
<div id="target" style="width:180px;height:70px;border:1px dashed #666">放到这里</div>
<script>
window.__owlRefs={next:100,map:new Map()};
window.__dropped=0;
const source=document.querySelector('#source');
const target=document.querySelector('#target');
const mark=()=>{window.__dropped++;target.textContent='已放下';};
target.addEventListener('dragover',e=>{e.preventDefault();});
target.addEventListener('drop',e=>{e.preventDefault();mark();});
target.addEventListener('mouseup',()=>{if(window.__dragging)mark();});
source.addEventListener('dragstart',e=>{window.__dragging=true;if(e.dataTransfer)e.dataTransfer.setData('text/plain','x');});
source.addEventListener('mousedown',()=>{window.__dragging=true;});
document.querySelector('#go').addEventListener('click',()=>{location.href='/next';});
</script></body></html>`;

const secondPage = `<!doctype html><html><head><title>第二页</title></head><body><h1>第二页</h1></body></html>`;

interface QueryElement {
	ref: number;
	tag: string;
	type?: string;
	label: string;
	visible: boolean;
}

interface NotFound {
	found: false;
	reason: string;
}

type TextQueryResult = { found: true; text: string; length: number; truncated: boolean } | NotFound;

type DomQueryResult = { found: true; html: string; length: number; truncated: boolean } | NotFound;

type ElementsQueryResult = { found: true; total?: number; elements: QueryElement[] } | NotFound;

interface HistoryResult {
	url: string;
}

interface CheckResult {
	checked: boolean;
}

interface ClickAndWaitResult {
	navigated: boolean;
	url: string;
}

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

function text(result: ToolResult): string {
	return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

// Real browser, isolated context and local fixture only; no user profiles or external services.
describe.skipIf(!browserPath)("desktop browser parity actions", () => {
	let server: Server;
	let hub: BrowserHub;
	let baseUrl: string;
	const sessionId = "parity-session";

	const run = async (name: string, params: Record<string, unknown>): Promise<string> => {
		const tool = hub.tools(sessionId).find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`工具未注册: ${name}`);
		const result = await tool.execute("call-1", params, undefined, undefined, undefined as never);
		return text(result);
	};

	const call = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
		const raw = await run(name, params);
		try {
			return JSON.parse(raw) as T;
		} catch {
			throw new Error(`工具 ${name} 未返回 JSON: ${raw.slice(0, 200)}`);
		}
	};

	const found = <T extends { found: true }>(result: T | NotFound, name: string): T => {
		if (!result.found) throw new Error(`${name} 未命中: ${result.reason}`);
		return result;
	};

	beforeAll(async () => {
		await initializeBrowserInteraction();
		process.env.OWL_BROWSER_PATH = browserPath;
		server = createServer((request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(request.url === "/next" ? secondPage : firstPage);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		hub = new BrowserHub({
			onPagesChanged: () => {},
			onFrame: () => {},
			onFileChooser: () => {},
			onDiagnostic: () => {},
		});
	}, 20_000);

	afterAll(async () => {
		await hub?.dispose();
		await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
	});

	it("reads the page as text, DOM, editable controls and by accessible name", async () => {
		await hub.open({ url: `${baseUrl}/`, sessionId });

		const text = found(await call<TextQueryResult>("browser_query", { kind: "text" }), "browser_query");
		expect(text.text).toContain("右侧边栏浏览器");

		const dom = found(await call<DomQueryResult>("browser_query", { kind: "dom" }), "browser_query");
		expect(dom.html).toContain("<html>");
		expect(dom.html).toContain('id="go"');

		const editable = found(await call<ElementsQueryResult>("browser_query", { kind: "editable" }), "browser_query");
		expect(editable.elements.map((element) => element.label).join(" ")).toContain("请输入名称");

		const semantic = found(
			await call<ElementsQueryResult>("browser_query", { kind: "semantic", name: "前往下一页" }),
			"browser_query",
		);
		expect(semantic.elements[0].ref).toBeGreaterThan(0);
	});

	it("uses a query ref for a later action on the same page", async () => {
		await hub.open({ url: `${baseUrl}/`, sessionId });
		const semantic = found(
			await call<ElementsQueryResult>("browser_query", { kind: "semantic", name: "前往下一页" }),
			"browser_query",
		);
		const ref = semantic.elements[0].ref;

		await call<CheckResult>("browser_check", { ref: 0, checked: false }).catch(() => undefined);
		const checked = await call<CheckResult>("browser_check", { selector: "#agree", checked: true });
		expect(checked.checked).toBe(true);
		expect(typeof ref).toBe("number");
	});

	it("navigates history without losing the page", async () => {
		await hub.open({ url: `${baseUrl}/`, sessionId });
		const reloaded = await call<HistoryResult>("browser_history", { action: "reload" });
		expect(reloaded.url).toContain("/");

		await call<ClickAndWaitResult>("browser_click_and_wait", { selector: "#go" });
		const forward = await call<HistoryResult>("browser_history", { action: "back" });
		expect(forward.url).toContain("/");
		expect(forward.url).not.toContain("/next");
	});

	it("waits for the navigation a click triggers", async () => {
		await hub.open({ url: `${baseUrl}/`, sessionId });
		const result = await call<ClickAndWaitResult>("browser_click_and_wait", { selector: "#go" });
		expect(result.navigated).toBe(true);
		expect(result.url).toContain("/next");
	});

	it("reports a click that does not navigate instead of failing", async () => {
		await hub.open({ url: `${baseUrl}/`, sessionId });
		const result = await call<ClickAndWaitResult>("browser_click_and_wait", { selector: "#title" });
		expect(result.navigated).toBe(false);
	});

	it("drags an element onto a drop target", async () => {
		await hub.open({ url: `${baseUrl}/`, sessionId });
		await run("browser_drag", { source: { selector: "#source" }, target: { selector: "#target" } });
		const dropped = found(
			await call<TextQueryResult>("browser_query", { kind: "text", selector: "#target" }),
			"browser_query",
		);
		expect(dropped.text).toContain("已放下");
	});
});
