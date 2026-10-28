import { describe, expect, it } from "vitest";
import { deliveryChecklist } from "./delivery.ts";
import type { ChatEntry, ToolCard } from "./transcript.ts";

function card(id: string, name: string, args: unknown, text: string, status: ToolCard["status"] = "ok"): ToolCard {
	return { id, name, args: JSON.stringify(args), summary: name, status, output: { text, totalLines: 1 } };
}
function assistant(...tools: ToolCard[]): ChatEntry {
	return { kind: "assistant", text: "完成", thinking: "", tools };
}
const criterion = {
	criterion: "界面交互验收",
	status: "verified",
	evidence: "真实页面已检查，按钮响应符合预期",
	toolCallId: "check",
};
const report = { goal: "完成界面优化", criteria: [criterion] };
const registration = () => card("register", "task_check", report, JSON.stringify({ ...report, active: true }));
describe("delivery evidence provenance", () => {
	it("does not upgrade observed command results into acceptance claims", () => {
		const run = card("run", "bash", { command: "node verify.mjs" }, "passed");
		expect(deliveryChecklist([assistant(run)])).toBeUndefined();
	});
	it("links only a real successful execution preceding the task record in this user turn", () => {
		const check = card("check", "bash", { command: "node verify.mjs" }, "Verified 6 interactions");
		const result = deliveryChecklist([assistant(check, registration())]);
		expect(result?.goal).toBe(report.goal);
		expect(result?.criteria[0]?.tool).toBe(check);
	});
	it("does not manufacture checklists from a final answer, shell text or failed task_check", () => {
		expect(
			deliveryChecklist([{ kind: "assistant", text: "全部测试通过，已验收", thinking: "", tools: [] }]),
		).toBeUndefined();
		expect(deliveryChecklist([assistant(card("shell", "bash", {}, JSON.stringify(report)))])).toBeUndefined();
		expect(deliveryChecklist([assistant({ ...registration(), status: "error" })])).toBeUndefined();
	});
	it("does not attach a failed, missing or later tool call as successful evidence", () => {
		for (const check of [card("check", "bash", {}, "failed", "error"), card("other", "bash", {}, "success")])
			expect(deliveryChecklist([assistant(check, registration())])?.criteria[0].tool).toBeUndefined();
		expect(
			deliveryChecklist([assistant(registration(), card("check", "bash", {}, "later"))])?.criteria[0].tool,
		).toBeUndefined();
	});
	it("cannot inherit an old checklist or tool evidence after the next delivered user message", () => {
		const entries: ChatEntry[] = [
			assistant(card("check", "bash", {}, "done"), registration()),
			{ kind: "user", text: "下一项" },
			assistant(card("inspect", "task_check", {}, JSON.stringify(report))),
		];
		expect(deliveryChecklist(entries)).toBeUndefined();
		expect(deliveryChecklist([...entries, assistant(registration())])?.criteria[0].tool).toBeUndefined();
	});
	it("clears a previous checklist when a successful clear returns plain text", () => {
		expect(
			deliveryChecklist([
				assistant(
					registration(),
					card("clear", "task_check", { clear: true }, "No acceptance checklist is registered."),
				),
			]),
		).toBeUndefined();
	});
	it("keeps verified, pending and blocked items distinct and rejects malformed records", () => {
		const mixed = {
			...report,
			criteria: [
				criterion,
				{ criterion: "页面发布", status: "pending" },
				{ criterion: "真实设备验收", status: "blocked", evidence: "目标设备未连接，暂无法执行" },
			],
		};
		expect(
			deliveryChecklist([assistant(card("mixed", "task_check", mixed, JSON.stringify(mixed)))])?.criteria.map(
				(item) => item.status,
			),
		).toEqual(["verified", "pending", "blocked"]);
		expect(
			deliveryChecklist([
				assistant(
					card(
						"invalid",
						"task_check",
						report,
						JSON.stringify({ ...report, criteria: [{ criterion: "x", status: "done" }] }),
					),
				),
			]),
		).toBeUndefined();
	});
});
