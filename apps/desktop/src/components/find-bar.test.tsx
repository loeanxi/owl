import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindBar } from "./FindBar.tsx";

class TextRange {
	startContainer?: Node;
	startOffset = 0;
	endContainer?: Node;
	endOffset = 0;
	setStart(node: Node, offset: number): void {
		this.startContainer = node;
		this.startOffset = offset;
	}
	setEnd(node: Node, offset: number): void {
		this.endContainer = node;
		this.endOffset = offset;
	}
}

let container: HTMLElement;
let root: Root;
let highlights: Map<string, Set<unknown>>;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div><p>alpha beta alpha</p></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
	vi.spyOn(document, "createRange").mockImplementation(() => new TextRange() as unknown as Range);
	highlights = new Map();
	vi.stubGlobal("CSS", { highlights });
	vi.stubGlobal(
		"Highlight",
		class extends Set<unknown> {
			constructor(...ranges: unknown[]) {
				super(ranges);
			}
		},
	);
	(dom.window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
	// linkedom 的输入框未实现 focus/select，补空实现。
	(dom.window.HTMLInputElement.prototype as unknown as Record<string, unknown>).focus = () => {};
	(dom.window.HTMLInputElement.prototype as unknown as Record<string, unknown>).select = () => {};
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	onClose = vi.fn();
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	await act(async () => root.render(<FindBar onClose={onClose} />));
}

async function type(text: string): Promise<void> {
	await act(async () => {
		const input = container.querySelector("input")!;
		input.value = text;
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
	await act(async () => {
		// 组件的防抖走 window.setTimeout，等真实的防抖窗口过去再断言。
		await new Promise((resolve) => setTimeout(resolve, 200));
	});
}

function counter(): string | undefined {
	return container.querySelector(".owl-find-count")?.textContent;
}

describe("FindBar match counting", () => {
	it("counts matches, starts at the first one and cycles with next", async () => {
		await render();
		expect(container.querySelector(".owl-find-count")).toBeNull();
		await type("alpha");
		expect(counter()).toBe("1/2 处");
		await act(async () => {
			container.querySelector<HTMLButtonElement>("button[aria-label='下一个（Enter）']")!.click();
		});
		expect(counter()).toBe("2/2 处");
		await act(async () => {
			container.querySelector<HTMLButtonElement>("button[aria-label='下一个（Enter）']")!.click();
		});
		expect(counter()).toBe("1/2 处");
	});

	it("shows the not-found hint when nothing matches", async () => {
		await render();
		await type("missing-word");
		expect(counter()).toBeUndefined();
		expect(container.querySelector("[role='status']")?.textContent).toBe("未找到匹配内容");
	});

	it("falls back to window.find and hides the counter when the highlight API is missing", async () => {
		vi.stubGlobal("CSS", {});
		const find = vi.fn(() => true);
		(window as unknown as { find: unknown }).find = find;
		await render();
		await type("alpha");
		await act(async () => {
			container.querySelector<HTMLButtonElement>("button[aria-label='下一个（Enter）']")!.click();
		});
		expect(find).toHaveBeenCalledWith("alpha", false, false, true, false, false, false);
		expect(counter()).toBeUndefined();
		expect(container.querySelector("[role='status']")).toBeNull();
	});

	it("clears highlights on unmount so the next open starts clean", async () => {
		await render();
		await type("alpha");
		expect(highlights.size).toBe(2);
		await act(async () => root.unmount());
		expect(highlights.size).toBe(0);
		root = createRoot(container);
	});

	it("closes on Escape", async () => {
		await render();
		await act(async () => {
			const event = new window.Event("keydown");
			(event as unknown as { key: string }).key = "Escape";
			document.dispatchEvent(event);
		});
		expect(onClose).toHaveBeenCalled();
	});
});
