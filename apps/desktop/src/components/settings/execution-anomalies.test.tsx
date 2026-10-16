import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ExecutionAnomalyListResult, ExecutionAnomalyRecord } from "../../bridge/protocol.ts";
import { setUiLanguage } from "../../i18n/index.ts";
import { ExecutionAnomaliesSection } from "./ExecutionAnomaliesSection.tsx";

const createdAt = Date.UTC(2026, 9, 15, 8, 30);

function record(patch: Partial<ExecutionAnomalyRecord> = {}): ExecutionAnomalyRecord {
	return { id: "anomaly-1", sessionId: "session-1", sessionName: "修复执行链路", sessionFile: "D:/profile/sessions/session-1.jsonl", cwd: "D:/owl", provider: "example", model: "test-model", toolCallId: "call-1", toolName: "bash", kind: "tool_error", summary: "命令执行失败", details: "Permission denied\n<script>alert('error')</script>", createdAt, updatedAt: createdAt, status: "pending", ...patch };
}

let root: Root;
let host: HTMLElement;
let client: BridgeClient;
let list: ReturnType<typeof vi.fn<BridgeClient["listExecutionAnomalies"]>>;
let processAnomaly: ReturnType<typeof vi.fn<BridgeClient["processExecutionAnomaly"]>>;
let restoreAnomaly: ReturnType<typeof vi.fn<BridgeClient["restoreExecutionAnomaly"]>>;
let unsubscribe: ReturnType<typeof vi.fn>;
let onOpenSession: ReturnType<typeof vi.fn>;
let changed: (() => void) | undefined;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	for (const element of [dom.window.HTMLInputElement, dom.window.HTMLTextAreaElement]) Object.assign(element.prototype, {
		attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
		detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
	});
	setUiLanguage("zh");
	changed = undefined;
	unsubscribe = vi.fn();
	onOpenSession = vi.fn();
	list = vi.fn(async () => ({ ok: true, result: { records: [record()], total: 1 } }));
	processAnomaly = vi.fn(async ({ kind, note, verification }) => ({ ok: true, result: record({ processing: { kind, note, verification, processedAt: createdAt + 4_000 } }) }));
	restoreAnomaly = vi.fn(async () => ({ ok: true, result: record() }));
	client = { listExecutionAnomalies: list, processExecutionAnomaly: processAnomaly, restoreExecutionAnomaly: restoreAnomaly, onExecutionAnomaliesChanged: (handler: () => void) => { changed = handler; return unsubscribe; } } as unknown as BridgeClient;
	host = document.getElementById("root")!;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function render(open = true): Promise<void> {
	await act(async () => root.render(<div className="owl-settings-page"><ExecutionAnomaliesSection client={client} onOpenSession={open ? onOpenSession : undefined} /></div>));
}

function button(label: string): HTMLButtonElement {
	return [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label)!;
}

async function processingView(value: "active" | "optimized" | "dismissed" | "all"): Promise<void> {
	await act(async () => {
		const select = host.querySelector("select")!;
		for (const option of select.querySelectorAll("option")) option.removeAttribute("selected");
		select.querySelector(`option[value="${value}"]`)!.setAttribute("selected", "");
		select.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
}

async function submitProcessing(): Promise<void> {
	// Linkedom does not synthesize a form submit from a submit button click.
	await act(async () => host.querySelector(".owl-execution-anomaly-processing form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
}

async function fillProcessing(note: string, verification: string): Promise<void> {
	for (const [index, value] of [note, verification].entries()) await act(async () => {
		const field = host.querySelectorAll("textarea")[index];
		field.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
		field.dispatchEvent(new window.Event("keyup", { bubbles: true }));
		field.dispatchEvent(new window.Event("focusout", { bubbles: true }));
	});
}

describe("Settings execution anomalies", () => {
	it("shows captured evidence and pending model reporting separately, with safe text and session navigation", async () => {
		await render();
		expect(list).toHaveBeenCalledExactlyOnceWith({ query: undefined, status: undefined, processing: "active", limit: 40, offset: 0 });
		expect(host.textContent).toContain("待模型上报");
		expect(host.textContent).toContain("修复执行链路");
		expect(host.textContent).toContain("example / test-model");
		expect(host.textContent).toContain("bash");
		expect(host.textContent).toContain("D:/owl");
		expect(host.querySelector("details pre")?.textContent).toBe(record().details);
		expect(host.querySelector("script")).toBeNull();
		expect(host.querySelector("time")?.getAttribute("dateTime")).toBe(new Date(createdAt).toISOString());
		expect(host.querySelector(".owl-execution-anomaly-awaiting")?.textContent).toContain("等待执行该会话的模型");
		expect(host.querySelector(".owl-execution-anomaly-report")).toBeNull();
		await act(async () => button("打开会话").click());
		expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(record());
	});

	it("shows the model's cause, action and assessment without replacing original evidence", async () => {
		list.mockResolvedValueOnce({ ok: true, result: { records: [record({ status: "reported", report: { cause: "路径错误", action: "已改为绝对路径并重试", outcome: "resolved", reportedAt: createdAt + 2_000 } })], total: 1 } });
		await render(false);
		expect(host.querySelector(".owl-execution-anomaly-report")?.textContent).toContain("模型上报说明");
		expect(host.querySelector(".owl-execution-anomaly-report")?.textContent).toContain("路径错误");
		expect(host.querySelector(".owl-execution-anomaly-report")?.textContent).toContain("已改为绝对路径并重试");
		expect(host.querySelector(".owl-execution-anomaly-report")?.textContent).toContain("模型判断已解决");
		expect(host.querySelector("details pre")?.textContent).toBe(record().details);
		expect(host.querySelector(".owl-execution-anomaly-awaiting")).toBeNull();
		expect(button("打开会话")).toBeUndefined();
	});

	it("submits search text and combines it with a status filter", async () => {
		await render();
		const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
		await act(async () => {
			input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
			Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "  bash  ");
			input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
		});
		expect(list).toHaveBeenCalledTimes(1);
		await act(async () => host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
		expect(list).toHaveBeenLastCalledWith({ query: "bash", status: undefined, processing: "active", limit: 40, offset: 0 });
		await act(async () => button("待模型上报").click());
		expect(list).toHaveBeenLastCalledWith({ query: "bash", status: "pending", processing: "active", limit: 40, offset: 0 });
		expect(button("待模型上报").getAttribute("aria-pressed")).toBe("true");
		await act(async () => button("已上报").click());
		expect(list).toHaveBeenLastCalledWith({ query: "bash", status: "reported", processing: "active", limit: 40, offset: 0 });
		await processingView("optimized");
		expect(list).toHaveBeenLastCalledWith({ query: "bash", status: "reported", processing: "optimized", limit: 40, offset: 0 });
	});

	it("renders loading, failure recovery and a genuine empty state", async () => {
		let finish!: (value: { ok: boolean; result?: ExecutionAnomalyListResult; error?: string }) => void;
		list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		await render();
		expect(host.querySelector('[aria-busy="true"]')?.textContent).toContain("正在加载");
		expect(button("刷新").disabled).toBe(true);
		await act(async () => finish({ ok: false, error: "Bridge unavailable" }));
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("Bridge unavailable");
		list.mockResolvedValueOnce({ ok: true, result: { records: [], total: 0 } });
		await act(async () => button("重试").click());
		expect(host.querySelector('[role="alert"]')).toBeNull();
		expect(host.textContent).toContain("暂无未处理的执行异常");
		expect(button("刷新").disabled).toBe(false);
	});

	it("ignores stale requests and automatically refreshes on log changes", async () => {
		let finish!: (value: { ok: boolean; result: ExecutionAnomalyListResult }) => void;
		list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		await render();
		list.mockResolvedValueOnce({ ok: true, result: { records: [record({ id: "new", summary: "新的异常" })], total: 1 } });
		await act(async () => button("已上报").click());
		await act(async () => finish({ ok: true, result: { records: [record()], total: 1 } }));
		expect(host.querySelector("article h3")?.textContent).toBe("新的异常");
		list.mockResolvedValueOnce({ ok: true, result: { records: [], total: 0 } });
		await act(async () => changed?.());
		expect(list).toHaveBeenCalledTimes(3);
		expect(host.textContent).toContain("没有匹配的执行异常");
		await act(async () => root.unmount());
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("paginates and returns to the first page after changing filters", async () => {
		list.mockImplementation(async (filter) => ({ ok: true, result: { records: [record({ id: `anomaly-${filter?.offset ?? 0}` })], total: 41 } }));
		await render();
		expect(button("上一页").disabled).toBe(true);
		await act(async () => button("下一页").click());
		expect(list).toHaveBeenLastCalledWith({ query: undefined, status: undefined, processing: "active", limit: 40, offset: 40 });
		expect(host.textContent).toContain("第 2 / 2 页");
		expect(button("下一页").disabled).toBe(true);
		await act(async () => button("待模型上报").click());
		expect(list).toHaveBeenLastCalledWith({ query: undefined, status: "pending", processing: "active", limit: 40, offset: 0 });
	});

	it("preserves expanded evidence during a refresh and retains it if that refresh fails", async () => {
		await render();
		const evidence = host.querySelector("details")!;
		evidence.open = true;
		let finish!: (value: { ok: boolean; error?: string }) => void;
		list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		await act(async () => changed?.());
		expect(host.querySelector("details")).toBe(evidence);
		expect(host.querySelector("details")?.open).toBe(true);
		expect(host.textContent).toContain("正在刷新…");
		await act(async () => finish({ ok: false, error: "Refresh failed" }));
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("Refresh failed");
		expect(host.querySelector("details")).toBe(evidence);
		expect(host.querySelector("details")?.open).toBe(true);
	});

	it("recovers when a refreshed final page has disappeared", async () => {
		list.mockResolvedValue({ ok: true, result: { records: [record()], total: 41 } });
		await render();
		await act(async () => button("下一页").click());
		list.mockResolvedValue({ ok: true, result: { records: [], total: 0 } });
		await act(async () => changed?.());
		expect(list).toHaveBeenLastCalledWith({ query: undefined, status: undefined, processing: "active", limit: 40, offset: 0 });
		expect(host.textContent).toContain("暂无未处理的执行异常");
		expect(host.querySelector(".owl-execution-anomalies-pagination")).toBeNull();
	});

	it("updates localized copy without loading the log again", async () => {
		await render();
		await act(async () => setUiLanguage("en"));
		expect(host.querySelector("h2")?.textContent).toBe("Execution anomalies");
		expect(button("Awaiting model report").getAttribute("aria-pressed")).toBe("false");
		expect(host.querySelector("input")?.getAttribute("aria-label")).toBe("Search execution anomalies");
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("requires a real processing note and verification before saving, and cancellation writes nothing", async () => {
		await render();
		await act(async () => button("标记已优化").click());
		expect(host.querySelectorAll("textarea")).toHaveLength(2);
		expect([...host.querySelectorAll("textarea")].every((field) => field.hasAttribute("required"))).toBe(true);
		expect(button("保存处理标记").disabled).toBe(true);
		await fillProcessing("  已修正路径  ", "  ");
		expect(button("保存处理标记").disabled).toBe(true);
		await submitProcessing();
		expect(processAnomaly).not.toHaveBeenCalled();
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("处理说明和验证依据不能为空");
		await act(async () => button("取消").click());
		expect(host.querySelectorAll("textarea")).toHaveLength(0);
		expect(processAnomaly).not.toHaveBeenCalled();
		expect(restoreAnomaly).not.toHaveBeenCalled();
	});

	it.each(["optimized", "dismissed"] as const)("hides %s records from the default view, keeps evidence searchable and restores reversibly", async (kind) => {
		const original = record({ status: "reported", report: { cause: "路径错误", action: "读取实际路径", outcome: "resolved", reportedAt: createdAt + 2_000 } });
		let stored = original;
		list.mockImplementation(async (filter) => {
			const visible = filter?.processing === "all" || (filter?.processing === "active" ? !stored.processing : stored.processing?.kind === filter?.processing);
			return { ok: true, result: { records: visible ? [stored] : [], total: visible ? 1 : 0 } };
		});
		processAnomaly.mockImplementation(async (input) => {
			stored = { ...stored, processing: { kind: input.kind, note: input.note, verification: input.verification, processedAt: createdAt + 4_000 } };
			return { ok: true, result: stored };
		});
		restoreAnomaly.mockImplementation(async () => { stored = original; return { ok: true, result: stored }; });
		await render();
		await act(async () => button(kind === "optimized" ? "标记已优化" : "无需优化").click());
		await fillProcessing("  修正了目录路径  ", "  针对同一路径的 read 回放成功  ");
		expect(button("保存处理标记").disabled).toBe(false);
		await submitProcessing();
		expect(processAnomaly).toHaveBeenCalledExactlyOnceWith({ id: original.id, kind, note: "修正了目录路径", verification: "针对同一路径的 read 回放成功" });
		expect(host.querySelectorAll("article")).toHaveLength(0);
		expect(host.textContent).toContain("暂无未处理的执行异常");
		await processingView(kind);
		expect(list).toHaveBeenLastCalledWith({ query: undefined, status: undefined, processing: kind, limit: 40, offset: 0 });
		expect(host.querySelectorAll("article")).toHaveLength(1);
		expect(host.querySelector(".owl-execution-anomaly-processing h4")?.textContent).toBe(kind === "optimized" ? "已优化" : "无需优化");
		expect(host.querySelector(".owl-execution-anomaly-processing dl")?.textContent).toContain("修正了目录路径");
		expect(host.querySelector(".owl-execution-anomaly-processing dl")?.textContent).toContain("针对同一路径的 read 回放成功");
		expect(host.querySelector("details pre")?.textContent).toBe(original.details);
		expect(host.querySelector(".owl-execution-anomaly-report")?.textContent).toContain(original.report!.cause);
		await processingView("all");
		expect(host.querySelectorAll("article")).toHaveLength(1);
		await processingView(kind);
		await act(async () => button("恢复为未处理").click());
		expect(restoreAnomaly).toHaveBeenCalledExactlyOnceWith(original.id);
		expect(host.querySelectorAll("article")).toHaveLength(0);
		expect(host.textContent).toContain("没有匹配的执行异常");
		await processingView("active");
		expect(host.querySelectorAll("article")).toHaveLength(1);
		expect(host.querySelector("details pre")?.textContent).toBe(original.details);
		expect(host.querySelector(".owl-execution-anomaly-report")?.textContent).toContain(original.report!.cause);
		expect(button("标记已优化")).toBeDefined();
	});

	it("keeps the inline draft on save failure and allows an explicit retry", async () => {
		await render();
		await act(async () => button("标记已优化").click());
		await fillProcessing("修正路径", "回放通过");
		processAnomaly.mockResolvedValueOnce({ ok: false, error: "Write failed" });
		await submitProcessing();
		expect(host.querySelector('[role="alert"]')?.textContent).toBe("Write failed");
		expect([...host.querySelectorAll("textarea")].map((field) => field.value)).toEqual(["修正路径", "回放通过"]);
		expect(button("保存处理标记").disabled).toBe(false);
		list.mockResolvedValueOnce({ ok: true, result: { records: [], total: 0 } });
		await submitProcessing();
		expect(processAnomaly).toHaveBeenCalledTimes(2);
		expect(host.querySelectorAll("article")).toHaveLength(0);
	});

	it("combines processing views with report status and resets pagination", async () => {
		list.mockResolvedValue({ ok: true, result: { records: [record()], total: 41 } });
		await render();
		await act(async () => button("已上报").click());
		await act(async () => button("下一页").click());
		await processingView("optimized");
		expect(list).toHaveBeenLastCalledWith({ query: undefined, status: "reported", processing: "optimized", limit: 40, offset: 0 });
	});

	it("keeps a processed record and its evidence intact if restoring fails", async () => {
		const processed = record({ processing: { kind: "optimized", note: "修正路径", verification: "回放通过", processedAt: createdAt + 4_000 } });
		list.mockImplementation(async (filter) => ({ ok: true, result: { records: filter?.processing === "all" ? [processed] : [], total: filter?.processing === "all" ? 1 : 0 } }));
		restoreAnomaly.mockRejectedValueOnce(new Error("Restore failed"));
		await render();
		await processingView("all");
		await act(async () => button("恢复为未处理").click());
		expect(host.querySelector('[role="alert"]')?.textContent).toBe("Restore failed");
		expect(host.querySelectorAll("article")).toHaveLength(1);
		expect(host.querySelector("details pre")?.textContent).toBe(processed.details);
		expect(host.querySelector(".owl-execution-anomaly-processing h4")?.textContent).toBe("已优化");
		expect(button("恢复为未处理").disabled).toBe(false);
		expect(list).toHaveBeenCalledTimes(2);
	});
});
