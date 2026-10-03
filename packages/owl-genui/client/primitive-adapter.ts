/**
 * owl 本地宿主原语。dsh 版从宿主 ui-primitives 收编 CodeBlock / DiffBlock /
 * JsonTree / writeClipboard 四个表面；owl 没有等价宿主包，这里按同一 prop
 * 契约自绘实现（样式见 owl-primitives.module.css，配色走 --dsw-alias-* 令牌）。
 * 行级 diff 用仓库已有的 jsdiff；剪贴板优先 navigator.clipboard，降级
 * execCommand。getGenuiComponent 恒为 undefined：owl MVP 不开放自定义组件注册。
 * @module owl-genui/client/primitive-adapter
 */

import { diffLines } from "diff";
import { createElement, type ReactNode, useCallback, useMemo, useState } from "react";
import css from "./owl-primitives.module.css";

/** Localized chrome labels for the inline diff block. */
export interface DiffBlockLabels {
	copy: string;
	copied: string;
	codeLabel: string;
	wrapLabel: string;
	unwrapLabel: string;
	collapse: string;
	/** Accessible label for expanding a collapsed diff tail. */
	collapseAria: (hidden: number) => string;
	/** Visible label for expanding a collapsed diff tail. */
	expand: (hidden: number) => string;
	/** Localized file-count summary in the diff footer. */
	files: (count: number) => string;
}

/** Localized chrome labels for the JSON tree. */
export interface JsonTreeLabels {
	copyValue: string;
	copyJson: string;
	copyPath: string;
	copyPrettyJson: string;
	copyCompactJson: string;
	copied: string;
	copyFailed: string;
	collapseNode: string;
	expandNode: string;
	/** Tooltip for a JSON tree copy action. */
	copyButtonTitle: (action: string) => string;
}

export interface GenuiDiffFile {
	path: string;
	oldText: string | null;
	newText: string;
}

/** Copy to the clipboard; returns whether it succeeded. */
export async function writeClipboard(text: string): Promise<boolean> {
	try {
		if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the legacy path (denied permission / non-secure context)
	}
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "true");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

/** Copy button with a transient done state, shared by the three primitives. */
function CopyChip(props: { getText: () => string; label: string; doneLabel: string }): ReactNode {
	const [copied, setCopied] = useState(false);
	const onCopy = useCallback(() => {
		void writeClipboard(props.getText()).then((ok) => {
			if (!ok) return;
			setCopied(true);
			setTimeout(() => setCopied(false), 1600);
		});
	}, [props]);
	return createElement(
		"button",
		{
			type: "button",
			className: `${css.copyBtn}${copied ? ` ${css.done}` : ""}`,
			onClick: onCopy,
		},
		copied ? props.doneLabel : props.label,
	);
}

const CODE_COLLAPSE_LINES = 60;
const CODE_KEEP_LINES = 40;

/** Code block with an optional language chip and copy action. */
export function CodeBlock(props: { code: string; lang?: string; copyLabel?: string; copiedLabel?: string }): ReactNode {
	const lines = useMemo(() => props.code.split("\n"), [props.code]);
	const clamped = lines.length > CODE_COLLAPSE_LINES;
	const shown = clamped ? lines.slice(0, CODE_KEEP_LINES) : lines;
	const [expanded, setExpanded] = useState(false);
	const visible = expanded ? lines : shown;
	return createElement(
		"div",
		{ className: css.primitive },
		(props.lang !== undefined || props.copyLabel !== undefined) &&
			createElement(
				"div",
				{ className: css.primitiveHead },
				createElement("span", { className: css.primitiveLabel }, props.lang ?? ""),
				props.copyLabel !== undefined &&
					createElement(CopyChip, {
						getText: () => props.code,
						label: props.copyLabel,
						doneLabel: props.copiedLabel ?? props.copyLabel,
					}),
			),
		createElement("div", { className: css.codeScroll }, createElement("pre", null, visible.join("\n"))),
		clamped &&
			!expanded &&
			createElement(
				"button",
				{ type: "button", className: css.diffCollapseBtn, onClick: () => setExpanded(true) },
				`… +${lines.length - shown.length}`,
			),
	);
}

const DIFF_COLLAPSE_LINES = 120;
const DIFF_KEEP_LINES = 50;

/** Per-file unified diff, computed locally with jsdiff. */
export function DiffBlock(props: { diffs: GenuiDiffFile[]; labels: DiffBlockLabels }): ReactNode {
	const { labels } = props;
	const [wrap, setWrap] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const files = useMemo(
		() =>
			props.diffs.map((file) => {
				const parts =
					file.oldText === null
						? [{ value: file.newText, added: true, removed: false, count: 0 }]
						: diffLines(file.oldText, file.newText);
				const lines: Array<{ text: string; kind: "add" | "del" | "ctx" }> = [];
				for (const part of parts) {
					for (const line of part.value.replace(/\n$/, "").split("\n")) {
						lines.push({ text: line, kind: part.added ? "add" : part.removed ? "del" : "ctx" });
					}
				}
				return { path: file.path, lines };
			}),
		[props.diffs],
	);
	const totalLines = files.reduce((sum, file) => sum + file.lines.length, 0);
	const collapsed = totalLines > DIFF_COLLAPSE_LINES && !expanded;
	let budget = collapsed ? DIFF_KEEP_LINES : Number.POSITIVE_INFINITY;
	return createElement(
		"div",
		{ className: css.primitive },
		createElement(
			"div",
			{ className: css.primitiveHead },
			createElement("span", { className: css.primitiveLabel }, labels.files(props.diffs.length)),
			createElement(
				"div",
				{ style: { display: "flex", gap: 2 } },
				createElement(
					"button",
					{ type: "button", className: css.copyBtn, onClick: () => setWrap((value) => !value) },
					wrap ? labels.unwrapLabel : labels.wrapLabel,
				),
				createElement(CopyChip, {
					getText: () =>
						files
							.map(
								(file) =>
									`${file.path}\n${file.lines.map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`).join("\n")}`,
							)
							.join("\n\n"),
					label: labels.copy,
					doneLabel: labels.copied,
				}),
			),
		),
		files.map((file) =>
			createElement(
				"div",
				{ key: file.path },
				createElement(
					"div",
					{ className: css.primitiveHead },
					createElement("span", { className: css.primitiveLabel }, file.path),
				),
				createElement(
					"div",
					{ className: `${css.diffScroll}${wrap ? ` ${css.wrap}` : ""}` },
					file.lines
						.filter((line) => {
							if (budget > 0) {
								budget -= 1;
								return true;
							}
							return false;
						})
						.map((line, index) =>
							createElement(
								"span",
								{ key: index, className: `${css.diffLine} ${css[line.kind]}` },
								`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`,
							),
						),
				),
			),
		),
		collapsed &&
			createElement(
				"button",
				{
					type: "button",
					className: css.diffCollapseBtn,
					"aria-label": labels.collapseAria(totalLines - DIFF_KEEP_LINES),
					onClick: () => setExpanded(true),
				},
				labels.expand(totalLines - DIFF_KEEP_LINES),
			),
		expanded &&
			createElement(
				"button",
				{ type: "button", className: css.diffCollapseBtn, onClick: () => setExpanded(false) },
				labels.collapse,
			),
	);
}

/** JSON scalar → colored span; object/array → collapsible subtree. */
function JsonValue(props: {
	name: string | undefined;
	value: unknown;
	depth: number;
	path: string;
	labels: JsonTreeLabels;
}): ReactNode {
	const { labels } = props;
	const collapsible = props.value !== null && typeof props.value === "object";
	const [open, setOpen] = useState(props.depth < 2);
	const [copied, setCopied] = useState<string | null>(null);

	const copy = useCallback((text: string, action: string) => {
		void writeClipboard(text).then((ok) => {
			setCopied(ok ? action : "failed");
			setTimeout(() => setCopied(null), 1600);
		});
	}, []);

	const actions = collapsible
		? createElement(
				"span",
				{ className: css.jsonActions },
				createElement(
					"button",
					{
						type: "button",
						className: css.copyBtn,
						title: labels.copyButtonTitle(labels.copyPath),
						onClick: () => copy(props.path, "path"),
					},
					copied === "path" ? "✓" : "path",
				),
				createElement(
					"button",
					{
						type: "button",
						className: css.copyBtn,
						title: labels.copyButtonTitle(labels.copyJson),
						onClick: () => copy(JSON.stringify(props.value, null, 2), "json"),
					},
					copied === "json" ? "✓" : "{}",
				),
			)
		: null;

	if (!collapsible) {
		let className: string;
		let text: string;
		if (typeof props.value === "string") {
			className = css.jsonString;
			text = JSON.stringify(props.value);
		} else if (typeof props.value === "number") {
			className = css.jsonNumber;
			text = String(props.value);
		} else if (typeof props.value === "boolean") {
			className = css.jsonBoolean;
			text = String(props.value);
		} else {
			className = css.jsonNull;
			text = "null";
		}
		return createElement(
			"span",
			{ className: css.jsonRow },
			props.name !== undefined && createElement("span", { className: css.jsonKey }, props.name),
			props.name !== undefined && createElement("span", { className: css.jsonPunct }, ": "),
			createElement("span", { className }, text),
			props.depth === 0 && actions,
		);
	}

	const entries: Array<[string, unknown]> = Array.isArray(props.value)
		? props.value.map((item, index) => [String(index), item])
		: Object.entries(props.value as Record<string, unknown>);
	const bracketOpen = Array.isArray(props.value) ? "[" : "{";
	const bracketClose = Array.isArray(props.value) ? "]" : "}";

	return createElement(
		"div",
		{ className: css.jsonRow, style: { flexDirection: "column", alignItems: "stretch" } },
		createElement(
			"span",
			{ style: { display: "flex", alignItems: "baseline", gap: 4 } },
			createElement(
				"button",
				{
					type: "button",
					className: css.jsonToggle,
					"aria-label": open ? labels.collapseNode : labels.expandNode,
					onClick: () => setOpen((value) => !value),
				},
				open ? "▾" : "▸",
			),
			props.name !== undefined && createElement("span", { className: css.jsonKey }, props.name),
			props.name !== undefined && createElement("span", { className: css.jsonPunct }, ": "),
			createElement("span", { className: css.jsonPunct }, bracketOpen),
			createElement("span", { className: css.jsonPunct, style: { opacity: 0.6 } }, `${entries.length}`),
			actions,
		),
		open &&
			(entries.length === 0
				? createElement("span", { className: css.jsonEmpty }, "—")
				: entries.map(([key, value]) =>
						createElement(JsonValue, {
							key,
							name: key,
							value,
							depth: props.depth + 1,
							path: `${props.path}.${key}`,
							labels,
						}),
					)),
		open && createElement("span", { className: css.jsonPunct }, bracketClose),
	);
}

/** Expandable JSON tree with hover copy actions. */
export function JsonTree(props: {
	data: object | unknown[];
	label?: string;
	labels: JsonTreeLabels;
	copyable?: boolean;
}): ReactNode {
	return createElement(
		"div",
		{ className: css.primitive },
		props.label !== undefined &&
			createElement(
				"div",
				{ className: css.primitiveHead },
				createElement("span", { className: css.primitiveLabel }, props.label),
				props.copyable === true &&
					createElement(
						"div",
						{ style: { display: "flex", gap: 2 } },
						createElement(CopyChip, {
							getText: () => JSON.stringify(props.data, null, 2),
							label: props.labels.copyPrettyJson,
							doneLabel: props.labels.copied,
						}),
						createElement(CopyChip, {
							getText: () => JSON.stringify(props.data),
							label: props.labels.copyCompactJson,
							doneLabel: props.labels.copied,
						}),
					),
			),
		createElement(
			"div",
			{ className: css.jsonTree },
			createElement(JsonValue, {
				name: undefined,
				value: props.data,
				depth: 0,
				path: "$",
				labels: props.labels,
			}),
		),
	);
}

/** owl MVP 不开放宿主自定义组件注册（dsh 的 getGenuiComponent 扩展点）。 */
export const getGenuiComponent: ((type: string) => unknown) | undefined = undefined;
