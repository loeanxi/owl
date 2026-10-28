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

let root: Root;
let host: HTMLElement;
let props: Props;
let scrollTo: ReturnType<typeof vi.fn>;

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
	scrollTo = vi.fn();
	dom.window.HTMLElement.prototype.scrollTo = scrollTo as never;
	setUiLanguage("zh");
	document.documentElement.dataset.owlClaudeFlow = "on";
	host = document.getElementById("root")!;
	root = createRoot(host);
	props = { entries: [], sessionId: "products", activity: "idle" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setUiLanguage("zh");
});

function writeTool(id: string, path: string): ToolCard {
	return {
		id,
		name: "write",
		args: JSON.stringify({ path }),
		summary: `wrote ${path}`,
		status: "ok",
		output: { text: "已写入", totalLines: 1 },
	};
}

function visualTool(id: string, title: string): ToolCard {
	return {
		id,
		name: "render_ui",
		args: "{}",
		summary: "rendered",
		status: "ok",
		output: {
			text: "已渲染",
			totalLines: 1,
			genuiSpec: { title, items: [{ type: "chart", data: [{ label: "订阅", value: 12480 }] }] } as never,
		},
	};
}

function entriesWith(tools: ToolCard[]): ChatEntry[] {
	return [
		{ kind: "user", text: "做点东西", timestamp: 500 },
		{
			kind: "assistant",
			entryId: "a",
			text: "",
			thinking: "",
			timestamp: 1000,
			endedAt: 2000,
			tools,
			segments: tools.map((tool) => ({ kind: "tool" as const, toolId: tool.id })),
		},
	];
}

async function render(next: Partial<Props>): Promise<void> {
	await act(async () => {
		root.render(<ChatStream {...props} {...next} />);
	});
}

describe("the product list in the answer stream", () => {
	it("lists the turn's products: the new file and the visualization", async () => {
		await render({
			entries: entriesWith([writeTool("w1", "docs/report.md"), visualTool("v1", "费用明细")]),
			cwd: "D:/owl",
			onOpenFile: () => undefined,
		});
		const rows = host.querySelectorAll(".owl-product-row");
		expect(rows).toHaveLength(2);
		expect(host.querySelector(".owl-products-heading")?.textContent).toContain("产物");
		expect(host.querySelector(".owl-product-kind[data-kind='chart']")?.textContent).toBe("图表");
	});

	it("locates the visualization card in the conversation when clicked", async () => {
		await render({
			entries: entriesWith([visualTool("v1", "费用明细")]),
			cwd: "D:/owl",
			onOpenFile: () => undefined,
		});
		const button = host.querySelector(".owl-product-button") as HTMLButtonElement;
		expect(button).not.toBeNull();
		await act(async () => {
			button.click();
		});
		// 目标卡片被找到并高亮；滚动交给对话区自己的滚动容器。
		const target = host.querySelector("[data-tool-id='v1']");
		expect(target?.classList.contains("is-product-located")).toBe(true);
		expect(scrollTo).toHaveBeenCalled();
	});

	it("renders the task list as an inline checklist and echoes the raw result away", async () => {
		const todo: ToolCard = {
			id: "t1",
			name: "todo",
			args: "{}",
			summary: "任务清单",
			status: "ok",
			output: {
				text: "任务清单已更新 — 3 items: 1 completed, 1 in progress, 1 pending\n[x] 1. 读源码\n[>] 2. 改接缝\n[ ] 3. 跑测试",
				totalLines: 4,
				todos: [
					{ content: "读源码", status: "completed" },
					{ content: "改接缝", status: "in_progress" },
					{ content: "跑测试", status: "pending" },
				],
			},
		};
		await render({ entries: entriesWith([todo]), cwd: "D:/owl", onOpenFile: () => undefined });
		const list = host.querySelector(".owl-claude-tasklist");
		expect(list).not.toBeNull();
		expect(list?.querySelectorAll(".owl-claude-tasklist-item")).toHaveLength(3);
		expect(list?.querySelector("[data-status='in_progress']")?.textContent).toContain("改接缝");
		// 原文按 resultEcho 回显掉 —— 清单卡已经说了同样的事。
		expect(host.textContent).not.toContain("任务清单已更新");
	});

	it("renders the model's next steps as chips and hands the picked one back", async () => {
		const suggest: ToolCard = {
			id: "s1",
			name: "offer_next_steps",
			args: "{}",
			summary: "下一步",
			status: "ok",
			output: {
				text: "补测试 / 改文档",
				totalLines: 1,
				nextSteps: [
					{ label: "补测试", prompt: "给 parser 补测试" },
					{ label: "改文档", prompt: "更新 README 里的用法" },
				],
			},
		};
		const picked: string[] = [];
		await render({
			entries: entriesWith([suggest]),
			cwd: "D:/owl",
			onOpenFile: () => undefined,
			onPromptExample: (text) => picked.push(text),
		});
		const chips = [...host.querySelectorAll(".owl-claude-nextstep")];
		expect(chips).toHaveLength(2);
		expect(chips[0]?.textContent).toBe("补测试");
		await act(async () => {
			(chips[0] as HTMLButtonElement).click();
		});
		// 点芯片：把这句话交回宿主（桌面端填进输入框），不直接发送。
		expect(picked).toEqual(["给 parser 补测试"]);
	});

	it("turns the task list into a plan card with approve and reject in plan mode", async () => {
		const todo: ToolCard = {
			id: "t1",
			name: "todo",
			args: "{}",
			summary: "任务清单",
			status: "ok",
			output: {
				text: "任务清单已更新",
				totalLines: 1,
				todos: [
					{ content: "读源码", status: "pending" },
					{ content: "改接缝", status: "pending" },
				],
			},
		};
		const approved: string[] = [];
		const rejected: string[] = [];
		await render({
			entries: entriesWith([todo]),
			cwd: "D:/owl",
			onOpenFile: () => undefined,
			approvalMode: "plan",
			onApprovePlan: () => approved.push("approve"),
			onRejectPlan: (feedback) => rejected.push(feedback),
		});
		// 计划模式：清单不逐步显示，收成一张计划卡。
		expect(host.querySelector(".owl-claude-tasklist")).not.toBeNull();
		expect(host.querySelector(".owl-claude-plan")).not.toBeNull();
		await act(async () => {
			(host.querySelector(".owl-claude-plan-approve") as HTMLButtonElement).click();
		});
		expect(approved).toEqual(["approve"]);

		await act(async () => {
			(host.querySelector(".owl-claude-plan-reject") as HTMLButtonElement).click();
		});
		const input = host.querySelector(".owl-claude-plan-feedback-input") as HTMLInputElement;
		expect(input).not.toBeNull();
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(input, "先看 gateway 那一层");
			input.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await act(async () => {
			(host.querySelector(".owl-claude-plan-send") as HTMLButtonElement).click();
		});
		expect(rejected).toEqual(["先看 gateway 那一层"]);
	});
});
