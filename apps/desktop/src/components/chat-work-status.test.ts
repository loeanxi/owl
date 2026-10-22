import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEventMessage } from "../bridge/protocol.ts";
import { applyEvent, type ChatEntry, type ToolCard } from "../hooks/transcript.ts";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("../i18n/index.ts", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("../i18n/index.ts");
	return { ...actual, useT: () => actual.t };
});

beforeEach(() => {
	vi.stubGlobal("document", { documentElement: { dataset: {} } });
	vi.useFakeTimers();
	vi.setSystemTime(30_000);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const tool = (id: string, status: ToolCard["status"], finishedAt?: number): ToolCard => ({
	id, name: "computer_observe", args: "{}", summary: id, status, startedAt: 2000,
	...(finishedAt === undefined ? {} : { finishedAt }),
});

function assistant(tools: ToolCard[], extra: Partial<Extract<ChatEntry, { kind: "assistant" }>> = {}): ChatEntry {
	return { kind: "assistant", text: "", thinking: "", tools, timestamp: 2000, ...extra };
}

function render(entries: ChatEntry[], activity: "idle" | "working" | "waiting" = "working") {
	const html = renderToStaticMarkup(createElement(ChatStream, { entries, activity }));
	const { document } = parseHTML(html);
	const labels = [...document.querySelectorAll(".owl-work-process-summary")].map((summary) => {
		const primary = summary.querySelector(".owl-work-primary");
		const metadata = summary.querySelector(".owl-work-metadata")?.textContent ?? "";
		const elapsed = metadata.match(/^\d+(?:h(?: \d+m)?|m(?: \d+s)?|s)/)?.[0];
		return elapsed ? `${primary?.getAttribute("role") === "status" ? "正在工作" : "工作了"} ${elapsed}` : `${primary?.textContent ?? ""} ${metadata}`;
	});
	return { html, labels, live: labels.filter(label => label.startsWith("正在工作")) };
}

describe("chat work segment status", () => {
	it("renders no global activity status row; state text lives in the island and composer", () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([], {
				usage: { input: 100, output: 40, cacheRead: 60, cacheWrite: 0 },
				stream: { firstAt: 1000, lastAt: 3000, estTokens: 40 },
			}),
		];
		expect(parseHTML(render(entries).html).document.querySelector(".owl-response-activity")).toBeNull();
		expect(parseHTML(render(entries, "waiting").html).document.querySelector(".owl-response-activity")).toBeNull();
	});

	it("keeps the same usage details on the completed answer actions, aligned to the right", () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([], {
				text: "完成",
				endedAt: 6000,
				usage: { input: 100, output: 40, cacheRead: 60, cacheWrite: 0 },
				// 响应 2000 开始、6000 结束：40 输出 ÷ 4s = 10 tok/s；流式窗口落在响应窗口内
				stream: { firstAt: 2000, lastAt: 5000, estTokens: 40 },
			}),
		];
		const { document } = parseHTML(render(entries, "idle").html);
		expect(document.querySelector(".owl-response-activity")).toBeNull();
		const footer = document.querySelector(".owl-msg-actions");
		const details = footer?.querySelector("details.owl-response-details");
		expect(details?.querySelector("summary")?.getAttribute("aria-label")).toBe("本轮累计 200 tok（含缓存） · 1 次调用");
		expect(details?.querySelector(".owl-response-metrics")?.textContent).toContain("输出 40 / 总 200 tokens");
		expect(details?.querySelector(".owl-response-metrics")?.textContent).toContain("10 tok/s");
		expect(details?.querySelector(".owl-response-usage")?.textContent).toContain("未缓存输入 100 · 输出 40 · 缓存读 60 · 缓存写 0");
		expect(footer?.lastElementChild).toBe(details);
	});

	it.each(["working", "waiting"] as const)("keeps one live timer for the turn when public progress sits inside the work process during %s", (activity) => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("first", "ok", 5000), tool("second", "running")], {
				text: "重新观察当前窗口", endedAt: 6000,
				segments: [{ kind: "tool", toolId: "first" }, { kind: "text", text: "重新观察当前窗口" }, { kind: "tool", toolId: "second" }],
			}),
		];
		const { labels, live } = render(entries, activity);
		// 公开进展并进工作过程后，一轮只有一个折叠行，也只有一个计时器：
		// 已完成的 5s 与仍在跑的 24s 合起来是本轮连续工作的 29s。
		expect(labels).toHaveLength(1);
		expect(live).toHaveLength(1);
		expect(labels).toEqual(["正在工作 29s"]);
	});

	it("does not revive a sealed segment even when its tool has a stale running status", () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("first", "running", 5000), tool("second", "running")], {
				text: "继续", endedAt: 6000,
				segments: [{ kind: "tool", toolId: "first" }, { kind: "text", text: "继续" }, { kind: "tool", toolId: "second" }],
			}),
		];
		expect(render(entries).live).toHaveLength(1);
		expect(render(entries).labels).toEqual(["正在工作 29s"]);
		vi.setSystemTime(45_000);
		expect(render(entries).labels).toEqual(["正在工作 44s"]);
	});

	it("keeps a paused segment fixed and starts continuation timing after the pause", () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("old", "cancelled", 7000)], { endedAt: 6000, aborted: true }),
			assistant([tool("resumed", "running")], { timestamp: 20_000 }),
		];
		const first = render(entries);
		expect(first.labels).toEqual(["工作了 6s", "正在工作 10s"]);
		vi.setSystemTime(45_000);
		expect(render(entries).labels).toEqual(["工作了 6s", "正在工作 25s"]);
	});

	it("does not manufacture a live row for an idle queued message", () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("done", "ok", 5000)]),
			{ kind: "user", text: "queued", queued: true, timestamp: 10_000 },
		];
		expect(render(entries, "idle").live).toHaveLength(0);
		expect(render(entries).live).toHaveLength(1);
	});

	it("uses step text when an ended historical segment has no end timestamp", () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("cancelled", "cancelled")], { aborted: true }),
		];
		expect(render(entries, "idle").labels[0]).toContain("工作过程");
		vi.setSystemTime(100_000_000);
		expect(render(entries, "idle").labels[0]).toContain("工作过程");
	});

	it("includes the final answer generation in a completed work segment", () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("done", "ok", 5000)], { endedAt: 5000 }),
			assistant([], { text: "完成", timestamp: 6000, endedAt: 10_000 }),
		];
		expect(render(entries, "idle").labels).toEqual(["工作了 9s"]);
	});

	it("keeps one timing origin for the turn when public progress sits inside the work process", () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("first", "ok", 5000), tool("second", "ok", 9000)], {
				text: "继续", endedAt: 6000,
				segments: [{ kind: "tool", toolId: "first" }, { kind: "text", text: "继续" }, { kind: "tool", toolId: "second" }],
			}),
		];
		// 一轮只有一个折叠行，耗时按本轮连续工作时间合并（5s + 3s = 8s）。
		expect(render(entries, "idle").labels).toEqual(["工作了 8s"]);
	});

	it("uses the real continuation run boundary even without a new user or an aborted message", () => {
		const history: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("old", "ok", 5000)], { endedAt: 5000 }),
		];
		let entries = applyEvent(history, { type: "event", sessionId: "test", event: { type: "agent_start" } } as ServerEventMessage);
		expect(render(entries).live).toHaveLength(0);
		entries = applyEvent(entries, { type: "event", sessionId: "test", event: {
			type: "message_start", message: { role: "assistant", timestamp: 20_000, content: [] },
		} } as ServerEventMessage);
		entries = applyEvent(entries, { type: "event", sessionId: "test", event: {
			type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "继续处理" },
		} } as ServerEventMessage);
		expect(render(entries).labels).toEqual(["正在工作 14s"]);
	});
});
