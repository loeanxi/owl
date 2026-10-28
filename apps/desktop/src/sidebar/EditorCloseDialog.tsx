import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getUiLanguage, useT } from "../i18n/index.ts";
import type { SidebarStore } from "./store.ts";
import "./editor-safety.css";

const zh = {
	close: "处理未保存的修改",
	leave: "离开前保留修改",
	detail: "先保存文件或保留可恢复的草稿，再继续。取消会保留当前页面。",
	save: "保存文件",
	preserve: "保留草稿",
	discard: "放弃本次修改",
	cancel: "取消",
	working: "正在确认…",
	changed: "确认期间又有文件发生编辑，请重新选择。所有编辑器仍然保留。",
	unavailable: "编辑器尚未准备好，当前内容仍然保留，请稍后重试。",
	failed: "尚未确认保存或草稿备份成功。请查看文件内的提示后重试。",
	discardHint: "放弃仅针对本窗口的修改；其他窗口更新的草稿不会被覆盖或删除。",
};
const en: Record<keyof typeof zh, string> = {
	close: "Handle unsaved changes",
	leave: "Keep changes before leaving",
	detail: "Save the files or retain recoverable drafts before continuing. Cancel keeps the current page open.",
	save: "Save files",
	preserve: "Keep drafts",
	discard: "Discard these changes",
	cancel: "Cancel",
	working: "Confirming…",
	changed: "An editor changed during confirmation. Choose again; every editor is still retained.",
	unavailable: "An editor is not ready. Its current contents remain retained; retry shortly.",
	failed: "Saving or draft preservation was not confirmed. Check the message inside the file and retry.",
	discardHint:
		"Discard applies to this window's changes. Newer drafts from another window will not be overwritten or removed.",
};

export function EditorCloseDialog({ store }: { store: SidebarStore }): React.JSX.Element | null {
	useT();
	const text = getUiLanguage() === "en" ? en : zh;
	const request = useSyncExternalStore(
		store.editorClose.subscribe,
		store.editorClose.getSnapshot,
		store.editorClose.getSnapshot,
	);
	const panel = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!request) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		panel.current?.querySelector<HTMLButtonElement>('[data-close-cancel="true"]')?.focus();
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				if (!store.editorClose.getSnapshot()?.pending) void store.editorClose.choose("cancel");
			}
			if (event.key === "Tab") {
				const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
				if (!buttons.length) {
					event.preventDefault();
					panel.current?.focus();
					return;
				}
				const first = buttons[0];
				const last = buttons.at(-1);
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last?.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first?.focus();
				}
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			previous?.focus();
		};
	}, [request?.id, store]);
	if (!request) return null;
	const error =
		request.error === "editor-changed"
			? text.changed
			: request.error === "editor-unavailable"
				? text.unavailable
				: request.error === "editor-not-ready"
					? text.failed
					: request.error;
	return createPortal(
		<div className="owl-editor-close-overlay">
			<section
				ref={panel}
				tabIndex={-1}
				className="owl-editor-close-dialog"
				role="alertdialog"
				aria-modal="true"
				aria-label={request.reason === "leave" ? text.leave : text.close}
			>
				<h2>{request.reason === "leave" ? text.leave : text.close}</h2>
				<p>{text.detail}</p>
				<ul>
					{request.paths.map((path) => (
						<li key={path}>{path}</li>
					))}
				</ul>
				{error && (
					<p className="owl-editor-safety-error" role="alert">
						{error}
					</p>
				)}
				{request.pending && <p role="status">{text.working}</p>}
				<p className="owl-editor-safety-muted">{text.discardHint}</p>
				<div className="owl-editor-close-actions">
					<button type="button" disabled={request.pending} onClick={() => void store.editorClose.choose("save")}>
						{text.save}
					</button>
					<button
						type="button"
						disabled={request.pending}
						onClick={() => void store.editorClose.choose("preserve")}
					>
						{text.preserve}
					</button>
					<button
						type="button"
						disabled={request.pending}
						onClick={() => void store.editorClose.choose("discard")}
					>
						{text.discard}
					</button>
					<button
						type="button"
						data-close-cancel="true"
						disabled={request.pending}
						onClick={() => void store.editorClose.choose("cancel")}
					>
						{text.cancel}
					</button>
				</div>
			</section>
		</div>,
		document.body,
	);
}
