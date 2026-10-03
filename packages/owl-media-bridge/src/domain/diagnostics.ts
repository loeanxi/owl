import type { BridgeStatus, PlayerCapabilities, PlayerId } from "./types.ts";

/** Severity of one self-check row in the connection diagnostics center. */
export type DiagnosticCheckState = "pass" | "warn" | "fail" | "info";

export type DiagnosticCheckId =
	| "player-configured"
	| "powershell-worker"
	| "player-process"
	| "media-session"
	| "audio-session"
	| "capabilities"
	| "metadata-enrichment"
	| "status-read";

/** One normalized self-check row; `detail` is pre-sanitized and never contains media metadata. */
export interface BridgeDiagnosticCheck {
	readonly id: DiagnosticCheckId;
	readonly state: DiagnosticCheckState;
	readonly detail?: string;
}

/** Probe of the configured player's OS processes (names only, no pids/paths). */
export interface PlayerProcessProbe {
	readonly found: boolean;
	readonly processCount?: number;
	readonly names?: readonly string[];
}

/** Probe of GSMTC media sessions versus the player's expected app-id pattern. */
export interface MediaSessionProbe {
	readonly matchingSessions: number;
	readonly totalSessions?: number;
	readonly appUserModelIds?: readonly string[];
}

/** Probe of the player's own Core Audio render session (never endpoint volume). */
export interface AudioSessionProbe {
	readonly found: boolean;
	readonly volumePercent?: number;
}

/** Health of the reusable PowerShell worker below the adapter seam. */
export interface PowerShellWorkerProbe {
	readonly alive: boolean;
	readonly startedAt?: number;
	readonly lastStopReason?: string;
	readonly lastStopAt?: number;
	readonly activeLeases?: number;
}

/**
 * Everything an adapter can report about the current connection, gathered in
 * one on-demand probe. All values are pre-sanitized: no track titles, artists,
 * lyrics, artwork URLs, local paths, hostnames, or process ids.
 */
export interface AdapterDiagnostics {
	readonly process?: PlayerProcessProbe;
	readonly mediaSession?: MediaSessionProbe;
	readonly audioSession?: AudioSessionProbe;
	readonly worker?: PowerShellWorkerProbe;
	readonly capabilities?: PlayerCapabilities;
	readonly state?: BridgeStatus["state"];
	readonly detail?: string;
}

/** Telemetry of the most recent authoritative status read through the bridge. */
export interface StatusReadTelemetry {
	readonly at: number;
	readonly durationMs: number;
	readonly ok: boolean;
	readonly errorMessage?: string;
}

/** The domain answer behind the one-click self-check. */
export interface BridgeDiagnostics {
	readonly playerId: PlayerId;
	readonly playerName?: string;
	readonly generatedAt: number;
	readonly checks: readonly BridgeDiagnosticCheck[];
	readonly probes: AdapterDiagnostics;
	readonly lastStatusRead?: StatusReadTelemetry;
	readonly metadataState?: BridgeStatus["metadataState"];
}

export interface BridgeDiagnosticsInput {
	readonly playerId: PlayerId;
	readonly playerName?: string;
	readonly generatedAt: number;
	readonly probes: AdapterDiagnostics;
	readonly lastStatus?: BridgeStatus;
	readonly lastStatusRead?: StatusReadTelemetry;
}

const SLOW_STATUS_READ_MS = 2_000;
const MAX_ERROR_DETAIL = 240;

const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\s"'`;|<>()[\]]*/g;
const UNIX_PATH_PATTERN = /(?:\/(?:Users|home|tmp|temp|var|usr|opt)\b)[^\s"'`;|<>()[\]]*/g;

/**
 * Collapse an arbitrary error into one short single-line detail that is safe
 * to show and to copy: no stack traces, no filesystem paths, bounded length.
 */
export function sanitizeErrorDetail(value: unknown): string {
	const raw = value instanceof Error ? value.message : typeof value === "string" ? value : String(value ?? "");
	const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
	const withoutPaths = firstLine.replace(WINDOWS_PATH_PATTERN, "<path>").replace(UNIX_PATH_PATTERN, "<path>");
	const collapsed = withoutPaths.replace(/\s+/g, " ").trim();
	return collapsed.length > MAX_ERROR_DETAIL ? `${collapsed.slice(0, MAX_ERROR_DETAIL)}…` : collapsed;
}

/** Derive the ordered self-check rows from raw probes and bridge telemetry. */
export function deriveBridgeChecks(input: BridgeDiagnosticsInput): BridgeDiagnosticCheck[] {
	const checks: BridgeDiagnosticCheck[] = [];
	const { probes, lastStatus, lastStatusRead } = input;

	if (input.playerName === undefined) {
		checks.push({
			id: "player-configured",
			state: "fail",
			detail: `No adapter is configured for player "${input.playerId}".`,
		});
	} else {
		checks.push({ id: "player-configured", state: "pass", detail: `${input.playerName} adapter is configured.` });
	}

	const worker = probes.worker;
	if (worker === undefined) {
		checks.push({ id: "powershell-worker", state: "info", detail: "No worker probe available." });
	} else if (worker.alive) {
		const leases = worker.activeLeases ?? 0;
		checks.push({
			id: "powershell-worker",
			state: "pass",
			detail: leases > 0 ? `Worker running with ${leases} volume lease(s).` : "Worker running.",
		});
	} else if (/idle|closed/i.test(worker.lastStopReason ?? "")) {
		checks.push({ id: "powershell-worker", state: "info", detail: "Worker idle; it restarts on demand." });
	} else if (worker.lastStopReason !== undefined) {
		checks.push({ id: "powershell-worker", state: "warn", detail: `Last worker exit: ${worker.lastStopReason}` });
	} else {
		checks.push({ id: "powershell-worker", state: "info", detail: "Worker not started yet; it starts on demand." });
	}

	const process = probes.process;
	if (process === undefined) {
		checks.push({ id: "player-process", state: "info", detail: "No process probe available." });
	} else if (process.found) {
		const names = process.names !== undefined && process.names.length > 0 ? `: ${process.names.join(", ")}` : "";
		checks.push({
			id: "player-process",
			state: "pass",
			detail: `${process.processCount ?? 1} player process(es) running${names}.`,
		});
	} else {
		checks.push({
			id: "player-process",
			state: "fail",
			detail: "The player process is not running. Start the player first.",
		});
	}

	const session = probes.mediaSession;
	if (session === undefined) {
		checks.push({ id: "media-session", state: "info", detail: "No media-session probe available." });
	} else if (session.matchingSessions > 0) {
		const total = session.totalSessions === undefined ? "" : ` / ${session.totalSessions}`;
		const ids =
			session.appUserModelIds !== undefined && session.appUserModelIds.length > 0
				? ` (${session.appUserModelIds.join(", ")})`
				: "";
		checks.push({
			id: "media-session",
			state: "pass",
			detail: `${session.matchingSessions}${total} media session(s) matched${ids}.`,
		});
	} else {
		const total = session.totalSessions === undefined ? "" : ` out of ${session.totalSessions} published sessions`;
		checks.push({
			id: "media-session",
			state: "fail",
			detail: `No media session matches the expected app id${total}. Play a track in the player.`,
		});
	}

	const audio = probes.audioSession;
	if (audio === undefined) {
		checks.push({ id: "audio-session", state: "info", detail: "No audio-session probe available." });
	} else if (audio.found) {
		checks.push({
			id: "audio-session",
			state: "pass",
			detail:
				audio.volumePercent === undefined
					? "Per-app audio session found."
					: `Per-app audio session found at ${audio.volumePercent}%.`,
		});
	} else {
		checks.push({
			id: "audio-session",
			state: "warn",
			detail: "No per-app audio session; application volume control stays unavailable.",
		});
	}

	const capabilities = probes.capabilities;
	if (capabilities === undefined) {
		checks.push({ id: "capabilities", state: "info", detail: "Capabilities unknown." });
	} else {
		const enabled = [
			capabilities.playPause ? "play-pause" : undefined,
			capabilities.next ? "next" : undefined,
			capabilities.previous ? "previous" : undefined,
			capabilities.seek ? "seek" : undefined,
			capabilities.volume ? "volume" : undefined,
		].filter((item): item is string => item !== undefined);
		if (enabled.length > 0)
			checks.push({ id: "capabilities", state: "pass", detail: `Enabled: ${enabled.join(", ")}.` });
		else checks.push({ id: "capabilities", state: "warn", detail: "The player currently advertises no controls." });
	}

	if (lastStatus?.track === undefined) {
		checks.push({ id: "metadata-enrichment", state: "info", detail: "No track published yet." });
	} else if (lastStatus.metadataState === "ready") {
		checks.push({ id: "metadata-enrichment", state: "pass", detail: "Artwork/lyric enrichment is ready." });
	} else if (lastStatus.metadataState === "pending") {
		checks.push({
			id: "metadata-enrichment",
			state: "info",
			detail: "Artwork/lyric enrichment is loading in the background.",
		});
	} else if (lastStatus.metadataState === "degraded") {
		checks.push({
			id: "metadata-enrichment",
			state: "warn",
			detail: "Artwork/lyric enrichment degraded; playback itself is unaffected.",
		});
	} else {
		checks.push({
			id: "metadata-enrichment",
			state: "info",
			detail: "Enrichment state not reported by the adapter.",
		});
	}

	const read = lastStatusRead;
	if (read === undefined) {
		checks.push({ id: "status-read", state: "info", detail: "No status read recorded yet." });
	} else if (!read.ok) {
		checks.push({
			id: "status-read",
			state: "fail",
			detail: `Last status read failed: ${read.errorMessage ?? "unknown error"}`,
		});
	} else if (read.durationMs > SLOW_STATUS_READ_MS) {
		checks.push({ id: "status-read", state: "warn", detail: `Last status read was slow: ${read.durationMs} ms.` });
	} else {
		checks.push({ id: "status-read", state: "pass", detail: `Last status read took ${read.durationMs} ms.` });
	}

	return checks;
}

/** Assemble the full diagnostics payload from probes plus bridge observations. */
export function buildBridgeDiagnostics(input: BridgeDiagnosticsInput): BridgeDiagnostics {
	return {
		playerId: input.playerId,
		playerName: input.playerName,
		generatedAt: input.generatedAt,
		checks: deriveBridgeChecks(input),
		probes: input.probes,
		lastStatusRead: input.lastStatusRead,
		metadataState: input.lastStatus?.track === undefined ? undefined : input.lastStatus.metadataState,
	};
}

/**
 * Render a sanitized plain-text report suitable for issue reports. It never
 * contains track titles, artists, lyrics, artwork URLs, local paths,
 * hostnames, or process ids.
 */
export function buildSanitizedReport(
	diagnostics: BridgeDiagnostics,
	extras: ReadonlyArray<readonly [string, string]> = [],
): string {
	const lines: string[] = [
		"DSH Media Bridge self-check report",
		`generated_at: ${new Date(diagnostics.generatedAt).toISOString()}`,
		`player_id: ${diagnostics.playerId}`,
	];
	if (diagnostics.playerName !== undefined) lines.push(`player_name: ${diagnostics.playerName}`);
	if (diagnostics.metadataState !== undefined) lines.push(`metadata_state: ${diagnostics.metadataState}`);
	if (diagnostics.lastStatusRead !== undefined) {
		const read = diagnostics.lastStatusRead;
		lines.push(
			`last_status_read: ${read.ok ? `ok ${read.durationMs}ms` : `failed (${read.errorMessage ?? "unknown error"})`}`,
		);
	}
	lines.push("checks:");
	for (const check of diagnostics.checks) {
		lines.push(`[${check.state}] ${check.id}${check.detail === undefined ? "" : ` — ${check.detail}`}`);
	}
	if (extras.length > 0) {
		lines.push("extras:");
		for (const [key, value] of extras) lines.push(`${key}=${value}`);
	}
	lines.push(
		"note: sanitized report — no track titles, artists, lyrics, artwork URLs, local paths, hostnames, or process ids.",
	);
	return lines.join("\n");
}
