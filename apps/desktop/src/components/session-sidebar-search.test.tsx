import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionSearchHit } from "../bridge/protocol.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { SessionSidebar } from "./SessionSidebar.tsx";

const hit: SessionSearchHit = {
	sessionId: "research-chat",
	cwd: "D:/beta",
	title: "研究中的另一个问题",
	scope: "research",
	archived: false,
	modified: "2026-10-15T04:00:00.000Z",
	entryId: "later-error",
	role: "user",
	excerpt: "后续报错 SQL",
	matchRanges: [{ start: 5, end: 8 }],
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
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe(): void {}
			disconnect(): void {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
	vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
		x: 0,
		y: 0,
		width: 264,
		height: 800,
		top: 0,
		left: 0,
		right: 264,
		bottom: 800,
		toJSON: () => ({}),
	});
	dom.window.HTMLElement.prototype.scrollTo = () => {};
	dom.window.HTMLElement.prototype.scrollIntoView = () => {};
	container = dom.document.getElementById("root")!;
	Object.defineProperty(container, "clientWidth", { value: 1280, configurable: true });
	Object.defineProperty(container, "clientHeight", { value: 800 });
	root = createRoot(container);
	setUiLanguage("zh");
	const request = vi.fn(async (value: { type: string }) =>
		value.type === "session.search"
			? { ok: true, result: { hits: [hit], hasMore: false } }
			: {
					ok: true,
					result: [
						{ id: "alpha-chat", cwd: "D:/alpha", name: "普通会话", scope: "chat", modified: hit.modified },
						{ id: hit.sessionId, cwd: hit.cwd, name: hit.title, scope: "research", modified: hit.modified },
					],
				},
	);
	props = {
		client: { request } as unknown as BridgeClient,
		sessionScope: "chat",
		connected: true,
		activeId: "alpha-chat",
		activeProject: "D:/alpha",
		runningSessions: new Set(),
		refreshKey: "alpha-chat",
		revision: 0,
		focus: "chat",
		minimized: false,
		onToggleMinimized: vi.fn(),
		onNewChat: vi.fn(),
		onNewChatInProject: vi.fn(),
		onSelectProject: vi.fn(),
		onOpenSession: vi.fn(),
		onOpenSearchHit: vi.fn(),
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
	it("groups recent sessions by day, keeps pinned sessions separate, and preserves raw title information", async () => {
		vi.setSystemTime(new Date(2026, 9, 15, 12));
		const firstMessage =
			'<owl-myself-turn>{"date":"2026-10-15","intent":"plan","text":"复查周五日程"}</owl-myself-turn>\n\n内部日程边界';
		localStorage.setItem("owl.pinnedSessions", JSON.stringify(["pinned-chat"]));
		vi.mocked(props.client.request).mockResolvedValue({
			ok: true,
			result: [
				{ id: "today-chat", firstMessage, scope: "chat", modified: new Date(2026, 9, 15, 9).toISOString() },
				{
					id: "yesterday-chat",
					name: "手动命名保留",
					scope: "chat",
					modified: new Date(2026, 9, 14, 20).toISOString(),
				},
				{
					id: "older-chat",
					firstMessage: "D:/work/report.md",
					scope: "chat",
					modified: new Date(2026, 9, 12, 20).toISOString(),
				},
				{ id: "pinned-chat", name: "常用任务", scope: "chat", modified: new Date(2026, 9, 15, 10).toISOString() },
			],
		});
		await render();
		const recent = container.querySelector("#recent")!;
		expect(
			[...recent.querySelectorAll("[data-session-period]")].map((group) =>
				group.getAttribute("data-session-period"),
			),
		).toEqual(["today", "yesterday", "earlier"]);
		expect(recent.textContent).toContain("复查周五日程");
		expect(recent.textContent).toContain("report.md");
		expect(recent.textContent).not.toContain("owl-myself-turn");
		expect(recent.textContent).not.toContain("常用任务");
		expect(container.querySelector("#pinned")?.textContent).toContain("常用任务");
		const today = recent.querySelector<HTMLButtonElement>('[data-session-period="today"] .owl-sidebar-row-main')!;
		expect(today.title).toContain(firstMessage);
		expect(today.title).toContain("today-chat");
		await act(async () => today.click());
		expect(props.onOpenSession).toHaveBeenCalledExactlyOnceWith("today-chat");
		expect(props.client.request).toHaveBeenCalledTimes(1);
	});

	it("uses a compact default width while preserving a saved manual preference", async () => {
		await render();
		const width = Number.parseFloat(container.querySelector<HTMLElement>("#owl-session-sidebar")!.style.width);
		expect(width).toBeGreaterThanOrEqual(240);
		expect(width).toBeLessThanOrEqual(260);
		expect(localStorage.getItem("owl.sidebar.width")).toBeNull();
		await act(async () => root.unmount());
		localStorage.setItem("owl.sidebar.width", "480");
		root = createRoot(container);
		await render();
		expect(container.querySelector<HTMLElement>("#owl-session-sidebar")!.style.width).toBe("480px");
		expect(localStorage.getItem("owl.sidebar.width")).toBe("480");
	});

	it("uses an initially closed drawer in a narrow workspace without overwriting the saved width", async () => {
		Object.defineProperty(container, "clientWidth", { value: 600, configurable: true });
		localStorage.setItem("owl.sidebar.width", "480");
		await render();
		const aside = container.querySelector<HTMLElement>("#owl-session-sidebar")!;
		expect(aside.classList.contains("owl-sidebar--drawer")).toBe(true);
		expect(aside.hidden).toBe(true);
		expect(container.querySelector(".owl-sidebar-drawer-trigger")).not.toBeNull();
		expect(localStorage.getItem("owl.sidebar.width")).toBe("480");
	});

	it("searches in a dialog without replacing or expanding sidebar groups and closes after a cross-source hit", async () => {
		localStorage.setItem("owl.sidebar.collapsed", JSON.stringify(["projects"]));
		await render();
		expect(container.querySelector(".owl-sidebar-search-input")).toBeNull();
		const projectToggle = container.querySelector<HTMLButtonElement>("#projects .owl-sidebar-section-toggle")!;
		expect(projectToggle.getAttribute("aria-expanded")).toBe("false");
		expect(projectToggle.querySelector(".owl-sidebar-section-label")?.nextElementSibling?.tagName.toLowerCase()).toBe(
			"svg",
		);
		await act(async () => container.querySelector<HTMLButtonElement>(".owl-sidebar-search-trigger")!.click());
		const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')!;
		expect(dialog).not.toBeNull();
		expect(dialog.querySelector(".owl-session-search-panel")).toBeNull();
		await act(async () => vi.advanceTimersByTimeAsync(250));
		expect(props.client.request).toHaveBeenCalledTimes(1);
		await act(async () => {
			const input = dialog.querySelector<HTMLInputElement>(".owl-sidebar-search-input")!;
			input.value = "SQL";
			input.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		expect(projectToggle.getAttribute("aria-expanded")).toBe("false");
		await act(async () => vi.advanceTimersByTimeAsync(220));
		expect(dialog.textContent).toContain("后续报错 SQL");
		expect(container.textContent).toContain("普通会话");
		await act(async () => dialog.querySelector<HTMLButtonElement>(".owl-session-search-hit")!.click());
		expect(props.onOpenSearchHit).toHaveBeenCalledExactlyOnceWith(hit, "SQL");
		expect(props.onOpenSession).not.toHaveBeenCalled();
		expect(document.querySelector(".owl-session-search-dialog")).toBeNull();
		expect(projectToggle.getAttribute("aria-expanded")).toBe("false");
	});

	it("clears the query inside the dialog and closes with Escape or its backdrop", async () => {
		await render();
		const trigger = container.querySelector<HTMLButtonElement>(".owl-sidebar-search-trigger")!;
		await act(async () => trigger.click());
		await act(async () => {
			const input = document.querySelector<HTMLInputElement>(".owl-session-search-dialog-input")!;
			input.value = "SQL";
			input.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await act(async () => document.querySelector<HTMLButtonElement>(".owl-session-search-dialog-clear")!.click());
		expect(document.querySelector<HTMLInputElement>(".owl-session-search-dialog-input")!.value).toBe("");
		expect(document.querySelector(".owl-session-search-panel")).toBeNull();
		await act(async () =>
			document.dispatchEvent(
				Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" }),
			),
		);
		expect(document.querySelector(".owl-session-search-dialog")).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		await act(async () => trigger.click());
		await act(async () => document.querySelector<HTMLElement>(".owl-session-search-backdrop")!.click());
		expect(document.querySelector(".owl-session-search-dialog")).toBeNull();
	});

	it("selects a project from the dialog and closes it", async () => {
		await render();
		await act(async () => container.querySelector<HTMLButtonElement>(".owl-sidebar-search-trigger")!.click());
		await act(async () => {
			const input = document.querySelector<HTMLInputElement>(".owl-session-search-dialog-input")!;
			input.value = "alpha";
			input.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await act(async () => document.querySelector<HTMLButtonElement>(".owl-session-search-project-hit")!.click());
		expect(props.onSelectProject).toHaveBeenCalledExactlyOnceWith("D:/alpha");
		expect(document.querySelector(".owl-session-search-dialog")).toBeNull();
	});

	it("expands or collapses from the project name as well as the folder icon", async () => {
		await render();
		const group = container.querySelector<HTMLElement>('[data-project-path="d:/alpha"]')!;
		const toggle = group.querySelector<HTMLButtonElement>(".owl-sidebar-project-toggle")!;
		const name = group.querySelector<HTMLButtonElement>(".owl-sidebar-project-row .owl-sidebar-row-main")!;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(name.getAttribute("aria-expanded")).toBe("true");
		expect(toggle.dataset.icon).toBe("folder-open");
		expect(toggle.querySelector("svg")).not.toBeNull();
		expect(name.querySelector("svg")).toBeNull();
		await act(async () => name.click());
		expect(props.onSelectProject).toHaveBeenCalledExactlyOnceWith("D:/alpha");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(name.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.dataset.icon).toBe("folder");
		await act(async () => toggle.click());
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(props.onSelectProject).toHaveBeenCalledTimes(1);
	});

	it("opens a new chat after archiving the current session and shows an archive failure", async () => {
		await render();
		const actions = container.querySelector<HTMLButtonElement>('[aria-label="会话操作：普通会话"]')!;
		await act(async () => actions.click());
		const archive = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find(
			(button) => button.textContent === t("sidebar.archive"),
		)!;
		const request = vi.mocked(props.client.request);
		request.mockImplementation(async (value: { type: string }) =>
			value.type === "session.archive" ? { ok: false, error: "disk full" } : { ok: true, result: [] },
		);
		await act(async () => archive.click());
		expect(props.onNewChat).not.toHaveBeenCalled();
		expect(container.querySelector(".owl-sidebar-notice")?.textContent).toContain("disk full");
		request.mockImplementation(async (value: { type: string }) =>
			value.type === "session.archive" ? { ok: true, result: {} } : { ok: true, result: [] },
		);
		await act(async () => actions.click());
		const retry = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find(
			(button) => button.textContent === t("sidebar.archive"),
		)!;
		await act(async () => retry.click());
		expect(props.onNewChat).toHaveBeenCalledOnce();
	});

	it("preserves explicit new-chat controls for the selected project", async () => {
		await render();
		const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) => item.getAttribute("aria-label") === t("sidebar.newChatInProjectAria", { project: "alpha" }),
		)!;
		await act(async () => button.click());
		expect(props.onNewChatInProject).toHaveBeenCalledExactlyOnceWith("D:/alpha");
		expect(props.onSelectProject).not.toHaveBeenCalled();
	});
});
