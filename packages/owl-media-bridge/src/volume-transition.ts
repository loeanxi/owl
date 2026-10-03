/**
 * Shared vocabulary and pure policy for smooth volume transitions.
 *
 * The sleep timer introduced gradual fading; this module lifts the reusable
 * parts (linear ramp math, manual-takeover detection, per-kind durations) so
 * pausing, resuming, and the optional track-skip dip can all lean on one
 * mechanism.
 *
 * Everything here is pure: no timers, no adapter calls, no player details.
 * `BridgeRuntime` owns the orchestration and keeps the safety invariants
 * (player-session volume only, capability checks, lease-protected recovery).
 */

/** The situations that soften a volume change instead of jumping. */
export type VolumeTransitionKind =
  | 'pause-fade'
  | 'resume-rise'
  | 'skip-dip'

/**
 * How long each transition takes by default. Short enough to never feel like
 * latency, long enough to read as a deliberate fade. Tests can shrink the
 * step size without touching these values.
 */
export const TRANSITION_DURATIONS_MS: Readonly<Record<VolumeTransitionKind, number>> = Object.freeze({
  'pause-fade': 1400,
  'resume-rise': 1100,
  'skip-dip': 420,
})

/** Delay between two applied ramp steps. */
export const DEFAULT_TRANSITION_STEP_MS = 240

/** Upper bound on adapter round trips a single transition may spend. */
export const MAX_RAMP_STEPS = 8

/** Below this distance a "fade" would be imperceptible; act immediately instead. */
export const MIN_RAMP_DELTA_PERCENT = 2

/**
 * A current volume farther than this from the value we last applied means a
 * human moved it. The same tolerance is used by fades and undo guards.
 */
export const VOLUME_TAKEOVER_DELTA_PERCENT = 1.5

/** Resume never rises from absolute silence; start here at minimum. */
export const RESUME_START_FLOOR_PERCENT = 8

/** Resume pre-drop lands at this fraction of the target volume. */
export const RESUME_START_RATIO = 0.3

/** Volume for one interpolation point of a ramp. */
export function rampTarget(fromPercent: number, toPercent: number, ratio: number): number {
  const clamped = Math.min(1, Math.max(0, ratio))
  return Math.round(fromPercent + (toPercent - fromPercent) * clamped)
}

/**
 * The ordered volume steps for one ramp, excluding the starting volume.
 *
 * Steps interpolate linearly across `durationMs` sampled every `stepMs`,
 * consecutive duplicates collapse, and the last step always lands exactly on
 * `toPercent` so leases, journals, and callers can rely on the end state.
 */
export function planRampSteps(
  fromPercent: number,
  toPercent: number,
  durationMs: number,
  stepMs: number = DEFAULT_TRANSITION_STEP_MS,
): number[] {
  if (!Number.isFinite(fromPercent) || !Number.isFinite(toPercent)) return []
  if (Math.abs(toPercent - fromPercent) < MIN_RAMP_DELTA_PERCENT) return []
  const count = Math.max(2, Math.min(MAX_RAMP_STEPS, Math.round(durationMs / Math.max(1, stepMs))))
  const steps: number[] = []
  for (let index = 1; index <= count; index += 1) {
    const percent = rampTarget(fromPercent, toPercent, index / count)
    const previous = steps[steps.length - 1]
    if (previous === undefined || Math.abs(percent - previous) >= 1) steps.push(percent)
  }
  const last = steps[steps.length - 1]
  if (last === undefined || last !== toPercent) steps.push(toPercent)
  return steps
}

/**
 * True when the player's current volume no longer matches what a transition
 * last applied, meaning a person took over and the ramp must stop without
 * writing another value.
 */
export function volumeDeviated(lastAppliedPercent: number, currentPercent: number | undefined): boolean {
  return currentPercent !== undefined
    && Math.abs(currentPercent - lastAppliedPercent) > VOLUME_TAKEOVER_DELTA_PERCENT
}

/**
 * Where resuming should begin: quiet but not silent, always below the
 * target so the rise is audible rather than a jump from the same level.
 */
export function resumeStartPercent(targetPercent: number): number {
  const floor = Math.max(RESUME_START_FLOOR_PERCENT, Math.round(targetPercent * RESUME_START_RATIO))
  return Math.min(targetPercent, floor)
}

/** Why a transition stopped before reaching its target. */
export class TransitionAbortedError extends Error {
  readonly reason: 'player-changed' | 'volume-overridden'
  constructor(
    reason: 'player-changed' | 'volume-overridden',
    message: string,
  ) {
    super(message)
    this.reason = reason
    this.name = 'TransitionAbortedError'
  }
}
