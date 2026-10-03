/** A stable identifier for one locally controllable player. */
export type PlayerId = "qq-music" | "netease-music" | (string & {});

/** One selectable player shown in the settings picker and config view. */
export interface PlayerOption {
	readonly id: PlayerId;
	readonly displayName: string;
}

/** The only playback states the initial UI renders. */
export type PlaybackState = "unavailable" | "paused" | "playing";

/** Operations an adapter has explicitly confirmed for its current session. */
export interface PlayerCapabilities {
	readonly playPause: boolean;
	readonly next: boolean;
	readonly previous: boolean;
	readonly seek: boolean;
	readonly volume: boolean;
}

/** Metadata published by a player through the operating system media session. */
export interface Track {
	readonly title: string;
	readonly artist: string;
	readonly album?: string;
	readonly artworkUrl?: string;
	readonly artistImageUrl?: string;
	readonly durationSeconds?: number;
}

export interface LyricLine {
	readonly startMs: number;
	readonly text: string;
	/** Aligned translation resolved by the adapter; absent means original-only. */
	readonly translation?: string;
}

/** Fresh, normalized local-player state consumed by tools and the Web UI. */
export interface BridgeStatus {
	readonly playerId: PlayerId;
	readonly playerName: string;
	readonly state: PlaybackState;
	readonly track?: Track;
	readonly positionSeconds?: number;
	readonly volumePercent?: number;
	readonly backgroundImageUrl?: string;
	readonly backgroundImageUrls?: readonly string[];
	readonly lyrics?: readonly LyricLine[];
	/** Remote artwork/lyric enrichment never blocks the authoritative media state. */
	readonly metadataState?: "pending" | "ready" | "degraded";
	readonly capabilities: PlayerCapabilities;
	readonly detail?: string;
}

export type MediaCommand =
	| { readonly kind: "play-pause" }
	| { readonly kind: "next" }
	| { readonly kind: "previous" }
	| { readonly kind: "seek"; readonly positionSeconds: number }
	| { readonly kind: "set-volume"; readonly volumePercent: number };

export const NO_CAPABILITIES: PlayerCapabilities = Object.freeze({
	playPause: false,
	next: false,
	previous: false,
	seek: false,
	volume: false,
});
