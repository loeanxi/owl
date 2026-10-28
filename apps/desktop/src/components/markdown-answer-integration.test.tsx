import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream, renderMarkdown } from "./ChatStream.tsx";
import { highlightMessageMatches, messageElement, messageMatchRanges } from "./chat-message-navigation.ts";

const fixture = vi.hoisted(() => ({ genui: vi.fn() }));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));
vi.mock("../../../../packages/owl-genui/client/index.ts", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("../../../../packages/owl-genui/client/index.ts");
	return {
		...actual,
		renderGenuiFence: (raw: string, identity: string) => {
			fixture.genui(raw, identity);
			return <div data-test-genui="true">{raw}</div>;
		},
	};
});

class LiteralRange {
	startContainer?: Node;
	startOffset = 0;
	endContainer?: Node;
	endOffset = 0;
	setStart(node: Node, offset: number): void {
		this.startContainer = node;
		this.startOffset = offset;
	}
	setEnd(node: Node, offset: number): void {
		this.endContainer = node;
		this.endOffset = offset;
	}
	toString(): string {
		return this.startContainer === this.endContainer
			? (this.startContainer?.textContent?.slice(this.startOffset, this.endOffset) ?? "")
			: "";
	}
}

type Props = React.ComponentProps<typeof ChatStream>;
let host: HTMLElement;
let root: Root;
let props: Props;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let highlights: Map<string, Set<Range>>;

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
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe(): void {}
			disconnect(): void {}
		},
	);
	frames = new Map();
	frameId = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = ++frameId;
		frames.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	dom.window.getSelection = () => null;
	dom.window.matchMedia = () =>
		({ matches: false, addEventListener() {}, removeEventListener() {} }) as MediaQueryList;
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
		x: 0,
		y: 0,
		width: 800,
		height: 40,
		top: 0,
		left: 0,
		right: 800,
		bottom: 40,
		toJSON: () => ({}),
	});
	vi.spyOn(document, "createRange").mockImplementation(() => new LiteralRange() as unknown as Range);
	highlights = new Map();
	vi.stubGlobal("CSS", { highlights });
	vi.stubGlobal(
		"Highlight",
		class extends Set<Range> {
			constructor(...ranges: Range[]) {
				super(ranges);
			}
		},
	);
	fixture.genui.mockClear();
	setUiLanguage("zh");
	host = document.getElementById("root")!;
	root = createRoot(host);
	props = { entries: [], sessionId: "session-one", cwd: "D:/project", onOpenFile: vi.fn(), onOpenUrl: vi.fn() };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function assistant(text: string): ChatEntry {
	return { kind: "assistant", entryId: "answer-entry", text, thinking: "", tools: [] };
}

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
	const surface = host.querySelector<HTMLElement>(".owl-chat-scroll")!;
	Object.defineProperties(surface, {
		clientHeight: { configurable: true, value: 400 },
		scrollHeight: { configurable: true, value: 2000 },
	});
	surface.scrollTop = 0;
	surface.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
	const scrollTo = vi.fn((options: ScrollToOptions) => {
		surface.scrollTop = options.top ?? 0;
	});
	surface.scrollTo = scrollTo;
	return surface as typeof surface & { scrollTo: typeof scrollTo };
}

const searchedMarkdown =
	"```TOKEN_MATCH\nTOKEN_MATCH <safe>\n```\n\n| 位置 | 内容 |\n| --- | --- |\n| table | `TOKEN_MATCH` |\n\n[TOKEN_MATCH](https://example.test/TOKEN_MATCH)\n\n`D:/project/TOKEN_MATCH.ts`";

describe("Markdown answers in the real chat timeline", () => {
	it("keeps the shared Markdown export free of reading controls for existing static preview callers", () => {
		const preview = document.createElement("article");
		preview.innerHTML = renderMarkdown(
			'Read **guide**\nsecond line\n\n```ts\n  const escaped = "<tag>";\n```\n\n`src/main.ts` https://example.test/docs\n\n| A | B |\n| --- | --- |\n| first | second |\n\n<script>not executable</script>',
		);
		expect(
			preview.querySelector("[data-answer-toolbar], [data-answer-action], [data-answer-code], [data-answer-table]"),
		).toBeNull();
		expect(preview.querySelector("strong")?.textContent).toBe("guide");
		expect(preview.querySelector("br")).not.toBeNull();
		expect(preview.querySelector("pre > code")?.textContent).toBe('  const escaped = "<tag>";\n');
		expect(preview.querySelector("code.owl-path-chip")?.textContent).toBe("src/main.ts");
		expect(preview.querySelector("a")?.getAttribute("href")).toBe("https://example.test/docs");
		expect(preview.querySelector("table")?.parentElement).toBe(preview);
		expect(preview.querySelectorAll("td")).toHaveLength(2);
		expect(preview.querySelector("script")).toBeNull();
		expect(preview.textContent).toContain("<script>not executable</script>");
	});

	it("uses the reading component for ordinary Markdown while closed owl-ui fences keep their Genui route", async () => {
		const spec = '{"items":[]}';
		const text = `开头正文\n\n\`\`\`js\nconst 中文 = "<tag>";\n\`\`\`\n\n\`\`\`owl-ui\n${spec}\n\`\`\`\n\n结尾正文`;
		await render({ entries: [{ kind: "user", entryId: "question-entry", text: "展示回答" }, assistant(text)] });
		const row = host.querySelector<HTMLElement>('[data-entry-id="answer-entry"]')!;
		expect(row.querySelectorAll(".owl-answer-reading")).toHaveLength(2);
		expect(row.querySelectorAll("[data-answer-code]")).toHaveLength(1);
		expect(row.querySelector("pre > code")?.textContent).toBe('const 中文 = "<tag>";\n');
		expect(row.querySelectorAll("[data-test-genui]")).toHaveLength(1);
		expect(new Set(fixture.genui.mock.calls.map(([raw]) => raw))).toEqual(new Set([spec]));
		expect(row.textContent).toContain("开头正文");
		expect(row.textContent).toContain("结尾正文");
	});

	it("keeps unfinished owl-ui JSON readable during streaming, then switches once the fence closes", async () => {
		const partial = '开始\n\n```owl-ui\n{"items":[]';
		await render({ entries: [assistant(partial)], activity: "working" });
		expect(host.querySelector("pre > code")?.textContent).toContain('{"items":[]');
		expect(fixture.genui).not.toHaveBeenCalled();
		const closed = partial + "}\n```\n\n最后一段";
		await render({ entries: [assistant(closed)], activity: "idle" });
		expect(host.querySelectorAll("[data-test-genui]")).toHaveLength(1);
		expect(host.querySelectorAll("[data-answer-code]")).toHaveLength(0);
		expect((host.textContent ?? "").split("最后一段")).toHaveLength(2);
	});

	it("retains historical entry ownership and literal body highlights while ignoring toolbar language and copy status", async () => {
		await render({
			searchTarget: { sessionId: "session-one", entryId: "history-entry", query: "TOKEN_MATCH", requestId: 1 },
			searchHistoryMessage: {
				entryId: "history-entry",
				message: { role: "assistant", content: searchedMarkdown, timestamp: 1 },
			},
		});
		const surface = scrollSurface();
		const row = host.querySelector<HTMLElement>("[data-owl-search-history]")!;
		row.getBoundingClientRect = () => ({ top: 200 }) as DOMRect;
		const status = row.querySelector<HTMLElement>("[data-answer-copy-status]")!;
		status.textContent = "TOKEN_MATCH";
		const before = row.innerHTML;
		expect(row.dataset.entryId).toBe("history-entry");
		expect(row.querySelectorAll(".owl-answer-reading")).toHaveLength(1);
		expect(row.querySelectorAll("[data-answer-toolbar]")).toHaveLength(2);
		expect(messageMatchRanges(row, "TOKEN_MATCH").map(String)).toEqual([
			"TOKEN_MATCH",
			"TOKEN_MATCH",
			"TOKEN_MATCH",
			"TOKEN_MATCH",
		]);
		expect(messageMatchRanges(row, "复制")).toHaveLength(0);
		const clear = highlightMessageMatches(row, "TOKEN_MATCH");
		expect([...highlights.get("owl-message-search")!].map(String)).toHaveLength(4);
		expect(row.innerHTML).toBe(before);
		clear();
		const toolbarOnlyCandidate = document.createElement("div");
		toolbarOnlyCandidate.dataset.entryId = "history-entry";
		toolbarOnlyCandidate.innerHTML = "<div data-answer-toolbar><span>TOKEN_MATCH</span></div><p>另一行正文</p>";
		surface.insertBefore(toolbarOnlyCandidate, surface.firstChild);
		expect(messageElement(surface, "history-entry", "TOKEN_MATCH")).toBe(row);
		await flushFrames();
		expect(surface.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 184, behavior: "instant" });
		expect(row.dataset.searchMatch).toBe("true");
		expect(host.querySelectorAll("[data-qidx]")).toHaveLength(0);
		expect(row.querySelector("code.owl-path-chip")?.textContent).toBe("D:/project/TOKEN_MATCH.ts");
		expect(row.querySelector("a")?.getAttribute("href")).toBe("https://example.test/TOKEN_MATCH");
	});

	it("still locates a historical code hit when CSS custom highlights are unavailable", async () => {
		vi.stubGlobal("CSS", {});
		await render({
			searchTarget: { sessionId: "session-one", entryId: "history-entry", query: "TOKEN_MATCH", requestId: 2 },
			searchHistoryMessage: {
				entryId: "history-entry",
				message: { role: "assistant", content: searchedMarkdown, timestamp: 1 },
			},
		});
		const surface = scrollSurface();
		const row = host.querySelector<HTMLElement>("[data-owl-search-history]")!;
		row.getBoundingClientRect = () => ({ top: 180 }) as DOMRect;
		await flushFrames();
		expect(surface.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 164, behavior: "instant" });
		expect(row.dataset.searchMatch).toBe("true");
		expect(row.querySelector("pre > code")?.textContent).toBe("TOKEN_MATCH <safe>\n");
	});

	it("keeps table path chips and external links delegated to the existing chat handlers", async () => {
		await render({
			entries: [
				assistant(
					"| 文件 | 资料 |\n| --- | --- |\n| `D:/project/source.ts` | [原文](https://example.test/source) |",
				),
			],
		});
		const path = host.querySelector<HTMLElement>("table code.owl-path-chip")!;
		const link = host.querySelector<HTMLAnchorElement>("table a")!;
		await act(async () => path.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })));
		expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith("source.ts");
		await act(async () => link.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })));
		expect(props.onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://example.test/source");
		expect(link.getAttribute("href")).toBe("https://example.test/source");
		expect(path.textContent).toBe("D:/project/source.ts");
	});

	it("opens a workspace link that carries both a line and a column", async () => {
		await render({ entries: [assistant("[位置](src/App.tsx:10:4)")] });
		const link = host.querySelector<HTMLAnchorElement>(".owl-answer a")!;
		const click = new window.Event("click", { bubbles: true, cancelable: true });
		await act(async () => link.dispatchEvent(click));
		expect(click.defaultPrevented).toBe(true);
		expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith("src/App.tsx");
	});

	it("opens protocol-relative links in the sidebar and does not follow other schemes", async () => {
		await render({ entries: [assistant("[站](//example.test/docs) 和 [信](mailto:owl@example.test)")] });
		const [web, mail] = [...host.querySelectorAll<HTMLAnchorElement>(".owl-answer a")];
		const webClick = new window.Event("click", { bubbles: true, cancelable: true });
		await act(async () => web!.dispatchEvent(webClick));
		expect(webClick.defaultPrevented).toBe(true);
		expect(props.onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://example.test/docs");
		const mailClick = new window.Event("click", { bubbles: true, cancelable: true });
		await act(async () => mail!.dispatchEvent(mailClick));
		expect(mailClick.defaultPrevented).toBe(true);
		expect(props.onOpenUrl).toHaveBeenCalledOnce();
		expect(props.onOpenFile).not.toHaveBeenCalled();
	});
});
