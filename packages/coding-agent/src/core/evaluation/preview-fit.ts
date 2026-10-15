/** Pure SVG preview sizing shared by the desktop preview and the browser checker. Safe to import in browser code. */
export interface EvaluationSvgAspect {
	width: number;
	height: number;
}

function pixels(value: string | null): number | null {
	const match = value?.match(/^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i)?.[1];
	const number = match ? Number(match) : Number.NaN;
	return Number.isFinite(number) && number > 0 ? number : null;
}

/** The drawing's own aspect ratio, from its viewBox or, failing that, from plain pixel width and height. */
export function evaluationSvgAspect(
	viewBox: string | null,
	width: string | null,
	height: string | null,
): EvaluationSvgAspect | null {
	const box = viewBox
		?.trim()
		.split(/[\s,]+/)
		.map(Number);
	if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0)
		return { width: box[2], height: box[3] };
	const w = pixels(width);
	const h = pixels(height);
	return w && h ? { width: w, height: h } : null;
}

/**
 * SVG clips to the element box, not the viewBox. A box wider than the viewBox ratio would show drawing that lies
 * outside the viewBox, which the artifact never shows at its natural size; the box therefore keeps the viewBox ratio.
 */
export function evaluationSvgFitSize(aspect: EvaluationSvgAspect): { width: string; height: string } {
	return {
		width: `min(100vw, calc(100vh * ${aspect.width} / ${aspect.height}))`,
		height: `min(100vh, calc(100vw * ${aspect.height} / ${aspect.width}))`,
	};
}
