import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowsProcessAudioMeter } from "../src/adapters/process-audio-meter.ts";

class FakeMeterChild extends EventEmitter {
	stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
	stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
	stdin = { write: vi.fn() };
	exitCode: number | null = null;
	killed = false;
	kill = vi.fn(() => {
		this.killed = true;
		queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
		return true;
	});

	writeLine(line: string): void {
		this.stdout.emit("data", `${line}\n`);
	}

	crash(): void {
		this.killed = true;
		this.emit("exit", 1, null);
	}
}

function asChildProcess(fake: FakeMeterChild): ChildProcessWithoutNullStreams {
	return fake as unknown as ChildProcessWithoutNullStreams;
}

function frameLine(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ rms: 0.5, peak: 0.7, bands: [0.1, 0.9], targets: 2, active: 1, ...overrides });
}

describe("WindowsProcessAudioMeter", () => {
	let children: FakeMeterChild[];
	let meter: WindowsProcessAudioMeter;

	const createMeter = (options: Record<string, unknown> = {}) => {
		children = [];
		meter = new WindowsProcessAudioMeter({
			spawnProcess: () => {
				const child = new FakeMeterChild();
				children.push(child);
				return asChildProcess(child);
			},
			...options,
		});
		return meter;
	};

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		meter?.dispose();
		vi.useRealTimers();
	});

	it("streams NDJSON frames into a bounded in-memory ring", () => {
		const meter = createMeter();
		meter.request("qq-music");
		for (let index = 0; index < 30; index++) children[0]!.writeLine(frameLine({ rms: index / 100 }));
		const reading = meter.read();
		expect(reading.frames.length).toBe(24);
		expect(reading.frames[reading.frames.length - 1]!.rms).toBeCloseTo(0.29);
		expect(reading.targetProcesses).toBe(2);
		expect(reading.activeTargetProcesses).toBe(1);
		expect(reading.active).toBe(true);
	});

	it("marks the OS unsupported without ever falling back to endpoint capture", () => {
		const meter = createMeter();
		meter.request("qq-music");
		children[0]!.writeLine(
			JSON.stringify({ error: { code: "PROCESS_LOOPBACK_UNSUPPORTED", message: "needs build 19041" } }),
		);
		const reading = meter.read();
		expect(reading.unsupportedOs).toBe(true);
		expect(reading.failure).toContain("19041");
		expect(reading.active).toBe(false);
	});

	it("restarts a crashed helper with backoff and gives up after repeated crashes", () => {
		const meter = createMeter({ restartDelayMs: 10 });
		meter.request("qq-music");

		children[0]!.crash();
		vi.advanceTimersByTime(20);
		children[1]!.crash();
		vi.advanceTimersByTime(20);
		children[2]!.crash();
		vi.advanceTimersByTime(20);

		expect(children.length).toBe(3);
		const reading = meter.read();
		expect(reading.failure).toBeTruthy();
		expect(children.length).toBe(3);
	});

	it("recovers the failure flag once frames flow again", () => {
		const meter = createMeter({ restartDelayMs: 10 });
		meter.request("qq-music");
		children[0]!.writeLine(JSON.stringify({ error: { code: "PROCESS_CAPTURE_FAILED", message: "boom" } }));
		expect(meter.read().failure).toBe("boom");
		children[0]!.writeLine(frameLine());
		expect(meter.read().failure).toBeUndefined();
	});

	it("retargets players by restarting the helper scoped to that player only", () => {
		const spawned: string[] = [];
		const meter = new WindowsProcessAudioMeter({
			spawnProcess: (playerId) => {
				spawned.push(playerId);
				const child = new FakeMeterChild();
				children.push(child);
				return asChildProcess(child);
			},
		});
		children = [];
		meter.request("qq-music");
		meter.request("netease-music");
		expect(spawned).toEqual(["qq-music", "netease-music"]);
		expect(children[0]!.kill).toHaveBeenCalled();
		meter.dispose();
	});

	it("stops capture entirely on stop() and drops buffered frames", () => {
		const meter = createMeter();
		meter.request("qq-music");
		children[0]!.writeLine(frameLine());
		expect(meter.read().frames.length).toBe(1);
		meter.stop();
		const reading = meter.read();
		expect(reading.frames).toEqual([]);
		expect(reading.active).toBe(false);
		expect(children[0]!.kill).toHaveBeenCalled();
	});

	it("auto-stops the helper after the consumer liveness window expires", () => {
		const meter = createMeter({ idleStopMs: 1000 });
		meter.request("qq-music");
		children[0]!.writeLine(frameLine());
		meter.read();
		vi.advanceTimersByTime(1100);
		expect(children[0]!.kill).toHaveBeenCalled();
		// A returning consumer transparently restarts the helper.
		meter.read();
		expect(children.length).toBe(2);
	});
});
