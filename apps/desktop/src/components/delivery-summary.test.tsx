import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";
import { DeliverySummary } from "./DeliverySummary.tsx";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Node", dom.window.Node); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = dom.document.getElementById("root")!; root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const check: ToolCard = { id: "run", name: "bash", args: JSON.stringify({ command: "node verify.mjs" }), summary: "页面检查", status: "ok", output: { text: "6 interactions passed", totalLines: 1 } };
function entries(linked: boolean): ChatEntry[] {
	const report = { goal: "界面优化", criteria: [{ criterion: "交互已核对", status: "verified", evidence: "已执行页面交互检查并核对结果", ...(linked ? { toolCallId: "run" } : {}) }, { criterion: "线上部署", status: "pending" }, { criterion: "设备验收", status: "blocked", evidence: "验收设备尚未连接" }] };
	return [{ kind: "user", text: "实现界面" }, { kind: "assistant", text: "已处理", thinking: "", tools: [check, { id: "report", name: "task_check", args: JSON.stringify(report), summary: "记录验收", status: "ok", output: { text: JSON.stringify(report), totalLines: 1 } }] }];
}
describe("delivery summary display", () => {
	it("shows no panel unless the agent registered an acceptance checklist", async () => {
		await act(async () => root.render(<DeliverySummary entries={[{ kind: "assistant", text: "done", thinking: "", tools: [check] }]} />));
		expect(container.textContent).toBe("");
	});
	it("shows linked execution output, pending work and blocking reasons without inventing a task-level pass", async () => {
		await act(async () => root.render(<DeliverySummary entries={entries(true)} />));
		expect(container.textContent).toContain("验收结论由 Agent 提交"); expect(container.textContent).toContain("已关联成功执行记录"); expect(container.textContent).toContain("6 interactions passed"); expect(container.textContent).toContain("待验证"); expect(container.textContent).toContain("受阻"); expect(container.textContent).toContain("验收设备尚未连接");
		// 文件清单与命令流水由改动卡和工作过程承担，这里不再重复。
		expect(container.textContent).not.toContain("本轮执行记录"); expect(container.textContent).not.toContain("个文件");
	});
	it("separates the agent's assertion from an actual linked execution", async () => { await act(async () => root.render(<DeliverySummary entries={entries(false)} />)); expect(container.textContent).toContain("未关联执行记录"); expect(container.querySelectorAll("li pre")).toHaveLength(0); });
	it("badges the collapsed outcome by severity and marks per-item status for coloring", async () => {
		await act(async () => root.render(<DeliverySummary entries={entries(true)} />));
		// 有受阻 → 收起态徽标红 tone，文本直接说几项受阻。
		const badge = container.querySelector<HTMLElement>(".owl-delivery-outcome");
		expect(badge?.dataset.tone).toBe("blocked");
		expect(badge?.textContent).toBe("1 项受阻");
		// 每项 li 带 data-status，供 CSS 着色（成功绿 / 受阻红 / 待验证琥珀）。
		expect([...container.querySelectorAll("li[data-status]")].map((item) => item.getAttribute("data-status"))).toEqual(["verified", "pending", "blocked"]);
	});
	it("badges all-pass green and partial gray without blocked items", async () => {
		const mix = (statuses: string[]): ChatEntry[] => {
			const report = { goal: "界面优化", criteria: statuses.map((status, index) => ({ criterion: `项${index + 1}`, status })) };
			return [{ kind: "user", text: "实现界面" }, { kind: "assistant", text: "已处理", thinking: "", tools: [check, { id: "report", name: "task_check", args: JSON.stringify(report), summary: "记录验收", status: "ok", output: { text: JSON.stringify(report), totalLines: 1 } }] }];
		};
		await act(async () => root.render(<DeliverySummary entries={mix(["verified", "verified"])} />));
		expect(container.querySelector(".owl-delivery-outcome")?.textContent).toBe("全部通过");
		expect(container.querySelector(".owl-delivery-outcome")?.getAttribute("data-tone")).toBe("verified");
		await act(async () => root.render(<DeliverySummary entries={mix(["verified", "pending"])} />));
		expect(container.querySelector(".owl-delivery-outcome")?.textContent).toBe("1/2 已通过");
		expect(container.querySelector(".owl-delivery-outcome")?.getAttribute("data-tone")).toBe("partial");
	});
	it("offers a copy button carrying the linked execution output", async () => {
		await act(async () => root.render(<DeliverySummary entries={entries(true)} />));
		const copy = container.querySelector<HTMLButtonElement>(".owl-delivery-evidence-actions button");
		expect(copy?.getAttribute("aria-label")).toBe("复制执行结果");
		// MessageCopyButton 持有完整输出文本；不触发剪贴板，仅确认按钮落在证据区。
		expect(copy?.textContent).toContain("复制");
		expect(container.querySelector(".owl-delivery-evidence-actions")).not.toBeNull();
	});
});
