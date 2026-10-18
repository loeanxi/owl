import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useComposerMaterialsText } from "./composer-materials-copy.ts";
import "./composer-materials.css";

export type ComposerMaterialImage = { id: string; data: string; mimeType: string; name?: string };
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
	const listId = useId();
	const [expanded, setExpanded] = useState(false);
	const imageItems = images.map((image, index) => ({ kind: "image" as const, key: "image:" + image.id, image, index }));
	const fileItems = files.map((file) => ({ kind: "file" as const, key: "file:" + file.key, file }));
	const items = [...imageItems, ...fileItems];
	const total = items.length;
	const isExpanded = expanded && total > 3;
	const previousKeys = useRef(new Set(items.map((item) => item.key)));
	const arrivalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const [arrivingKeys, setArrivingKeys] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => { if (total <= 3) setExpanded(false); }, [total]);
	const visible = isExpanded ? items : imageItems.length && fileItems.length
		? [...imageItems.slice(0, 2), ...fileItems.slice(0, 3 - Math.min(2, imageItems.length))]
		: items.slice(0, 3);
	// Restoring a draft and revealing collapsed materials must not replay their arrival.
	useLayoutEffect(() => {
		const visibleKeys = new Set(visible.map((item) => item.key));
		const added = visible.filter((item) => !previousKeys.current.has(item.key)).map((item) => item.key);
		previousKeys.current = new Set(items.map((item) => item.key));
		const hidden = [...arrivingKeys].filter((key) => !visibleKeys.has(key));
		if (added.length === 0 && hidden.length === 0) return;
		for (const key of [...hidden, ...added]) {
			clearTimeout(arrivalTimers.current.get(key));
			arrivalTimers.current.delete(key);
		}
		setArrivingKeys((current) => new Set([...current].filter((key) => visibleKeys.has(key)).concat(added)));
		for (const key of added) {
			const timer = setTimeout(() => {
				arrivalTimers.current.delete(key);
				setArrivingKeys((current) => new Set([...current].filter((entry) => entry !== key)));
			}, 500);
			arrivalTimers.current.set(key, timer);
		}
	});
	useEffect(() => () => {
		for (const timer of arrivalTimers.current.values()) clearTimeout(timer);
		arrivalTimers.current.clear();
	}, []);
	if (total === 0) return null;
	return <section className="owl-composer-materials" data-expanded={isExpanded} aria-label={copy("count", { n: total })}>
		<ul id={listId} className="owl-composer-materials-list" tabIndex={isExpanded ? 0 : undefined}>
			{visible.map((item, index) => <li key={item.key} className="owl-composer-material" data-kind={item.kind} data-arriving={arrivingKeys.has(item.key) || undefined} style={{ "--owl-material-arrival-delay": `${Math.min(index, 3) * 35}ms` } as CSSProperties}>
				{item.kind === "image" ? <>
					<button type="button" className="owl-composer-material-preview" aria-label={copy("previewImage", { n: item.index + 1 })} title={copy("previewImage", { n: item.index + 1 })} onClick={() => onPreview(item.image)}><img src={`data:${item.image.mimeType};base64,${item.image.data}`} alt="" /></button>
					<button type="button" className="owl-composer-material-remove" aria-label={copy("removeImage", { n: item.index + 1 })} title={copy("removeImage", { n: item.index + 1 })} onClick={() => onRemoveImage(item.image.id)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
				</> : <>
					<span className="owl-composer-material-file" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></svg></span>
					<div className="owl-composer-material-copy">
						<span className="owl-composer-material-name" title={item.file.path}>{item.file.basename}</span>
						{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus reveals the complete truncated path. */}
						<span className="owl-composer-material-path" tabIndex={0} title={item.file.path}>{item.file.path}</span>
					</div>
					<button type="button" className="owl-composer-material-remove" aria-label={copy("removeFile", { path: item.file.path })} title={copy("removeFile", { path: item.file.path })} onClick={() => onRemoveFile(item.file.path)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
				</>}
			</li>)}
		</ul>
		{total > 3 && <button type="button" className="owl-composer-materials-toggle" aria-label={copy(isExpanded ? "collapse" : "expand", { n: total })} title={copy(isExpanded ? "collapse" : "expand", { n: total })} aria-expanded={isExpanded} aria-controls={listId} onClick={() => setExpanded((value) => !value)}>{isExpanded ? copy("collapse") : copy("more", { n: total - visible.length })}</button>}
	</section>;
}
