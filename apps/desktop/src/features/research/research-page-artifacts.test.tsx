import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ResearchResult } from "../../bridge/protocol.ts";
import { rebuild, type ChatEntry, type ToolCard } from "../../hooks/transcript.ts";
import { ResearchPage } from "./ResearchPage.tsx";
import type { ResearchSessionState } from "./research-session.ts";

const seam = vi.hoisted(() => ({ state: {} as ResearchSessionState }));

// Keep ResearchPage and ChatStream real; only the store and browser-dependent leaves are replaced.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T => actual.useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
	};
});
vi.mock("./research-session.ts", () => ({
	ResearchSessionController: class {
		subscribe = (): (() => void) => () => undefined;
		getSnapshot = (): ResearchSessionState => seam.state;
	},
}));
vi.mock("../../components/Composer.tsx", () => ({ Composer: () => null }));
vi.mock("../../components/OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));
vi.mock("../../components/ContextView.tsx", () => ({ ContextView: () => null }));
vi.mock("../../components/RetryPin.tsx", () => ({ RetryPin: () => null }));
vi.mock("../../components/TodoPin.tsx", () => ({ TodoPin: () => null }));
vi.mock("../trajectory/TrajectoryView.tsx", () => ({ TrajectoryView: () => null }));

beforeEach(() => {
	seam.state = {
		sessionId: "research-1", model: "fixture/model", thinkingLevel: "high", approvalMode: "confirm",
		entries: [], results: [], running: false, busy: false, ready: true, connected: true, retryStatus: null,
	};
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
	vi.stubGlobal("document", { documentElement: { dataset: {} } });
});

afterEach(() => { vi.unstubAllGlobals(); });

function result(id: string, title: string): ResearchResult {
	return { id, title, summary: `${title} 的实际工具结果`, mode: "binary", status: "complete", createdAt: "2026-10-13T00:00:00.000Z", columns: [], rows: [], sources: [], findings: [] };
}

function user(text: string, queued = false): ChatEntry {
	return { kind: "user", text, entryId: text, timestamp: 1, ...(queued ? { queued: true } : {}) };
}

function answer(text: string, results: ResearchResult[] = [], status: ToolCard["status"] = "ok"): ChatEntry {
	const tools: ToolCard[] = results.map((item, index) => ({ id: `${text}-${index}`, name: "research_publish", args: "{}", summary: "已记录研究结果", status, output: { text: "", totalLines: 0, researchResult: item } }));
	return {
		kind: "assistant", entryId: text, text, thinking: "", tools,
		segments: [...tools.map((tool) => ({ kind: "tool" as const, toolId: tool.id })), ...(text ? [{ kind: "text" as const, text }] : [])],
	};
}

function render(): string {
	return renderToStaticMarkup(React.createElement(ResearchPage, {
		client: {} as BridgeClient, active: true, connected: true, cwd: "D:/owl",
		providers: [], defaultModel: "fixture/model", defaultThinkingLevel: "high", defaultApprovalMode: "confirm",
	}));
}

function cardPosition(html: string, title: string): number {
	const marker = `<strong>${title}</strong>`;
	expect(html.split(marker)).toHaveLength(2);
	return html.indexOf(marker);
}

function userPosition(html: string, text: string): number {
	const position = html.indexOf(`<div class="owl-user-bubble">${text}</div>`);
	expect(position).toBeGreaterThanOrEqual(0);
	return position;
}

function answerPosition(html: string, text: string): number {
	const position = html.indexOf(`<div class="owl-answer"><p>${text}</p>`);
	expect(position).toBeGreaterThanOrEqual(0);
	return position;
}

describe("ResearchPage artifact ownership in the real chat stream", () => {
	it("keeps a published card at its historical turn when a later follow-up is pending", () => {
		const old = result("old", "历史静态分析产物");
		seam.state.entries = [user("分析目标程序"), answer("首轮分析结论", [old]), user("目前用的什么模型")];
		seam.state.results = [old];
		seam.state.running = true;
		const html = render();
		expect(cardPosition(html, old.title)).toBeGreaterThan(answerPosition(html, "首轮分析结论"));
		expect(cardPosition(html, old.title)).toBeLessThan(userPosition(html, "目前用的什么模型"));
		expect(html.slice(userPosition(html, "目前用的什么模型"))).not.toContain('class="research-result-card"');
	});

	it("does not append old results after a completed follow-up without a new artifact", () => {
		const old = result("old", "历史协议分析产物");
		seam.state.entries = [user("恢复协议"), answer("已恢复通信协议", [old]), user("还要多久"), answer("预计还需要五分钟")];
		seam.state.results = [old];
		const html = render();
		expect(cardPosition(html, old.title)).toBeLessThan(userPosition(html, "还要多久"));
		expect(html.slice(answerPosition(html, "预计还需要五分钟"))).not.toContain('class="research-result-card"');
	});

	it("places new results after their own turn and deduplicates the same result within a turn", () => {
		const old = result("old", "第一轮产物");
		const next = result("next", "第二轮产物");
		seam.state.entries = [user("第一轮请求"), answer("第一轮结论", [old]), user("第二轮请求"), answer("第二轮结论", [next, next]), user("第三轮请求")];
		seam.state.results = [old, next];
		const html = render();
		expect(cardPosition(html, old.title)).toBeLessThan(userPosition(html, "第二轮请求"));
		expect(cardPosition(html, next.title)).toBeGreaterThan(answerPosition(html, "第二轮结论"));
		expect(cardPosition(html, next.title)).toBeLessThan(userPosition(html, "第三轮请求"));
	});

	it("shows a successful live tool result before its final answer arrives", () => {
		const live = result("live", "运行中的实际产物");
		seam.state.entries = [user("继续分析"), answer("", [live])];
		seam.state.results = [live];
		seam.state.running = true;
		const html = render();
		const activityPosition = html.indexOf('class="owl-response-activity"');
		expect(activityPosition).toBeGreaterThanOrEqual(0);
		expect(cardPosition(html, live.title)).toBeGreaterThan(userPosition(html, "继续分析"));
		expect(cardPosition(html, live.title)).toBeLessThan(activityPosition);
	});

	it("uses the latest published revision within one turn while keeping earlier turns independent", () => {
		const original = result("shared", "首轮保存的产物版本");
		const intermediate = result("shared", "次轮中间版本");
		const revised = result("shared", "次轮最终版本");
		seam.state.entries = [user("首轮版本请求"), answer("首轮版本结论", [original]), user("修订产物"), answer("", [intermediate]), answer("修订完成", [revised]), user("修订后的追问")];
		seam.state.results = [revised];
		const html = render();
		expect(cardPosition(html, original.title)).toBeLessThan(userPosition(html, "修订产物"));
		expect(html).not.toContain(`<strong>${intermediate.title}</strong>`);
		expect(cardPosition(html, revised.title)).toBeGreaterThan(answerPosition(html, "修订完成"));
		expect(cardPosition(html, revised.title)).toBeLessThan(userPosition(html, "修订后的追问"));
	});

	it("keeps queued follow-ups inside the active turn until they are delivered", () => {
		const live = result("live", "排队跟进期间的产物");
		seam.state.entries = [user("执行当前研究"), answer("", [live]), user("排队的补充信息", true), answer("当前轮最终结论")];
		seam.state.results = [live];
		seam.state.running = true;
		const html = render();
		expect(cardPosition(html, live.title)).toBeGreaterThan(answerPosition(html, "当前轮最终结论"));
	});

	it("does not show failed tool results as published cards", () => {
		const failed = result("failed", "失败工具的无效产物");
		seam.state.entries = [user("尝试分析"), answer("工具执行失败", [failed], "error")];
		const html = render();
		expect(html).not.toContain(`<strong>${failed.title}</strong>`);
		expect(html).not.toContain('class="research-result-card"');
	});

	it("does not treat unrelated tools carrying a research-shaped payload as published results", () => {
		const unexpected = result("unexpected", "非研究工具夹带的结果");
		const entry = answer("普通工具执行完毕", [unexpected]);
		if (entry.kind !== "assistant") throw new Error("Fixture did not produce an assistant entry");
		entry.tools[0]!.name = "write";
		seam.state.entries = [user("执行普通工具"), entry, { kind: "toolResult", toolName: "read", ok: true, brief: "普通读取结果", researchResult: unexpected }];
		seam.state.results = [unexpected];
		const html = render();
		expect(html).not.toContain(`<strong>${unexpected.title}</strong>`);
		expect(html).not.toContain('class="research-result-cards"');
	});

	it("does not leave empty artifact containers in turns without published results", () => {
		seam.state.entries = [user("第一次纯追问"), answer("第一次说明"), user("第二次纯追问"), answer("第二次说明")];
		const html = render();
		answerPosition(html, "第一次说明");
		answerPosition(html, "第二次说明");
		expect(html).not.toContain('class="research-result-cards"');
	});

	it("restores orphan tool results into the correct turns even when snapshots have no timestamps", () => {
		const first = result("first-orphan", "首轮孤立工具产物");
		const second = result("second-orphan", "次轮孤立工具产物");
		seam.state.entries = rebuild([
			{ role: "user", content: "首轮孤立恢复请求" },
			{ role: "toolResult", toolCallId: "missing-first", toolName: "research_executable", isError: false, content: [{ type: "text", text: "首轮原始工具记录" }], details: { researchResult: first } },
			{ role: "assistant", content: [{ type: "text", text: "首轮恢复结论" }] },
			{ role: "user", content: "次轮孤立恢复请求" },
			{ role: "toolResult", toolCallId: "missing-second", toolName: "research_decompile", isError: false, content: [{ type: "text", text: "次轮原始工具记录" }], details: { researchResult: second } },
			{ role: "assistant", content: [{ type: "text", text: "次轮恢复结论" }] },
			{ role: "user", content: "孤立恢复后的纯追问" },
		]);
		seam.state.results = [first, second];
		const html = render();
		expect(cardPosition(html, first.title)).toBeGreaterThan(answerPosition(html, "首轮恢复结论"));
		expect(cardPosition(html, first.title)).toBeLessThan(userPosition(html, "次轮孤立恢复请求"));
		expect(cardPosition(html, second.title)).toBeGreaterThan(answerPosition(html, "次轮恢复结论"));
		expect(cardPosition(html, second.title)).toBeLessThan(userPosition(html, "孤立恢复后的纯追问"));
		expect(html.slice(userPosition(html, "孤立恢复后的纯追问"))).not.toContain('class="research-result-cards"');
	});

	it("restores the same artifact placement and does not carry cards into another session", () => {
		const old = result("old", "恢复会话中的历史产物");
		seam.state.entries = [user("恢复研究任务"), answer("恢复前的分析结论", [old]), user("恢复后的追问")];
		seam.state.results = [old];
		const restored = render();
		expect(cardPosition(restored, old.title)).toBeLessThan(userPosition(restored, "恢复后的追问"));
		seam.state = { ...seam.state, sessionId: "research-2", entries: [user("另一个会话的问题"), answer("另一个会话的回答")], results: [] };
		const nextSession = render();
		expect(nextSession).not.toContain(old.title);
		expect(nextSession).not.toContain('class="research-result-card"');
	});
});
