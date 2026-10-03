import { describe, expect, it } from "vitest";
import {
	audioSignalView,
	normalizeAudioSignalFrame,
	normalizeAudioSignalFrames,
	resolveAudioSignalReason,
} from "../src/domain/audio-signal.ts";

describe("normalizeAudioSignalFrame", () => {
	it("clamps amplitude values into 0..1 and keeps peak above rms", () => {
		const frame = normalizeAudioSignalFrame({ at: 5, rms: 1.7, peak: -3, bands: [0.2, 2, -1] });
		expect(frame).toEqual({ at: 5, rms: 1, peak: 1, bands: [0.2, 1, 0] });
	});

	it("drops malformed payloads and non-finite numbers", () => {
		expect(normalizeAudioSignalFrame(null)).toBeUndefined();
		expect(normalizeAudioSignalFrame("nope")).toBeUndefined();
		const frame = normalizeAudioSignalFrame({ rms: Number.NaN, bands: "x" });
		expect(frame).toBeDefined();
		expect(frame!.rms).toBe(0);
		expect(frame!.bands).toEqual([]);
	});

	it("bounds the band array so a hostile helper cannot balloon memory", () => {
		const bands = Array.from({ length: 500 }, (_, index) => index / 500);
		const frame = normalizeAudioSignalFrame({ rms: 0.5, bands });
		expect(frame!.bands.length).toBe(64);
	});
});

describe("normalizeAudioSignalFrames", () => {
	it("keeps only the newest bounded window of frames", () => {
		const raw = Array.from({ length: 40 }, (_, index) => ({ rms: index / 100, bands: [index] }));
		const frames = normalizeAudioSignalFrames(raw);
		expect(frames.length).toBe(24);
		expect(frames[frames.length - 1]!.rms).toBeCloseTo(0.39);
		expect(normalizeAudioSignalFrames(undefined)).toEqual([]);
	});
});

describe("resolveAudioSignalReason", () => {
	const base = { realWaveEnabled: true, providerAvailable: true, state: "playing" as const };

	it("reports disabled and paused before touching capture state", () => {
		expect(resolveAudioSignalReason(undefined, { ...base, realWaveEnabled: false })).toBe("disabled");
		expect(resolveAudioSignalReason(undefined, { ...base, state: "paused" })).toBe("paused");
	});

	it("requires an available provider before declaring any capture scope", () => {
		expect(resolveAudioSignalReason(undefined, { ...base, providerAvailable: false })).toBe("unsupported-os");
	});

	it("surfaces explicit degradation instead of pretending to capture", () => {
		expect(
			resolveAudioSignalReason(
				{
					active: false,
					starting: false,
					unsupportedOs: true,
					frames: [],
					targetProcesses: 0,
					activeTargetProcesses: 0,
				},
				base,
			),
		).toBe("unsupported-os");
		expect(
			resolveAudioSignalReason(
				{
					active: false,
					starting: false,
					unsupportedOs: false,
					failure: "boom",
					frames: [],
					targetProcesses: 0,
					activeTargetProcesses: 0,
				},
				base,
			),
		).toBe("capture-failed");
	});

	it("only reports capturing when frames actually flow from live targets", () => {
		const silentReading = {
			active: false,
			starting: true,
			unsupportedOs: false,
			frames: [],
			targetProcesses: 0,
			activeTargetProcesses: 0,
		};
		expect(resolveAudioSignalReason(silentReading, base)).toBe("starting");
		const liveReading = {
			active: true,
			starting: false,
			unsupportedOs: false,
			frames: [{ at: 1, rms: 0.5, peak: 0.6, bands: [0.5] }],
			targetProcesses: 2,
			activeTargetProcesses: 1,
		};
		expect(resolveAudioSignalReason(liveReading, base)).toBe("capturing");
	});
});

describe("audioSignalView", () => {
	const status = { playerId: "qq-music", playerName: "QQ 音乐", state: "playing" as const };

	it("labels degraded output as synthetic and hides stale frames", () => {
		const reading = {
			active: true,
			starting: false,
			unsupportedOs: true,
			frames: [{ at: 1, rms: 0.5, peak: 0.5, bands: [1] }],
			targetProcesses: 1,
			activeTargetProcesses: 1,
		};
		const view = audioSignalView(status, reading, { realWaveEnabled: true, providerAvailable: true });
		expect(view.source).toBe("synthetic");
		expect(view.reason).toBe("unsupported-os");
		expect(view.frames).toEqual([]);
	});

	it("passes bounded frames through only while enabled and playing", () => {
		const reading = {
			active: true,
			starting: false,
			unsupportedOs: false,
			frames: [{ at: 1, rms: 0.5, peak: 0.7, bands: [0.4] }],
			targetProcesses: 1,
			activeTargetProcesses: 1,
		};
		const view = audioSignalView(status, reading, { realWaveEnabled: true, providerAvailable: true });
		expect(view.source).toBe("process");
		expect(view.frames.length).toBe(1);
		const pausedView = audioSignalView({ ...status, state: "paused" }, reading, {
			realWaveEnabled: true,
			providerAvailable: true,
		});
		expect(pausedView.frames).toEqual([]);
		expect(pausedView.reason).toBe("paused");
	});
});
