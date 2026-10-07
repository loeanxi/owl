import { describe, expect, it } from "vitest";
import { mirrorContentPoint, validMirrorCrop } from "./mirror-geometry.ts";

describe("mirror content coordinates", () => {
	it("excludes letterbox areas and the exclusive bottom/right edge", () => {
		const bounds = { x: 10, y: 20, width: 800, height: 800 };
		expect(mirrorContentPoint(bounds, 800, 400, 410, 100)).toBeUndefined();
		expect(mirrorContentPoint(bounds, 800, 400, 410, 220)).toEqual({ u: 0.5, v: 0 });
		expect(mirrorContentPoint(bounds, 800, 400, 810, 420)).toBeUndefined();
		expect(mirrorContentPoint(bounds, 800, 400, 410, 620)).toBeUndefined();
	});
	it("clamps captured drags outside the panel so button-up can still be forwarded", () => {
		const point = mirrorContentPoint({ x: 100, y: 100, width: 600, height: 300 }, 800, 400, 2000, -500, true)!;
		expect(point.u).toBeGreaterThan(0.999);
		expect(point.u).toBeLessThan(1);
		expect(point.v).toBe(0);
	});
	it("maps the same content point consistently after resize without a DPR multiplier", () => {
		expect(mirrorContentPoint({ x: 0, y: 0, width: 800, height: 400 }, 800, 400, 200, 300)).toEqual({
			u: 0.25,
			v: 0.75,
		});
		expect(mirrorContentPoint({ x: 100, y: 50, width: 400, height: 400 }, 800, 400, 200, 300)).toEqual({
			u: 0.25,
			v: 0.75,
		});
	});
	it("rejects hidden and non-finite geometry even during a drag", () => {
		expect(mirrorContentPoint({ x: 0, y: 0, width: 0, height: 400 }, 800, 400, 10, 10, true)).toBeUndefined();
		expect(
			mirrorContentPoint({ x: 0, y: 0, width: 800, height: 400 }, 800, 400, Number.NaN, 10, true),
		).toBeUndefined();
	});
	it("accepts only complete crop regions within the encoded frame", () => {
		expect(validMirrorCrop(906, 547, { x: 4, y: 40, width: 843, height: 472 })).toBe(true);
		expect(validMirrorCrop(800, 547, { x: 4, y: 40, width: 843, height: 472 })).toBe(false);
		expect(validMirrorCrop(906, 547, { x: -1, y: 40, width: 843, height: 472 })).toBe(false);
		expect(validMirrorCrop(906, 547, { x: 4, y: 40, width: 0, height: 472 })).toBe(false);
		expect(validMirrorCrop(906, 547, { x: 4, y: 40, width: Number.POSITIVE_INFINITY, height: 472 })).toBe(false);
	});
});
