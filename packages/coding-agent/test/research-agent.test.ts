import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/index.ts";
import {
	createResearchExtension,
	createResearchPublishTool,
	getResearchMode,
	normalizeResearchMode,
	normalizeResearchResult,
	RESEARCH_MODE_ENTRY,
	RESEARCH_PUBLISH_TOOL,
	researchResultSchema,
	updateResearchMode,
} from "../src/core/research/agent.ts";
import type { ResearchResultDetails, ResearchResultInput } from "../src/core/research/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, getToolResult, type Harness } from "./suite/harness.ts";

const sample: ResearchResultInput = {
	mode: "crawl",
	status: "sample",
	title: "产品目录样本",
	summary: "读取了一页产品资料，价格尚未核实。",
	columns: [
		{ key: "name", label: "名称" },
		{ key: "price", label: "价格" },
	],
	rows: [{ name: "示例产品", price: null }],
	sources: [{ id: "page1", title: "产品页", url: "https://example.test/products/1", note: "原文：示例产品。" }],
	findings: [
		{ kind: "fact", text: "页面显示产品名称", sourceIds: ["page1"] },
		{ kind: "unverified", text: "未读取到价格", sourceIds: [] },
	],
};

describe("research conversation and result contract", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("requires explicit scope and rejects malformed modes instead of changing ordinary chat", () => {
		const ordinary = SessionManager.inMemory();
		expect(getResearchMode(ordinary)).toBeUndefined();
		expect(() => createResearchExtension(ordinary)).toThrow("普通会话");
		expect(() => updateResearchMode(ordinary, "auto")).toThrow("不是研究会话");
		for (const value of [null, undefined, {}, "unknown", "web-js"]) {
			expect(() => normalizeResearchMode(value)).toThrow("研究方向");
		}
		expect(normalizeResearchMode("auto")).toBe("auto");
	});

	it("preserves the latest selected direction through JSONL reopen and rewind", () => {
		const dir = mkdtempSync(join(tmpdir(), "owl-research-record-"));
		tempDirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		const initial = manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
		manager.appendMessage({ role: "user", content: "采集这个目录", timestamp: Date.now() });
		expect(updateResearchMode(manager, "crawl")).toBe("crawl");
		const count = manager.getEntries().length;
		updateResearchMode(manager, "crawl");
		expect(manager.getEntries()).toHaveLength(count);
		manager.branch(initial);
		expect(getResearchMode(manager)).toBe("crawl");
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing persisted session");
		expect(getResearchMode(SessionManager.open(file))).toBe("crawl");
	});

	it("does not add research tools or research instructions to ordinary Agent sessions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("普通回答")]);
		await harness.session.prompt("你好");
		expect(harness.session.getAllTools().some((tool) => tool.name === RESEARCH_PUBLISH_TOOL)).toBe(false);
		expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("Owl 研究助手");
	});

	it("uses the current direction every turn and stores an executed result in the real Agent transcript", async () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createResearchExtension(manager)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(RESEARCH_PUBLISH_TOOL, sample as unknown as JsonObject)], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("样本已整理，可以继续。"),
		]);
		await harness.session.prompt("先整理产品样本");
		const output = getToolResult(harness, RESEARCH_PUBLISH_TOOL);
		expect(output.isError).toBe(false);
		const details = output.details as unknown as ResearchResultDetails;
		expect(details.researchResult).toMatchObject(sample);
		expect(details.researchResult.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(Number.isFinite(Date.parse(details.researchResult.createdAt))).toBe(true);
		expect(manager.buildSessionProjection().entries.flatMap((entry) => entry.messages)).toContainEqual(output);
		expect(getCurrentSystemPrompt(harness.session.messages)).toContain("自动识别");
		updateResearchMode(manager, "web");
		harness.setResponses([fauxAssistantMessage("继续分析请求")]);
		await harness.session.prompt("看看参数从哪里来");
		expect(getCurrentSystemPrompt(harness.session.messages)).toContain("当前研究方向：Web / JS 分析");
		expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("当前研究方向：自动识别");
	});

	it("retains publish details when the transcript is saved and reopened", async () => {
		const dir = mkdtempSync(join(tmpdir(), "owl-research-output-"));
		tempDirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "crawl" });
		manager.appendMessage({ role: "user", content: "整理样本", timestamp: Date.now() });
		const tool = createResearchPublishTool();
		const output = await tool.execute("published", sample, undefined, undefined, {} as ExtensionToolContext);
		manager.appendMessage({
			role: "toolResult",
			toolName: tool.name,
			toolCallId: "published",
			content: output.content,
			details: output.details as JsonValue | undefined,
			isError: false,
			timestamp: Date.now(),
		});
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing session file");
		const reopened = SessionManager.open(file);
		const saved = reopened.buildSessionContext().messages.find((message) => message.role === "toolResult");
		expect(saved).toMatchObject({ details: output.details });
		expect(getResearchMode(reopened)).toBe("crawl");
	});

	it("validates table alignment, duplicate keys and scalar values without filling invented data", () => {
		expect(normalizeResearchResult(sample)).toEqual(sample);
		expect(() => normalizeResearchResult({ ...sample, rows: [{ name: "missing price" }] })).toThrow("完全对应");
		expect(() => normalizeResearchResult({ ...sample, rows: [{ name: "extra", price: 1, unknown: 2 }] })).toThrow(
			"完全对应",
		);
		expect(() => normalizeResearchResult({ ...sample, columns: [sample.columns[0], sample.columns[0]] })).toThrow(
			"唯一",
		);
		expect(() => normalizeResearchResult({ ...sample, rows: [{ name: "nested", price: {} }] })).toThrow("格式无效");
		expect(() => normalizeResearchResult({ ...sample, rows: [{ name: "invalid", price: Number.NaN }] })).toThrow();
		expect(Value.Check(researchResultSchema, { ...sample, id: "model supplied" })).toBe(false);
		expect(() => normalizeResearchResult({ ...sample, title: " " })).toThrow("不能为空");
	});

	it("keeps facts, inference and unresolved findings distinct and requires valid source references", () => {
		expect(() => normalizeResearchResult({ ...sample, sources: [...sample.sources, sample.sources[0]] })).toThrow(
			"不能重复",
		);
		expect(() =>
			normalizeResearchResult({ ...sample, findings: [{ kind: "fact", text: "claim", sourceIds: [] }] }),
		).toThrow("至少引用");
		expect(() =>
			normalizeResearchResult({
				...sample,
				findings: [{ kind: "inference", text: "guess", sourceIds: ["missing"] }],
			}),
		).toThrow("不存在");
		expect(
			normalizeResearchResult({
				...sample,
				findings: [{ kind: "inference", text: "归属可能相关", sourceIds: ["page1"] }],
			}).findings[0].kind,
		).toBe("inference");
		expect(
			normalizeResearchResult({
				...sample,
				sources: [{ id: "local", title: "用户提供的资料", note: "原文摘录" }],
				findings: [],
			}).sources[0].url,
		).toBeUndefined();
	});

	it("rejects executable, malformed and credential-bearing source links", () => {
		for (const url of ["javascript:alert(1)", "file:///private", "https://secret:token@example.test", "not-a-url"]) {
			expect(() => normalizeResearchResult({ ...sample, sources: [{ ...sample.sources[0], url }] })).toThrow();
		}
	});

	it("caps result size and never publishes a cancelled result", async () => {
		expect(() =>
			normalizeResearchResult({ ...sample, rows: Array.from({ length: 201 }, () => sample.rows[0]) }),
		).toThrow();
		const large = {
			...sample,
			columns: [{ key: "text", label: "正文" }],
			rows: Array.from({ length: 200 }, () => ({ text: "中".repeat(2000) })),
		};
		expect(() => normalizeResearchResult(large)).toThrow("过大");
		const controller = new AbortController();
		controller.abort();
		await expect(
			createResearchPublishTool().execute(
				"cancelled",
				sample,
				controller.signal,
				undefined,
				{} as ExtensionToolContext,
			),
		).rejects.toThrow("已取消");
	});
});
