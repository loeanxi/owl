import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEventMessage } from "../../bridge/protocol.ts";
import { applyEvent, type ChatEntry, type ToolCard, type ToolStatus } from "../../hooks/transcript.ts";
import { setUiLanguage, t } from "../../i18n/index.ts";
import { setSessionFeed } from "../feed.ts";
import { TasksTab } from "./TasksTab.tsx";

const NOW = 1_792_022_405_000;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setUiLanguage("zh");
	setSessionFeed({ running: false, entries: [] });
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	setSessionFeed({ running: false, entries: [] });
	setUiLanguage("zh");
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function tool(id: string, status: ToolStatus, extra: Partial<ToolCard> = {}): ToolCard {
	return { id, name: "read", args: "{}", summary: `读取 \`${id}.txt\``, status, ...extra };
}

function assistant(tools: ToolCard[]): ChatEntry {
	return { kind: "assistant", text: "", thinking: "", tools };
}

async function render(entries: ChatEntry[], running = true): Promise<void> {
	await act(async () => {
		setSessionFeed({ running, entries });
		root.render(<TasksTab />);
	});
}

function row(id: string): HTMLElement {
	const element = container.querySelector<HTMLElement>(`[data-tool-id="${id}"]`);
	if (!element) throw new Error(`Missing tool: ${id}`);
	return element;
}

function event(entries: ChatEntry[], payload: Record<string, unknown>): ChatEntry[] {
	return applyEvent(entries, { type: "event", sessionId: "session", event: payload } as unknown as ServerEventMessage);
}

describe("TasksTab real task states", () => {
	it("labels all five states visibly and accessibly, with success styling only on actual success", async () => {
		const statuses: ToolStatus[] = ["pending", "running", "ok", "error", "cancelled"];
		await render([{ kind: "user", text: "检查项目" }, assistant(statuses.map((status) => tool(status, status)))]);
		for (const status of statuses) {
			const current = row(status);
			const label = t(`tasks.${status}`);
			expect(current.getAttribute("data-status")).toBe(status);
			expect(current.textContent).toContain(label);
			expect(
				current.querySelector(`[aria-label="${t("tasks.toolState", { name: "read", status: label })}"]`),
			).not.toBeNull();
			expect(current.querySelector("[aria-hidden='true']")?.className.includes("bg-emerald-500")).toBe(
				status === "ok",
			);
		}
		expect(row("error").querySelector("[aria-hidden='true']")?.className).toContain("bg-red-400");
		expect(container.textContent).toContain(t("tasks.stats", { rounds: 1, tools: 5 }));
	});

	it("follows actual call, execution and cancellation events without counting a cancellation as success", async () => {
		let entries: ChatEntry[] = [{ kind: "user", text: "检查" }];
		entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
		entries = event(entries, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { id: "call", name: "read", arguments: { path: "file.txt" } },
			},
		});
		await render(entries);
		expect(row("call").textContent).toContain(t("tasks.pending"));
		expect(row("call").querySelector("time")).toBeNull();
		entries = event(entries, {
			type: "tool_execution_start",
			toolCallId: "call",
			toolName: "read",
			args: { path: "file.txt" },
		});
		await render(entries);
		expect(row("call").textContent).toContain(t("tasks.running"));
		await act(async () => vi.advanceTimersByTime(3000));
		expect(row("call").querySelector("[data-elapsed-ms]")?.getAttribute("data-elapsed-ms")).toBe("3000");
		entries = event(entries, {
			type: "tool_execution_end",
			toolCallId: "call",
			toolName: "read",
			isError: true,
			result: { content: [{ type: "text", text: "Operation aborted" }] },
		});
		await render(entries, false);
		expect(row("call").getAttribute("data-status")).toBe("cancelled");
		expect(row("call").textContent).toContain(t("tasks.cancelled"));
		expect(row("call").textContent).toContain(t("tasks.duration", { time: "3.0s" }));
		expect(row("call").innerHTML).not.toContain("bg-emerald-500");
		await act(async () => vi.advanceTimersByTime(60_000));
		expect(row("call").querySelector("[data-elapsed-ms]")?.getAttribute("data-elapsed-ms")).toBe("3000");
	});

	it("keeps queued follow-ups visible without incrementing executed rounds until delivery", async () => {
		const queued: ChatEntry = { kind: "user", text: "稍后分析另一文件", queued: true };
		await render([{ kind: "user", text: "当前任务" }, assistant([tool("active", "running")]), queued]);
		expect(container.textContent).toContain(t("tasks.stats", { rounds: 1, tools: 1 }));
		expect(container.querySelector("[data-task-queued='true']")?.textContent).toContain(t("tasks.queued"));
		expect(container.textContent).not.toContain(t("tasks.round", { n: 2 }));
		await render([
			{ kind: "user", text: "当前任务" },
			assistant([tool("active", "ok")]),
			{ ...queued, queued: false },
		]);
		expect(container.textContent).toContain(t("tasks.stats", { rounds: 2, tools: 1 }));
		expect(container.querySelector("[data-task-queued='true']")).toBeNull();
		expect(container.textContent).toContain(t("tasks.round", { n: 2 }));
	});

	it("does not claim an executed round when the only user message is queued", async () => {
		await render([{ kind: "user", text: "尚未执行", queued: true }], false);
		expect(container.textContent).toContain(t("tasks.stats", { rounds: 0, tools: 0 }));
		expect(container.textContent).toContain(t("tasks.queued"));
		expect(container.querySelector("[role='status']")?.textContent).toBe(t("tasks.idle"));
	});

	it("shows actual start/end timestamps and freezes completed duration while a parallel tool keeps running", async () => {
		const start = NOW - 5000;
		await render([
			assistant([
				tool("done", "ok", { startedAt: start, finishedAt: start + 2000 }),
				tool("active", "running", { startedAt: start }),
			]),
		]);
		const stamps = [...row("done").querySelectorAll("time")];
		// linkedom retains React's camel-case spelling on the <time> attribute.
		expect(stamps.map((stamp) => stamp.getAttribute("dateTime"))).toEqual([
			new Date(start).toISOString(),
			new Date(start + 2000).toISOString(),
		]);
		expect(row("done").textContent).toContain(t("tasks.duration", { time: "2.0s" }));
		expect(row("active").textContent).toContain(t("tasks.elapsed", { time: "5.0s" }));
		await act(async () => vi.advanceTimersByTime(3000));
		expect(row("active").querySelector("[data-elapsed-ms]")?.getAttribute("data-elapsed-ms")).toBe("8000");
		expect(row("done").querySelector("[data-elapsed-ms]")?.getAttribute("data-elapsed-ms")).toBe("2000");
	});

	it("leaves missing, invalid, and inverted timing unknown instead of inventing elapsed time", async () => {
		await render([
			assistant([
				tool("missing", "ok"),
				tool("end-only", "error", { finishedAt: NOW }),
				tool("invalid", "running", { startedAt: Number.NaN, finishedAt: Number.POSITIVE_INFINITY }),
				tool("inverted", "ok", { startedAt: NOW, finishedAt: NOW - 1000 }),
			]),
		]);
		expect(container.querySelector("[data-elapsed-ms]")).toBeNull();
		expect(row("missing").querySelector("time")).toBeNull();
		expect(row("invalid").querySelector("time")).toBeNull();
		expect(row("end-only").querySelectorAll("time")).toHaveLength(1);
		expect(container.textContent).not.toContain("NaN");
		expect(container.textContent).not.toContain("1970");
	});

	it("does not tick pending, interrupted, or stale idle tools without a real finish timestamp", async () => {
		await render(
			[
				assistant([
					tool("pending", "pending", { startedAt: NOW - 1000 }),
					tool("cancelled", "cancelled", { startedAt: NOW - 1000 }),
					tool("stale", "running", { startedAt: NOW - 1000 }),
				]),
			],
			false,
		);
		expect(vi.getTimerCount()).toBe(0);
		await act(async () => vi.advanceTimersByTime(60_000));
		expect(container.querySelector("[data-elapsed-ms]")).toBeNull();
		expect(container.querySelector("[role='status']")?.textContent).toBe(t("tasks.idle"));
		expect(container.textContent).not.toContain(t("chat.pausedHint"));
	});

	it("does not show a negative or fabricated zero duration for a future start timestamp", async () => {
		await render([assistant([tool("future", "running", { startedAt: NOW + 30_000 })])]);
		expect(row("future").querySelector("time")?.getAttribute("dateTime")).toBe(new Date(NOW + 30_000).toISOString());
		expect(row("future").querySelector("[data-elapsed-ms]")).toBeNull();
	});

	it("updates status text and accessibility labels when the UI language changes", async () => {
		await render([assistant([tool("pending", "pending"), tool("cancelled", "cancelled")])]);
		await act(async () => setUiLanguage("en"));
		expect(row("pending").textContent).toContain("Pending");
		expect(row("cancelled").textContent).toContain("Interrupted");
		expect(row("pending").querySelector("[aria-label='read: Pending']")).not.toBeNull();
	});

	it("explains orphan tool-result success and failure with visible labels", async () => {
		await render(
			[
				{ kind: "toolResult", toolName: "read", ok: true, brief: "file content" },
				{ kind: "toolResult", toolName: "bash", ok: false, brief: "exit 1" },
			],
			false,
		);
		expect(
			container.querySelector(`[aria-label="${t("tasks.toolState", { name: "read", status: t("tasks.ok") })}"]`)
				?.textContent,
		).toContain(t("tasks.ok"));
		expect(
			container.querySelector(`[aria-label="${t("tasks.toolState", { name: "bash", status: t("tasks.error") })}"]`)
				?.textContent,
		).toContain(t("tasks.error"));
	});

	it("clears the live clock when the tab switches to idle or unmounts", async () => {
		const entries = [assistant([tool("live", "running", { startedAt: NOW - 1000 })])];
		await render(entries);
		expect(vi.getTimerCount()).toBe(1);
		await render(entries, false);
		expect(vi.getTimerCount()).toBe(0);
		await render(entries, true);
		expect(vi.getTimerCount()).toBe(1);
		await act(async () => root.render(<div />));
		expect(vi.getTimerCount()).toBe(0);
	});
});
