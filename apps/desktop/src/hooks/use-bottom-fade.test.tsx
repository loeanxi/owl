import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBottomFade } from "./use-bottom-fade.ts";

let root: Root;
let host: HTMLElement;
let observed: (() => void)[];

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	observed = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				observed.push(callback);
			}
			observe(): void {}
			disconnect(): void {}
		},
	);
	host = document.getElementById("root")!;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

function Panel(): React.JSX.Element {
	const ref = useBottomFade<HTMLDivElement>();
	return (
		<div className="panel" ref={ref}>
			内容
		</div>
	);
}

describe("bottom fade overflow flag", () => {
	it("marks the box as overflowing only while the content is taller than the box", async () => {
		await act(async () => root.render(<Panel />));
		const panel = host.querySelector<HTMLElement>(".panel")!;
		expect(panel.dataset.answerOverflow).toBe("none");
		Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 400 });
		Object.defineProperty(panel, "clientHeight", { configurable: true, value: 200 });
		await act(async () => observed.at(-1)!());
		expect(panel.dataset.answerOverflow).toBe("bottom");
		Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 120 });
		await act(async () => observed.at(-1)!());
		expect(panel.dataset.answerOverflow).toBe("none");
	});
});
