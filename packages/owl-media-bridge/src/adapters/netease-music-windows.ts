import type { AdapterDiagnostics } from "../domain/diagnostics.ts";
import type { PlayerAdapter, PlayerVolumeLease } from "../domain/player-adapter.ts";
import type { BridgeStatus, MediaCommand, PlayerCapabilities, Track } from "../domain/types.ts";
import { NeteaseMusicCoverResolver, type NeteaseMusicVisuals } from "./netease-music-cover.ts";
import { type PowerShellRunner, type WindowsMediaCommand, WindowsPowerShellRunner } from "./powershell-runner.ts";
import { ProgressiveTrackMetadata } from "./progressive-track-metadata.ts";
import { runWindowsDiagnosis } from "./windows-media-diagnostics.ts";

interface PowerShellStatus {
	readonly playerId: string;
	readonly playerName: string;
	readonly state: "unavailable" | "paused" | "playing";
	readonly track?: Track;
	readonly positionSeconds?: number;
	readonly volumePercent?: number;
	readonly capabilities: PlayerCapabilities;
	readonly detail?: string;
}

/**
 * Windows adapter for the NetEase Cloud Music session explicitly identified
 * as cloudmusic.exe. Talks only to the OS media-session layer; never touches
 * the player's files, login, or process.
 */
export class NeteaseMusicWindowsAdapter implements PlayerAdapter {
	readonly id = "netease-music";
	readonly displayName = "网易云音乐";
	private readonly metadata: ProgressiveTrackMetadata<NeteaseMusicVisuals>;
	private readonly runner: PowerShellRunner;
	constructor(
		runner: PowerShellRunner = new WindowsPowerShellRunner(),
		coverResolver: Pick<NeteaseMusicCoverResolver, "resolve"> = new NeteaseMusicCoverResolver(),
	) {
		this.runner = runner;
		this.metadata = new ProgressiveTrackMetadata((track, signal) => coverResolver.resolve(track, signal), {
			hasValue: (visuals) =>
				Boolean(
					visuals.artworkUrl ||
						visuals.backgroundImageUrls?.length ||
						visuals.lyrics?.length ||
						visuals.durationSeconds,
				),
			refreshAfterMs: (visuals) => (visuals.lyrics === undefined ? 15_000 : 60 * 60 * 1000),
		});
	}

	async launch(signal?: AbortSignal): Promise<void> {
		if (this.runner.launch === undefined) throw new Error("网易云音乐无法自动启动。");
		await this.runner.launch("netease-music", signal);
	}

	async readStatus(signal?: AbortSignal): Promise<BridgeStatus> {
		const status = statusFrom(await this.runner.run("status", undefined, signal, "netease-music"));
		const enrichment = this.metadata.read(status.track);
		if (status.track === undefined || enrichment === undefined) return status;
		const visuals = enrichment.value;
		const artworkUrl = visuals?.artworkUrl ?? status.track.artworkUrl;
		const artistImageUrl = visuals?.artistImageUrl ?? status.track.artistImageUrl;
		const backgroundImageUrls =
			visuals?.backgroundImageUrls ??
			(artworkUrl === undefined
				? undefined
				: artistImageUrl === undefined
					? [artworkUrl]
					: [artistImageUrl, artworkUrl]);
		const durationSeconds =
			status.track.durationSeconds && status.track.durationSeconds > 0
				? status.track.durationSeconds
				: visuals?.durationSeconds;
		return {
			...status,
			backgroundImageUrl: artistImageUrl ?? backgroundImageUrls?.[0] ?? artworkUrl,
			backgroundImageUrls,
			lyrics: visuals?.lyrics,
			metadataState: enrichment.state,
			// Keep the same contract as QQ Music: every status poll is authoritative.
			// The client interpolates only between these fresh media-session samples.
			positionSeconds: status.positionSeconds,
			track: { ...status.track, artworkUrl, artistImageUrl, durationSeconds },
		};
	}

	async execute(command: MediaCommand, signal?: AbortSignal): Promise<void> {
		const mapped = commandToPowerShell(command);
		await this.runner.run(mapped.command, mapped.positionSeconds, signal, "netease-music");
	}

	async armVolumeLease(lease: PlayerVolumeLease, signal?: AbortSignal): Promise<void> {
		await this.runner.armVolumeLease?.({ ...lease, player: this.id }, signal);
	}

	async clearVolumeLease(leaseId: string, signal?: AbortSignal): Promise<void> {
		await this.runner.clearVolumeLease?.(leaseId, signal);
	}

	/** One-shot connection probes for the diagnostics center; failures degrade into data, never throw. */
	async diagnose(signal?: AbortSignal): Promise<AdapterDiagnostics> {
		return await runWindowsDiagnosis(
			this.runner,
			"netease-music",
			{ playerId: "netease-music", playerName: "NetEase Cloud Music" },
			signal,
		);
	}
}

function commandToPowerShell(command: MediaCommand): { command: WindowsMediaCommand; positionSeconds?: number } {
	switch (command.kind) {
		case "play-pause":
			return { command: "play-pause" };
		case "next":
			return { command: "next" };
		case "previous":
			return { command: "previous" };
		case "seek":
			return { command: "seek", positionSeconds: command.positionSeconds };
		case "set-volume":
			return { command: "set-volume", positionSeconds: command.volumePercent };
	}
}

function statusFrom(value: unknown): BridgeStatus {
	if (!isPowerShellStatus(value)) throw new Error("Windows media bridge returned an invalid status payload.");
	return {
		playerId: "netease-music",
		playerName: "网易云音乐",
		state: value.state,
		track: value.track,
		positionSeconds: value.positionSeconds,
		volumePercent: value.volumePercent,
		capabilities: value.capabilities,
		detail: value.detail,
	};
}

function isPowerShellStatus(value: unknown): value is PowerShellStatus {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record.playerId !== "netease-music" || record.playerName !== "NetEase Cloud Music") return false;
	if (!["unavailable", "paused", "playing"].includes(String(record.state))) return false;
	if (typeof record.capabilities !== "object" || record.capabilities === null) return false;
	const capabilities = record.capabilities as Record<string, unknown>;
	if (!["playPause", "next", "previous", "seek", "volume"].every((key) => typeof capabilities[key] === "boolean"))
		return false;
	if (record.track !== undefined && !isTrack(record.track)) return false;
	if (record.positionSeconds !== undefined && !isNonNegativeFinite(record.positionSeconds)) return false;
	if (record.volumePercent !== undefined && (!isNonNegativeFinite(record.volumePercent) || record.volumePercent > 100))
		return false;
	return record.detail === undefined || typeof record.detail === "string";
}

function isTrack(value: unknown): value is Track {
	if (typeof value !== "object" || value === null) return false;
	const track = value as Record<string, unknown>;
	return (
		typeof track.title === "string" &&
		typeof track.artist === "string" &&
		(track.album === undefined || typeof track.album === "string") &&
		(track.durationSeconds === undefined || isNonNegativeFinite(track.durationSeconds))
	);
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
