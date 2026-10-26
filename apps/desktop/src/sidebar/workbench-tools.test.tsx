import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_KEYBINDINGS, formatAppKeybinding, publishAppKeybindings } from "../app-keybindings.ts";
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
	publishAppKeybindings(DEFAULT_APP_KEYBINDINGS);
	vi.unstubAllGlobals();
});

async function render(width: number, menuScope?: "all" | "unpinned"): Promise<void> {
	await act(async () => root.render(<WorkbenchTools store={store} activeKind={store.getState().tabs.find((tab) => tab.id === store.getState().activeId)?.kind} width={width} menuScope={menuScope} kindAllowed={(kind) => kind !== "terminal" && isTabKindEnabled(kind)} />));
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
			// 工具栏固定项只留图标：名称走 title/aria-label，与下方 tab 条（图标 + 名称）拉开层次。
			expect(button.getAttribute("aria-label")).not.toBe("");
			expect(button.getAttribute("title")).toBe(button.getAttribute("aria-label"));
			expect(button.querySelector("svg")).not.toBeNull();
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

	it("can scope the menu to the tools the toolbar does not already pin, without losing any", async () => {
		await render(480, "unpinned");
		const pinned = [...container.querySelectorAll("[data-workbench-quick]")].map((button) => button.getAttribute("data-workbench-quick"));
		await more();
		const menuItems = [...container.querySelectorAll<HTMLButtonElement>("[data-workbench-tool]")].map((button) => button.getAttribute("data-workbench-tool"));
		const enabled = QUICK_ACTIONS.filter((action) => !action.disabled && action.kind !== "terminal").map((action) => action.kind);
		// 菜单里不再重复工具栏已经固定的项。
		expect(menuItems.some((kind) => pinned.includes(kind!))).toBe(false);
		// 但两者合起来仍覆盖全部可用工具：去重不能让人找不到任何一个。
		expect([...pinned, ...menuItems].sort()).toEqual([...enabled].sort());
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

	it("groups the menu and explains every entry so look-alike cards can be told apart", async () => {
		await render(480);
		await more();
		const groups = [...container.querySelectorAll(".owl-workbench-tool-group")];
		expect(groups.map((group) => group.querySelector(".owl-workbench-tool-group-title")?.textContent)).toEqual([
			t("wb.groupWorkspace"),
			t("wb.groupRuntime"),
			t("wb.groupAgent"),
		]);
		const items = [...container.querySelectorAll<HTMLButtonElement>("[data-workbench-tool]")];
		// 每项都带一句说明：名字相近的卡片（文件变动 / 改动审批）不用点进去试。
		expect(items.every((item) => (item.querySelector(".owl-workbench-tool-desc")?.textContent ?? "") !== "")).toBe(true);
		const descOf = (kind: string): string => items.find((item) => item.getAttribute("data-workbench-tool") === kind)!.querySelector(".owl-workbench-tool-desc")!.textContent!;
		expect(descOf("changes")).toBe(t("wb.desc.changes"));
		expect(descOf("review")).toBe(t("wb.desc.review"));
		expect(descOf("changes")).not.toBe(descOf("review"));
	});

	it("marks the side chat entry with a beta badge instead of baking it into the name", async () => {
		await render(480);
		await more();
		const sidechat = container.querySelector<HTMLButtonElement>('[data-workbench-tool="sidechat"]')!;
		expect(sidechat.querySelector(".owl-workbench-tool-label")!.textContent).toBe(t("wb.sidechat"));
		expect(sidechat.querySelector(".owl-workbench-tool-label")!.textContent!.toLowerCase()).not.toContain("beta");
		expect(sidechat.querySelector(".owl-workbench-tool-badge")!.textContent).toBe(t("wb.badgeBeta"));
	});

	it("shows the live keyboard shortcut instead of a hard-coded one", async () => {
		publishAppKeybindings({ ...DEFAULT_APP_KEYBINDINGS, openBrowserTab: ["ctrl+shift+b"] });
		await render(480);
		await more();
		const browser = container.querySelector<HTMLButtonElement>('[data-workbench-tool="browser"]')!;
		expect(browser.querySelector("kbd")!.textContent).toBe(formatAppKeybinding("ctrl+shift+b"));
	});
});
