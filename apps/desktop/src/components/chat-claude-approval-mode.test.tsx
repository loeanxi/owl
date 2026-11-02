import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
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
	document.documentElement.dataset.owlClaudeFlow = "on";
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	setUiLanguage("zh");
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

/** 一轮里有 todo 工具卡（回传清单快照）的对话。 */
const entriesWithTodo: ChatEntry[] = [
	{ kind: "user", text: "列个计划", entryId: "u0", timestamp: 1 },
	{
		kind: "assistant",
		text: "好的，先列计划。",
		thinking: "",
		tools: [
			{
				id: "tool-todo",
				name: "todo",
				args: "{}",
				summary: "更新任务清单",
				status: "ok",
				output: { text: "", totalLines: 0, todos: [{ content: "第一步", status: "pending" }] },
			},
		],
		entryId: "a0",
		timestamp: 2,
		endedAt: 3,
	},
];

describe("审批模式切换后的回答流", () => {
	it("swaps the inline task list for the plan card when the mode turns to plan", async () => {
		await act(async () =>
			root.render(<ChatStream entries={entriesWithTodo} sessionId="session" cwd="D:/project" approvalMode="auto" />),
		);
		// 普通模式下清单是行内清单卡。
		expect(container.querySelector(".owl-claude-tasklist")).not.toBeNull();
		expect(container.querySelector(".owl-claude-plan")).toBeNull();

		// 只改审批模式、转录不动：计划模式下清单即计划，必须立刻换成计划卡。
		await act(async () =>
			root.render(<ChatStream entries={entriesWithTodo} sessionId="session" cwd="D:/project" approvalMode="plan" />),
		);
		expect(container.querySelector(".owl-claude-plan")).not.toBeNull();
	});

	it("goes back to the inline task list when the mode leaves plan", async () => {
		await act(async () =>
			root.render(<ChatStream entries={entriesWithTodo} sessionId="session" cwd="D:/project" approvalMode="plan" />),
		);
		expect(container.querySelector(".owl-claude-plan")).not.toBeNull();
		await act(async () =>
			root.render(
				<ChatStream entries={entriesWithTodo} sessionId="session" cwd="D:/project" approvalMode="confirm" />,
			),
		);
		expect(container.querySelector(".owl-claude-plan")).toBeNull();
		expect(container.querySelector(".owl-claude-tasklist")).not.toBeNull();
	});
});
