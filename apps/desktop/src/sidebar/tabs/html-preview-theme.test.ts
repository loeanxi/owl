import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import type { WorkbenchPalette } from "../theme-observer.ts";
import { readWorkbenchPalette } from "../theme-observer.ts";
import { HTML_PREVIEW_THEME_MESSAGE, htmlPreviewThemeScript } from "./html-preview-theme.ts";

function previewFixture() {
	const style = new Map<string, string>();
	const parent = {};
	let message: ((event: { source: unknown; data: unknown }) => void) | undefined;
	const palette = readWorkbenchPalette({ getPropertyValue: () => "" }, "dark");
	runInNewContext(htmlPreviewThemeScript(palette), {
		document: { documentElement: { style: { setProperty: (name: string, value: string) => style.set(name, value) } } },
		window: { addEventListener: (type: string, listener: typeof message) => { assert.equal(type, "message"); message = listener; } },
		parent,
		CSS: { supports: (_property: string, value: string) => !value.includes("invalid") },
	});
	return { style, parent, emit: (source: unknown, data: unknown) => message?.({ source, data }) };
}

test("sandbox HTML defaults update in place from the parent when theme and custom colors change", () => {
	const fixture = previewFixture();
	assert.equal(fixture.style.get("--owl-preview-scheme"), "dark");
	assert.equal(fixture.style.get("--owl-preview-text"), "#e9e7e0");
	const palette = readWorkbenchPalette({ getPropertyValue: (name) => name === "--color-owl-accent" ? "#c02080" : "" }, "light");
	fixture.emit(fixture.parent, { type: HTML_PREVIEW_THEME_MESSAGE, palette });
	assert.equal(fixture.style.get("--owl-preview-scheme"), "light");
	assert.equal(fixture.style.get("--owl-preview-canvas"), "#fafbf9");
	assert.equal(fixture.style.get("--owl-preview-text"), "#3d3a32");
	assert.equal(fixture.style.get("--owl-preview-accent"), "#c02080");
});

test("foreign windows and malformed palettes cannot change sandbox preview colors", () => {
	const fixture = previewFixture();
	const initial = [...fixture.style.entries()];
	fixture.emit({}, { type: HTML_PREVIEW_THEME_MESSAGE, palette: { theme: "light", text: "#000000" } });
	for (const data of [null, "theme", {}, { type: HTML_PREVIEW_THEME_MESSAGE }, { type: HTML_PREVIEW_THEME_MESSAGE, palette: { theme: "system" } }]) fixture.emit(fixture.parent, data);
	assert.deepEqual([...fixture.style.entries()], initial);
	fixture.emit(fixture.parent, { type: HTML_PREVIEW_THEME_MESSAGE, palette: { theme: "dark", text: "invalid", accent: 42 } });
	assert.equal(fixture.style.get("--owl-preview-text"), "#e9e7e0");
	assert.equal(fixture.style.get("--owl-preview-accent"), "#2f9e5a");
});

test("embedded theme data cannot terminate the injected script element", () => {
	const palette = readWorkbenchPalette({ getPropertyValue: (name) => name === "--color-owl-accent" ? "</script><script>bad()</script>" : "" }, "dark");
	assert.equal(htmlPreviewThemeScript(palette).includes("</script>"), false);
});

const browserExecutable = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((path) => existsSync(path));

test("real CSS cascade preserves authored html/body inheritance while default documents follow theme without reloads", { skip: !browserExecutable }, async (t) => {
	const bundle = await build({
		entryPoints: [fileURLToPath(new URL("./html-preview-theme.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		globalName: "owlHtmlPreview",
	});
	const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
	t.after(() => browser.close());
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addScriptTag({ content: bundle.outputFiles[0].text });
	const fixtures = [
		{ name: "plain", css: "", text: null, bodyBackground: "rgba(0, 0, 0, 0)", htmlBackground: null },
		{ name: "html-color-only", css: "html { color: #222233; }", text: "rgb(34, 34, 51)", bodyBackground: "rgba(0, 0, 0, 0)", htmlBackground: null },
		{ name: "html-color-body-white", css: "html { color: #222233; } body { background: white; }", text: "rgb(34, 34, 51)", bodyBackground: "rgb(255, 255, 255)", htmlBackground: null },
		{ name: "html-color-background", css: "html { color: #222233; background: white; }", text: "rgb(34, 34, 51)", bodyBackground: "rgba(0, 0, 0, 0)", htmlBackground: "rgb(255, 255, 255)" },
		{ name: "body-color-background", css: "body { color: #223344; background: #ffeecc; }", text: "rgb(34, 51, 68)", bodyBackground: "rgb(255, 238, 204)", htmlBackground: null },
	];
	const dark = readWorkbenchPalette({ getPropertyValue: () => "" }, "dark");
	await page.evaluate(({ fixtures, palette }) => {
		const preview = window as Window & { owlHtmlPreview: { themedHtmlPreview: (content: string, palette: WorkbenchPalette) => string } };
		for (const fixture of fixtures) {
			const frame = document.createElement("iframe");
			frame.dataset.fixture = fixture.name;
			frame.sandbox.add("allow-scripts");
			frame.srcdoc = preview.owlHtmlPreview.themedHtmlPreview(`<!doctype html><style>${fixture.css}</style><p>Readable document</p><input value="Inherited control"><script>document.body.dataset.previewBoot = String(Math.random())</script>`, palette);
			document.body.append(frame);
		}
	}, { fixtures, palette: dark });
	const evidence: Array<Record<string, unknown>> = [];
	const nonces = new Map<string, string | undefined>();
	for (const mode of ["dark", "light"] as const) {
		const palette = readWorkbenchPalette({ getPropertyValue: () => "" }, mode);
		await page.evaluate(({ palette, type }) => {
			for (const frame of document.querySelectorAll("iframe")) frame.contentWindow?.postMessage({ type, palette }, "*");
		}, { palette, type: HTML_PREVIEW_THEME_MESSAGE });
		for (const fixture of fixtures) {
			const element = await page.locator(`iframe[data-fixture="${fixture.name}"]`).elementHandle();
			const frame = await element?.contentFrame();
			assert.ok(frame);
			await frame.waitForFunction((expected) => !!document.body.dataset.previewBoot && getComputedStyle(document.documentElement).colorScheme === expected, mode);
			const actual = await frame.evaluate(() => ({
				nonce: document.body.dataset.previewBoot,
				text: getComputedStyle(document.querySelector("p")!).color,
				controlText: getComputedStyle(document.querySelector("input")!).color,
				controlBackground: getComputedStyle(document.querySelector("input")!).backgroundColor,
				bodyBackground: getComputedStyle(document.body).backgroundColor,
				htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
			}));
			const text = fixture.text ?? (mode === "dark" ? "rgb(233, 231, 224)" : "rgb(61, 58, 50)");
			assert.equal(actual.text, text, `${fixture.name} paragraph inherits authored colors in ${mode}`);
			assert.equal(actual.controlText, text, `${fixture.name} control inherits the document foreground in ${mode}`);
			assert.equal(actual.bodyBackground, fixture.bodyBackground, `${fixture.name} body retains authored/transparent background in ${mode}`);
			assert.equal(actual.controlBackground, fixture.bodyBackground, `${fixture.name} control retains the document surface in ${mode}`);
			assert.equal(actual.htmlBackground, fixture.htmlBackground ?? (mode === "dark" ? "rgb(32, 35, 33)" : "rgb(250, 251, 249)"));
			if (mode === "dark") nonces.set(fixture.name, actual.nonce);
			else assert.equal(actual.nonce, nonces.get(fixture.name), `${fixture.name} does not rerun scripts on theme changes`);
			evidence.push({ fixture: fixture.name, mode, ...actual });
		}
	}
	assert.deepEqual(errors, []);
	if (process.env.OWL_HTML_PREVIEW_EVIDENCE) {
		await writeFile(process.env.OWL_HTML_PREVIEW_EVIDENCE, JSON.stringify({ passed: true, evidence, errors }, null, 2));
	}
});
