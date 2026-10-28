import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiLanguage } from "../i18n/index.ts";
import { ClaudeAnswerFeedback } from "./ClaudeAnswerFeedback.tsx";

let root: Root;
let host: HTMLElement;
let storage: Map<string, string>;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	storage = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	});
	// React 在这个 DOM 之前加载，textarea 的变更走它的 input polyfill。
	Object.assign(dom.window.HTMLTextAreaElement.prototype, {
		attachEvent(this: HTMLElement, name: string, listener: EventListener): void {
			this.addEventListener(name.replace(/^on/, ""), listener);
		},
		detachEvent(this: HTMLElement, name: string, listener: EventListener): void {
			this.removeEventListener(name.replace(/^on/, ""), listener);
		},
	});
	setUiLanguage("zh");
	host = document.getElementById("root")!;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setUiLanguage("zh");
});

async function render(props: { onSubmit?: (text: string) => Promise<boolean> | void } = {}): Promise<void> {
	await act(async () => {
		root.render(<ClaudeAnswerFeedback sessionId="s1" entryId="e1" onSubmit={props.onSubmit} />);
	});
}

async function click(selector: string): Promise<void> {
	await act(async () => {
		(host.querySelector(selector) as HTMLButtonElement).click();
	});
}

async function type(text: string): Promise<void> {
	const input = host.querySelector(".owl-feedback-text") as HTMLTextAreaElement;
	await act(async () => {
		input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
		input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
		input.dispatchEvent(new window.Event("focusout", { bubbles: true }));
	});
}

describe("the answer's thumbs up / down", () => {
	it("shows both thumbs and keeps them exclusive", async () => {
		await render();
		const buttons = [...host.querySelectorAll(".owl-feedback-btn")] as HTMLButtonElement[];
		expect(buttons).toHaveLength(2);
		expect(buttons[0]?.getAttribute("aria-label")).toBe("赞");
		expect(buttons[1]?.getAttribute("aria-label")).toBe("踩");
		await click(".owl-feedback-btn:nth-of-type(1)");
		expect(host.querySelector(".owl-feedback-btn:nth-of-type(1)")?.getAttribute("aria-pressed")).toBe("true");
		// 赞和跌互斥：点跌之后赞不再是选中态。
		await click(".owl-feedback-btn:nth-of-type(2)");
		expect(host.querySelector(".owl-feedback-btn:nth-of-type(1)")?.getAttribute("aria-pressed")).toBe("false");
		expect(host.querySelector(".owl-feedback-btn:nth-of-type(2)")?.getAttribute("aria-pressed")).toBe("true");
	});

	it("asks for more when the thumbs down is pressed, and cancels the rating when pressed again", async () => {
		await render();
		await click(".owl-feedback-btn:nth-of-type(2)");
		// Claude 的点踩后面是一句「Tell us more (optional)」。
		expect(host.querySelector(".owl-feedback-label")?.textContent).toBe("补充说明（可选）");
		expect(host.querySelector(".owl-feedback-text")).not.toBeNull();
		// 再点一次同一个 = 取消评分，表单跟着收起来。
		await click(".owl-feedback-btn:nth-of-type(2)");
		expect(host.querySelector(".owl-feedback-form")).toBeNull();
		expect(host.querySelector(".owl-feedback-btn:nth-of-type(2)")?.getAttribute("aria-pressed")).toBe("false");
	});

	it("keeps the rating locally and hands the reason to Owl", async () => {
		const sent: string[] = [];
		await render({
			onSubmit: (text) => {
				sent.push(text);
				return true;
			},
		});
		await click(".owl-feedback-btn:nth-of-type(2)");
		await type("方向不对，我要的是接口契约");
		await click(".owl-feedback-action.is-primary");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("上一条回答没帮上忙");
		expect(sent[0]).toContain("方向不对，我要的是接口契约");
		// 评分落本地（按会话存）。
		expect(JSON.parse(storage.get("owl.feedback.s1") ?? "{}")).toEqual({
			e1: { rating: "down", reason: "方向不对，我要的是接口契约" },
		});
		expect(host.querySelector(".owl-feedback-note")?.textContent).toBe("已记录你的评价");
	});

	it("records the rating without bothering the conversation when no reason is written", async () => {
		const sent: string[] = [];
		await render({
			onSubmit: (text) => {
				sent.push(text);
				return true;
			},
		});
		await click(".owl-feedback-btn:nth-of-type(2)");
		await click(".owl-feedback-action.is-primary");
		expect(sent).toHaveLength(0);
		expect(JSON.parse(storage.get("owl.feedback.s1") ?? "{}")).toEqual({ e1: { rating: "down" } });
	});

	it("reports a rejected handoff instead of claiming it went through", async () => {
		await render({ onSubmit: () => false });
		await click(".owl-feedback-btn:nth-of-type(2)");
		await type("还是不对");
		await click(".owl-feedback-action.is-primary");
		expect(host.querySelector(".owl-feedback-note.is-error")?.textContent).toBe("反馈没送出去");
	});
});
