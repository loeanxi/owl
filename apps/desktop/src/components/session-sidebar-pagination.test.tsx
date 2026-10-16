import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { SessionSidebar } from "./SessionSidebar.tsx";

type Props = React.ComponentProps<typeof SessionSidebar>;
type Session = {
	id: string;
	name: string;
	scope: "chat";
	created: string;
	modified: string;
	cwd?: string;
};

let host: HTMLElement;
let root: Root;
let props: Props;
let sessions: Session[];

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 9, 15, 12));
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
	vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 264, height: 800, top: 0, left: 0, right: 264, bottom: 800, toJSON: () => ({}) });
	dom.window.HTMLElement.prototype.scrollTo = () => {};
	dom.window.HTMLElement.prototype.scrollIntoView = () => {};
	host = dom.document.getElementById("root")!;
	Object.defineProperty(host, "clientWidth", { value: 1280, configurable: true });
	Object.defineProperty(host, "clientHeight", { value: 800 });
	root = createRoot(host);
	setUiLanguage("zh");
	sessions = [];
	const request = vi.fn(async (message: { type: string }) => message.type === "session.list"
		? { ok: true, result: sessions }
		: { ok: true, result: {} });
	props = {
		client: { request } as unknown as BridgeClient,
		sessionScope: "chat", connected: true, activeId: undefined, activeProject: "D:/owl",
		runningSessions: new Set(), refreshKey: "initial", revision: 0, focus: "chat", minimized: false,
		onToggleMinimized: vi.fn(), onNewChat: vi.fn(), onNewChatInProject: vi.fn(), onSelectProject: vi.fn(), onOpenSession: vi.fn(), onOpenSearchHit: vi.fn(),
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function rows(prefix: string, count: number, cwd?: string): Session[] {
	return Array.from({ length: count }, (_, index) => {
		const time = new Date(2026, 9, 15, 11, 59 - index).toISOString();
		return { id: `${prefix}-${index}`, name: `${prefix} 会话 ${index + 1}`, scope: "chat", created: time, modified: time, ...(cwd ? { cwd } : {}) };
	});
}

function datedRows(): Session[] {
	return rows("recent", 12).map((row, index) => {
		const day = index < 2 ? 15 : index < 6 ? 14 : 12;
		const time = new Date(2026, 9, day, 11, 59 - index).toISOString();
		return { ...row, created: time, modified: time };
	});
}

async function render(overrides: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<SessionSidebar {...props} />));
}

function section(id: "pinned" | "projects" | "recent"): HTMLElement {
	const node = host.querySelector<HTMLElement>(`#${id}`);
	expect(node, `${id} section`).not.toBeNull();
	return node!;
}

function visibleRows(scope: ParentNode): HTMLElement[] {
	return [...scope.querySelectorAll<HTMLElement>(".owl-sidebar-session-row")];
}

function project(path: string): HTMLElement {
	const group = section("projects").querySelector<HTMLElement>(`[data-project-path="${path}"]`);
	expect(group, `${path} project`).not.toBeNull();
	return group!;
}

function controls(key: string): HTMLElement {
	const node = host.querySelector<HTMLElement>(`.owl-sidebar-list-controls[data-sidebar-list="${key}"]`);
	expect(node, `${key} pagination controls`).not.toBeNull();
	return node!;
}

async function click(button: HTMLButtonElement): Promise<void> {
	await act(async () => button.click());
}

async function showMore(key: string, expectedNextCount: number): Promise<void> {
	const button = controls(key).querySelector<HTMLButtonElement>(".owl-sidebar-list-more");
	expect(button, `${key} show-more button`).not.toBeNull();
	expect(button!.textContent).toMatch(new RegExp(`再显示\\s*${expectedNextCount}\\s*条`));
	await click(button!);
}

async function collapse(key: string): Promise<void> {
	const button = controls(key).querySelector<HTMLButtonElement>(".owl-sidebar-list-collapse");
	expect(button, `${key} collapse button`).not.toBeNull();
	expect(button!.textContent).toContain("收起");
	await click(button!);
}

async function openProject(path: string): Promise<void> {
	const toggle = project(path).querySelector<HTMLButtonElement>(".owl-sidebar-project-toggle")!;
	if (toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
}

describe("sidebar lists revealed in batches", () => {
	it("shows twelve pins in batches of five, five and two, then returns to five without unpinning anything", async () => {
		sessions = rows("pin", 12);
		const pinnedIds = sessions.map((row) => row.id);
		localStorage.setItem("owl.pinnedSessions", JSON.stringify(pinnedIds));
		await render({ activeProject: "", activeId: "pin-11" });
		expect(visibleRows(section("pinned"))).toHaveLength(5);
		expect(controls("pinned").querySelector(".owl-sidebar-list-collapse")).toBeNull();
		await showMore("pinned", 5);
		expect(visibleRows(section("pinned"))).toHaveLength(10);
		await showMore("pinned", 2);
		expect(visibleRows(section("pinned"))).toHaveLength(12);
		expect(controls("pinned").querySelector(".owl-sidebar-list-more")).toBeNull();
		await collapse("pinned");
		expect(visibleRows(section("pinned"))).toHaveLength(5);
		expect(JSON.parse(localStorage.getItem("owl.pinnedSessions")!)).toEqual(pinnedIds);
		expect(visibleRows(section("recent"))).toHaveLength(0);
	});

	it("keeps each project's five-row limit independent while either project can expand to twelve and collapse", async () => {
		sessions = [...rows("owl", 12, "D:/owl"), ...rows("manager", 12, "D:/manager")];
		await render();
		await openProject("d:/manager");
		await openProject("d:/owl");
		expect(visibleRows(project("d:/owl"))).toHaveLength(5);
		expect(visibleRows(project("d:/manager"))).toHaveLength(5);
		await showMore("project:d:/owl", 5);
		expect(visibleRows(project("d:/owl"))).toHaveLength(10);
		expect(visibleRows(project("d:/manager"))).toHaveLength(5);
		await showMore("project:d:/manager", 5);
		expect(visibleRows(project("d:/manager"))).toHaveLength(10);
		await showMore("project:d:/owl", 2);
		expect(visibleRows(project("d:/owl"))).toHaveLength(12);
		expect(controls("project:d:/owl").querySelector(".owl-sidebar-list-more")).toBeNull();
		await collapse("project:d:/owl");
		expect(visibleRows(project("d:/owl"))).toHaveLength(5);
		expect(visibleRows(project("d:/manager"))).toHaveLength(10);
		await showMore("project:d:/manager", 2);
		expect(visibleRows(project("d:/manager"))).toHaveLength(12);
		await collapse("project:d:/manager");
		expect(visibleRows(project("d:/manager"))).toHaveLength(5);
	});

	it("keeps the default current project expanded when another project is opened for the first time", async () => {
		sessions = [...rows("owl", 12, "D:/owl"), ...rows("manager", 12, "D:/manager")];
		await render();
		expect(project("d:/owl").querySelector(".owl-sidebar-project-toggle")?.getAttribute("aria-expanded")).toBe("true");
		expect(visibleRows(project("d:/owl"))).toHaveLength(5);
		expect(project("d:/manager").querySelector(".owl-sidebar-project-toggle")?.getAttribute("aria-expanded")).toBe("false");
		await openProject("d:/manager");
		expect(project("d:/owl").querySelector(".owl-sidebar-project-toggle")?.getAttribute("aria-expanded")).toBe("true");
		expect(visibleRows(project("d:/owl"))).toHaveLength(5);
		expect(project("d:/manager").querySelector(".owl-sidebar-project-toggle")?.getAttribute("aria-expanded")).toBe("true");
		expect(visibleRows(project("d:/manager"))).toHaveLength(5);
	});

	it("limits the recent list to five sessions in total before inserting date headings", async () => {
		sessions = datedRows();
		await render({ activeProject: "", activeId: "recent-11" });
		const recent = section("recent");
		expect(visibleRows(recent)).toHaveLength(5);
		expect(recent.querySelectorAll('[data-session-period="today"] .owl-sidebar-session-row')).toHaveLength(2);
		expect(recent.querySelectorAll('[data-session-period="yesterday"] .owl-sidebar-session-row')).toHaveLength(3);
		expect(recent.querySelector('[data-session-period="earlier"]')).toBeNull();
		await showMore("recent", 5);
		expect(visibleRows(recent)).toHaveLength(10);
		expect(recent.querySelectorAll('[data-session-period="earlier"] .owl-sidebar-session-row')).toHaveLength(4);
		await showMore("recent", 2);
		expect(visibleRows(recent)).toHaveLength(12);
		expect(controls("recent").querySelector(".owl-sidebar-list-more")).toBeNull();
		await collapse("recent");
		expect(visibleRows(recent)).toHaveLength(5);
	});

	it("also limits project-grouped recent sessions globally rather than revealing five in each project", async () => {
		sessions = datedRows().map((row, index) => ({ ...row, cwd: index % 2 === 0 ? "D:/owl" : "D:/manager" }));
		localStorage.setItem("owl.chat.projectSidebar", JSON.stringify({ recentView: "projects", readInitialized: true }));
		await render();
		const recent = section("recent");
		expect(visibleRows(recent)).toHaveLength(5);
		expect(recent.querySelectorAll('[data-recent-project="d:/owl"] .owl-sidebar-session-row')).toHaveLength(3);
		expect(recent.querySelectorAll('[data-recent-project="d:/manager"] .owl-sidebar-session-row')).toHaveLength(2);
		await showMore("recent", 5);
		expect(visibleRows(recent)).toHaveLength(10);
		await showMore("recent", 2);
		expect(visibleRows(recent)).toHaveLength(12);
		await collapse("recent");
		expect(visibleRows(recent)).toHaveLength(5);
	});

	it("can reveal all thirty-two recent sessions instead of stopping at the former thirty-row limit", async () => {
		sessions = rows("recent", 32);
		await render({ activeProject: "" });
		const recent = section("recent");
		expect(visibleRows(recent)).toHaveLength(5);
		for (let expected = 10; expected <= 30; expected += 5) {
			await showMore("recent", 5);
			expect(visibleRows(recent)).toHaveLength(expected);
		}
		await showMore("recent", 2);
		expect(visibleRows(recent)).toHaveLength(32);
		expect(recent.textContent).toContain("recent 会话 32");
		expect(controls("recent").querySelector(".owl-sidebar-list-more")).toBeNull();
		await collapse("recent");
		expect(visibleRows(recent)).toHaveLength(5);
	});

	it("reveals projects five at a time while the current project stays visible outside the window", async () => {
		sessions = Array.from({ length: 9 }, (_, index) => {
			const time = new Date(2026, 9, 15, 11, 59 - index).toISOString();
			return { id: `p${index}`, name: `项目会话 ${index}`, scope: "chat" as const, created: time, modified: time, cwd: `D:/p${index}` };
		});
		await render({ activeProject: "D:/p8" });
		const groups = (): string[] => [...section("projects").querySelectorAll<HTMLElement>(".owl-sidebar-project-group")].map((node) => node.dataset.projectPath!);
		expect(groups()).toEqual(["d:/p0", "d:/p1", "d:/p2", "d:/p3", "d:/p4", "d:/p8"]);
		const more = controls("projects:merged-default").querySelector<HTMLButtonElement>(".owl-sidebar-list-more")!;
		expect(more.textContent).toMatch(/再显示\s*3\s*个项目/);
		await click(more);
		expect(groups()).toEqual(Array.from({ length: 9 }, (_, index) => `d:/p${index}`));
		await collapse("projects:merged-default");
		expect(groups()).toHaveLength(6);
	});

	it("omits pagination controls for lists containing five or fewer sessions", async () => {
		const pins = rows("pin", 3);
		sessions = [...pins, ...rows("owl", 5, "D:/owl")];
		localStorage.setItem("owl.pinnedSessions", JSON.stringify(pins.map((row) => row.id)));
		await render();
		expect(visibleRows(section("pinned"))).toHaveLength(3);
		expect(visibleRows(project("d:/owl"))).toHaveLength(5);
		expect(visibleRows(section("recent"))).toHaveLength(5);
		expect(host.querySelector(".owl-sidebar-list-controls")).toBeNull();
	});

	it("preserves expanded quotas when a background history refresh returns new sessions", async () => {
		const pins = rows("pin", 12);
		sessions = [...pins, ...rows("owl", 12, "D:/owl")];
		localStorage.setItem("owl.pinnedSessions", JSON.stringify(pins.map((row) => row.id)));
		await render();
		await showMore("pinned", 5);
		await showMore("project:d:/owl", 5);
		await showMore("recent", 5);
		const newer: Session = { id: "owl-new", name: "新到的后台会话", scope: "chat", cwd: "D:/owl", created: new Date(2026, 9, 15, 12).toISOString(), modified: new Date(2026, 9, 15, 12).toISOString() };
		sessions = [newer, ...sessions];
		await render({ refreshKey: "background-update" });
		expect(visibleRows(section("pinned"))).toHaveLength(10);
		expect(visibleRows(project("d:/owl"))).toHaveLength(10);
		expect(visibleRows(section("recent"))).toHaveLength(10);
		expect(project("d:/owl").textContent).toContain("新到的后台会话");
		expect(section("recent").textContent).toContain("新到的后台会话");
		expect(vi.mocked(props.client.request).mock.calls.filter(([request]) => request.type === "session.list")).toHaveLength(2);
	});

	it("preserves all hidden project sessions when a visible row is dragged to another visible position", async () => {
		sessions = rows("owl", 12, "D:/owl");
		await render();
		const group = project("d:/owl");
		const visible = visibleRows(group);
		expect(visible).toHaveLength(5);
		for (const [index, row] of visible.entries()) {
			row.getBoundingClientRect = () => ({ x: 0, y: index * 32, width: 240, height: 32, top: index * 32, left: 0, right: 240, bottom: (index + 1) * 32, toJSON: () => ({}) });
		}
		const payload = new Map<string, string>();
		const transfer = { effectAllowed: "", dropEffect: "", setData: (format: string, value: string) => payload.set(format, value), getData: (format: string) => payload.get(format) ?? "" };
		const drag = (type: string): Event => Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), { dataTransfer: transfer, clientY: 90 });
		await act(async () => visible[0]!.dispatchEvent(drag("dragstart")));
		expect(transfer.getData("text/plain")).toBe("owl-0");
		const dropZone = group.querySelector<HTMLElement>(".owl-sidebar-project-sessions")!;
		await act(async () => dropZone.dispatchEvent(drag("dragover")));
		await act(async () => dropZone.dispatchEvent(drag("drop")));
		const saved = JSON.parse(localStorage.getItem("owl.sidebar.sessionOrder") ?? "{}");
		expect(saved).toEqual({ "d:/owl": ["owl-1", "owl-2", "owl-0", ...Array.from({ length: 9 }, (_, index) => `owl-${index + 3}`)] });
		expect(visibleRows(project("d:/owl"))).toHaveLength(5);
		await showMore("project:d:/owl", 5);
		await showMore("project:d:/owl", 2);
		expect(visibleRows(project("d:/owl"))).toHaveLength(12);
	});
});
