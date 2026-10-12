import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDiagnosis } from "../../bridge/protocol.ts";
import { setUiLanguage } from "../../i18n/index.ts";
import { ResearchDiagnosisNotice } from "./ResearchDiagnosisNotice.tsx";

// The desktop language store is client-only; supply its snapshot for this isolated static render.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return { ...actual, useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T => actual.useSyncExternalStore(subscribe, getSnapshot, getSnapshot) };
});

const diagnosis: ResearchDiagnosis = { id: "11111111-1111-4111-8111-111111111111", version: 1, createdAt: "2026-10-12T00:00:00.000Z", ownerSessionId: "research-1", status: "textual_refusal_candidate", summary: "上游没有明确拒绝标记，需要核对文本。", evidence: [{ source: "agent", text: "我无法协助提供分析。" }] };
afterEach(() => { setUiLanguage("zh"); });

describe("research diagnosis notice", () => {
	it("does not warn on absent, ordinary unverified or still-running responses", () => {
		for (const props of [{ diagnosis: undefined, running: false }, { diagnosis: { ...diagnosis, status: "unverified" as const }, running: false }, { diagnosis, running: true }]) {
			expect(renderToStaticMarkup(React.createElement(ResearchDiagnosisNotice, props))).toBe("");
		}
	});
	it("labels refusal language as a candidate and keeps its evidence collapsed", () => {
		setUiLanguage("zh");
		const html = renderToStaticMarkup(React.createElement(ResearchDiagnosisNotice, { diagnosis, running: false }));
		expect(html).toContain("可能未接受任务，需要核对");
		expect(html).not.toContain("上游响应出现明确拒绝标记");
		expect(html).toContain("<details>");
		expect(html).not.toContain(" open=");
		expect(html).toContain('role="status"');
	});
	it("shows an explicit provider refusal with the actual provider evidence", () => {
		setUiLanguage("zh");
		const html = renderToStaticMarkup(React.createElement(ResearchDiagnosisNotice, { diagnosis: { ...diagnosis, status: "upstream_refusal", evidence: [{ source: "provider", text: "Provider refusal" }] }, running: false }));
		expect(html).toContain("上游响应出现明确拒绝标记");
		expect(html).toContain("模型响应");
		expect(html).toContain("Provider refusal");
	});
	it("keeps missing dependencies separate from approvals and escapes tool excerpts", () => {
		setUiLanguage("zh");
		const html = renderToStaticMarkup(React.createElement(ResearchDiagnosisNotice, { diagnosis: { ...diagnosis, status: "missing_dependency", evidence: [{ source: "tool", text: "<script>fake()</script>", toolName: "research_rea" }] }, running: false }));
		expect(html).toContain("缺少运行分析所需的依赖");
		expect(html).toContain("research_rea");
		expect(html).not.toContain("本地操作未获批准");
		expect(html).toContain("&lt;script&gt;");
	});
	it("translates status and evidence labels to English", () => {
		setUiLanguage("en");
		const html = renderToStaticMarkup(React.createElement(ResearchDiagnosisNotice, { diagnosis, running: false }));
		expect(html).toContain("The task may not have been accepted; review is needed");
		expect(html).toContain("View evidence");
		expect(html).toContain("Execution record");
	});
	it("shows an unknown tool failure without calling it provider review", () => {
		setUiLanguage("zh");
		const html = renderToStaticMarkup(React.createElement(ResearchDiagnosisNotice, { diagnosis: { ...diagnosis, status: "tool_error", evidence: [{ source: "tool", text: "Unexpected parser error", toolName: "research_rea" }] }, running: false }));
		expect(html).toContain("工具执行出现错误");
		expect(html).not.toContain("上游响应出现明确拒绝标记");
	});
});
