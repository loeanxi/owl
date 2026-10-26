import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";
import { workProcessText as text } from "./work-process-copy.ts";

const interactive = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn(), action: vi.fn() }));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => <span data-test-response-mascot="" />, useSessionOwlPose: () => "idle" }));
vi.mock("./Genui.tsx", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("./Genui.tsx");
	return { ...actual, GenuiToolCardView: ({ card }: { card: ToolCard }) => {
		const [count, setCount] = React.useState(0);
		React.useEffect(() => { interactive.mounted(card.id); return () => { interactive.unmounted(card.id); }; }, [card.id]);
		return <div className="owl-answer" data-test-work-card={card.id}><button type="button" onClick={() => { setCount((value) => value + 1); interactive.action(card.id); }}>卡片操作 {count}</button></div>;
	} };
});

type Assistant = Extract<ChatEntry, { kind: "assistant" }>;
type Props = React.ComponentProps<typeof ChatStream>;
let root: Root;
let host: HTMLElement;
let props: Props;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let clipboard: ReturnType<typeof vi.fn<(value: string) => Promise<void>>>;
let highlights: Map<string, Set<Range>>;

class LiteralRange {
	startContainer?: Node;
	startOffset = 0;
	endOffset = 0;
	setStart(node: Node, offset: number): void { this.startContainer = node; this.startOffset = offset; }
	setEnd(_node: Node, offset: number): void { this.endOffset = offset; }
	toString(): string { return this.startContainer?.textContent?.slice(this.startOffset, this.endOffset) ?? ""; }
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(30_000);
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
	frames = new Map(); sequence = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id; });
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	clipboard = vi.fn(async () => {});
	vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
	highlights = new Map();
	vi.stubGlobal("CSS", { highlights });
	vi.stubGlobal("Highlight", class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } });
	vi.spyOn(document, "createRange").mockImplementation(() => new LiteralRange() as unknown as Range);
	dom.window.getSelection = () => null;
	dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as MediaQueryList;
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 40, top: 0, left: 0, right: 800, bottom: 40, toJSON: () => ({}) });
	interactive.mounted.mockClear(); interactive.unmounted.mockClear(); interactive.action.mockClear();
	setUiLanguage("zh");
	host = dom.document.getElementById("root")!;
	root = createRoot(host);
	props = { entries: [], sessionId: "work-refinement", cwd: "D:/project", activity: "idle" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function tool(id: string, path: string, status: ToolCard["status"] = "ok", output = `结果 ${path}`): ToolCard {
	return { id, name: "read", args: JSON.stringify({ path }), summary: `读取 \`${path}\``, detail: path, status, startedAt: 2000, ...(status === "running" || status === "pending" ? {} : { finishedAt: 3000 }), output: { text: output, totalLines: output.split("\n").length } };
}
function assistant(entryId: string, tools: ToolCard[], extra: Partial<Assistant> = {}): Assistant {
	return { kind: "assistant", entryId, text: "", thinking: "", tools, timestamp: 2000, ...extra };
}
function turn(...messages: Assistant[]): ChatEntry[] { return [{ kind: "user", entryId: "user-one", text: "检查当前任务", timestamp: 1000 }, ...messages]; }
async function render(overrides: Partial<Props>): Promise<void> { props = { ...props, ...overrides }; await act(async () => root.render(<ChatStream {...props} />)); }
async function click(button: HTMLElement): Promise<void> { await act(async () => button.click()); }
async function flush(): Promise<void> { await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); }); }
function summary(scope: ParentNode = host): HTMLButtonElement { return scope.querySelector<HTMLButtonElement>(".owl-work-process-summary")!; }
function containing(value: string, scope: ParentNode = host): HTMLButtonElement {
	const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(value));
	if (!result) throw new Error(`Missing button ${value}`);
	return result;
}
function visibleText(scope: HTMLElement): string {
	const clone = scope.cloneNode(true) as HTMLElement;
	for (const hidden of clone.querySelectorAll("[hidden]")) hidden.remove();
	for (const details of clone.querySelectorAll("details:not([open])")) for (const child of [...details.children]) if (child.tagName !== "SUMMARY") child.remove();
	// grid 折叠体收起时内容仍在 DOM（overflow 裁切），按开关状态从文本快照剔除。
	for (const body of clone.querySelectorAll(".owl-collapse-body:not([data-open])")) body.remove();
	return clone.textContent ?? "";
}

describe("One process between visible conversation boundaries", () => {
	it("keeps silent tools together and separates pauses, queued follow-ups and the next delivered turn", async () => {
		const queued: ChatEntry = { kind: "user", entryId: "queued-user", text: "排队跟进", queued: true, timestamp: 8000 };
		const messages: ChatEntry[] = [...turn(
			assistant("failed-entry", [tool("failed", "src/first.ts", "error", "第一次失败"), tool("retried", "src/first.ts", "ok", "同一操作重试成功")], { endedAt: 4000 }),
			assistant("paused-entry", [tool("cancelled", "src/paused.ts", "cancelled")], { aborted: true, timestamp: 5000, endedAt: 7000 }),
		), queued, assistant("continued-entry", [tool("resumed", "src/resumed.ts", "running")], { thinking: "继续处理的原始思考", timestamp: 20_000 })];
		await render({ entries: messages, activity: "working" });
		expect(host.querySelectorAll(".owl-work-process")).toHaveLength(2);
		expect(host.querySelectorAll(".owl-work-process-summary")).toHaveLength(2);
		expect(visibleText(host)).toContain("排队跟进");
		expect(host.querySelector(".owl-work-recent, .owl-work-issues")).toBeNull();
		await render({ entries: [...messages, assistant("generating", [], { thinking: "整理最终结论", timestamp: 24_000 })], activity: "working" });
		expect(host.querySelectorAll(".owl-work-process")).toHaveLength(2);
		await render({ entries: [...messages.slice(0, -1), assistant("continued-entry", [tool("resumed", "src/resumed.ts")], { endedAt: 24_000 }), assistant("answer", [], { text: "最终结论", timestamp: 25_000, endedAt: 26_000 })] });
		expect(host.querySelectorAll(".owl-work-process")).toHaveLength(2);
		await render({ entries: [...props.entries, { kind: "user", entryId: "user-two", text: "已送达的第二轮", timestamp: 27_000 }, assistant("second-turn-work", [tool("other-turn", "src/second-turn.ts")], { endedAt: 28_000 })], activity: "idle" });
		expect(host.querySelectorAll(".owl-work-process")).toHaveLength(3);
	});

	it("keeps zero-tool original thinking accessible without a zero-action shell", async () => {
		const thinking = "只有思考的原文 <保留>\n\n第二段";
		await render({ entries: turn(assistant("thinking-only", [], { thinking, endedAt: 5000 })) });
		expect(visibleText(host)).not.toMatch(/0\s*项操作/);
		expect(host.querySelectorAll(".owl-work-process").length).toBeLessThanOrEqual(1);
		if (summary() && summary().getAttribute("aria-expanded") !== "true") await click(summary());
		const original = host.querySelector<HTMLElement>(".owl-thinking")!;
		expect(original).not.toBeNull();
		expect(original.hasAttribute("data-open")).toBe(false);
		expect(original.querySelector("pre")?.textContent).toBe(thinking);
	});

	it("shows a current operation, waiting, completion and review states without duplicating the primary action", async () => {
		await render({ entries: turn(assistant("current", [tool("read-now", "src/current.ts", "running")])), activity: "working" });
		expect(host.querySelector('.owl-work-primary[role="status"]')?.textContent).toContain("current.ts");
		expect(host.querySelectorAll(".owl-work-process-summary")).toHaveLength(1);
		await render({ activity: "waiting" });
		expect(host.querySelector(".owl-work-primary")?.textContent).toContain(text("waiting"));
		await render({ entries: turn(assistant("current", [tool("read-now", "src/current.ts")], { endedAt: 5000 })), activity: "idle" });
		expect(host.querySelector(".owl-work-process")?.getAttribute("data-state")).toBe("finished");
		expect(host.querySelector(".owl-work-primary")?.textContent).toBe(text("process"));
		expect(host.querySelector('.owl-work-primary[role="status"]')).toBeNull();
		await render({ entries: turn(assistant("current", [tool("read-now", "src/missing.ts", "error", "EIO: read failed")], { endedAt: 5000 })) });
		// 结束态不挂失败角标：错误证据保留在工具行状态与记录详情里。
		expect(host.querySelector(".owl-work-issue-link")).toBeNull();
		await render({ entries: turn(assistant("current", [tool("edit-missing", "ghost.txt", "error", "Could not edit file: ghost.txt. Error code: ENOENT."), tool("blocked", "bash", "error", "BLOCKED by CC Safety Net\n\nReason: command analysis failed unexpectedly.")], { endedAt: 5000 })) });
		expect(host.querySelector(".owl-work-issue-link")).toBeNull();
		expect(host.querySelector(".owl-work-issues")).toBeNull();
	});

	it("keeps the merged thinking appendix searchable by the second original message owner", async () => {
		await render({ entries: turn(
			assistant("first-thinking-owner", [], { thinking: "第一段原始思考", endedAt: 3000 }),
			assistant("second-thinking-owner", [], { thinking: "第二段 THINKING_ONLY_NEEDLE 原文", timestamp: 4000, endedAt: 5000 }),
			assistant("answer", [], { text: "最终公开答案", timestamp: 6000, endedAt: 7000 }),
		) });
		const viewport = host.querySelector<HTMLElement>(".owl-chat-scroll")!;
		Object.defineProperties(viewport, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } });
		viewport.scrollTop = 0; viewport.scrollTo = vi.fn();
		expect(visibleText(host)).not.toContain("THINKING_ONLY_NEEDLE");
		await render({ searchTarget: { sessionId: "work-refinement", entryId: "second-thinking-owner", query: "THINKING_ONLY_NEEDLE", requestId: 2 } });
		await flush(); await flush();
		const originals = host.querySelectorAll<HTMLElement>(".owl-thinking");
		expect(originals).toHaveLength(1);
		expect(originals[0]!.hasAttribute("data-open")).toBe(true);
		expect(originals[0]!.querySelector("pre")?.textContent).toBe("第一段原始思考\n\n第二段 THINKING_ONLY_NEEDLE 原文");
		expect(visibleText(host)).toContain("THINKING_ONLY_NEEDLE");
		expect([...highlights.get("owl-message-search") ?? []].map(String)).toContain("THINKING_ONLY_NEEDLE");
		expect(host.querySelector('[data-search-match="true"]')?.getAttribute("data-entry-id")).toBe("second-thinking-owner");
	});
});

describe("Readable tool records without losing evidence", () => {
	it("uses a single basename action with the real path in its title and expandable input", async () => {
		const path = "D:/project/一层/deep/中文 file.ts";
		const calls = (["read", "write", "edit"] as const).map((name) => ({ ...tool(name, path), name, args: JSON.stringify({ path, content: "unchanged fixture" }), summary: `${name} \`${path}\`` }));
		const onOpenFile = vi.fn();
		await render({ entries: turn(assistant("files", calls)), onOpenFile });
		await click(summary());
		for (const [index, name] of (["read", "write", "edit"] as const).entries()) {
			const row = host.querySelector<HTMLElement>(`[data-tool-id="${name}"]`)!;
			const toggle = row.querySelector<HTMLButtonElement>(".owl-tool-summary")!;
			const title = toggle.querySelector<HTMLElement>(".owl-work-action-title")!;
			expect(title.textContent).toBe(["读取", "写入", "编辑"][index] + " 中文 file.ts");
			expect(title.querySelector("code.owl-path-chip, a")).toBeNull();
			expect(row.querySelector(".owl-work-action-detail")).toBeNull();
			expect(toggle.getAttribute("title")).toBe(path);
			await click(title);
			expect(onOpenFile).toHaveBeenCalledTimes(index);
			expect(row.querySelector('[data-work-record="command"] pre')?.textContent).toBe(path);
			await click(row.querySelector<HTMLElement>('.owl-tool-detail code.owl-path-chip')!);
			expect(onOpenFile).toHaveBeenLastCalledWith("一层/deep/中文 file.ts");
		}
		expect(onOpenFile).toHaveBeenCalledTimes(3);
	});

	it("omits empty response chrome in every state; the global status row is retired", async () => {
		await render({ entries: turn(assistant("active", [tool("now", "src/now.ts", "running")])), activity: "working" });
		expect(host.querySelector('.owl-work-primary[role="status"]')).not.toBeNull();
		expect(host.querySelector(".owl-response-activity")).toBeNull();
		expect(host.querySelector(".owl-response-mark")).toBeNull();
		await render({ entries: turn(assistant("active", [tool("now", "src/now.ts", "running")], { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } })) });
		expect(host.querySelector(".owl-response-activity")).toBeNull();
		await render({ entries: turn(assistant("generating-only", [])), activity: "working" });
		expect(host.querySelector(".owl-work-process")).toBeNull();
		expect(host.querySelector(".owl-response-activity")).toBeNull();
		expect(host.querySelector(".owl-response-mark")).toBeNull();
		expect(host.querySelector("[data-test-response-mascot]")).toBeNull();
	});

	it("shows the final sixteen output lines first, preserves full original text and copies command/output separately", async () => {
		const command = 'git diff -- "src/中文 file.ts"\n  echo "<结束>"';
		const output = Array.from({ length: 22 }, (_, index) => `line-${index + 1} <tag> 中文`).join("\n") + "\n\n";
		const call: ToolCard = { id: "command", name: "bash", args: JSON.stringify({ command }), summary: "执行 git diff · src/中文 file.ts", detail: command, status: "ok", output: { text: output, totalLines: 24 } };
		await render({ entries: turn(assistant("commands", [call, tool("another", "src/another.ts", "ok", "另一项可继续阅读")])) });
		await click(summary());
		const row = host.querySelector<HTMLElement>('[data-tool-id="command"]')!;
		expect(row.querySelector(".owl-tool-summary")?.textContent).toContain("git diff");
		expect(row.querySelector(".owl-tool-summary")?.textContent).toContain("中文 file.ts");
		await click(row.querySelector<HTMLButtonElement>(".owl-tool-summary")!);
		const commandRecord = row.querySelector<HTMLElement>('[data-work-record="command"]')!;
		const outputRecord = row.querySelector<HTMLElement>('[data-work-record="output"]')!;
		expect(commandRecord.querySelector("pre")?.textContent).toBe(command);
		const preview = outputRecord.querySelector("pre")?.textContent ?? "";
		expect(preview).toContain("line-22");
		expect(preview).not.toContain("line-1 ");
		expect(preview.endsWith(output.split("\n").slice(-16).join("\n"))).toBe(true);
		await click(commandRecord.querySelector<HTMLButtonElement>(".owl-message-copy button")!);
		await click(outputRecord.querySelector<HTMLButtonElement>(".owl-message-copy button")!);
		expect(clipboard.mock.calls.map(([value]) => value)).toEqual([command, output]);
		await click(outputRecord.querySelector<HTMLButtonElement>(".owl-work-output-toggle")!);
		expect(outputRecord.querySelector("pre")?.textContent).toBe(output);
		await click(containing("收起全文", outputRecord));
		expect(outputRecord.querySelector("pre")?.textContent).not.toContain("line-1 ");
		await click(host.querySelector<HTMLButtonElement>('[data-tool-id="another"] .owl-tool-summary')!);
		expect(host.querySelector('[data-tool-id="another"] .owl-tool-output')?.textContent).toBe("另一项可继续阅读");
	});

	it("shows no failure badge when different assistant entries reuse the same tool id", async () => {
		await render({ entries: turn(
			assistant("other-owner", [tool("same-id", "src/other.ts", "ok", "OTHER OWNER BODY")], { endedAt: 4000 }),
			assistant("failed-owner", [tool("same-id", "src/missing.ts", "error", "FAILED OWNER BODY")], { endedAt: 5000 }),
		) });
		expect(host.querySelector(".owl-work-issue-link")).toBeNull();
		const viewport = host.querySelector<HTMLElement>(".owl-chat-scroll")!;
		Object.defineProperties(viewport, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } });
		viewport.scrollTop = 0; viewport.scrollTo = vi.fn();
		await click(summary());
		await flush(); await flush();
		const rows = [...host.querySelectorAll<HTMLElement>('[data-tool-id="same-id"]')];
		expect(rows).toHaveLength(2);
		const failure = rows.find((row) => row.dataset.toolOwner === "2")!;
		const other = rows.find((row) => row.dataset.toolOwner === "1")!;
		// 证据仍在：失败行自身展开即可查看输出，不依赖角标导航。
		await click(failure.querySelector<HTMLButtonElement>(".owl-tool-summary")!);
		expect(failure.querySelector(".owl-tool-output")?.textContent).toBe("FAILED OWNER BODY");
		expect(other.querySelector(".owl-tool-summary")?.getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps expanded-record preferences in preview mode but reveals a searched head-only hit in full", async () => {
		document.documentElement.dataset.owlToolRecords = "expanded";
		const output = ["HEAD_ONLY_NEEDLE", ...Array.from({ length: 82 }, (_, index) => `long-output-line-${index + 2}`)].join("\n");
		await render({ entries: turn(
			assistant("historical-worker", [tool("long-record", "src/long.ts", "ok", output)], { endedAt: 4000 }),
			assistant("final-answer", [], { text: "当前结论", timestamp: 5000, endedAt: 6000 }),
		) });
		await click(summary());
		const record = host.querySelector<HTMLElement>('[data-tool-id="long-record"]')!;
		expect(record.querySelector(".owl-tool-summary")?.getAttribute("aria-expanded")).toBe("true");
		expect(record.querySelector(".owl-tool-output")?.textContent).not.toContain("HEAD_ONLY_NEEDLE");
		expect(record.querySelector(".owl-tool-output")?.textContent?.endsWith(output.split("\n").slice(-16).join("\n"))).toBe(true);
		const viewport = host.querySelector<HTMLElement>(".owl-chat-scroll")!;
		Object.defineProperties(viewport, { clientHeight: { value: 400 }, scrollHeight: { value: 6000 } });
		viewport.scrollTop = 0; viewport.scrollTo = vi.fn();
		await render({ searchTarget: { sessionId: "work-refinement", entryId: "historical-worker", query: "HEAD_ONLY_NEEDLE", requestId: 1 } });
		await flush(); await flush();
		expect(record.querySelector(".owl-tool-output")?.textContent).toBe(output);
		expect([...highlights.get("owl-message-search") ?? []].map(String)).toContain("HEAD_ONLY_NEEDLE");
		expect(host.querySelector('[data-search-match="true"]')?.getAttribute("data-entry-id")).toBe("historical-worker");
	});

	it("does not offer an answer jump before a real final answer exists", async () => {
		await render({ entries: turn(assistant("work", [tool("first", "src/first.ts")], { endedAt: 5000 })) });
		await click(summary());
		expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes(text("viewAnswer")))).toBe(false);
		await render({ entries: [...props.entries, assistant("answer", [], { text: "可定位的最终答案", timestamp: 6000, endedAt: 7000 })] });
		expect(host.querySelector('[data-owl-answer="true"]')?.textContent).toContain("可定位的最终答案");
		expect(containing(text("viewAnswer"))).toBeDefined();
	});

	it("keeps the answer jump in the open process foot and collapses back to the summary", async () => {
		await render({ entries: turn(
			assistant("work", [tool("first", "src/first.ts")], { endedAt: 4000 }),
			assistant("answer", [], { text: "完整答案就在过程下面", timestamp: 5000, endedAt: 6000 }),
		) });
		expect(host.querySelector(".owl-work-process-header")?.textContent).not.toContain(text("viewAnswer"));
		expect(host.querySelector(".owl-work-process-foot")).toBeNull();
		await click(summary());
		const foot = host.querySelector<HTMLElement>(".owl-work-process-foot")!;
		expect(containing(text("viewAnswer"), foot)).toBeDefined();
		const viewport = host.querySelector<HTMLElement>(".owl-chat-scroll")!;
		Object.defineProperties(viewport, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } });
		viewport.scrollTop = 500;
		viewport.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
		viewport.scrollTo = vi.fn((options: ScrollToOptions) => { viewport.scrollTop = options.top ?? 0; });
		const main = summary();
		main.getBoundingClientRect = () => ({ top: 700 - viewport.scrollTop } as DOMRect);
		const focus = vi.spyOn(main, "focus");
		await click(containing(text("collapse"), foot));
		await flush(); await flush();
		expect(main.getAttribute("aria-expanded")).toBe("false");
		expect(host.querySelector(".owl-work-process-foot")).toBeNull();
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 684, behavior: "instant" });
	});

	it("preserves hard-failure classification separately from non-zero shell exits and read-gate blocks", async () => {
		const exit: ToolCard = { id: "exit", name: "bash", args: '{"command":"grep needle file"}', summary: "grep", status: "error", output: { text: "no matches\nCommand exited with code 1", totalLines: 2 } };
		const blocked: ToolCard = { id: "blocked", name: "write", args: '{"path":"a.ts","content":"x"}', summary: "write a.ts", status: "error", output: { text: "[Current file content follows. It counts as your read of this file", totalLines: 1 } };
		await render({ entries: turn(assistant("classifications", [exit, blocked, tool("hard", "missing.ts", "error", "ENOENT")])) });
		expect(host.querySelector(".owl-work-process")?.getAttribute("data-failed-count")).toBe("1");
		await click(summary());
		expect(host.querySelector('[data-tool-id="exit"]')?.getAttribute("data-error-kind")).toBe("exit");
		expect(host.querySelector('[data-tool-id="blocked"]')?.getAttribute("data-error-kind")).toBe("blocked");
		expect(host.querySelector('[data-tool-id="hard"]')?.getAttribute("data-error-kind")).toBe("failed");
	});

	it("keeps an interactive render card mounted and usable between ordinary tools across process toggles", async () => {
		const card: ToolCard = { id: "interactive", name: "render_ui", args: "{}", summary: "交互结果", status: "ok", output: { text: "", totalLines: 0, genuiSpec: { items: [] } } };
		await render({ entries: turn(
			assistant("mixed", [tool("before", "src/before.ts"), card, tool("after", "src/after.ts")], { text: "中间公开说明", segments: [{ kind: "tool", toolId: "before" }, { kind: "text", text: "中间公开说明" }, { kind: "tool", toolId: "interactive" }, { kind: "tool", toolId: "after" }] }),
			assistant("final", [], { text: "最终答复", timestamp: 5000, endedAt: 6000 }),
		) });
		const widget = host.querySelector<HTMLElement>('[data-test-work-card="interactive"]')!;
		expect(widget.closest('[data-work-kind="interactive"]')).not.toBeNull();
		expect(widget.closest("[hidden]")).toBeNull();
		await click(widget.querySelector("button")!);
		expect(widget.textContent).toContain("卡片操作 1");
		for (const toggle of host.querySelectorAll<HTMLButtonElement>(".owl-work-process-summary")) await click(toggle);
		expect([...host.querySelectorAll<HTMLElement>('[data-tool-id="before"], [data-work-kind="note"] .owl-answer-reading, [data-test-work-card], [data-tool-id="after"]')].map((node) => node.dataset.toolId ?? node.dataset.testWorkCard ?? "note")).toEqual(["before", "note", "interactive", "after"]);
		await click(summary());
		expect(host.querySelector('[data-test-work-card="interactive"]')).toBe(widget);
		expect(widget.closest("[hidden]")).toBeNull();
		await click(widget.querySelector("button")!);
		expect(widget.textContent).toContain("卡片操作 2");
		expect(interactive.mounted).toHaveBeenCalledExactlyOnceWith("interactive");
		expect(interactive.unmounted).not.toHaveBeenCalled();
		expect(interactive.action).toHaveBeenCalledTimes(2);
	});
});
