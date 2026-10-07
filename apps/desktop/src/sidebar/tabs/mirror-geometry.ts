export interface MirrorRect {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface MirrorPoint {
	u: number;
	v: number;
}

/** CSS pointer coordinates inside an object-contain image; black bars are not interactive. */
export function mirrorContentPoint(
	bounds: MirrorRect,
	width: number,
	height: number,
	x: number,
	y: number,
	clamp = false,
): MirrorPoint | undefined {
	if (![bounds.x, bounds.y, bounds.width, bounds.height, width, height, x, y].every(Number.isFinite)) return undefined;
	if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return undefined;
	const scale = Math.min(bounds.width / width, bounds.height / height);
	const drawnWidth = width * scale;
	const drawnHeight = height * scale;
	const u = (x - bounds.x - (bounds.width - drawnWidth) / 2) / drawnWidth;
	const v = (y - bounds.y - (bounds.height - drawnHeight) / 2) / drawnHeight;
	if (!clamp && (u < 0 || u >= 1 || v < 0 || v >= 1)) return undefined;
	return { u: Math.max(0, Math.min(1 - Number.EPSILON, u)), v: Math.max(0, Math.min(1 - Number.EPSILON, v)) };
}

/** Reject incomplete resize frames before either drawing or forwarding input. */
export function validMirrorCrop(width: number, height: number, crop: MirrorRect): boolean {
	return (
		[width, height, crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) &&
		width > 0 &&
		height > 0 &&
		crop.x >= 0 &&
		crop.y >= 0 &&
		crop.width > 0 &&
		crop.height > 0 &&
		crop.x + crop.width <= width &&
		crop.y + crop.height <= height
	);
}
