import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { renderAnswerMarkdown } from "./answer-markdown-renderer.ts";

function answer(source: string): HTMLElement {
	const { document } = parseHTML("<!doctype html><html><body><main></main></body></html>");
	const element = document.querySelector("main")!;
	element.innerHTML = renderAnswerMarkdown(source);
	return element;
}

test("raw HTML and malicious fence information remain literal text without executable attributes", () => {
	const source =
		'<script>bad()</script>\n<img src=x onerror="bad()">\n\n```js\" onmouseover=\"bad()\n<tag attr="value">中文 & 引号\n```\n\n[x](javascript:alert(1))';
	const element = answer(source);
	assert.equal(element.querySelector("script, img, [onmouseover], [onerror], [onclick]"), null);
	assert.equal(element.querySelector('a[href^="javascript:"]'), null);
	assert.match(element.textContent ?? "", /<script>bad\(\)<\/script>/);
	assert.equal(element.querySelector("pre > code")?.textContent, '<tag attr="value">中文 & 引号\n');
	assert.equal(element.querySelectorAll("[data-answer-code]").length, 1);
	const attributeAttack = answer('```\"><img src=x onerror=bad()>\n安全正文\n```');
	assert.equal(attributeAttack.querySelector("img, [onerror]"), null);
	assert.equal(attributeAttack.querySelector("pre > code")?.textContent, "安全正文\n");
});

test("fenced code retains angle brackets, quotes, UTF-8, blank lines and all trailing newlines", () => {
	const payload = "const 中文 = \"<tag attr='value'>\";\n\nconsole.log(中文, '单引号', \"双引号\");\n\n";
	const element = answer(`\`\`\`typescript\n${payload}\`\`\`\n`);
	assert.equal(element.querySelector("pre > code")?.textContent, payload);
	assert.equal(element.querySelectorAll('[data-answer-action="copy-code"]').length, 1);
	assert.equal(element.querySelectorAll('[data-answer-action="expand-code"]').length, 1);
	// 上色只允许新增高亮作用域，不得包裹/改写 payload。
	assert.ok((element.querySelectorAll("pre > code > .hljs-keyword").length ?? 0) > 0);
	for (const span of element.querySelectorAll("pre > code > *")) {
		assert.match(span.getAttribute("class") ?? "", /^hljs-[a-z_-]+$/);
	}
});

test("indented code receives the same safe toolbar while retaining its parsed payload", () => {
	const element = answer("    第一行 <tag attr=\"x\">\n    \n    第二行 '引号'\n");
	assert.equal(element.querySelector("pre > code")?.textContent, "第一行 <tag attr=\"x\">\n\n第二行 '引号'\n");
	assert.equal(element.querySelectorAll("[data-answer-code]").length, 1);
	assert.equal(element.querySelectorAll('[data-answer-action="copy-code"]').length, 1);
});

test("streaming an unclosed fence preserves every received line and does not duplicate the closed result", () => {
	const partial = "段首唯一内容\n\n```js\nstream-one <tag>\nstream-two";
	const open = answer(partial);
	assert.equal(open.querySelectorAll("pre > code").length, 1);
	assert.match(open.querySelector("pre > code")?.textContent ?? "", /^stream-one <tag>\nstream-two\n?$/);
	assert.equal((open.textContent ?? "").split("stream-one").length - 1, 1);
	assert.equal((open.textContent ?? "").split("段首唯一内容").length - 1, 1);
	const closed = answer(`${partial}\nstream-three\n\`\`\`\n\n段尾唯一内容`);
	assert.equal(closed.querySelectorAll("pre > code").length, 1);
	assert.equal(closed.querySelector("pre > code")?.textContent, "stream-one <tag>\nstream-two\nstream-three\n");
	assert.equal((closed.textContent ?? "").split("stream-one").length - 1, 1);
	assert.equal((closed.textContent ?? "").split("段尾唯一内容").length - 1, 1);
	assert.equal(closed.querySelectorAll("p").length, 2);
});

test("multiple code blocks remain independent rather than nesting or sharing their payload", () => {
	const element = answer("```sql\nSELECT '第一块';\n```\n\n说明段落\n\n```sh\necho \"第二块\"\n```");
	const blocks = [...element.querySelectorAll("[data-answer-code]")];
	assert.equal(blocks.length, 2);
	assert.deepEqual(
		blocks.map((block) => block.querySelector("pre > code")?.textContent),
		["SELECT '第一块';\n", 'echo "第二块"\n'],
	);
	for (const block of blocks) {
		assert.equal(block.querySelectorAll("[data-answer-code]").length, 0);
		assert.equal(block.querySelectorAll('[data-answer-action="copy-code"]').length, 1);
	}
});

test("table wrapping retains every cell, URL and clickable inline code path", () => {
	const element = answer(
		"| 名称 | 依据 | 路径 |\n| --- | --- | --- |\n| 中文 <示例> | [原文](https://example.test/item?a=1&b=2) | `D:/项目/source.ts:42` |\n| 第二行 | **强调** | `ordinary` |",
	);
	const table = element.querySelector("table")!;
	assert.notEqual(table, null);
	assert.equal(element.querySelectorAll("[data-answer-table]").length, 1);
	assert.equal(table.closest(".owl-answer-table-scroll")?.getAttribute("role"), "region");
	assert.equal(table.querySelectorAll("tr").length, 3);
	assert.equal(table.querySelectorAll("th, td").length, 9);
	assert.equal(table.querySelector("td")?.textContent, "中文 <示例>");
	assert.equal(table.querySelector("a")?.getAttribute("href"), "https://example.test/item?a=1&b=2");
	assert.equal(table.querySelector("code.owl-path-chip")?.textContent, "D:/项目/source.ts:42");
	assert.equal(table.querySelector("strong")?.textContent, "强调");
	assert.equal(table.querySelectorAll("code.owl-path-chip").length, 1);
});
