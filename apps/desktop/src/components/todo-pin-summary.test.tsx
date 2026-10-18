import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import type { TodoItem } from "../hooks/todo.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { TodoPin } from "./TodoPin.tsx";

let host: HTMLElement;
let root: Root;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	setUiLanguage("zh");
	host = document.getElementById("root")!;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(todos: TodoItem[]): Promise<void> {
	const entries: ChatEntry[] = [{ kind: "assistant", text: "", thinking: "", tools: [{ id: "todos", name: "todo", args: JSON.stringify({ todos }), summary: "更新任务清单", status: "ok" }] }];
	await act(async () => root.render(<TodoPin entries={entries} presentation="summary" />));
}

it("renders the actual current task and completed count, updates the open list and restores focus on Escape", async () => {
	let activeElement: Element = document.body;
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => activeElement });
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function(this: HTMLElement) { activeElement = this; });
	const todos: TodoItem[] = [{ content: "已读取实现", status: "completed" }, { content: "核对取消状态", status: "in_progress" }, { content: "汇报结果", status: "pending" }];
	await render(todos);
	const trigger = host.querySelector<HTMLButtonElement>(".owl-todo-trigger")!;
	expect(trigger.textContent).toContain("核对取消状态");
	expect(host.querySelector(".owl-todo-summary-count")?.textContent).toBe("1/3");
	await act(async () => trigger.click());
	expect(host.querySelector('[role="dialog"] [data-current="true"]')?.textContent).toContain("核对取消状态");
	await render([todos[0]!, { ...todos[1]!, status: "completed" }, { ...todos[2]!, status: "in_progress" }]);
	expect(trigger.getAttribute("aria-expanded")).toBe("true");
	expect(host.querySelector(".owl-todo-summary-count")?.textContent).toBe("2/3");
	expect(host.querySelector('[role="dialog"] [data-current="true"]')?.textContent).toContain("汇报结果");
	const escape = new Event("keydown");
	Object.defineProperty(escape, "key", { value: "Escape" });
	await act(async () => document.dispatchEvent(escape));
	expect(host.querySelector('[role="dialog"]')).toBeNull();
	expect(trigger.getAttribute("aria-expanded")).toBe("false");
	expect(document.activeElement).toBe(trigger);
});

it("does not claim all done for an unknown todo status and hides an empty list", async () => {
	await render([{ content: "等待核对", status: "cancelled" }]);
	expect(host.querySelector(".owl-todo-summary-count")?.textContent).toBe("0/1");
	expect(host.querySelector(".owl-todo-trigger")?.getAttribute("data-state")).toBe("idle");
	await render([]);
	expect(host.querySelector(".owl-todo-anchor")).toBeNull();
});
