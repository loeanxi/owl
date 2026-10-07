import type { MirrorInputRequest, MirrorProjectionGeometry } from "../protocol.ts";

export interface ProjectionPointer {
	action: MirrorInputRequest["action"];
	x: number;
	y: number;
	deltaY: number;
}

/** The JPEG includes the app frame; Windows mouse messages use client pixels. */
export function projectionPointer(
	geometry: MirrorProjectionGeometry,
	request: MirrorInputRequest,
	clientOffset: { x: number; y: number },
): ProjectionPointer {
	if (!["click", "down", "move", "up", "wheel", "cancel"].includes(request.action)) {
		throw new Error("Unsupported mirror input action");
	}
	if (request.action === "cancel") return { action: "cancel", x: 0, y: 0, deltaY: 0 };
	if (request.geometryId !== geometry.geometryId) throw new Error("Mirror geometry changed; wait for the next frame");
	if (![request.u, request.v].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
		throw new Error("Mirror input is outside the short-drama content");
	}
	if (request.deltaY !== undefined && !Number.isFinite(request.deltaY)) throw new Error("Invalid mirror wheel delta");
	const { crop } = geometry;
	return {
		action: request.action,
		x: Math.round(crop.x + request.u * (crop.width - 1) - clientOffset.x),
		y: Math.round(crop.y + request.v * (crop.height - 1) - clientOffset.y),
		deltaY: Math.max(-32767, Math.min(32767, Math.round(request.deltaY ?? 0))),
	};
}
