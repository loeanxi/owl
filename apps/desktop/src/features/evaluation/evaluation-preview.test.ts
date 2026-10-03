import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser } from "linkedom";
import { chromium } from "playwright-core";
import { findEvaluationBrowserPath } from "../../../../../packages/coding-agent/src/core/evaluation/check-browser.ts";
import { isolatedPreview } from "./evaluation-model.ts";

const ORIGINAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260" style="width:400px!important;height:260px!important"><rect id="canvas" width="400" height="260" fill="white"/><circle id="wheel" cx="100" cy="230" r="25" fill="black"/></svg>';

function preview(content = ORIGINAL_SVG): string {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
	Object.defineProperty(globalThis, "DOMParser", { value: DOMParser, configurable: true });
	try { return isolatedPreview(content, "svg"); }
	finally {
		if (descriptor) Object.defineProperty(globalThis, "DOMParser", descriptor);
		else Reflect.deleteProperty(globalThis, "DOMParser");
	}
}

test("SVG viewport wrapper preserves original viewBox and source while enforcing contain sizing without scripts", () => {
	const output = preview();
	const document = new DOMParser().parseFromString(output, "text/html");
	const svg = document.querySelector("svg");
	assert.equal(svg?.getAttribute("viewBox"), "0 0 400 260");
	assert.equal(svg?.getAttribute("preserveAspectRatio"), "xMidYMid meet");
	assert.match(svg?.getAttribute("style") ?? "", /width:100%/);
	assert.match(svg?.getAttribute("style") ?? "", /height:100%/);
	assert.match(output, /min-height:0/);
	assert.match(output, /object-fit:contain/);
	assert.match(output, /script-src 'none'/);
	assert.equal(document.querySelector("script"), null);
	assert.match(ORIGINAL_SVG, /width="400" height="260"/);
	assert.match(ORIGINAL_SVG, /height:260px!important/);
	const withoutViewBox = ORIGINAL_SVG.replace(' viewBox="0 0 400 260"', "");
	assert.equal(new DOMParser().parseFromString(preview(withoutViewBox), "text/html").querySelector("svg")?.getAttribute("viewBox"), "0 0 400 260");
	assert.doesNotMatch(withoutViewBox, /viewBox=/);
});

const browserPath = findEvaluationBrowserPath();

test("400×260 SVG fully fits both a 200px thumbnail and an expanded viewport in a real sandbox iframe", { skip: browserPath ? false : "Installed Chrome/Edge unavailable; SVG geometry was not checked." }, async () => {
	const browser = await chromium.launch({ executablePath: browserPath, headless: true });
	try {
		const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
		await context.route("**/*", (route) => route.abort());
		const page = await context.newPage();
		for (const original of [ORIGINAL_SVG, ORIGINAL_SVG.replace(' viewBox="0 0 400 260"', "")]) {
		const content = preview(original).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
		for (const size of [{ width: 320, height: 200 }, { width: 900, height: 650 }]) {
			await page.setViewportSize(size);
			await page.setContent(`<style>html,body{margin:0;width:100%;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style><iframe id="preview" sandbox="" srcdoc="${content}"></iframe>`);
			const handle = await page.$("#preview");
			const frame = await handle?.contentFrame();
			assert.ok(frame);
			const geometry = await frame.evaluate<{ width: number; height: number; svg: { x: number; y: number; right: number; bottom: number }; wheel: { right: number; bottom: number }; viewBox: string }>("(() => {const svg=document.querySelector('svg'),rect=svg.getBoundingClientRect(),wheel=document.getElementById('wheel').getBoundingClientRect();return {width:innerWidth,height:innerHeight,svg:{x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom},wheel:{right:wheel.right,bottom:wheel.bottom},viewBox:svg.getAttribute('viewBox')}})()");
			assert.equal(geometry.viewBox, "0 0 400 260");
			assert.ok(geometry.svg.x >= -1 && geometry.svg.y >= -1);
			assert.ok(geometry.svg.right <= geometry.width + 1, `SVG extends past ${size.width}px preview width`);
			assert.ok(geometry.svg.bottom <= geometry.height + 1, `SVG extends past ${size.height}px preview height`);
			assert.ok(geometry.wheel.right <= geometry.width + 1 && geometry.wheel.bottom <= geometry.height + 1, "The bottom wheel is cropped");
		}
		}
	} finally { await browser.close(); }
});
