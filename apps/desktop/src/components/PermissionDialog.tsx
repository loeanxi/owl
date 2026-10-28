import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { usePendingResponses } from "../bridge/pending-responses.ts";
import type { PermissionRequest } from "../bridge/protocol.ts";
import { describeToolInput } from "../hooks/summarize.ts";
import { useT } from "../i18n/index.ts";
import { PendingResponseNotice } from "./PendingResponseNotice.tsx";
import { usePendingRequestCopy } from "./pending-request-copy.ts";
import { permissionDialogText, usePermissionDialogText } from "./permission-dialog-copy.ts";
import { permissionActionTitle } from "./permission-presentation.ts";
import "./pending-request.css";
import "./permission-dialog.css";

/** edit 预览每侧最多行数：超过明示「还有 N 行未显示」，全文仍在「来源与完整参数」。 */
const EDIT_PREVIEW_LINES = 8;
/** write 预览最多行数：新文件不再整卷倾倒，规模先给人。 */
const WRITE_PREVIEW_LINES = 15;

/** edit 的变更预览：红绿 diff 块，替代 describeToolInput 手工拼的 ± 纯文本（各 200 字符静默截断）。 */
function PermissionEditPreview({
	path,
	edits,
	text,
}: {
	path: string;
	edits: readonly { oldText?: unknown; newText?: unknown }[];
	text: typeof permissionDialogText;
}): React.JSX.Element {
	return (
		<div className="owl-permission-diff">
			<code className="owl-permission-diff-path">{path}</code>
			{edits.map((edit, index) => {
				const oldLines = String(edit.oldText ?? "").split("\n");
				const newLines = String(edit.newText ?? "").split("\n");
				return (
					<div key={index} className="owl-permission-diff-hunk">
						{oldLines.slice(0, EDIT_PREVIEW_LINES).map((line, i) => (
							<span key={"o" + i} className="owl-permission-diff-del">
								− {line}
							</span>
						))}
						{oldLines.length > EDIT_PREVIEW_LINES && (
							<span className="owl-permission-diff-more">
								{text("moreLines", { n: String(oldLines.length - EDIT_PREVIEW_LINES) })}
							</span>
						)}
						{newLines.slice(0, EDIT_PREVIEW_LINES).map((line, i) => (
							<span key={"n" + i} className="owl-permission-diff-add">
								+ {line}
							</span>
						))}
						{newLines.length > EDIT_PREVIEW_LINES && (
							<span className="owl-permission-diff-more">
								{text("moreLines", { n: String(newLines.length - EDIT_PREVIEW_LINES) })}
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}

/** write 的内容预览：前 N 行 + 规模与截断计数，全文仍在「来源与完整参数」。 */
function PermissionWritePreview({
	path,
	content,
	text,
}: {
	path: string;
	content: string;
	text: typeof permissionDialogText;
}): React.JSX.Element {
	const lines = content.split("\n");
	const clipped = lines.length > WRITE_PREVIEW_LINES;
	return (
		<div className="owl-permission-write">
			<code className="owl-permission-diff-path">{path}</code>
			<pre className="owl-permission-input-text">{lines.slice(0, WRITE_PREVIEW_LINES).join("\n")}</pre>
			{clipped && (
				<p className="owl-permission-preview-more">
					{text("totalLines", { n: String(lines.length) })} ·{" "}
					{text("moreLines", { n: String(lines.length - WRITE_PREVIEW_LINES) })}
				</p>
			)}
		</div>
	);
}

export function PermissionDialog({
	request,
	contextLabel,
	workspace,
	onLater,
	onDecide,
}: {
	request: PermissionRequest;
	contextLabel?: string;
	workspace?: string;
	onLater?: () => void;
	onDecide: (approved: boolean) => void;
}): React.JSX.Element {
	const t = useT();
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const sourceRef = useRef<HTMLDetailsElement>(null);
	const openerRef = useRef<HTMLElement | null>(null);
	const submitting = useRef(false);
	const copy = usePendingRequestCopy();
	const dialogCopy = usePermissionDialogText();
	const { controller, feedback } = usePendingResponses();
	const responseFeedback = feedback.get(request.requestId);
	const busy = responseFeedback?.phase === "pending";
	const workspacePath = workspace?.trim() ? workspace : undefined;
	const workspaceName =
		workspacePath
			?.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.at(-1) || workspacePath;
	const rawInput = JSON.stringify(request.input, null, 2) ?? String(request.input);
	const inputRecord = (request.input ?? {}) as Record<string, unknown>;
	const inputPath = typeof inputRecord.path === "string" ? inputRecord.path : undefined;
	const editEdits =
		request.toolName === "edit" && Array.isArray(inputRecord.edits)
			? (inputRecord.edits as { oldText?: unknown; newText?: unknown }[])
			: undefined;
	const writeContent =
		request.toolName === "write" && typeof inputRecord.content === "string" ? inputRecord.content : undefined;
	useLayoutEffect(() => {
		const previous = document.activeElement;
		if (previous instanceof HTMLElement && !dialogRef.current?.contains(previous)) openerRef.current = previous;
		return () => {
			if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true });
		};
	}, []);
	useLayoutEffect(() => {
		if (bodyRef.current) bodyRef.current.scrollTop = 0;
		if (sourceRef.current) sourceRef.current.open = false;
		submitting.current = false;
		dialogRef.current?.focus({ preventScroll: true });
	}, [request.requestId, request.sessionId]);
	useLayoutEffect(() => {
		if (responseFeedback?.phase && bodyRef.current) bodyRef.current.scrollTop = 0;
	}, [request.requestId, responseFeedback?.phase, responseFeedback?.error]);
	useEffect(() => {
		if (!busy) submitting.current = false;
	}, [busy]);
	const decide = (approved: boolean): void => {
		if (busy || submitting.current || controller?.getSnapshot().get(request.requestId)?.phase === "pending") return;
		submitting.current = true;
		// Keep keyboard focus in the reading area before the clicked action becomes disabled.
		bodyRef.current?.focus({ preventScroll: true });
		try {
			onDecide(approved);
		} finally {
			if (controller?.getSnapshot().get(request.requestId)?.phase !== "pending") submitting.current = false;
		}
	};
	return (
		<div
			className="owl-permission-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onKeyDown={(event) => {
				if (event.key === "Escape" && onLater) {
					event.preventDefault();
					event.stopPropagation();
					onLater();
				}
			}}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-busy={busy}
				className="owl-permission-dialog owl-permission-review"
				onKeyDown={(event) => {
					// Ctrl/Cmd+Enter = 允许：与全局「推进」快捷键同语义。拒绝保持纯点击，防误触。
					if (event.nativeEvent.isComposing || event.repeat) return;
					if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
						event.preventDefault();
						event.stopPropagation();
						decide(true);
						return;
					}
					if (event.key !== "Tab") return;
					const focusable = [
						...event.currentTarget.querySelectorAll<HTMLElement>(
							"button, a[href], input, select, textarea, summary, [tabindex]",
						),
					].filter((element) => {
						if (
							element.matches(':disabled, [aria-disabled="true"], input[type="hidden"]') ||
							element.closest("[hidden], [inert]") ||
							(element.hasAttribute("tabindex") && element.tabIndex < 0)
						)
							return false;
						let ancestor = element.parentElement;
						while (ancestor && ancestor !== event.currentTarget) {
							if (ancestor.tagName === "DETAILS" && !ancestor.hasAttribute("open")) {
								const summary = [...ancestor.children].find((child) => child.tagName === "SUMMARY");
								if (!summary?.contains(element)) return false;
							}
							ancestor = ancestor.parentElement;
						}
						return true;
					});
					const first = focusable[0];
					const last = focusable.at(-1);
					if (
						document.activeElement === event.currentTarget ||
						!event.currentTarget.contains(document.activeElement)
					) {
						event.preventDefault();
						(event.shiftKey ? last : first)?.focus();
					} else if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last?.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first?.focus();
					}
				}}
			>
				<header className="owl-permission-head">
					<h2 id={titleId} className="owl-permission-title">
						{permissionActionTitle(request.toolName, request.input)}
					</h2>
					<div className="owl-permission-scope">
						<span className="owl-permission-workspace-label">{copy.workspace}</span>
						<strong className="owl-permission-workspace-name">{workspaceName ?? copy.unknownWorkspace}</strong>
						{workspacePath && (
							<span className="owl-permission-workspace-path" title={workspacePath}>
								{workspacePath}
							</span>
						)}
					</div>
				</header>
				<div
					ref={bodyRef}
					className="owl-permission-body"
					tabIndex={0}
					role="region"
					aria-label={dialogCopy("readingRegion")}
				>
					<PendingResponseNotice requestId={request.requestId} />
					<section className="owl-permission-input">
						<h3 className="owl-permission-input-label">
							{dialogCopy(
								request.toolName === "edit" || request.toolName === "write" ? "changePreview" : "input",
							)}
						</h3>
						{request.toolName === "edit" && editEdits !== undefined && inputPath !== undefined ? (
							<PermissionEditPreview path={inputPath} edits={editEdits} text={dialogCopy} />
						) : request.toolName === "write" && writeContent !== undefined && inputPath !== undefined ? (
							<PermissionWritePreview path={inputPath} content={writeContent} text={dialogCopy} />
						) : (
							<pre className="owl-permission-input-text">
								{describeToolInput(request.toolName, request.input)}
							</pre>
						)}
					</section>
					<details ref={sourceRef} className="owl-permission-source">
						<summary>{dialogCopy("source")}</summary>
						<dl className="owl-permission-source-fields">
							<dt>{dialogCopy("tool")}</dt>
							<dd>{request.toolName}</dd>
							<dt>{copy.workspace}</dt>
							<dd>{workspacePath ?? copy.unknownWorkspace}</dd>
							<dt>{copy.session}</dt>
							<dd>
								{contextLabel && <span>{contextLabel} · </span>}
								<code>{request.sessionId}</code>
							</dd>
						</dl>
						<h3 className="owl-permission-input-label">{dialogCopy("fullInput")}</h3>
						<pre className="owl-permission-raw-input">{rawInput}</pre>
					</details>
				</div>
				<footer className="owl-permission-foot">
					{onLater && (
						<button type="button" className="owl-permission-action later" onClick={onLater}>
							{copy.later}
						</button>
					)}
					{busy && (
						<button type="button" disabled className="owl-permission-action sending">
							{copy.sending}
						</button>
					)}
					<button
						type="button"
						disabled={busy}
						className="owl-permission-action deny"
						onClick={() => decide(false)}
					>
						{t("perm.deny")}
					</button>
					<button
						type="button"
						disabled={busy}
						className="owl-permission-action allow"
						onClick={() => decide(true)}
					>
						{t("perm.allow")}
						<span className="owl-permission-kbd" aria-hidden="true">
							Ctrl+Enter
						</span>
					</button>
				</footer>
			</div>
		</div>
	);
}
