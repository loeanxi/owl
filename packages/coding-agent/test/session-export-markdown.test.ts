import type { AssistantMessage, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildSessionExportFilename,
	formatSessionMarkdown,
	resolveCurrentBranch,
	sanitizeExportFilename,
} from "../src/core/session-export.ts";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";

const HEADER = {
	type: "session" as const,
	version: 3,
	id: "01a105d1-5285-7cc7-a1a2-c5f3a9b0e111",
	timestamp: "2026-10-04T07:29:26.661Z",
	cwd: "D:\\owl",
};

function messageEntry(id: string, parentId: string | null, message: unknown): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-04T07:30:00.000Z",
		message,
	} as SessionMessageEntry;
}

const userText = (text: string): UserMessage => ({
	role: "user",
	content: text,
	timestamp: Date.parse("2026-10-04T07:30:00.000Z"),
});

const assistant = (content: AssistantMessage["content"], usage: AssistantMessage["usage"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-completions",
	provider: "zai-coding-cn",
	model: "glm-5.3-flash",
	usage,
	stopReason: "toolUse",
	timestamp: Date.parse("2026-10-04T07:30:05.000Z"),
});

const toolResult = (toolCallId: string, text: string, isError = false): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "bash",
	content: [{ type: "text", text } as TextContent],
	isError,
	timestamp: Date.parse("2026-10-04T07:30:06.000Z"),
});

const usage = {
	input: 18709,
	output: 175,
	cacheRead: 12000,
	cacheWrite: 0,
	totalTokens: 30884,
	cost: { input: 0.01, output: 0.002, cacheRead: 0.001, cacheWrite: 0, total: 0.013 },
};

describe("sanitizeExportFilename", () => {
	it("replaces illegal characters and trims to 80 chars", () => {
		expect(sanitizeExportFilename('a<b>c:"d/e\\f|g?h*i')).toBe("a_b_c__d_e_f_g_h_i");
		expect(sanitizeExportFilename(`bad\x00\x1fname`)).toBe("bad__name");
		expect(sanitizeExportFilename("x".repeat(100)).length).toBe(80);
		expect(sanitizeExportFilename("  问候 与 协助  ")).toBe("问候 与 协助");
	});
});

describe("buildSessionExportFilename", () => {
	it("prefers display name, falls back to id prefix, appends local timestamp", () => {
		const name = buildSessionExportFilename({
			sessionId: "01a105d1-5285-7cc7",
			displayName: "问候与协助",
			startedAt: "2026-10-04T07:29:26.661Z",
			ext: "jsonl",
		});
		expect(name.startsWith("问候与协助-")).toBe(true);
		expect(name.endsWith(".jsonl")).toBe(true);
		expect(name).not.toMatch(/[<>:"/\\|?*]/);

		const fallback = buildSessionExportFilename({
			sessionId: "01a105d1-5285-7cc7",
			startedAt: "2026-10-04T07:29:26.661Z",
			ext: "markdown",
		});
		expect(fallback.startsWith("01a105d1-")).toBe(true);
		expect(fallback.endsWith(".md")).toBe(true);
	});
});

describe("resolveCurrentBranch", () => {
	it("walks parentIds back from the last entry", () => {
		const a = messageEntry("a", null, userText("一"));
		const b = messageEntry("b", "a", { role: "assistant", content: [], usage, stopReason: "stop" });
		const fork = messageEntry("c", "a", userText("分支"));
		const { header, branch } = resolveCurrentBranch([HEADER, a, b, fork]);
		expect(header.id).toBe(HEADER.id);
		expect(branch.map((entry) => entry.id)).toEqual(["a", "c"]);
	});
});

describe("formatSessionMarkdown", () => {
	it("renders user/assistant/toolResult with usage, thinking in details, and a summary", () => {
		const entries: SessionEntry[] = [
			messageEntry("a", null, userText("列出目录")),
			messageEntry(
				"b",
				"a",
				assistant(
					[
						{ type: "thinking", thinking: "先看看有什么文件" },
						{ type: "text", text: "好的，我来列目录。" },
						{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
					],
					usage,
				),
			),
			messageEntry("c", "b", toolResult("call_1", "total 20")),
		];
		const md = formatSessionMarkdown(HEADER, entries);
		expect(md).toContain("# Owl 会话：01a105d1");
		expect(md).toContain("`D:\\owl`");
		expect(md).toContain("## 👤 用户 ·");
		expect(md).toContain("列出目录");
		expect(md).toContain("## 🤖 助手 · glm-5.3-flash ·");
		expect(md).toContain("<details><summary>思考过程</summary>");
		expect(md).toContain("**🔧 工具调用 `bash`**");
		expect(md).toContain("```json");
		expect(md).toContain('"command": "ls"');
		expect(md).toContain("**🔧 工具结果 · `bash`**");
		expect(md).toContain("输入 18,709");
		expect(md).toContain("成本 $0.0130");
		expect(md).toContain("## 汇总");
		expect(md).toContain("用户消息 1 条 · 助手回复 1 条 · 工具调用 1 次");
		expect(md).toContain("合计 30,884");
		expect(md).toContain("成本合计：$0.0130");
	});

	it("marks error tool results and error stop reasons", () => {
		const entries: SessionEntry[] = [
			messageEntry("a", null, userText("hi")),
			messageEntry(
				"b",
				"a",
				assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }], {
					...usage,
					cost: { ...usage.cost, total: 0 },
				}),
			),
			messageEntry("c", "b", toolResult("call_1", "boom", true)),
		];
		const md = formatSessionMarkdown(HEADER, entries);
		expect(md).toContain("工具结果 · `bash` ❌");
		expect(md).not.toContain("成本合计");
	});

	it("keeps code fences balanced when tool output contains backticks", () => {
		const entries: SessionEntry[] = [
			messageEntry("a", null, userText("hi")),
			messageEntry("b", "a", assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }], usage)),
			messageEntry("c", "b", toolResult("call_1", "````\ncode\n````")),
		];
		const md = formatSessionMarkdown(HEADER, entries);
		expect(md).toContain("`````\n````");
	});

	it("uses the latest session_info entry as the title", () => {
		const info = (id: string, parentId: string | null, name: string): SessionEntry => ({
			type: "session_info",
			id,
			parentId,
			timestamp: "2026-10-04T07:30:00.000Z",
			name,
		});
		const md = formatSessionMarkdown(HEADER, [
			info("i0", null, "旧名"),
			messageEntry("a", "i0", userText("一")),
			info("i1", "a", "问候与协助"),
		]);
		expect(md.startsWith("# Owl 会话：问候与协助\n")).toBe(true);
	});
});
