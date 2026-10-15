import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionSearchHit } from "../bridge/protocol.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { SessionSidebar } from "./SessionSidebar.tsx";

const hit: SessionSearchHit = {
	sessionId: "research-chat", cwd: "D:/beta", title: "研究中的另一个问题", scope: "research", archived: false,
	modified: "2026-10-15T04:00:00.000Z", entryId: "later-error", role: "user", excerpt: "后续报错 SQL", matchRanges: [{ start: 5, end: 8 }],
};
type Props = React.ComponentProps<typeof SessionSidebar>;
let container: HTMLElement;
let root: Root;
let props: Props;

beforeEach(() => {
	vi.useFakeTimers();
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
	vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 264, height: 800, top: 0, left: 0, right: 264, bottom: 800, toJSON: () => ({}) });
	dom.window.HTMLElement.prototype.scrollTo = () => {};
	dom.window.HTMLElement.prototype.scrollIntoView = () => {};
	container = dom.document.getElementById("root")!;
	Object.defineProperty(container, "clientWidth", { value: 1280 });
	Object.defineProperty(container, "clientHeight", { value: 800 });
	root = createRoot(container);
	setUiLanguage("zh");
	const request = vi.fn(async (value: { type: string }) => value.type === "session.search"
		? { ok: true, result: { hits: [hit], hasMore: false } }
		: { ok: true, result: [{ id: "alpha-chat", cwd: "D:/alpha", name: "普通会话", scope: "chat", modified: hit.modified }, { id: hit.sessionId, cwd: hit.cwd, name: hit.title, scope: "research", modified: hit.modified }] });
	props = {
		client: { request } as unknown as BridgeClient, sessionScope: "chat", connected: true, activeId: "alpha-chat", activeProject: "D:/alpha",
		runningSessions: new Set(), refreshKey: "alpha-chat", revision: 0, focus: "chat", minimized: false,
		onToggleMinimized: vi.fn(), onNewChat: vi.fn(), onNewChatInProject: vi.fn(), onSelectProject: vi.fn(), onOpenSession: vi.fn(), onOpenSearchHit: vi.fn(),
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	await act(async () => root.render(<SessionSidebar {...props} />));
}

describe("SessionSidebar search and project entry points", () => {
	it("replaces regular groups with body hits, routes cross-source hits, and restores groups when cleared", async () => {
		await render();
		expect(container.querySelector("#projects")).not.toBeNull();
		await act(async () => {
			const input = container.querySelector<HTMLInputElement>(".owl-sidebar-search-input")!;
			input.value = "SQL";
			input.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		expect(container.querySelector("#projects")).toBeNull();
		await act(async () => vi.advanceTimersByTimeAsync(220));
		expect(container.textContent).toContain("后续报错 SQL");
		await act(async () => container.querySelector<HTMLButtonElement>(".owl-session-search-hit")!.click());
		expect(props.onOpenSearchHit).toHaveBeenCalledExactlyOnceWith(hit, "SQL");
		expect(props.onOpenSession).not.toHaveBeenCalled();
		await act(async () => container.querySelector<HTMLButtonElement>(".owl-sidebar-search-clear")!.click());
		expect(container.querySelector(".owl-session-search-panel")).toBeNull();
		expect(container.querySelector("#projects")).not.toBeNull();
	});

	it("selects the current project by name while its chevron alone toggles the list", async () => {
		await render();
		const group = container.querySelector<HTMLElement>('[data-project-path="d:/alpha"]')!;
		const toggle = group.querySelector<HTMLButtonElement>(".owl-sidebar-project-toggle")!;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		await act(async () => group.querySelector<HTMLButtonElement>(".owl-sidebar-project-row .owl-sidebar-row-main")!.click());
		expect(props.onSelectProject).toHaveBeenCalledExactlyOnceWith("D:/alpha");
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		await act(async () => toggle.click());
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(props.onSelectProject).toHaveBeenCalledTimes(1);
	});

	it("preserves explicit new-chat controls for the selected project", async () => {
		await render();
		const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === t("sidebar.newChatInProjectAria", { project: "alpha" }))!;
		await act(async () => button.click());
		expect(props.onNewChatInProject).toHaveBeenCalledExactlyOnceWith("D:/alpha");
		expect(props.onSelectProject).not.toHaveBeenCalled();
	});
});
