export interface PointerDragHandlers {
	cursor: "col-resize" | "row-resize" | "grabbing";
	onMove(event: PointerEvent): void;
	onFinish(cancelled: boolean): void;
}

/** Keep one gesture in the parent document even when it crosses an embedded editor. */
export function startPointerDrag(
	target: HTMLElement,
	event: PointerEvent,
	handlers: PointerDragHandlers,
): () => void {
	const document = target.ownerDocument;
	const view = document.defaultView;
	if (!view || event.button !== 0 || !event.isPrimary) return () => {};
	event.preventDefault();
	const pointerId = event.pointerId;
	const shield = document.createElement("div");
	shield.dataset.workbenchDragShield = "";
	shield.setAttribute("data-tauri-drag-region", "false");
	shield.setAttribute("aria-hidden", "true");
	Object.assign(shield.style, {
		position: "fixed", inset: "0", zIndex: "2147483647", cursor: handlers.cursor,
		touchAction: "none", userSelect: "none",
	});
	const previousCursor = document.body.style.cursor;
	const previousSelection = document.body.style.userSelect;
	document.body.style.cursor = handlers.cursor;
	document.body.style.userSelect = "none";
	document.body.append(shield);
	let finished = false;
	const finish = (cancelled: boolean, finalEvent?: PointerEvent): void => {
		if (finished) return;
		finished = true;
		try {
			if (!cancelled && finalEvent) handlers.onMove(finalEvent);
		} finally {
			view.removeEventListener("pointermove", move, true);
			view.removeEventListener("pointerup", up, true);
			view.removeEventListener("pointercancel", cancel, true);
			view.removeEventListener("blur", blur);
			target.removeEventListener("lostpointercapture", lost);
			shield.remove();
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousSelection;
			if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
			handlers.onFinish(cancelled);
		}
	};
	const move = (next: PointerEvent): void => {
		if (next.pointerId !== pointerId) return;
		if (next.pointerType === "mouse" && (next.buttons & 1) === 0) { finish(true); return; }
		next.preventDefault();
		handlers.onMove(next);
	};
	const up = (next: PointerEvent): void => {
		if (next.pointerId === pointerId) finish(false, next);
	};
	const cancel = (next: PointerEvent): void => {
		if (next.pointerId === pointerId) finish(true);
	};
	const blur = (): void => finish(true);
	const lost = (next: PointerEvent): void => {
		if (next.pointerId === pointerId) finish(true);
	};
	view.addEventListener("pointermove", move, { capture: true, passive: false });
	view.addEventListener("pointerup", up, true);
	view.addEventListener("pointercancel", cancel, true);
	view.addEventListener("blur", blur);
	target.addEventListener("lostpointercapture", lost);
	try { target.setPointerCapture(pointerId); }
	catch { /* The shield still fences if capture is unavailable during a window transition. */ }
	return () => finish(true);
}
