import React from "react";
import { createRoot } from "react-dom/client";
import { ChatStream } from "../../src/components/ChatStream.tsx";

/**
 * 复刻用户那一轮的结构：多段单行说明 + 单行思考 + 工具调用。
 * 目的是量出「Claude 式回答流」把这些内容隐藏掉之后，还剩下多少可见行。
 */
function tool(id, name, args) {
	return { id, name, args: JSON.stringify(args), status: "done", output: { text: "ok" }, ts: Date.now() };
}

function assistantEntry(id, segments, tools) {
	return {
		kind: "assistant",
		entryId: id,
		timestamp: Date.now(),
		text: "",
		thinking: "",
		tools,
		segments,
		usage: undefined,
	};
}

const tools = [
	tool("t1", "ls", { path: "." }),
	tool("t2", "tool_search", { query: "subagent" }),
	tool("t3", "subagents_enable", {}),
	tool("t4", "subagent", { action: "list" }),
	tool("t5", "subagent", { action: "run" }),
	tool("t6", "read", { path: "greet.js" }),
	tool("t7", "read", { path: "quicksort.py" }),
	tool("t8", "bash", { command: "node test-greet.js" }),
	tool("t9", "bash", { command: "node test-greet-edge.js" }),
	tool("t10", "bash", { command: "python quicksort.py" }),
];

// 用户第一问那一轮的真实内容（来自会话记录 01a17eb3）
const entry = assistantEntry("a1", [
	{ kind: "thinking", text: "用户要测试子 agent 调用能力。需要 subagents_enable 工具，然后 subagent。" },
	{ kind: "text", text: "我先看一下工作区，然后启用子代理能力。" },
	{ kind: "tool", toolId: "t1" },
	{ kind: "tool", toolId: "t2" },
	{ kind: "tool", toolId: "t3" },
	{ kind: "thinking", text: "subagents_enable 不在可用工具里。用 tool_search 发现 subagent 能力。" },
	{ kind: "tool", toolId: "t4" },
	{ kind: "text", text: "工作区是个小小的 Node+Python 实验项目，正好拿来当测试目标。" },
	{ kind: "thinking", text: "Now call subagents_enable (should be loaded now)." },
	{ kind: "thinking", text: "Now call subagent with action list capabilities:true.\nBut the tool may need enabling.\nLet me check." },
	{ kind: "text", text: "子代理清单正常，其中有 20 个用户级代理和内置的 worker、reviewer、scout 等。下面跑一个真实的两路并行测试：一路写代码，为 `greet()` 补 JSDoc 注释；一路只读审查 `quicksort.py` 的边界情况。" },
	{ kind: "tool", toolId: "t5" },
	{ kind: "thinking", text: "Let's run a simple test subagent — e.g. delegate or scout.\nSome second line here.\nThird line." },
	{ kind: "tool", toolId: "t6" },
	{ kind: "tool", toolId: "t7" },
	{ kind: "text", text: "两路 agent 都已完成。现在由我来核对它们各自的说法，不能只听它们自报。" },
	{ kind: "tool", toolId: "t8" },
	{ kind: "tool", toolId: "t9" },
	{ kind: "text", text: "reviewer 提出的 RecursionError 值得实际测试，这是它的结论中唯一的实质风险。" },
	{ kind: "tool", toolId: "t10" },
	{ kind: "text", text: "子代理跑通了，实测结论如下。\n\n**链路**：subagents_enable → subagent list 拿到 20 个用户级 agent。\n\n**并行实测**：worker 写入型 12.6s，reviewer 只读型 22.1s。" },
], tools);

const entries = [
	{ kind: "user", entryId: "u1", timestamp: Date.now() - 60000, text: "测试下owl的子agent" },
	entry,
];

function Fixture() {
	return React.createElement(
		"div",
		{ style: { height: "100vh", display: "flex", flexDirection: "column" } },
		React.createElement(
			"div",
			{ className: "owl-desktop-shell", style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
			React.createElement(
				"div",
				{ className: "owl-main-frame", style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
				React.createElement(
					"div",
					{ className: "owl-agent-conversation" },
					React.createElement(ChatStream, {
						entries,
						sessionId: "fixture-session",
						activity: "idle",
						cwd: "D:/owl/tmp/e2e-workspace",
					}),
				),
			),
		),
	);
}

createRoot(document.getElementById("root")).render(React.createElement(Fixture));
