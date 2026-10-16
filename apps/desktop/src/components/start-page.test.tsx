import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { setSidebarConfig } from "../sidebar/config.ts";
import { DEFAULT_WORKSPACE_DIR } from "../utils/paths.ts";
import { StartPage } from "./StartPage.tsx";

const { usageMounted } = vi.hoisted(() => ({ usageMounted: vi.fn() }));
vi.mock("./UsageOverview.tsx", () => ({
	UsageOverview: () => { usageMounted(); return <div className="test-usage-overview" />; },
}));

type Props = React.ComponentProps<typeof StartPage>;
let container: HTMLElement;
let root: Root;
let props: Props;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(dom.window.HTMLElement.prototype, "open", {
		configurable: true,
		get() { return this.hasAttribute("open"); },
		set(value: boolean) { if (value) this.setAttribute("open", ""); else this.removeAttribute("open"); },
	});
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	setUiLanguage("zh");
	setSidebarConfig({ disabledTabs: [], disabledViewers: [], injectOpenTool: false });
	usageMounted.mockClear();
	props = {
		client: { request: vi.fn() } as unknown as BridgeClient,
		cwd: "D:\\owl", profile: "agent A", onAction: vi.fn(), onPrompt: vi.fn(), onResume: vi.fn(), onOpenDeveloper: vi.fn(),
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	setSidebarConfig({ disabledTabs: [], disabledViewers: [], injectOpenTool: false });
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	await act(async () => root.render(<StartPage {...props} />));
}

async function toggleUsage(open: boolean): Promise<void> {
	await act(async () => {
		const details = container.querySelector<HTMLDetailsElement>(".owl-start-usage")!;
		details.open = open;
		details.dispatchEvent(new window.Event("toggle"));
	});
}

describe("StartPage task entry points and usage disclosure", () => {
	it("offers three examples that only fill the draft and never invoke actions or load sessions", async () => {
		await render();
		const examples = [...container.querySelectorAll<HTMLButtonElement>(".owl-start-example")];
		expect(examples).toHaveLength(3);
		await act(async () => examples[0]!.click());
		expect(props.onPrompt).toHaveBeenCalledExactlyOnceWith(t("start.exResearchPrompt"));
		expect(props.onResume).not.toHaveBeenCalled();
		expect(props.onAction).not.toHaveBeenCalled();
		expect(props.client!.request).not.toHaveBeenCalled();
		expect(container.querySelector(".owl-start-eyebrow")).toBeNull();
	});

	it("shows the current project and at most three recent tasks that resume the original id", async () => {
		props.recentSessions = [
			{ id: "one-original-id", title: "检查登录", time: "2026-10-15T08:00:00.000Z" },
			{ id: "two-original-id", title: "整理文件" },
			{ id: "three-original-id", title: "比较方案" },
			{ id: "four-original-id", title: "第四项不显示" },
		];
		await render();
		expect(container.querySelector(".owl-start-project-name")?.textContent).toBe("owl");
		expect(container.querySelector(".owl-start-project-name")?.getAttribute("title")).toBe("D:\\owl");
		const recent = [...container.querySelectorAll<HTMLButtonElement>(".owl-start-recent-task")];
		expect(recent).toHaveLength(3);
		expect(container.textContent).not.toContain("第四项不显示");
		expect(container.querySelector(".owl-start-task-time")?.getAttribute("title")).toBe("2026-10-15T08:00:00.000Z");
		expect(container.querySelector(".owl-start-task-time")?.textContent).not.toContain("T08:00");
		await act(async () => recent[1]!.click());
		expect(props.onResume).toHaveBeenCalledExactlyOnceWith("two-original-id");
		expect(props.onPrompt).not.toHaveBeenCalled();
		expect(props.onAction).not.toHaveBeenCalled();
	});

	it("keeps default data directories out of the project label and opens files explicitly", async () => {
		props.cwd = DEFAULT_WORKSPACE_DIR;
		await render();
		expect(container.querySelector(".owl-start-project-name")?.textContent).toBe(t("composer.projectChoose"));
		expect(container.querySelector(".owl-start-project-name")?.getAttribute("title")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>(".owl-start-project button")!.click());
		expect(props.onAction).toHaveBeenCalledExactlyOnceWith("files");
		expect(props.onPrompt).not.toHaveBeenCalled();
	});

	it("continues honoring disabled tool configuration", async () => {
		setSidebarConfig({ disabledTabs: ["files", "terminal", "changes", "review", "browser", "mirror", "tasks", "impression", "sidechat"], disabledViewers: [], injectOpenTool: false });
		await render();
		expect(container.querySelector(".owl-start-project button")).toBeNull();
		expect(container.querySelector(".owl-start-more-tools")).toBeNull();
		expect(container.querySelector(".owl-start-developer-action")).toBeNull();
		expect(container.querySelectorAll(".owl-start-example")).toHaveLength(3);
	});

	it("disables tool buttons when a host does not provide an action handler", async () => {
		props.onAction = undefined;
		await render();
		const buttons = [...container.querySelectorAll<HTMLButtonElement>(".owl-start-secondary-action:not(.owl-start-developer-action)")];
		expect(buttons.length).toBeGreaterThan(0);
		expect(buttons.every((button) => button.disabled)).toBe(true);
	});

	it("mounts usage only when opened and restores a separate disclosure preference per profile", async () => {
		await render();
		expect(usageMounted).not.toHaveBeenCalled();
		expect(container.querySelector(".test-usage-overview")).toBeNull();
		await toggleUsage(true);
		expect(container.querySelector(".test-usage-overview")).not.toBeNull();
		expect(localStorage.getItem("owl.start.usageOpen.agent%20A")).toBe("true");
		props.profile = "agent B";
		await render();
		expect(container.querySelector(".test-usage-overview")).toBeNull();
		expect(container.querySelector<HTMLDetailsElement>(".owl-start-usage")!.open).toBe(false);
		props.profile = "agent A";
		await render();
		expect(container.querySelector(".test-usage-overview")).not.toBeNull();
		await toggleUsage(false);
		expect(localStorage.getItem("owl.start.usageOpen.agent%20A")).toBe("false");
		expect(container.querySelector(".test-usage-overview")).toBeNull();
	});

	it("ignores a shared default preference while the current profile is still unknown", async () => {
		localStorage.setItem("owl.start.usageOpen.default", "true");
		localStorage.setItem("owl.start.usageOpen.agent%20A", "true");
		props.profile = undefined;
		await render();
		expect(usageMounted).not.toHaveBeenCalled();
		expect(container.querySelector<HTMLDetailsElement>(".owl-start-usage")!.open).toBe(false);
		props.profile = "agent A";
		await render();
		expect(container.querySelector(".test-usage-overview")).not.toBeNull();
	});
});
