import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rebuild } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";
import { REAL_REPLAY_ENTRY_IDS, REAL_REPLAY_MESSAGES, REAL_REPLAY_SOURCE } from "./test-data/execution-real-session.ts";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

let root: Root;
let host: HTMLElement;

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
	vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
	vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
	dom.window.getSelection = () => null;
	dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as MediaQueryList;
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 40, top: 0, left: 0, right: 800, bottom: 40, toJSON: () => ({}) });
	setUiLanguage("zh");
	host = document.getElementById("root")!;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("rebuilds the actual five tool rounds and final text without inventing a progress message", () => {
	const entries = rebuild(REAL_REPLAY_MESSAGES, REAL_REPLAY_ENTRY_IDS);
	const assistant = entries.filter((entry) => entry.kind === "assistant");
	expect(assistant.map((entry) => entry.tools.length)).toEqual([2, 3, 3, 2, 2, 0]);
	expect(assistant.filter((entry) => entry.text.trim())).toHaveLength(1);
	expect(assistant.at(-1)?.text).toMatch(/^看完了，给你一份概览/);
	expect(assistant.every((entry) => entry.thinking === "[已移除原始 thinking 正文]")).toBe(true);
	expect(assistant.every((entry) => entry.model === undefined && entry.usage === undefined)).toBe(true);
	expect(REAL_REPLAY_SOURCE.retainedThinking).toBe(false);
	const tools = assistant.flatMap((entry) => entry.tools);
	expect(tools).toHaveLength(12);
	expect(tools.filter((tool) => tool.status === "error")).toHaveLength(1);
	expect(tools.find((tool) => tool.status === "error")?.output?.text).toBe("Path not found: D:\\owl\\owl-re-v1\\packages");
	expect(tools.find((tool) => tool.id === "call_01_qLJrwEV0g2e4TZwO6dd77162")?.status).toBe("ok");
});

it("opens one real turn directly into twelve operations, without round-count folds or fabricated commentary", async () => {
	const entries = rebuild(REAL_REPLAY_MESSAGES, REAL_REPLAY_ENTRY_IDS);
	await act(async () => root.render(<ChatStream entries={entries} sessionId="actual-session-replay" activity="idle" executionView="normal" />));
	expect(host.querySelectorAll('[data-work-kind="note"]')).toHaveLength(0);
	expect(host.querySelectorAll(".owl-work-process-summary")).toHaveLength(1);
	expect(host.querySelector(".owl-work-metadata")?.textContent).toContain("12");
	expect(host.querySelectorAll(".owl-work-history-toggle")).toHaveLength(0);
	await act(async () => host.querySelector<HTMLButtonElement>(".owl-work-process-summary")!.click());
	expect(host.querySelectorAll(".owl-work-history-toggle")).toHaveLength(0);
	expect(host.querySelectorAll(".owl-tool-group-summary")).toHaveLength(0);
	expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(12);
	expect(host.querySelectorAll('[data-owl-answer="true"]')).toHaveLength(1);
	expect(host.querySelector('[data-owl-answer="true"]')?.textContent).toMatch(/^看完了/);
});

it("keeps the historical path failure in its original record instead of presenting it as latest output after completion", async () => {
	const entries = rebuild(REAL_REPLAY_MESSAGES, REAL_REPLAY_ENTRY_IDS);
	await act(async () => root.render(<ChatStream entries={entries} sessionId="actual-session-replay" activity="idle" executionView="normal" />));
	expect(host.querySelector(".owl-work-latest-output")).toBeNull();
	expect(host.querySelector(".owl-work-latest-state")).toBeNull();
	await act(async () => host.querySelector<HTMLButtonElement>(".owl-work-process-summary")!.click());
	const error = host.querySelector('[data-tool-id="call_02_xvax6Up245ygbIQ6Num13607"]');
	expect(error).not.toBeNull();
	expect(error?.textContent).toContain("packages");
	const corrected = host.querySelector('[data-tool-id="call_01_qLJrwEV0g2e4TZwO6dd77162"]');
	expect(corrected).not.toBeNull();
	expect(corrected?.textContent).toContain("packages");
});
