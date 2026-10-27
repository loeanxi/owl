import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationHeader, type ConversationView } from "./ConversationHeader.tsx";
import { setUiLanguage } from "../i18n/index.ts";

let root: Root;
let container: HTMLElement;
let onViewChange: ReturnType<typeof vi.fn<(view: ConversationView) => void>>;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Element", dom.window.Element); vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	onViewChange = vi.fn<(view: ConversationView) => void>();
});

afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function renderHeader(view: ConversationView = "chat"): Promise<void> {
	await act(async () => root.render(
		<ConversationHeader
			title="你好"
			view={view}
			onViewChange={onViewChange}
			terminalOpen={false}
			sidebarOpen={false}
			onToggleTerminal={vi.fn()}
			onToggleSidebar={vi.fn()}
			onExport={vi.fn()}
			onExportTurns={vi.fn()}
		/>,
	));
}

describe("ConversationHeader view switcher", () => {
	it("触发钮只显示当前视图图标，悬浮不出列表", async () => {
		await renderHeader("chat");
		const tabs = container.querySelector(".owl-view-tabs")!;
		const trigger = tabs.querySelector(".owl-view-tabs-trigger")!;
		expect(trigger.textContent).not.toContain("对话");
		expect(trigger.querySelector("svg")).toBeTruthy();
		expect(trigger.getAttribute("title")).toBe("对话");
		await act(async () => tabs.dispatchEvent(new window.Event("mouseover", { bubbles: true })));
		expect(container.querySelector(".owl-view-tabs-popover")).toBeNull();
	});

	it("点击触发钮展开三项视图列表并标记当前项", async () => {
		await renderHeader("context");
		const trigger = container.querySelector(".owl-view-tabs-trigger")!;
		await act(async () => trigger.click());
		const popover = container.querySelector(".owl-view-tabs-popover")!;
		const items = [...popover.querySelectorAll("button")];
		expect(items.map((item) => item.textContent)).toEqual(["对话", "上下文", "轨迹"]);
		expect(items.find((item) => item.classList.contains("is-current"))?.textContent).toContain("上下文");
	});

	it("点击列表项切换视图并收起弹层", async () => {
		await renderHeader("chat");
		const trigger = container.querySelector(".owl-view-tabs-trigger")!;
		await act(async () => trigger.click());
		const target = [...container.querySelectorAll<HTMLButtonElement>(".owl-view-tabs-popover button")].find((item) => item.textContent?.includes("轨迹"));
		expect(target).toBeTruthy();
		await act(async () => target!.click());
		expect(onViewChange).toHaveBeenCalledWith("trajectory");
		expect(container.querySelector(".owl-view-tabs-popover")).toBeNull();
	});
});
