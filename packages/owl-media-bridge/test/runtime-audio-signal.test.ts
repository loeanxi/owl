import { describe, expect, it, vi } from "vitest";
import { BridgeRuntime } from "../src/bridge-runtime.ts";
import type { AudioSignalProvider, AudioSignalReading } from "../src/domain/audio-signal.ts";
import type { MediaBridge } from "../src/domain/media-bridge.ts";
import type { BridgeStatus } from "../src/domain/types.ts";

function statusOf(state: "playing" | "paused" | "unavailable"): BridgeStatus {
	return {
		playerId: "qq-music",
		playerName: "QQ 音乐",
		state,
		capabilities: { playPause: true, next: true, previous: true, seek: false, volume: false },
	};
}

function liveReading(): AudioSignalReading {
	return {
		active: true,
		starting: false,
		unsupportedOs: false,
		frames: [{ at: 1, rms: 0.5, peak: 0.8, bands: [0.2, 0.9] }],
		targetProcesses: 1,
		activeTargetProcesses: 1,
	};
}

interface ProviderSpy extends AudioSignalProvider {
	requested: string[];
	stoppedCount: number;
	disposedCount: number;
	next: AudioSignalReading;
}

function providerSpy(initial: AudioSignalReading): ProviderSpy {
	const spy: ProviderSpy = {
		requested: [],
		stoppedCount: 0,
		disposedCount: 0,
		next: initial,
		request(playerId) {
			spy.requested.push(playerId);
		},
		stop() {
			spy.stoppedCount += 1;
		},
		read() {
			return spy.next;
		},
		dispose() {
			spy.disposedCount += 1;
		},
	};
	return spy;
}

function createBridge(status: () => BridgeStatus): MediaBridge {
	return {
		currentPlayerId: () => status().playerId,
		listPlayers: () => [{ id: status().playerId, displayName: status().playerName }],
		selectPlayer: () => undefined,
		status: vi.fn(async () => status()),
	} as unknown as MediaBridge;
}

describe("BridgeRuntime.signalForUi", () => {
	it("never starts capture while the real-wave opt-in is off", async () => {
		const provider = providerSpy(liveReading());
		const current = statusOf("playing");
		const runtime = new BridgeRuntime(
			createBridge(() => current),
			{ playerId: "qq-music" },
			0,
			{},
			undefined,
			undefined,
			provider,
		);
		const view = await runtime.signalForUi();
		expect(view.reason).toBe("disabled");
		expect(view.source).toBe("synthetic");
		expect(provider.requested).toEqual([]);
	});

	it("drives the seam only for the selected player while playing", async () => {
		const provider = providerSpy(liveReading());
		const current = statusOf("playing");
		const runtime = new BridgeRuntime(
			createBridge(() => current),
			{ playerId: "qq-music", realWaveEnabled: true },
			0,
			{},
			undefined,
			undefined,
			provider,
		);
		const view = await runtime.signalForUi();
		expect(view.reason).toBe("capturing");
		expect(view.source).toBe("process");
		expect(view.frames.length).toBe(1);
		expect(provider.requested).toEqual(["qq-music"]);
		await runtime.signalForUi();
		expect(provider.requested).toEqual(["qq-music", "qq-music"]);
	});

	it("ends the capture scope when playback pauses instead of keeping it live", async () => {
		const provider = providerSpy(liveReading());
		let current = statusOf("playing");
		const runtime = new BridgeRuntime(
			createBridge(() => current),
			{ playerId: "qq-music", realWaveEnabled: true },
			0,
			{},
			undefined,
			undefined,
			provider,
		);
		await runtime.signalForUi();
		current = statusOf("paused");
		const paused = await runtime.signalForUi();
		expect(paused.reason).toBe("paused");
		expect(paused.frames).toEqual([]);
		expect(provider.stoppedCount).toBe(1);
	});

	it("stops the provider on player switch and on disable", () => {
		const provider = providerSpy({
			active: false,
			starting: true,
			unsupportedOs: false,
			frames: [],
			targetProcesses: 0,
			activeTargetProcesses: 0,
		});
		const current = statusOf("playing");
		const runtime = new BridgeRuntime(
			createBridge(() => current),
			{ playerId: "qq-music", realWaveEnabled: true },
			0,
			{},
			undefined,
			undefined,
			provider,
		);

		runtime.updateConfig({ realWaveEnabled: false });
		expect(provider.stoppedCount).toBe(1);

		runtime.updateConfig({ realWaveEnabled: true, playerId: "netease-music" });
		expect(provider.stoppedCount).toBe(2);
	});

	it("reuses the cached status so the signal route adds no adapter polls", async () => {
		const provider = providerSpy(liveReading());
		const current = statusOf("playing");
		const bridge = createBridge(() => current);
		const runtime = new BridgeRuntime(
			bridge,
			{ playerId: "qq-music", realWaveEnabled: true },
			500,
			{},
			undefined,
			undefined,
			provider,
		);
		await runtime.status();
		await runtime.signalForUi();
		expect((bridge.status as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
	});

	it("disposes the provider with the focus teardown path", async () => {
		const provider = providerSpy(liveReading());
		const current = statusOf("playing");
		const runtime = new BridgeRuntime(
			createBridge(() => current),
			{ playerId: "qq-music", realWaveEnabled: true },
			0,
			{},
			undefined,
			undefined,
			provider,
		);
		await runtime.dispose();
		expect(provider.disposedCount).toBe(1);
	});
});
