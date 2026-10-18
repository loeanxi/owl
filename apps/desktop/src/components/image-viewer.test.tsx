import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiLanguage } from "../i18n/index.ts";
import { ImageViewer, type ImageViewerItem } from "./ImageViewer.tsx";

type Props = React.ComponentProps<typeof ImageViewer>;
const images: readonly ImageViewerItem[] = [
	{ src: "/fixture/first.png", alt: "第一张截图" },
	{ src: "/fixture/second.png", alt: "第二张截图" },
];
let root: Root;
let host: HTMLElement;
let trigger: HTMLButtonElement;
let props: Props;
let active: Element | null;
let frames: Map<number, FrameRequestCallback>;
let frameSequence: number;
let showModal: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;
let hostKey: ReturnType<typeof vi.fn>;
let hostWheel: ReturnType<typeof vi.fn>;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><button id='trigger'>查看原始截图</button><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("HTMLImageElement", dom.window.HTMLImageElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
	frames = new Map(); frameSequence = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++frameSequence; frames.set(id, callback); return id; });
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	active = null;
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
	dom.window.HTMLElement.prototype.focus = function (): void { active = this; };
	dom.window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 500, top: 0, left: 0, right: 800, bottom: 500, toJSON: () => ({}) });
	dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number): void {
		this.scrollLeft = typeof options === "number" ? options : options?.left ?? this.scrollLeft;
		this.scrollTop = typeof options === "number" ? y ?? this.scrollTop : options?.top ?? this.scrollTop;
	};
	Object.defineProperties(dom.window.HTMLElement.prototype, {
		clientWidth: { configurable: true, get: () => 800 },
		clientHeight: { configurable: true, get: () => 500 },
		tabIndex: { configurable: true,
			get() { const value = this.getAttribute("tabindex"); return value === null ? /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(this.tagName) ? 0 : -1 : Number(value); },
			set(value: number) { this.setAttribute("tabindex", String(value)); },
		},
		open: { configurable: true, get() { return this.hasAttribute("open"); } },
	});
	// These shims model the native API calls only. Actual top-layer layout and
	// browser focus isolation belong to the browser fixture, not Linkedom.
	showModal = vi.fn(function (this: HTMLElement) { this.setAttribute("open", ""); });
	closeDialog = vi.fn(function (this: HTMLElement) { this.removeAttribute("open"); });
	dom.window.HTMLElement.prototype.showModal = showModal;
	dom.window.HTMLElement.prototype.close = closeDialog;
	host = document.getElementById("root")!;
	host.style.setProperty("mask-image", "linear-gradient(transparent, black)");
	host.style.overflow = "hidden";
	trigger = document.getElementById("trigger") as HTMLButtonElement;
	trigger.focus();
	root = createRoot(host);
	props = { images, index: 0, onIndexChange: vi.fn(), onClose: vi.fn() };
	hostKey = vi.fn(); hostWheel = vi.fn();
	setUiLanguage("zh");
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function render(overrides: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<div onKeyDown={hostKey} onWheel={hostWheel}><ImageViewer {...props} /></div>));
	await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });
}

function dialog(): HTMLDialogElement { return document.querySelector<HTMLDialogElement>(".owl-image-viewer")!; }
function picture(): HTMLImageElement { return dialog().querySelector<HTMLImageElement>(".owl-image-viewer-image")!; }
function stage(): HTMLElement { return dialog().querySelector<HTMLElement>(".owl-image-viewer-stage")!; }
function button(label: string): HTMLButtonElement {
	const result = dialog().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	if (!result) throw new Error(`Missing image viewer button: ${label}`);
	return result;
}
async function click(element: HTMLElement): Promise<void> { await act(async () => element.click()); }
async function key(target: HTMLElement | Document, value: string): Promise<Event> {
	const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: value, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false });
	await act(async () => target.dispatchEvent(event));
	return event;
}
async function load(image: HTMLImageElement, width: number, height: number): Promise<void> {
	Object.defineProperties(image, { naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height }, complete: { configurable: true, value: true } });
	await act(async () => image.dispatchEvent(new window.Event("load")));
}

describe("Shared image viewer", () => {
	it("mounts its modal directly under body outside the masked conversation subtree", async () => {
		await render();
		expect(dialog()).not.toBeNull();
		expect(dialog().parentElement).toBe(document.body);
		expect(host.contains(dialog())).toBe(false);
		expect(dialog().tagName).toBe("DIALOG");
		expect(showModal).toHaveBeenCalledOnce();
		expect(dialog().open).toBe(true);
		expect(picture().getAttribute("src")).toBe(images[0].src);
		expect(picture().alt).toBe(images[0].alt);
		expect(picture().getAttribute("draggable")).toBe("false");
	});

	it("requests the adjacent image while keeping navigation within the image group", async () => {
		await render();
		expect(button("上一张").disabled).toBe(true);
		await click(button("下一张"));
		expect(props.onIndexChange).toHaveBeenLastCalledWith(1);
		await render({ index: 1 });
		expect(picture().getAttribute("src")).toBe(images[1].src);
		expect(button("下一张").disabled).toBe(true);
		await click(button("上一张"));
		expect(props.onIndexChange).toHaveBeenLastCalledWith(0);
		expect(props.onClose).not.toHaveBeenCalled();
	});

	it("consumes viewer keys before they reach the conversation and closes on Escape", async () => {
		await render();
		// Linkedom does not order document capture before React's delegated
		// bubble listener. Exercise the real document handler directly, then
		// separately check the portal's React propagation boundary.
		const globalKey = vi.fn();
		window.addEventListener("keydown", globalKey);
		await key(document, "ArrowRight");
		expect(props.onIndexChange).toHaveBeenLastCalledWith(1);
		await key(dialog(), "Tab");
		const escape = await key(document, "Escape");
		expect(escape.defaultPrevented).toBe(true);
		expect(props.onClose).toHaveBeenCalledOnce();
		expect(hostKey).not.toHaveBeenCalled();
		expect(globalKey).not.toHaveBeenCalled();
		window.removeEventListener("keydown", globalKey);
	});

	it("keeps picture clicks open but permits closing through the blank stage or close button", async () => {
		await render();
		await click(picture());
		expect(props.onClose).not.toHaveBeenCalled();
		await click(stage());
		expect(props.onClose).toHaveBeenCalledOnce();
		await click(button("关闭预览"));
		expect(props.onClose).toHaveBeenCalledTimes(2);
	});

	it("does not treat a picture press retargeted to the captured stage as a backdrop click", async () => {
		await render();
		await load(picture(), 1600, 1000);
		await click(button("原始尺寸"));
		const element = stage();
		Object.defineProperties(element, { scrollWidth: { configurable: true, value: 1600 }, scrollHeight: { configurable: true, value: 1000 } });
		const captured = new Set<number>();
		element.setPointerCapture = vi.fn((id: number) => { captured.add(id); });
		element.hasPointerCapture = (id: number) => captured.has(id);
		element.releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
		const pointer = async (target: HTMLElement, type: string, x: number, y: number): Promise<void> => {
			const event = Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), { pointerId: 7, button: 0, clientX: x, clientY: y });
			await act(async () => target.dispatchEvent(event));
		};
		// Feed the retargeted sequence explicitly; this tests our close guard,
		// not Linkedom's ability to reproduce native pointer capture.
		await pointer(picture(), "pointerdown", 200, 100);
		expect(element.setPointerCapture).toHaveBeenCalledWith(7);
		await pointer(element, "pointerup", 200, 100);
		await click(element);
		expect(props.onClose).not.toHaveBeenCalled();
		expect(element.releasePointerCapture).toHaveBeenCalledWith(7);
		await pointer(picture(), "pointerdown", 200, 100);
		await pointer(element, "pointermove", 180, 70);
		await pointer(element, "pointerup", 180, 70);
		await click(element);
		expect(props.onClose).not.toHaveBeenCalled();
		await pointer(element, "pointerdown", 40, 40);
		await pointer(element, "pointerup", 40, 40);
		await click(element);
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it("moves instantly to both ends of a long image without changing images or closing", async () => {
		await render();
		await load(picture(), 800, 6000);
		await click(button("原始尺寸"));
		const element = stage();
		Object.defineProperty(element, "scrollHeight", { configurable: true, value: 6000 });
		element.scrollTop = 1000;
		element.scrollLeft = 77;
		const scroll = vi.spyOn(element, "scrollTo");
		const end = await key(document, "End");
		expect(end.defaultPrevented).toBe(true);
		expect(scroll).toHaveBeenLastCalledWith({ top: 5500, behavior: "instant" });
		expect(element.scrollTop).toBe(5500);
		const home = await key(document, "Home");
		expect(home.defaultPrevented).toBe(true);
		expect(scroll).toHaveBeenLastCalledWith({ top: 0, behavior: "instant" });
		expect(element.scrollTop).toBe(0);
		expect(element.scrollLeft).toBe(77);
		expect(props.onIndexChange).not.toHaveBeenCalled();
		expect(props.onClose).not.toHaveBeenCalled();
	});

	it("keeps image scrolling out of the conversation's wheel handler", async () => {
		await render();
		const globalWheel = vi.fn();
		window.addEventListener("wheel", globalWheel);
		const wheel = Object.assign(new window.Event("wheel", { bubbles: true, cancelable: true }), { deltaY: -100, ctrlKey: true, metaKey: false });
		await act(async () => stage().dispatchEvent(wheel));
		expect(wheel.defaultPrevented).toBe(true);
		expect(hostWheel).not.toHaveBeenCalled();
		expect(globalWheel).not.toHaveBeenCalled();
		expect(props.onClose).not.toHaveBeenCalled();
		window.removeEventListener("wheel", globalWheel);
	});

	it("restores the connected opener when the modal is removed", async () => {
		const previousOverflow = document.body.style.overflow;
		await render();
		expect(active).not.toBe(trigger);
		expect(document.body.style.overflow).toBe("hidden");
		await act(async () => root.render(null));
		expect(document.querySelector(".owl-image-viewer")).toBeNull();
		expect(closeDialog).toHaveBeenCalledOnce();
		expect(active).toBe(trigger);
		expect(document.body.style.overflow).toBe(previousOverflow);
	});

	it("offers recovery and closing after an image cannot load", async () => {
		await render();
		await act(async () => picture().dispatchEvent(new window.Event("error")));
		expect(dialog().textContent).toContain("加载失败");
		const retry = [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((control) => control.textContent?.includes("重试"));
		expect(retry).toBeDefined();
		await click(retry!);
		expect(dialog().textContent).not.toContain("加载失败");
		await load(picture(), 1600, 1000);
		expect(picture().getAttribute("src")).toBe(images[0].src);
		await click(button("关闭预览"));
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it("returns to a fitting image when changing pictures and ignores a detached old image load", async () => {
		await render();
		const oldImage = picture();
		await load(oldImage, 1600, 1000);
		await click(button("原始尺寸"));
		await click(button("放大"));
		stage().scrollTop = 120;
		stage().scrollLeft = 160;
		await render({ index: 1 });
		const nextImage = picture();
		await load(nextImage, 400, 1200);
		expect(button("适应窗口").getAttribute("aria-pressed")).toBe("true");
		expect(Number.parseFloat(nextImage.style.height)).toBeGreaterThan(0);
		expect(Number.parseFloat(nextImage.style.height)).toBeLessThanOrEqual(stage().clientHeight);
		const dimensions = { width: nextImage.style.width, height: nextImage.style.height };
		await load(oldImage, 9999, 9999);
		expect(picture()).toBe(nextImage);
		expect(picture().getAttribute("src")).toBe(images[1].src);
		expect({ width: picture().style.width, height: picture().style.height }).toEqual(dimensions);
		expect(stage().scrollLeft).toBe(0);
		expect(stage().scrollTop).toBe(0);
		expect(props.onClose).not.toHaveBeenCalled();
	});
});
