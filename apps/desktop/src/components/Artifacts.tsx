import type { ArtifactKind, FileArtifact } from "../hooks/artifacts.ts";
import { t, useT, type TextKey } from "../i18n/index.ts";
import { IconChevron } from "./icons.tsx";
import "./artifacts.css";

const KIND_LABEL: Record<ArtifactKind, TextKey> = {
	document: "artifacts.kindDocument",
	sheet: "artifacts.kindSheet",
	presentation: "artifacts.kindPresentation",
	image: "artifacts.kindImage",
	code: "artifacts.kindCode",
	file: "artifacts.kindFile",
};

const ACTION_LABEL: Record<FileArtifact["action"], TextKey> = {
	written: "artifacts.written",
	edited: "artifacts.edited",
	opened: "artifacts.opened",
};

export interface ArtifactsProps {
	artifacts: readonly FileArtifact[];
	onOpenFile: (path: string) => void;
	title?: string;
}

/** Real session outputs share the existing workbench viewers and file-opening policy. */
export function Artifacts({ artifacts, onOpenFile, title }: ArtifactsProps): React.JSX.Element | null {
	const t = useT();
	const heading = title ?? t("artifacts.title");
	if (artifacts.length === 0) return null;
	return (
		<section className="owl-artifacts" aria-label={heading}>
			<header className="owl-artifacts-heading">
				<strong>{heading}</strong>
				<span>{t("artifacts.fileCount", { n: artifacts.length })}</span>
			</header>
			<ul className="owl-artifacts-list">
				{artifacts.map((artifact) => (
					<li key={artifact.path}>
						<button
							type="button"
							className="owl-artifact-file"
							aria-label={t("artifacts.openAria", { name: artifact.title })}
							title={artifact.path}
							onClick={() => onOpenFile(artifact.path)}
						>
							<span className="owl-artifact-kind" data-kind={artifact.kind}>{t(KIND_LABEL[artifact.kind])}</span>
							<span className="owl-artifact-description">
								<strong>{artifact.title}</strong>
								<span>{artifact.path}</span>
							</span>
							<span className="owl-artifact-action">{t(ACTION_LABEL[artifact.action])}</span>
							<IconChevron className="owl-artifact-chevron" />
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
