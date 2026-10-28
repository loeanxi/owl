import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

type Props = React.ComponentProps<typeof ChatStream>;
type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;

let root: Root;
let host: HTMLElement;
let props: Props;

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
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
	dom.window.getSelection = () => null;
	dom.window.matchMedia = () =>
		({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as MediaQueryList;
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
	setUiLanguage("zh");
	document.documentElement.dataset.owlClaudeFlow = "on";
	host = document.getElementById("root")!;
	root = createRoot(host);
	props = { entries: [], sessionId: "cite", activity: "idle" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setUiLanguage("zh");
});

async function render(next: Partial<Props>): Promise<void> {
	await act(async () => {
		root.render(<ChatStream {...props} {...next} />);
	});
}

function assistant(text: string, citations?: unknown[]): AssistantEntry {
	return {
		kind: "assistant",
		entryId: "a",
		text,
		thinking: "",
		timestamp: 1000,
		endedAt: 2000,
		tools: [],
		segments: [{ kind: "text", text, ...(citations ? { citations } : {}) }],
	} as unknown as AssistantEntry;
}

describe("citations in the answer stream", () => {
	it("renders the inline marker and the sources panel", async () => {
		await render({
			entries: [
				{ kind: "user", text: "查资料", timestamp: 500 },
				assistant("结论在这里。", [
					{ title: "Example Domain", url: "https://example.com/page", source: "url_citation", endIndex: 5 },
				]),
			],
		});

		const marker = host.querySelector(".owl-answer-cite");
		expect(marker).not.toBeNull();
		expect(marker?.textContent).toBe("1");
		expect(marker?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/page");

		const panel = host.querySelector("[data-answer-sources]");
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain("Example Domain");
	});

	it("leaves an answer without citations untouched", async () => {
		await render({
			entries: [{ kind: "user", text: "查资料", timestamp: 500 }, assistant("没有来源的结论。")],
		});

		expect(host.querySelector(".owl-answer-cite")).toBeNull();
		expect(host.querySelector("[data-answer-sources]")).toBeNull();
	});
});
