import { describe, expect, it } from "vitest";
import { BridgeRuntime } from "../src/bridge-runtime.ts";
import type { AdapterDiagnostics } from "../src/domain/diagnostics.ts";
import { MediaBridge } from "../src/domain/media-bridge.ts";
import type { PlayerAdapter } from "../src/domain/player-adapter.ts";
import { type BridgeStatus, type MediaCommand, NO_CAPABILITIES } from "../src/domain/types.ts";

class DiagnosableAdapter implements PlayerAdapter {
	readonly id = "qq-music";
	readonly displayName = "QQ 音乐";

	private readonly probes: AdapterDiagnostics;

	constructor(probes: AdapterDiagnostics = {}) {
		this.probes = probes;
	}

	async readStatus(): Promise<BridgeStatus> {
		return {
			playerId: "qq-music",
			playerName: "QQ 音乐",
			state: "paused",
			capabilities: { ...NO_CAPABILITIES, playPause: true },
			track: { title: "秘密歌曲", artist: "某歌手" },
			metadataState: "ready",
		};
	}

	async execute(_command: MediaCommand): Promise<void> {}

	async diagnose(): Promise<AdapterDiagnostics> {
		return this.probes;
	}
}

const PROBES: AdapterDiagnostics = {
	process: { found: true, processCount: 2, names: ["QQMusic"] },
	mediaSession: { matchingSessions: 1, totalSessions: 3, appUserModelIds: ["QQMusic.exe"] },
	audioSession: { found: true, volumePercent: 42 },
	worker: { alive: false, lastStopReason: "Windows media bridge worker became idle." },
	capabilities: { playPause: true, next: true, previous: true, seek: false, volume: true },
};

describe("BridgeRuntime.diagnoseForUi", () => {
	it("merges config, cache state, and a sanitized report", async () => {
		const runtime = new BridgeRuntime(new MediaBridge([new DiagnosableAdapter(PROBES)]));

		const view = await runtime.diagnoseForUi();

		expect(view.playerId).toBe("qq-music");
		expect(view.config.playerId).toBe("qq-music");
		expect(view.statusCache.fresh).toBe(false);
		expect(view.checks.find((item) => item.id === "media-session")?.state).toBe("pass");
		// The idle worker stop is routine: informational, not a warning.
		expect(view.checks.find((item) => item.id === "powershell-worker")?.state).toBe("info");
		expect(typeof view.report).toBe("string");
	});

	it("reuses the observed status for metadata state and primes the cache", async () => {
		const runtime = new BridgeRuntime(new MediaBridge([new DiagnosableAdapter(PROBES)]));
		await runtime.status();

		const view = await runtime.diagnoseForUi();
		expect(view.metadataState).toBe("ready");
		expect(view.statusCache.fresh).toBe(true);
		expect(view.report).toContain("metadata_state: ready");
	});

	it("never leaks track titles into the copied report", async () => {
		const runtime = new BridgeRuntime(new MediaBridge([new DiagnosableAdapter(PROBES)]), { allowAgentControl: true });
		await runtime.status();

		const view = await runtime.diagnoseForUi();
		expect(view.report).toContain("player_id: qq-music");
		expect(view.report).toContain("[pass] player-process");
		expect(view.report).toContain("allow_agent_control=true");
		expect(view.report).not.toContain("秘密歌曲");
		expect(view.report).not.toContain("某歌手");
		expect(JSON.parse(JSON.stringify(view))).toMatchObject({ playerId: "qq-music" });
	});
});
