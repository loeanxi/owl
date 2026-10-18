import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationSound } from "./sound.ts";

class FakeParam {
	value = 0;
	setValueAtTime = vi.fn();
	exponentialRampToValueAtTime = vi.fn();
}

class FakeGain {
	gain = new FakeParam();
	connectedTo: unknown[] = [];
	disconnected = false;
	connect(node: unknown) { this.connectedTo.push(node); return node; }
	disconnect() { this.disconnected = true; }
}

class FakeOscillator {
	type = "sine";
	frequency = new FakeParam();
	start = vi.fn();
	stop = vi.fn();
	connect() {}
}

let gains: FakeGain[];
let oscillators: FakeOscillator[];

class FakeAudioContext {
	currentTime = 0;
	state = "running";
	destination = { name: "destination" };
	resume = vi.fn(async () => {});
	createGain() { const gain = new FakeGain(); gains.push(gain); return gain; }
	createOscillator() { const oscillator = new FakeOscillator(); oscillators.push(oscillator); return oscillator; }
}

beforeEach(() => {
	vi.useFakeTimers();
	gains = [];
	oscillators = [];
	vi.stubGlobal("AudioContext", FakeAudioContext);
	// sound.ts 缓存模块级 AudioContext：每个用例重置模块，保证拿到本用例的假 context。
	vi.resetModules();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function load(): Promise<typeof import("./sound.ts")> {
	return await import("./sound.ts");
}

describe("playChime", () => {
	it("stays silent at zero volume", async () => {
		const { playChime } = await load();
		playChime("ding", 0, false);
		expect(gains).toHaveLength(0);
		expect(oscillators).toHaveLength(0);
	});

	it("disconnects the master gain after the last note decays", async () => {
		const { playChime } = await load();
		playChime("bell", 60, false);
		// bell = 基音 + 泛音：2 个振荡器，master 连着扬声器
		expect(oscillators).toHaveLength(2);
		const master = gains[0]!;
		expect(master.connectedTo).toHaveLength(1);
		expect(master.disconnected).toBe(false);
		// 最长音符 0.8s + 0.05s 收尾 + 120ms 余量
		await vi.advanceTimersByTimeAsync(1200);
		expect(master.disconnected).toBe(true);
	});
});

describe("previewChime", () => {
	it("plays both real scenarios back to back for auto", async () => {
		const { previewChime } = await load();
		previewChime("auto", 60);
		expect(oscillators).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(500);
		// 完成单音 + 审批上行双音 = 3 个音符
		expect(oscillators).toHaveLength(3);
	});

	it("plays a fixed style once without the extra critical pass", async () => {
		const { previewChime } = await load();
		previewChime("ding" as NotificationSound, 60);
		expect(oscillators).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(600);
		expect(oscillators).toHaveLength(1);
	});
});
