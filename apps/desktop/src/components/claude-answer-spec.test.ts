import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCard } from "../hooks/transcript.ts";
import {
	claudeActionLine,
	claudeActionText,
	claudeGroupTitle,
	claudeRowObject,
	claudeTurnSummaryText,
} from "./claude-answer-spec.ts";

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

test("the front-end verb table wins over the model-authored title", () => {
	// 网关型 provider 给的标题常是一整句流水账（"Write live-state.mjs, ran a command, …"），
	// 直接上屏就是一串读不懂的句子。客户端的动词短语更整齐，模型标题只做兜底。
	const authored = card(
		"read",
		{ path: "src/admin/index.html" },
		{ output: { text: "", totalLines: 0, title: "Read admin HTML structure" } },
	);
	const line = claudeActionLine(authored);
	assert.equal(line?.verb, "Read");
	assert.equal(line?.object, "index.html");
	assert.equal(claudeActionText(line!), "Read index.html");
});

test("the model-authored title is the fallback when the verb table has nothing", () => {
	const authored = card(
		"browser",
		{ url: "https://example.com" },
		{ output: { text: "", totalLines: 0, title: "Opened the page" } },
	);
	const line = claudeActionLine(authored);
	assert.equal(line?.verb, "");
	assert.equal(line?.object, "Opened the page");
});

test("without a model title the verb table fills in", () => {
	assert.equal(claudeActionText(claudeActionLine(card("read", { path: "src/admin/index.html" }))!), "Read index.html");
	assert.equal(claudeActionText(claudeActionLine(card("write", { path: "src/admin/core.ts" }))!), "Created core.ts");
	assert.equal(claudeActionText(claudeActionLine(card("edit", { path: "src/admin/core.ts" }))!), "Edited core.ts");
	assert.equal(
		claudeActionText(claudeActionLine(card("grep", { pattern: "loean-{mark|word}" }))!),
		"Searched loean-{mark|word}",
	);
	assert.equal(claudeActionText(claudeActionLine(card("ls", { path: "src/admin" }))!), "Listed admin");
	assert.equal(claudeActionText(claudeActionLine(card("bash", { command: "npm run check" }))!), "Ran npm run check");
});

test("a call without enough information yields no phrase", () => {
	assert.equal(claudeActionLine(card("read", {})), undefined);
	assert.equal(claudeActionLine(card("grep", { path: "src" })), undefined);
});

test("only object-less fallback labels carry an inline meta object", () => {
	// Claude 的行内 meta：泛指标签（"Ran a command"）后跟对象；文件类标签
	// 自带短路径（"Reading admin/index.html"），模型标题亦然 —— 都不补 meta。
	assert.equal(claudeRowObject(card("bash", { command: "npm run check" })), "npm run check");
	assert.equal(claudeRowObject(card("grep", { pattern: "brand" })), "brand");
	assert.equal(claudeRowObject(card("web_search", { query: "owl" })), "owl");
	assert.equal(claudeRowObject(card("ls", { path: "src/admin" })), "admin");
	assert.equal(claudeRowObject(card("read", { path: "src/admin/index.html" })), undefined);
	const authored = card(
		"bash",
		{ command: "npm run check" },
		{ output: { text: "", totalLines: 0, title: "Ran the suite" } },
	);
	assert.equal(claudeRowObject(authored), undefined);
});

test("the group title falls back to Claude's own category copy", () => {
	// Claude 的工具汇总表：read → "Read a file" / "Read {count} files"
	assert.equal(claudeGroupTitle([card("read", { path: "a.ts" })]), "Read a file");
	assert.equal(claudeGroupTitle([card("read", { path: "a.ts" }), card("read", { path: "b.ts" })]), "Read 2 files");
	// Claude: grep → "Searched files"
	assert.equal(claudeGroupTitle([card("grep", { pattern: "x" })]), "Searched files");
	// 混合批次按第一个动作的类别定名，次数只数同类的。
	assert.equal(claudeGroupTitle([card("grep", { pattern: "x" }), card("read", { path: "a.ts" })]), "Searched files");
	// Claude: bash → "Ran a command" / "Ran {count} commands"
	assert.equal(
		claudeGroupTitle([card("bash", { command: "npm run check" }), card("bash", { command: "npm test" })]),
		"Ran 2 commands",
	);
});

test("the group title uses Claude's category copy, with the model batch label as fallback", () => {
	// 动词表优先：网关型 provider 的批次标签常是流水账，当组头就是一串读不懂的句子。
	const labelled = card("grep", { pattern: "x" }, { batchLabel: "Searched code" });
	assert.equal(claudeGroupTitle([labelled]), "Searched files");
	// 组内任意一张卡带上标签都算数。
	assert.equal(claudeGroupTitle([card("grep", { pattern: "x" }), labelled]), "Searched files");
	// 客户端没有对应类别时，才落回模型写的批次标签。
	const unknown = card("browser", { url: "https://example.com" }, { batchLabel: "Opened the page" });
	assert.equal(claudeGroupTitle([unknown]), "Opened the page");
});

test("a per-tool title does not become the group title", () => {
	// Claude 的组头说的是这批工具整体在干什么，不是第一条工具的细节。
	const authored = card(
		"read",
		{ path: "a.ts" },
		{ output: { text: "", totalLines: 0, title: "Surveyed admin frontend structure" } },
	);
	assert.equal(claudeGroupTitle([authored]), "Read a file");
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
	// 搜索项用客户端的动作短语（模型写的批次标签只做兜底）。
	const summary = claudeTurnSummaryText([
		card("grep", { pattern: "brand" }, { batchLabel: "Searched code" }),
		card("read", { path: "style.css" }),
		card("edit", { path: "style.css" }),
		card("bash", { command: "npm run build" }),
	]);
	assert.equal(summary, "Searched brand, read and edited style.css, ran a command");
});

test("the turn summary falls back to the action phrase when no group label exists", () => {
	const summary = claudeTurnSummaryText([card("grep", { pattern: "brand" })]);
	assert.equal(summary, "Searched brand");
});
