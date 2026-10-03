import type { PlaybackState, PlayerId } from './types.ts'

/**
 * One short-lived amplitude/frequency frame produced below the
 * AudioSignalProvider seam. Values are normalized into 0..1 and exist only in
 * memory; they are never persisted and never sent to the model tools.
 */
export interface AudioSignalFrame {
  readonly at: number
  readonly rms: number
  readonly peak: number
  readonly bands: readonly number[]
}

/** Where the rendered wave currently comes from. */
export type AudioSignalSource = 'process' | 'synthetic'

/**
 * Machine-readable reason consumed by the browser UI, which renders the
 * Chinese-first notice. `capturing` means process-scoped loopback frames flow;
 * every other reason degrades to the synthetic animation with an explicit,
 * visible explanation — never a silent capture-scope change.
 */
export type AudioSignalReason =
  | 'capturing'
  | 'disabled'
  | 'paused'
  | 'starting'
  | 'player-unavailable'
  | 'unsupported-os'
  | 'capture-failed'

export interface AudioSignalView {
  readonly playerId: PlayerId
  readonly playerName: string
  readonly state: PlaybackState
  readonly source: AudioSignalSource
  readonly reason: AudioSignalReason
  /** Oldest → newest bounded frame history for the browser renderer. */
  readonly frames: readonly AudioSignalFrame[]
  readonly targetProcesses: number
  readonly activeTargetProcesses: number
}

/**
 * Liveness snapshot returned by an AudioSignalProvider implementation.
 * `failure` carries sanitized helper diagnostics only (no frame content).
 */
export interface AudioSignalReading {
  readonly active: boolean
  readonly starting: boolean
  readonly unsupportedOs: boolean
  readonly failure?: string
  readonly frames: readonly AudioSignalFrame[]
  readonly targetProcesses: number
  readonly activeTargetProcesses: number
}

/**
 * The reserved opt-in waveform seam from docs/audio-wave-design.md.
 *
 * Implementations must declare and honor their capture scope: the only
 * supported scope is the explicitly selected player's own processes. Falling
 * back to endpoint-wide capture is forbidden — implementations surface
 * failure instead, and the UI keeps labeling the wave as synthetic.
 */
export interface AudioSignalProvider {
  /** Begin (or retarget) capturing for exactly this player's processes. */
  request(playerId: PlayerId): void
  /** Stop capturing entirely and drop buffered frames. */
  stop(): void
  /**
   * Latest bounded reading. Also acts as the consumer liveness signal:
   * providers may stop themselves when nobody reads for a while.
   */
  read(): AudioSignalReading
  /** Final teardown owned by the host process. */
  dispose(): void
}

export const MAX_SIGNAL_FRAMES = 24
const MAX_SIGNAL_BANDS = 64

export const EMPTY_AUDIO_SIGNAL_READING: AudioSignalReading = {
  active: false,
  starting: false,
  unsupportedOs: false,
  frames: [],
  targetProcesses: 0,
  activeTargetProcesses: 0,
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Validate one transport frame defensively; invalid shapes are dropped. */
export function normalizeAudioSignalFrame(value: unknown): AudioSignalFrame | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const rms = clamp01(record.rms)
  const peak = Math.max(clamp01(record.peak), rms)
  const rawBands = Array.isArray(record.bands) ? record.bands : []
  const bands = rawBands.slice(0, MAX_SIGNAL_BANDS).map((band) => clamp01(band))
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now()
  return { at, rms, peak, bands }
}

/** Validate a transport frame list; keeps at most MAX_SIGNAL_FRAMES newest. */
export function normalizeAudioSignalFrames(value: unknown): AudioSignalFrame[] {
  if (!Array.isArray(value)) return []
  const frames = value.map(normalizeAudioSignalFrame).filter((frame): frame is AudioSignalFrame => frame !== undefined)
  return frames.slice(-MAX_SIGNAL_FRAMES)
}

/**
 * Pure reason/source resolution shared by the runtime and tests so the UI
 * degradation contract lives in one place next to the seam it describes.
 */
export function resolveAudioSignalReason(
  reading: AudioSignalReading | undefined,
  options: { realWaveEnabled: boolean; providerAvailable: boolean; state: PlaybackState },
): AudioSignalReason {
  if (!options.realWaveEnabled) return 'disabled'
  if (options.state !== 'playing') return 'paused'
  if (!options.providerAvailable || reading === undefined) return 'unsupported-os'
  if (reading.unsupportedOs) return 'unsupported-os'
  if (reading.failure !== undefined) return 'capture-failed'
  if (reading.frames.length > 0 && reading.activeTargetProcesses > 0) return 'capturing'
  return 'starting'
}

export function audioSignalView(
  status: { playerId: PlayerId; playerName: string; state: PlaybackState },
  reading: AudioSignalReading | undefined,
  options: { realWaveEnabled: boolean; providerAvailable: boolean },
): AudioSignalView {
  const safeReading = reading ?? EMPTY_AUDIO_SIGNAL_READING
  const reason = resolveAudioSignalReason(safeReading, {
    realWaveEnabled: options.realWaveEnabled,
    providerAvailable: options.providerAvailable,
    state: status.state,
  })
  return {
    playerId: status.playerId,
    playerName: status.playerName,
    state: status.state,
    source: reason === 'capturing' ? 'process' : 'synthetic',
    reason,
    // Degraded views never carry frames: stale samples must never be
    // rendered as if they were real capture output.
    frames: reason === 'capturing' ? safeReading.frames : [],
    targetProcesses: safeReading.targetProcesses,
    activeTargetProcesses: safeReading.activeTargetProcesses,
  }
}
