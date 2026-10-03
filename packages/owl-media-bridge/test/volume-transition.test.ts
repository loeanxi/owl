import { describe, expect, it } from "vitest";
import {
	MIN_RAMP_DELTA_PERCENT,
	planRampSteps,
	rampTarget,
	resumeStartPercent,
	TRANSITION_DURATIONS_MS,
	TransitionAbortedError,
	volumeDeviated,
} from "../src/volume-transition.ts";

describe("volume transition policy", () => {
	it("plans linear descending steps that land exactly on the target", () => {
		expect(planRampSteps(80, 0, TRANSITION_DURATIONS_MS["pause-fade"], 240)).toEqual([67, 53, 40, 27, 13, 0]);
		expect(planRampSteps(80, 35, TRANSITION_DURATIONS_MS["skip-dip"], 240)).toEqual([58, 35]);
	});

	it("collapses duplicate interpolation points but keeps the exact end value", () => {
		expect(planRampSteps(10, 12, 10_000, 240)).toEqual([10, 11, 12]);
	});

	it("returns no steps when the distance would be imperceptible", () => {
		expect(planRampSteps(50, 51, 1_400, 240)).toEqual([]);
		expect(planRampSteps(50, 50 + MIN_RAMP_DELTA_PERCENT - 1, 1_400, 240)).toEqual([]);
	});

	it("always uses at least two steps for a real ramp regardless of timing", () => {
		expect(planRampSteps(80, 0, 100, 5_000)).toEqual([40, 0]);
	});

	it("clamps interpolation ratios into the closed unit interval", () => {
		expect(rampTarget(20, 80, -1)).toBe(20);
		expect(rampTarget(20, 80, 0.5)).toBe(50);
		expect(rampTarget(20, 80, 2)).toBe(80);
	});

	it("treats only real drift as a manual takeover", () => {
		expect(volumeDeviated(30, 31.4)).toBe(false);
		expect(volumeDeviated(30, 31.6)).toBe(true);
		expect(volumeDeviated(30, undefined)).toBe(false);
	});

	it("starts resumes quietly but never above the target", () => {
		expect(resumeStartPercent(80)).toBe(24);
		expect(resumeStartPercent(20)).toBe(8);
		expect(resumeStartPercent(9)).toBe(8);
		expect(resumeStartPercent(5)).toBe(5);
	});

	it("declares every transition duration up front", () => {
		expect(Object.keys(TRANSITION_DURATIONS_MS).sort()).toEqual(["pause-fade", "resume-rise", "skip-dip"]);
	});

	it("carries the abort reason for callers to branch on", () => {
		const error = new TransitionAbortedError("volume-overridden", "The player volume was changed manually.");
		expect(error.reason).toBe("volume-overridden");
		expect(error.name).toBe("TransitionAbortedError");
	});
});
