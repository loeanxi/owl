import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
	const labels = [...html.matchAll(/class="owl-tool-summary owl-work-process-summary"[^>]*>.*?<span class="min-w-0 flex-1 truncate">([^<]+)<\/span>/gs)].map(match => match[1]!);
	return { html, labels, live: labels.filter(label => label.startsWith("正在工作")) };
}

describe("chat work segment status", () => {
	it.each(["working", "waiting"] as const)("keeps prose between tool segments and gives only the tail a live timer while %s", (activity) => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("first", "ok", 5000), tool("second", "running")], {
				text: "重新观察当前窗口", endedAt: 6000,
				segments: [{ kind: "tool", toolId: "first" }, { kind: "text", text: "重新观察当前窗口" }, { kind: "tool", toolId: "second" }],
			}),
		];
		const { html, labels, live } = render(entries, activity);
		expect(labels).toHaveLength(2);
		expect(live).toHaveLength(1);
		expect(labels[0]).toBe("工作了 5s");
		expect(live[0]).toBe("正在工作 24s");
		expect(html.indexOf(labels[0]!)).toBeLessThan(html.indexOf("重新观察当前窗口"));
		expect(html.indexOf("重新观察当前窗口")).toBeLessThan(html.indexOf(live[0]!));
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
		expect(render(entries).labels[0]).toBe("工作了 5s");
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

	it("times each completed segment on its own instead of from the turn start", () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "test", timestamp: 1000 },
			assistant([tool("first", "ok", 5000), tool("second", "ok", 9000)], {
				text: "继续", endedAt: 6000,
				segments: [{ kind: "tool", toolId: "first" }, { kind: "text", text: "继续" }, { kind: "tool", toolId: "second" }],
			}),
		];
		expect(render(entries, "idle").labels).toEqual(["工作了 5s", "工作了 3s"]);
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
		expect(render(entries).labels).toEqual(["工作了 4s", "正在工作 10s"]);
	});
});
