import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";
import type { ExecutionView } from "./execution-view.ts";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

type Assistant = Extract<ChatEntry, { kind: "assistant" }>;
type Props = React.ComponentProps<typeof ChatStream>;
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
	props = { entries: [], sessionId: "execution-view", activity: "working" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function tool(id: string, status: ToolCard["status"] = "ok", output = "真实输出"): ToolCard {
	return { id, name: "read", args: JSON.stringify({ path: `src/${id}.ts` }), detail: `src/${id}.ts`, summary: `读取 ${id}.ts`, status, output: { text: output, totalLines: output.split("\n").length } };
}
function assistant(entryId: string, tools: ToolCard[], extra: Partial<Assistant> = {}): Assistant {
	return { kind: "assistant", entryId, text: "", thinking: "", tools, ...extra };
}
function turn(...messages: Assistant[]): ChatEntry[] {
	return [{ kind: "user", entryId: "question", text: "核对真实执行状态" }, ...messages];
}
async function render(overrides: Partial<Props>): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<ChatStream {...props} />));
}
async function click(selector: string): Promise<void> {
	const button = host.querySelector<HTMLButtonElement>(selector);
	expect(button, selector).not.toBeNull();
	await act(async () => button!.click());
}
function visibleText(): string {
	const clone = host.cloneNode(true) as HTMLElement;
	for (const node of clone.querySelectorAll("[hidden], .owl-collapse-body:not([data-open])")) node.remove();
	return clone.textContent ?? "";
}

it("folds twelve tools across five silent model rounds into one direct operation disclosure", async () => {
	let nextId = 0;
	const messages = [2, 3, 3, 2, 2].map((count, index) => assistant(`silent-round-${index}`, Array.from({ length: count }, () => tool(`silent-${nextId++}`)), { thinking: `隐藏思考 ${index}` }));
	await render({ entries: turn(...messages, assistant("answer", [], { text: "看完了，给你一个概览。" })), activity: "idle" });
	expect(host.querySelectorAll(".owl-work-process-summary")).toHaveLength(1);
	expect(host.querySelectorAll(".owl-work-history-toggle, .owl-tool-group-summary")).toHaveLength(0);
	expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(0);
	expect(visibleText()).not.toMatch(/执行了.*工具调用|隐藏思考/);
	await click(".owl-work-process-summary");
	expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(12);
	expect(host.querySelectorAll(".owl-work-history-toggle, .owl-tool-group-summary")).toHaveLength(0);
});

it("keeps finished historical errors in the disclosure without pinning stale output before the answer", async () => {
	const failed = tool("missing", "error", "Path not found: D:/owl/owl-re-v1/packages");
	const corrected = tool("correct-path", "ok", "owl-mono/packages exists");
	await render({ entries: turn(assistant("work", [failed, corrected]), assistant("answer", [], { text: "项目根目录已经确认。" })), activity: "idle" });
	expect(host.querySelector(".owl-work-latest-state")).toBeNull();
	expect(host.querySelector(".owl-work-issue-tail")).toBeNull();
	// 结束态不再显示失败角标；历史错误仍在工具记录详情里可查。
	expect(host.querySelector(".owl-work-issue-link")).toBeNull();
	expect(visibleText()).not.toContain("Path not found");
	expect(visibleText()).not.toContain("重试成功");
	await click(".owl-work-process-summary");
	expect(host.querySelector('[data-tool-id="missing"]')?.getAttribute("data-status")).toBe("error");
});

it("keeps compact tool headers to one action and exposes the full-output action inside the details", async () => {
	const onInspectTool = vi.fn();
	const call = tool("single-line");
	await render({ entries: turn(assistant("work", [call])), onInspectTool, activity: "idle" });
	await click(".owl-work-process-summary");
	const row = host.querySelector('[data-tool-id="single-line"]')!;
	expect(row.querySelector(".owl-work-action-detail")).toBeNull();
	expect(row.querySelector(".owl-work-inspect")).toBeNull();
	expect(row.querySelector(".owl-tool-summary")?.getAttribute("title")).toBe(call.detail);
	await click('[data-tool-id="single-line"] .owl-tool-summary');
	expect(row.querySelector(".owl-tool-detail .owl-work-inspect")).not.toBeNull();
	await click('[data-tool-id="single-line"] .owl-tool-detail .owl-work-inspect');
	expect(onInspectTool).toHaveBeenCalledExactlyOnceWith(call, 1);
});

it("keeps finished cancellation in the original records while normal history stays folded", async () => {
	const output = ["first", "second", "third", "fourth", "取消前的原始输出"].join("\n");
	await render({ entries: turn(assistant("work", [tool("old"), tool("current", "cancelled", output)])), activity: "idle" });
	expect(host.querySelector(".owl-work-process-summary")?.getAttribute("aria-expanded")).toBe("false");
	expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(0);
	expect(host.querySelector(".owl-work-latest-state, .owl-work-issue-tail")).toBeNull();
	expect(visibleText()).not.toMatch(/已通过|100%|剩余.*秒/);
	expect(host.querySelector(".owl-work-metadata")?.textContent).not.toMatch(/\d+s/);
	await click(".owl-work-process-summary");
	expect(host.querySelector('[data-tool-id="current"]')?.getAttribute("data-status")).toBe("cancelled");
	await click('[data-tool-id="current"] .owl-tool-summary');
	expect(host.querySelector('[data-tool-id="current"] .owl-tool-output')?.textContent).toBe(output);
});

it("separates waiting for the model from waiting for the person", async () => {
	await render({ entries: turn(assistant("work", [tool("returned")])), activity: "working" });
	expect(host.querySelector(".owl-work-primary")?.textContent).toBe("等待模型响应");
	await render({ activity: "waiting" });
	expect(host.querySelector(".owl-work-primary")?.textContent).toBe("等待你的确认或回答");
	expect(host.querySelector(".owl-work-process")?.getAttribute("data-state")).toBe("waiting");
});

it("opens original tool records and all command output by default in verbose, retaining an explicit fold after completion", async () => {
	const output = ["HEAD_ORIGINAL", ...Array.from({ length: 30 }, (_, index) => `line-${index}`)].join("\n");
	const call = tool("long", "running", output);
	await render({ executionView: "verbose", entries: turn(assistant("work", [call])) });
	expect(host.querySelector(".owl-work-process-summary")?.getAttribute("aria-expanded")).toBe("true");
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-summary')?.getAttribute("aria-expanded")).toBe("true");
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-output')?.textContent).toBe(output);
	await click('[data-tool-id="long"] .owl-tool-summary');
	await render({ entries: turn(assistant("work", [{ ...call, status: "ok" }]), assistant("answer", [], { text: "真实最终答案" })), activity: "idle" });
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-summary')?.getAttribute("aria-expanded")).toBe("false");
	await render({ executionView: "normal" });
	await render({ executionView: "verbose" });
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-summary')?.getAttribute("aria-expanded")).toBe("false");
});

it("retains the manual output preview when verbose is left and entered again", async () => {
	const output = Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n");
	await render({ executionView: "verbose", entries: turn(assistant("work", [tool("long", "ok", output)])), activity: "idle" });
	await click('[data-tool-id="long"] .owl-work-output-toggle');
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-output')?.textContent).not.toContain("line-0\n");
	await render({ executionView: "normal" });
	await render({ executionView: "verbose" });
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-output')?.textContent).not.toContain("line-0\n");
});

it("returns automatically expanded history to normal defaults after leaving verbose", async () => {
	await render({ entries: turn(assistant("work", [tool("first"), tool("second")])), activity: "idle" });
	await render({ executionView: "verbose" });
	expect(host.querySelector(".owl-work-process-summary")?.getAttribute("aria-expanded")).toBe("true");
	expect(host.querySelectorAll('.owl-tool-summary[aria-expanded="true"]')).toHaveLength(3);
	await render({ executionView: "normal" });
	expect(host.querySelector(".owl-work-process-summary")?.getAttribute("aria-expanded")).toBe("false");
	expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(0);
	expect(host.querySelector(".owl-work-issue-tail")).toBeNull();
});

it("retains a manually opened process while automatic tool and output expansion returns to normal", async () => {
	const output = ["ORIGINAL_HEAD", ...Array.from({ length: 30 }, (_, index) => `line-${index}`)].join("\n");
	await render({ entries: turn(assistant("work", [tool("long", "ok", output)])), activity: "idle" });
	await click(".owl-work-process-summary");
	await render({ executionView: "verbose" });
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-output')?.textContent).toBe(output);
	await render({ executionView: "normal" });
	expect(host.querySelector(".owl-work-process-summary")?.getAttribute("aria-expanded")).toBe("true");
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-summary')?.getAttribute("aria-expanded")).toBe("false");
	await click('[data-tool-id="long"] .owl-tool-summary');
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-output')?.textContent).not.toContain("ORIGINAL_HEAD");
	await render({ executionView: "verbose" });
	await render({ executionView: "normal" });
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-summary')?.getAttribute("aria-expanded")).toBe("true");
	expect(host.querySelector('[data-tool-id="long"] .owl-tool-output')?.textContent).not.toContain("ORIGINAL_HEAD");
});

it("exposes only real thinking segments in thinking view without unfolding tools", async () => {
	await render({ entries: turn(assistant("work", [tool("read")], { thinking: "模型实际返回的思考 <original>" })) });
	expect(host.querySelector(".owl-thinking")).toBeNull();
	await render({ executionView: "thinking" });
	expect(host.querySelector(".owl-thinking pre")?.textContent).toBe("模型实际返回的思考 <original>");
	expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(0);
	await click(".owl-thinking button");
	expect(visibleText()).toContain("模型实际返回的思考 <original>");
	await render({ executionView: "normal" });
	await render({ executionView: "thinking", activity: "idle" });
	expect(host.querySelector(".owl-thinking button")?.getAttribute("aria-expanded")).toBe("true");
	await render({ entries: turn(assistant("no-thinking", [tool("read")])) });
	expect(host.querySelector(".owl-thinking")).toBeNull();
});

it("retains manual thinking expansion through streaming text growth and persisted entry IDs", async () => {
	await render({ executionView: "thinking", entries: turn(assistant("", [tool("read", "running")], { entryId: undefined, thinking: "正在核对第一处" })) });
	await click(".owl-thinking button");
	await render({ executionView: "normal" });
	await render({ entries: turn(assistant("", [tool("read", "running")], { entryId: undefined, thinking: "正在核对第一处，然后检查第二处" })) });
	await render({ executionView: "thinking" });
	expect(host.querySelector(".owl-thinking button")?.getAttribute("aria-expanded")).toBe("true");
	await render({ executionView: "normal" });
	await render({ entries: turn(assistant("persisted-work", [tool("read")], { thinking: "正在核对第一处，然后检查第二处，核对结束" }), assistant("answer", [], { text: "核对结果" })), activity: "idle" });
	await render({ executionView: "thinking" });
	expect(host.querySelector(".owl-thinking button")?.getAttribute("aria-expanded")).toBe("true");
	expect(visibleText()).toContain("正在核对第一处，然后检查第二处，核对结束");
});

it("opens the exact tool owner in the workspace from the failure tail", async () => {
	const onInspectTool = vi.fn();
	const first = tool("shared", "ok", "earlier owner");
	const last = tool("shared", "error", "原始失败输出");
	await render({ onInspectTool, entries: turn(assistant("first", [first]), assistant("last", [last])) });
	await click(".owl-work-issue-tail");
	expect(onInspectTool).toHaveBeenCalledExactlyOnceWith(last, 2);
	expect(host.querySelector(".owl-work-latest-state")?.textContent).toContain("执行失败");
	expect(host.querySelector(".owl-work-latest-state")?.textContent).not.toContain("已完成");
});

it("keeps a non-zero check visible during work until the identical check succeeds, then retains history on finish", async () => {
	const failed: ToolCard = { id: "failed-check", name: "bash", args: '{"command":"npm run check"}', summary: "运行项目检查", detail: "npm run check", status: "error", output: { text: "ChatStream.tsx(18,4): error TS2339\nCommand exited with code 2", totalLines: 2 } };
	const unrelated = tool("different-operation", "ok", "后台任务已启动");
	const onInspectTool = vi.fn();
	await render({ onInspectTool, entries: turn(assistant("work", [failed, unrelated])), activity: "working" });
	expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(0);
	expect(host.querySelector(".owl-work-latest-state")?.textContent).toContain("执行结果待核对");
	expect(host.querySelector(".owl-work-latest-state")?.textContent).toContain("运行项目检查");
	expect(host.querySelector(".owl-work-latest-state")?.textContent).toContain("执行失败");
	expect(host.querySelector(".owl-work-issue-tail")?.textContent).toBe(failed.output!.text);
	await click(".owl-work-issue-tail");
	expect(onInspectTool).toHaveBeenCalledExactlyOnceWith(failed, 1);
	const recovered: ToolCard = { ...failed, id: "successful-retry", status: "ok", output: { text: "相同检查已返回退出码 0", totalLines: 1 } };
	await render({ entries: turn(assistant("work", [failed, unrelated, recovered])) });
	expect(host.querySelector(".owl-work-latest-state")?.textContent).not.toContain("执行结果待核对");
	expect(host.querySelector(".owl-work-latest-state")?.textContent).toContain("已完成");
	// 重试成功后失败末行随之撤下：运行中的常驻信息只留给还没被修复的失败。
	expect(host.querySelector(".owl-work-issue-tail")).toBeNull();
	expect(visibleText()).toContain("1 项操作重试成功");
	await render({ activity: "idle" });
	expect(host.querySelector(".owl-work-latest-state, .owl-work-issue-tail")).toBeNull();
});

it.each(["normal", "thinking", "verbose"] as ExecutionView[])("keeps progress, tool groups and the final answer in real order in %s", async (executionView) => {
	await render({ executionView, activity: "idle", entries: turn(
		assistant("intro", [tool("inspect")], { text: "先检查当前实现。", segments: [{ kind: "text", text: "先检查当前实现。" }, { kind: "tool", toolId: "inspect" }] }),
		assistant("discovery", [tool("edit")], { text: "发现状态误判，接着修复分支。", segments: [{ kind: "text", text: "发现状态误判，接着修复分支。" }, { kind: "tool", toolId: "edit" }] }),
		assistant("final", [], { text: "已修复，结果如下。" }),
	) });
	const sequence = [...host.querySelector(".owl-chat-column")!.children].flatMap((row) => row.querySelector(".owl-work-process") ? [...row.querySelectorAll(".owl-work-process-body > .owl-work-process-item")].map((item) => item.getAttribute("data-work-kind") === "note" ? "note:" + item.textContent?.trim() : "tool-group") : []);
	// 一轮只有一个折叠行：说明与工具组同处其中，并按真实顺序交错。
	// 折叠状态下工具行收起，公开进展仍然可见。
	expect(sequence).toEqual(executionView === "verbose" ? ["note:先检查当前实现。", "tool-group", "note:发现状态误判，接着修复分支。", "tool-group"] : ["note:先检查当前实现。", "note:发现状态误判，接着修复分支。"]);
	expect(visibleText()).toContain("先检查当前实现。");
	expect(visibleText()).toContain("发现状态误判，接着修复分支。");
	expect(host.querySelectorAll('[data-owl-answer="true"]')).toHaveLength(1);
	expect(host.querySelector('[data-owl-answer="true"]')?.textContent).toContain("已修复，结果如下。");
	if (executionView !== "verbose") {
		expect(host.querySelectorAll(".owl-work-history-toggle")).toHaveLength(0);
		expect(host.querySelectorAll(".owl-work-process-summary")).toHaveLength(1);
		expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(0);
	}
});

it("treats a commentary-only segment as visible progress even before any tool exists", async () => {
	await render({ entries: turn(assistant("commentary", [], { text: "我先确认两个调用点。", segments: [{ kind: "text", text: "我先确认两个调用点。", phase: "commentary" }] })) });
	expect(visibleText()).toContain("我先确认两个调用点。");
	expect(host.querySelector('[data-owl-answer="true"]')).toBeNull();
	expect(host.querySelector('[data-work-kind="note"]')?.textContent).toContain("我先确认两个调用点。");
});

it("preserves keyboard focus and the opened output when progress splits an existing tool group", async () => {
	let activeElement: Element = document.body;
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => activeElement });
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function(this: HTMLElement) { activeElement = this; });
	const first = tool("first");
	const second = tool("second", "running", "保留正在读的真实输出");
	await render({ executionView: "verbose", entries: turn(assistant("work", [first, second])) });
	const focused = host.querySelector<HTMLButtonElement>('[data-tool-id="second"] .owl-work-record-toolbar button')!;
	focused.focus();
	expect(document.activeElement).toBe(focused);
	await render({ entries: turn(assistant("work", [first, { ...second, status: "ok" }], { text: "发现新的调用点，接着核对。", segments: [{ kind: "tool", toolId: "first" }, { kind: "text", text: "发现新的调用点，接着核对。" }, { kind: "tool", toolId: "second" }] }), assistant("answer", [], { text: "已完成本轮核对。" })), activity: "idle" });
	expect(document.activeElement).not.toBe(focused);
	expect(document.activeElement?.closest('[data-tool-id="second"]')).not.toBeNull();
	expect(host.querySelector('[data-tool-id="second"] .owl-tool-output')?.textContent).toBe("保留正在读的真实输出");
});

it("keeps the same process and read output mounted when a later silent round adds hidden thinking", async () => {
	const first = tool("already-reading", "ok", "正在查阅的输出原文");
	await render({ entries: turn(assistant("first-owner", [first])) });
	await click(".owl-work-process-summary");
	await click('[data-tool-id="already-reading"] .owl-tool-summary');
	const process = host.querySelector(".owl-work-process");
	const row = host.querySelector('[data-tool-id="already-reading"]');
	await render({ entries: turn(assistant("first-owner", [first]), assistant("later-owner", [tool("later", "running")], { thinking: "后续模型实际返回的隐藏思考" })) });
	expect(host.querySelector(".owl-work-process")).toBe(process);
	expect(host.querySelector('[data-tool-id="already-reading"]')).toBe(row);
	expect(row?.querySelector(".owl-tool-output")?.textContent).toBe("正在查阅的输出原文");
	expect(host.querySelectorAll(".owl-work-process-summary")).toHaveLength(1);
	expect(host.querySelectorAll(".owl-work-history-toggle")).toHaveLength(0);
});

it("keeps a thinking-only process and its focused disclosure mounted when its first tool arrives", async () => {
	let activeElement: Element = document.body;
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => activeElement });
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function(this: HTMLElement) { activeElement = this; });
	await render({ executionView: "thinking", entries: turn(assistant("thinking-owner", [], { thinking: "第一段真实思考" })) });
	await click(".owl-thinking button");
	const process = host.querySelector(".owl-work-process");
	const disclosure = host.querySelector<HTMLButtonElement>(".owl-thinking button")!;
	const original = host.querySelector(".owl-thinking pre");
	disclosure.focus();
	await render({ entries: turn(assistant("thinking-owner", [tool("first", "running")], { thinking: "第一段真实思考，接着执行" })) });
	expect(host.querySelector(".owl-work-process")).toBe(process);
	expect(host.querySelector(".owl-thinking button")).toBe(disclosure);
	expect(host.querySelector(".owl-thinking pre")).toBe(original);
	expect(document.activeElement).toBe(disclosure);
	expect(disclosure.getAttribute("aria-expanded")).toBe("true");
});
