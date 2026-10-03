import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright-core";
import pw from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BrowserInteraction, initializeBrowserInteraction } from "../src/modes/desktop/browser-interaction.ts";

const browserPath = [
	process.env.OWL_BROWSER_TEST_EXECUTABLE,
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

const fixture = `<!doctype html><html><body>
<input id="text" value="start"><textarea id="textarea">line 1</textarea>
<input id="password" type="password"><input id="disabled" disabled><input id="readonly" readonly>
<input id="short" maxlength="3"><input id="number" type="number"><input id="checkbox" type="checkbox">
<div id="editable" contenteditable="true">first</div><div id="plain">Plain text</div>
<button id="button">Click</button><button class="duplicate">One</button><button class="duplicate">Two</button>
<button id="covered" style="position:absolute;left:600px;top:20px">Covered</button>
<div style="position:absolute;left:590px;top:10px;width:180px;height:80px;z-index:9"></div>
<select id="single"><option value="a">Alpha</option><option value="b">Beta</option><option value="c" disabled>Disabled</option></select>
<select id="multiple" multiple><option value="a">Alpha</option><option value="b">Beta</option></select>
<select id="reset"><option value="a">Alpha</option><option value="b">Beta</option></select>
<div id="scroller" style="width:180px;height:120px;overflow:auto;margin-top:80px"><div style="height:900px">Scroll me<button id="deep" style="margin-top:780px">Deep button</button></div></div>
<script>
window.events=[];
for(const eventName of ['input','change','click','dblclick','contextmenu','auxclick','mouseover','focus','blur','wheel']) {
 document.addEventListener(eventName,e=>window.events.push({type:e.type,id:e.target.id,trusted:e.isTrusted,button:e.button}),true);
}
document.querySelector('#reset').addEventListener('change', e=>{e.target.value='a';});
window.__owlRefs={next:100,map:new Map()};
for(const [index,element] of Array.from(document.querySelectorAll('[id]')).entries()) {
 const ref=index+1;element.__owlRef=ref;window.__owlRefs.map.set(ref,element);
}
</script></body></html>`;

// Real browser, isolated context and local fixture only; no user profiles or external services.
describe.skipIf(!browserPath)("desktop browser reliable interactions", () => {
	let server: Server;
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;
	let interaction: BrowserInteraction;
	let fixtureUrl: string;

	beforeAll(async () => {
		await initializeBrowserInteraction();
		server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(fixture);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		fixtureUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		browser = await pw.chromium.launch({ executablePath: browserPath, headless: true });
	}, 15_000);

	beforeEach(async () => {
		context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
		page = await context.newPage();
		await page.goto(fixtureUrl);
		interaction = new BrowserInteraction(page, { timeoutMs: 700 });
	});

	afterEach(async () => {
		await context?.close();
	});

	afterAll(async () => {
		await browser?.close();
		await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
	});

	it("fills by snapshot ref and appends at the end with trusted input events", async () => {
		expect(await interaction.fill({ ref: 1 }, "new")).toEqual({ verified: true, characters: 3, redacted: false });
		await page.locator("#text").evaluate(`el => el.setSelectionRange(0, 0)`);
		expect(await interaction.fill({ ref: 1 }, " suffix", { append: true })).toEqual({
			verified: true,
			characters: 10,
			redacted: false,
		});
		expect(await page.locator("#text").inputValue()).toBe("new suffix");
		expect(
			await page.evaluate(`window.events.filter(e=>e.id==='text' && e.type==='input').every(e=>e.trusted)`),
		).toBe(true);
	});

	it("supports textarea and contenteditable replacement and append", async () => {
		await interaction.fill({ selector: "#textarea" }, "first\nsecond");
		await interaction.fill({ selector: "#textarea" }, " end", { append: true });
		expect(await page.locator("#textarea").inputValue()).toBe("first\nsecond end");
		await interaction.fill({ selector: "#editable" }, "updated");
		await interaction.fill({ selector: "#editable" }, " end", { append: true });
		expect(await page.locator("#editable").innerText()).toBe("updated end");
	});

	it("does not return password values or include them in failure details", async () => {
		const secret = "fixture-password";
		const result = await interaction.fill({ selector: "#password" }, secret);
		expect(result).toEqual({ verified: true, characters: secret.length, redacted: true });
		expect(JSON.stringify(result)).not.toContain(secret);
		await page.locator("#password").evaluate(`el => el.style.display='none'`);
		const error = await interaction.fill({ selector: "#password" }, secret).catch((reason: unknown) => reason);
		expect(String(error)).not.toContain(secret);
		expect(String(error)).toContain("输入失败");
	});

	it("rejects disabled, readonly and non-editable fields before mutating", async () => {
		await expect(interaction.fill({ selector: "#disabled" }, "bad")).rejects.toThrow("已禁用");
		await expect(interaction.fill({ selector: "#readonly" }, "bad")).rejects.toThrow("只读");
		await expect(interaction.fill({ selector: "#plain" }, "bad")).rejects.toThrow("不可编辑");
		await expect(interaction.fill({ selector: "#checkbox" }, "bad")).rejects.toThrow("不可编辑");
		expect(await page.locator("#disabled").inputValue()).toBe("");
	});

	it("detects rejected or shortened input through readback", async () => {
		await expect(interaction.fill({ selector: "#short" }, "long value")).rejects.toThrow("读回校验失败");
		await page.locator("#text").evaluate(`el => el.addEventListener('input',()=>{el.value='reset'})`);
		await expect(interaction.fill({ selector: "#text" }, "expected")).rejects.toThrow("读回校验失败");
	});

	it("rejects missing, stale, ambiguous and invalid targets", async () => {
		await expect(interaction.click({})).rejects.toThrow("只能提供");
		await expect(interaction.click({ ref: 1, selector: "#text" })).rejects.toThrow("只能提供");
		await expect(interaction.click({ ref: Number.NaN })).rejects.toThrow("正整数");
		await expect(interaction.click({ selector: ".duplicate" })).rejects.toThrow("2 个元素");
		await expect(interaction.click({ selector: "#missing" })).rejects.toThrow("未匹配");
		await expect(interaction.click({ selector: "[" })).rejects.toThrow("无法解析");
		await page.locator("#text").evaluate(`el => {el.outerHTML='<input id="text" value="replacement">'}`);
		await expect(interaction.fill({ ref: 1 }, "wrong")).rejects.toThrow("已失效");
		expect(await page.locator("#text").inputValue()).toBe("replacement");
	});

	it("checks click actionability and supports right, middle and double clicks", async () => {
		await expect(interaction.click({ selector: "#covered" })).rejects.toThrow("被遮挡");
		await interaction.click({ selector: "#button" }, { button: "right" });
		await interaction.click({ selector: "#button" }, { button: "middle" });
		await interaction.click({ selector: "#button" }, { clickCount: 2 });
		const events = await page.evaluate<Array<{ type: string; trusted: boolean; button: number }>>(
			`window.events.filter(e=>e.id==='button')`,
		);
		expect(events.some((event) => event.type === "contextmenu" && event.button === 2 && event.trusted)).toBe(true);
		expect(events.some((event) => event.type === "auxclick" && event.button === 1 && event.trusted)).toBe(true);
		expect(events.some((event) => event.type === "dblclick" && event.trusted)).toBe(true);
		await expect(interaction.click({ selector: "#button" }, { clickCount: 4 })).rejects.toThrow("clickCount");
	});

	it("selects by exact option value and verifies single and multiple selections", async () => {
		expect(await interaction.selectOptions({ selector: "#single" }, ["b"])).toEqual({
			verified: true,
			values: ["b"],
		});
		expect(await interaction.selectOptions({ selector: "#multiple" }, ["b", "a", "b"])).toEqual({
			verified: true,
			values: ["a", "b"],
		});
		await expect(interaction.selectOptions({ selector: "#single" }, ["a", "b"])).rejects.toThrow("只允许单选");
		await expect(interaction.selectOptions({ selector: "#single" }, ["Alpha"])).rejects.toThrow("不存在");
		await expect(interaction.selectOptions({ selector: "#single" }, ["c"])).rejects.toThrow("选项已禁用");
		await expect(interaction.selectOptions({ selector: "#plain" }, ["b"])).rejects.toThrow("不是原生 select");
		await expect(interaction.selectOptions({ selector: "#reset" }, ["b"])).rejects.toThrow("读回校验失败");
	});

	it("hover, focus and blur produce observable browser events", async () => {
		await interaction.hover({ selector: "#button" });
		await interaction.focus({ selector: "#text" });
		expect(await page.evaluate(`document.activeElement.id`)).toBe("text");
		await interaction.blur({ selector: "#text" });
		expect(await page.evaluate(`document.activeElement.id`)).not.toBe("text");
		expect(await page.evaluate(`window.events.some(e=>e.id==='button' && e.type==='mouseover' && e.trusted)`)).toBe(
			true,
		);
		expect(await page.evaluate(`window.events.some(e=>e.id==='text' && e.type==='blur' && e.trusted)`)).toBe(true);
		await expect(interaction.focus({ selector: "#disabled" })).rejects.toThrow("已禁用");
		await expect(interaction.focus({ selector: "#plain" })).rejects.toThrow("未获得焦点");
	});

	it("scrolls the target container and brings a deep element into view", async () => {
		await interaction.scroll({ selector: "#scroller" }, { deltaY: 300 });
		await expect.poll(() => page.locator("#scroller").evaluate<number>(`el => el.scrollTop`)).toBeGreaterThan(0);
		expect(await page.evaluate(`window.scrollY`)).toBe(0);
		await interaction.scrollIntoView({ selector: "#deep" });
		expect(await page.locator("#scroller").evaluate<number>(`el => el.scrollTop`)).toBeGreaterThan(600);
		expect(await page.evaluate(`window.events.some(e=>e.type==='wheel' && e.trusted)`)).toBe(true);
		await expect(interaction.scroll({ selector: "#scroller" }, { deltaY: Number.NaN })).rejects.toThrow("有限数字");
	});
});
