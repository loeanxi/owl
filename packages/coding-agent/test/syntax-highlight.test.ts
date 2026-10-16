import assert from "node:assert/strict";
import test from "node:test";
import {
	highlightCodeHtml,
	isPlainHighlightLanguage,
	resolveHighlightLanguage,
	supportsLanguage,
} from "../src/utils/syntax-highlight.ts";

/** highlight.js 的输出是转义后的 HTML；还原成纯文本后才能与输入逐字比较。 */
function textOf(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** 每个围栏语言名配一段最朴素的样本：只验证“能否上色”，不追求覆盖全部语法。 */
const SAMPLES: Array<[string, string]> = [
	["python", "def bubble_sort(arr):\n    n = len(arr)  # 注释\n    if n <= 1:\n        return arr"],
	["py", "x = 1"],
	["javascript", "const a = 1;"],
	["js", "const a = 1;"],
	["jsx", "const A = () => <div x={1}>hi</div>;"],
	["typescript", "interface A { x: number }"],
	["ts", "const a: number = 1;"],
	["tsx", "const A = () => <div x={1}>hi</div>;"],
	["mts", "const a: number = 1;"],
	["json", '{"a": 1, "b": [true, null]}'],
	["jsonc", '{"a": 1 /* 注释 */}'],
	["yaml", "a: 1\nb: [1, 2]"],
	["yml", "a: 1"],
	["toml", 'title = "x"\n[server]\nport = 8080'],
	["ini", "a=1"],
	["conf", "a=1"],
	["html", '<a href="/x">hi</a>'],
	["xml", "<a>1</a>"],
	["svg", "<svg></svg>"],
	["css", "a { color: red; }"],
	["scss", "$a: 1;"],
	["less", "@a: 1;"],
	["markdown", "# 标题\n\n**粗体** `code`"],
	["md", "# 标题"],
	["sql", "SELECT * FROM t WHERE id = 1;"],
	["postgres", "SELECT 1"],
	["plpgsql", "SELECT 1"],
	["bash", 'for f in *.txt; do echo "$f"; done'],
	["sh", "echo hi"],
	["zsh", "echo $ZSH_VERSION"],
	["shell", "cd /tmp && ls"],
	["powershell", "Get-ChildItem -Path $p"],
	["ps1", "Write-Host 'hi'"],
	["bat", "echo hi"],
	["cmd", "dir"],
	["dockerfile", "FROM node:20 AS build\nRUN npm ci"],
	["containerfile", "FROM node:20"],
	["makefile", "all:\n\techo hi"],
	["mk", "all:\n\techo hi"],
	["cmake", "project(owl)"],
	["nginx", "server { listen 80; }"],
	["diff", "-old\n+new"],
	["patch", "-old\n+new"],
	["c", "int main(void) { return 0; }"],
	["cpp", "std::vector<int> v;"],
	["cs", "var a = 1;"],
	["csharp", "int a = 1;"],
	["java", "class A { }"],
	["kotlin", "val a = 1"],
	["scala", "val a = 1"],
	["groovy", "def a = 1"],
	["swift", "let a = 1"],
	["objc", "NSString *a;"],
	["obj-c", "NSString *a;"],
	["dart", "var a = 1;"],
	["go", "func f() {}"],
	["golang", "package main"],
	["rust", "let a = 1;"],
	["r", "f <- function(x) x + 1"],
	["julia", "function f(x)\n  x + 1\nend"],
	["matlab", "for i = 1:10\n  disp(i)\nend"],
	["fortran", "program x\n  integer :: i\nend program x"],
	["haskell", "data T = A | B"],
	["hs", "data T = A | B"],
	["ex", "defmodule A do\n  def f, do: 1\nend"],
	["erl", "-module(a)."],
	["clj", "(defn f [x] x)"],
	["fsharp", "let f x = x + 1"],
	["ml", "let f x = x + 1"],
	["nix", "{ pkgs }: pkgs.hello"],
	["protobuf", "message A { int32 x = 1; }"],
	["proto", "message A { }"],
	["properties", "a=1"],
	["http", "GET / HTTP/1.1\nHost: x"],
	["gradle", "plugins { id 'java' }"],
	["asm", "mov eax, [ebp+8]"],
	["lisp", "(defun f (x) (+ x 1))"],
	["vim", "set number"],
	["console", "$ echo hi"],
];

test("every advertised fence language resolves and colors without altering the payload", () => {
	const unresolved: string[] = [];
	for (const [language, code] of SAMPLES) {
		const html = highlightCodeHtml(code, language);
		if (html === undefined) {
			unresolved.push(language);
			continue;
		}
		// 上色不得丢字、换字：还原后的纯文本必须与输入逐字相等（含中文、引号与 &<>）。
		assert.equal(textOf(html), code, `${language} 的 payload 被改写了`);
		assert.equal(/<script|onerror=|javascript:/i.test(html), false, `${language} 的输出出现可执行标记`);
	}
	assert.deepEqual(unresolved, [], "下列语言声明支持却没有高亮输出");
});

test("language names are matched case-insensitively and unknown ones fall back to plain text", () => {
	assert.equal(resolveHighlightLanguage("PYTHON"), "python");
	assert.equal(resolveHighlightLanguage("  Ts  "), "ts");
	// objective-c / obj-c / objc 在 highlight.js 里已是别名，归一目标由它决定；
	// 这里只要求三个写法都能解析到同一种语法并出色。
	const objective = ["Objective-C", "obj-c", "objc"].map((name) => highlightCodeHtml("NSString *a;", name));
	for (const html of objective) assert.notEqual(html, undefined);
	assert.equal(new Set(objective).size, 1);
	assert.equal(resolveHighlightLanguage("nginx"), "nginx");
	// 认不出来就返回 undefined，由调用方走转义原文，不抛错也不猜语言。
	for (const unknown of ["cobol", "definitely-not-a-lang", "", "   "]) {
		assert.equal(resolveHighlightLanguage(unknown), undefined);
		assert.equal(highlightCodeHtml("x = 1", unknown), undefined);
	}
});

test("plain text fences stay byte-identical and are excluded from syntax coloring", () => {
	for (const language of ["text", "txt", "plain", "plaintext", "log", "ansi", "terminal"]) {
		assert.equal(isPlainHighlightLanguage(language), true, `${language} 应被当作纯文本`);
		assert.equal(highlightCodeHtml("<b>a</b>", language), "&lt;b&gt;a&lt;/b&gt;");
	}
	// console 是 hightlight.js 的 Shell Session（带提示符的命令会话），不属于纯文本。
	assert.equal(isPlainHighlightLanguage("console"), false);
	assert.notEqual(highlightCodeHtml("$ echo hi", "console"), undefined);
	assert.equal(isPlainHighlightLanguage("python"), false);
});

test("empty, blank-line and trailing-newline payloads keep their exact shape", () => {
	for (const payload of ["", "\n", "a = 1", "a = 1\n", "a = 1\n\n", "\n\n\n"]) {
		const html = highlightCodeHtml(payload, "python");
		assert.notEqual(html, undefined);
		assert.equal(textOf(html ?? ""), payload);
	}
});

test("CRLF and CR payloads are colored without being rewritten", () => {
	for (const payload of ["const a = 1;\r\nconst b = 2;\r\n", "x = 1\r", "a\r\nb\r\nc"]) {
		const html = highlightCodeHtml(payload, "javascript");
		assert.notEqual(html, undefined);
		assert.equal(textOf(html ?? ""), payload, "行尾被改写了");
	}
});

test("oversized blocks are left uncolored instead of blocking the render path", () => {
	assert.equal(highlightCodeHtml("x".repeat(200_000), "python"), undefined);
	// 边界之内仍然正常工作。
	assert.notEqual(highlightCodeHtml("x = 1".repeat(1_000), "python"), undefined);
});

test("supportsLanguage reports capability without registering anything new", () => {
	assert.equal(supportsLanguage("python"), true);
	assert.equal(supportsLanguage("nginx"), true);
	assert.equal(supportsLanguage("cobol"), false);
});
