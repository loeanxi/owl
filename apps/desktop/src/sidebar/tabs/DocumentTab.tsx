import { useEffect, useState } from "react";
import { renderMarkdown } from "../../components/ChatStream.tsx";
import { workspaceArtifactPath } from "../../hooks/artifacts.ts";
import { fileUrlOf } from "../api.ts";
import type { TabComponentProps } from "../registry.ts";
import "./document.css";

/** Text documents have a readable preview; their existing editor remains available. */
export function DocumentTab({ api, cwd, tab, store, onOpenFile }: TabComponentProps): React.JSX.Element {
	const path = tab.path ?? "";
	const [content, setContent] = useState<string>();
	const [error, setError] = useState<string>();
	const [revision, setRevision] = useState(0);
	useEffect(() => store.onFsChanged(() => setRevision((current) => current + 1)), [store]);
	useEffect(() => {
		let cancelled = false;
		setContent(undefined);
		setError(undefined);
		void api.fsRead(cwd, path).then((file) => {
			if (!cancelled) setContent(file.content);
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
				<button type="button" onClick={() => setRevision((current) => current + 1)}>刷新</button>
				<button type="button" onClick={() => store.openFileTab("editor", path, path.split("/").pop() ?? path)}>编辑文件</button>
				<button type="button" onClick={() => {
					void api.openExternal("url", fileUrlOf(cwd, path)).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
				}}>系统打开</button>
			</div>
			{error && <p className="owl-document-error" role="alert">{error}</p>}
			{content === undefined && !error && <p className="owl-document-loading" role="status">正在读取文件…</p>}
			{content !== undefined && (html
				? <iframe title={`预览 ${path}`} className="owl-document-html" srcDoc={content} sandbox="allow-scripts" referrerPolicy="no-referrer" />
				: markdown
					? <article className="owl-document-markdown owl-answer" onClick={(event) => {
						if (!(event.target instanceof Element)) return;
						const href = event.target.closest<HTMLAnchorElement>("a[href]")?.getAttribute("href");
						if (!href || href.startsWith("#")) return;
						const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
						const target = /^[a-z][a-z\d+.-]*:|^[\\/]/i.test(href) ? href : `${parent}${href}`;
						const relative = workspaceArtifactPath(target.split("#")[0], cwd, { encoded: true });
						if (!relative) return;
						event.preventDefault();
						onOpenFile(relative);
					}} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
					: <pre className="owl-document-text">{content}</pre>)}
		</div>
	);
}
