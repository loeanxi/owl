import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { ChatStream } from "./ChatStream.tsx";
import { highlightMessageMatches, messageElement, messageMatchRanges } from "./chat-message-navigation.ts";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

class TextRange {
	startContainer?: Node;
	startOffset = 0;
	endContainer?: Node;
	endOffset = 0;
	setStart(node: Node, offset: number): void { this.startContainer = node; this.startOffset = offset; }
	setEnd(node: Node, offset: number): void { this.endContainer = node; this.endOffset = offset; }
	toString(): string {
		if (this.startContainer === this.endContainer) return this.startContainer?.textContent?.slice(this.startOffset, this.endOffset) ?? "";
		const parts: string[] = [];
		let node = this.startContainer;
		while (node) {
			if (node === this.endContainer) { parts.push(node.textContent?.slice(0, this.endOffset) ?? ""); break; }
			parts.push(node.textContent?.slice(node === this.startContainer ? this.startOffset : 0) ?? "");
			node = node.nextSibling ?? undefined;
		}
		return parts.join("");
	}
}

let container: HTMLElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let frameSequence: number;
let highlights: Map<string, Set<Range>>;
let resizeCallbacks: ResizeObserverCallback[];
type Props = React.ComponentProps<typeof ChatStream>;
let props: Props;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
	vi.spyOn(document, "createRange").mockImplementation(() => new TextRange() as unknown as Range);
	frames = new Map();
	frameSequence = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++frameSequence; frames.set(id, callback); return id; });
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	highlights = new Map();
	vi.stubGlobal("CSS", { highlights });
	vi.stubGlobal("Highlight", class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } });
	resizeCallbacks = [];
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
		observe(): void {}
		disconnect(): void {}
	});
	container = document.getElementById("root")!;
	root = createRoot(container);
	props = { entries: [], sessionId: "session-one", profile: "D:/profile-one", cwd: "D:/project-one" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const user = (id: string, text: string): ChatEntry => ({ kind: "user", entryId: id, text });
const assistant = (id: string, text: string): ChatEntry => ({ kind: "assistant", entryId: id, text, thinking: "", tools: [] });

async function render(overrides: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<ChatStream {...props} />));
}

async function flushFrames(): Promise<void> {
	await act(async () => {
		const pending = [...frames.values()];
		frames.clear();
		for (const callback of pending) callback(0);
	});
}

function scrollSurface(): HTMLElement & { scrollTo: ReturnType<typeof vi.fn> } {
	const surface = container.querySelector<HTMLElement>(".owl-chat-scroll")!;
	Object.defineProperties(surface, {
		clientHeight: { configurable: true, value: 400 },
		clientWidth: { configurable: true, value: 800 },
		scrollHeight: { configurable: true, value: 2400 },
	});
	surface.scrollTop ||= 0;
	surface.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
	const scrollTo = vi.fn((options: ScrollToOptions) => { surface.scrollTop = options.top ?? 0; });
	surface.scrollTo = scrollTo;
	return surface as typeof surface & { scrollTo: typeof scrollTo };
}

async function workspaceRestored(surface: HTMLElement, top: number): Promise<void> {
	surface.scrollTop = top;
	surface.removeAttribute("data-owl-scroll-restoring");
	await act(async () => surface.dispatchEvent(new Event("scroll")));
}

describe("message search navigation", () => {
	it("uses the exact persisted entry ID when the same words appear in other turns", async () => {
		await render({ entries: [user("question-1", "timeout"), assistant("answer-1", "timeout in first turn"), user("question-2", "later"), assistant("answer-2", "timeout in second turn")], searchTarget: { sessionId: "session-one", entryId: "answer-1", query: "timeout", requestId: 1 } });
		const surface = scrollSurface();
		messageElement(surface, "answer-1", "timeout")!.getBoundingClientRect = () => ({ top: 320 } as DOMRect);
		const navigation = vi.fn();
		surface.addEventListener("owl-chat-search-navigation", navigation);
		await flushFrames();
		expect(surface.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 304, behavior: "instant" });
		expect(container.querySelector('[data-search-match="true"]')?.dataset.entryId).toBe("answer-1");
		expect(surface.hasAttribute("data-owl-scroll-restoring")).toBe(false);
		expect(surface.dataset.owlSearchNavigation).toBe("1");
		expect(navigation).toHaveBeenCalledOnce();
		expect([...highlights.get("owl-message-search")!].map(String)).toEqual(["timeout"]);
	});

	it("locates an already visible intermediate assistant message without hiding its progress", async () => {
		const entries = [user("question", "run"), assistant("note", "intermediate ERR_CONFLICT detail"), assistant("answer", "final result")];
		await render({ entries });
		expect(container.textContent).toContain("intermediate ERR_CONFLICT detail");
		await render({ searchTarget: { sessionId: "session-one", entryId: "note", query: "ERR_CONFLICT", requestId: 2 } });
		const surface = scrollSurface();
		const note = messageElement(surface, "note", "ERR_CONFLICT")!;
		expect(note).toBeDefined();
		note.getBoundingClientRect = () => ({ top: 180 } as DOMRect);
		await flushFrames();
		expect(surface.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 164, behavior: "instant" });
		// 说明并进了本轮的工作过程折叠块，所以折叠行存在；但这一轮没有工具，只有进展本身。
		expect(container.querySelector(".owl-work-process-summary")).not.toBeNull();
		expect(container.querySelectorAll(".owl-tool-row")).toHaveLength(0);
		expect(container.querySelector('[data-search-match="true"]')?.dataset.entryId).toBe("note");
	});

	it("keeps unrelated tool records folded without an explicit message search", async () => {
		await render({ entries: [user("question", "run"), { kind: "assistant", entryId: "tool-owner", text: "", thinking: "private work", tools: [{ id: "tool", name: "read", summary: "tool summary", args: "{}", detail: "tool detail", status: "ok" }] }, assistant("answer", "done")] });
		expect(container.querySelector(".owl-work-process-summary")?.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("tool summary");
		expect(container.textContent).not.toContain("private work");
	});

	it("does not locate a hit from a different session or guess another matching message", async () => {
		await render({ entries: [user("other", "same words")], searchTarget: { sessionId: "session-two", entryId: "other", query: "same", requestId: 3 } });
		const surface = scrollSurface();
		await flushFrames();
		expect(surface.scrollTo).not.toHaveBeenCalled();
		await render({ searchTarget: { sessionId: "session-one", entryId: "missing-id", query: "same", requestId: 4 } });
		await flushFrames();
		expect(surface.scrollTo).not.toHaveBeenCalled();
		expect(container.querySelector('[data-search-match="true"]')).toBeNull();
	});

	it("waits for the exact message to arrive and does not repeat navigation on streaming updates", async () => {
		const initial = [user("question", "first question")];
		await render({ entries: initial, searchTarget: { sessionId: "session-one", entryId: "historical", query: "SQL", requestId: 5 } });
		const surface = scrollSurface();
		await flushFrames();
		expect(surface.scrollTo).not.toHaveBeenCalled();
		const loaded = [...initial, assistant("historical", "historical SQL result"), user("latest-question", "new task"), assistant("live", "working")];
		await render({ entries: loaded, activity: "working" });
		messageElement(surface, "historical", "SQL")!.getBoundingClientRect = () => ({ top: 260 } as DOMRect);
		await flushFrames();
		expect(surface.scrollTop).toBe(244);
		await render({ entries: [...loaded.slice(0, -1), assistant("live", "working on additional content")] });
		await flushFrames();
		await act(async () => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
		expect(surface.scrollTo).toHaveBeenCalledOnce();
		expect(surface.scrollTop).toBe(244);
	});

	it("lets an explicit new search request override the prior reading position", async () => {
		await render({ entries: [user("question", "run"), assistant("answer", "cache miss")] });
		const surface = scrollSurface();
		await workspaceRestored(surface, 850);
		await render({ searchTarget: { sessionId: "session-one", entryId: "answer", query: "cache", requestId: 6 } });
		messageElement(surface, "answer", "cache")!.getBoundingClientRect = () => ({ top: 250 } as DOMRect);
		await flushFrames();
		expect(surface.scrollTop).toBe(1084);
		await render({ searchTarget: { sessionId: "session-one", entryId: "question", query: "run", requestId: 7 } });
		messageElement(surface, "question", "run")!.getBoundingClientRect = () => ({ top: -900 } as DOMRect);
		await flushFrames();
		expect(surface.scrollTop).toBe(168);
		expect(surface.scrollTo).toHaveBeenCalledTimes(2);
	});
});

describe("reading position ownership", () => {
	it("keeps an asynchronously growing home page at the top without a latest button, then follows the first real message", async () => {
		await render({ sessionId: undefined, entries: [] });
		const surface = scrollSurface();
		expect(surface.scrollTop).toBe(0);
		await act(async () => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
		expect(surface.scrollTop).toBe(0);
		await render({ recentSessions: [{ id: "recent", title: "最近任务" }] });
		Object.defineProperty(surface, "scrollHeight", { configurable: true, value: 3000 });
		await act(async () => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
		expect(surface.scrollTop).toBe(0);
		surface.scrollTop = 80;
		await act(async () => surface.dispatchEvent(new Event("scroll")));
		expect(container.querySelector(".owl-chat-latest")).toBeNull();
		expect(surface.dataset.owlSearchNavigation).toBe("start");
		await render({ entries: [user("first-question", "开始检查项目")] });
		expect(surface.scrollTop).toBe(surface.scrollHeight - surface.clientHeight);
		expect(surface.hasAttribute("data-owl-search-navigation")).toBe(false);
	});

	it("opens the latest turn's delivery from a completion request and does not repeat on later updates", async () => {
		const criteria = [{ criterion: "已生成结果文件", status: "verified", toolCallId: "write-result" }];
		const answer: ChatEntry = { ...assistant("answer", "已交付"), tools: [
			{ id: "write-result", name: "write", args: JSON.stringify({ path: "result.md" }), summary: "生成结果", status: "ok", output: { text: "written", totalLines: 1 } },
			{ id: "registered-check", name: "task_check", args: JSON.stringify({ goal: "生成结果", criteria }), summary: "登记验收清单", status: "ok", output: { text: JSON.stringify({ goal: "生成结果", criteria }), totalLines: 1 } },
		] };
		await render({ entries: [user("latest-question", "生成结果"), answer], onOpenFile: () => {}, deliveryRequest: 10 });
		const surface = scrollSurface();
		container.querySelector<HTMLElement>(".owl-delivery-summary")!.getBoundingClientRect = () => ({ top: 520 } as DOMRect);
		await flushFrames();
		expect(surface.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 504, behavior: "instant" });
		expect(surface.dataset.owlSearchNavigation).toBe("delivery-10");
		await render({ entries: [user("latest-question", "生成结果"), { ...answer, text: "结果仍保留" }] });
		await flushFrames();
		expect(surface.scrollTo).toHaveBeenCalledOnce();
	});

	it("waits for task settlement before following a completion request", async () => {
		await render({ entries: [user("latest-question", "检查结果"), assistant("answer", "仍在处理")], activity: "working", deliveryRequest: 11 });
		const surface = scrollSurface();
		await flushFrames();
		expect(surface.scrollTo).not.toHaveBeenCalled();
		await render({ activity: "idle" });
		await flushFrames();
		expect(surface.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 2000, behavior: "instant" });
	});
	it("does not snap loaded history to the bottom while workspace restoration is pending", async () => {
		await render({ entries: [user("question", "run"), assistant("answer", "history")] });
		const surface = scrollSurface();
		surface.scrollTop = 340;
		await render({ entries: [user("question", "run"), assistant("answer", "history restored")] });
		await act(async () => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
		expect(surface.scrollTop).toBe(340);
		expect(surface.dataset.owlScrollRestoring).toBe("true");
	});

	it("follows a newly sent message even while scroll restoration is still pending", async () => {
		await render({ entries: [user("question", "run"), assistant("answer", "history")] });
		const surface = scrollSurface();
		surface.scrollTop = 340;
		expect(surface.dataset.owlScrollRestoring).toBe("true");
		await render({ entries: [user("question", "run"), assistant("answer", "history"), user("next", "继续")] });
		expect(surface.hasAttribute("data-owl-scroll-restoring")).toBe(false);
		expect(surface.scrollTop).toBe(surface.scrollHeight - surface.clientHeight);
	});

	it("preserves a restored historical position through replay and new assistant content", async () => {
		await render({ entries: [user("question", "run")] });
		const surface = scrollSurface();
		await workspaceRestored(surface, 520);
		await render({ entries: [user("question", "run")] });
		expect(surface.scrollTop).toBe(520);
		await render({ entries: [user("question", "run"), assistant("answer", "streaming reply")], activity: "working" });
		await act(async () => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
		expect(surface.scrollTop).toBe(520);
		expect(container.querySelector(".owl-chat-latest")).not.toBeNull();
	});

	it("keeps the latest button hidden while followed output grows, and steady while reading earlier content", async () => {
		await render({ entries: [user("question", "run")], activity: "working" });
		const surface = scrollSurface();
		await workspaceRestored(surface, 2000);
		expect(container.querySelector(".owl-chat-latest")).toBeNull();
		for (const height of [2800, 3200]) {
			Object.defineProperty(surface, "scrollHeight", { configurable: true, value: height });
			await act(async () => {
				surface.dispatchEvent(new Event("scroll"));
				for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
			});
			expect(surface.scrollTop).toBe(height - surface.clientHeight);
			expect(container.querySelector(".owl-chat-latest")).toBeNull();
		}
		surface.scrollTop = 520;
		Object.defineProperty(surface, "scrollHeight", { configurable: true, value: 3200 });
		await act(async () => surface.dispatchEvent(new Event("scroll")));
		expect(surface.scrollTop).toBe(520);
		expect(container.querySelector(".owl-chat-latest")?.textContent).toContain("有新进展");
		for (const height of [3600, 4000]) {
			Object.defineProperty(surface, "scrollHeight", { configurable: true, value: height });
			await act(async () => {
				surface.dispatchEvent(new Event("scroll"));
				for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
			});
			expect(surface.scrollTop).toBe(520);
			expect(container.querySelector(".owl-chat-latest")).not.toBeNull();
		}
	});

	it("resets pending scroll ownership when the profile or session changes on a reused DOM", async () => {
		await render({ entries: [user("question", "run")] });
		const surface = scrollSurface();
		await workspaceRestored(surface, 0);
		surface.dataset.owlSearchNavigation = "old-request";
		await render({ sessionId: "session-two", profile: "D:/profile-two", entries: [user("new-question", "other project")] });
		expect(surface.dataset.owlScrollRestoring).toBe("true");
		expect(surface.hasAttribute("data-owl-search-navigation")).toBe(false);
		expect(surface.scrollTop).toBe(0);
	});
});

describe("literal text highlights", () => {
	it("highlights a literal phrase split by emphasis without rewriting either node", () => {
		const element = document.createElement("div");
		element.innerHTML = "<p>cache <strong>miss</strong> found</p><p>other line</p>";
		const original = element.innerHTML;
		const ranges = messageMatchRanges(element, "cache miss");
		expect(ranges).toHaveLength(1);
		expect(ranges[0]?.startContainer.textContent).toBe("cache ");
		expect(ranges[0]?.startOffset).toBe(0);
		expect(ranges[0]?.endContainer.textContent).toBe("miss");
		expect(ranges[0]?.endOffset).toBe(4);
		expect(messageMatchRanges(element, "foundother")).toHaveLength(0);
		expect(element.innerHTML).toBe(original);
	});

	it("keeps code, links and escaped HTML intact and treats punctuation literally", () => {
		const element = document.createElement("div");
		element.innerHTML = '<p>ERR[A].* <a href="https://example.test/ERR[A].*">err[a].*</a> <code>ERR[A].*</code> &lt;script&gt;</p><button>ERR[A].*</button>';
		const original = element.innerHTML;
		const ranges = messageMatchRanges(element, "ERR[A].*");
		expect(ranges.map(String)).toEqual(["ERR[A].*", "err[a].*", "ERR[A].*"]);
		expect(messageMatchRanges(element, "<script>").map(String)).toEqual(["<script>"]);
		const clear = highlightMessageMatches(element, "ERR[A].*");
		expect(element.innerHTML).toBe(original);
		expect(element.querySelector("a")?.getAttribute("href")).toBe("https://example.test/ERR[A].*");
		clear();
		expect(highlights.has("owl-message-search")).toBe(false);
	});

	it("does not let cleanup from another chat remove the newer highlight", () => {
		const first = document.createElement("div");
		const second = document.createElement("div");
		first.textContent = "first match";
		second.textContent = "second match";
		const clearFirst = highlightMessageMatches(first, "first");
		const clearSecond = highlightMessageMatches(second, "second");
		clearFirst();
		expect([...highlights.get("owl-message-search")!].map(String)).toEqual(["second"]);
		clearSecond();
		expect(highlights.size).toBe(0);
	});
});
