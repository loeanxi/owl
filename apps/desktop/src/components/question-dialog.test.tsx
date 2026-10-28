import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionRequest } from "../bridge/protocol.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { QuestionDialog } from "./QuestionDialog.tsx";

let root: Root;
let host: HTMLElement;
let window: Window & typeof globalThis;
let props: { request: QuestionRequest; onAnswer: ReturnType<typeof vi.fn> };

const request: QuestionRequest = {
	type: "question_request",
	requestId: "q-1",
	sessionId: "session-1",
	toolCallId: "ask-1",
	questions: [
		{
			header: "超时",
			question: "超时改成多少毫秒？",
			multiSelect: false,
			options: [{ label: "3000" }, { label: "5000", description: "更保守" }],
		},
		{
			header: "范围",
			question: "要覆盖哪些文件？",
			multiSelect: true,
			options: [{ label: "仅 src" }, { label: "全部" }],
		},
	],
};

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	window = dom.window;
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe(): void {}
			disconnect(): void {}
		},
	);
	dom.window.matchMedia = () =>
		({ matches: false, addEventListener() {}, removeEventListener() {} }) as MediaQueryList;
	setUiLanguage("zh");
	host = document.getElementById("root")!;
	root = createRoot(host);
	props = { request, onAnswer: vi.fn() };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	await act(async () => root.render(<QuestionDialog request={props.request} onAnswer={props.onAnswer} />));
}

async function escape(): Promise<void> {
	const card = host.querySelector<HTMLElement>(".owl-question-card")!;
	const option = card.querySelector<HTMLElement>(".owl-question-card__choice")!;
	await act(async () => {
		option.focus();
		// linkedom 没有 KeyboardEvent 构造器：普通事件补一个实例级 key，React 合成事件照样读到。
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "Escape" });
		option.dispatchEvent(event);
	});
}

describe("question card escape staging", () => {
	it("collapses on the first Escape and cancels only on the second", async () => {
		await render();
		const card = host.querySelector<HTMLElement>(".owl-question-card")!;
		expect(card.getAttribute("data-collapsed")).toBe("false");

		await escape();
		expect(host.querySelector<HTMLElement>(".owl-question-card")!.getAttribute("data-collapsed")).toBe("true");
		expect(props.onAnswer).not.toHaveBeenCalled();

		await escape();
		expect(props.onAnswer).toHaveBeenCalledTimes(1);
		expect(props.onAnswer).toHaveBeenCalledWith([], true);
	});

	it("keeps the cancel button as a one-click path", async () => {
		await render();
		const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "取消",
		)!;
		await act(async () => cancel.click());
		expect(props.onAnswer).toHaveBeenCalledWith([], true);
		expect(host.querySelector<HTMLElement>(".owl-question-card")!.getAttribute("data-collapsed")).toBe("false");
	});
});
