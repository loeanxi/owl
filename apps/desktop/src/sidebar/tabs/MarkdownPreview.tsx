import { useMemo } from "react";
import { renderMarkdown } from "../../components/ChatStream.tsx";
import { workspaceArtifactPath } from "../../hooks/artifacts.ts";
import { pathCandidateFromCode } from "../../utils/paths.ts";
import "./document.css";

export const MARKDOWN_PATH = /\.(md|markdown)$/i;

interface MarkdownPreviewProps {
	content: string;
	/** 工作区相对路径：相对链接按它的目录解析。 */
	path: string;
	cwd: string;
	onOpenFile: (path: string) => void;
	className?: string;
}

/** 工作区 Markdown 渲染：文档预览与编辑器预览共用，相对链接 / 路径芯片跳转到工作区文件。 */
export function MarkdownPreview({ content, path, cwd, onOpenFile, className }: MarkdownPreviewProps): React.JSX.Element {
	const html = useMemo(() => renderMarkdown(content), [content]);
	return (
		<article className={`owl-document-markdown owl-answer${className ? ` ${className}` : ""}`} onClick={(event) => {
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
		}} dangerouslySetInnerHTML={{ __html: html }} />
	);
}
