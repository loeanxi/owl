import { createHash } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isResearchTaskRecord, type ResearchTaskRecord } from "../../../../../packages/coding-agent/src/core/research/task-state.ts";
import { setUiLanguage } from "../../i18n/index.ts";
import { ResearchTaskNotice } from "./ResearchTaskNotice.tsx";

vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return { ...actual, useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T => actual.useSyncExternalStore(subscribe, getSnapshot, getSnapshot) };
});

function fixture(): ResearchTaskRecord {
	const originalRequest = "编写 Lua 5.1 解密器。";
	const inputHash = createHash("sha256").update(originalRequest).digest("hex");
	return {
		id: "33333333-3333-4333-8333-333333333333", version: 1, taskId: "44444444-4444-4444-8444-444444444444", revision: 1, ownerSessionId: "research-1", updatedAt: "2026-10-13T00:00:00.000Z", originalRequest, inputHash,
		inputs: [{ id: "input-1", text: originalRequest, sha256: inputHash, truncated: false }],
		facts: { target: { state: "unreviewed", value: null, evidence: [] }, function: { state: "unreviewed", value: null, evidence: [] }, environment: { state: "unreviewed", value: null, evidence: [] }, dataSource: { state: "unknown", value: null, evidence: [] }, authorization: { state: "unreviewed", value: null, evidence: [] }, deliverable: { state: "user_stated", value: "Lua 5.1 解密器", evidence: [{ inputId: "input-1", quote: originalRequest }] }, acceptance: { state: "unreviewed", value: null, evidence: [] } },
		missingMaterials: ["原始加密脚本", "输入样本"], toolMatches: [],
		modelFit: { selected: { provider: "fixture", id: "model", inputTypes: ["text"], inputCompatible: true }, candidates: [{ provider: "other", id: "candidate", inputCompatible: true }], basis: "只按输入类型匹配，未评估生成正确性。" },
		response: { state: "not_started", summary: "尚未收到响应" }, acceptance: { state: "not_run", goalVerified: false, checks: [] }, status: "needs_input",
	};
}

function render(task: ResearchTaskRecord, running = false): string {
	expect(isResearchTaskRecord(task, "research-1")).toBe(true);
	return renderToStaticMarkup(React.createElement(ResearchTaskNotice, { task, sessionId: "research-1", running }));
}

afterEach(() => { setUiLanguage("zh"); });

describe("research task facts and measured checks", () => {
	it("shows attachment-only input without inventing a textual goal, and lists exact file paths and image counts", () => {
		const task = fixture();
		task.originalRequest = "";
		task.inputs[0] = { id: "input-1", text: "", sha256: createHash("sha256").update("").digest("hex"), truncated: false, attachedPaths: ["D:/owl/selected.lua"], imageCount: 2 };
		task.facts.deliverable = { state: "unreviewed", value: null, evidence: [] };
		const html = render(task);
		expect(html).toContain("只提供了附件，尚未说明目标");
		expect(html).toContain("已提供的文件路径");
		expect(html).toContain("D:/owl/selected.lua");
		expect(html).toContain("图片附件记录：2 张");
		expect(html).not.toContain("Lua 5.1 解密器");
	});

	it("translates an image-only task and keeps the existing text request display unchanged", () => {
		const textTask = fixture();
		const ordinaryHtml = render(textTask);
		expect(ordinaryHtml).toContain(`<p>${textTask.originalRequest}</p>`);
		expect(ordinaryHtml).not.toContain("只提供了附件");
		const task = fixture();
		task.originalRequest = "";
		task.inputs[0] = { id: "input-1", text: "", sha256: createHash("sha256").update("").digest("hex"), truncated: false, imageCount: 3 };
		task.facts.deliverable = { state: "unreviewed", value: null, evidence: [] };
		setUiLanguage("en");
		const html = render(task);
		expect(html).toContain("Only attachments were provided; no task goal was stated.");
		expect(html).toContain("Recorded image attachments: 3");
		expect(html).not.toContain("Provided file paths");
	});

	it("does not say the goal is unstated after an attachment-only request receives later text", () => {
		const task = fixture();
		task.originalRequest = "";
		task.inputs.unshift({ id: "attachment-input", text: "", sha256: createHash("sha256").update("").digest("hex"), truncated: false, imageCount: 1 });
		const html = render(task);
		expect(html).toContain("最初只提供了附件，后续文字说明已记录");
		expect(html).not.toContain("尚未说明目标");
	});

	it("shows missing material as neutral task information even while research is running", () => {
		const html = render(fixture(), true);
		expect(html).toContain("需要补充研究材料");
		expect(html).toContain("原始加密脚本");
		expect(html).toContain("正在处理");
		expect(html).toContain('role="status"');
		expect(html).toContain("<details>");
		expect(html).not.toContain(" open=");
		expect(html).not.toContain("上游响应出现明确拒绝标记");
		expect(html).not.toContain("研究方向");
	});

	it("distinguishes unreviewed facts from unknown facts without claiming the user omitted them", () => {
		const html = render(fixture());
		expect(html).toContain("尚未整理这项信息");
		expect(html).toContain("当前记录尚未明确识别这项信息");
		expect(html).toContain("来自用户描述，尚未独立核实");
		expect(html).not.toContain("用户未提供");
	});

	it("shows recorded responses and input compatibility without promoting them to task success", () => {
		const task = fixture();
		task.status = "unverified";
		task.response = { state: "received", provider: "fixture", model: "model", summary: "已收到实际模型回答" };
		task.toolMatches = [{ operation: "静态分析", requestedTools: ["research_rea"], registeredTools: ["research_rea"], unavailableTools: [] }];
		const html = render(task);
		expect(html).toContain("已收到模型响应");
		expect(html).toContain("尚未执行独立检查");
		expect(html).toContain("fixture/model");
		expect(html).toContain("other/candidate");
		expect(html).toContain("当前模型不会自动更换");
		expect(html).toContain("工具已注册不代表对应操作已执行");
		expect(html).not.toContain("任务已完成");
	});

	it("a passed artifact check remains partial and explicitly does not verify the whole goal", () => {
		const task = fixture();
		task.status = "partial";
		task.acceptance = { state: "partial", goalVerified: false, checks: [{ id: "check-1", taskId: task.taskId, inputHash: task.inputHash, criterion: "输出文件存在", kind: "file_exists", status: "passed", artifactPath: "D:/owl/output.json", artifactSha256: "b".repeat(64), verifier: "filesystem", summary: "仅核对文件存在" }] };
		const html = render(task);
		expect(html).toContain("1 / 1 项检查通过");
		expect(html).toContain("整体目标仍待核验");
		expect(html).toContain("不能据此确认整个研究目标已完成");
		expect(html).not.toContain("任务已完成");
	});

	it("rejects records for other sessions and fabricated verified-goal state", () => {
		const task = fixture();
		expect(renderToStaticMarkup(React.createElement(ResearchTaskNotice, { task, sessionId: "ordinary-chat", running: false }))).toBe("");
		expect(renderToStaticMarkup(React.createElement(ResearchTaskNotice, { task: { ...task, acceptance: { ...task.acceptance, goalVerified: true } } as unknown as ResearchTaskRecord, sessionId: "research-1", running: false }))).toBe("");
	});

	it("escapes source instructions, artifact paths and quotations without executing them", () => {
		const task = fixture();
		task.originalRequest = "<script>evil()</script>";
		task.inputHash = createHash("sha256").update(task.originalRequest).digest("hex");
		task.inputs[0].text = task.originalRequest;
		task.inputs[0].sha256 = task.inputHash;
		task.missingMaterials = ["D:/owl/<img src=x onerror=evil()>.json"];
		task.facts.deliverable = { state: "user_stated", value: task.originalRequest, evidence: [{ inputId: "input-1", quote: task.originalRequest }] };
		const html = render(task);
		expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
		expect(html).toContain("&lt;img src=x onerror=evil()&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
	});

	it("translates task and component-verification states to English", () => {
		setUiLanguage("en");
		const html = render(fixture());
		expect(html).toContain("Task facts and verification progress");
		expect(html).toContain("Independent checks have not run");
		expect(html).toContain("This information has not been extracted yet");
		expect(html).toContain("The current model is not switched automatically");
	});
});
