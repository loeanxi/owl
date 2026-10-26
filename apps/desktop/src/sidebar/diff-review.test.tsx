import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage } from "../i18n/index.ts";
import type { SidebarApi } from "./api.ts";
import { DiffReview } from "./DiffReview.tsx";
import { diffReviewText as copy } from "./diff-review-copy.ts";
import { ExecutionContext, type ExecutionContextValue } from "./execution-context.tsx";
import type { TabComponentProps } from "./registry.ts";
import { SidebarStore } from "./store.ts";
import { ChangesTab } from "./tabs/ChangesTab.tsx";
import { focusChangesFile } from "./changes-focus.ts";

const firstDiff = [
	"diff --git a/src/first.ts b/src/first.ts", "--- a/src/first.ts", "+++ b/src/first.ts", "@@ -10,3 +20,3 @@",
	" const context = true;", "-const oldFirst = 1;", "+const newFirst = 2;", " const tail = true;",
].join("\n");
const secondDiff = [
	"diff --git a/src/second.ts b/src/second.ts", "--- a/src/second.ts", "+++ b/src/second.ts", "@@ -30,3 +40,3 @@",
	" const secondContext = true;", "-const oldSecond = 3;", "+const newSecond = 4;", " const secondTail = true;",
].join("\n");

let root: Root;
let container: HTMLElement;
let gitDiff: ReturnType<typeof vi.fn<SidebarApi["gitDiff"]>>;
let submit: ReturnType<typeof vi.fn<(text: string) => Promise<boolean>>>;
let context: ExecutionContextValue;
let props: TabComponentProps;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Element", dom.window.Element); vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
	// React is imported before this DOM, so textarea changes use its input polyfill.
	Object.assign(dom.window.HTMLTextAreaElement.prototype, {
		attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
		detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
	});
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	gitDiff = vi.fn<SidebarApi["gitDiff"]>().mockImplementation(async (_cwd, path) => path === "src/first.ts" ? firstDiff : secondDiff);
	submit = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
	context = { sessionId: "source-session", profile: "profile-one", entries: [], subagents: [], onOpenSubagent: vi.fn(), onRefreshSubagents: vi.fn(), onSubmitFeedback: submit };
	props = {
		api: { gitDiff } as unknown as SidebarApi, client: {} as BridgeClient,
		store: new SidebarStore("D:/diff-review"), cwd: "D:/diff-review", profile: "profile-one", tab: { id: "changes", kind: "changes", title: "改动" },
		onOpenFile: vi.fn(), onGitRefresh: vi.fn(), onToChat: vi.fn(),
		gitStatus: { repo: true, entries: [{ path: "src/first.ts", x: " ", y: "M" }, { path: "src/second.ts", x: " ", y: "M" }] },
	};
});

afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function renderChanges(contextPatch: Partial<ExecutionContextValue> = {}, propsPatch: Partial<TabComponentProps> = {}): Promise<void> {
	context = { ...context, ...contextPatch }; props = { ...props, ...propsPatch };
	await act(async () => root.render(<ExecutionContext.Provider value={context}><ChangesTab {...props} /></ExecutionContext.Provider>));
}

async function renderReview(): Promise<void> {
	await act(async () => root.render(<ExecutionContext.Provider value={context}><DiffReview api={props.api} cwd={props.cwd} selected={{ path: "src/first.ts", staged: false }} diff={firstDiff} loading={false} expanded={false} onExpand={vi.fn()} onClose={vi.fn()} onOpenFile={props.onOpenFile} /></ExecutionContext.Provider>));
}

function button(label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
	if (!found) throw new Error(`Missing button: ${label}`);
	return found;
}

async function click(label: string): Promise<void> { await act(async () => button(label).click()); }

async function openFile(path: string): Promise<void> {
	const row = container.querySelector<HTMLElement>(`.group span[title="${path}"]`)!;
	if (!row) throw new Error(`Missing file row: ${path}`);
	await act(async () => row.click());
}

async function addComment(path: string, side: "old" | "new", line: number, text: string): Promise<void> {
	await click(`${copy("comment")} · ${path} · ${copy(side === "old" ? "oldLine" : "newLine", { n: line })}`);
	const textarea = container.querySelector<HTMLTextAreaElement>(".owl-diff-comment-editor textarea")!;
	await act(async () => {
		textarea.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")!.set!.call(textarea, text);
		textarea.dispatchEvent(new window.Event("keyup", { bubbles: true }));
		textarea.dispatchEvent(new window.Event("focusout", { bubbles: true }));
	});
	expect(button(copy("add")).disabled).toBe(false);
	await click(copy("add"));
}

describe("Diff review modes and line anchors", () => {
	it("filters real deleted and added rows in before/after while retaining context", async () => {
		await renderReview();
		const body = (): string => container.querySelector(".owl-diff-review-body")!.textContent!;
		expect(body()).toContain("const oldFirst = 1;"); expect(body()).toContain("const newFirst = 2;");
		await click(copy("before"));
		expect(body()).toContain("const oldFirst = 1;"); expect(body()).not.toContain("const newFirst = 2;"); expect(body()).toContain("const context = true;");
		expect(button(`${copy("comment")} · src/first.ts · ${copy("oldLine", { n: 11 })}`)).toBeTruthy();
		await click(copy("after"));
		expect(body()).not.toContain("const oldFirst = 1;"); expect(body()).toContain("const newFirst = 2;"); expect(body()).toContain("const context = true;");
		expect(button(`${copy("comment")} · src/first.ts · ${copy("newLine", { n: 21 })}`)).toBeTruthy();
	});

	it("attaches deletion comments to old line numbers and additions to new line numbers", async () => {
		await renderReview();
		await addComment("src/first.ts", "old", 11, "这里的删除需要保留兼容处理");
		await addComment("src/first.ts", "new", 21, "这个新值需要配置化");
		// 意见按文件分组：组头是文件名，内层条目才是逐条意见。
		const notes = [...container.querySelectorAll(".owl-diff-comment-list li li")].map((item) => item.textContent);
		expect(notes[0]).toContain("src/first.ts · 修改前第 11 行");
		expect(notes[1]).toContain("src/first.ts · 修改后第 21 行");
		await click(copy("send"));
		expect(submit).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("`src/first.ts:11` (工作区, 修改前)"));
		expect(submit.mock.calls[0][0]).toContain("`src/first.ts:21` (工作区, 修改后)");
	});
});

describe("ChangesTab review collection and acknowledged sending", () => {	it("keeps comments across selected files and validates every snapshot before one batch send", async () => {
		await renderChanges(); await openFile("src/first.ts");
		await addComment("src/first.ts", "old", 11, "第一处删除要说明原因");
		await openFile("src/second.ts");
		await addComment("src/second.ts", "new", 41, "第二处增加边界检查");
		expect(container.querySelectorAll(".owl-diff-comment-list > li")).toHaveLength(2);
		await openFile("src/first.ts");
		expect(container.querySelectorAll(".owl-diff-comment-list > li")).toHaveLength(2);
		gitDiff.mockClear();
		await click(copy("send"));
		expect(gitDiff.mock.calls).toEqual([["D:/diff-review", "src/first.ts", false], ["D:/diff-review", "src/second.ts", false]]);
		expect(submit).toHaveBeenCalledExactlyOnceWith([
			"请按以下改动意见调整代码，先核对对应上下文，并保留其他已有改动。",
			"每条意见前的 `路径:行号` 就是侧边栏指的那一行（行号按括号里写的那一侧计数）；需要用户核对时用同一个锚点指回去即可。",
			"1. `src/first.ts:11` (工作区, 修改前)\n第一处删除要说明原因",
			"2. `src/second.ts:41` (工作区, 修改后)\n第二处增加边界检查",
		].join("\n\n"));
		expect(props.onToChat).not.toHaveBeenCalled();
		expect(container.querySelectorAll(".owl-diff-comment-list > li")).toHaveLength(0);
		expect(container.querySelector('[role="status"]')?.textContent).toBe(copy("sent"));
	});

	it("refuses a changed diff and keeps the complete comments for review", async () => {
		await renderChanges(); await openFile("src/first.ts"); await addComment("src/first.ts", "new", 21, "需要重新核对上下文");
		gitDiff.mockResolvedValueOnce(firstDiff.replace("newFirst = 2", "newFirst = 99"));
		await click(copy("send"));
		expect(submit).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(copy("changed"));
		expect(container.querySelector(".owl-diff-comment-list")?.textContent).toContain("需要重新核对上下文");
		expect(button(copy("send")).disabled).toBe(false);
	});

	it("keeps comments after a rejected real send and clears only on a successful retry", async () => {
		submit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		await renderChanges(); await openFile("src/first.ts"); await addComment("src/first.ts", "new", 21, "保留这条意见待重试");
		await click(copy("send"));
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(copy("failed"));
		expect(container.querySelectorAll(".owl-diff-comment-list > li")).toHaveLength(1);
		await click(copy("send"));
		expect(submit).toHaveBeenCalledTimes(2);
		expect(submit.mock.calls[0][0]).toBe(submit.mock.calls[1][0]);
		expect(container.querySelectorAll(".owl-diff-comment-list > li")).toHaveLength(0);
	});

	it("does not submit after the review unmounts while snapshot validation awaits", async () => {
		await renderChanges(); await openFile("src/first.ts"); await addComment("src/first.ts", "new", 21, "卸载前的意见");
		const pending = Promise.withResolvers<string>(); gitDiff.mockReturnValueOnce(pending.promise);
		await click(copy("send")); expect(submit).not.toHaveBeenCalled();
		await act(async () => root.render(null));
		await act(async () => pending.resolve(firstDiff));
		expect(submit).not.toHaveBeenCalled();
	});

	it.each(["session", "profile", "workspace"] as const)("does not send source comments after %s changes during validation", async (scope) => {
		await renderChanges(); await openFile("src/first.ts"); await addComment("src/first.ts", "new", 21, "原来源的意见");
		const pending = Promise.withResolvers<string>(); gitDiff.mockReturnValueOnce(pending.promise);
		await click(copy("send"));
		const nextSubmit = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
		await renderChanges({ onSubmitFeedback: nextSubmit, ...(scope === "session" ? { sessionId: "other-session" } : scope === "profile" ? { profile: "profile-two" } : {}) }, scope === "profile" ? { profile: "profile-two" } : scope === "workspace" ? { cwd: "D:/other-workspace" } : {});
		await act(async () => pending.resolve(firstDiff));
		expect(submit).not.toHaveBeenCalled(); expect(nextSubmit).not.toHaveBeenCalled();
		expect(container.querySelectorAll(".owl-diff-comment-list > li")).toHaveLength(0);
	});
});

describe("review comment navigation", () => {
	it("locates a comment back to its diff line with a flash", async () => {
		await renderReview();
		await addComment("src/first.ts", "old", 11, "回跳目标一");
		await addComment("src/first.ts", "new", 21, "回跳目标二");
		const items = [...container.querySelectorAll<HTMLButtonElement>(".owl-diff-comment-locate")];
		expect(items).toHaveLength(2);
		await act(async () => items[1]!.click());
		const target = [...container.querySelectorAll<HTMLElement>("[data-diff-target]")].find((node) => node.classList.contains("owl-diff-flash"));
		expect(target?.dataset.diffTarget).toBe(JSON.stringify(["src/first.ts", "new", 21]));
	});

	it("navigates change runs with Alt+Arrow and shows the n/m badge", async () => {
		const multiRun = [
			"diff --git a/src/multi.ts b/src/multi.ts", "--- a/src/multi.ts", "+++ b/src/multi.ts", "@@ -1,6 +1,6 @@",
			" const a = 1;", "-const old1 = 1;", "+const new1 = 1;", " const mid = 2;", "-const old2 = 2;", "+const new2 = 2;", " const z = 3;",
		].join("\n");
		gitDiff.mockImplementation(async (_cwd, path) => path === "src/multi.ts" ? multiRun : secondDiff);
		await renderChanges({}, { gitStatus: { repo: true, entries: [{ path: "src/multi.ts", x: " ", y: "M" }, { path: "src/first.ts", x: " ", y: "M" }, { path: "src/second.ts", x: " ", y: "M" }] } });
		await openFile("src/multi.ts");
		// 两段互不相邻的增删 = 两个变更块；徽标先显示总数。
		expect(container.querySelectorAll("[data-diff-change]")).toHaveLength(2);
		expect(container.querySelector(".owl-diff-change-count")?.textContent).toBe("2");
		const panel = container.querySelector<HTMLElement>(".owl-diff-review")!;
		const press = async (key: string): Promise<void> => {
			const event = new window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperties(event, { key: { value: key }, altKey: { value: true } });
			await act(async () => panel.dispatchEvent(event));
		};
		await press("ArrowDown");
		expect(container.querySelector(".owl-diff-change-count")?.textContent).toBe("1/2");
		const first = [...container.querySelectorAll<HTMLElement>("[data-diff-change]")][0]!;
		expect(first.classList.contains("owl-diff-flash")).toBe(true);
		await press("ArrowDown");
		expect(container.querySelector(".owl-diff-change-count")?.textContent).toBe("2/2");
		await press("ArrowUp");
		expect(container.querySelector(".owl-diff-change-count")?.textContent).toBe("1/2");
	});

	it("jumps across files from a comment group header", async () => {
		await renderChanges();
		await openFile("src/first.ts");
		await addComment("src/first.ts", "old", 11, "第一份的意见");
		await openFile("src/second.ts");
		await addComment("src/second.ts", "new", 41, "第二份的意见");
		// 面板当前在 second.ts：点第一份的组头应切回 first.ts 并落到那一行。
		const head = [...container.querySelectorAll<HTMLButtonElement>(".owl-diff-comment-group-head")].find((item) => item.textContent?.includes("src/first.ts"))!;
		await act(async () => head.click());
		expect(container.querySelector(".owl-diff-review-header span")?.textContent).toBe("src/first.ts");
		expect(gitDiff.mock.calls.at(-1)).toEqual(["D:/diff-review", "src/first.ts", false]);
	});
});
