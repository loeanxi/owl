import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchMessageResult } from "../bridge/protocol.ts";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

type Props = React.ComponentProps<typeof ChatStream>;
let container: HTMLElement;
let root: Root;
let props: Props;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
const history: SessionSearchMessageResult = {
	entryId: "early-entry",
	message: { role: "user", content: "较早的 SQL 排查内容", timestamp: 1 },
};

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("CSS", {});
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe(): void {}
			disconnect(): void {}
		},
	);
	frames = new Map();
	sequence = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = ++sequence;
		frames.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	setUiLanguage("zh");
	container = document.getElementById("root")!;
	root = createRoot(container);
	props = {
		entries: [],
		sessionId: "session-one",
		cwd: "D:/alpha",
		searchTarget: { sessionId: "session-one", entryId: history.entryId, query: "SQL", requestId: 1 },
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

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

describe("searched messages before the compacted transcript", () => {
	it("navigates when an asynchronously loaded earlier message appears", async () => {
		await render();
		const surface = container.querySelector<HTMLElement>(".owl-chat-scroll")!;
		Object.defineProperties(surface, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } });
		surface.scrollTop = 0;
		surface.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
		const scrollTo = vi.fn((options: ScrollToOptions) => {
			surface.scrollTop = options.top ?? 0;
		});
		surface.scrollTo = scrollTo;
		await flushFrames();
		expect(scrollTo).not.toHaveBeenCalled();
		await render({ searchHistoryMessage: history });
		const preview = container.querySelector<HTMLElement>("[data-owl-search-history]")!;
		preview.getBoundingClientRect = () => ({ top: 200 }) as DOMRect;
		await flushFrames();
		expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 184, behavior: "instant" });
		expect(preview.dataset.searchMatch).toBe("true");
		expect(preview.dataset.entryId).toBe(history.entryId);
		expect(preview.textContent).toContain("较早的历史消息");
		expect(preview.querySelector("button, textarea, input")).toBeNull();
		expect(container.querySelector(".owl-chat-empty")).toBeNull();
	});

	it("keeps the preview outside live turns, navigation counts, and streaming updates", async () => {
		const entries: ChatEntry[] = [
			{ kind: "user", entryId: "current-question", text: "current question" },
			{ kind: "assistant", entryId: "current-answer", text: "current answer", thinking: "", tools: [] },
		];
		const artifacts = vi.fn((_turn: ChatEntry[]) => null);
		await render({ entries, searchHistoryMessage: history, renderTurnArtifacts: artifacts });
		await render({
			entries: [
				entries[0]!,
				{ ...entries[1]!, kind: "assistant", text: "current answer streaming", thinking: "", tools: [] },
			],
			activity: "working",
		});
		expect(container.querySelectorAll("[data-owl-search-history]")).toHaveLength(1);
		expect(container.querySelectorAll("[data-qidx]")).toHaveLength(1);
		expect(artifacts).toHaveBeenCalled();
		for (const [turn] of artifacts.mock.calls)
			expect(
				turn.every(
					(entry) => (entry.kind === "user" || entry.kind === "assistant") && entry.entryId !== history.entryId,
				),
			).toBe(true);
		expect(entries).toHaveLength(2);
		expect(container.textContent).toContain("current answer streaming");
	});

	it("renders user text literally and assistant Markdown with raw HTML disabled", async () => {
		const raw = "<script>bad()</script>\nSQL <img src=x>";
		await render({
			searchHistoryMessage: {
				...history,
				message: { role: "user", content: [{ type: "text", text: raw }], timestamp: 1 },
			},
		});
		let preview = container.querySelector<HTMLElement>("[data-owl-search-history]")!;
		expect(preview.textContent).toContain(raw);
		expect(preview.querySelector("script, img")).toBeNull();
		expect(preview.dataset.historyRole).toBe("user");
		await render({
			searchHistoryMessage: { ...history, message: { role: "assistant", content: `**SQL** ${raw}`, timestamp: 1 } },
		});
		preview = container.querySelector<HTMLElement>("[data-owl-search-history]")!;
		expect(preview.querySelector("strong")?.textContent).toBe("SQL");
		expect(preview.querySelector("script, img, button")).toBeNull();
		expect(preview.dataset.historyRole).toBe("assistant");
	});

	it("suppresses duplicate or stale previews when the snapshot or search selection changes", async () => {
		await render({
			searchHistoryMessage: history,
			entries: [{ kind: "user", entryId: history.entryId, text: "SQL already in snapshot" }],
		});
		expect(container.querySelector("[data-owl-search-history]")).toBeNull();
		expect(container.querySelectorAll("[data-entry-id='early-entry']")).toHaveLength(1);
		await render({
			entries: [],
			searchTarget: { sessionId: "another-session", entryId: history.entryId, query: "SQL", requestId: 2 },
		});
		expect(container.querySelector("[data-owl-search-history]")).toBeNull();
		await render({
			searchTarget: { sessionId: "session-one", entryId: "another-entry", query: "SQL", requestId: 3 },
		});
		expect(container.querySelector("[data-owl-search-history]")).toBeNull();
	});
});
