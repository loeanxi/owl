export interface MapFocus {
	x: number;
	y: number;
}

export interface MapWorldLayout {
	width: number;
	height: number;
	left: number;
	top: number;
}

/** Keeps the 900 × 820 illustrated map and its percentage-based markers in one shared world. */
export function mapWorldLayout(width: number, height: number, zoom: number, focus: MapFocus): MapWorldLayout {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return { width: 0, height: 0, left: 0, top: 0 };
	}
	const safeZoom = Number.isFinite(zoom) ? Math.min(1.45, Math.max(0.85, zoom)) : 1;
	const scale = Math.max(width / 900, height / 820) * safeZoom;
	const worldWidth = 900 * scale;
	const worldHeight = 820 * scale;
	const focusX = Number.isFinite(focus.x) ? Math.min(100, Math.max(0, focus.x)) / 100 : 0.5;
	const focusY = Number.isFinite(focus.y) ? Math.min(100, Math.max(0, focus.y)) / 100 : 0.5;
	return {
		width: worldWidth,
		height: worldHeight,
		left: axisOffset(width, worldWidth, focusX),
		top: axisOffset(height, worldHeight, focusY),
	};
}

function axisOffset(viewport: number, world: number, focus: number): number {
	if (world < viewport) return (viewport - world) / 2;
	return Math.min(0, Math.max(viewport - world, viewport / 2 - focus * world));
}
