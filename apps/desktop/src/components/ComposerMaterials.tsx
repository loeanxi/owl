import { useEffect, useId, useState } from "react";
import { useComposerMaterialsText } from "./composer-materials-copy.ts";
import "./composer-materials.css";

const IMAGE_FORMAT_LABELS: Readonly<Record<string, string>> = {
	"image/png": "PNG",
	"image/jpeg": "JPEG",
	"image/webp": "WebP",
	"image/gif": "GIF",
	"image/bmp": "BMP",
	"image/avif": "AVIF",
	"image/svg+xml": "SVG",
};

export type ComposerMaterialImage = { id: string; data: string; mimeType: string };
export type ComposerMaterialFile = { key: string; path: string; basename: string };

export interface ComposerMaterialsProps {
	images: readonly ComposerMaterialImage[];
	files: readonly ComposerMaterialFile[];
	onPreview: (image: ComposerMaterialImage) => void;
	onRemoveImage: (id: string) => void;
	onRemoveFile: (path: string) => void;
}

/** This is a view of the draft's complete material set; collapse never changes the send payload. */
export function ComposerMaterials({ images, files, onPreview, onRemoveImage, onRemoveFile }: ComposerMaterialsProps): React.JSX.Element | null {
	const copy = useComposerMaterialsText();
	const headingId = useId();
	const listId = useId();
	const [expanded, setExpanded] = useState(false);
	const imageItems = images.map((image, index) => ({ kind: "image" as const, key: "image:" + image.id, image, index }));
	const fileItems = files.map((file) => ({ kind: "file" as const, key: "file:" + file.key, file }));
	const items = [...imageItems, ...fileItems];
	const total = items.length;
	const isExpanded = expanded && total > 3;
	useEffect(() => { if (total <= 3) setExpanded(false); }, [total]);
	if (total === 0) return null;
	const visible = isExpanded ? items : imageItems.length && fileItems.length
		? [...imageItems.slice(0, 2), ...fileItems.slice(0, 3 - Math.min(2, imageItems.length))]
		: items.slice(0, 3);
	return <section className="owl-composer-materials" data-expanded={isExpanded} aria-labelledby={headingId}>
		<div className="owl-composer-materials-head">
			<span id={headingId} className="owl-composer-materials-count">{copy("count", { n: total })}</span>
			{total > 3 && <button type="button" className="owl-composer-materials-toggle" aria-expanded={isExpanded} aria-controls={listId} onClick={() => setExpanded((value) => !value)}>{copy(isExpanded ? "collapse" : "expand")}</button>}
		</div>
		<ul id={listId} className="owl-composer-materials-list" tabIndex={isExpanded ? 0 : undefined} aria-labelledby={headingId}>
			{visible.map((item) => <li key={item.key} className="owl-composer-material" data-kind={item.kind}>
				{item.kind === "image" ? <>
					<button type="button" className="owl-composer-material-preview" aria-label={copy("previewImage", { n: item.index + 1 })} title={copy("previewImage", { n: item.index + 1 })} onClick={() => onPreview(item.image)}><img src={`data:${item.image.mimeType};base64,${item.image.data}`} alt="" /></button>
					<div className="owl-composer-material-copy"><span className="owl-composer-material-name">{copy("image", { n: item.index + 1 })}</span>{IMAGE_FORMAT_LABELS[item.image.mimeType] && <span className="owl-composer-material-path">{IMAGE_FORMAT_LABELS[item.image.mimeType]}</span>}</div>
					<button type="button" className="owl-composer-material-remove" aria-label={copy("removeImage", { n: item.index + 1 })} title={copy("removeImage", { n: item.index + 1 })} onClick={() => onRemoveImage(item.image.id)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
				</> : <>
					<span className="owl-composer-material-file" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></svg></span>
					<div className="owl-composer-material-copy"><span className="owl-composer-material-name" title={item.file.path}>{item.file.basename}</span><span className="owl-composer-material-path" tabIndex={0} title={item.file.path}>{item.file.path}</span></div>
					<button type="button" className="owl-composer-material-remove" aria-label={copy("removeFile", { path: item.file.path })} title={copy("removeFile", { path: item.file.path })} onClick={() => onRemoveFile(item.file.path)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
				</>}
			</li>)}
		</ul>
	</section>;
}
