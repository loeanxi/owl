import { describe, expect, it } from "vitest";
import type { AdapterDiagnostics } from "../src/domain/diagnostics.ts";
import { MediaBridge, MediaBridgeError } from "../src/domain/media-bridge.ts";
import type { PlayerAdapter } from "../src/domain/player-adapter.ts";
import { type BridgeStatus, type MediaCommand, NO_CAPABILITIES } from "../src/domain/types.ts";

function status(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
	return {
		playerId: "qq-music",
		playerName: "QQ 音乐",
		state: "paused",
		capabilities: { ...NO_CAPABILITIES, playPause: true },
		...overrides,
	};
}

class FakeAdapter implements PlayerAdapter {
	readonly id = "qq-music";
	readonly displayName = "QQ 音乐";
	readonly calls: MediaCommand[] = [];

	private current: BridgeStatus;

	constructor(current: BridgeStatus = status()) {
		this.current = current;
	}

	async readStatus(): Promise<BridgeStatus> {
		return this.current;
	}

	async execute(command: MediaCommand): Promise<void> {
		this.calls.push(command);
		if (command.kind === "play-pause") {
			this.current = { ...this.current, state: this.current.state === "playing" ? "paused" : "playing" };
		}
	}
}

describe("MediaBridge", () => {
	it("returns a fresh state after a supported command", async () => {
		const adapter = new FakeAdapter();
		const bridge = new MediaBridge([adapter]);

		await expect(bridge.control({ kind: "play-pause" })).resolves.toMatchObject({ state: "playing" });
		expect(adapter.calls).toEqual([{ kind: "play-pause" }]);
	});

	it("captures the exact authorization and result states in a control receipt", async () => {
		const adapter = new FakeAdapter(status({ state: "paused" }));
		const bridge = new MediaBridge([adapter]);

		await expect(bridge.controlWithReceipt({ kind: "play-pause" })).resolves.toMatchObject({
			before: { state: "paused" },
			after: { state: "playing" },
		});
	});

	it("never falls back from the configured player to another adapter", async () => {
		const netease: PlayerAdapter = {
			id: "netease-music",
			displayName: "网易云音乐",
			readStatus: async () => status({ playerId: "netease-music", playerName: "网易云音乐" }),
			execute: async () => undefined,
		};

		const bridge = new MediaBridge([netease]);
		await expect(bridge.status()).rejects.toMatchObject({ code: "PLAYER_NOT_CONFIGURED" });
	});

	it("lists every registered player for the settings picker", () => {
		const qq = new FakeAdapter(status());
		const netease: PlayerAdapter = {
			id: "netease-music",
			displayName: "网易云音乐",
			readStatus: async () => status({ playerId: "netease-music", playerName: "网易云音乐" }),
			execute: async () => undefined,
		};

		const bridge = new MediaBridge([qq, netease]);
		expect(bridge.listPlayers()).toEqual([
			{ id: "qq-music", displayName: "QQ 音乐" },
			{ id: "netease-music", displayName: "网易云音乐" },
		]);
	});

	it("switches the explicit player selection and reads it through", async () => {
		const qq = new FakeAdapter(status());
		const netease: PlayerAdapter = {
			id: "netease-music",
			displayName: "网易云音乐",
			readStatus: async () => status({ playerId: "netease-music", playerName: "网易云音乐", state: "playing" }),
			execute: async () => undefined,
		};

		const bridge = new MediaBridge([qq, netease], "qq-music");
		expect(bridge.currentPlayerId()).toBe("qq-music");

		bridge.selectPlayer("netease-music");
		expect(bridge.currentPlayerId()).toBe("netease-music");
		await expect(bridge.status()).resolves.toMatchObject({ playerId: "netease-music", playerName: "网易云音乐" });
	});

	it("rejects an unknown player selection instead of falling back", () => {
		const adapter = new FakeAdapter(status());
		const bridge = new MediaBridge([adapter]);

		expect(() => bridge.selectPlayer("unknown-player")).toThrowError(
			new MediaBridgeError("PLAYER_NOT_CONFIGURED", 'No adapter is configured for player "unknown-player".'),
		);
		expect(bridge.currentPlayerId()).toBe("qq-music");
	});

	it("rejects an operation not published by the selected player", async () => {
		const adapter = new FakeAdapter(status({ capabilities: NO_CAPABILITIES }));
		const bridge = new MediaBridge([adapter]);

		await expect(bridge.control({ kind: "next" })).rejects.toMatchObject({ code: "COMMAND_UNAVAILABLE" });
		expect(adapter.calls).toEqual([]);
	});

	it("rejects invalid range values before reaching an adapter", async () => {
		const adapter = new FakeAdapter(status({ capabilities: { ...NO_CAPABILITIES, volume: true } }));
		const bridge = new MediaBridge([adapter]);

		await expect(bridge.control({ kind: "set-volume", volumePercent: 101 })).rejects.toMatchObject({
			code: "INVALID_COMMAND",
		});
		expect(adapter.calls).toEqual([]);
	});
});

class DiagnoseAdapter implements PlayerAdapter {
	readonly id = "qq-music";
	readonly displayName = "QQ 音乐";

	private readonly probes: AdapterDiagnostics;
	private readonly failReads: boolean;
	private readonly throwDuringDiagnose: boolean;

	constructor(probes: AdapterDiagnostics = {}, failReads = false, throwDuringDiagnose = false) {
		this.probes = probes;
		this.failReads = failReads;
		this.throwDuringDiagnose = throwDuringDiagnose;
	}

	async readStatus(): Promise<BridgeStatus> {
		if (this.failReads) throw new Error("powershell.exe is missing while loading C:\\Windows\\System32\\bridge.ps1");
		return status({ track: { title: "秘密歌曲", artist: "某歌手" }, metadataState: "ready" });
	}

	async execute(): Promise<void> {}

	async diagnose(_signal?: AbortSignal): Promise<AdapterDiagnostics> {
		if (this.throwDuringDiagnose) throw new Error("probe exploded");
		return this.probes;
	}
}

describe("MediaBridge.diagnose", () => {
	it("aggregates adapter probes with read telemetry and observed metadata state", async () => {
		const adapter = new DiagnoseAdapter({
			process: { found: true, processCount: 1, names: ["QQMusic"] },
			mediaSession: { matchingSessions: 1, totalSessions: 2 },
			audioSession: { found: true, volumePercent: 30 },
			worker: { alive: true },
		});
		const bridge = new MediaBridge([adapter]);
		await bridge.status();

		const diagnostics = await bridge.diagnose();
		expect(diagnostics.playerId).toBe("qq-music");
		expect(diagnostics.playerName).toBe("QQ 音乐");
		expect(diagnostics.metadataState).toBe("ready");
		expect(diagnostics.lastStatusRead?.ok).toBe(true);
		expect(diagnostics.probes.mediaSession).toEqual({ matchingSessions: 1, totalSessions: 2 });
		expect(diagnostics.checks.find((item) => item.id === "media-session")?.state).toBe("pass");
		expect(diagnostics.checks.find((item) => item.id === "metadata-enrichment")?.state).toBe("pass");
	});

	it("records failed status reads as sanitized telemetry instead of losing them", async () => {
		const adapter = new DiagnoseAdapter({}, true);
		const bridge = new MediaBridge([adapter]);
		await expect(bridge.status()).rejects.toThrow();

		const diagnostics = await bridge.diagnose();
		expect(diagnostics.lastStatusRead?.ok).toBe(false);
		expect(diagnostics.lastStatusRead?.errorMessage).toBeDefined();
		expect(diagnostics.lastStatusRead?.errorMessage).not.toContain("C:\\");
		expect(diagnostics.checks.find((item) => item.id === "status-read")?.state).toBe("fail");
	});

	it("returns failed checks instead of throwing for an unconfigured player", async () => {
		const bridge = new MediaBridge([new DiagnoseAdapter()], "unknown-player");

		const diagnostics = await bridge.diagnose();
		expect(diagnostics.playerId).toBe("unknown-player");
		expect(diagnostics.playerName).toBeUndefined();
		const configured = diagnostics.checks.at(0);
		expect(configured?.id).toBe("player-configured");
		expect(configured?.state).toBe("fail");
	});

	it("degrades to a sanitized note when the adapter probe throws", async () => {
		const bridge = new MediaBridge([new DiagnoseAdapter({}, false, true)]);

		const diagnostics = await bridge.diagnose();
		expect(diagnostics.probes.detail).toBe("probe exploded");
	});
});
