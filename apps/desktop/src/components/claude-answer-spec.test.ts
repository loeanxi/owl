import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCard } from "../hooks/transcript.ts";
import { claudeActionLine, claudeActionText, claudeGroupTitle, claudeTurnSummaryText } from "./claude-answer-spec.ts";

function card(name: string, args: Record<string, unknown>, extra: Partial<ToolCard> = {}): ToolCard {
	return {
		id: "c1",
		name,
		args: JSON.stringify(args),
		summary: `summary ${name}`,
		status: "ok",
		...extra,
	};
}

test("the model-authored title wins over the front-end fallback", () => {
	// Claude Desktop 的工具行标题是模型写的（wire 上带 title_parts），前端只做兜底。
	const authored = card("read", { path: "src/admin/index.html" }, { output: { text: "", totalLines: 0, title: "Read admin HTML structure" } });
	const line = claudeActionLine(authored);
	assert.equal(line?.verb, "");
	assert.equal(line?.object, "Read admin HTML structure");
	assert.equal(claudeActionText(line!), "Read admin HTML structure");
});

test("without a model title the verb table fills in", () => {
	assert.equal(claudeActionText(claudeActionLine(card("read", { path: "src/admin/index.html" }))!), "Read index.html");
	assert.equal(claudeActionText(claudeActionLine(card("write", { path: "src/admin/core.ts" }))!), "Created core.ts");
	assert.equal(claudeActionText(claudeActionLine(card("edit", { path: "src/admin/core.ts" }))!), "Edited core.ts");
	assert.equal(claudeActionText(claudeActionLine(card("grep", { pattern: "loean-{mark|word}" }))!), "Searched loean-{mark|word}");
	assert.equal(claudeActionText(claudeActionLine(card("ls", { path: "src/admin" }))!), "Listed admin");
	assert.equal(claudeActionText(claudeActionLine(card("bash", { command: "npm run check" }))!), "Ran npm run check");
});

test("a call without enough information yields no phrase", () => {
	assert.equal(claudeActionLine(card("read", {})), undefined);
	assert.equal(claudeActionLine(card("grep", { path: "src" })), undefined);
});

test("the group title follows the main verb of the batch", () => {
	assert.equal(claudeGroupTitle([card("read", { path: "a.ts" }), card("read", { path: "b.ts" })]), "Read files");
	assert.equal(claudeGroupTitle([card("grep", { pattern: "x" })]), "Searched code");
	// 混合批次按第一个动作的动词定名。
	assert.equal(claudeGroupTitle([card("grep", { pattern: "x" }), card("read", { path: "a.ts" })]), "Searched code");
});

test("the group title uses the model's batch label when there is one", () => {
	// 服务端在批次结束后让模型写的组标题（Claude 的 tool_use_summary）。
	const labelled = card("grep", { pattern: "x" }, { batchLabel: "Searched code" });
	assert.equal(claudeGroupTitle([labelled]), "Searched code");
	// 组内任意一张卡带上标签都算数。
	assert.equal(claudeGroupTitle([card("grep", { pattern: "x" }), labelled]), "Searched code");
});

test("a per-tool title does not become the group title", () => {
	// Claude 的组头说的是这批工具整体在干什么，不是第一条工具的细节。
	const authored = card("read", { path: "a.ts" }, { output: { text: "", totalLines: 0, title: "Surveyed admin frontend structure" } });
	assert.equal(claudeGroupTitle([authored]), "Read files");
});

test("the turn summary lists what was done, without repeating", () => {
	const summary = claudeTurnSummaryText([
		card("read", { path: "a.ts" }),
		card("read", { path: "a.ts" }),
		card("edit", { path: "b.ts" }),
	]);
	assert.equal(summary, "Read a.ts, edited b.ts");
});

test("the turn summary reads like Claude's prose", () => {
	// Claude: "Searched code, read and edited style.css, ran a command"
	const summary = claudeTurnSummaryText([
		card("grep", { pattern: "brand" }, { batchLabel: "Searched code" }),
		card("read", { path: "style.css" }),
		card("edit", { path: "style.css" }),
		card("bash", { command: "npm run build" }),
	]);
	assert.equal(summary, "Searched code, read and edited style.css, ran a command");
});

test("the turn summary falls back to the action phrase when no group label exists", () => {
	const summary = claudeTurnSummaryText([card("grep", { pattern: "brand" })]);
	assert.equal(summary, "Searched brand");
});
