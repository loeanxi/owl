import type { ArtifactKind, FileArtifact } from "../hooks/artifacts.ts";
import { IconChevron } from "./icons.tsx";
import "./artifacts.css";

const KIND_LABEL: Record<ArtifactKind, string> = {
	document: "文档",
	sheet: "表格",
	presentation: "演示",
	image: "图片",
	code: "代码",
	file: "文件",
};

const ACTION_LABEL: Record<FileArtifact["action"], string> = {
	written: "已写入",
	edited: "已更新",
	opened: "已展示",
};

export interface ArtifactsProps {
	artifacts: readonly FileArtifact[];
	onOpenFile: (path: string) => void;
	title?: string;
}

/** Real session outputs share the existing workbench viewers and file-opening policy. */
export function Artifacts({ artifacts, onOpenFile, title = "成果文件" }: ArtifactsProps): React.JSX.Element | null {
	if (artifacts.length === 0) return null;
	return (
		<section className="owl-artifacts" aria-label={title}>
			<header className="owl-artifacts-heading">
				<strong>{title}</strong>
				<span>{artifacts.length} 个文件</span>
			</header>
			<ul className="owl-artifacts-list">
				{artifacts.map((artifact) => (
					<li key={artifact.path}>
						<button
							type="button"
							className="owl-artifact-file"
							aria-label={`打开 ${artifact.title}`}
							title={artifact.path}
							onClick={() => onOpenFile(artifact.path)}
						>
							<span className="owl-artifact-kind" data-kind={artifact.kind}>{KIND_LABEL[artifact.kind]}</span>
							<span className="owl-artifact-description">
								<strong>{artifact.title}</strong>
								<span>{artifact.path}</span>
							</span>
							<span className="owl-artifact-action">{ACTION_LABEL[artifact.action]}</span>
							<IconChevron className="owl-artifact-chevron" />
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
