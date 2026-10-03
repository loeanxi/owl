/**
 * Opt in with OWL_BROWSER_INTEGRATION_TESTS=1. Uses a new system Edge/Chrome
 * process and a loopback HTTP fixture; no desktop bridge or model provider.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeIabPath, parseIabPath } from "../../../apps/desktop/src/sidebar/iab-bound.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { BrowserHub } from "../src/modes/desktop/browser-hub.ts";
import type { BrowserNetworkJournal } from "../src/modes/desktop/browser-network.ts";
import type { IabPageInfo } from "../src/modes/desktop/protocol.ts";

interface Receipt {
	kind: string;
	name: string;
	choice: string;
	passwordLength: number;
	cookie: string;
	hovered: string;
	scrollTop: number;
	documentScrollTop: number;
	width: number;
	focusedId: string;
}

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type NetworkList = ReturnType<BrowserNetworkJournal["list"]>;
type NetworkDetail = Awaited<ReturnType<BrowserNetworkJournal["detail"]>>;
const DUMMY_PASSWORD = "fixture-password-only";

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Browser tools fixture</title>
<style>body{font:16px sans-serif;margin:16px}label{display:block;margin:8px 0}input,select,button{font:inherit}
#scroll-box{height:120px;width:260px;overflow:auto;border:1px solid black}#scroll-content{height:1200px}
#hover-menu{display:none}#hover-target:hover #hover-menu{display:block}@media(max-width:500px){body{background:#eef}}
</style></head><body><h1>Integration fixture</h1>
<label>Name <input id="name" aria-label="Name"></label>
<label>Choice <select id="choice" aria-label="Choice"><option value="one">One</option><option value="two">Two</option><option value="disabled" disabled>Disabled</option></select></label>
<label>Password <input id="password" aria-label="Password" type="password"></label>
<label>Read only <input id="readonly" value="unchanged" readonly></label>
<label>Disabled <input id="disabled" value="unchanged" disabled></label>
<label>Controlled <input id="controlled" oninput="this.value='fixed'"></label>
<label>Cookie <input id="cookie-value" aria-label="Cookie value"></label>
<button id="set-cookie" onclick="document.cookie='owner='+document.getElementById('cookie-value').value+'; Path=/'">Set cookie</button>
<div id="hover-target" role="button" aria-label="Hover target" onmouseenter="document.getElementById('hover-state').textContent='hovered'">Hover target <button id="hover-menu">Hover menu</button></div>
<p id="hover-state">idle</p><div id="scroll-box" role="region" aria-label="Scrollable region"><div id="scroll-content">Scrollable content</div></div>
<button id="report" onclick="report('manual')">Report state</button>
<button id="network" onclick="runNetwork()">Run network fixture</button>
<p id="network-status">idle</p>
<script>
const field = (id) => document.getElementById(id);
async function report(kind) {
  await fetch('/receipt', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    kind,name:field('name').value,choice:field('choice').value,passwordLength:field('password').value.length,
    cookie:document.cookie,hovered:field('hover-state').textContent,scrollTop:field('scroll-box').scrollTop,
    documentScrollTop:document.documentElement.scrollTop,width:document.documentElement.clientWidth,
    focusedId:document.activeElement.id || ''})});
}
document.addEventListener('focusin', (event) => report('focus:'+event.target.id));
document.addEventListener('focusout', (event) => queueMicrotask(() => report('blur:'+event.target.id)));
async function runNetwork() {
  await Promise.allSettled([
    fetch('/echo?token=fixture-url-secret&visible=yes',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture-auth-secret','X-Api-Key':'fixture-api-secret'},body:JSON.stringify({displayName:'visible-request',password:'fixture-request-secret',nested:{token:'fixture-nested-secret'}})}),
    fetch('/status-503'),fetch('/disconnect')]);
  field('network-status').textContent='completed'; await report('network-completed');
}
</script></body></html>`;

describe.skipIf(process.env.OWL_BROWSER_INTEGRATION_TESTS !== "1")(
	"desktop browser tools with a real isolated browser",
	() => {
		let server: Server;
		let baseUrl: string;
		let hub: BrowserHub;
		const receipts: Receipt[] = [];
		let barrierResponses: ServerResponse[] = [];
		let barrierPaired = false;
		let slowNavigations = 0;
		const responseTimers = new Set<ReturnType<typeof setTimeout>>();
		const frames: Array<{ pageId: string; width: number; height: number }> = [];

		beforeAll(async () => {
			server = createServer((request, response) => {
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				if (url.pathname === "/receipt") {
					const chunks: Buffer[] = [];
					request.on("data", (chunk: Buffer) => chunks.push(chunk));
					request.on("end", () => {
						receipts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Receipt);
						response.writeHead(204).end();
					});
					return;
				}
				if (url.pathname === "/echo") {
					request.resume();
					response
						.writeHead(201, {
							"content-type": "application/json",
							"set-cookie": "fixture_session=fixture-cookie-secret; Path=/; HttpOnly",
							"x-auth-token": "fixture-header-secret",
						})
						.end(JSON.stringify({ displayName: "visible-response", token: "fixture-response-secret" }));
					return;
				}
				if (url.pathname === "/status-503") {
					response.writeHead(503, { "content-type": "application/json" }).end('{"reason":"fixture unavailable"}');
					return;
				}
				if (url.pathname === "/disconnect") {
					response.destroy();
					return;
				}
				if (url.pathname === "/barrier-form") {
					barrierResponses.push(response);
					if (barrierResponses.length === 2) {
						barrierPaired = true;
						for (const waiting of barrierResponses)
							waiting.writeHead(200, { "content-type": "text/html" }).end(HTML);
					} else {
						const timer = setTimeout(() => {
							responseTimers.delete(timer);
							if (!response.writableEnded) response.writeHead(200, { "content-type": "text/html" }).end(HTML);
						}, 3000);
						responseTimers.add(timer);
					}
					return;
				}
				if (url.pathname === "/slow-form") {
					slowNavigations++;
					const timer = setTimeout(() => {
						responseTimers.delete(timer);
						response.writeHead(200, { "content-type": "text/html" }).end(HTML);
					}, 300);
					responseTimers.add(timer);
					return;
				}
				response.writeHead(200, { "content-type": "text/html" }).end(HTML);
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected a loopback TCP server");
			baseUrl = `http://127.0.0.1:${address.port}`;
		});

		beforeEach(() => {
			receipts.length = 0;
			frames.length = 0;
			barrierResponses = [];
			barrierPaired = false;
			slowNavigations = 0;
			hub = new BrowserHub({
				onFrame: (pageId, _data, width, height) => frames.push({ pageId, width, height }),
				onPagesChanged: () => {},
				onFileChooser: () => {},
				onDiagnostic: () => {},
			});
		});

		afterEach(async () => {
			await hub.dispose();
			for (const timer of responseTimers) clearTimeout(timer);
			responseTimers.clear();
		});

		afterAll(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		});

		async function invoke(sessionId: string, name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
			const tool = hub.tools(sessionId).find((candidate) => candidate.name === name);
			if (!tool) throw new Error(`Missing browser tool: ${name}`);
			// These tools use their bound BrowserHub and do not read the agent extension context.
			return tool.execute(randomUUID(), input, undefined, undefined, undefined as never);
		}

		function text(result: ToolResult): string {
			return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
		}

		async function report(sessionId: string, pageId?: string): Promise<Receipt> {
			const before = receipts.length;
			await invoke(sessionId, "browser_click", { selector: "#report", ...(pageId ? { pageId } : {}) });
			await expect
				.poll(() => receipts.slice(before).find((receipt) => receipt.kind === "manual"), { timeout: 3000 })
				.toBeDefined();
			return receipts.slice(before).find((receipt) => receipt.kind === "manual")!;
		}

		async function open(sessionId: string, path = "/form"): Promise<IabPageInfo> {
			await invoke(sessionId, "browser_navigate", { url: baseUrl + path });
			const page = hub.listPages(sessionId).find((candidate) => candidate.active);
			if (!page) throw new Error("Navigation did not produce an owned active page");
			return page;
		}

		it("isolates same-URL pages and cookies, refuses foreign IDs, and disposes only the owner", async () => {
			const a = await open("chat-a");
			const b = await open("chat-b");
			expect(a.url).toBe(b.url);
			expect(a.pageId).not.toBe(b.pageId);
			await invoke("chat-a", "browser_fill", { selector: "#cookie-value", text: "chat-a" });
			await invoke("chat-a", "browser_click", { selector: "#set-cookie" });
			expect((await report("chat-a")).cookie).toContain("owner=chat-a");
			expect((await report("chat-b")).cookie).not.toContain("owner=chat-a");
			await expect(
				invoke("chat-b", "browser_fill", { pageId: a.pageId, selector: "#name", text: "foreign" }),
			).rejects.toThrow(/其他聊天|owner|belong/i);
			await expect(invoke("chat-b", "browser_tabs", { action: "select", pageId: a.pageId })).rejects.toThrow(
				/其他聊天|owner|belong/i,
			);
			await hub.disposeSession("chat-a");
			expect(hub.listPages("chat-a")).toEqual([]);
			expect(hub.listPages("chat-b").map((page) => page.pageId)).toEqual([b.pageId]);
			expect((await report("chat-b")).name).toBe("");
		}, 30_000);

		it("claims an explicit unowned page once and persists its original chat", async () => {
			const manual = await hub.open({ url: `${baseUrl}/form` });
			expect(hub.listPages("chat-a")).toEqual([]);
			await invoke("chat-a", "browser_tabs", { action: "select", pageId: manual.pageId });
			const claimed = hub.listPages("chat-a")[0];
			expect(claimed.pageId).toBe(manual.pageId);
			expect(parseIabPath(encodeIabPath(claimed.pageId, claimed.url, claimed.sessionId)).sessionId).toBe("chat-a");
			await expect(invoke("chat-b", "browser_snapshot", { pageId: manual.pageId })).rejects.toThrow(
				/其他聊天|owner|belong/i,
			);
			expect(hub.listPages("chat-b")).toEqual([]);
		}, 30_000);

		it("does not share cookies between UI pages claimed by different chats", async () => {
			const first = await hub.open({ url: `${baseUrl}/form?manual=first` });
			const second = await hub.open({ url: `${baseUrl}/form?manual=second` });
			await invoke("chat-a", "browser_tabs", { action: "select", pageId: first.pageId });
			await invoke("chat-b", "browser_tabs", { action: "select", pageId: second.pageId });
			await invoke("chat-a", "browser_fill", { selector: "#cookie-value", text: "claimed-chat-a" });
			await invoke("chat-a", "browser_click", { selector: "#set-cookie" });
			expect((await report("chat-a")).cookie).toContain("owner=claimed-chat-a");
			expect((await report("chat-b")).cookie).not.toContain("owner=claimed-chat-a");
		}, 30_000);

		it("queues navigation and fill in the same chat without losing input", async () => {
			const page = await open("chat-a");
			await Promise.all([
				invoke("chat-a", "browser_navigate", { pageId: page.pageId, url: `${baseUrl}/slow-form` }),
				invoke("chat-a", "browser_fill", { pageId: page.pageId, selector: "#name", text: "ordered" }),
			]);
			expect((await report("chat-a", page.pageId)).name).toBe("ordered");
		}, 30_000);

		it("finishes a pending UI navigation before claiming and filling its page", async () => {
			const manual = await hub.open({ url: `${baseUrl}/form` });
			const navigation = hub.open({ pageId: manual.pageId, url: `${baseUrl}/slow-form` });
			await expect.poll(() => slowNavigations).toBe(1);
			await Promise.all([
				navigation,
				invoke("chat-a", "browser_fill", {
					pageId: manual.pageId,
					selector: "#name",
					text: "claimed-after-navigation",
				}),
			]);
			expect((await report("chat-a", manual.pageId)).name).toBe("claimed-after-navigation");
		}, 30_000);

		it("lets different chats navigate concurrently", async () => {
			await open("chat-a");
			await open("chat-b");
			await Promise.all([
				invoke("chat-a", "browser_navigate", { url: `${baseUrl}/barrier-form?owner=a` }),
				invoke("chat-b", "browser_navigate", { url: `${baseUrl}/barrier-form?owner=b` }),
			]);
			expect(barrierPaired).toBe(true);
		}, 30_000);

		it("verifies fill, selection, focus, hover and directed scrolling with useful failures", async () => {
			await open("chat-a");
			await invoke("chat-a", "browser_fill", { selector: "#name", text: "李现 first" });
			await invoke("chat-a", "browser_fill", { selector: "#name", text: " second", append: true });
			await invoke("chat-a", "browser_select", { selector: "#choice", values: ["two"] });
			const passwordResult = await invoke("chat-a", "browser_fill", { selector: "#password", text: DUMMY_PASSWORD });
			expect(JSON.stringify(passwordResult)).not.toContain(DUMMY_PASSWORD);
			await invoke("chat-a", "browser_focus", { selector: "#name", action: "focus" });
			await expect
				.poll(() => receipts.some((receipt) => receipt.kind === "focus:name" && receipt.focusedId === "name"))
				.toBe(true);
			await invoke("chat-a", "browser_focus", { selector: "#name", action: "blur" });
			await invoke("chat-a", "browser_hover", { selector: "#hover-target" });
			await invoke("chat-a", "browser_scroll", { selector: "#scroll-box", deltaY: 350 });
			await expect(invoke("chat-a", "browser_fill", { selector: "#readonly", text: "wrong" })).rejects.toThrow(
				/只读|read.?only/i,
			);
			await expect(invoke("chat-a", "browser_fill", { selector: "#disabled", text: "wrong" })).rejects.toThrow(
				/禁用|disabled/i,
			);
			await expect(invoke("chat-a", "browser_fill", { selector: "#controlled", text: "rejected" })).rejects.toThrow(
				/校验|验证|verify/i,
			);
			await expect(
				invoke("chat-a", "browser_select", { selector: "#choice", values: ["disabled"] }),
			).rejects.toThrow(/禁用|disabled/i);
			const receipt = await report("chat-a");
			expect(receipt.name).toBe("李现 first second");
			expect(receipt.choice).toBe("two");
			expect(receipt.passwordLength).toBe(DUMMY_PASSWORD.length);
			expect(receipt.hovered).toBe("hovered");
			expect(receipt.scrollTop).toBeGreaterThan(0);
			expect(receipt.documentScrollTop).toBe(0);
		}, 30_000);

		it("keeps refs monotonic across reload and refuses the stale ref", async () => {
			const page = await open("chat-a");
			const first = text(await invoke("chat-a", "browser_snapshot"));
			const match = first.match(/\[ref=(\d+)\][^\n]*"Name"/);
			if (!match) throw new Error("Fixture Name input was missing from the snapshot");
			const staleRef = Number(match[1]);
			const oldRefs = [...first.matchAll(/\[ref=(\d+)\]/g)].map((item) => Number(item[1]));
			await hub.nav(page.pageId, "reload");
			const second = text(await invoke("chat-a", "browser_snapshot"));
			const newRefs = [...second.matchAll(/\[ref=(\d+)\]/g)].map((item) => Number(item[1]));
			expect(Math.min(...newRefs)).toBeGreaterThan(Math.max(...oldRefs));
			await expect(invoke("chat-a", "browser_fill", { ref: staleRef, text: "stale should fail" })).rejects.toThrow(
				/ref.*失效|stale/i,
			);
			expect((await report("chat-a")).name).toBe("");
		}, 30_000);

		it("records HTTP failures and transport failures with redacted request details", async () => {
			await open("chat-a");
			await invoke("chat-a", "browser_click", { selector: "#network" });
			await expect
				.poll(() => receipts.some((receipt) => receipt.kind === "network-completed"), { timeout: 10_000 })
				.toBe(true);
			const result = await invoke("chat-a", "browser_network", { action: "list", limit: 100 });
			const list = result.details as NetworkList;
			const echo = list.requests.find((request) => new URL(request.url).pathname === "/echo");
			const httpFailure = list.requests.find((request) => new URL(request.url).pathname === "/status-503");
			const transportFailure = list.requests.find((request) => new URL(request.url).pathname === "/disconnect");
			expect(echo?.status).toBe(201);
			expect(echo?.state).toBe("finished");
			expect(httpFailure?.status).toBe(503);
			expect(httpFailure?.state).toBe("finished");
			expect(transportFailure?.state).toBe("failed");
			expect(transportFailure?.failure).toBeTruthy();
			if (!echo) throw new Error("Expected echo request in the browser network journal");
			const detailResult = await invoke("chat-a", "browser_network", {
				action: "detail",
				requestId: echo.requestId,
				includeRequestBody: true,
				includeResponseBody: true,
			});
			const detail = detailResult.details as NetworkDetail;
			expect(detail.requestBody.state).toBe("available");
			expect(detail.responseBody.state).toBe("available");
			const output = JSON.stringify(detailResult);
			for (const secret of [
				"fixture-url-secret",
				"fixture-auth-secret",
				"fixture-api-secret",
				"fixture-request-secret",
				"fixture-nested-secret",
				"fixture-response-secret",
				"fixture-header-secret",
				"fixture-cookie-secret",
			]) {
				expect(output).not.toContain(secret);
			}
			expect(output).toContain("visible-request");
			expect(output).toContain("visible-response");
			expect(output).toContain("REDACTED");
		}, 30_000);

		it("preserves responsive viewport metadata, rendered layout and frame dimensions", async () => {
			const page = await open("chat-a");
			await hub.setViewport(page.pageId, 390, 844);
			expect(hub.listPages("chat-a")[0].viewport).toEqual({ width: 390, height: 844 });
			expect((await report("chat-a")).width).toBe(390);
			await hub.captureFrame(page.pageId);
			expect(
				frames.some((frame) => frame.pageId === page.pageId && frame.width === 390 && frame.height === 844),
			).toBe(true);
			await hub.setViewport(page.pageId, 844, 390);
			expect((await report("chat-a")).width).toBe(844);
			expect(hub.listPages("chat-a")[0].viewport).toEqual({ width: 844, height: 390 });
			const screenshot = await invoke("chat-a", "browser_screenshot");
			expect(
				screenshot.content.some(
					(item) => item.type === "image" && item.mimeType === "image/png" && item.data.length > 100,
				),
			).toBe(true);
		}, 30_000);
	},
);
