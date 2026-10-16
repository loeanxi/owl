import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import clojure from "highlight.js/lib/languages/clojure.js";
import cmake from "highlight.js/lib/languages/cmake.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import css from "highlight.js/lib/languages/css.js";
import dart from "highlight.js/lib/languages/dart.js";
import diff from "highlight.js/lib/languages/diff.js";
import dockerfile from "highlight.js/lib/languages/dockerfile.js";
import dos from "highlight.js/lib/languages/dos.js";
import elixir from "highlight.js/lib/languages/elixir.js";
import erlang from "highlight.js/lib/languages/erlang.js";
import fortran from "highlight.js/lib/languages/fortran.js";
import fsharp from "highlight.js/lib/languages/fsharp.js";
import go from "highlight.js/lib/languages/go.js";
import gradle from "highlight.js/lib/languages/gradle.js";
import groovy from "highlight.js/lib/languages/groovy.js";
import haskell from "highlight.js/lib/languages/haskell.js";
import http from "highlight.js/lib/languages/http.js";
import ini from "highlight.js/lib/languages/ini.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import julia from "highlight.js/lib/languages/julia.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import less from "highlight.js/lib/languages/less.js";
import lisp from "highlight.js/lib/languages/lisp.js";
import lua from "highlight.js/lib/languages/lua.js";
import makefile from "highlight.js/lib/languages/makefile.js";
import markdown from "highlight.js/lib/languages/markdown.js";
import matlab from "highlight.js/lib/languages/matlab.js";
import nginx from "highlight.js/lib/languages/nginx.js";
import nix from "highlight.js/lib/languages/nix.js";
import objectivec from "highlight.js/lib/languages/objectivec.js";
import ocaml from "highlight.js/lib/languages/ocaml.js";
import perl from "highlight.js/lib/languages/perl.js";
import php from "highlight.js/lib/languages/php.js";
import plaintext from "highlight.js/lib/languages/plaintext.js";
import powershell from "highlight.js/lib/languages/powershell.js";
import properties from "highlight.js/lib/languages/properties.js";
import protobuf from "highlight.js/lib/languages/protobuf.js";
import python from "highlight.js/lib/languages/python.js";
import r from "highlight.js/lib/languages/r.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import scala from "highlight.js/lib/languages/scala.js";
import scss from "highlight.js/lib/languages/scss.js";
import shell from "highlight.js/lib/languages/shell.js";
import sql from "highlight.js/lib/languages/sql.js";
import swift from "highlight.js/lib/languages/swift.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import vbnet from "highlight.js/lib/languages/vbnet.js";
import vim from "highlight.js/lib/languages/vim.js";
import x86asm from "highlight.js/lib/languages/x86asm.js";
import xml from "highlight.js/lib/languages/xml.js";
import yaml from "highlight.js/lib/languages/yaml.js";
import { decodeHtmlEntityAt } from "./html.ts";

/**
 * 常驻语法：聊天/文档里的代码块与导出 HTML 都要立刻出颜色，不能等异步加载。
 * 覆盖面按真实出现频率取：主流语言 + 配置/数据格式 + shell/构建/容器这几类
 * 命令行与工程文件。冷门语言（约 190 个）仍走 loadAllHighlightLanguages() 兜底。
 */
const eagerLanguages = {
	python,
	java,
	go,
	javascript,
	json,
	cpp,
	typescript,
	php,
	ruby,
	c,
	csharp,
	clojure,
	nix,
	bash,
	rust,
	scala,
	kotlin,
	swift,
	dart,
	groovy,
	perl,
	lua,
	yaml,
	ini,
	xml,
	css,
	scss,
	less,
	markdown,
	sql,
	diff,
	plaintext,
	powershell,
	dos,
	dockerfile,
	makefile,
	cmake,
	nginx,
	properties,
	protobuf,
	objectivec,
	r,
	julia,
	matlab,
	fortran,
	erlang,
	haskell,
	elixir,
	fsharp,
	ocaml,
	lisp,
	vim,
	x86asm,
	gradle,
	http,
	shell,
	vbnet,
};

for (const [name, language] of Object.entries(eagerLanguages)) {
	hljs.registerLanguage(name, language);
}

let allLanguagesPromise: Promise<void> | undefined;

export function loadAllHighlightLanguages(): Promise<void> {
	if (!allLanguagesPromise) {
		allLanguagesPromise = new Promise((resolve) => {
			setImmediate(() => {
				void import("highlight.js/lib/index.js").then(
					() => resolve(),
					() => {
						// Eager languages and plaintext fallback remain available.
						resolve();
					},
				);
			});
		});
	}
	return allLanguagesPromise;
}

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter ? formatter(textBuffer) : textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name) !== undefined;
}

/**
 * 围栏语言名到 highlight.js 语言的补全表。highlight.js 自带大部分别名（py/ts/sh/yml…），
 * 这里只补它没有、但作者习惯写的那些。
 */
const languageAliases: Record<string, string> = {
	mts: "typescript",
	cts: "typescript",
	jsonc: "json",
	json5: "json",
	jsonl: "json",
	proto: "protobuf",
	postgres: "sql",
	postgresql: "sql",
	plpgsql: "sql",
	mysql: "sql",
	golang: "go",
	rs: "rust",
	kt: "kotlin",
	kts: "kotlin",
	cs: "csharp",
	"c#": "csharp",
	objc: "objectivec",
	"obj-c": "objectivec",
	"objective-c": "objectivec",
	asm: "x86asm",
	nasm: "x86asm",
	psm1: "powershell",
	conf: "ini",
	cfg: "ini",
	containerfile: "dockerfile",
	mk: "makefile",
	patch: "diff",
	hs: "haskell",
	ex: "elixir",
	exs: "elixir",
	erl: "erlang",
	clj: "clojure",
	ml: "ocaml",
	jl: "julia",
	vimscript: "vim",
};

/**
 * 纯文本围栏：不上色，但依然只做转义输出。`console` 在 highlight.js 里是
 * Shell Session（带提示符的命令会话），不属于这里。
 */
const plainLanguages = new Set(["text", "txt", "plain", "plaintext", "log", "ansi", "terminal"]);

/** 单块超过这个体量的代码不参与高亮：宁可无色，也不能让一次重排卡住整个会话。 */
const MAX_HIGHLIGHT_LENGTH = 120_000;

/**
 * 把围栏里的语言名解析成 highlight.js 认识的名字；不认识则返回 undefined。
 * 大小写不敏感；`{.python}` / `python title="x"` 这类写法由调用方先取首个 token。
 */
export function resolveHighlightLanguage(name: string): string | undefined {
	const lowered = name.trim().toLowerCase();
	if (lowered === "") return undefined;
	if (plainLanguages.has(lowered)) return "plaintext";
	if (hljs.getLanguage(lowered)) return lowered;
	const alias = languageAliases[lowered];
	return alias && hljs.getLanguage(alias) ? alias : undefined;
}

/** 该围栏是否只是纯文本——不需要上色，也不该按“代码”承诺语法。 */
export function isPlainHighlightLanguage(name: string): boolean {
	return plainLanguages.has(name.trim().toLowerCase());
}

/**
 * highlight.js 输出的是转义后的 HTML，可以安全地放进 <pre><code>；纯文本围栏只做转义。
 * 返回 undefined 表示“围栏语言不认识 / 内容过大不宜上色”，调用方自行转义输出。
 */
export function highlightCodeHtml(code: string, language: string): string | undefined {
	if (code.length > MAX_HIGHLIGHT_LENGTH) return undefined;
	const resolved = resolveHighlightLanguage(language);
	if (!resolved) return undefined;
	try {
		return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
	} catch {
		return undefined;
	}
}
