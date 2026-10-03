/**
 * 编辑器 tab：CodeMirror 6 可编辑视图（保存 / 语法高亮 / 外部变更横幅）。
 * 对应 dsh-better-sidebar 保留 catch-all viewer 的理由——只读预览不够用。
 * 语言包按需 import（Vite 静态打包，CodeMirror 各包 ~200KB gzip 内）。
 */
import { useEffect, useRef, useState } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { indentUnit, HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { TabComponentProps } from "../registry.ts";
import { IconLoader, IconRefresh, IconSave } from "../icons.tsx";

/** CodeMirror follows scoped workbench tokens without rebuilding the editor on theme changes. */
const owlTheme = EditorView.theme(
	{
		"&": { color: "var(--workbench-text, #e9e7e0)", backgroundColor: "transparent", height: "100%", fontSize: "13px" },
		".cm-scroller": { fontFamily: "Consolas, 'JetBrains Mono', 'Cascadia Code', monospace", lineHeight: "1.55" },
		".cm-content": { caretColor: "#2f9e5a", paddingBottom: "40px" },
		".cm-gutters": { backgroundColor: "transparent", color: "var(--workbench-muted, #8a867c)", border: "none" },
		".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.035)" },
		".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--workbench-text, #a6a399)" },
		"&.cm-focused": { outline: "none" },
		".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(47,158,90,0.28)" },
		".cm-cursor": { borderLeftColor: "#2f9e5a" },
	},
	{ dark: true },
);

const owlHighlight = HighlightStyle.define([
	{ tag: t.keyword, color: "var(--owl-code-keyword, #c792ea)" },
	{ tag: [t.string, t.special(t.string)], color: "var(--owl-code-string, #a5d6a7)" },
	{ tag: [t.number, t.bool, t.null], color: "var(--owl-code-number, #f78c6c)" },
	{ tag: [t.comment, t.lineComment, t.blockComment], color: "var(--owl-code-comment, #7a766b)", fontStyle: "italic" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--owl-code-function, #82aaff)" },
	{ tag: [t.typeName, t.className], color: "var(--owl-code-type, #ffcb6b)" },
	{ tag: [t.variableName, t.propertyName], color: "var(--workbench-text, #e9e7e0)" },
	{ tag: [t.operator, t.punctuation, t.separator], color: "var(--workbench-muted, #a6a399)" },
	{ tag: t.heading, color: "#2f9e5a", fontWeight: "bold" },
	{ tag: t.link, color: "var(--owl-code-function, #82aaff)" },
	{ tag: t.emphasis, fontStyle: "italic" },
	{ tag: t.strong, fontWeight: "bold" },
	{ tag: t.invalid, color: "var(--owl-code-invalid, #ff5370)" },
]);

/** 扩展名 → CodeMirror 语言包（未命中返回 undefined，纯文本渲染）。 */
function languageFor(path: string): LanguageSupport | undefined {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	switch (ext) {
		case "js":
		case "mjs":
		case "cjs":
			return javascript();
		case "jsx":
			return javascript({ jsx: true });
		case "ts":
		case "mts":
		case "cts":
			return javascript({ typescript: true });
		case "tsx":
			return javascript({ typescript: true, jsx: true });
		case "json":
			return json();
		case "md":
		case "markdown":
			return markdown();
		case "py":
			return python();
		case "html":
		case "htm":
			return html();
		case "css":
		case "scss":
		case "less":
			return css();
		case "yaml":
		case "yml":
			return yaml();
		case "sql":
			return sql();
		case "rs":
			return rust();
		case "go":
			return go();
		case "java":
			return java();
		case "c":
		case "h":
		case "cpp":
		case "hpp":
		case "cc":
			return cpp();
		case "xml":
		case "svg":
			return xml();
		default:
			return undefined;
	}
}

export function EditorTab({ api, store, cwd, tab }: TabComponentProps): React.JSX.Element {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const saveRef = useRef<(() => void) | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>(undefined);
	const [truncated, setTruncated] = useState(false);
	const [stale, setStale] = useState(false);
	const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
	const path = tab.path ?? "";

	// 挂载视图 + 首次载入文档（一个 effect 保证顺序：先有视图再 dispatch）。
	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		let cancelled = false;

		const save = (): void => {
			const view = viewRef.current;
			if (view === null) return;
			void (async () => {
				try {
					await api.fsWrite(cwd, path, view.state.doc.toString());
					store.setDirty(tab.id, false);
					setStale(false);
					setSavedAt(Date.now());
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			})();
		};
		saveRef.current = save;

		const extensions: Extension[] = [
			lineNumbers(),
			history(),
			drawSelection(),
			keymap.of([indentWithTab, { key: "Mod-s", run: () => (save(), true) }, ...defaultKeymap, ...historyKeymap]),
			indentUnit.of("    "),
			owlTheme,
			syntaxHighlighting(owlHighlight),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) store.setDirty(tab.id, true);
			}),
		];
		const language = languageFor(path);
		if (language !== undefined) extensions.push(language);
		const view = new EditorView({ state: EditorState.create({ doc: "", extensions }), parent: host });
		viewRef.current = view;

		setLoading(true);
		setError(undefined);
		setStale(false);
		void api
			.fsRead(cwd, path)
			.then((result) => {
				if (cancelled) return;
				setTruncated(result.truncated);
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result.content } });
				store.setDirty(tab.id, false);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
			saveRef.current = null;
			view.destroy();
			viewRef.current = null;
		};
		// 语言与文档都随 path 走；Workbench 按 tab.id key 挂载，切文件即重建
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd, path, api, store, tab.id]);

	// 从磁盘重新加载（refresh 按钮与"磁盘已更改"横幅共用）。
	const refresh = (): void => {
		const view = viewRef.current;
		if (view === null) return;
		setLoading(true);
		void api
			.fsRead(cwd, path)
			.then((result) => {
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result.content } });
				store.setDirty(tab.id, false);
				setTruncated(result.truncated);
				setStale(false);
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	};

	// 外部变更：所在目录有 fs_changed 事件时挂"磁盘已更改"横幅。
	useEffect(() => {
		const dir = path.split("/").slice(0, -1).join("/");
		return store.onFsChanged((dirs) => {
			if (dirs.includes(path) || dirs.includes(dir)) setStale(true);
		});
	}, [store, path]);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex items-center gap-1 border-b border-owl-border/40 px-2 py-1.5">
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-owl-faint" title={path}>
					{path}
					{stale && <span className="ml-2 text-amber-300">磁盘上已更改</span>}
				</span>
				{savedAt !== undefined && !stale && <span className="text-[11px] text-emerald-300/80">已保存</span>}
				{loading && <IconLoader size={13} className="animate-spin text-owl-faint" />}
				<button type="button" title="从磁盘重新加载" className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text" onClick={refresh}>
					<IconRefresh size={14} />
				</button>
				<button type="button" title="保存（Ctrl+S）" className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text" onClick={() => saveRef.current?.()}>
					<IconSave size={14} />
				</button>
			</div>
			{error !== undefined && (
				<div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{error}</div>
			)}
			{stale && (
				<button
					type="button"
					className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-left text-xs text-amber-200 hover:bg-amber-500/15"
					onClick={refresh}
				>
					文件在编辑器外被修改——点击重新加载磁盘版本（重新加载会丢弃未保存的修改）
				</button>
			)}
			{truncated && (
				<div className="border-b border-owl-border/40 bg-owl-panel px-3 py-1.5 text-xs text-amber-300">
					文件超过 1MB，只显示前 1MB；更大文件建议右键用 VS Code 打开
				</div>
			)}
			<div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2" />
		</div>
	);
}
