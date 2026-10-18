import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useImageViewerText } from "./image-viewer-copy.ts";
import "./image-viewer.css";

export type ImageViewerItem = { src: string; alt: string };

/** The native top layer and body portal keep images outside chat masks and scrolling containers. */
export function ImageViewer({ images, index, onIndexChange, onClose }: {
	images: readonly ImageViewerItem[];
	index: number;
	onIndexChange: (index: number) => void;
	onClose: () => void;
}): React.JSX.Element | null {
	const text = useImageViewerText();
	const helpId = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const imageElement = useRef<HTMLImageElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const keyboard = useRef<(event: KeyboardEvent) => void>(() => {});
	const wheel = useRef<(event: WheelEvent) => void>(() => {});
	const image = images[index];
	const source = image?.src;
	const sourceRef = useRef(source);
	sourceRef.current = source;
	const [natural, setNatural] = useState<{ source: string; width: number; height: number }>();
	const [viewport, setViewport] = useState({ width: 0, height: 0 });
	const [scale, setScale] = useState(1);
	const [fitted, setFitted] = useState(true);
	const [failed, setFailed] = useState<string>();
	const [attempt, setAttempt] = useState(0);
	const drag = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | undefined>(undefined);
	const dragged = useRef(false);
	const backdropDown = useRef<boolean | undefined>(undefined);
	const imagePressed = useRef(false);
	const anchor = useRef<{ x: number; y: number; viewportX: number; viewportY: number } | undefined>(undefined);
	const currentNatural = natural?.source === source ? natural : undefined;
	const ready = Boolean(currentNatural) && failed !== source;
	const gallery = images.length > 1;
	const fitScale = currentNatural
		? Math.min(1, Math.max(1, viewport.width - (gallery ? 128 : 48)) / currentNatural.width, Math.max(1, viewport.height - 48) / currentNatural.height)
		: 1;
	const minScale = Math.min(0.1, fitScale);

	useLayoutEffect(() => {
		const element = dialog.current;
		if (!element) return;
		const previousFocus = document.activeElement;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		element.showModal();
		closeButton.current?.focus({ preventScroll: true });
		const handleKey = (event: KeyboardEvent): void => {
			if (!element.open) return;
			event.stopPropagation();
			keyboard.current(event);
		};
		const handleWheel = (event: WheelEvent): void => {
			event.preventDefault();
			event.stopPropagation();
			wheel.current(event);
		};
		document.addEventListener("keydown", handleKey, true);
		element.addEventListener("wheel", handleWheel, { passive: false });
		return () => {
			document.removeEventListener("keydown", handleKey, true);
			element.removeEventListener("wheel", handleWheel);
			if (element.open) element.close();
			document.body.style.overflow = previousOverflow;
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
		};
	}, []);

	useLayoutEffect(() => {
		const element = stage.current;
		if (!element) return;
		const measure = (): void => setViewport({ width: element.clientWidth, height: element.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useLayoutEffect(() => {
		setFitted(true);
		setFailed(undefined);
		setAttempt(0);
		anchor.current = undefined;
		drag.current = undefined;
		dragged.current = false;
	}, [source, index]);

	useLayoutEffect(() => {
		if (!currentNatural) return;
		if (fitted) {
			setScale(fitScale);
			if (stage.current) { stage.current.scrollLeft = 0; stage.current.scrollTop = 0; }
		}
	}, [fitted, fitScale, currentNatural]);

	useLayoutEffect(() => {
		const position = anchor.current;
		const element = stage.current;
		const picture = imageElement.current;
		if (!position || !element || !picture) return;
		const bounds = element.getBoundingClientRect();
		const imageBounds = picture.getBoundingClientRect();
		element.scrollLeft += imageBounds.left - bounds.left + position.x * scale - position.viewportX;
		element.scrollTop += imageBounds.top - bounds.top + position.y * scale - position.viewportY;
		anchor.current = undefined;
	}, [scale]);

	const zoom = (value: number, clientX?: number, clientY?: number): void => {
		const element = stage.current;
		const picture = imageElement.current;
		if (!ready || !element || !picture) return;
		const next = Math.min(8, Math.max(minScale, value));
		if (Math.abs(next - scale) < 0.00001) return;
		const bounds = element.getBoundingClientRect();
		const imageBounds = picture.getBoundingClientRect();
		const x = clientX ?? bounds.left + element.clientWidth / 2;
		const y = clientY ?? bounds.top + element.clientHeight / 2;
		anchor.current = { x: (x - imageBounds.left) / scale, y: (y - imageBounds.top) / scale, viewportX: x - bounds.left, viewportY: y - bounds.top };
		setFitted(false);
		setScale(next);
	};
	const fit = (): void => { anchor.current = undefined; setFitted(true); setScale(fitScale); if (stage.current) { stage.current.scrollLeft = 0; stage.current.scrollTop = 0; } };
	const move = (offset: number): void => { const next = index + offset; if (next >= 0 && next < images.length) onIndexChange(next); };
	keyboard.current = (event) => {
		if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
		if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(scale * 1.25); }
		else if (event.key === "-") { event.preventDefault(); zoom(scale / 1.25); }
		else if (event.key === "0") { event.preventDefault(); fit(); }
		else if (event.key === "1") { event.preventDefault(); zoom(1); }
		else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			const element = stage.current;
			if (element) element.scrollTo({ top: event.key === "Home" ? 0 : Math.max(0, element.scrollHeight - element.clientHeight), behavior: "instant" });
		}
		else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && gallery) { event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1); }
		else if (event.key.startsWith("Arrow")) {
			event.preventDefault();
			stage.current?.scrollBy({ left: event.key === "ArrowLeft" ? -80 : event.key === "ArrowRight" ? 80 : 0, top: event.key === "ArrowUp" ? -80 : event.key === "ArrowDown" ? 80 : 0, behavior: "instant" });
		}
	};
	wheel.current = (event) => {
		if (!stage.current?.contains(event.target as Node)) return;
		const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1);
		zoom(scale * Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002), event.clientX, event.clientY);
	};

	if (!image) return null;
	return createPortal(
		<dialog ref={dialog} className="owl-image-viewer" aria-label={text("title")} aria-describedby={helpId} aria-modal="true"
			onCancel={(event) => { event.preventDefault(); onCloseRef.current(); }}
			onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
			<header className="owl-image-viewer-toolbar">
				<div className="owl-image-viewer-heading"><span>{text("title")}</span><span className="owl-image-viewer-count" aria-live="polite">{index + 1} / {images.length}</span></div>
				<div className="owl-image-viewer-controls" role="group" aria-label={text("title")}>
					<button type="button" onClick={() => zoom(scale / 1.25)} disabled={!ready || scale <= minScale} aria-label={text("zoomOut")} title={`${text("zoomOut")} (−)`}><svg viewBox="0 0 24 24"><path d="M5 12h14" /></svg></button>
					<output className="owl-image-viewer-scale" aria-live="polite">{Math.round(scale * 100)}%</output>
					<button type="button" onClick={() => zoom(scale * 1.25)} disabled={!ready || scale >= 8} aria-label={text("zoomIn")} title={`${text("zoomIn")} (+)`}><svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14" /></svg></button>
					<span className="owl-image-viewer-divider" />
					<button type="button" className="owl-image-viewer-fit" onClick={fit} disabled={!ready} aria-pressed={fitted} aria-label={text("fit")} title={`${text("fit")} (0)`}><svg viewBox="0 0 24 24"><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" /></svg><span>{text("fit")}</span></button>
					<button type="button" className="owl-image-viewer-actual" onClick={() => zoom(1)} disabled={!ready} aria-label={text("actual")} title={`${text("actual")} (1)`}>100%</button>
				</div>
				<button ref={closeButton} type="button" className="owl-image-viewer-close" onClick={onClose} aria-label={text("close")} title={`${text("close")} (Esc)`}><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
			</header>
			<div className="owl-image-viewer-workspace">
				<div ref={stage} className="owl-image-viewer-stage" tabIndex={0} data-gallery={gallery || undefined} data-zoomed={ready && scale > fitScale + 0.001 || undefined}
					onClick={(event) => { const blank = event.target === event.currentTarget || event.target instanceof HTMLElement && event.target.classList.contains("owl-image-viewer-canvas"); if (!dragged.current && backdropDown.current !== false && blank) onClose(); backdropDown.current = undefined; }}
					onDoubleClick={(event) => { if (!dragged.current && (event.target === imageElement.current || imagePressed.current)) { if (fitted) zoom(Math.max(1, fitScale * 2), event.clientX, event.clientY); else fit(); } }}
					onPointerDown={(event) => {
						dragged.current = false;
						imagePressed.current = event.target === imageElement.current;
						backdropDown.current = event.target === event.currentTarget || event.target instanceof HTMLElement && event.target.classList.contains("owl-image-viewer-canvas");
						const element = event.currentTarget;
						if (event.button !== 0 || element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1) return;
						drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
						element.setPointerCapture(event.pointerId);
						element.dataset.dragging = "true";
						element.focus({ preventScroll: true });
					}}
					onPointerMove={(event) => {
						const start = drag.current;
						if (!start || start.pointer !== event.pointerId) return;
						if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) dragged.current = true;
						event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
						event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
					}}
					onPointerUp={(event) => { drag.current = undefined; delete event.currentTarget.dataset.dragging; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
					onPointerCancel={(event) => { drag.current = undefined; dragged.current = true; delete event.currentTarget.dataset.dragging; }}>
					<div className="owl-image-viewer-canvas">
						<img key={`${image.src}:${attempt}`} ref={imageElement} src={image.src} alt={image.alt} draggable={false} className="owl-image-viewer-image"
							style={{ width: currentNatural ? currentNatural.width * scale : undefined, height: currentNatural ? currentNatural.height * scale : undefined, visibility: ready ? "visible" : "hidden" }}
							onLoad={(event) => { const element = event.currentTarget; if (element !== imageElement.current || element.getAttribute("src") !== sourceRef.current) return; if (element.naturalWidth > 0 && element.naturalHeight > 0) setNatural({ source: image.src, width: element.naturalWidth, height: element.naturalHeight }); }}
							onError={(event) => { if (event.currentTarget === imageElement.current) setFailed(image.src); }} />
					</div>
				</div>
				{!ready && <div className="owl-image-viewer-status" role="status">{failed === source ? <><span>{text("failed")}</span><button type="button" onClick={() => { setFailed(undefined); setNatural(undefined); setAttempt((value) => value + 1); }}>{text("retry")}</button></> : text("loading")}</div>}
				{gallery && <><button type="button" className="owl-image-viewer-nav is-previous" onClick={() => move(-1)} disabled={index === 0} aria-label={text("previous")} title={text("previous")}><svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></svg></button><button type="button" className="owl-image-viewer-nav is-next" onClick={() => move(1)} disabled={index === images.length - 1} aria-label={text("next")} title={text("next")}><svg viewBox="0 0 24 24"><path d="m10 6 6 6-6 6" /></svg></button></>}
			</div>
			<footer className="owl-image-viewer-footer" id={helpId}><span className="owl-image-viewer-help">{text("help")}{gallery && <span className="owl-image-viewer-gallery-help"> · {text("galleryHelp")}</span>}</span><span className="owl-image-viewer-compact-help">{text("compactHelp")}</span>{currentNatural && <span>{currentNatural.width} × {currentNatural.height}</span>}</footer>
		</dialog>, document.body,
	);
}
