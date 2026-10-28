/**
 * 编辑器 tab：CodeMirror 6 可编辑视图（保存 / 语法高亮 / 外部变更横幅）。
 * 对应 dsh-better-sidebar 保留 catch-all viewer 的理由——只读预览不够用。
 * 语言包按需 import（Vite 静态打包，CodeMirror 各包 ~200KB gzip 内）。
 *
 * 待审改动装饰：对话流改动卡点文件名（pending 条目）时经 editor-diff-focus
 * 总线携带语境进来，编辑器拉取该文件的 diffApproval diff，按新文件坐标系
 * 高亮新增行、内联展示删除块，并滚动到第一个改动块（VS Code inline diff
 * 同款意图：保留"整文件上下文"，同时第一眼看到改动本身）。
 */

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
import { HighlightStyle, indentUnit, type LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import {
	Compartment,
	EditorState,
	type Extension,
	type Range,
	StateEffect,
	StateField,
	type Text,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	drawSelection,
	EditorView,
	keymap,
	lineNumbers,
	WidgetType,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../../i18n/index.ts";
import { fileUrlOf, samePath } from "../api.ts";
import { EditorController } from "../editor-controller.ts";
import { useEditorText } from "../editor-copy.ts";
import { editorsTransitionLocked, subscribeEditorTransition } from "../editor-exit-guard.ts";
import { applyEditorTextChanges, editorDisplayText } from "../editor-text.ts";
import "./editor-safety.css";
import { type EditorDiffMarks, editorDiffMarks } from "../editor-diff.ts";
import { consumeEditorDiffFocus, EDITOR_DIFF_FOCUS_EVENT, peekEditorDiffFocus } from "../editor-diff-focus.ts";
import { consumeEditorLineFocus, EDITOR_LINE_FOCUS_EVENT, peekEditorLineFocus } from "../editor-line-focus.ts";
import { formatFileRef } from "../file-ref.ts";
import { reportEditorFocus } from "../focus-state.ts";
import { IconCopy, IconLoader, IconRefresh, IconSave } from "../icons.tsx";
import type { TabComponentProps } from "../registry.ts";
import { observeWorkbenchTheme, resolveSurfaceTheme } from "../theme-observer.ts";
import { MARKDOWN_PATH, MarkdownPreview } from "./MarkdownPreview.tsx";

/** CodeMirror follows scoped workbench tokens without rebuilding the editor on theme changes. */
const owlTheme = EditorView.theme({
	"&": { color: "var(--workbench-text, #e9e7e0)", backgroundColor: "transparent", height: "100%", fontSize: "13px" },
	".cm-scroller": { fontFamily: "Consolas, 'JetBrains Mono', 'Cascadia Code', monospace", lineHeight: "1.55" },
	".cm-content": { caretColor: "var(--color-owl-accent)", paddingBottom: "40px" },
	".cm-gutters": { backgroundColor: "transparent", color: "var(--workbench-muted, #8a867c)", border: "none" },
	".cm-activeLine": { backgroundColor: "var(--workbench-hover)" },
	".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--workbench-text, #a6a399)" },
	"&.cm-focused": { outline: "none" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
		backgroundColor: "color-mix(in srgb, var(--color-owl-accent) 28%, transparent)",
	},
	".cm-cursor": { borderLeftColor: "var(--color-owl-accent)" },
	// diff 装饰（改动卡点文件名进来的待审改动高亮）：配色与 DiffView 同源
	// （emerald/red-500 调，10% 上下），左缘条用 inset box-shadow 避免行宽抖动
	".cm-owl-diff-add": { backgroundColor: "rgba(16,185,129,0.12)", boxShadow: "inset 2px 0 0 rgba(16,185,129,0.55)" },
	".cm-owl-diff-del": {
		backgroundColor: "rgba(239,68,68,0.08)",
		boxShadow: "inset 2px 0 0 rgba(239,68,68,0.5)",
		cursor: "default",
	},
	".cm-owl-diff-del > div": { whiteSpace: "pre", color: "var(--workbench-muted, #8a867c)" },
	// 模型指行（sidebar_show file:line）：定位行的高亮，闪一下就静下来。
	".cm-owl-focus-line": {
		backgroundColor: "color-mix(in srgb, var(--color-owl-accent) 14%, transparent)",
		boxShadow: "inset 2px 0 0 var(--color-owl-accent)",
		animation: "owl-focus-flash 1.8s ease-out 1",
	},
});

const owlHighlight = HighlightStyle.define([
	{ tag: t.keyword, color: "var(--owl-code-keyword, #c792ea)" },
	{ tag: [t.string, t.special(t.string)], color: "var(--owl-code-string, #a5d6a7)" },
	{ tag: [t.number, t.bool, t.null], color: "var(--owl-code-number, #f78c6c)" },
	{ tag: [t.comment, t.lineComment, t.blockComment], color: "var(--owl-code-comment, #7a766b)", fontStyle: "italic" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--owl-code-function, #82aaff)" },
	{ tag: [t.typeName, t.className], color: "var(--owl-code-type, #ffcb6b)" },
	{ tag: [t.variableName, t.propertyName], color: "var(--workbench-text, #e9e7e0)" },
	{ tag: [t.operator, t.punctuation, t.separator], color: "var(--workbench-muted, #a6a399)" },
	{ tag: t.heading, color: "var(--color-owl-accent)", fontWeight: "bold" },
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

type MarkdownMode = "edit" | "split" | "preview";
const MARKDOWN_MODES: readonly MarkdownMode[] = ["edit", "split", "preview"];
const MARKDOWN_MODE_KEY = "owl.editor.markdownMode";
/** 预览随输入重渲染整篇 Markdown，按键间隔内合并。 */
const MARKDOWN_PREVIEW_DEBOUNCE_MS = 150;

function readMarkdownMode(): MarkdownMode {
	try {
		const saved = localStorage.getItem(MARKDOWN_MODE_KEY);
		return MARKDOWN_MODES.includes(saved as MarkdownMode) ? (saved as MarkdownMode) : "edit";
	} catch {
		return "edit";
	}
}

// -- 待审改动装饰（改动卡点文件名 → focusEditorDiff → 这里消费）--------------

/** 置入/清除 diff 标记：undefined = 清除（条目被保留/回滚后重校验会走到）。 */
const setEditorDiff = StateEffect.define<EditorDiffMarks | undefined>();

/** 删除行内联块（VS Code inline diff 同款）：基线里有、新文件里没有的行，
 * 以红底块插在删除发生位置之前；不可编辑，事件放行给编辑器。 */
class DeletedLinesWidget extends WidgetType {
	readonly lines: readonly string[];

	constructor(lines: readonly string[]) {
		super();
		this.lines = lines;
	}

	override eq(other: DeletedLinesWidget): boolean {
		return (
			other === this ||
			(other.lines.length === this.lines.length && other.lines.every((line, index) => line === this.lines[index]))
		);
	}

	override toDOM(): HTMLElement {
		const wrap = document.createElement("div");
		wrap.className = "cm-owl-diff-del";
		for (const line of this.lines) {
			const row = document.createElement("div");
			row.textContent = line === "" ? "−" : `− ${line}`;
			wrap.appendChild(row);
		}
		return wrap;
	}

	override ignoreEvent(): boolean {
		return false;
	}
}

/** 标记 → 装饰集：行号按 1 基钳到当前文档（文件与 diff 之间可能已有出入），
 * EOF 之后的删除块锚到文档末尾。Decoration.set(sort) 统一排序混排的行/块装饰。 */
function buildDiffDecorations(marks: EditorDiffMarks | undefined, doc: Text): DecorationSet {
	if (marks === undefined || marks.hunks.length === 0) return Decoration.none;
	const ranges: Array<Range<Decoration>> = [];
	for (const hunk of marks.hunks) {
		for (const line of hunk.addLines) {
			if (line >= 1 && line <= doc.lines)
				ranges.push(Decoration.line({ class: "cm-owl-diff-add" }).range(doc.line(line).from));
		}
		for (const group of hunk.dels) {
			const inside = group.atLine >= 1 && group.atLine <= doc.lines;
			const deco = Decoration.widget({
				widget: new DeletedLinesWidget(group.lines),
				block: true,
				side: inside ? -1 : 1,
			});
			ranges.push(deco.range(inside ? doc.line(group.atLine).from : doc.length));
		}
	}
	return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
}

const editorDiffField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		let next = tr.docChanged ? value.map(tr.changes) : value;
		for (const effect of tr.effects) {
			if (effect.is(setEditorDiff)) next = buildDiffDecorations(effect.value, tr.state.doc);
		}
		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

// -- 模型指行的高亮（sidebar_show file:line → focusEditorLine）---------------

/** 置入/清除定位高亮：{ start, end } 是 1 起的行号区间，undefined = 清除。 */
const setEditorLineFocus = StateEffect.define<{ start: number; end: number } | undefined>();

/** 行号按 1 基钳到当前文档（模型给的行可能已经过期）。 */
function buildLineFocusDecorations(focus: { start: number; end: number } | undefined, doc: Text): DecorationSet {
	if (focus === undefined) return Decoration.none;
	const start = Math.min(Math.max(1, focus.start), doc.lines);
	const end = Math.min(Math.max(start, focus.end), doc.lines);
	const ranges: Array<Range<Decoration>> = [];
	for (let line = start; line <= end; line += 1) {
		ranges.push(Decoration.line({ class: "cm-owl-focus-line" }).range(doc.line(line).from));
	}
	return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
}

const editorLineFocusField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		let next = tr.docChanged ? value.map(tr.changes) : value;
		for (const effect of tr.effects) {
			if (effect.is(setEditorLineFocus)) next = buildLineFocusDecorations(effect.value, tr.state.doc);
		}
		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

export function EditorTab({
	api,
	client,
	store,
	cwd,
	profile,
	tab,
	onOpenFile,
	onToChat,
}: TabComponentProps): React.JSX.Element {
	const t = useT();
	const copy = useEditorText();
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const path = tab.path ?? "";
	const controller = useMemo(() => {
		let storage: Storage | undefined;
		try {
			storage = localStorage;
		} catch {
			/* The controller reports missing local protection on edit. */
		}
		return new EditorController(api, cwd, path, profile ?? "", storage);
	}, [api, client, cwd, path, profile]);
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	const transitionLocked = useSyncExternalStore(subscribeEditorTransition, editorsTransitionLocked);
	const loading = state.loading;
	const stale = state.stale;
	const truncated = state.disk?.truncated ?? false;
	const savedAt = state.savedAt;
	const [actionError, setActionError] = useState<string>();
	const error = state.error ?? actionError;
	const [newPath, setNewPath] = useState("");
	// 另存新文件：低频操作，收在工具条按钮后面，不在内容上方常驻一条横栏。
	const [saveAsOpen, setSaveAsOpen] = useState(false);
	const [removeRecovery, setRemoveRecovery] = useState<string>();
	const activeController = useRef(controller);
	activeController.current = controller;
	const isMarkdown = MARKDOWN_PATH.test(path);
	const [markdownMode, setMarkdownMode] = useState<MarkdownMode>(readMarkdownMode);
	const [previewText, setPreviewText] = useState("");
	const mode: MarkdownMode = isMarkdown ? markdownMode : "edit";
	const changeMarkdownMode = (next: MarkdownMode): void => {
		setMarkdownMode(next);
		try {
			localStorage.setItem(MARKDOWN_MODE_KEY, next);
		} catch {
			// 存储不可用时只在本次会话生效
		}
	};
	// diff 装饰状态：marks 是最近一次算出的标记；docReady 表示文档已载入
	// （标记必须在真实文档上构建，空文档时先行到达的标记挂起等载入）；
	// focusSeen 表示本 tab 消费过一次聚焦（此后 refresh/推送都按活口径重校验）；
	// scrolled 保证一次聚焦只自动滚一次；diffSeq 防“改 A 后马上改 B”的乱序覆盖。
	const marksRef = useRef<EditorDiffMarks | undefined>(undefined);
	const docReadyRef = useRef(false);
	const focusSeenRef = useRef(false);
	const scrolledRef = useRef(false);
	const diffSeqRef = useRef(0);
	// 模型指行：lineFocusRef 记着待定位的行（文档没载入时先挂着），timer 负责撤掉高亮。
	const lineFocusRef = useRef<{ line?: number; endLine?: number } | undefined>(undefined);
	const lineFocusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// 当前选区（行号 + 内容）：有选中时头部出现「问 Owl」。
	const [selection, setSelection] = useState<{ line: number; endLine: number; text: string } | undefined>(undefined);
	const selectionRef = useRef<{ line: number; endLine: number; text: string } | undefined>(undefined);

	/** 把选中的这段交给对话：引用（路径:行号）+ 选中内容，模型能直接对着看。 */
	const askOwl = (): void => {
		const current = selectionRef.current;
		if (current === undefined || onToChat === undefined) return;
		const ref = formatFileRef({
			path,
			line: current.line,
			...(current.endLine !== current.line ? { endLine: current.endLine } : {}),
		});
		onToChat(`${copy("askOwlPrompt")}\n\n\`${ref}\`\n${current.text}`);
	};

	/** 把当前标记放进编辑器；scroll=true 且未滚过时滚到第一个改动块（居中）。 */
	const applyDiffMarks = (scroll: boolean): void => {
		const view = viewRef.current;
		const marks = marksRef.current;
		if (view === null || !docReadyRef.current) return;
		const effects: Array<StateEffect<unknown>> = [setEditorDiff.of(marks)];
		if (
			scroll &&
			!scrolledRef.current &&
			marks?.firstLine !== undefined &&
			marks.firstLine >= 1 &&
			marks.firstLine <= view.state.doc.lines
		) {
			effects.push(EditorView.scrollIntoView(view.state.doc.line(marks.firstLine).from, { y: "center" }));
			scrolledRef.current = true;
		}
		view.dispatch({ effects });
	};

	/** 定位到模型指定的行并闪一下；文档还没载入时先记着，载入后补上。 */
	const applyLineFocus = (): void => {
		const view = viewRef.current;
		const focus = lineFocusRef.current;
		if (view === null || !docReadyRef.current || focus === undefined) return;
		const lines = view.state.doc.lines;
		const start = Math.min(Math.max(1, focus.line ?? 1), lines);
		const end = Math.min(Math.max(start, focus.endLine ?? start), lines);
		view.dispatch({
			effects: [
				setEditorLineFocus.of({ start, end }),
				EditorView.scrollIntoView(view.state.doc.line(start).from, { y: "center" }),
			],
		});
		if (lineFocusTimer.current !== undefined) clearTimeout(lineFocusTimer.current);
		lineFocusTimer.current = setTimeout(() => {
			lineFocusTimer.current = undefined;
			// 视图可能已经卸载（切走/关掉 tab）：只给还活着的视图撤高亮。
			if (viewRef.current === view) view.dispatch({ effects: setEditorLineFocus.of(undefined) });
		}, 2500);
	};

	/** 拉取本文件的待审 diff 并换成标记（无 pending 条目/已处理 → 清除装饰）。 */
	const loadDiffMarks = (scroll: boolean): void => {
		const version = ++diffSeqRef.current;
		void api
			.diffApprovalList(cwd)
			.then((list) => {
				if (version !== diffSeqRef.current) return undefined;
				const entry = list.find((item) => item.status === "pending" && samePath(item.displayPath, path));
				return entry === undefined ? undefined : api.diffApprovalDiff(cwd, entry.id);
			})
			.then((result) => {
				if (version !== diffSeqRef.current) return;
				marksRef.current = result === undefined ? undefined : editorDiffMarks(result.diff);
				if (result !== undefined) scrolledRef.current = false;
				applyDiffMarks(scroll);
			})
			.catch(() => {
				// 条目已处理（基线已释放）或桥不可达：静默不装饰
				if (version !== diffSeqRef.current) return;
				marksRef.current = undefined;
				applyDiffMarks(scroll);
			});
	};

	// 挂载时消费聚焦 + 事件驱动 + 待审清单变化重校验。peek 先行：工作台里
	// 挂载着多个 EditorTab 实例，路径匹配的才取走，避免盲吞别人的聚焦。
	useEffect(() => {
		marksRef.current = undefined;
		focusSeenRef.current = false;
		scrolledRef.current = false;
		const consume = (): void => {
			const focus = peekEditorDiffFocus();
			if (focus === undefined || !samePath(focus, path)) return;
			consumeEditorDiffFocus();
			focusSeenRef.current = true;
			loadDiffMarks(true);
		};
		consume();
		window.addEventListener(EDITOR_DIFF_FOCUS_EVENT, consume);
		const offChanged = client.onDiffApprovalChanged((message) => {
			if (focusSeenRef.current && samePath(message.cwd, cwd)) loadDiffMarks(false);
		});
		return () => {
			++diffSeqRef.current;
			window.removeEventListener(EDITOR_DIFF_FOCUS_EVENT, consume);
			offChanged();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd, client, path, api, profile]);

	// 挂载视图 + 首次载入文档（一个 effect 保证顺序：先有视图再 dispatch）。
	// 模型指行（sidebar_show file:line）：消费定位请求 → 记下 → 文档就绪后落地。
	// peek 先行：工作台里挂着多个 EditorTab 实例，路径匹配的才取走，避免盲吞请求。
	useEffect(() => {
		const consume = (): void => {
			const focus = peekEditorLineFocus();
			if (focus === undefined || !samePath(focus.path, path)) return;
			consumeEditorLineFocus();
			// 过期请求（超过一分钟）直接丢掉：别让半年前的定位在文件再打开时突然跳行。
			if (Date.now() - focus.at > 60_000) return;
			lineFocusRef.current = {
				...(focus.line !== undefined ? { line: focus.line } : {}),
				...(focus.endLine !== undefined ? { endLine: focus.endLine } : {}),
			};
			applyLineFocus();
		};
		consume();
		window.addEventListener(EDITOR_LINE_FOCUS_EVENT, consume);
		return () => window.removeEventListener(EDITOR_LINE_FOCUS_EVENT, consume);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [path]);

	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		let cancelled = false;
		let applying = false;
		let previewTimer: ReturnType<typeof setTimeout> | undefined;
		setPreviewText("");

		controller.activate();
		setActionError(undefined);
		setNewPath("");
		const save = (): void => {
			void controller.save();
		};
		const themeMode = new Compartment();
		const editability = new Compartment();
		let dark = resolveSurfaceTheme(document.documentElement.dataset) === "dark";

		const extensions: Extension[] = [
			lineNumbers(),
			history(),
			drawSelection(),
			keymap.of([indentWithTab, { key: "Mod-s", run: () => (save(), true) }, ...defaultKeymap, ...historyKeymap]),
			indentUnit.of("    "),
			owlTheme,
			themeMode.of(EditorView.darkTheme.of(dark)),
			syntaxHighlighting(owlHighlight),
			editorDiffField,
			editorLineFocusField,
			EditorView.contentAttributes.of({ "aria-label": path }),
			editability.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
			EditorView.updateListener.of((update) => {
				// 选区跟踪：「问 Owl」要用（选中行号 + 选中内容）。
				if (update.selectionSet || update.docChanged) {
					const main = update.state.selection.main;
					// 光标位置报给焦点总线：模型问「用户在看哪一行」时用。
					reportEditorFocus({ path, line: update.state.doc.lineAt(main.head).number });
					const next = main.empty
						? undefined
						: {
								line: update.state.doc.lineAt(main.from).number,
								endLine: update.state.doc.lineAt(main.to).number,
								text: update.state.sliceDoc(main.from, main.to),
							};
					const previous = selectionRef.current;
					const changed =
						previous === undefined || next === undefined
							? previous !== next
							: previous.line !== next.line || previous.endLine !== next.endLine || previous.text !== next.text;
					if (changed) {
						selectionRef.current = next;
						setSelection(next);
					}
				}
				if (!update.docChanged || applying) return;
				let content = controller.getSnapshot().text;
				for (const transaction of update.transactions)
					if (transaction.docChanged) {
						const changes: Array<{ from: number; to: number; insert: string }> = [];
						transaction.changes.iterChanges((from, to, _fromB, _toB, insert) =>
							changes.push({ from, to, insert: insert.toString() }),
						);
						content = applyEditorTextChanges(content, changes);
					}
				controller.change(content);
				if (!isMarkdown) return;
				if (previewTimer !== undefined) clearTimeout(previewTimer);
				previewTimer = setTimeout(() => {
					previewTimer = undefined;
					if (!cancelled) setPreviewText(update.state.doc.toString());
				}, MARKDOWN_PREVIEW_DEBOUNCE_MS);
			}),
		];
		const language = languageFor(path);
		if (language !== undefined) extensions.push(language);
		const view = new EditorView({ state: EditorState.create({ doc: "", extensions }), parent: host });
		viewRef.current = view;
		const offTheme = observeWorkbenchTheme(host, () => {
			const next = resolveSurfaceTheme(document.documentElement.dataset) === "dark";
			if (dark === next) return;
			dark = next;
			view.dispatch({ effects: themeMode.reconfigure(EditorView.darkTheme.of(next)) });
		});

		let writable = false;
		const sync = (): void => {
			if (cancelled) return;
			const snapshot = controller.getSnapshot();
			const doc = editorDisplayText(snapshot.text);
			applying = true;
			try {
				if (view.state.doc.toString() !== doc) {
					view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
					setPreviewText(doc);
				}
				const nextWritable = snapshot.ready && snapshot.editable && !snapshot.loading && !editorsTransitionLocked();
				if (nextWritable !== writable) {
					writable = nextWritable;
					view.dispatch({
						effects: editability.reconfigure([
							EditorState.readOnly.of(!writable),
							EditorView.editable.of(writable),
						]),
					});
				}
			} finally {
				applying = false;
			}
			store.setDirty(tab.id, snapshot.dirty);
			if (!docReadyRef.current && snapshot.ready) {
				docReadyRef.current = true;
				applyDiffMarks(true);
				applyLineFocus();
			}
			if (isMarkdown && !snapshot.dirty) setPreviewText(doc);
		};
		const offController = controller.subscribe(sync);
		const offTransition = subscribeEditorTransition(sync);
		const offGuard = store.registerEditor(tab.id, {
			isDirty: controller.isDirty,
			revision: controller.revision,
			isProtected: controller.isProtected,
			save: () => controller.save(),
			preserveDraft: () => controller.preserveDraft(),
			discard: () => controller.discard(),
		});
		const offStatus = client.onStatus((connected) => {
			const snapshot = controller.getSnapshot();
			if (connected && (!snapshot.ready || (snapshot.dirty && !snapshot.disk))) void controller.load();
		});
		sync();
		void controller.load();

		return () => {
			cancelled = true;
			controller.dispose();
			if (previewTimer !== undefined) clearTimeout(previewTimer);
			if (lineFocusTimer.current !== undefined) {
				clearTimeout(lineFocusTimer.current);
				lineFocusTimer.current = undefined;
			}
			offStatus();
			offTheme();
			offController();
			offTransition();
			offGuard();
			docReadyRef.current = false;
			view.destroy();
			viewRef.current = null;
		};
		// 语言与文档都随 path 走；Workbench 按 tab.id key 挂载，切文件即重建
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd, path, api, client, store, tab.id, controller]);

	// 从磁盘重新加载（refresh 按钮与"磁盘已更改"横幅共用）。整篇替换会把
	// 装饰坍缩到文档头，落库后按标记重放；消费过聚焦的 tab 顺带按活口径
	// 重取 diff（条目可能已被保留/回滚）。
	const refresh = (): void => {
		void controller.reload().then((changed) => {
			if (changed && activeController.current === controller) {
				if (focusSeenRef.current) loadDiffMarks(false);
				else applyDiffMarks(false);
			}
		});
	};
	useEffect(() => {
		if (!state.dirty || !state.ready) return;
		const timer = setTimeout(() => void controller.preserveDraft(), 500);
		return () => clearTimeout(timer);
	}, [controller, state.version, state.dirty, state.ready]);

	// 外部变更：所在目录有 fs_changed 事件时挂"磁盘已更改"横幅。
	useEffect(() => {
		const dir = path.split("/").slice(0, -1).join("/");
		return store.onFsChanged((dirs) => {
			if (dirs.includes(path) || dirs.includes(dir)) controller.markStale();
		});
	}, [store, path, controller]);

	// 编辑器从 display:none 恢复可见时重新量尺寸（行号槽宽、视口行）
	useEffect(() => {
		if (mode !== "preview") viewRef.current?.requestMeasure();
	}, [mode]);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			<div className="flex shrink-0 items-center gap-1 border-b border-owl-border/40 px-2 py-1.5">
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-owl-faint" title={path}>
					{path}
					{stale && <span className="ml-2 text-amber-300">{t("editor.stale")}</span>}
				</span>
				{state.dirty ? (
					<span className="text-[11px] text-owl-warning">{copy("dirty")}</span>
				) : (
					savedAt !== undefined && !stale && <span className="text-[11px] text-owl-success">{copy("saved")}</span>
				)}
				{selection !== undefined && onToChat !== undefined && (
					<button type="button" className="owl-editor-ask" title={copy("askOwl")} onClick={askOwl}>
						✦ {copy("askOwl")}
					</button>
				)}
				{loading && <IconLoader size={13} className="animate-spin text-owl-faint" />}
				{isMarkdown && (
					<div
						role="group"
						aria-label={t("editor.mdModeLabel")}
						className="flex items-center rounded-md border border-owl-border/40 p-0.5"
					>
						{MARKDOWN_MODES.map((item) => (
							<button
								key={item}
								type="button"
								aria-pressed={mode === item}
								className={`rounded px-1.5 py-0.5 text-[11px] ${mode === item ? "bg-owl-hover text-owl-text" : "text-owl-muted hover:text-owl-text"}`}
								onClick={() => changeMarkdownMode(item)}
							>
								{t(
									item === "edit" ? "editor.mdEdit" : item === "split" ? "editor.mdSplit" : "editor.mdPreview",
								)}
							</button>
						))}
					</div>
				)}
				<button
					type="button"
					disabled={transitionLocked || loading || state.saving}
					title={copy("refresh")}
					className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text disabled:opacity-40"
					onClick={refresh}
				>
					<IconRefresh size={14} />
				</button>
				<button
					type="button"
					disabled={
						!state.ready ||
						!state.editable ||
						!state.dirty ||
						loading ||
						state.saving ||
						stale ||
						Boolean(state.conflict)
					}
					title={state.saving ? copy("saving") : t("editor.saveTitle")}
					className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text disabled:opacity-40"
					onClick={() => void controller.save()}
				>
					<IconSave size={14} />
				</button>
				<button
					type="button"
					disabled={!state.ready || transitionLocked}
					aria-pressed={saveAsOpen}
					title={copy("saveAs")}
					className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text disabled:opacity-40"
					onClick={() => setSaveAsOpen((open) => !open)}
				>
					<IconCopy size={14} />
				</button>
			</div>
			<div className="owl-editor-safety-scroll">
				{transitionLocked && (
					<div className="owl-editor-safety-status" role="status">
						{copy("accountLocked")}
					</div>
				)}
				{state.dirty && (
					<div className="owl-editor-safety-status" role="status">
						<p>
							{state.draftStatus === "pending"
								? copy("draftPending")
								: state.draftStatus === "saved"
									? copy(state.serverSavedVersion === state.version ? "draftSaved" : "draftOlder")
									: copy("protectedNone")}
						</p>
						{state.walStatus === "saved" && <p>{copy("walSaved")}</p>}
						<button
							type="button"
							disabled={state.draftStatus === "pending"}
							onClick={() => void controller.preserveDraft()}
						>
							{copy(state.draftStatus === "error" ? "retryDraft" : "keep")}
						</button>
					</div>
				)}
				{(state.draftError || state.walError) && (
					<div className="owl-editor-safety-error" role="alert">
						{state.draftError && <p>{state.draftError}</p>}
						{state.walError && (
							<p>
								{copy("walError")}: {state.walError}
							</p>
						)}
					</div>
				)}
				{state.recovery || state.localRecoveries?.length ? (
					<details className="owl-editor-safety-recovery" open>
						<summary>{copy("restoreNote")}</summary>
						{state.recovery && (
							<div>
								<p>{new Date(state.recovery.updatedAt).toLocaleString()}</p>
								<pre>{state.recovery.content}</pre>
								<button
									type="button"
									disabled={transitionLocked || loading || state.saving}
									onClick={() => controller.restore("server")}
								>
									{copy("recoverServer")}
								</button>
							</div>
						)}
						{state.localRecoveries?.map((draft) => (
							<div key={draft.walKey}>
								<p>{new Date(draft.updatedAt).toLocaleString()}</p>
								<pre>{draft.content}</pre>
								<button
									type="button"
									disabled={transitionLocked || loading || state.saving}
									onClick={() => controller.restore("local", draft.walKey)}
								>
									{copy("recoverLocal")}
								</button>
								{removeRecovery === draft.walKey ? (
									<>
										<button
											type="button"
											disabled={transitionLocked || loading || state.saving}
											onClick={() => {
												if (draft.walKey && controller.removeLocalRecovery(draft.walKey))
													setRemoveRecovery(undefined);
											}}
										>
											{copy("confirmRemoveRecovery")}
										</button>
										<button type="button" onClick={() => setRemoveRecovery(undefined)}>
											{copy("cancelRemoveRecovery")}
										</button>
									</>
								) : (
									<button
										type="button"
										disabled={transitionLocked || loading || state.saving || !draft.token || !draft.editorId}
										onClick={() => setRemoveRecovery(draft.walKey)}
									>
										{copy("removeRecovery")}
									</button>
								)}
							</div>
						))}
					</details>
				) : null}
				{error !== undefined && (
					<div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{error}</div>
				)}
				{stale && (
					<button
						type="button"
						disabled={transitionLocked}
						className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-left text-xs text-amber-200 hover:bg-amber-500/15"
						onClick={refresh}
					>
						{t("editor.staleBanner")}
					</button>
				)}
				{truncated && (
					<div className="border-b border-owl-border/40 bg-owl-panel px-3 py-1.5 text-xs text-amber-300">
						{t("editor.tooLarge")}
					</div>
				)}
				{state.ready && !state.editable && (
					<div className="owl-editor-safety-status" role="status">
						{copy("readonly")}
						{state.disk?.readOnlyReason && <p>{state.disk.readOnlyReason}</p>}
						<button
							type="button"
							onClick={() => {
								void api.openExternal("url", fileUrlOf(cwd, path)).catch((reason: unknown) => {
									if (activeController.current === controller)
										setActionError(reason instanceof Error ? reason.message : String(reason));
								});
							}}
						>
							{copy("external")}
						</button>
					</div>
				)}
				{state.conflict && (
					<details className="owl-editor-safety-conflict" open>
						<summary>{copy("conflict")}</summary>
						<div className="owl-editor-compare">
							<section>
								<strong>{copy("mine")}</strong>
								<pre>{state.text}</pre>
							</section>
							<section>
								<strong>{copy("disk")}</strong>
								<pre>{state.conflict.content}</pre>
							</section>
						</div>
						<button
							type="button"
							disabled={transitionLocked || loading || state.saving || state.draftStatus === "pending"}
							onClick={() => void controller.useDiskAfterPreserve()}
						>
							{copy("keep")} · {copy("refresh")}
						</button>
					</details>
				)}
				{state.ready && saveAsOpen && (
					<div className="owl-editor-safety-saveas">
						<p>{copy("saveAsNote")}</p>
						<label>
							{copy("path")}
							<input
								disabled={transitionLocked}
								value={newPath}
								onChange={(event) => setNewPath(event.target.value)}
								placeholder={`${path}.copy`}
							/>
						</label>
						<button
							type="button"
							disabled={
								transitionLocked || !newPath.trim() || loading || state.saving || state.disk?.kind === "binary"
							}
							onClick={() => void controller.saveAs(newPath)}
						>
							{copy("saveAs")}
						</button>
						{state.copyPath && (
							<p role="status">
								{copy("copySaved")}:{" "}
								<button type="button" onClick={() => onOpenFile(state.copyPath!)}>
									{state.copyPath}
								</button>
							</p>
						)}
					</div>
				)}
				{state.warnings?.length ? (
					<div className="owl-editor-safety-status" role="alert">
						{copy("warnings")}: {state.warnings.join("; ")}
					</div>
				) : null}
			</div>
			<div className="owl-editor-content flex flex-1 overflow-hidden">
				<div
					ref={hostRef}
					className={`min-h-0 min-w-0 flex-1 overflow-hidden px-2 ${mode === "preview" ? "hidden" : ""}`}
				/>
				{mode !== "edit" && (
					<MarkdownPreview
						content={previewText}
						path={path}
						cwd={cwd}
						onOpenFile={onOpenFile}
						className={`min-w-0 ${mode === "split" ? "border-l border-owl-border/40" : ""}`}
					/>
				)}
			</div>
		</div>
	);
}
