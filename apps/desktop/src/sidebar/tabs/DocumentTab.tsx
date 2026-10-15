import { useEffect, useMemo, useRef, useState } from "react";
import { t, useT } from "../../i18n/index.ts";
import { fileUrlOf } from "../api.ts";
import type { TabComponentProps } from "../registry.ts";
import { useSidebarConfig } from "../config.ts";
import { MARKDOWN_PATH, MarkdownPreview } from "./MarkdownPreview.tsx";
import { observeWorkbenchTheme, readWorkbenchPalette, resolveSurfaceTheme } from "../theme-observer.ts";
import { HTML_PREVIEW_THEME_MESSAGE, themedHtmlPreview } from "./html-preview-theme.ts";
import "./document.css";

/** Text documents have a readable preview; their existing editor remains available. */
export function DocumentTab({ api, cwd, tab, store, onOpenFile }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const path = tab.path ?? "";
	const config = useSidebarConfig();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [content, setContent] = useState<string>();
	const [error, setError] = useState<string>();
	const [truncated, setTruncated] = useState(false);
	const [revision, setRevision] = useState(0);
	useEffect(() => store.onFsChanged(() => setRevision((current) => current + 1)), [store]);
	useEffect(() => {
		let cancelled = false;
		setContent(undefined);
		setError(undefined);
		setTruncated(false);
		void api.fsRead(cwd, path).then((file) => {
			if (cancelled) return;
			if (file.kind !== "text") {
				setError(t("doc.openWithSystemNeeded"));
				return;
			}
			setContent(file.content);
			setTruncated(file.truncated);
		}).catch((failure: unknown) => {
			if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
		});
		return () => { cancelled = true; };
	}, [api, cwd, path, revision]);
	const markdown = MARKDOWN_PATH.test(path);
	const html = /\.(html|htm)$/i.test(path);
	const syncHtmlTheme = (): void => {
		if (!surfaceRef.current || !frameRef.current?.contentWindow) return;
		const palette = readWorkbenchPalette(getComputedStyle(surfaceRef.current), resolveSurfaceTheme(document.documentElement.dataset));
		// sandbox without allow-same-origin gives this srcDoc frame an opaque origin.
		frameRef.current.contentWindow.postMessage({ type: HTML_PREVIEW_THEME_MESSAGE, palette }, "*");
	};
	useEffect(() => {
		if (!html || !surfaceRef.current) return;
		return observeWorkbenchTheme(surfaceRef.current, syncHtmlTheme);
	}, [html]);
	const htmlContent = useMemo(() => {
		if (!html || content === undefined) return undefined;
		const surface = surfaceRef.current ?? document.documentElement;
		return themedHtmlPreview(content, readWorkbenchPalette(getComputedStyle(surface), resolveSurfaceTheme(document.documentElement.dataset)));
	}, [content, html]);
	return (
		<div ref={surfaceRef} className="owl-document">
			<div className="owl-document-toolbar">
				<span title={path}>{path}</span>
				<button type="button" onClick={() => setRevision((current) => current + 1)}>{t("common.refresh")}</button>
				<button type="button" disabled={config.disabledViewers.includes("editor")} onClick={() => {
					if (!config.disabledViewers.includes("editor")) store.openFileTab("editor", path, path.split("/").pop() ?? path);
				}}>{t("doc.edit")}</button>
				<button type="button" onClick={() => {
					void api.openExternal("url", fileUrlOf(cwd, path)).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
				}}>{t("doc.openWithSystem")}</button>
			</div>
			{error && <p className="owl-document-error" role="alert">{error}</p>}
			{truncated && <p className="owl-document-loading" role="status">{t("doc.truncated")}</p>}
			{content === undefined && !error && <p className="owl-document-loading" role="status">{t("doc.loading")}</p>}
			{content !== undefined && (html
				? <iframe ref={frameRef} title={t("doc.previewTitle", { path })} className="owl-document-html" srcDoc={htmlContent} onLoad={syncHtmlTheme} sandbox="allow-scripts" referrerPolicy="no-referrer" />
				: markdown
					? <MarkdownPreview content={content} path={path} cwd={cwd} onOpenFile={onOpenFile} />
					: <pre className="owl-document-text">{content}</pre>)}
		</div>
	);
}
