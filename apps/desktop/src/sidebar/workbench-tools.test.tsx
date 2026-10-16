import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiLanguage, t } from "../i18n/index.ts";
import { isTabKindEnabled, setSidebarConfig } from "./config.ts";
import { QUICK_ACTIONS } from "./quick.tsx";
import { SidebarStore } from "./store.ts";
import { WorkbenchTools } from "./WorkbenchTools.tsx";

let container: HTMLElement;
let root: Root;
let store: SidebarStore;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
	setSidebarConfig({ disabledTabs: [], disabledViewers: [], injectOpenTool: false });
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	store = new SidebarStore("D:/workbench-tools-fixture");
});

afterEach(async () => {
	await act(async () => root.unmount());
	setSidebarConfig({ disabledTabs: [], disabledViewers: [], injectOpenTool: false });
	vi.unstubAllGlobals();
});

async function render(width: number): Promise<void> {
	await act(async () => root.render(<WorkbenchTools store={store} activeKind={store.getState().tabs.find((tab) => tab.id === store.getState().activeId)?.kind} width={width} kindAllowed={(kind) => kind !== "terminal" && isTabKindEnabled(kind)} />));
}

async function more(): Promise<void> {
	await act(async () => container.querySelector<HTMLButtonElement>(".owl-workbench-more-tools")!.click());
}

async function choose(kind: string): Promise<void> {
	await act(async () => container.querySelector<HTMLButtonElement>(`[data-workbench-tool="${kind}"]`)!.click());
}

describe("Workbench tool discovery", () => {
	it.each([
		[480, ["files", "browser", "changes"]],
		[380, ["files", "browser"]],
		[280, ["files"]],
	] as const)("keeps every enabled tool named and reachable at %ipx", async (width, pinned) => {
		await render(width);
		expect([...container.querySelectorAll("[data-workbench-quick]")].map((button) => button.getAttribute("data-workbench-quick"))).toEqual(pinned);
		for (const button of container.querySelectorAll<HTMLButtonElement>("[data-workbench-quick]")) {
			expect(button.textContent).toBe(button.getAttribute("aria-label"));
		}
		await more();
		const menuItems = [...container.querySelectorAll<HTMLButtonElement>("[data-workbench-tool]")];
		expect(menuItems.map((button) => button.getAttribute("data-workbench-tool"))).toEqual(QUICK_ACTIONS.filter((action) => !action.disabled && action.kind !== "terminal").map((action) => action.kind));
		expect(menuItems.every((button) => button.querySelector("svg") !== null && button.querySelector("span")!.textContent !== "")).toBe(true);
		const focus = vi.spyOn(container.querySelector<HTMLButtonElement>(".owl-workbench-more-tools")!, "focus");
		await choose("changes");
		expect(store.getState().tabs.map((tab) => tab.kind)).toEqual(["changes"]);
		expect(container.querySelector(".owl-workbench-tools-menu")).toBeNull();
		expect(focus).toHaveBeenCalledOnce();
	});

	it("hides disabled tools in both entry points and preserves singletons and multiple browsers", async () => {
		setSidebarConfig({ disabledTabs: ["files", "tasks"], disabledViewers: [], injectOpenTool: false });
		await render(480);
		expect(container.querySelector('[data-workbench-quick="files"]')).toBeNull();
		await more();
		expect(container.querySelector('[data-workbench-tool="files"]')).toBeNull();
		expect(container.querySelector('[data-workbench-tool="tasks"]')).toBeNull();
		await choose("review");
		await more();
		await choose("review");
		await more();
		await choose("browser");
		await more();
		await choose("browser");
		expect(store.getState().tabs.map((tab) => tab.kind)).toEqual(["review", "browser", "browser"]);
	});

	it("dismisses the keyboard menu with Escape and restores its trigger focus", async () => {
		await render(280);
		await more();
		const focus = vi.spyOn(container.querySelector<HTMLButtonElement>(".owl-workbench-more-tools")!, "focus");
		const event = new window.Event("keydown", { bubbles: true });
		Object.assign(event, { key: "Escape" });
		await act(async () => container.querySelector<HTMLButtonElement>('[data-workbench-tool="review"]')!.dispatchEvent(event));
		expect(container.querySelector(".owl-workbench-tools-menu")).toBeNull();
		expect(focus).toHaveBeenCalledOnce();
		expect(container.querySelector(".owl-workbench-more-tools")?.textContent).toContain(t("start.moreTools"));
	});
});
