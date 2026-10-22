import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setUiLanguage } from "../i18n/index.ts";
import { ExecutionToolbar } from "./ExecutionToolbar.tsx";

let host: HTMLElement;
let root: Root;

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
	setUiLanguage("zh");
	host = document.getElementById("root")!;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(collapsed: boolean, onToggleCollapsed: () => void): Promise<void> {
	await act(async () => root.render(
		<ExecutionToolbar
			view="normal"
			onView={() => {}}
			onShortcut={() => true}
			onTerminal={() => {}}
			onTasks={() => {}}
			onChanges={() => {}}
			terminalOpen={false}
			changeCount={15}
			collapsed={collapsed}
			onToggleCollapsed={onToggleCollapsed}
			plan={<p data-plan="true">计划</p>}
		/>,
	));
}

it("keeps the toolbar actions and the change count visible while expanded and collapses on demand", async () => {
	const onToggleCollapsed = vi.fn();
	await render(false, onToggleCollapsed);
	expect(host.querySelector('[aria-label="终端"]')).not.toBeNull();
	expect(host.querySelector('[aria-label="后台任务"]')).not.toBeNull();
	expect(host.querySelector('[aria-label="改动"]')?.textContent).toContain("15");
	const collapse = host.querySelector<HTMLButtonElement>('[aria-label="收起执行工具栏"]')!;
	expect(collapse.getAttribute("aria-expanded")).toBe("true");
	await act(async () => collapse.click());
	expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
});

it("renders a single expand affordance when collapsed and keeps the plan below it", async () => {
	const onToggleCollapsed = vi.fn();
	await render(true, onToggleCollapsed);
	expect(host.querySelector('[aria-label="终端"]')).toBeNull();
	expect(host.querySelector('[aria-label="后台任务"]')).toBeNull();
	expect(host.querySelector('[aria-label="改动"]')).toBeNull();
	expect(host.querySelector('[data-plan="true"]')).not.toBeNull();
	const expand = host.querySelector<HTMLButtonElement>('[aria-label="展开执行工具栏"]')!;
	expect(expand.getAttribute("aria-expanded")).toBe("false");
	await act(async () => expand.click());
	expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
});
