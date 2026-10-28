import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

let root: Root;
let container: HTMLElement;
let resizes: Set<ResizeObserverCallback>;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	resizes = new Set();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(private callback: ResizeObserverCallback) {
				resizes.add(callback);
			}
			observe(): void {}
			disconnect(): void {
				resizes.delete(this.callback);
			}
		},
	);
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function resize(): Promise<void> {
	await act(async () => {
		for (const callback of [...resizes]) callback([], {} as ResizeObserver);
	});
}

it("treats code expansion as reading while a later real user message resumes bottom-following", async () => {
	const entries: ChatEntry[] = [
		{ kind: "user", entryId: "question", text: "查看代码" },
		{
			kind: "assistant",
			entryId: "answer",
			text: "```ts\n" + "const value = 1;\n".repeat(30) + "```",
			thinking: "",
			tools: [],
		},
	];
	const render = async (next: ChatEntry[]): Promise<void> => {
		await act(async () => root.render(<ChatStream entries={next} sessionId="session" />));
	};
	await render(entries);
	const surface = container.querySelector<HTMLElement>(".owl-chat-scroll")!;
	let height = 2000;
	Object.defineProperties(surface, {
		clientHeight: { configurable: true, value: 400 },
		clientWidth: { configurable: true, value: 800 },
		scrollHeight: { configurable: true, get: () => height },
	});
	surface.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
	Object.defineProperty(container.querySelector("pre")!, "scrollHeight", { configurable: true, value: 700 });
	surface.scrollTop = 1600;
	surface.removeAttribute("data-owl-scroll-restoring");
	await act(async () => surface.dispatchEvent(new Event("scroll")));
	await resize();
	const copy = container.querySelector<HTMLButtonElement>('[data-answer-action="copy-code"]')!;
	await act(async () => copy.click());
	height = 2100;
	await resize();
	expect(surface.scrollTop).toBe(1700);
	const readingTop = surface.scrollTop;
	const expand = container.querySelector<HTMLButtonElement>('[data-answer-action="expand-code"]')!;
	expect(expand.hidden).toBe(false);
	await act(async () => expand.click());
	expect(expand.getAttribute("aria-expanded")).toBe("true");
	height = 2600;
	await resize();
	expect(surface.scrollTop).toBe(readingTop);
	await render([...entries, { kind: "user", entryId: "next-question", text: "继续检查" }]);
	expect(surface.scrollTop).toBe(height - surface.clientHeight);
	await resize();
	expect(surface.scrollTop).toBe(height - surface.clientHeight);
});
