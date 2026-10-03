import type { AdapterDiagnostics } from './diagnostics.ts'
import type { BridgeStatus, MediaCommand, PlayerId } from './types.ts'

export interface PlayerVolumeLease {
  readonly id: string
  readonly beforeVolume: number
  readonly appliedVolume: number
  readonly previousAppliedVolume?: number
}

/**
 * The seam for player-specific implementations.
 *
 * Adapters may talk to Windows media sessions, a platform SDK, or a future
 * test double. They must not expose those details to the rest of the plugin.
 */
export interface PlayerAdapter {
  readonly id: PlayerId
  readonly displayName: string
  /** Start the player when it is not currently publishing a media session. */
  readonly launch?: (signal?: AbortSignal) => Promise<void>
  readStatus(signal?: AbortSignal): Promise<BridgeStatus>
  execute(command: MediaCommand, signal?: AbortSignal): Promise<void>
  /** Crash-only restoration handled below the host process; optional for non-Windows adapters/test doubles. */
  readonly armVolumeLease?: (lease: PlayerVolumeLease, signal?: AbortSignal) => Promise<void>
  readonly clearVolumeLease?: (leaseId: string, signal?: AbortSignal) => Promise<void>
  /**
   * One-shot connection probes for the diagnostics center (process, media
   * session, audio session, worker health). Optional: test doubles may stay
   * silent and the bridge reports informational checks instead. Implementations
   * must degrade failures into probe data rather than throwing.
   */
  readonly diagnose?: (signal?: AbortSignal) => Promise<AdapterDiagnostics>
}
