/**
 * VS Code 文件图标主题（iconTheme JSON）的纯解析：文件名 → iconDefinitions 里的图标 id。
 *
 * 匹配顺序同 VS Code：完整文件名 → 扩展名（多段扩展名优先，`a.spec.ts` 先试 `spec.ts` 再试 `ts`）
 * → 语言 id → 主题默认。浅色档先查 `light` 覆盖再查基础映射。
 * 语言 id 在 VS Code 里由各语言扩展声明，这里用 LANGUAGE_BY_* 补一张常用表。
 */

export interface IconDefinition {
	iconPath?: string;
	fontCharacter?: string;
	fontColor?: string;
}

interface IconAssociations {
	file?: string;
	folder?: string;
	folderExpanded?: string;
	fileExtensions?: Record<string, string>;
	fileNames?: Record<string, string>;
	languageIds?: Record<string, string>;
	folderNames?: Record<string, string>;
	folderNamesExpanded?: Record<string, string>;
}

export interface IconThemeManifest extends IconAssociations {
	iconDefinitions: Record<string, IconDefinition>;
	light?: IconAssociations;
}

export type IconKind = "file" | "folder" | "folderExpanded";

const LANGUAGE_BY_FILENAME: Record<string, string> = {
	dockerfile: "dockerfile",
	containerfile: "dockerfile",
	makefile: "makefile",
	gnumakefile: "makefile",
	"docker-compose.yml": "dockercompose",
	"docker-compose.yaml": "dockercompose",
	"compose.yml": "dockercompose",
	"compose.yaml": "dockercompose",
	jenkinsfile: "groovy",
	gemfile: "ruby",
	rakefile: "ruby",
	".bashrc": "shellscript",
	".zshrc": "shellscript",
	".profile": "shellscript",
	".editorconfig": "properties",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	ts: "typescript",
	cts: "typescript",
	mts: "typescript",
	tsx: "typescriptreact",
	js: "javascript",
	cjs: "javascript",
	mjs: "javascript",
	jsx: "javascriptreact",
	json: "json",
	webmanifest: "json",
	jsonc: "jsonc",
	jsonl: "jsonl",
	css: "css",
	scss: "scss",
	less: "less",
	sass: "sass",
	html: "html",
	htm: "html",
	xhtml: "html",
	md: "markdown",
	markdown: "markdown",
	mdx: "mdx",
	py: "python",
	pyw: "python",
	pyi: "python",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	ino: "cpp",
	cs: "csharp",
	csx: "csharp",
	php: "php",
	rb: "ruby",
	gemspec: "ruby",
	sh: "shellscript",
	bash: "shellscript",
	zsh: "shellscript",
	ksh: "shellscript",
	ps1: "powershell",
	psm1: "powershell",
	psd1: "powershell",
	bat: "bat",
	cmd: "bat",
	yml: "yaml",
	yaml: "yaml",
	xml: "xml",
	xsd: "xml",
	xsl: "xml",
	xslt: "xml",
	xaml: "xml",
	csproj: "xml",
	plist: "xml",
	sql: "sql",
	swift: "swift",
	lua: "lua",
	pl: "perl",
	pm: "perl",
	r: "r",
	dart: "dart",
	dockerfile: "dockerfile",
	mk: "makefile",
	gitignore: "ignore",
	ini: "ini",
	properties: "properties",
	cfg: "properties",
	conf: "properties",
	coffee: "coffeescript",
	clj: "clojure",
	cljs: "clojure",
	cljc: "clojure",
	fs: "fsharp",
	fsi: "fsharp",
	fsx: "fsharp",
	groovy: "groovy",
	hbs: "handlebars",
	handlebars: "handlebars",
	jl: "julia",
	tex: "latex",
	sty: "tex",
	m: "objective-c",
	mm: "objective-cpp",
	vue: "vue",
	kt: "kotlin",
	kts: "kotlin",
	diff: "diff",
	patch: "diff",
	log: "log",
	txt: "plaintext",
	toml: "toml",
	cshtml: "razor",
	razor: "razor",
};

/** 文件名的语言 id（先按完整文件名，再按最后一段扩展名）。 */
export function languageIdOf(fileName: string): string | undefined {
	const lower = fileName.toLowerCase();
	const byName = LANGUAGE_BY_FILENAME[lower];
	if (byName !== undefined) return byName;
	const dot = lower.lastIndexOf(".");
	return dot < 0 ? undefined : LANGUAGE_BY_EXTENSION[lower.slice(dot + 1)];
}

function lookup(
	layers: readonly IconAssociations[],
	pick: (layer: IconAssociations) => Record<string, string> | undefined,
	key: string,
): string | undefined {
	for (const layer of layers) {
		const id = pick(layer)?.[key];
		if (id !== undefined) return id;
	}
	return undefined;
}

/** 解析出图标 id；主题没有对应默认图标（如 Seti 不带文件夹图标）时返回 undefined。 */
export function resolveIconId(
	theme: IconThemeManifest,
	name: string,
	kind: IconKind,
	light: boolean,
): string | undefined {
	const layers: IconAssociations[] = light && theme.light !== undefined ? [theme.light, theme] : [theme];
	const lower = name.toLowerCase();
	if (kind !== "file") {
		const names =
			kind === "folder"
				? (layer: IconAssociations) => layer.folderNames
				: (layer: IconAssociations) => layer.folderNamesExpanded;
		return lookup(layers, names, lower) ?? layers.map((layer) => layer[kind]).find((id) => id !== undefined);
	}
	const byName = lookup(layers, (layer) => layer.fileNames, lower);
	if (byName !== undefined) return byName;
	for (let dot = lower.indexOf("."); dot >= 0; dot = lower.indexOf(".", dot + 1)) {
		const byExtension = lookup(layers, (layer) => layer.fileExtensions, lower.slice(dot + 1));
		if (byExtension !== undefined) return byExtension;
	}
	const language = languageIdOf(lower);
	const byLanguage = language === undefined ? undefined : lookup(layers, (layer) => layer.languageIds, language);
	return byLanguage ?? layers.map((layer) => layer.file).find((id) => id !== undefined);
}

/** Seti 的 fontCharacter 是 CSS 转义写法（`\E001`），转成实际字符。 */
export function fontGlyph(fontCharacter: string): string {
	return String.fromCodePoint(Number.parseInt(fontCharacter.replace(/^\\/, ""), 16));
}

/** Material 的 iconPath 形如 `./../icons/git.svg`，只取文件名。 */
export function iconFileName(iconPath: string): string {
	return iconPath.slice(iconPath.lastIndexOf("/") + 1);
}
