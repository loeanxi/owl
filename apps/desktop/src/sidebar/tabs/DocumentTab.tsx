import { useEffect, useState } from "react";
import { t, useT } from "../../i18n/index.ts";
import { renderMarkdown } from "../../components/ChatStream.tsx";
import { workspaceArtifactPath } from "../../hooks/artifacts.ts";
import { pathCandidateFromCode } from "../../utils/paths.ts";
import { fileUrlOf } from "../api.ts";
import type { TabComponentProps } from "../registry.ts";
import { useSidebarConfig } from "../config.ts";
import "./document.css";

/** Text documents have a readable preview; their existing editor remains available. */
export function DocumentTab({ api, cwd, tab, store, onOpenFile }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const path = tab.path ?? "";
	const config = useSidebarConfig();
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
	const markdown = /\.(md|markdown)$/i.test(path);
	const html = /\.(html|htm)$/i.test(path);
	return (
		<div className="owl-document">
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
				? <iframe title={t("doc.previewTitle", { path })} className="owl-document-html" srcDoc={content} sandbox="allow-scripts" referrerPolicy="no-referrer" />
				: markdown
					? <article className="owl-document-markdown owl-answer" onClick={(event) => {
						if (!(event.target instanceof Element)) return;
						const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
						if (anchor) {
							const href = anchor.getAttribute("href");
							if (!href || href.startsWith("#")) return;
							const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
							const target = /^[a-z][a-z\d+.-]*:|^[\\/]/i.test(href) ? href : `${parent}${href}`;
							const relative = workspaceArtifactPath(target.split("#")[0], cwd, { encoded: true });
							if (!relative) return;
							event.preventDefault();
							onOpenFile(relative);
							return;
						}
						// 路径/URL 芯片（owl-path-chip）与聊天流同款：解析成工作区路径跳转
						const code = event.target.closest<HTMLElement>("code");
						if (!code || code.closest("pre") || code.closest("a")) return;
						const candidate = pathCandidateFromCode(code.textContent ?? "");
						if (!candidate) return;
						const relative = workspaceArtifactPath(candidate, cwd);
						if (!relative) return;
						event.preventDefault();
						onOpenFile(relative);
					}} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
					: <pre className="owl-document-text">{content}</pre>)}
		</div>
	);
}
