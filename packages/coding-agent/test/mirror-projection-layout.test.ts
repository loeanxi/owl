import { describe, expect, it } from "vitest";
import { projectionPointer } from "../src/modes/desktop/mirror/projection-layout.ts";
import type { MirrorInputRequest, MirrorProjectionGeometry } from "../src/modes/desktop/protocol.ts";

const geometry: MirrorProjectionGeometry = {
	geometryId: "projection-one",
	sourceWidth: 906,
	sourceHeight: 547,
	crop: { x: 4, y: 40, width: 843, height: 472 },
};
const click: MirrorInputRequest = {
	type: "mirror.input",
	id: "test",
	windowId: "123",
	geometryId: geometry.geometryId,
	action: "click",
	u: 0,
	v: 0,
};

describe("mirror projection coordinates", () => {
	it("maps all four content corners without reaching the app toolbar", () => {
		expect(projectionPointer(geometry, click, { x: 4, y: 0 })).toMatchObject({ x: 0, y: 40 });
		expect(projectionPointer(geometry, { ...click, u: 1, v: 1 }, { x: 4, y: 0 })).toMatchObject({
			x: 842,
			y: 511,
		});
	});
	it("maps the video center from normalized coordinates into client pixels", () => {
		expect(projectionPointer(geometry, { ...click, u: 0.5, v: 0.5 }, { x: 4, y: 0 })).toMatchObject({
			x: 421,
			y: 276,
		});
	});
	it("rejects stale geometry, invalid points, and nonfinite wheel deltas", () => {
		for (const request of [
			{ ...click, geometryId: "old" },
			{ ...click, u: -0.1 },
			{ ...click, u: Number.NaN },
			{ ...click, v: 1.01 },
			{ ...click, deltaY: Number.POSITIVE_INFINITY },
		]) {
			expect(() => projectionPointer(geometry, request, { x: 4, y: 0 })).toThrow();
		}
	});
	it("allows cancellation from the prior frame to release a held pointer", () => {
		expect(projectionPointer(geometry, { ...click, geometryId: "old", action: "cancel" }, { x: 4, y: 0 })).toEqual({
			action: "cancel",
			x: 0,
			y: 0,
			deltaY: 0,
		});
	});
	it("keeps coalesced wheel magnitude and direction within the signed Windows delta range", () => {
		for (const deltaY of [0, 2, -2, 120, 6000, -6000]) {
			expect(projectionPointer(geometry, { ...click, action: "wheel", deltaY }, { x: 4, y: 0 }).deltaY).toBe(deltaY);
		}
		expect(projectionPointer(geometry, { ...click, action: "wheel", deltaY: 100_000 }, { x: 4, y: 0 }).deltaY).toBe(
			32767,
		);
	});
});
