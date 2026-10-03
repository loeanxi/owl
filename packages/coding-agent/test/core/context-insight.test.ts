import { describe, expect, it } from "vitest";
import {
	classifyRequestMessages,
	estimateToolDeclarations,
	type ContextRequestRow,
	dropContextInsight,
	findContextInsightByCwd,
	getContextInsight,
	recordContextEvent,
	recordContextRequest,
	recordContextTools,
} from "../../src/core/context-insight.ts";

const cwd0 = "D:\\tmp\\caps";
const emptyComposition = () => ({ system: 1, inject: 0, user: 0, assistant: 0, toolResult: 0, toolSchemas: 0, other: 0 });

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
			{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: "x", mimeType: "image/png" }] },
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
	it("按 name+description+schema 估算并记录来源", () => {
		const estimate = estimateToolDeclarations([
			{ name: "read", description: "read a file", parameters: { type: "object" }, sourceInfo: { source: "builtin" } },
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
			{ ts: 200, composition: { system: 10, inject: 4, user: 5, assistant: 6, toolResult: 7, toolSchemas: 3, other: 0 } },
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
});
