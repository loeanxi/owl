import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantSegment, ToolCard } from "../hooks/transcript.ts";
import {
	buildAnswerGroups,
	firstContentLine,
	formatThinkingDuration,
	isThinkingOnly,
	thinkingDurationText,
	toolGroupLabel,
	truncateLabel,
} from "./claude-answer-groups.ts";

function tool(id: string, status: ToolCard["status"] = "ok"): ToolCard {
	return { id, name: "read", args: "{}", summary: `summary ${id}`, status };
}

test("consecutive tool calls collapse into one group labelled by count", () => {
	const segments: AssistantSegment[] = [
		{ kind: "tool", toolId: "a" },
		{ kind: "tool", toolId: "b" },
		{ kind: "tool", toolId: "c" },
	];
	const groups = buildAnswerGroups(segments, [tool("a"), tool("b"), tool("c")]);
	assert.equal(groups.length, 1);
	assert.equal(groups[0]?.kind, "tools");
	assert.equal(groups[0]?.label, "Ran 3 commands");
	assert.deepEqual(groups[0]?.tools.map((card) => card.id), ["a", "b", "c"]);
});

test("a single tool call uses the singular label", () => {
	const groups = buildAnswerGroups([{ kind: "tool", toolId: "a" }], [tool("a")]);
	assert.equal(groups[0]?.label, "Ran 1 command");
});

test("a tool interrupted by prose starts a new group", () => {
	const segments: AssistantSegment[] = [
		{ kind: "tool", toolId: "a" },
		{ kind: "text", text: "现状摸清了。" },
		{ kind: "tool", toolId: "b" },
	];
	const groups = buildAnswerGroups(segments, [tool("a"), tool("b")]);
	assert.deepEqual(groups.map((group) => group.kind), ["tools", "note", "tools"]);
	assert.equal(groups[0]?.label, "Ran 1 command");
	assert.equal(groups[2]?.label, "Ran 1 command");
});

test("group order preserves the assistant content block order", () => {
	const segments: AssistantSegment[] = [
		{ kind: "text", text: "先写后端 billing 领域" },
		{ kind: "tool", toolId: "a" },
		{ kind: "text", text: "Backend first: create the billing domain entities and config." },
		{ kind: "tool", toolId: "b" },
	];
	const groups = buildAnswerGroups(segments, [tool("a"), tool("b")]);
	assert.deepEqual(groups.map((group) => group.kind), ["note", "tools", "note", "tools"]);
	assert.equal(groups[0]?.label, "先写后端 billing 领域");
});

test("thinking becomes its own group instead of a tool row", () => {
	const segments: AssistantSegment[] = [
		{ kind: "thinking", text: "需要先确认 billing 领域边界" },
		{ kind: "tool", toolId: "a" },
	];
	const groups = buildAnswerGroups(segments, [tool("a")]);
	assert.deepEqual(groups.map((group) => group.kind), ["thinking", "tools"]);
	assert.equal(groups[0]?.thinking, "需要先确认 billing 领域边界");
	assert.equal(groups[0]?.label, "需要先确认 billing 领域边界");
});

test("a thinking-only message is recognised so its body is never rendered as prose", () => {
	assert.equal(isThinkingOnly([{ kind: "thinking", text: "思考中" }]), true);
	assert.equal(isThinkingOnly([{ kind: "thinking", text: "思考中" }, { kind: "tool", toolId: "a" }]), false);
	assert.equal(isThinkingOnly([{ kind: "text", text: "正文" }]), false);
	assert.equal(isThinkingOnly([]), false);
});

test("thinking duration is formatted like Claude's Thought for family", () => {
	// Claude 用 Math.round 而非 floor：500ms 记作 1s，低于 500ms 才是空。
	assert.equal(formatThinkingDuration(400), undefined);
	assert.deepEqual(formatThinkingDuration(500), { seconds: 1, unit: "s" });
	assert.deepEqual(formatThinkingDuration(12_400), { seconds: 12, unit: "s" });
	assert.deepEqual(formatThinkingDuration(60_000), { seconds: 60, unit: "m" });
	assert.deepEqual(formatThinkingDuration(90_000), { seconds: 90, unit: "m" });
	assert.deepEqual(formatThinkingDuration(3_600_000), { seconds: 3600, unit: "h" });
	assert.deepEqual(formatThinkingDuration(5_400_000), { seconds: 5400, unit: "h" });
});

test("the duration text keeps Claude's minutes and seconds split", () => {
	const plain = (value: number, unit: "s" | "m" | "h"): string => `${value}${unit}`;
	assert.equal(thinkingDurationText({ seconds: 12, unit: "s" }, plain), "12s");
	assert.equal(thinkingDurationText({ seconds: 60, unit: "m" }, plain), "1m");
	assert.equal(thinkingDurationText({ seconds: 90, unit: "m" }, plain), "1m 30s");
	assert.equal(thinkingDurationText({ seconds: 3600, unit: "h" }, plain), "1h");
	assert.equal(thinkingDurationText({ seconds: 5400, unit: "h" }, plain), "1h 30m");
});

test("thinking label prefers the measured duration over the raw summary", () => {
	const segments: AssistantSegment[] = [{ kind: "thinking", text: "很长的推理内容" }];
	const groups = buildAnswerGroups(segments, [], { thinkingDuration: () => "Thought for 12s" });
	assert.equal(groups[0]?.label, "Thought for 12s");
});

test("the note label is the first meaningful line with markdown decoration removed", () => {
	assert.equal(firstContentLine("# 标题\n\n正文第一行"), "标题");
	assert.equal(firstContentLine("- 列表项"), "列表项");
	assert.equal(firstContentLine("> 引用"), "引用");
	assert.equal(firstContentLine("```ts\ncode\n```"), "code");
	assert.equal(firstContentLine("   \n\n"), undefined);
});

test("labels truncate at 200 characters without splitting a surrogate pair", () => {
	const long = "a".repeat(300);
	assert.equal(truncateLabel(long).length, 201);
	assert.equal(truncateLabel(long).endsWith("\u2026"), true);
	const emoji = "\u{1F600}".repeat(150);
	const cut = truncateLabel(emoji);
	// 150 个代理对 = 300 个 UTF-16 码元；切到 200 码元后补省略号，共 201。
	assert.equal(cut.length, 201);
	assert.equal(cut.includes("\uFFFD"), false);
	assert.equal([...cut].length, 101);
});

test("the tool group label follows Claude's plural rule", () => {
	assert.equal(toolGroupLabel(1), "Ran 1 command");
	assert.equal(toolGroupLabel(2), "Ran 2 commands");
	assert.equal(toolGroupLabel(0), "Ran 0 commands");
});
