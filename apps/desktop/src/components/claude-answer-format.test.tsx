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
	dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as MediaQueryList;
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 40, top: 0, left: 0, right: 800, bottom: 40, toJSON: () => ({}) });
	setUiLanguage("zh");
	// 默认走 owl 原本的一层折叠；Claude 专属的 describe 里再打开。
	document.documentElement.dataset.owlClaudeFlow = "off";
	host = document.getElementById("root")!;
	root = createRoot(host);
	props = { entries: [], sessionId: "claude-format", activity: "working" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setUiLanguage("zh");
});

function readTool(id: string, status: ToolCard["status"] = "ok"): ToolCard {
	return {
		id,
		name: "read",
		args: JSON.stringify({ path: `src/${id}.ts` }),
		summary: `读取 ${id}.ts`,
		detail: `src/${id}.ts`,
		status,
		startedAt: 2000,
		...(status === "running" || status === "pending" ? {} : { finishedAt: 3000 }),
		output: { text: `已读取 ${id}.ts`, totalLines: 1 },
	};
}

function assistant(entryId: string, tools: ToolCard[], extra: Partial<AssistantEntry> = {}): AssistantEntry {
	return { kind: "assistant", entryId, text: "", thinking: "", tools, timestamp: 2000, ...extra };
}

function turn(...entries: AssistantEntry[]): ChatEntry[] {
	return [{ kind: "user", entryId: "question-entry", text: "核对工作过程", timestamp: 1000 }, ...entries];
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

/** 屏幕上的可见文本：隐藏的节点不算数（hidden 与收起的折叠体都剔除）。 */
function visibleText(scope: HTMLElement = host): string {
	const clone = scope.cloneNode(true) as HTMLElement;
	for (const node of clone.querySelectorAll("[hidden]")) node.remove();
	for (const body of clone.querySelectorAll(".owl-collapse-body:not([data-open])")) body.remove();
	return clone.textContent ?? "";
}

/** 连续工具调用在同一条 assistant 消息里：Claude 把它们合成一个「Ran N commands」组。 */
function consecutiveTools(...ids: string[]): AssistantEntry {
	return assistant("work-entry", ids.map((id) => readTool(id)), {
		segments: ids.map((id) => ({ kind: "tool" as const, toolId: id })),
	});
}

describe("Claude answer format in owl", () => {
	it("keeps the work-process fold free of a duplicate group header", async () => {
		await render({ entries: turn(consecutiveTools("one", "two", "three")) });
		await click(".owl-work-process-summary");
		// owl 原本的一层折叠里，「3 项操作」已经表达了工具组数，不再另起一个组头。
		expect(host.querySelector(".owl-work-group-head")).toBeNull();
		expect(host.querySelectorAll(".owl-tool-row")).toHaveLength(3);
	});

	it("keeps the work-process rows in owl's own style", async () => {
		await render({ entries: turn(consecutiveTools("one", "two")) });
		await click(".owl-work-process-summary");
		// 工作过程是汇总视角：状态图标与耗时留着，一眼看出哪步在跑。
		expect(host.querySelector(".owl-status-slot")).not.toBeNull();
		expect(host.querySelector(".owl-claude-row-chevron")).toBeNull();
	});

	it("shows the measured thinking duration next to the thinking disclosure", async () => {
		await render({
			entries: turn(assistant("work-entry", [readTool("one")], {
				thinking: "先确认 billing 领域边界",
				segments: [
					{ kind: "thinking", text: "先确认 billing 领域边界", startedAt: 1000, endedAt: 12_500 },
					{ kind: "tool", toolId: "one" },
				],
			})),
		});
		await click(".owl-work-process-summary");
		expect(host.querySelector(".owl-thinking-duration")?.textContent).toBe("Thought for 12s");
	});

	it("leaves the duration out when the thinking block has no measured span", async () => {
		await render({
			entries: turn(assistant("work-entry", [readTool("one")], {
				thinking: "缺少起止时刻的思考",
				segments: [
					{ kind: "thinking", text: "缺少起止时刻的思考" },
					{ kind: "tool", toolId: "one" },
				],
			})),
		});
		await click(".owl-work-process-summary");
		expect(host.querySelector(".owl-thinking-duration")).toBeNull();
	});

	it("formats long thinking durations as minutes and hours like Claude", async () => {
		await render({
			entries: turn(assistant("work-entry", [readTool("one")], {
				thinking: "长思考",
				segments: [
					{ kind: "thinking", text: "长思考", startedAt: 0, endedAt: 90_000 },
					{ kind: "tool", toolId: "one" },
				],
			})),
		});
		await click(".owl-work-process-summary");
		expect(host.querySelector(".owl-thinking-duration")?.textContent).toBe("Thought for 1m 30s");
	});

	it("keeps the tool rows mounted when a later round adds hidden thinking", async () => {
		await render({ entries: turn(consecutiveTools("one")) });
		await click(".owl-work-process-summary");
		const row = host.querySelector('[data-tool-id="one"]');
		await render({
			entries: turn(
				consecutiveTools("one"),
				assistant("later-entry", [readTool("later", "running")], { thinking: "后续模型返回的隐藏思考" }),
			),
		});
		expect(host.querySelector('[data-tool-id="one"]')).toBe(row);
	});
});

describe("Claude flow: the answer stream has no work-process fold", () => {
	beforeEach(() => {
		// Claude 模式走 dataset（与设置页同一份通道），不是 prop。
		document.documentElement.dataset.owlClaudeFlow = "on";
	});

	it("lays the tool group straight into the answer stream", async () => {
		await render({ entries: turn(consecutiveTools("one", "two")) });
		// 工具组直接落在回答流里，不再收进「工作过程」折叠块。
		expect(host.querySelector(".owl-work-process")).toBeNull();
		expect(host.querySelectorAll(".owl-claude-flow-item")).toHaveLength(1);
		expect(host.querySelector(".owl-claude-group-head")?.textContent).toContain("Read files");
		expect(host.querySelectorAll(".owl-claude-group-row")).toHaveLength(2);
	});

	it("keeps prose, tool groups and thinking in the emitted order", async () => {
		await render({
			entries: turn(assistant("work-entry", [readTool("a"), readTool("b"), readTool("c")], {
				segments: [
					{ kind: "tool", toolId: "a" },
					{ kind: "tool", toolId: "b" },
					{ kind: "text", text: "先写后端 billing 领域。" },
					{ kind: "tool", toolId: "c" },
				],
			})),
		});
		const kinds = [...host.querySelectorAll(".owl-claude-flow-item")].map((node) =>
			node.querySelector(".owl-claude-group") ? "group" : node.querySelector(".owl-claude-thinking") ? "thinking" : "note",
		);
		expect(kinds).toEqual(["group", "note", "group"]);
	});

	it("renders each tool row as one quiet line with the action phrase and a chevron", async () => {
		await render({ entries: turn(consecutiveTools("one", "two")) });
		const row = host.querySelector(".owl-claude-group-row")!;
		expect(row.querySelector(".owl-claude-group-row-label")?.textContent).toContain("Read one.ts");
		// Claude 的行首没有状态图标，箭头紧跟短语。
		expect(row.querySelector(".owl-status-slot")).toBeNull();
		expect(row.querySelector(".owl-claude-group-row-chevron")).not.toBeNull();
		// 耗时与时间戳不在这条安静的行里。
		expect(row.querySelector(".owl-work-row-secs")).toBeNull();
		expect(row.querySelector(".owl-tool-meta")).toBeNull();
	});

	it("names the group after the main verb", async () => {
		await render({ entries: turn(assistant("work-entry", [readTool("a")], { segments: [{ kind: "tool", toolId: "a" }] })) });
		expect(host.querySelector(".owl-claude-group-title")?.textContent).toBe("Read files");
	});

	it("reveals the raw tool output when a row is opened", async () => {
		await render({ entries: turn(consecutiveTools("one", "two")) });
		expect(host.querySelector(".owl-claude-group-output")).toBeNull();
		await click(".owl-claude-group-row-head");
		expect(host.querySelector(".owl-claude-group-output")?.textContent).toContain("已读取 one.ts");
		await click(".owl-claude-group-row-head");
		expect(host.querySelector(".owl-claude-group-output")).toBeNull();
	});

	it("hides the tool rows when the group header is collapsed and shows them again on reopen", async () => {
		await render({ entries: turn(consecutiveTools("one", "two")) });
		expect(host.querySelectorAll(".owl-claude-group-row")).toHaveLength(2);
		expect(host.querySelector(".owl-claude-group-head")?.getAttribute("aria-expanded")).toBe("true");
		await click(".owl-claude-group-head");
		expect(host.querySelector(".owl-claude-group-head")?.getAttribute("aria-expanded")).toBe("false");
		expect(host.querySelector(".owl-claude-group-box")).toBeNull();
		await click(".owl-claude-group-head");
		expect(host.querySelectorAll(".owl-claude-group-row")).toHaveLength(2);
	});

	it("writes one summary line of what this round did", async () => {
		await render({ entries: turn(consecutiveTools("one", "two", "three")) });
		const summary = host.querySelector(".owl-claude-summary");
		expect(summary).not.toBeNull();
		expect(summary?.textContent).toContain("Read one.ts");
	});

	it("marks the failed row in red and counts the failures in the group header", async () => {
		await render({
			entries: turn(assistant("work-entry", [readTool("one", "error"), readTool("two")], {
				segments: [
					{ kind: "tool", toolId: "one" },
					{ kind: "tool", toolId: "two" },
				],
			})),
		});
		const rows = [...host.querySelectorAll(".owl-claude-group-row")];
		const failedRow = rows.find((row) => row.getAttribute("data-status") === "error");
		const okRow = rows.find((row) => row.getAttribute("data-status") === "ok");
		// 失败行整行标红，并在行首留一个红点 —— Claude 靠颜色表达失败，不另加图标占位。
		expect(failedRow).not.toBeUndefined();
		expect(failedRow!.querySelector(".owl-claude-group-row-failed")).not.toBeNull();
		// 成功的行不沾失败标记。
		expect(okRow).not.toBeUndefined();
		expect(okRow!.querySelector(".owl-claude-group-row-failed")).toBeNull();
		// 组头给出失败计数。
		expect(host.querySelector(".owl-claude-group-failed-count")?.textContent).toBe("1");
	});

	it("shows thinking summaries in place instead of a folded row", async () => {
		await render({
			entries: turn(assistant("work-entry", [], {
				segments: [{
					kind: "thinking",
					text: "原始思考",
					startedAt: 1000,
					endedAt: 12_500,
					summaries: ["先确认 billing 领域边界", "gateway 接缝放在出站方向"],
				}],
			})),
		});
		const summaries = [...host.querySelectorAll(".owl-claude-thinking-summary")].map((node) => node.textContent);
		expect(summaries).toEqual(["先确认 billing 领域边界", "gateway 接缝放在出站方向"]);
		expect(host.querySelector(".owl-thinking")).toBeNull();
	});
});
