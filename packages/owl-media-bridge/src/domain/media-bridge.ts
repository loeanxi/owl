import { buildBridgeDiagnostics, sanitizeErrorDetail, type AdapterDiagnostics, type BridgeDiagnostics, type StatusReadTelemetry } from './diagnostics.ts'
import type { PlayerAdapter, PlayerVolumeLease } from './player-adapter.ts'
import type { BridgeStatus, MediaCommand, PlayerCapabilities, PlayerId, PlayerOption } from './types.ts'

export interface MediaControlReceipt {
  readonly before: BridgeStatus
  readonly after: BridgeStatus
}

export class MediaBridgeError extends Error {
  constructor(
    public readonly code: 'PLAYER_NOT_CONFIGURED' | 'COMMAND_UNAVAILABLE' | 'INVALID_COMMAND' | 'AGENT_CONTROL_DISABLED' | 'LIVE_VIDEO_ACTIVE',
    message: string,
  ) {
    super(message)
    this.name = 'MediaBridgeError'
  }
}

export interface MediaBridgeOptions {
  /**
   * Observed on every authoritative adapter read (including the before/after
   * reads inside a control command). This is where process-local features
   * such as listening history sample playback without adding extra polls.
   */
  readonly onStatusRead?: (status: BridgeStatus) => void
}

/**
 * The deep module used by every host route and model tool.
 *
 * It owns adapter selection, capability checks, input normalization, and the
 * post-command refresh. Consumers only learn its two operations.
 */
export class MediaBridge {
  private readonly adapters: ReadonlyMap<PlayerId, PlayerAdapter>
  private selectedPlayerId: PlayerId
  private readonly options: MediaBridgeOptions
  /** Telemetry of the most recent authoritative read; feeds the diagnostics center. */
  private lastStatusRead: StatusReadTelemetry | undefined
  private lastObservedStatus: BridgeStatus | undefined

  constructor(
    adapters: readonly PlayerAdapter[],
    selectedPlayerId: PlayerId = 'qq-music',
    options: MediaBridgeOptions = {},
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]))
    this.selectedPlayerId = selectedPlayerId
    this.options = options
  }

  /** The currently selected player. */
  currentPlayerId(): PlayerId {
    return this.selectedPlayerId
  }

  /** Every registered adapter, for the settings player picker. */
  listPlayers(): PlayerOption[] {
    return [...this.adapters.values()].map((adapter) => ({ id: adapter.id, displayName: adapter.displayName }))
  }

  /** Switch the explicit player selection. Unknown ids fail, never fall back. */
  selectPlayer(playerId: PlayerId): void {
    if (!this.adapters.has(playerId)) {
      throw new MediaBridgeError(
        'PLAYER_NOT_CONFIGURED',
        `No adapter is configured for player "${playerId}".`,
      )
    }
    this.selectedPlayerId = playerId
  }

  async status(signal?: AbortSignal): Promise<BridgeStatus> {
    const adapter = this.adapter()
    const result = await this.readWithTelemetry(adapter, signal)
    this.options.onStatusRead?.(result)
    return result
  }

  async launch(signal?: AbortSignal): Promise<void> {
    const adapter = this.adapter()
    if (adapter.launch === undefined) throw new Error(`${adapter.displayName} cannot be started automatically on this system.`)
    await adapter.launch(signal)
  }

  async armVolumeLease(lease: PlayerVolumeLease, signal?: AbortSignal): Promise<void> {
    await this.adapter().armVolumeLease?.(lease, signal)
  }

  async clearVolumeLease(leaseId: string, signal?: AbortSignal): Promise<void> {
    await this.adapter().clearVolumeLease?.(leaseId, signal)
  }

  async control(command: MediaCommand, signal?: AbortSignal): Promise<BridgeStatus> {
    return (await this.controlWithReceipt(command, signal)).after
  }

  /** Capture the exact fresh status used for authorization and the authoritative result. */
  async controlWithReceipt(command: MediaCommand, signal?: AbortSignal, assertBeforeExecute?: (status: BridgeStatus) => void): Promise<MediaControlReceipt> {
    validateCommand(command)
    const adapter = this.adapter()
    // Capabilities describe the currently published media session and can
    // change between polls (for example when a track ends or the player
    // closes). Always refresh before authorizing a command; using the cache
    // here can send controls that are no longer supported.
    const status = await this.readWithTelemetry(adapter, signal)
    this.options.onStatusRead?.(status)
    assertBeforeExecute?.(status)
    assertSupported(command, status.capabilities, adapter.displayName)
    await adapter.execute(command, signal)
    const result = await this.readWithTelemetry(adapter, signal)
    this.options.onStatusRead?.(result)
    return { before: status, after: result }
  }

  private adapter(): PlayerAdapter {
    const adapter = this.adapters.get(this.selectedPlayerId)
    if (adapter === undefined) {
      throw new MediaBridgeError(
        'PLAYER_NOT_CONFIGURED',
        `No adapter is configured for player "${this.selectedPlayerId}".`,
      )
    }
    return adapter
  }

  /**
   * One-click self-check for the connection diagnostics center. Never throws
   * for probe failures: a missing adapter or a broken adapter boundary becomes
   * a failed check plus a sanitized detail note inside the resulting report.
   */
  async diagnose(signal?: AbortSignal): Promise<BridgeDiagnostics> {
    const playerId = this.selectedPlayerId
    const generatedAt = Date.now()
    const adapter = this.adapters.get(playerId)
    if (adapter === undefined) {
      return buildBridgeDiagnostics({
        playerId,
        generatedAt,
        probes: {},
        lastStatus: this.lastObservedStatus,
        lastStatusRead: this.lastStatusRead,
      })
    }
    let probes: AdapterDiagnostics
    try {
      probes = (await adapter.diagnose?.(signal)) ?? {}
    } catch (error) {
      probes = { detail: sanitizeErrorDetail(error) }
    }
    return buildBridgeDiagnostics({
      playerId,
      playerName: adapter.displayName,
      generatedAt,
      probes,
      lastStatus: this.lastObservedStatus,
      lastStatusRead: this.lastStatusRead,
    })
  }

  /** Wraps every authoritative adapter read with duration/outcome telemetry. */
  private async readWithTelemetry(adapter: PlayerAdapter, signal?: AbortSignal): Promise<BridgeStatus> {
    const startedAt = performance.now()
    try {
      const result = await adapter.readStatus(signal)
      this.lastStatusRead = { at: Date.now(), durationMs: Math.round(performance.now() - startedAt), ok: true }
      this.lastObservedStatus = result
      return result
    } catch (error) {
      this.lastStatusRead = {
        at: Date.now(),
        durationMs: Math.round(performance.now() - startedAt),
        ok: false,
        errorMessage: sanitizeErrorDetail(error),
      }
      throw error
    }
  }
}

function assertSupported(command: MediaCommand, capabilities: PlayerCapabilities, playerName: string): void {
  const allowed = command.kind === 'play-pause'
    ? capabilities.playPause
    : command.kind === 'next'
      ? capabilities.next
      : command.kind === 'previous'
        ? capabilities.previous
        : command.kind === 'seek'
          ? capabilities.seek
          : capabilities.volume

  if (!allowed) {
    throw new MediaBridgeError(
      'COMMAND_UNAVAILABLE',
      `${playerName} does not currently expose the "${command.kind}" media control.`,
    )
  }
}

function validateCommand(command: MediaCommand): void {
  if (command.kind === 'seek' && (!Number.isFinite(command.positionSeconds) || command.positionSeconds < 0)) {
    throw new MediaBridgeError('INVALID_COMMAND', 'seek positionSeconds must be a finite value greater than or equal to zero.')
  }

  if (command.kind === 'set-volume' && (!Number.isFinite(command.volumePercent) || command.volumePercent < 0 || command.volumePercent > 100)) {
    throw new MediaBridgeError('INVALID_COMMAND', 'set-volume volumePercent must be a finite value from 0 to 100.')
  }
}
