/**
 * BrowserTab 的渲染契约：agent 正在操作的元素要高亮出来，多页要有标签页条。
 *
 * 这两块只靠协议层验证不够——面板里画没画出来是前端的事，这里直接渲染组件断言 DOM。
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionContext } from "../registry.ts";
import { BrowserTab } from "./BrowserTab.tsx";

vi.mock("../store.ts", () => ({
	useSidebarState: () => ({ activeId: "tab-1" }),
}));
vi.mock("../iab-bound.ts", () => ({
	bindIabPage: () => {},
	unbindIabPage: () => {},
	encodeIabPath: () => "iab:page-1|https://example.test/",
	parseIabPath: () => ({ pageId: "page-1", url: "https://example.test/" }),
}));

let root: Root;
let host: HTMLElement;
let handlers: Array<(message: unknown) => void>;

function push(message: unknown): void {
	for (const handler of handlers) handler(message);
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("ResizeObserver", class {
		observe(): void {}
		disconnect(): void {}
	});
	Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1280 });
	Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 860 });
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
		x: 0, y: 0, width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400, toJSON: () => ({}),
	});
	handlers = [];
	host = dom.document.getElementById("root") as HTMLElement;
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
});

async function renderTab(): Promise<void> {
	const client = {
		request: vi.fn(async () => ({ ok: true, result: { page: { pageId: "page-1", url: "https://example.test/", title: "示例", viewport: { width: 1280, height: 860 }, active: true } } })),
		onIabMessage: (handler: (message: unknown) => void) => {
			handlers.push(handler);
			return () => {};
		},
		onStatus: () => () => {},
	} as unknown as React.ComponentProps<typeof BrowserTab>["client"];

	const props = {
		api: { openExternal: vi.fn() },
		store: { setTabPath: vi.fn() },
		cwd: "D:/projects/demo",
		tab: { id: "tab-1", kind: "browser", path: "iab:page-1|https://example.test/" },
		client,
	} as unknown as React.ComponentProps<typeof BrowserTab>;

	act(() => {
		root.render(
			React.createElement(
				BrowserSessionContext.Provider,
				{ value: "chat-1" },
				React.createElement(BrowserTab, props),
			),
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

describe("browser tab rendering", () => {
	it("highlights the element the agent is acting on and clears it afterwards", async () => {
		await renderTab();
		act(() => {
			push({
				type: "iab.pages",
				pages: [
					{ pageId: "page-1", sessionId: "chat-1", url: "https://example.test/", title: "示例", viewport: { width: 1280, height: 860 }, active: true },
				],
				origin: "agent",
			});
		});
		act(() => {
			push({
				type: "iab.frame",
				pageId: "page-1",
				data: "AAAA",
				format: "jpeg",
				width: 1280,
				height: 860,
			});
		});
		act(() => {
			push({
				type: "iab.highlight",
				pageId: "page-1",
				action: "browser_click",
				rect: { x: 32, y: 154, width: 43, height: 23 },
			});
		});
		const highlight = host.querySelector(".owl-browser-highlight") as HTMLElement | null;
		expect(highlight).not.toBeNull();
		expect(highlight?.style.left).toBe("32px");
		expect(highlight?.style.top).toBe("154px");
		expect(highlight?.style.width).toBe("43px");
		expect(highlight?.style.height).toBe("23px");

		act(() => {
			push({ type: "iab.highlight", pageId: "page-1", rect: null });
		});
		expect(host.querySelector(".owl-browser-highlight")).toBeNull();
	});

	it("lists the conversation's pages as a tab strip", async () => {
		await renderTab();
		act(() => {
			push({
				type: "iab.pages",
				pages: [
					{ pageId: "page-1", sessionId: "chat-1", url: "https://a.test/", title: "甲页", viewport: { width: 1280, height: 860 }, active: true },
					{ pageId: "page-2", sessionId: "chat-1", url: "https://b.test/", title: "乙页", viewport: { width: 1280, height: 860 }, active: false },
				],
				origin: "agent",
			});
		});
		const tabs = host.querySelectorAll(".owl-browser-tab");
		expect(tabs.length).toBe(2);
		expect(tabs[0]?.textContent).toContain("甲页");
		expect(tabs[1]?.textContent).toContain("乙页");
	});
});
