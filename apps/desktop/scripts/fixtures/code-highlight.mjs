import { renderAnswerMarkdown } from "../../src/components/answer-markdown-renderer.ts";
// 代码块容器（.owl-answer-code 的底色与边框）在这份样式里，和 MarkdownAnswer.tsx 的导入保持一致。
import "../../src/components/reply-reading.css";

/**
 * 代码块高亮的浏览器夹具：用真实渲染器 + 真实 index.css，在 Chromium 里量取实际颜色。
 * 覆盖：多语言（不只是 python）、未识别语言降级、主题/玻璃换色板。
 */
const samples = [
	["python", "def bubble_sort(arr):\n    n = len(arr)  # 注释\n    return arr"],
	["typescript", "interface User { id: number }\nconst u: User = { id: 1 };"],
	["go", "func Add(a, b int) int {\n\treturn a + b\n}"],
	["rust", "fn main() {\n    let x: i32 = 1;\n}"],
	["sql", "SELECT id, name FROM users WHERE id = 1;"],
	["json", '{"a": 1, "b": [true, null]}'],
	["yaml", "server:\n  port: 8080"],
	["bash", 'for f in *.txt; do echo "$f"; done'],
	["dockerfile", "FROM node:20 AS build\nRUN npm ci"],
	["diff", "-const a = 1;\n+const a = 2;"],
	["css", "a:hover { color: #fff }"],
	["java", "public class A { private int x = 1; }"],
	["cpp", "#include <vector>\ntemplate <class T>\nstruct Box { T value; };\n// 注释"],
	["csharp", "public class A { string s = \"x\"; }"],
	["swift", "struct A: Codable { let x: Int = 1 }"],
	["kotlin", "data class A(val x: Int)"],
	["markdown", "# 标题\n\n**粗体**"],
	["toml", 'title = "x"\n[server]\nport = 8080'],
	["xml", '<a href="/x">hi</a>'],
	["unknownlang", "x = 1 未识别语言"],
];

export function renderSamples(theme) {
	const root = document.getElementById("root");
	document.documentElement.dataset.owlTheme = theme;
	root.textContent = "";
	// 真实级联：代码块阅读色由 .owl-chat-surface 上的 --owl-reading-* 提供。
	const surface = document.createElement("div");
	surface.className = "owl-chat-surface";
	for (const [lang, code] of samples) {
		const wrapper = document.createElement("div");
		wrapper.className = "owl-answer owl-answer-reading";
		wrapper.dataset.lang = lang;
		// 渲染器输出的是自己构造的静态标记（转义过的代码），不是外部输入。
		wrapper.append(
			...new DOMParser()
				.parseFromString(renderAnswerMarkdown(`\`\`\`${lang}\n${code}\n\`\`\``), "text/html")
				.body.childNodes,
		);
		surface.append(wrapper);
	}
	root.append(surface);
}

export function setGlass(mode) {
	if (mode === "off") {
		delete document.documentElement.dataset.owlWallpaper;
		delete document.documentElement.dataset.owlGlassTheme;
		return;
	}
	document.documentElement.dataset.owlWallpaper = "on";
	document.documentElement.dataset.owlGlassTheme = mode;
}

window.renderSamples = renderSamples;
window.setGlass = setGlass;
renderSamples("dark");
