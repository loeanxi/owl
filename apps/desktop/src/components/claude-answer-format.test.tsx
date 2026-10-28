import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";
import { resetClaudeGroups } from "./claude-turn-status-open.ts";

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
	// 默认走 owl 原本的一层折叠；Claude 专属的 describe 里再打开。
	document.documentElement.dataset.owlClaudeFlow = "off";
	// 组开合 store 是模块级的：每个用例前清空，默认全收起才可断言。
	resetClaudeGroups();
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
	return assistant(
		"work-entry",
		ids.map((id) => readTool(id)),
		{
			segments: ids.map((id) => ({ kind: "tool" as const, toolId: id })),
		},
	);
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
			entries: turn(
				assistant("work-entry", [readTool("one")], {
					thinking: "先确认 billing 领域边界",
					segments: [
						{ kind: "thinking", text: "先确认 billing 领域边界", startedAt: 1000, endedAt: 12_500 },
						{ kind: "tool", toolId: "one" },
					],
				}),
			),
		});
		await click(".owl-work-process-summary");
		expect(host.querySelector(".owl-thinking-duration")?.textContent).toBe("Thought for 12s");
	});

	it("leaves the duration out when the thinking block has no measured span", async () => {
		await render({
			entries: turn(
				assistant("work-entry", [readTool("one")], {
					thinking: "缺少起止时刻的思考",
					segments: [
						{ kind: "thinking", text: "缺少起止时刻的思考" },
						{ kind: "tool", toolId: "one" },
					],
				}),
			),
		});
		await click(".owl-work-process-summary");
		expect(host.querySelector(".owl-thinking-duration")).toBeNull();
	});

	it("formats long thinking durations as minutes and hours like Claude", async () => {
		await render({
			entries: turn(
				assistant("work-entry", [readTool("one")], {
					thinking: "长思考",
					segments: [
						{ kind: "thinking", text: "长思考", startedAt: 0, endedAt: 90_000 },
						{ kind: "tool", toolId: "one" },
					],
				}),
			),
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

	it("lays the tool group straight into the answer stream, collapsed by default", async () => {
		await render({ entries: turn(consecutiveTools("one", "two")) });
		// 工具组直接落在回答流里，不再收进「工作过程」折叠块；
		// 组头默认只这一行（Claude 的 openTurnStatusGroups 初始为空）。
		expect(host.querySelector(".owl-work-process")).toBeNull();
		expect(host.querySelectorAll(".owl-claude-flow-item")).toHaveLength(1);
		expect(host.querySelector(".owl-claude-group-head")?.textContent).toContain("Read 2 files");
		expect(host.querySelector(".owl-claude-group-box")).toBeNull();
		await click(".owl-claude-group-head");
		expect(host.querySelectorAll(".owl-claude-group-row")).toHaveLength(2);
	});

	it("merges a turn's tool batches into one collapsed group", async () => {
		await render({
			// Claude 的折叠单元是整个工作阶段（anchor 合并）：一轮内多个批次
			// 合成一个组，说明行独立成行（owl 的说明行在组外，Claude 在盒内）。
			activity: "idle",
			entries: turn(
				assistant("work-entry", [readTool("a"), readTool("b"), readTool("c")], {
					segments: [
						{ kind: "tool", toolId: "a" },
						{ kind: "tool", toolId: "b" },
						{ kind: "text", text: "先写后端 billing 领域。\n\n再看前端接线。" },
						{ kind: "tool", toolId: "c" },
					],
				}),
			),
		});
		const kinds = [...host.querySelectorAll(".owl-claude-flow-item")].map((node) =>
			node.querySelector(".owl-claude-group")
				? "group"
				: node.querySelector(".owl-claude-thinking")
					? "thinking"
					: "note",
		);
		expect(kinds).toEqual(["note", "group"]);
		// 合并组包含本轮全部三行工具。
		await click(".owl-claude-group-head");
		expect(host.querySelectorAll(".owl-claude-group-row")).toHaveLength(3);
	});

	it("suppresses the single-line narration entirely", async () => {
		// Claude 的 ie()：说明只有一行（首行即全部内容）时整行不渲染。
		await render({
			entries: turn(
				assistant("work-entry", [readTool("a")], {
					segments: [
						{ kind: "text", text: "先写后端 billing 领域。" },
						{ kind: "tool", toolId: "a" },
					],
				}),
			),
		});
		expect(host.querySelector(".owl-claude-note")).toBeNull();
	});

	it("hides the narration while the turn is still streaming", async () => {
		// Claude 的规则：跑动中只显示工具与思考，说明行等这一轮收口后才上屏。
		const entries = turn(
			assistant("work-entry", [readTool("a")], {
				segments: [
					{ kind: "text", text: "先摸清现状。\n\n第一步看目录结构。" },
					{ kind: "tool", toolId: "a" },
				],
			}),
		);
		await render({ entries, activity: "working" });
		expect(host.querySelector(".owl-claude-note")).toBeNull();
		await render({ entries, activity: "idle" });
		expect(host.querySelector(".owl-claude-note")).not.toBeNull();
	});

	it("renders each tool row as one quiet line with the action phrase and a chevron", async () => {
		await render({ entries: turn(consecutiveTools("one", "two")) });
		await click(".owl-claude-group-head");
		const row = host.querySelector(".owl-claude-group-row")!;
		// 兜底行标签用 Claude 的原话：文件类工具是「动词 + 短路径」（现在进行时 + Reading one.ts）。
		expect(row.querySelector(".owl-claude-group-row-label")?.textContent).toContain("Reading one.ts");
		// Claude 的行首没有状态图标，箭头紧跟短语。
		expect(row.querySelector(".owl-status-slot")).toBeNull();
		expect(row.querySelector(".owl-claude-group-row-chevron")).not.toBeNull();
		// 耗时与时间戳不在这条安静的行里。
		expect(row.querySelector(".owl-work-row-secs")).toBeNull();
		expect(row.querySelector(".owl-tool-meta")).toBeNull();
	});

	it("names the group after the main verb", async () => {
		await render({
			entries: turn(assistant("work-entry", [readTool("a")], { segments: [{ kind: "tool", toolId: "a" }] })),
		});
		// Claude 的兜底组标题：read → "Read a file"（一条）/ "Read N files"（多条）。
		expect(host.querySelector(".owl-claude-group-title")?.textContent).toBe("Read a file");
	});

	it("keeps internal tool calls out of the answer stream", async () => {
		const internal = { ...readTool("internal"), hiddenInChat: true };
		await render({
			entries: turn(
				assistant("work-entry", [readTool("one"), internal], {
					segments: [
						{ kind: "tool", toolId: "one" },
						{ kind: "tool", toolId: "internal" },
					],
				}),
			),
		});
		await click(".owl-claude-group-head");
		// 内部工具不进聊天（Claude 的 hidden_in_chat）。
		expect(host.querySelectorAll(".owl-claude-group-row")).toHaveLength(1);
		expect(host.querySelector(".owl-claude-group-row-label")?.textContent).toContain("Reading one.ts");
	});

	it("folds the intermediate narration into one note line", async () => {
		await render({
			entries: turn(
				assistant("work-entry", [readTool("one")], {
					segments: [
						{ kind: "text", text: "先摸清现状。\n\n第一步看目录结构。" },
						{ kind: "tool", toolId: "one" },
					],
				}),
			),
			activity: "idle",
		});
		const note = host.querySelector(".owl-claude-note")!;
		// Claude 的说明行：label = 首行，正文收起来。
		expect(note.querySelector(".owl-claude-note-label")?.textContent).toBe("先摸清现状。");
		expect(note.querySelector(".owl-claude-note-body")).toBeNull();
		await click(".owl-claude-note-head");
		expect(host.querySelector(".owl-claude-note-body")).not.toBeNull();
	});

	it("reveals the raw tool output when a row is opened", async () => {
		await render({ entries: turn(consecutiveTools("one", "two")) });
		await click(".owl-claude-group-head");
		expect(host.querySelector(".owl-claude-group-output")).toBeNull();
		await click(".owl-claude-group-row-head");
		expect(host.querySelector(".owl-claude-group-output")?.textContent).toContain("已读取 one.ts");
		await click(".owl-claude-group-row-head");
		expect(host.querySelector(".owl-claude-group-output")).toBeNull();
	});

	it("opens one group at a time, like Claude's openTurnStatusGroups store", async () => {
		// 同 scope 一次只展开一个组：一轮一个合并组，点开下一轮的组时上一轮自动收起。
		const user: ChatEntry = { kind: "user", entryId: "q", text: "继续", timestamp: 1000 };
		const turnA: ChatEntry[] = [
			user,
			assistant("work-a", [readTool("a"), readTool("b")], {
				segments: [
					{ kind: "tool", toolId: "a" },
					{ kind: "tool", toolId: "b" },
				],
			}),
		];
		const turnB: ChatEntry[] = [
			user,
			assistant("work-a", [readTool("a"), readTool("b")], {
				segments: [
					{ kind: "tool", toolId: "a" },
					{ kind: "tool", toolId: "b" },
				],
			}),
			{ kind: "user", entryId: "q2", text: "再来", timestamp: 5000 },
			assistant("work-b", [readTool("c"), readTool("d")], {
				segments: [
					{ kind: "tool", toolId: "c" },
					{ kind: "tool", toolId: "d" },
				],
			}),
		];
		await render({ entries: turnA });
		await click(".owl-claude-group-head");
		expect(host.querySelectorAll(".owl-claude-group-row")).toHaveLength(2);
		await render({ entries: turnB });
		const heads = [...host.querySelectorAll(".owl-claude-group-head")];
		expect(heads).toHaveLength(2);
		expect(heads[0]!.getAttribute("aria-expanded")).toBe("true");
		await act(async () => heads[1]!.click());
		expect(heads[0]!.getAttribute("aria-expanded")).toBe("false");
		expect(heads[1]!.getAttribute("aria-expanded")).toBe("true");
	});

	it("marks failures with a trailing state word instead of coloring the row", async () => {
		await render({
			entries: turn(
				assistant("work-entry", [readTool("one", "error"), readTool("two")], {
					segments: [
						{ kind: "tool", toolId: "one" },
						{ kind: "tool", toolId: "two" },
					],
				}),
			),
		});
		await click(".owl-claude-group-head");
		const rows = [...host.querySelectorAll(".owl-claude-group-row")];
		const failedRow = rows.find((row) => row.getAttribute("data-status") === "error");
		const okRow = rows.find((row) => row.getAttribute("data-status") === "ok");
		// Claude 的失败语义：行尾一个红色 "Failed"，标签不上色、不加图标。
		expect(failedRow!.querySelector(".owl-claude-state-word")?.textContent).toBe("Failed");
		expect(okRow!.querySelector(".owl-claude-state-word")).toBeNull();
		// 组头给出同一套状态词（tone danger），不再有失败计数徽标。
		expect(host.querySelector(".owl-claude-group-head .owl-claude-state-word")?.textContent).toBe("Failed");
	});

	it("renders edit rows with an inline +n/-m diff stat", async () => {
		// Claude 的 compact Edit 行：行尾 mono 12px 的 +n 绿 / -m 红。
		const edit = {
			...readTool("ed"),
			name: "edit",
			args: JSON.stringify({ path: "src/a.ts", old_str: "a\nb\nc", new_str: "a\nB\nc\nd" }),
		};
		await render({
			entries: turn(assistant("work-entry", [edit], { segments: [{ kind: "tool", toolId: "ed" }] })),
		});
		await click(".owl-claude-group-head");
		const diff = host.querySelector(".owl-claude-group-row-diff")!;
		// Claude 数的是总行数（lS()）：old 3 行 → -3，new 4 行 → +4。
		expect(diff.querySelector(".owl-claude-diff-added")?.textContent).toBe("+4");
		expect(diff.querySelector(".owl-claude-diff-removed")?.textContent).toBe("-3");
	});

	it("renders web_search sources as link preview cards", async () => {
		// Claude 的 rich_content：来源是标题卡（字母瓦片 + 标题 + 域名）。
		const search: ToolCard = {
			id: "ws1",
			name: "web_search",
			args: JSON.stringify({ query: "vite 7" }),
			summary: "搜索 vite 7",
			status: "ok",
			startedAt: 2000,
			finishedAt: 3000,
			output: { text: "要点。\n\n**Sources:**\n1. Some title\n   https://example.com/page", totalLines: 1 },
		};
		await render({
			entries: turn(assistant("e1", [search], { segments: [{ kind: "tool", toolId: "ws1" }] })),
		});
		await click(".owl-claude-group-head");
		// 预览在行展开后的输出区（row 层再展开一次）。
		await click(".owl-claude-group-row-head");
		const preview = host.querySelector(".owl-claude-link-preview")!;
		expect(preview?.querySelector(".owl-claude-link-preview-title")?.textContent).toBe("Some title");
		expect(preview?.querySelector(".owl-claude-link-preview-domain")?.textContent).toBe("example.com");
		expect(preview.getAttribute("href")).toBe("https://example.com/page");
	});

	it("shows the running group with a shimmer live label and no state word", async () => {
		await render({
			entries: turn(
				assistant("work-entry", [readTool("done"), readTool("busy", "running")], {
					segments: [
						{ kind: "tool", toolId: "done" },
						{ kind: "tool", toolId: "busy" },
					],
				}),
			),
		});
		const title = host.querySelector(".owl-claude-group-title")!;
		// 跑动中组头 = 最后一个在跑工具的进行时标签（Claude 的 RJ liveLabel），带 data-live。
		expect(title.getAttribute("data-live")).toBe("on");
		expect(title.textContent).toBe("Reading busy.ts");
		// running 没有状态词（Vj() 的 null 分支）。
		expect(host.querySelector(".owl-claude-group-head .owl-claude-state-word")).toBeNull();
	});

	it("writes one summary line of what this round did", async () => {
		await render({ entries: turn(consecutiveTools("one", "two", "three")) });
		const summary = host.querySelector(".owl-claude-summary");
		expect(summary).not.toBeNull();
		expect(summary?.textContent).toContain("Read one.ts");
	});

	it("folds thinking into one row; the panel leads with duration then summaries", async () => {
		// 纯思考条目：折叠行 label = Th() 的时长家族，点开面板 = 时长 + 摘要列表。
		await render({
			entries: turn(
				assistant("work-entry", [], {
					segments: [
						{
							kind: "thinking",
							text: "原始思考",
							startedAt: 1000,
							endedAt: 12_500,
							summaries: ["先确认 billing 领域边界", "gateway 接缝放在出站方向"],
						},
					],
				}),
			),
		});
		expect(host.querySelector(".owl-claude-thinking-panel")).toBeNull();
		expect(host.querySelector(".owl-claude-thinking-label")?.textContent).toBe("Thought for 12s");
		await click(".owl-claude-thinking-head");
		expect(host.querySelector(".owl-claude-thinking-duration")?.textContent).toBe("Thought for 12s");
		const summaries = [...host.querySelectorAll(".owl-claude-thinking-summary")].map((node) => node.textContent);
		expect(summaries).toEqual(["先确认 billing 领域边界", "gateway 接缝放在出站方向"]);
		expect(host.querySelector(".owl-thinking")).toBeNull();
	});

	it("labels a mixed-entry thinking row with the summary and falls back to the first line", async () => {
		// 混合条目（有工具）：思考行的 label = 摘要；没有摘要才落第一行。
		await render({
			entries: turn(
				assistant("work-entry", [readTool("a")], {
					segments: [
						{
							kind: "thinking",
							text: "原始思考",
							startedAt: 1000,
							endedAt: 12_500,
							summaries: ["先确认 billing 领域边界"],
						},
						{ kind: "tool", toolId: "a" },
					],
				}),
			),
		});
		expect(host.querySelector(".owl-claude-thinking-label")?.textContent).toBe("先确认 billing 领域边界");
		// 跑动中的思考兜底是 "Thinking"（bundle 的 AHQWDTo4+e）。
		const running = turn(
			assistant("work-entry", [readTool("a", "running")], {
				segments: [
					{ kind: "thinking", text: "先看看目录。\n\n再决定怎么改。", startedAt: 1000 },
					{ kind: "tool", toolId: "a" },
				],
			}),
		);
		await render({ entries: running, activity: "working" });
		expect(host.querySelector(".owl-claude-thinking-label")?.textContent).toBe("先看看目录。");
	});

	it("keeps the single-line thinking that has no summaries", async () => {
		// 2026-10-28：单行思考不再整块藏（Claude 的 ie() 会藏）——
		// 全藏之后整轮只剩工具组头，读起来像内容凭空消失。保留那一行，它不展开也不占高度。
		await render({
			entries: turn(
				assistant("work-entry", [readTool("a")], {
					segments: [
						{ kind: "thinking", text: "先想想" },
						{ kind: "tool", toolId: "a" },
					],
				}),
			),
		});
		expect(host.querySelector(".owl-claude-thinking-label")?.textContent).toBe("先想想");
	});

	it("folds the whole turn's thinking into one row", async () => {
		// 一次工具往返一个思考块，一轮下来十几块 —— 合成一行才读得下去。
		await render({
			entries: turn(
				assistant("entry-1", [readTool("a")], {
					segments: [
						{ kind: "thinking", text: "先看看目录。", startedAt: 1000, endedAt: 4000 },
						{ kind: "tool", toolId: "a" },
					],
				}),
				assistant("entry-2", [readTool("b")], {
					segments: [
						{ kind: "thinking", text: "再决定怎么改。", startedAt: 5000, endedAt: 9000 },
						{ kind: "tool", toolId: "b" },
					],
				}),
			),
		});
		// 整轮只有一行思考。
		expect(host.querySelectorAll(".owl-claude-thinking")).toHaveLength(1);
		// 混合轮（有工具）：标题取摘要，没有摘要就落原文首行。
		expect(host.querySelector(".owl-claude-thinking-label")?.textContent).toBe("先看看目录。");
		await click(".owl-claude-thinking-head");
		// 面板里是整轮的思考原文，两块都在。
		const panel = host.querySelector(".owl-claude-thinking-panel")?.textContent ?? "";
		expect(panel).toContain("再决定怎么改。");
	});
});
