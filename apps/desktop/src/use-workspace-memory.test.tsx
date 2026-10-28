import { parseHTML } from "linkedom";
import * as React from "react";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceMemory } from "./use-workspace-memory.ts";
import {
	defaultWorkspaceMemory,
	readWorkspaceMemory,
	type WorkspaceMemory,
	workspaceScrollKey,
	writeWorkspaceMemory,
} from "./workspace-memory.ts";

type HookOptions = Parameters<typeof useWorkspaceMemory>[0];
type Place = HookOptions["place"];
interface HarnessOptions extends HookOptions {
	height?: number;
	earlySearchTop?: number;
}

let container: HTMLElement;
let root: Root;
let values: Map<string, string>;
let frames: Map<number, FrameRequestCallback>;
let frameSequence: number;
let resizeCallbacks: ResizeObserverCallback[];
let options: HarnessOptions;
const profileOne = "D:/owl/profiles/one";
const profileTwo = "D:/owl/profiles/two";

function place(session: string, workspace = `D:/project-${session}`, rail: "chat" | "research" = "chat"): Place {
	const { version: _version, savedAt: _savedAt, scroll: _scroll, ...base } = defaultWorkspaceMemory();
	return { ...base, rail, chatSession: session, workspace, researchSession: session, researchWorkspace: workspace };
}

function Harness(props: HarnessOptions): React.JSX.Element {
	useWorkspaceMemory(props);
	const surface = useRef<HTMLElement>(null);
	const token = JSON.stringify([
		props.profile,
		props.place.rail,
		props.place.chatSession,
		props.place.researchSession,
		props.place.workspace,
	]);
	useLayoutEffect(() => {
		const element = surface.current!;
		element.scrollTop = 0;
		element.scrollLeft = 0;
		element.setAttribute("data-owl-scroll-restoring", "true");
		if (props.earlySearchTop !== undefined) {
			element.dataset.owlSearchNavigation = "early-search";
			element.scrollTop = props.earlySearchTop;
			element.dispatchEvent(new Event("owl-chat-search-navigation", { bubbles: true }));
			element.removeAttribute("data-owl-scroll-restoring");
		}
	}, [token]);
	useLayoutEffect(() => {
		Object.defineProperties(surface.current!, {
			clientWidth: { configurable: true, value: 800 },
			clientHeight: { configurable: true, value: 400 },
			scrollHeight: { configurable: true, value: props.height ?? 2400 },
		});
	}, [token, props.height]);
	return (
		<div className="owl-workspace-frame">
			<main key={token} ref={surface} className="owl-chat-scroll">
				<div>conversation content</div>
			</main>
		</div>
	);
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	values = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
	frames = new Map();
	frameSequence = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = ++frameSequence;
		frames.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	resizeCallbacks = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				resizeCallbacks.push(callback);
			}
			observe(): void {}
			disconnect(): void {}
		},
	);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.setSystemTime(10_000);
	container = document.getElementById("root")!;
	root = createRoot(container);
	options = {
		profile: profileOne,
		connected: true,
		place: place("a"),
		restore: vi.fn(async () => undefined),
		cancelRestore: vi.fn(),
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(patch: Partial<HarnessOptions> = {}): Promise<void> {
	options = { ...options, ...patch };
	await act(async () => root.render(<Harness {...options} />));
}

function surface(): HTMLElement {
	return container.querySelector<HTMLElement>(".owl-chat-scroll")!;
}

async function drainFrames(): Promise<void> {
	let count = 0;
	while (frames.size > 0) {
		if (count++ > 8) throw new Error("Scroll restoration kept scheduling itself after DOM settled");
		await act(async () => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(0);
		});
	}
}

async function userScroll(top: number): Promise<void> {
	surface().scrollTop = top;
	// linkedom does not propagate capture-only non-bubbling events like a browser.
	await act(async () => surface().dispatchEvent(new Event("scroll", { bubbles: true })));
}

function seed(profile: string, target: Place, top: number, atBottom = false): void {
	writeWorkspaceMemory(localStorage, profile, {
		...target,
		version: 1,
		savedAt: 5000,
		scroll: { [workspaceScrollKey(target, "chat")]: { top, left: 0, atBottom } },
	});
}

function savedPosition(profile: string, target: Place): number | undefined {
	return readWorkspaceMemory(localStorage, profile)?.scroll[workspaceScrollKey(target, "chat")]?.top;
}

describe("workspace reading positions", () => {
	it("restores A after visiting B, including a scroll that has not reached the debounce timer", async () => {
		await render();
		await drainFrames();
		expect(surface().scrollTop).toBe(2000);
		await userScroll(680);
		await render({ place: place("b") });
		await drainFrames();
		expect(surface().scrollTop).toBe(2000);
		await userScroll(430);
		await render({ place: place("a") });
		await drainFrames();
		expect(surface().scrollTop).toBe(680);
		expect(savedPosition(profileOne, place("a"))).toBe(680);
		expect(savedPosition(profileOne, place("b"))).toBe(430);
		expect(surface().hasAttribute("data-owl-scroll-restoring")).toBe(false);
	});

	it("starts at the latest message when no reading position was saved", async () => {
		await render();
		const scroll = vi.fn();
		surface().addEventListener("scroll", scroll);
		await drainFrames();
		expect(surface().scrollTop).toBe(2000);
		expect(scroll).toHaveBeenCalledOnce();
		expect(surface().hasAttribute("data-owl-scroll-restoring")).toBe(false);
	});

	it("waits for enough historical content and retries when layout height grows without a DOM mutation", async () => {
		seed(profileOne, place("a"), 1200);
		await render({ height: 600 });
		await drainFrames();
		expect(surface().scrollTop).toBe(0);
		expect(surface().dataset.owlScrollRestoring).toBe("true");
		await render({ height: 2400 });
		await act(async () => {
			for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
		});
		await drainFrames();
		expect(surface().scrollTop).toBe(1200);
		expect(surface().hasAttribute("data-owl-scroll-restoring")).toBe(false);
	});

	it("clears the pending marker and clamps a position after the restoration grace period", async () => {
		seed(profileOne, place("a"), 1900);
		await render({ height: 600 });
		await drainFrames();
		await act(async () => vi.advanceTimersByTime(3100));
		await drainFrames();
		expect(surface().scrollTop).toBe(200);
		expect(surface().hasAttribute("data-owl-scroll-restoring")).toBe(false);
	});

	it("keeps ordinary and research positions isolated for the same session and project", async () => {
		await render();
		await drainFrames();
		await userScroll(540);
		await render({ place: place("a", "D:/project-a", "research") });
		await drainFrames();
		await userScroll(960);
		await render({ place: place("a") });
		await drainFrames();
		expect(surface().scrollTop).toBe(540);
		await render({ place: place("a", "D:/project-a", "research") });
		await drainFrames();
		expect(surface().scrollTop).toBe(960);
	});

	it("clears a newly added pending marker on an already restored surface without moving it", async () => {
		await render();
		await drainFrames();
		await userScroll(540);
		await act(async () => surface().setAttribute("data-owl-scroll-restoring", "true"));
		await drainFrames();
		expect(surface().scrollTop).toBe(540);
		expect(surface().hasAttribute("data-owl-scroll-restoring")).toBe(false);
	});

	it("keeps the user's own scroll while an older reading position is still waiting for content", async () => {
		seed(profileOne, place("a"), 1600);
		await render({ height: 600 });
		await drainFrames();
		await act(async () => surface().dispatchEvent(new Event("wheel", { bubbles: true })));
		await userScroll(100);
		await render({ height: 2400 });
		await act(async () => {
			for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
		});
		await drainFrames();
		expect(surface().scrollTop).toBe(100);
		expect(surface().hasAttribute("data-owl-scroll-restoring")).toBe(false);
	});

	it("does not cancel the chat's pending restoration when the user scrolls another surface", async () => {
		seed(profileOne, place("a"), 1600);
		await render({ height: 600 });
		await drainFrames();
		const sidebar = document.createElement("aside");
		sidebar.className = "owl-sidebar-list";
		Object.defineProperties(sidebar, {
			clientWidth: { value: 200 },
			clientHeight: { value: 400 },
			scrollHeight: { value: 1200 },
		});
		await act(async () => {
			container.querySelector(".owl-workspace-frame")?.append(sidebar);
			sidebar.dispatchEvent(new Event("wheel", { bubbles: true }));
		});
		await drainFrames();
		expect(surface().dataset.owlScrollRestoring).toBe("true");
		await render({ height: 2400 });
		await act(async () => {
			for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
		});
		await drainFrames();
		expect(surface().scrollTop).toBe(1600);
	});
});

describe("sidebar scroll memory", () => {
	it("keys the sidebar surface per workspace, not per session, so switching sessions keeps the list in place", () => {
		const base = place("a");
		const switched = place("b", base.workspace);
		// 侧栏是导航面板：换会话不能按“那个会话记住的侧栏位置”重置列表（点击会话会把侧栏跳回顶部/过期位置）。
		expect(workspaceScrollKey(switched, "sidebar")).toBe(workspaceScrollKey(base, "sidebar"));
		// 会话内容面板的键仍按会话区分（各自的阅读位置互不覆盖）。
		expect(workspaceScrollKey(switched, "chat")).not.toBe(workspaceScrollKey(base, "chat"));
	});

	it("does not move the sidebar list when the chat session changes", async () => {
		seed(profileOne, place("a"), 1600);
		await render({ place: place("a") });
		await drainFrames();
		const sidebar = document.createElement("aside");
		sidebar.className = "owl-sidebar-list";
		Object.defineProperties(sidebar, {
			clientWidth: { value: 200 },
			clientHeight: { value: 400 },
			scrollHeight: { value: 1200 },
		});
		await act(async () => {
			container.querySelector(".owl-workspace-frame")?.append(sidebar);
			sidebar.scrollTop = 500;
			sidebar.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		await drainFrames();
		await act(async () => vi.advanceTimersByTime(200));
		await render({ place: place("b", place("a").workspace) });
		await drainFrames();
		await act(async () => {
			for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
		});
		await drainFrames();
		expect(sidebar.scrollTop).toBe(500);
	});
});

describe("search navigation priority", () => {
	it("uses a search attribute set before event listeners mount and immediately persists the new location", async () => {
		seed(profileOne, place("a"), 900);
		await render({ earlySearchTop: 350 });
		await drainFrames();
		expect(surface().scrollTop).toBe(350);
		expect(savedPosition(profileOne, place("a"))).toBe(350);
		await act(async () => {
			surface().firstElementChild?.append(document.createElement("p"));
		});
		await drainFrames();
		expect(surface().scrollTop).toBe(350);
	});

	it("lets an explicit search cancel a pending old position and ignores subsequent content growth", async () => {
		seed(profileOne, place("a"), 1600);
		await render({ height: 600 });
		await drainFrames();
		await act(async () => {
			surface().dataset.owlSearchNavigation = "search-one";
			surface().dispatchEvent(new Event("owl-chat-search-navigation", { bubbles: true }));
			surface().scrollTop = 150;
			surface().dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		await render({ height: 2400 });
		await act(async () => {
			surface().firstElementChild?.append(document.createElement("p"));
		});
		await drainFrames();
		await act(async () => vi.advanceTimersByTime(3100));
		await drainFrames();
		expect(surface().scrollTop).toBe(150);
		expect(savedPosition(profileOne, place("a"))).toBe(150);
		expect(surface().hasAttribute("data-owl-scroll-restoring")).toBe(false);
	});
});

describe("profile restoration boundaries", () => {
	it("restores each profile's position without overwriting the previous profile's last page", async () => {
		seed(profileOne, place("a"), 600);
		seed(profileTwo, place("b"), 900);
		await render();
		await drainFrames();
		expect(surface().scrollTop).toBe(600);
		await render({ profile: profileTwo, place: place("b") });
		await drainFrames();
		expect(surface().scrollTop).toBe(900);
		expect(readWorkspaceMemory(localStorage, profileOne)?.chatSession).toBe("a");
		expect(savedPosition(profileOne, place("a"))).toBe(600);
		expect(savedPosition(profileOne, place("b"))).toBeUndefined();
		await render({ profile: profileOne, place: place("a") });
		await drainFrames();
		expect(surface().scrollTop).toBe(600);
		expect(readWorkspaceMemory(localStorage, profileTwo)?.chatSession).toBe("b");
	});

	it("rejects a delayed restoration from an earlier profile", async () => {
		seed(profileOne, place("a"), 600);
		seed(profileTwo, place("b"), 900);
		const one = Promise.withResolvers<void>();
		const two = Promise.withResolvers<void>();
		const restore = vi
			.fn()
			.mockImplementationOnce(() => one.promise)
			.mockImplementationOnce(() => two.promise);
		await render({ restore });
		await render({ profile: profileTwo, place: place("b") });
		await act(async () => two.resolve());
		await drainFrames();
		expect(surface().scrollTop).toBe(900);
		await act(async () => one.resolve());
		await drainFrames();
		expect(surface().scrollTop).toBe(900);
		expect(restore.mock.calls[0]?.[1]()).toBe(false);
		expect(savedPosition(profileOne, place("a"))).toBe(600);
	});

	it("preserves saved positions when user navigation cancels an in-flight startup restore", async () => {
		seed(profileOne, place("a"), 620);
		const pending = Promise.withResolvers<void>();
		await render({ restore: async () => pending.promise });
		await act(async () => document.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		await render({ place: place("b") });
		await drainFrames();
		expect(options.cancelRestore).toHaveBeenCalledOnce();
		await render({ place: place("a") });
		await drainFrames();
		expect(surface().scrollTop).toBe(620);
		await act(async () => pending.resolve());
		await drainFrames();
		expect(surface().scrollTop).toBe(620);
	});
});
