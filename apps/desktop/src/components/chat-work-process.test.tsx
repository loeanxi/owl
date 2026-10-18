import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

type Props = React.ComponentProps<typeof ChatStream>;
type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;

let root: Root;
let host: HTMLElement;
let props: Props;
let clipboard: ReturnType<typeof vi.fn>;

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
	clipboard = vi.fn(async () => {});
	vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
	dom.window.getSelection = () => null;
	dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as MediaQueryList;
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 40, top: 0, left: 0, right: 800, bottom: 40, toJSON: () => ({}) });
	setUiLanguage("zh");
	host = document.getElementById("root")!;
	root = createRoot(host);
	props = { entries: [], sessionId: "work-session", activity: "working" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function readTool(id: string, path: string, status: ToolCard["status"] = "ok", output = `已读取 ${path}`): ToolCard {
	return {
		id, name: "read", args: JSON.stringify({ path }), summary: `读取 \`${path}\``, detail: path, status,
		startedAt: 2000,
		...(status === "running" || status === "pending" ? {} : { finishedAt: 3000 }),
		output: { text: output, totalLines: output.split("\n").length },
	};
}

function assistant(entryId: string, tools: ToolCard[], extra: Partial<AssistantEntry> = {}): AssistantEntry {
	return { kind: "assistant", entryId, text: "", thinking: "", tools, timestamp: 2000, ...extra };
}

function turn(...entries: AssistantEntry[]): ChatEntry[] {
	return [{ kind: "user", entryId: "question-entry", text: "检查会话的工作过程与答案", timestamp: 1000 }, ...entries];
}

async function render(overrides: Partial<Props>): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<ChatStream {...props} />));
}

async function click(button: HTMLButtonElement): Promise<void> {
	await act(async () => button.click());
}

function visibleText(scope: HTMLElement = host): string {
	const clone = scope.cloneNode(true) as HTMLElement;
	for (const hidden of clone.querySelectorAll("[hidden]")) hidden.remove();
	for (const details of clone.querySelectorAll("details:not([open])")) for (const child of [...details.children]) if (child.tagName !== "SUMMARY") child.remove();
	// grid 折叠体收起时内容仍在 DOM（overflow 裁切），按开关状态从文本快照剔除。
	for (const body of clone.querySelectorAll(".owl-collapse-body:not([data-open])")) body.remove();
	return clone.textContent ?? "";
}

function processToggle(scope: ParentNode = host): HTMLButtonElement {
	return scope.querySelector<HTMLButtonElement>(".owl-work-process-summary")!;
}

describe("working through a turn in the real conversation", () => {
	it("shows one current action without a duplicated recent summary or default original-thinking disclosure", async () => {
		const tools = [
			readTool("old", "src/earliest.ts"),
			readTool("recent-one", "src/recent-one.ts"),
			readTool("recent-two", "src/recent-two.ts"),
			readTool("recent-three", "src/recent-three.ts"),
			readTool("current", "src/current.ts", "running"),
		];
		await render({ entries: turn(assistant("work-entry", tools, { thinking: "原始思考内容不应默认铺开" })) });
		expect(host.querySelector('.owl-work-primary[role="status"]')?.textContent).toContain("current.ts");
		expect(host.querySelectorAll(".owl-work-process-summary")).toHaveLength(1);
		expect(host.querySelector('[aria-label="最近进展"]')).toBeNull();
		expect(processToggle().getAttribute("aria-expanded")).toBe("false");
		expect(visibleText()).not.toContain("原始思考内容不应默认铺开");
		await click(processToggle());
		expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(5);
		expect(host.querySelector(".owl-work-process-body")?.textContent).toContain("src/earliest.ts");
		expect(host.querySelector(".owl-thinking pre")?.textContent).toBe("原始思考内容不应默认铺开");
	});

	it("opens every action at the process location and expands one result without another tool-group disclosure", async () => {
		await render({ entries: turn(assistant("work-entry", [
			readTool("first", "src/first.ts", "ok", "第一项的完整输出"),
			readTool("second", "src/second.ts", "ok", "第二项的完整输出"),
		])), activity: "idle" });
		const process = host.querySelector(".owl-work-process")!;
		await click(processToggle(process));
		expect(host.querySelector(".owl-work-process")).toBe(process);
		expect(processToggle(process).getAttribute("aria-expanded")).toBe("true");
		expect(process.querySelectorAll(".owl-tool-row")).toHaveLength(2);
		expect(process.querySelector(".owl-tool-group-summary")).toBeNull();
		expect(process.textContent).toContain("src/first.ts");
		expect(process.textContent).toContain("src/second.ts");
		expect(process.textContent).not.toContain("第一项的完整输出");
		await click(process.querySelector<HTMLButtonElement>('[data-tool-id="first"] .owl-tool-summary')!);
		expect(process.textContent).toContain("第一项的完整输出");
		expect(process.querySelector('[data-tool-id="second"] .owl-tool-output')).toBeNull();
		expect(process.querySelector(".owl-work-latest-output")?.textContent).toContain("第二项的完整输出");
		expect(process.querySelector('[data-tool-id="second"] .owl-tool-summary')?.getAttribute("aria-expanded")).toBe("false");
	});

	it("marks a failed operation as recovered only after the same operation succeeds", async () => {
		await render({ entries: turn(assistant("work-entry", [
			readTool("failed", "src/retry.ts", "error", "首次读取失败"),
			readTool("retried", "src/retry.ts", "ok", "相同读取重试成功"),
		])), activity: "idle" });
		expect(visibleText()).toContain("1 项操作重试成功");
		expect(host.querySelector(".owl-work-issues")).toBeNull();
		await click(processToggle());
		await click(host.querySelector<HTMLButtonElement>(".owl-tool-row .owl-tool-summary")!);
		expect(host.textContent).toContain("首次读取失败");
	});

	it("keeps an unrelated failed result visible and lets the user inspect it directly", async () => {
		await render({ entries: turn(assistant("work-entry", [
			readTool("failed", "src/missing.ts", "error", "找不到被请求的文件"),
			readTool("unrelated", "src/other.ts", "ok", "另一个文件读取成功"),
		])), activity: "idle" });
		const issue = host.querySelector(".owl-work-issue-link")!;
		expect(issue.textContent).toContain("1 条执行异常");
		expect(host.querySelector(".owl-work-recovered")).toBeNull();
		await click(issue as HTMLButtonElement);
		expect(host.querySelector(".owl-work-process-body")).not.toBeNull();
		expect(host.querySelector(".owl-tool-output")?.textContent).toBe("找不到被请求的文件");
		expect(host.querySelector(".owl-work-issue-link")?.textContent).toContain("1 条执行异常");
		expect(host.querySelector(".owl-work-issues")).toBeNull();
	});

	it("preserves a manually opened process and its existing action detail when more work finishes and the answer arrives", async () => {
		const first = readTool("first", "src/stable.ts", "ok", "请保留这项已经展开的输出");
		await render({ entries: turn(assistant("work-entry", [first])) });
		await click(processToggle());
		await click(host.querySelector<HTMLButtonElement>('[data-tool-id="first"] .owl-tool-summary')!);
		expect(host.querySelector(".owl-tool-output")?.textContent).toBe("请保留这项已经展开的输出");
		await render({ entries: turn(
			assistant("work-entry", [first, readTool("later", "src/later.ts")], { endedAt: 4000 }),
			assistant("answer-entry", [], { text: "任务已结束，完整答案仍然可读。", timestamp: 5000, endedAt: 6000 }),
		), activity: "idle" });
		expect(host.querySelector(".owl-work-process-body")).not.toBeNull();
		expect(processToggle().getAttribute("aria-expanded")).toBe("true");
		expect(host.querySelector('[data-tool-id="first"] .owl-tool-summary')?.getAttribute("aria-expanded")).toBe("true");
		expect(host.querySelector(".owl-tool-output")?.textContent).toBe("请保留这项已经展开的输出");
		expect(host.querySelector('[data-entry-id="answer-entry"] .owl-answer-reading')?.textContent).toContain("完整答案仍然可读");
	});

	it("offers one initially closed original-thinking disclosure for thoughts emitted between multiple actions", async () => {
		await render({ entries: turn(
			assistant("work-one", [readTool("first", "src/first.ts")], { thinking: "第一段工作思考" }),
			assistant("work-two", [readTool("second", "src/second.ts")], { thinking: "第二段工作思考" }),
		), activity: "idle" });
		expect(visibleText()).not.toContain("第一段工作思考");
		await click(processToggle());
		const thoughts = [...host.querySelectorAll<HTMLElement>(".owl-thinking")].filter((thought) => thought.querySelector("button")?.textContent?.includes("查看思考原文"));
		expect(thoughts).toHaveLength(1);
		expect(thoughts[0]!.hasAttribute("data-open")).toBe(false);
		expect(thoughts[0]!.querySelector("pre")?.textContent).toBe("第一段工作思考\n\n第二段工作思考");
	});

	it("retains the tail action detail when a later final answer reclassifies an earlier text segment as progress", async () => {
		const first = readTool("first", "src/first.ts", "ok", "第一项输出");
		const second = readTool("second", "src/second.ts", "running", "正在查阅的第二项输出");
		const segments: AssistantEntry["segments"] = [
			{ kind: "tool", toolId: "first" },
			{ kind: "text", text: "继续检查" },
			{ kind: "tool", toolId: "second" },
		];
		await render({ entries: turn(assistant("work-entry", [first, second], { text: "继续检查", segments })) });
		const processes = [...host.querySelectorAll(".owl-work-process")];
		expect(processes).toHaveLength(1);
		const tail = processes.at(-1)!;
		await click(processToggle(tail));
		await click(tail.querySelector<HTMLButtonElement>('[data-tool-id="second"] .owl-tool-summary')!);
		expect(tail.querySelector(".owl-tool-output")?.textContent).toBe("正在查阅的第二项输出");
		await render({ entries: turn(
			assistant("work-entry", [first, { ...second, status: "ok", finishedAt: 4000 }], { text: "继续检查", segments, endedAt: 4000 }),
			assistant("answer-entry", [], { text: "最终检查结果已生成。", timestamp: 5000, endedAt: 6000 }),
		), activity: "idle" });
		const openProcess = host.querySelector(".owl-work-process-body");
		expect(openProcess, "the process containing the action being read stays expanded").not.toBeNull();
		const secondButton = openProcess!.querySelector<HTMLButtonElement>('[data-tool-id="second"] .owl-tool-summary')!;
		expect(secondButton.getAttribute("aria-expanded")).toBe("true");
		expect(secondButton.closest(".owl-tool-row")?.querySelector(".owl-tool-output")?.textContent).toBe("正在查阅的第二项输出");
		expect(host.querySelector('[data-entry-id="answer-entry"] .owl-answer-reading')?.textContent).toContain("最终检查结果已生成");
	});

	it("keeps complete answers after the process with the existing code-copy and table-reading controls", async () => {
		const code = 'const 原文 = "<保留>";\n';
		const text = "答案开头\n\n```ts\n" + code + "```\n\n| 文件 | 状态 |\n| --- | --- |\n| source.ts | 已核对 |\n\n答案结尾";
		await render({ entries: turn(
			assistant("work-entry", [readTool("first", "src/first.ts")], { endedAt: 3000 }),
			assistant("answer-entry", [], { text, timestamp: 4000, endedAt: 5000 }),
		), activity: "idle" });
		const answer = host.querySelector('[data-entry-id="answer-entry"] .owl-answer-reading')!;
		expect(answer.textContent).toContain("答案开头");
		expect(answer.textContent).toContain("答案结尾");
		expect(answer.querySelector("[data-answer-code] pre > code")?.textContent).toBe(code);
		expect(answer.querySelector("[data-answer-table-scroll] table")?.textContent).toContain("已核对");
		expect(answer.querySelector('[data-answer-action="expand-table"]')).not.toBeNull();
		const copy = answer.querySelector<HTMLButtonElement>('[data-answer-action="copy-code"]')!;
		await click(copy);
		expect(clipboard).toHaveBeenCalledExactlyOnceWith(code);
		const processRow = host.querySelector(".owl-work-process")!.closest(".owl-chat-row")!;
		const answerRow = answer.closest(".owl-chat-row")!;
		const timeline = [...processRow.parentElement!.children];
		expect(timeline.indexOf(processRow)).toBeLessThan(timeline.indexOf(answerRow));
	});

	it("promotes a mid-turn owl-ui fence to the answer when the final text has none", async () => {
		const fence = "```owl-ui\n{\"items\":[{\"type\":\"card\",\"title\":\"看板\",\"items\":[]}]}\n```";
		await render({ entries: turn(
			assistant("fence-entry", [readTool("probe", "src/a.ts")], { text: "看板如下：\n\n" + fence }),
			assistant("final-entry", [], { text: "看板已生成，需要补报异常日志。" }),
		), activity: "idle" });
		// 带围栏的中间说明提升为答案行，不再藏进工作过程折叠区；末尾纯文本答案照常上屏
		const promoted = host.querySelector('[data-entry-id="fence-entry"][data-owl-answer="true"]');
		expect(promoted?.textContent).toContain("看板如下");
		expect(host.querySelector('[data-entry-id="final-entry"][data-owl-answer="true"]')?.textContent).toContain("需要补报异常日志");
	});

	it("keeps intermediate notes folded when the final answer carries the owl-ui fence", async () => {
		const fence = "```owl-ui\n{\"items\":[]}\n```";
		await render({ entries: turn(
			assistant("note-entry", [readTool("probe", "src/b.ts")], { text: "中间说明附看板草稿。\n\n" + fence }),
			assistant("final-entry", [], { text: "最终回答：\n\n" + fence }),
		), activity: "idle" });
		// 最终答案已带围栏，中间说明不提升：无答案行标记，照常留在折叠区
		expect(host.querySelector('[data-entry-id="note-entry"][data-owl-answer="true"]')).toBeNull();
		await click(processToggle());
		expect(host.querySelector(".owl-work-process-body")?.textContent).toContain("中间说明附看板草稿");
	});
});
