import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { renderAnswerMarkdown, renderPlainMarkdown } from "./answer-markdown-renderer.ts";

function answer(source: string): HTMLElement {
	const { document } = parseHTML("<!doctype html><html><body><main></main></body></html>");
	const element = document.querySelector("main")!;
	element.innerHTML = renderAnswerMarkdown(source);
	return element;
}

/**
 * 代码块里所有高亮作用域及其内嵌子语法的承载节点。
 * 内嵌语法（JSX 里的 <div>、Dockerfile 里的 RUN）会多包一层裸类名，
 * 如 <span class="xml"> / <span class="bash">，内部词法依旧是 hljs-*。
 */
function scopes(element: HTMLElement): string[] {
	return [...element.querySelectorAll("pre > code *")].map((node) => node.getAttribute("class") ?? "");
}

/** 只保留真正的词法类名，剔掉内嵌语法包装层，用来判断“确实分了词”。 */
function tokenScopes(element: HTMLElement): string[] {
	return scopes(element).filter((value) => value.startsWith("hljs-"));
}

function tokenize(element: HTMLElement): string | undefined {
	return element.querySelector("pre > code")?.textContent ?? undefined;
}

const SAMPLES: Array<[string, string, string]> = [
	["python", "def f(x):\n    return x + 1  # 注释", "hljs-keyword"],
	["javascript", "const a = 1;", "hljs-keyword"],
	["typescript", "interface A { x: number }", "hljs-keyword"],
	["tsx", "const A = () => <div x={1}>hi</div>;", "hljs-keyword"],
	["json", '{"a": 1, "b": [true, null]}', "hljs-attr"],
	["yaml", "a: 1\nb: [1, 2]", "hljs-attr"],
	["toml", 'title = "x"\n[server]\nport = 8080', "hljs-string"],
	["xml", '<a href="/x">hi</a>', "hljs-tag"],
	["css", "a { color: red; }", "hljs-selector-tag"],
	["scss", "$a: 1;", "hljs-variable"],
	["markdown", "# 标题\n\n**粗体** `code`", "hljs-section"],
	["sql", "SELECT * FROM t WHERE id = 1;", "hljs-keyword"],
	["bash", 'for f in *.txt; do echo "$f"; done', "hljs-keyword"],
	["powershell", "Get-ChildItem -Path $p", "hljs-built_in"],
	["dockerfile", "FROM node:20 AS build\nRUN npm ci", "hljs-keyword"],
	["makefile", "all:\n\techo hi", "hljs-section"],
	["diff", "-old\n+new", "hljs-addition"],
	["c", "int main(void) { return 0; }", "hljs-function"],
	["cpp", "std::vector<int> v;", "hljs-keyword"],
	["csharp", "var a = 1;", "hljs-keyword"],
	["java", "class A { }", "hljs-class"],
	["kotlin", "val a = 1", "hljs-keyword"],
	["swift", "let a = 1", "hljs-keyword"],
	["go", "func f() {}", "hljs-keyword"],
	["rust", "let a = 1;", "hljs-keyword"],
	["php", "<?php $a = 1; ?>", "hljs-variable"],
	["ruby", "def f; @x = 1; end", "hljs-keyword"],
	["lua", "local a = 1", "hljs-keyword"],
	["r", "f <- function(x) x + 1", "hljs-keyword"],
	["nix", "let a = 1; in a", "hljs-keyword"],
	["protobuf", "message A { int32 x = 1; }", "hljs-keyword"],
	["ini", "[s]\nk = v", "hljs-section"],
	["properties", "a=1", "hljs-attr"],
	["http", "GET / HTTP/1.1\nHost: x", "hljs-keyword"],
	["asm-x86asm", "mov eax, [ebp+8]", "hljs-keyword"],
];

test("fenced code is highlighted for every advertised language rather than one of them", () => {
	for (const [label, code, expected] of SAMPLES) {
		const language = label === "asm-x86asm" ? "asm" : label;
		const element = answer(`\`\`\`${language}\n${code}\n\`\`\``);
		const classes = tokenScopes(element);
		assert.ok(classes.length > 0, `${language} 没有任何高亮作用域`);
		assert.ok(
			classes.every((value) => /^hljs-[a-z_-]+$/.test(value)),
			`${language} 输出了非高亮的 class：${classes.join(",")}`,
		);
		assert.equal(tokenize(element), `${code}\n`, `${language} 的 payload 被改写`);
		assert.ok(
			classes.some((value) => value.startsWith(expected)),
			`${language} 缺少 ${expected} 作用域：${classes.join(",")}`,
		);
	}
});

test("aliases authors actually type resolve to the same coloring", () => {
	const pairs: Array<[string, string]> = [
		["py", "python"],
		["js", "javascript"],
		["ts", "typescript"],
		["yml", "yaml"],
		["sh", "bash"],
		["md", "markdown"],
		["cs", "csharp"],
		["golang", "go"],
		["postgres", "sql"],
		["docker", "dockerfile"],
		["objc", "objectivec"],
		["conf", "ini"],
	];
	for (const [alias, canonical] of pairs) {
		const code = "x = y;";
		const aliased = answer(`\`\`\`${alias}\n${code}\n\`\`\``);
		const expected = answer(`\`\`\`${canonical}\n${code}\n\`\`\``);
		assert.deepEqual(tokenScopes(aliased), tokenScopes(expected), `${alias} 与 ${canonical} 上色不一致`);
		assert.deepEqual(scopes(aliased), scopes(expected), `${alias} 与 ${canonical} 的结构不一致`);
		assert.equal(tokenize(aliased), `${code}\n`);
	}
});

test("unknown and plain-text fences stay readable as escaped text instead of erroring", () => {
	for (const language of ["cobol", "definitely-not-a-lang"]) {
		const element = answer(`\`\`\`${language}\n<b>x = 1</b>\n\`\`\``);
		assert.deepEqual(scopes(element), [], `${language} 不该有高亮作用域`);
		assert.equal(tokenize(element), "<b>x = 1</b>\n");
		assert.equal(element.querySelector("pre b"), null);
	}
	for (const language of ["text", "txt", "plaintext"]) {
		const element = answer(`\`\`\`${language}\n<b>plain</b> & 符号\n\`\`\``);
		assert.deepEqual(scopes(element), []);
		assert.equal(tokenize(element), "<b>plain</b> & 符号\n");
	}
});

test("highlighting never becomes an injection surface", () => {
	const payload = '</code><img src=x onerror="bad()"><script>bad()</script>';
	for (const language of ["html", "xml", "javascript", "python", "markdown"]) {
		const element = answer(`\`\`\`${language}\n${payload}\n\`\`\``);
		assert.equal(element.querySelector("script, img, [onerror], [onclick]"), null, `${language} 泄漏了可执行标记`);
		assert.match(element.textContent ?? "", /<script>bad\(\)<\/script>/);
		assert.equal(tokenize(element), `${payload}\n`);
	}
	// 围栏语言名本身同样只是文本：不能变成 class 或属性。
	const attacked = answer('```python" onmouseover="bad()\nx = 1\n```');
	assert.equal(attacked.querySelector("[onmouseover]"), null);
	assert.equal(attacked.querySelectorAll("[data-answer-code]").length, 1);
});

test("indented code without a language is left uncolored but still escaped", () => {
	const element = answer("    第一行 <tag attr=\"x\">\n    \n    第二行 '引号'\n");
	assert.deepEqual(scopes(element), []);
	assert.equal(tokenize(element), "第一行 <tag attr=\"x\">\n\n第二行 '引号'\n");
});

test("blank lines and trailing newlines survive highlighting byte for byte", () => {
	const payload = 'def f():\n\n    return "<tag>&"\n\n\n';
	const element = answer(`\`\`\`python\n${payload}\`\`\``);
	assert.equal(tokenize(element), payload);
	assert.ok(scopes(element).length > 0);
});

test("plain previews share the same coloring without reading controls", () => {
	const { document } = parseHTML("<!doctype html><html><body><article></article></body></html>");
	const preview = document.querySelector("article")!;
	preview.innerHTML = renderPlainMarkdown("```python\ndef f():\n    return 1\n```\n\n```sql\nSELECT 1;\n```\n");
	const blocks = [...preview.querySelectorAll("pre > code")];
	assert.equal(blocks.length, 2);
	for (const block of blocks) {
		const inside = [...block.querySelectorAll("*")].map((node) => node.getAttribute("class") ?? "");
		assert.ok(inside.length > 0);
		assert.ok(inside.every((value) => /^hljs-[a-z_-]+$/.test(value)));
	}
	assert.equal(blocks[0]?.textContent, "def f():\n    return 1\n");
	assert.equal(blocks[1]?.textContent, "SELECT 1;\n");
	// 预览不挂阅读控件（工具栏/展开/复制按钮由答案组件负责）。
	assert.equal(preview.querySelector("[data-answer-code], [data-answer-toolbar]"), null);
});

test("the same block renders identically across repeated and interleaved calls", () => {
	const source = "```python\ndef f():\n    return 1  # 注释\n```";
	const first = answer(source);
	const second = answer("```js\nconst a = 1;\n```");
	const third = answer(source);
	assert.equal(first.innerHTML, third.innerHTML);
	assert.deepEqual(scopes(third), scopes(first));
	assert.notEqual(second.innerHTML, first.innerHTML);
});
