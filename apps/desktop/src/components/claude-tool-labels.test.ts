import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCard } from "../hooks/transcript.ts";
import {
	CLAUDE_TOOL_LABELS,
	CLAUDE_TOOL_LABELS_CANCELLED,
	CLAUDE_TOOL_LABELS_DONE,
	claudeShortPath,
	claudeToolLabel,
	claudeToolLabelFor,
	claudeToolName,
} from "./claude-tool-labels.ts";

function card(name: string, args: Record<string, unknown> = {}, extra: Partial<ToolCard> = {}): ToolCard {
	return {
		id: "c1",
		name,
		args: JSON.stringify(args),
		summary: `summary ${name}`,
		status: "ok",
		...extra,
	};
}

test("the fallback labels are Claude's own words, not ours", () => {
	// 逐字取自 bundle 的 kF：现在是进行时、泛指，不带对象。
	assert.equal(CLAUDE_TOOL_LABELS.read, "Reading a file");
	assert.equal(CLAUDE_TOOL_LABELS.grep, "Searching files");
	assert.equal(CLAUDE_TOOL_LABELS.glob, "Looking for files");
	assert.equal(CLAUDE_TOOL_LABELS.ls, "Listing files");
	assert.equal(CLAUDE_TOOL_LABELS.edit, "Editing a file");
	assert.equal(CLAUDE_TOOL_LABELS.write, "Creating a file");
	assert.equal(CLAUDE_TOOL_LABELS.web_search, "Searching the web");
});

test("owl tool names map onto Claude's names", () => {
	assert.equal(claudeToolName("read"), "read");
	// owl 的 find 是「按 glob 找文件」，Claude 侧同类工具归到 glob。
	assert.equal(claudeToolName("find"), "glob");
	assert.equal(claudeToolName("powershell"), "power_shell");
	assert.equal(claudeToolName("unknown_tool"), "unknown_tool");
});

test("the label follows the call state", () => {
	// 运行中用进行时，完成后用完成态（bundle 的 RF）。
	assert.equal(claudeToolLabel("ls", "running"), "Listing files");
	assert.equal(claudeToolLabel("ls", "done"), "Listed files");
	// 没有完成态说法的工具，完成后沿用通用说法。
	assert.equal(claudeToolLabel("read", "done"), "Reading a file");
	assert.equal(claudeToolLabel("read", "running"), "Reading a file");
	// 中断态逐字取自 bundle 的 zF。
	assert.equal(claudeToolLabel("read", "cancelled"), "Stopped reading file");
	assert.equal(claudeToolLabel("bash", "cancelled"), "Stopped running the command");
	assert.equal(CLAUDE_TOOL_LABELS_CANCELLED.bash, "Stopped running the command");
	assert.equal(CLAUDE_TOOL_LABELS_DONE.ls, "Listed files");
});

test("bash gets Claude's three command phrases", () => {
	assert.equal(claudeToolLabel("bash", "running"), "Running a command");
	assert.equal(claudeToolLabel("bash", "done"), "Ran a command");
	assert.equal(claudeToolLabel("powershell", "running"), "Running a command");
});

test("a model-authored title wins over the fallback", () => {
	const authored = card(
		"read",
		{ path: "src/admin/index.html" },
		{
			output: { text: "", totalLines: 0, title: "Read admin HTML structure" },
		},
	);
	const label = claudeToolLabelFor(authored);
	assert.equal(label.text, "Read admin HTML structure");
	assert.equal(label.authored, true);
});

test("without a model title the row shows the generic fallback", () => {
	const label = claudeToolLabelFor(card("read", { path: "src/admin/index.html" }));
	// 文件类工具带短路径（Claude 的 shortenPaths 分支）：QI 保留最后两段。
	assert.equal(label.text, "Reading admin/index.html");
	assert.equal(label.authored, false);
	// 对象不进标题，进 tooltip（Claude 的 labelTooltip）。
	assert.equal(label.detail, "src/admin/index.html");
});

test("the short path keeps the last two segments", () => {
	assert.equal(claudeShortPath("src/admin/index.html"), "admin/index.html");
	assert.equal(claudeShortPath("src/index.html"), "index.html");
	assert.equal(claudeShortPath("index.html"), "index.html");
});

test("file operations carry the object, the rest stay generic", () => {
	assert.equal(claudeToolLabelFor(card("write", { path: "src/admin/core.ts" })).text, "Writing admin/core.ts");
	assert.equal(claudeToolLabelFor(card("edit", { path: "src/admin/core.ts" })).text, "Editing admin/core.ts");
	// grep / ls 没有对象分支，用泛指说法。
	assert.equal(claudeToolLabelFor(card("grep", { pattern: "x" })).text, "Searching files");
	assert.equal(claudeToolLabelFor(card("ls", { path: "src/admin" })).text, "Listed files");
	// 命令统一说 "Running a command" / "Ran a command"，命令进 tooltip。
	assert.equal(claudeToolLabelFor(card("bash", { command: "npm run build" })).text, "Ran a command");
	assert.equal(
		claudeToolLabelFor(card("bash", { command: "npm run build" }, { status: "running" })).text,
		"Running a command",
	);
});

test("the detail carries whatever object the tool has", () => {
	assert.equal(claudeToolLabelFor(card("grep", { pattern: "loean-{mark|word}" })).detail, "loean-{mark|word}");
	assert.equal(claudeToolLabelFor(card("bash", { command: "npm run build" })).detail, "npm run build");
	assert.equal(claudeToolLabelFor(card("ls", { path: "src/admin" })).detail, "src/admin");
	assert.equal(claudeToolLabelFor(card("read", {})).detail, undefined);
});

test("a running call reads differently from a finished one", () => {
	assert.equal(claudeToolLabelFor(card("ls", { path: "src" }, { status: "running" })).text, "Listing files");
	assert.equal(claudeToolLabelFor(card("ls", { path: "src" }, { status: "ok" })).text, "Listed files");
	// 失败在 Claude 那边仍是完成态 —— 失败靠颜色表达，不改文案。
	assert.equal(claudeToolLabelFor(card("ls", { path: "src" }, { status: "error" })).text, "Listed files");
});

test("a tool Claude has no phrase for falls back to the card summary", () => {
	const label = claudeToolLabelFor(card("mystery_tool", {}));
	assert.equal(label.text, "summary mystery_tool");
});
