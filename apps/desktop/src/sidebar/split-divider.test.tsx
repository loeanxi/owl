import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiLanguage, t } from "../i18n/index.ts";
import { SplitDivider } from "./SplitDivider.tsx";
import { SidebarStore, type SplitNode } from "./store.ts";

let container: HTMLElement;
let root: Root;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

/** 造一个左右分屏，返回 store 与分隔条 id。 */
function splitFixture(): { store: SidebarStore; splitId: string } {
	const store = new SidebarStore("D:/split-divider-fixture");
	store.openSingleton("files", "文件");
	const left = store.getState().activePane;
	store.openSingleton("changes", "文件变动");
	store.moveTab("changes", left, "right");
	const tree = store.getState().tree as Extract<SplitNode, { kind: "split" }>;
	return { store, splitId: tree.id };
}

function currentRatio(store: SidebarStore, splitId: string): number {
	const tree = store.getState().tree;
	return tree.kind === "split" && tree.id === splitId ? tree.ratio : -1;
}

async function render(store: SidebarStore, splitId: string, ratio = 0.5): Promise<void> {
	await act(async () => root.render(<SplitDivider store={store} splitId={splitId} dir="row" ratio={ratio} />));
}

function separator(): HTMLElement {
	return container.querySelector<HTMLElement>('[role="separator"]')!;
}

async function key(name: string, shiftKey = false): Promise<void> {
	const event = new window.Event("keydown", { bubbles: true });
	Object.assign(event, { key: name, shiftKey });
	await act(async () => separator().dispatchEvent(event));
}

describe("分屏分隔条", () => {
	it("报出当前比例，可聚焦，并带一句怎么用的说明", async () => {
		const { store, splitId } = splitFixture();
		await render(store, splitId);
		expect(separator().getAttribute("aria-valuenow")).toBe("50");
		expect(separator().getAttribute("aria-label")).toBe(t("wb.splitPane"));
		expect(separator().getAttribute("title")).toBe(t("wb.splitPaneHint"));
		expect(separator().getAttribute("tabindex")).toBe("0");
	});

	it("双击复位到一半", async () => {
		const { store, splitId } = splitFixture();
		await render(store, splitId);
		store.setRatio(splitId, 0.2, { persist: false });
		await render(store, splitId, 0.2);
		await act(async () => separator().dispatchEvent(new window.Event("dblclick", { bubbles: true })));
		expect(currentRatio(store, splitId)).toBe(0.5);
	});

	it("方向键微调比例，Shift 步长更大", async () => {
		const { store, splitId } = splitFixture();
		await render(store, splitId);
		await key("ArrowRight");
		expect(currentRatio(store, splitId)).toBeCloseTo(0.52);
		await render(store, splitId, currentRatio(store, splitId));
		await key("ArrowLeft", true);
		expect(currentRatio(store, splitId)).toBeCloseTo(0.42);
		await render(store, splitId, currentRatio(store, splitId));
		await key("ArrowUp");
		expect(currentRatio(store, splitId)).toBeCloseTo(0.4);
	});
});
