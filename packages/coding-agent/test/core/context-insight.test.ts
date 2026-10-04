import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type ContextRequestRow,
	classifyRequestMessages,
	dropContextInsight,
	estimateToolDeclarations,
	findContextInsightByCwd,
	getContextInsight,
	measuredContextTokens,
	reconstructContextInsight,
	recordContextEvent,
	recordContextRequest,
	recordContextTools,
	recordContextUsage,
} from "../../src/core/context-insight.ts";
import type { ProjectedSessionEntry } from "../../src/core/session-manager.ts";

const cwd0 = "D:\\tmp\\caps";
const emptyComposition = () => ({
	system: 1,
	inject: 0,
	user: 0,
	assistant: 0,
	toolResult: 0,
	toolSchemas: 0,
	other: 0,
});

describe("classifyRequestMessages", () => {
	it("leading system 拆 system/inject：基础 sections 归 system，扩展注入归 inject", () => {
		const composition = classifyRequestMessages([
			{
				role: "system",
				content: "base prompt", // 11 chars → 3
				sections: {
					preamble: "12345678", // 基础 section：8 chars → 2
					owl_memory: "memory section", // 扩展注入：14 chars → 4
					gone: null,
				},
			},
			{ role: "system", content: "additional instructions" }, // 23 chars → 6
		] as any);
		expect(composition.system).toBe(3 + 2);
		expect(composition.inject).toBe(4 + 6);
		expect(composition.user).toBe(0);
	});

	it("user/assistant/toolResult 各归各类；图片按 4800 字符折算", () => {
		const composition = classifyRequestMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", data: "x", mimeType: "image/png" },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "abcd" },
					{ type: "text", text: "hi" },
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "a" } },
				],
			},
			{ role: "toolResult", toolCallId: "1", toolName: "read", content: "file contents" },
		] as any);
		// user: 5 + 4800 = 4805 → 1202
		expect(composition.user).toBe(1202);
		// assistant: 4 + 2 + 4 + JSON({"path":"a"}).length=12 → 22 → 6
		expect(composition.assistant).toBe(6);
		// toolResult: 13 → 4
		expect(composition.toolResult).toBe(4);
	});

	it("自定义角色落 other；空 transcript 全零", () => {
		expect(classifyRequestMessages([])).toEqual({
			system: 0,
			inject: 0,
			user: 0,
			assistant: 0,
			toolResult: 0,
			toolSchemas: 0,
			other: 0,
		});
		// bashExecution: "ls"(2) + "a\nb"(3) → 5 chars → 2
		const composition = classifyRequestMessages([{ role: "bashExecution", command: "ls", output: "a\nb" }] as any);
		expect(composition.other).toBe(2);
	});
});

describe("estimateToolDeclarations", () => {
	it("uses transcript declarations including model-only tools and augmented descriptions", () => {
		const registry = [
			{ name: "read", description: "short", parameters: {}, sourceInfo: { source: "builtin" } },
			{ name: "subagent", description: "base", parameters: {}, sourceInfo: { source: "subagents" } },
			{ name: "hidden", description: "not sent", parameters: {} },
		];
		const declared = [
			{
				name: "read",
				description: "actual description with appended execution guidance",
				parameters: { type: "object" },
			},
			{ name: "subagent", description: "actual model-only subagent declaration", parameters: { type: "object" } },
			{ name: "codemode", description: "all discovered tools are callable here", parameters: {} },
		];
		const transcript = [{ role: "system", toolsAdded: declared }];
		const estimate = estimateToolDeclarations(registry, transcript);
		expect(estimate.total).toBe(estimateToolDeclarations(declared).total);
		expect(estimate.refs).toEqual([
			{ name: "read", source: "builtin" },
			{ name: "subagent", source: "subagents" },
			{ name: "codemode", source: "transcript" },
		]);
	});

	it("applies tool removals and redefinitions without counting stale schemas", () => {
		const transcript = [
			{
				role: "system",
				toolsAdded: [
					{ name: "read", description: "stale", parameters: {} },
					{ name: "removed", description: "old", parameters: {} },
				],
			},
			{
				role: "system",
				toolsRemoved: [{ name: "removed" }],
				toolsAdded: [{ name: "read", description: "current", parameters: {} }],
			},
		];
		expect(estimateToolDeclarations([], transcript)).toEqual({
			total: Math.ceil((4 + 7 + 2) / 4),
			refs: [{ name: "read", source: "transcript" }],
		});
	});

	it("按 name+description+schema 估算并记录来源", () => {
		const estimate = estimateToolDeclarations([
			{
				name: "read",
				description: "read a file",
				parameters: { type: "object" },
				sourceInfo: { source: "builtin" },
			},
			{
				name: "mcp_playwright_navigate",
				description: "navigate",
				parameters: {},
				namespace: { name: "mcp_playwright" },
			},
		]);
		expect(estimate.refs).toEqual([
			{ name: "read", source: "builtin" },
			{ name: "mcp_playwright_navigate", source: "mcp_playwright" },
		]);
		const chars = 4 + 11 + JSON.stringify({ type: "object" }).length + 23 + 8 + 2;
		expect(estimate.total).toBe(Math.ceil(chars / 4));
	});
});

describe("context-insight 注册表", () => {
	it("记录请求、usage 补填到上一行、事件与工具来源", () => {
		const sessionId = "test-session-insight";
		const cwd = "D:\\tmp\\project";
		dropContextInsight(sessionId);

		recordContextRequest(sessionId, cwd, {
			ts: 100,
			composition: { system: 10, inject: 0, user: 5, assistant: 0, toolResult: 0, toolSchemas: 3, other: 2 },
		});
		// 第一行无上一行可补填，total = 10+5+3+2 = 20
		let state = getContextInsight(sessionId)!;
		expect(state.requests).toHaveLength(1);
		expect(state.requests[0].seq).toBe(1);
		expect(state.requests[0].totalTokens).toBe(20);
		expect(state.requests[0].usage).toBeUndefined();

		recordContextRequest(
			sessionId,
			cwd,
			{
				ts: 200,
				composition: { system: 10, inject: 4, user: 5, assistant: 6, toolResult: 7, toolSchemas: 3, other: 0 },
			},
			{ input: 100, output: 9, cacheRead: 80, cacheWrite: 11 },
		);
		state = getContextInsight(sessionId)!;
		expect(state.requests[1].seq).toBe(2);
		expect(state.requests[1].usage).toBeUndefined();
		// 本轮携带的 usage 属于上一轮的响应
		expect(state.requests[0].usage).toEqual({ input: 100, output: 9, cacheRead: 80, cacheWrite: 11 });

		recordContextEvent(sessionId, cwd, { kind: "compact", label: "上下文压缩（手动）", reason: "manual" });
		recordContextTools(sessionId, cwd, [{ name: "read", source: "builtin" }]);
		state = getContextInsight(sessionId)!;
		expect(state.events).toHaveLength(1);
		expect(state.tools).toEqual([{ name: "read", source: "builtin" }]);

		// 按 cwd 命中最近活跃会话（容忍尾斜杠与大小写）
		const found = findContextInsightByCwd("d:/tmp/project/");
		expect(found?.sessionId).toBe(sessionId);
		expect(found?.state.requests).toHaveLength(2);

		// 类型完整性：ContextRequestRow 形状不被误改
		const row: ContextRequestRow = state.requests[1];
		expect(row.composition.system).toBe(10);
	});

	it("请求/事件封顶不发散", () => {
		const sessionId = "test-session-caps";
		dropContextInsight(sessionId);
		for (let index = 0; index < 450; index += 1) {
			recordContextRequest(sessionId, cwd0, { ts: index, composition: emptyComposition() });
		}
		for (let index = 0; index < 120; index += 1) {
			recordContextEvent(sessionId, cwd0, { kind: "tools", label: `t${index}` });
		}
		const state = getContextInsight(sessionId)!;
		expect(state.requests).toHaveLength(400);
		expect(state.requests[0].seq).toBe(51);
		expect(state.requests[399].seq).toBe(450);
		expect(state.events).toHaveLength(100);
		dropContextInsight(sessionId);
	});

	it("message_end 即时回填：填最近一行的空 usage，不覆盖已有值，未知会话静默", () => {
		const sessionId = "test-session-usage";
		const cwd = "D:\\tmp\\usage";
		dropContextInsight(sessionId);
		// 未知会话：静默无操作
		recordContextUsage(sessionId, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });

		recordContextRequest(sessionId, cwd, { ts: 100, composition: emptyComposition() });
		recordContextUsage(sessionId, { input: 42, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 49 });
		const state = getContextInsight(sessionId)!;
		expect(state.requests[0].usage).toEqual({ input: 42, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 49 });

		// 已有 usage 不覆盖（陈旧响应不会污染新行）
		recordContextUsage(sessionId, { input: 999, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(state.requests[0].usage?.input).toBe(42);

		// 实测口径：totalTokens 优先，否则四项之和
		expect(measuredContextTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10);
		expect(measuredContextTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 50 })).toBe(50);
		dropContextInsight(sessionId);
	});
});

describe("reconstructContextInsight（历史会话回放）", () => {
	const entry = (type: string, id: string, messages: unknown[] = []) => ({
		sourceEntry: { type, id, timestamp: "2026-10-04T08:00:00.000Z" },
		messages,
	});

	it("reconstructs model-only tools from persisted transcript and respects later removals", () => {
		const tools = [{ name: "codemode", description: "execution instructions", parameters: Type.Object({}) }];
		const response: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: "openai-completions",
			provider: "stub",
			model: "stub",
			timestamp: 0,
			stopReason: "stop",
			usage: {
				input: 10,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const messages: AgentMessage[] = [
			{ role: "system", content: "", toolsAdded: tools, timestamp: 0 },
			response,
			{ role: "system", content: "", toolsRemoved: [{ name: "codemode" }], timestamp: 1 },
			{ ...response, timestamp: 1 },
		];
		const projected: ProjectedSessionEntry[] = messages.map((message, index) => ({
			sourceEntry: {
				type: "message",
				id: String(index),
				parentId: index > 0 ? String(index - 1) : null,
				timestamp: "2026-10-04T08:00:00.000Z",
				message,
			},
			messages: [message],
		}));
		const rows = reconstructContextInsight(projected);
		expect(rows.requests[0].composition.toolSchemas).toBe(estimateToolDeclarations(tools).total);
		expect(rows.requests[1].composition.toolSchemas).toBe(0);
		expect(rows.tools).toEqual([]);
	});

	it("按 assistant 分界切请求：请求构成不含本条 assistant，usage 归属产生它的那一行", () => {
		const rows = reconstructContextInsight([
			entry("message", "e1", [
				// leading system：content 4 chars + 基础 section 8 chars → system 3
				{ role: "system", content: "base", sections: { preamble: "12345678" } },
				{ role: "user", content: "hello" }, // 5 chars → 2
			]),
			entry("message", "e2", [
				// 第 1 次请求的响应：row1 = system 3 + user 2，实测 usage 归 row1
				{
					role: "assistant",
					content: "hi there!",
					usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
				},
			]),
			entry("message", "e3", [
				{ role: "toolResult", content: [{ type: "text", text: "12345678" }] }, // 8 chars → 2
			]),
			entry("message", "e4", [
				{ role: "system", content: "extra" }, // 后置系统消息 → inject 2
				{ role: "assistant", content: "done" }, // 无 usage（中止）：row2 不带实测
			]),
		] as any);

		expect(rows.requests).toHaveLength(2);
		expect(rows.requests[0].seq).toBe(1);
		expect(rows.requests[0].composition).toEqual({
			system: 3,
			inject: 0,
			user: 2,
			assistant: 0,
			toolResult: 0,
			toolSchemas: 0,
			other: 0,
		});
		expect(rows.requests[0].totalTokens).toBe(5);
		expect(rows.requests[0].usage).toEqual({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 });

		// row2 = 此前累计（system 3 + user 2 + assistant 3 + toolResult 2 + inject 2）
		expect(rows.requests[1].seq).toBe(2);
		expect(rows.requests[1].composition).toEqual({
			system: 3,
			inject: 2,
			user: 2,
			assistant: 3,
			toolResult: 2,
			toolSchemas: 0,
			other: 0,
		});
		expect(rows.requests[1].totalTokens).toBe(12);
		expect(rows.requests[1].usage).toBeUndefined();
		expect(rows.events).toHaveLength(0);
	});

	it("compaction 条目记一条 compact 事件，全零 usage 不回填", () => {
		const rows = reconstructContextInsight([
			entry("compaction", "c1", [{ role: "user", content: "summarized" }]),
			entry("message", "m1", [
				{ role: "assistant", content: "ok", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			]),
		] as any);

		expect(rows.events).toHaveLength(1);
		expect(rows.events[0].kind).toBe("compact");
		expect(rows.requests[0].usage).toBeUndefined();
	});

	it("空投影回空数据，不抛错", () => {
		const rows = reconstructContextInsight([] as any);
		expect(rows.requests).toHaveLength(0);
		expect(rows.events).toHaveLength(0);
		expect(rows.tools).toHaveLength(0);
	});
});
