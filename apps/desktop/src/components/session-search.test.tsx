import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionSearchHit, SessionSearchResult } from "../bridge/protocol.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { SessionSearchPanel, type SessionSearchPanelProps } from "./SessionSearchPanel.tsx";
import { sessionSearchText as text } from "./session-search-copy.ts";

type SearchResponse = { ok: boolean; result?: SessionSearchResult; error?: string };
const hit: SessionSearchHit = {
	sessionId: "chat-one",
	cwd: "D:/work/alpha",
	title: "质量问题排查",
	scope: "chat",
	archived: false,
	modified: "2026-10-15T04:00:00.000Z",
	entryId: "later-message",
	role: "assistant",
	excerpt: "后来发现 SQL 查询缺少索引",
	matchRanges: [{ start: 5, end: 8 }],
};
let container: HTMLElement;
let root: Root;
let props: SessionSearchPanelProps;
let request = vi.fn(
	async (_value: unknown): Promise<SearchResponse> => ({ ok: true, result: { hits: [], hasMore: false } }),
);

beforeEach(() => {
	vi.useFakeTimers();
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	request = vi.fn(
		async (_value: unknown): Promise<SearchResponse> => ({ ok: true, result: { hits: [], hasMore: false } }),
	);
	props = {
		client: { request } as unknown as BridgeClient,
		connected: true,
		query: "SQL",
		activeProject: "D:/work/alpha",
		refreshKey: "one",
		revision: 0,
		metadataSessions: [],
		projects: [],
		onOpenHit: vi.fn(),
		onSelectProject: vi.fn(),
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(overrides: Partial<SessionSearchPanelProps> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<SessionSearchPanel {...props} />));
}

async function debounce(): Promise<void> {
	await act(async () => vi.advanceTimersByTimeAsync(220));
}

function button(label: string): HTMLButtonElement {
	const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent === label,
	);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

describe("conversation content search", () => {
	it("debounces typing and searches across both conversation sources by default", async () => {
		await render({ query: "  SQ  " });
		expect(container.querySelector('[role="status"]')?.textContent).toContain(text("loading"));
		await act(async () => vi.advanceTimersByTimeAsync(150));
		await render({ query: "  SQL  " });
		await act(async () => vi.advanceTimersByTimeAsync(219));
		expect(request).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(request).toHaveBeenCalledExactlyOnceWith({
			type: "session.search",
			query: "SQL",
			cwd: undefined,
			includeArchived: false,
			limit: 50,
		});
	});

	it("ignores an older response after a newer query finishes", async () => {
		const old = Promise.withResolvers<SearchResponse>();
		const recent = Promise.withResolvers<SearchResponse>();
		request.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
		await render({ query: "old" });
		await debounce();
		await render({ query: "new" });
		await debounce();
		await act(async () =>
			recent.resolve({ ok: true, result: { hits: [{ ...hit, title: "new result" }], hasMore: false } }),
		);
		expect(container.textContent).toContain("new result");
		await act(async () =>
			old.resolve({ ok: true, result: { hits: [{ ...hit, title: "old result" }], hasMore: false } }),
		);
		expect(container.textContent).toContain("new result");
		expect(container.textContent).not.toContain("old result");
	});

	it("opens the specific matching message and safely highlights literal text", async () => {
		const unsafe = {
			...hit,
			scope: "research" as const,
			archived: true,
			excerpt: "<img src=x> SQL <script>boom</script>",
			matchRanges: [{ start: 12, end: 15 }],
		};
		request.mockResolvedValueOnce({ ok: true, result: { hits: [unsafe], hasMore: false } });
		await render();
		await debounce();
		expect(container.querySelector("mark")?.textContent).toBe("SQL");
		expect(container.querySelector("img, script")).toBeNull();
		expect(container.textContent).toContain(unsafe.excerpt);
		expect(container.textContent).toContain(text("research"));
		expect(container.textContent).toContain(text("archived"));
		const time = container.querySelector("time");
		expect(time?.getAttribute("datetime") ?? time?.getAttribute("dateTime")).toBe(hit.modified);
		await act(async () => container.querySelector<HTMLButtonElement>(".owl-session-search-hit")!.click());
		expect(props.onOpenHit).toHaveBeenCalledExactlyOnceWith(unsafe, "SQL");
	});

	it("filters to the current project and explicitly opts in to archived records", async () => {
		await render({
			metadataSessions: [
				hit,
				{ ...hit, sessionId: "other", cwd: "D:/work/beta", title: "other project" },
				{ ...hit, sessionId: "archived", archived: true, title: "archived title" },
			],
		});
		await debounce();
		expect(container.textContent).toContain("other project");
		expect(container.textContent).not.toContain("archived title");
		await act(async () => button(text("currentProject")).click());
		expect(container.textContent).not.toContain("other project");
		await debounce();
		expect(request).toHaveBeenLastCalledWith({
			type: "session.search",
			query: "SQL",
			cwd: props.activeProject,
			includeArchived: false,
			limit: 50,
		});
		await act(async () => {
			const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
			input.checked = true;
			input.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		await debounce();
		expect(request).toHaveBeenLastCalledWith({
			type: "session.search",
			query: "SQL",
			cwd: props.activeProject,
			includeArchived: true,
			limit: 50,
		});
		expect(container.textContent).toContain("archived title");
	});

	it("keeps title and project matches available without repeating a body hit", async () => {
		request.mockResolvedValueOnce({ ok: true, result: { hits: [hit], hasMore: false } });
		const titleMatch = { ...hit, sessionId: "metadata-only", entryId: "", title: "SQL标题匹配" };
		await render({ metadataSessions: [hit, titleMatch], projects: ["D:/work/SQL-project"] });
		await debounce();
		expect(container.querySelectorAll(".owl-session-search-hit")).toHaveLength(3);
		expect(container.querySelectorAll(".owl-session-search-title")).toHaveLength(3);
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>(".owl-session-search-hit")]
				.find((item) => item.textContent?.includes(titleMatch.title))!
				.click(),
		);
		expect(props.onOpenHit).toHaveBeenCalledExactlyOnceWith(titleMatch, "SQL");
		await act(async () => container.querySelector<HTMLButtonElement>(".owl-session-search-project-hit")!.click());
		expect(props.onSelectProject).toHaveBeenCalledExactlyOnceWith("D:/work/SQL-project");
	});

	it("shows a recoverable failure and retries without losing the query", async () => {
		request
			.mockResolvedValueOnce({ ok: false, error: "disk unavailable" })
			.mockResolvedValueOnce({ ok: true, result: { hits: [hit], hasMore: false } });
		await render();
		await debounce();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("disk unavailable");
		await act(async () => button(text("retry")).click());
		await debounce();
		expect(request).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).toContain(hit.excerpt);
	});

	it("invalidates pending results while disconnected and searches again on reconnect", async () => {
		const pending = Promise.withResolvers<SearchResponse>();
		request.mockReturnValueOnce(pending.promise);
		await render();
		await debounce();
		await render({ connected: false });
		await act(async () => pending.resolve({ ok: true, result: { hits: [hit], hasMore: false } }));
		expect(container.textContent).toContain(text("offline"));
		expect(container.textContent).not.toContain(hit.excerpt);
		await render({ connected: true });
		await debounce();
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("loads more results and resets the limit when the query changes", async () => {
		request.mockResolvedValueOnce({ ok: true, result: { hits: [hit], hasMore: true } });
		await render();
		await debounce();
		await act(async () => button(text("more")).click());
		await debounce();
		expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: "SQL", limit: 100 }));
		await render({ query: "other error" });
		await debounce();
		expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: "other error", limit: 50 }));
	});

	it("updates copy when the language changes without repeating the search", async () => {
		await render();
		await debounce();
		await act(async () => setUiLanguage("en"));
		expect(container.textContent).toContain("All projects");
		expect(container.textContent).toContain("No matching messages");
		expect(request).toHaveBeenCalledOnce();
	});
});
