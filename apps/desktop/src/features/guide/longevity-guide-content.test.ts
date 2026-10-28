// longevity-guide-content：单篇 README 的标题剥离、锚点注入与链接归一化。
// 上游是 geekan/HowToLiveLonger 的 README，固定最小样本防解析规则漂移。
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubSlug, injectHeadingIds, parseLongevityDoc, resolveLongevityUrl } from "./longevity-guide-content.ts";

const SAMPLE = [
	"# 程序员延寿指南",
	"",
	"[![CN doc](badge.svg)](README.md)",
	"",
	"### 1. 术语",
	"",
	"* ACM: All-Cause Mortality / 全因死亡率",
	"",
	"### 6. 证据",
	"",
	"#### 6.1. 输入",
	"",
	"##### 6.1.1. 固体",
	"",
	"* 白肉",
	"",
].join("\n");

test("parseLongevityDoc 剥掉首个 H1 作标题，正文不重复标题", () => {
	const doc = parseLongevityDoc(SAMPLE);
	assert.equal(doc.title, "程序员延寿指南");
	assert.ok(doc.body.startsWith("[![CN doc]"));
	assert.ok(!doc.body.includes("# 程序员延寿指南"));
	assert.ok(doc.body.includes("### 1. 术语"));
	// 原样保留，便于缓存层直接存原文。
	assert.equal(doc.raw, SAMPLE);
});

test("parseLongevityDoc 无 H1 时回退默认标题", () => {
	const doc = parseLongevityDoc("### 1. 术语\n\n正文");
	assert.equal(doc.title, "程序员延寿指南");
	assert.ok(doc.body.startsWith("### 1. 术语"));
});

test("injectHeadingIds 注入顺序 id 并产出同序目录", () => {
	const html = "<p>intro</p><h3>1. 术语</h3><p>x</p><h4>6.1. 输入</h4><h5>6.1.1. 固体</h5><h3>2. 目标</h3>";
	const { html: withIds, toc } = injectHeadingIds(html);
	assert.deepEqual(
		toc.map((entry) => entry.id),
		["lon-h-0", "lon-h-1", "lon-h-2", "lon-h-3"],
	);
	assert.deepEqual(
		toc.map((entry) => entry.level),
		[3, 4, 5, 3],
	);
	assert.deepEqual(
		toc.map((entry) => entry.title),
		["1. 术语", "6.1. 输入", "6.1.1. 固体", "2. 目标"],
	);
	assert.match(withIds, /<h3 id="lon-h-0">1\. 术语<\/h3>/);
	assert.match(withIds, /<h5 id="lon-h-2">6\.1\.1\. 固体<\/h5>/);
	assert.equal(withIds.match(/<h\d>/), null);
});

test("injectHeadingIds 标题内联标签只进文本，不进 id 与 slug", () => {
	const { toc } = injectHeadingIds("<h3><strong>粗体</strong>标题</h3>");
	assert.equal(toc[0].title, "粗体标题");
	assert.equal(toc[0].slug, githubSlug("粗体标题"));
});

test("injectHeadingIds 无标题时目录为空，HTML 原样返回", () => {
	const { html, toc } = injectHeadingIds("<p>only</p>");
	assert.deepEqual(toc, []);
	assert.equal(html, "<p>only</p>");
});

test("githubSlug 近似 GitHub：小写、去标点、空格转连字符", () => {
	assert.equal(githubSlug("6.1.1. 固体"), "611-固体");
	assert.equal(githubSlug("6. 证据"), "6-证据");
	assert.equal(githubSlug("All-Cause Mortality"), "all-cause-mortality");
});

test("resolveLongevityUrl 相对路径落到仓库 main 分支，绝对协议原样返回", () => {
	assert.equal(resolveLongevityUrl("LICENSE"), "https://github.com/geekan/HowToLiveLonger/blob/main/LICENSE");
	assert.equal(
		resolveLongevityUrl("README_en.md"),
		"https://github.com/geekan/HowToLiveLonger/blob/main/README_en.md",
	);
	assert.equal(resolveLongevityUrl("https://example.com/a"), "https://example.com/a");
	assert.equal(resolveLongevityUrl("mailto:a@b.c"), "mailto:a@b.c");
});
