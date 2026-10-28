import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe(): void {}
			disconnect(): void {}
		},
	);
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
	dom.window.getSelection = () => null;
	dom.window.matchMedia = () =>
		({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as MediaQueryList;
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
		x: 0,
		y: 0,
		width: 800,
		height: 40,
		top: 0,
		left: 0,
		right: 800,
		bottom: 40,
		toJSON: () => ({}),
	});
	setUiLanguage("zh");
	// 这一组测的是 Claude 模式的回答流。
	document.documentElement.dataset.owlClaudeFlow = "on";
	host = document.getElementById("root")!;
	root = createRoot(host);
	props = { entries: [], sessionId: "claude-flow-cards", activity: "working" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setUiLanguage("zh");
});

function tool(partial: Partial<ToolCard> & { id: string }): ToolCard {
	return {
		name: "read",
		args: JSON.stringify({ path: "src/a.ts" }),
		summary: "读取 src/a.ts",
		detail: "src/a.ts",
		status: "ok",
		startedAt: 2000,
		finishedAt: 3000,
		output: { text: "已读取", totalLines: 1 },
		...partial,
	};
}

function assistant(entryId: string, tools: ToolCard[], extra: Partial<AssistantEntry> = {}): AssistantEntry {
	return { kind: "assistant", entryId, text: "", thinking: "", tools, timestamp: 2000, ...extra };
}

function turn(...entries: AssistantEntry[]): ChatEntry[] {
	return [{ kind: "user", entryId: "question-entry", text: "继续", timestamp: 1000 }, ...entries];
}

async function render(overrides: Partial<Props>): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<ChatStream {...props} />));
}

describe("Claude 回答流的新增单元", () => {
	it("子代理单独成组，组头是 Ran N agents", async () => {
		const agents = [tool({ id: "a1", name: "subagent" }), tool({ id: "a2", name: "subagent" })];
		await render({
			entries: turn(
				assistant("e1", agents, { segments: agents.map((c) => ({ kind: "tool" as const, toolId: c.id })) }),
			),
		});
		const group = host.querySelector(".owl-claude-subagent-group");
		expect(group).not.toBeNull();
		expect(group?.querySelector(".owl-claude-group-title")?.textContent).toBe("Ran 2 agents");
		// 组默认收起（Claude 的 openTurnStatusGroups 初始为空），点开才是整组盒。
		expect(group?.querySelectorAll(".owl-claude-group-row")).toHaveLength(0);
		await act(async () => group!.querySelector<HTMLButtonElement>(".owl-claude-group-head")!.click());
		// 子代理有自己的盒，普通工具组不吞掉它。
		expect(group!.querySelectorAll(".owl-claude-group-row")).toHaveLength(2);
	});

	it("提问工具渲染成专属卡片，不是工具行", async () => {
		const question = tool({
			id: "q1",
			name: "ask_user_question",
			args: JSON.stringify({
				questions: [
					{
						question: "要改哪个文件？",
						header: "范围",
						options: [{ label: "只改路由", description: "不动其余" }, { label: "整页重写" }],
					},
				],
			}),
		});
		await render({
			entries: turn(assistant("e1", [question], { segments: [{ kind: "tool", toolId: "q1" }] })),
		});
		const card = host.querySelector(".owl-claude-question");
		expect(card).not.toBeNull();
		expect(card?.textContent).toContain("要改哪个文件？");
		expect(card?.textContent).toContain("只改路由");
		expect(card?.textContent).toContain("不动其余");
		// 提问不进工具盒。
		expect(host.querySelector(".owl-claude-group-box")?.textContent ?? "").not.toContain("要改哪个文件？");
	});

	it("被中断的一轮留下中断标记，不上错误态", async () => {
		await render({
			entries: turn(assistant("e1", [], { aborted: true, segments: [{ kind: "text", text: "先看看目录" }] })),
		});
		expect(host.querySelector(".owl-claude-interrupted")).not.toBeNull();
		expect(host.querySelector(".owl-chat-error")).toBeNull();
	});

	it("连接器工具的散文以散文形态落在回答流里", async () => {
		const connector = tool({
			id: "m1",
			name: "mcp__docs__search",
			output: { text: "找到三份关于计费的文档。", totalLines: 1 },
		});
		await render({
			entries: turn(assistant("e1", [connector], { segments: [{ kind: "tool", toolId: "m1" }] })),
		});
		const block = host.querySelector(".owl-claude-connector");
		expect(block).not.toBeNull();
		expect(block?.textContent).toContain("找到三份关于计费的文档。");
		expect(block?.querySelector(".owl-claude-connector-source")?.textContent).toBe("docs");
	});

	it("用量不出现在回答流里（Claude 的 token_budget 是透明单元）", async () => {
		await render({
			entries: turn(
				assistant("e1", [], {
					usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
					segments: [{ kind: "text", text: "做完了" }],
				}),
			),
		});
		expect(host.querySelector(".owl-claude-usage")).toBeNull();
		expect(host.textContent).not.toContain("cached");
	});

	it("产出文件不再单独成芯片条（Claude 的 present_files 就是一行）", async () => {
		// 对齐结论：Claude 没有文件芯片条 —— write/edit 行已带文件名与动作。
		const write = tool({
			id: "w1",
			name: "write",
			output: { text: "已写入", totalLines: 1, artifacts: [{ path: "src/admin/style.css", action: "edited" }] },
		});
		await render({
			entries: turn(assistant("e1", [write], { segments: [{ kind: "tool", toolId: "w1" }] })),
		});
		expect(host.querySelector(".owl-claude-files")).toBeNull();
		expect(host.querySelector(".owl-claude-file")).toBeNull();
		// 文件名由 write 行自己携带（标签取 args.path）。
		expect(host.textContent).toContain("a.ts");
	});
});
