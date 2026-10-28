import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolCard } from "../hooks/transcript.ts";
import { claudeConnectorBlocks, connectorServerOf, connectorTextOf, isConnectorTool } from "./claude-connector.ts";
import { trimClaudeLabel } from "./claude-label-trim.ts";
import { claudeSubagentGroupLabel, isSubagentTool, splitSubagentCards } from "./claude-subagent.ts";
import { CLAUDE_USER_BUBBLE } from "./claude-user-bubble.ts";

function card(partial: Partial<ToolCard> & { id: string }): ToolCard {
	return {
		name: "read",
		args: "{}",
		summary: "",
		detail: "",
		status: "ok",
		startedAt: 1,
		finishedAt: 2,
		...partial,
	};
}

describe("Claude 的标签尾部修剪（Qp）", () => {
	it("剪掉末尾的省略号", () => {
		expect(trimClaudeLabel("Searched code…")).toBe("Searched code");
		expect(trimClaudeLabel("Searched code…\u2026")).toBe("Searched code");
	});

	it("剪掉三个以上的句点串，一两个句点保留", () => {
		expect(trimClaudeLabel("Searched code...")).toBe("Searched code");
		expect(trimClaudeLabel("Searched code..")).toBe("Searched code..");
		expect(trimClaudeLabel("Searched code.")).toBe("Searched code.");
	});

	it("剪掉尾部空白与格式符", () => {
		expect(trimClaudeLabel("Searched code  \n")).toBe("Searched code");
		expect(trimClaudeLabel("Searched code\u200B")).toBe("Searched code");
	});

	it("剪空了原样返回", () => {
		expect(trimClaudeLabel("…")).toBe("…");
		expect(trimClaudeLabel("   ")).toBe("   ");
	});

	it("正常标题不动", () => {
		expect(trimClaudeLabel("Searched code")).toBe("Searched code");
		expect(trimClaudeLabel("Read index.html")).toBe("Read index.html");
	});
});

describe("Claude 的子代理组", () => {
	it("认出 owl 的 subagent 与 Claude 的 Task", () => {
		expect(isSubagentTool("subagent")).toBe(true);
		expect(isSubagentTool("Task")).toBe(true);
		expect(isSubagentTool("read")).toBe(false);
	});

	it("组头用 Claude 的复数写法", () => {
		expect(claudeSubagentGroupLabel(1)).toBe("Ran 1 agent");
		expect(claudeSubagentGroupLabel(3)).toBe("Ran 3 agents");
		expect(claudeSubagentGroupLabel(0)).toBe("");
	});

	it("把子代理和普通工具分开", () => {
		const sub = card({ id: "s1", name: "subagent" });
		const read = card({ id: "r1", name: "read" });
		const split = splitSubagentCards([sub, read]);
		expect(split.subagents.map((c) => c.id)).toEqual(["s1"]);
		expect(split.rest.map((c) => c.id)).toEqual(["r1"]);
	});
});

describe("Claude 的连接器文本", () => {
	it("认出 MCP 工具与它的服务器名", () => {
		expect(isConnectorTool("mcp__docs__search")).toBe(true);
		expect(isConnectorTool("read")).toBe(false);
		expect(connectorServerOf("mcp__docs__search")).toBe("docs");
		expect(connectorServerOf("read")).toBeUndefined();
	});

	it("只有散文算连接器文本，JSON 和代码块不算", () => {
		expect(connectorTextOf("这是一段说明。")).toBe("这是一段说明。");
		expect(connectorTextOf('{"a":1}')).toBeUndefined();
		expect(connectorTextOf("```ts\nconst a = 1;\n```")).toBeUndefined();
		expect(connectorTextOf("   ")).toBeUndefined();
		expect(connectorTextOf(undefined)).toBeUndefined();
	});

	it("只收 MCP 工具的散文", () => {
		const blocks = claudeConnectorBlocks([
			card({ id: "m1", name: "mcp__docs__search", output: { text: "找到了三份文档。", totalLines: 1 } }),
			card({ id: "r1", name: "read", output: { text: "普通工具输出。", totalLines: 1 } }),
			card({ id: "m2", name: "mcp__docs__list", output: { text: '{"files":[]}', totalLines: 1 } }),
		]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.source).toBe("docs");
		expect(blocks[0]!.text).toBe("找到了三份文档。");
	});
});

describe("Claude 的用户气泡规格", () => {
	it("数值逐条对齐 bundle", () => {
		expect(CLAUDE_USER_BUBBLE.radius).toBe("0.75rem");
		expect(CLAUDE_USER_BUBBLE.minWidth).toBe("16rem");
		expect(CLAUDE_USER_BUBBLE.maxWidth).toBe("85%");
		expect(CLAUDE_USER_BUBBLE.shadow).toBe("0 1px 2px 0 rgb(0 0 0 / 0.05)");
	});

	it("样式文件真的用上了这些值", () => {
		const css = readFileSync(fileURLToPath(new URL("./claude-flow-cards.css", import.meta.url)), "utf8");
		const bubble = css.slice(css.indexOf('html[data-owl-claude-flow="on"] .owl-user-bubble'));
		expect(bubble).toContain(`min-width: ${CLAUDE_USER_BUBBLE.minWidth}`);
		expect(bubble).toContain(`max-width: ${CLAUDE_USER_BUBBLE.maxWidth}`);
		expect(bubble).toContain(`border-radius: ${CLAUDE_USER_BUBBLE.radius}`);
		expect(bubble).toContain(`box-shadow: ${CLAUDE_USER_BUBBLE.shadow}`);
		expect(bubble).toContain("border: 1px solid");
	});
});
