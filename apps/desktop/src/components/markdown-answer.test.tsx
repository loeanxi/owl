import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiLanguage } from "../i18n/index.ts";
import { renderAnswerMarkdown } from "./answer-markdown-renderer.ts";
import { MarkdownAnswer } from "./MarkdownAnswer.tsx";
import { replyReadingText } from "./reply-reading-copy.ts";

let root: Root;
let host: HTMLElement;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let tableWidth: number;
let codeWidth: number;
let resized: (() => void)[];

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	resized = [];
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: () => void) { resized.push(callback); }
		observe(): void {}
		disconnect(): void {}
	});
	writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	tableWidth = 240;
	codeWidth = 240;
	Object.defineProperties(dom.window.HTMLElement.prototype, {
		scrollLeft: { configurable: true, writable: true, value: 0 },
		scrollHeight: { configurable: true, get() {
			if (this.tagName === "PRE") return (this.textContent?.split("\n").length ?? 0) * 22 + 28;
			return this.hasAttribute("data-answer-table-scroll") ? this.querySelectorAll("tr").length * 31 + 28 : 0;
		} },
		clientWidth: { configurable: true, get() { return 240; } },
		clientHeight: { configurable: true, get() { return this.tagName === "PRE" ? this.closest("[data-answer-code]")?.dataset.answerExpanded === "true" ? this.scrollHeight : Math.min(360, this.scrollHeight) : 440; } },
		scrollWidth: { configurable: true, get() { return this.tagName === "PRE" ? codeWidth : this.hasAttribute("data-answer-table-scroll") ? tableWidth : 240; } },
	});
	host = document.getElementById("root")!;
	root = createRoot(host);
	setUiLanguage("zh");
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

describe("answer outline", () => {
	it("lists sections once the answer has three or more headings and jumps with a flash", async () => {
		const markdown = ["## 一", "正文", "", "## 二", "正文", "", "## 三", "正文", "", "## 四", "正文"].join("\n");
		await render(markdown);
		const toc = host.querySelector<HTMLElement>(".owl-answer-toc")!;
		expect(toc).not.toBeNull();
		expect(toc.querySelector("summary")?.textContent).toContain(replyReadingText("tocTitle"));
		expect(toc.querySelector("summary")?.textContent).toContain("4");
		const items = [...toc.querySelectorAll<HTMLAnchorElement>("li a")];
		expect(items.map((item) => item.textContent)).toEqual(["一", "二", "三", "四"]);
		expect(items.map((item) => item.getAttribute("href"))).toEqual(["#answer-heading-0", "#answer-heading-1", "#answer-heading-2", "#answer-heading-3"]);
		// 点击滚动到目标并给闪烁反馈（linkedom 无 scrollIntoView，桩在原型上记录）。
		const scrolled: HTMLElement[] = [];
		HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this); };
		try {
			await act(async () => items[2]!.click());
			expect(scrolled).toHaveLength(1);
			expect(scrolled[0]!.id).toBe("answer-heading-2");
			expect(scrolled[0]!.classList.contains("owl-answer-toc-flash")).toBe(true);
		} finally {
			delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
		}
	});

	it("stays quiet for short answers without three headings", async () => {
		await render("## 唯一一节\n正文");
		expect(host.querySelector(".owl-answer-toc")).toBeNull();
		expect(host.querySelector("h2")?.getAttribute("id")).toBe("answer-heading-0");
	});
});

async function render(markdown: string, onBodyClick = vi.fn()): Promise<void> {
	await act(async () => root.render(<div onClick={onBodyClick}><MarkdownAnswer html={renderAnswerMarkdown(markdown)} /></div>));
}

function codeBlock(index = 0): HTMLElement {
	return host.querySelectorAll<HTMLElement>("[data-answer-code]")[index];
}

function action(block: HTMLElement, name: string): HTMLButtonElement {
	return block.querySelector<HTMLButtonElement>(`[data-answer-action="${name}"]`)!;
}

async function click(button: HTMLButtonElement): Promise<void> {
	await act(async () => button.click());
}

describe("Markdown answer reading controls", () => {
	it("copies only the selected block with its exact indentation and line endings, after clipboard acknowledgement", async () => {
		const pending = Promise.withResolvers<void>();
		writeText.mockReturnValueOnce(pending.promise);
		await render("```ts\n  const first = '<b>';\n\treturn first;\n```\n\n```sh\nprintf 'second'\n\n```\n");
		await click(action(codeBlock(), "copy-code"));
		expect(writeText).toHaveBeenNthCalledWith(1, "  const first = '<b>';\n\treturn first;\n");
		expect(codeBlock().querySelector("[data-answer-copy-status]")?.textContent).toBe("");
		await act(async () => pending.resolve());
		expect(codeBlock().querySelector("[data-answer-copy-status]")?.textContent).toBe(replyReadingText("copied"));
		await click(action(codeBlock(1), "copy-code"));
		expect(writeText).toHaveBeenNthCalledWith(2, "printf 'second'\n\n");
		expect(writeText).toHaveBeenCalledTimes(2);
	});

	it("shows clipboard rejection and permits retry without a false success", async () => {
		writeText.mockRejectedValueOnce(new Error("clipboard denied"));
		await render("```\nretry me\n```");
		await click(action(codeBlock(), "copy-code"));
		const status = codeBlock().querySelector<HTMLElement>("[data-answer-copy-status]")!;
		expect(status.getAttribute("role")).toBe("status");
		expect(status.getAttribute("aria-live")).toBe("polite");
		expect(status.textContent).toBe(replyReadingText("copyFailed"));
		expect(status.textContent).not.toContain(replyReadingText("copied"));
		await click(action(codeBlock(), "copy-code"));
		expect(status.textContent).toBe(replyReadingText("copied"));
		expect(writeText).toHaveBeenCalledTimes(2);
	});

	it("preserves unchanged expanded blocks, resets changed payloads and never drops code lines", async () => {
		const payload = Array.from({ length: 24 }, (_, index) => `  line ${index}`).join("\n") + "\n";
		const markdown = `\`\`\`text\n${payload}\`\`\`\n\n\`\`\`\nshort\n\`\`\``;
		await render(markdown);
		expect(action(codeBlock(), "expand-code").hidden).toBe(false);
		expect(action(codeBlock(1), "expand-code").hidden).toBe(true);
		await click(action(codeBlock(), "expand-code"));
		expect(action(codeBlock(), "expand-code").getAttribute("aria-expanded")).toBe("true");
		await render(markdown + "\n\nAnother paragraph.");
		expect(codeBlock().dataset.answerExpanded).toBe("true");
		expect(codeBlock().querySelector("code")?.textContent).toBe(payload);
		await render(markdown.replace("line 0", "updated line 0"));
		expect(codeBlock().dataset.answerExpanded).toBe("false");
		await click(action(codeBlock(), "copy-code"));
		expect(writeText).toHaveBeenLastCalledWith(payload.replace("line 0", "updated line 0"));
	});

	it("does not attach an old asynchronous copy result to a replacement block", async () => {
		const pending = Promise.withResolvers<void>();
		writeText.mockReturnValueOnce(pending.promise);
		await render("```js\noriginal\n```");
		await click(action(codeBlock(), "copy-code"));
		await render("```js\nnew streamed contents\n```");
		await act(async () => pending.resolve());
		expect(codeBlock().querySelector("[data-answer-copy-status]")?.textContent).toBe("");
		await click(action(codeBlock(), "copy-code"));
		expect(writeText).toHaveBeenLastCalledWith("new streamed contents\n");
		expect(codeBlock().querySelector("[data-answer-copy-status]")?.textContent).toBe(replyReadingText("copied"));
	});

	it("offers a keyboard scroll region only while code overflows", async () => {
		codeWidth = 720;
		await render("```js\n  const wideLine = true;\n```");
		const pre = codeBlock().querySelector("pre")!;
		expect(pre.getAttribute("tabindex")).toBe("0");
		expect(pre.getAttribute("role")).toBe("region");
		expect(pre.getAttribute("aria-label")).toBe(`${replyReadingText("code")} · js`);
		codeWidth = 240;
		await act(async () => resized.at(-1)!());
		expect(pre.hasAttribute("tabindex")).toBe(false);
		expect(pre.hasAttribute("role")).toBe(false);
		expect(pre.querySelector("code")?.textContent).toBe("  const wideLine = true;\n");
	});

	it("makes overflowing tables focusable, updates directional hints and expands only long tables", async () => {
		tableWidth = 720;
		const rows = Array.from({ length: 18 }, (_, index) => `| row ${index} | details ${index} |`).join("\n");
		await render(`| Name | Details |\n| --- | --- |\n${rows}`);
		const table = host.querySelector<HTMLElement>("[data-answer-table]")!;
		const viewport = table.querySelector<HTMLElement>("[data-answer-table-scroll]")!;
		const hint = table.querySelector<HTMLElement>("[data-answer-table-hint]")!;
		expect(viewport.getAttribute("tabindex")).toBe("0");
		expect(viewport.getAttribute("role")).toBe("region");
		expect(hint.hidden).toBe(false);
		expect(hint.textContent).toBe(replyReadingText("tableScrollRight"));
		viewport.scrollLeft = 480;
		await act(async () => viewport.dispatchEvent(new window.Event("scroll")));
		expect(hint.textContent).toBe(replyReadingText("tableScrollLeft"));
		expect(action(table, "expand-table").hidden).toBe(false);
		await click(action(table, "expand-table"));
		expect(table.dataset.answerExpanded).toBe("true");
		expect(table.querySelectorAll("tr")).toHaveLength(19);
		await click(action(table, "expand-table"));
		expect(table.dataset.answerExpanded).toBe("false");
		tableWidth = 240;
		await act(async () => resized.at(-1)!());
		expect(hint.hidden).toBe(true);
	});

	it("leaves ordinary path and link clicks available to the parent", async () => {
		const onBodyClick = vi.fn();
		await render("Read `src/main.ts` or [the reference](https://example.test/reference).", onBodyClick);
		await act(async () => host.querySelector<HTMLElement>(".owl-path-chip")!.click());
		await act(async () => host.querySelector<HTMLAnchorElement>("a")!.click());
		expect(onBodyClick).toHaveBeenCalledTimes(2);
	});
});

describe("Markdown image preview entry points", () => {
	let active: Element | null;
	let openModal: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		active = null;
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
		window.HTMLElement.prototype.focus = function (): void { active = this; };
		Object.defineProperty(window.HTMLElement.prototype, "open", { configurable: true, get() { return this.hasAttribute("open"); } });
		openModal = vi.fn(function (this: HTMLElement) { this.setAttribute("open", ""); });
		window.HTMLElement.prototype.showModal = openModal;
		window.HTMLElement.prototype.close = function (): void { this.removeAttribute("open"); };
		window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 500, top: 0, left: 0, right: 800, bottom: 500, toJSON: () => ({}) });
	});

	function image(): HTMLImageElement { return document.querySelector<HTMLImageElement>(".owl-image-viewer-image")!; }
	function close(): HTMLButtonElement { return document.querySelector<HTMLButtonElement>('.owl-image-viewer button[aria-label="关闭预览"]')!; }
	async function imageClick(target: HTMLImageElement): Promise<Event> {
		const event = new window.Event("click", { bubbles: true, cancelable: true });
		await act(async () => target.dispatchEvent(event));
		return event;
	}

	it("opens the clicked image from a shared group without following its enclosing link", async () => {
		const parentClick = vi.fn();
		await render("![第一张](https://example.test/first.png)\n\n[![链接里的第二张](https://example.test/second.png)](https://example.test/article)", parentClick);
		const pictures = [...host.querySelectorAll<HTMLImageElement>(".owl-answer-reading img")];
		expect(pictures[1].getAttribute("tabindex")).toBe("0");
		expect(pictures[1].getAttribute("role")).toBe("button");
		expect(pictures[1].getAttribute("aria-label")).toContain("链接里的第二张");
		const event = await imageClick(pictures[1]);
		expect(event.defaultPrevented).toBe(true);
		expect(parentClick).not.toHaveBeenCalled();
		expect(image().getAttribute("src")).toBe("https://example.test/second.png");
		expect(document.querySelector(".owl-image-viewer-count")?.textContent).toBe("2 / 2");
		await act(async () => document.querySelector<HTMLButtonElement>('.owl-image-viewer button[aria-label="上一张"]')!.click());
		expect(image().getAttribute("src")).toBe("https://example.test/first.png");
		expect(openModal).toHaveBeenCalledOnce();
		await act(async () => close().click());
		expect(active).toBe(pictures[1]);
	});

	it.each(["Enter", " "])("opens an inline image with %j and keeps code controls independent", async (key) => {
		await render("![键盘截图](/fixture/keyboard.png)\n\n```js\nconst preserved = '<image>';\n```");
		const picture = host.querySelector<HTMLImageElement>(".owl-answer-reading img")!;
		const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key, isComposing: false });
		await act(async () => picture.dispatchEvent(event));
		expect(event.defaultPrevented).toBe(true);
		expect(image().getAttribute("src")).toBe("/fixture/keyboard.png");
		await act(async () => close().click());
		await click(action(codeBlock(), "copy-code"));
		expect(writeText).toHaveBeenCalledExactlyOnceWith("const preserved = '<image>';\n");
		expect(document.querySelector(".owl-image-viewer")).toBeNull();
	});

	it("keeps the open image snapshot and zoom while the answer continues streaming", async () => {
		const original = "![第一张](/fixture/original.png)\n\n![第二张](/fixture/second.png)";
		await render(original);
		await imageClick(host.querySelector<HTMLImageElement>(".owl-answer-reading img")!);
		const viewer = document.querySelector(".owl-image-viewer")!;
		const picture = image();
		Object.defineProperties(picture, { naturalWidth: { configurable: true, value: 1600 }, naturalHeight: { configurable: true, value: 1000 } });
		await act(async () => picture.dispatchEvent(new window.Event("load")));
		const originalZoom = document.querySelector(".owl-image-viewer-scale")!.textContent;
		await act(async () => document.querySelector<HTMLButtonElement>('.owl-image-viewer button[aria-label="放大"]')!.click());
		const zoom = document.querySelector(".owl-image-viewer-scale")!.textContent;
		expect(zoom).not.toBe(originalZoom);
		await render(original.replace("original.png", "changed.png") + "\n\n新增正文\n\n![第三张](/fixture/third.png)");
		expect(document.querySelector(".owl-image-viewer")).toBe(viewer);
		expect(image()).toBe(picture);
		expect(image().getAttribute("src")).toBe("/fixture/original.png");
		expect(document.querySelector(".owl-image-viewer-count")?.textContent).toBe("1 / 2");
		expect(document.querySelector(".owl-image-viewer-scale")?.textContent).toBe(zoom);
		expect(openModal).toHaveBeenCalledOnce();
	});
});
