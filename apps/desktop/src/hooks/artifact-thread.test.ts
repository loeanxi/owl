import assert from "node:assert/strict";
import { test } from "node:test";
import {
	artifactPromptFor,
	artifactQuestionFrom,
	artifactSpecText,
	artifactThreadKey,
	trimReplyPreview,
} from "./artifact-thread.ts";
import type { Product } from "./products.ts";

const fileProduct: Product = {
	id: "file:docs/report.md",
	kind: "file",
	title: "report.md",
	subtitle: "docs/report.md",
	path: "docs/report.md",
	toolId: "w1",
	fileKind: "document",
	action: "written",
};

const chartProduct: Product = {
	id: "visual:v1",
	kind: "chart",
	title: "月度趋势",
	toolId: "v1",
	spec: { title: "月度趋势", items: [{ type: "chart", data: [{ label: "一月", value: 12 }] }] },
};

test("the thread key binds a product to a project", () => {
	assert.equal(artifactThreadKey("D:/owl", "visual:v1"), "owl.artifactchat.d:/owl.visual:v1");
	// Windows 与 POSIX 写法指向同一个项目：键不该因为分隔符不同而分裂。
	assert.equal(artifactThreadKey("D:\\owl\\", "visual:v1"), "owl.artifactchat.d:/owl.visual:v1");
});

test("a file product rides along as a read-only attachment", () => {
	const prompt = artifactPromptFor(fileProduct, "这个报告讲了什么");
	assert.deepEqual(prompt.attachedPaths, ["docs/report.md"]);
	assert.match(prompt.message, /\[Artifact context\]/);
	assert.match(prompt.message, /title: report\.md/);
	assert.match(prompt.message, /path: docs\/report\.md/);
	assert.match(prompt.message, /Question: 这个报告讲了什么/);
});

test("a visual product carries its spec inline", () => {
	const prompt = artifactPromptFor(chartProduct, "哪个月最高");
	assert.equal(prompt.attachedPaths, undefined);
	assert.match(prompt.message, /kind: chart/);
	assert.match(prompt.message, /"label": "一月"/);
	assert.match(prompt.message, /Question: 哪个月最高/);
});

test("an oversized spec is truncated rather than flooding the turn", () => {
	const huge: Product = { ...chartProduct, spec: { blob: "x".repeat(20_000) } };
	const text = artifactSpecText(huge);
	assert.ok(text.length < 20_000);
	assert.match(text, /… \(truncated\)$/);
});

test("the question is recovered from the stored message", () => {
	const prompt = artifactPromptFor(fileProduct, "这个报告讲了什么");
	// 会话里存的是带上下文的完整消息，气泡里只该显示用户写的那句。
	assert.equal(artifactQuestionFrom(prompt.message), "这个报告讲了什么");
	assert.equal(
		artifactQuestionFrom(`[Attached files for this turn]\n- docs/report.md\n\n${prompt.message}`),
		"这个报告讲了什么",
	);
	assert.equal(artifactQuestionFrom("没有上下文的普通消息"), "没有上下文的普通消息");
});

test("the reply preview is trimmed the way Claude trims it", () => {
	assert.equal(trimReplyPreview("短回答"), "短回答");
	assert.equal(trimReplyPreview("第一行\n第二行"), "第一行 第二行");
	assert.equal(trimReplyPreview("• 开头是项目符号"), "开头是项目符号");
	// 超长时在最后一个空格处截断并加省略号。
	const long = `${"词".repeat(150)} ${"尾".repeat(150)}`;
	const preview = trimReplyPreview(long);
	assert.ok(preview.length <= 201);
	assert.match(preview, /…$/);
	assert.ok(!preview.includes("  "));
});
