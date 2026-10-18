import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import type { DesktopSubagentSummary } from "../../bridge/protocol.ts";
import type { ChatEntry, ToolCard } from "../../hooks/transcript.ts";
import { setUiLanguage } from "../../i18n/index.ts";
import { ExecutionContext, type ExecutionContextValue } from "../execution-context.tsx";
import { parseExecutionSelection, selectedExecutionTool } from "../execution-selection.ts";
import { SidebarStore } from "../store.ts";
import { ExecutionTab } from "./ExecutionTab.tsx";

let root: Root;
let container: HTMLElement;
let store: SidebarStore;
const request = vi.fn();
const writeText = vi.fn().mockResolvedValue(undefined);
const client = { request } as unknown as BridgeClient;
const onOpenSession = vi.fn();
const onOpenSubagent = vi.fn();
const tool = (extra: Partial<ToolCard> = {}): ToolCard => ({ id: "tool-1", name: "bash", args: '{"command":"echo output"}', summary: "echo output", status: "running", output: { text: "first output", totalLines: 1 }, ...extra });
const assistant = (tools: ToolCard[]): ChatEntry => ({ kind: "assistant", text: "", thinking: "", tools });

beforeEach(() => {
	vi.useFakeTimers();
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!; root = createRoot(container);
	store = new SidebarStore("D:/project");
	request.mockReset().mockResolvedValue({ ok: true, result: [] });
	writeText.mockClear(); onOpenSession.mockClear(); onOpenSubagent.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function render(mode: "tasks" | "tool", extra: Partial<ExecutionContextValue> = {}, profile = "account", pathExtra: Record<string, unknown> = {}) {
	const context: ExecutionContextValue = { sessionId: "owner", profile: "account", entries: [assistant([tool()])], subagents: [], onOpenSubagent, onRefreshSubagents: vi.fn(), onOpenSession, ...extra };
	await act(async () => root.render(<ExecutionContext.Provider value={context}><ExecutionTab tab={{ id: "execution:one", kind: "execution", title: "执行", path: JSON.stringify({ sessionId: "owner", mode, toolId: "tool-1", ownerIndex: 0, profile: "account", ...pathExtra }) }} store={store} client={client} profile={profile} onOpenFile={vi.fn()} /></ExecutionContext.Provider>));
}

function button(text: string): HTMLButtonElement {
	const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
	if (!found) throw new Error(`Missing button: ${text}`);
	return found;
}
async function click(text: string) { await act(async () => button(text).click()); }

describe("ExecutionTab output ownership and real task controls", () => {
	it("shows live authoritative output and copies its exact text", async () => {
		await render("tool");
		expect(container.textContent).toContain("first output");
		await render("tool", { entries: [assistant([tool({ status: "ok", output: { text: "complete\nsecond line", totalLines: 2 } })])] });
		expect(container.textContent).toContain("complete\nsecond line");
		expect(container.textContent).not.toContain("first output");
		await click("复制输出");
		expect(writeText).toHaveBeenCalledWith("complete\nsecond line");
		expect(request).not.toHaveBeenCalled();
	});

	it("never shows the newly selected conversation in an older task panel", async () => {
		await render("tasks", { sessionId: "other", entries: [assistant([tool({ output: { text: "other secret", totalLines: 1 } })])] });
		expect(container.textContent).toContain("另一条对话");
		expect(container.textContent).not.toContain("other secret");
		expect(request).not.toHaveBeenCalled();
		await click("切回原对话");
		expect(onOpenSession).toHaveBeenCalledWith("owner");
	});

	it("blocks old account output and controls after a profile switch", async () => {
		await render("tool");
		await render("tool", { profile: "other-account" }, "other-account");
		expect(container.textContent).toContain("另一个账号");
		expect(container.textContent).not.toContain("first output");
		expect(container.querySelector("button")).toBeNull();
	});

	it("reads actual process output and sends a process-specific stop", async () => {
		const process = { id: 41, sessionId: "owner", command: "watch files", cwd: "D:/project", startedAt: 100, status: "running" };
		request.mockImplementation(async (input: { type: string }) => input.type === "process.list" ? { ok: true, result: [process] } : { ok: true, result: { ...process, status: input.type === "process.kill" ? "stopped" : "running", output: "real process output", totalBytes: 19, omittedBytes: 0 } });
		await render("tasks");
		expect(container.textContent).toContain("watch files");
		await click("查看输出");
		expect(container.textContent).toContain("real process output");
		await click("停止进程");
		expect(request).toHaveBeenCalledWith({ type: "process.kill", sessionId: "owner", processId: 41 });
		expect(request.mock.calls.some(([input]) => input.type === "session.abort")).toBe(false);
	});

	it("groups siblings into one delegation and keeps an interrupt refusal visible", async () => {
		const subagents = [0, 1].map((childIndex) => ({ id: `run:${childIndex}`, runId: "run", childIndex, parentSessionId: "owner", agent: `reviewer-${childIndex}`, task: "Review", cwd: "D:/project", status: "running", updatedAt: "2026-10-19T00:00:00Z" })) as DesktopSubagentSummary[];
		request.mockImplementation(async (input: { type: string }) => input.type === "subagent.interrupt" ? { ok: false, error: "Cannot interrupt this delegation" } : { ok: true, result: [] });
		await render("tasks", { subagents });
		expect(container.querySelectorAll("[data-run-id='run']")).toHaveLength(1);
		expect([...container.querySelectorAll("button")].filter((item) => item.textContent === "停止此委派")).toHaveLength(1);
		await click("停止此委派");
		expect(request).toHaveBeenCalledWith({ type: "subagent.interrupt", sessionId: "owner", runId: "run" });
		await act(async () => vi.advanceTimersByTimeAsync(2100));
		expect(container.querySelector("[role='alert']")?.textContent).toBe("Cannot interrupt this delegation");
	});

	it("cleans up polling when switching away from the owning session", async () => {
		await render("tasks");
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		await render("tasks", { sessionId: "other" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not present an unavailable task list as an empty task list", async () => {
		request.mockResolvedValue({ ok: false, error: "Task backend unavailable" });
		await render("tasks");
		expect(container.querySelector("[role='alert']")?.textContent).toBe("Task backend unavailable");
		expect(container.textContent).not.toContain("暂无后台任务");
	});

	it("uses the selected owner index when tool IDs repeat", () => {
		const entries = [assistant([tool({ output: { text: "old", totalLines: 1 } })]), assistant([tool({ output: { text: "new", totalLines: 1 } })])];
		expect(selectedExecutionTool(entries, { sessionId: "owner", mode: "tool", ownerIndex: 0, toolId: "tool-1" })?.output?.text).toBe("old");
		expect(selectedExecutionTool(entries, { sessionId: "owner", mode: "tool", ownerIndex: 99, toolId: "tool-1" })).toBeUndefined();
		expect(parseExecutionSelection('{"sessionId":"owner","mode":"unknown"}')).toBeUndefined();
	});
});
