import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

let container: HTMLElement;
let root: Root;

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
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"MutationObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", () => 0);
	vi.stubGlobal("cancelAnimationFrame", () => {});
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	setUiLanguage("zh");
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

function marks(): HTMLButtonElement[] {
	return [...container.querySelectorAll<HTMLButtonElement>(".owl-chat-minimap-marks button")];
}

describe("用户消息导航小地图", () => {
	it("marks a user message the assistant already answered as 已答", async () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "你好", entryId: "u0", timestamp: 1 },
			{
				kind: "assistant",
				text: "你好呀～我是 Owl Si。",
				thinking: "",
				tools: [],
				entryId: "a0",
				timestamp: 2,
				endedAt: 3,
			},
		];
		await act(async () => root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />));
		expect(marks()).toHaveLength(1);
		// 导航轨标的是用户消息：这条已经被 assistant 回复过，必须是「已答」。
		expect(marks()[0].getAttribute("aria-label")).toContain(t("question.answeredTag"));
		expect(marks()[0].getAttribute("data-answered")).toBe("true");
	});

	it("keeps the newest unanswered user message as 未答", async () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "第一个", entryId: "u0", timestamp: 1 },
			{
				kind: "assistant",
				text: "回你一句",
				thinking: "",
				tools: [],
				entryId: "a0",
				timestamp: 2,
				endedAt: 3,
			},
			{ kind: "user", text: "还没回", entryId: "u1", timestamp: 4 },
		];
		await act(async () => root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />));
		expect(marks()).toHaveLength(2);
		expect(marks()[0].getAttribute("aria-label")).toContain(t("question.answeredTag"));
		expect(marks()[1].getAttribute("aria-label")).toContain(t("question.unansweredTag"));
		expect(marks()[1].getAttribute("data-answered")).toBeNull();
	});
});
