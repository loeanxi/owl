import {
  sanitizeErrorDetail,
  type AdapterDiagnostics,
  type AudioSessionProbe,
  type MediaSessionProbe,
  type PlayerProcessProbe,
  type PowerShellWorkerProbe,
} from '../domain/diagnostics.ts'
import type { PlayerCapabilities } from '../domain/types.ts'
import { type PowerShellRunner, type PowerShellRunnerHealth } from './powershell-runner.ts'

export interface WindowsDiagnosisExpectation {
  readonly playerId: string
  readonly playerName: string
}

const MAX_NAME_ENTRIES = 8
const MAX_NAME_LENGTH = 64

/**
 * Run the on-demand `diagnose` probe below one Windows adapter. Failures are
 * diagnostics data, never exceptions: a broken PowerShell boundary degrades to
 * an unhealthy worker probe plus a sanitized detail note.
 */
export async function runWindowsDiagnosis(
  runner: PowerShellRunner,
  player: string,
  expected: WindowsDiagnosisExpectation,
  signal?: AbortSignal,
): Promise<AdapterDiagnostics> {
  try {
    const payload = await runner.run('diagnose', undefined, signal, player)
    const diagnosis = parseWindowsDiagnosis(payload, expected)
    return { ...diagnosis, worker: workerProbeFromHealth(runner.health?.()) }
  } catch (error) {
    return { worker: workerProbeFromHealth(runner.health?.()), detail: sanitizeErrorDetail(error) }
  }
}

/** Map raw runner health onto the sanitized worker probe vocabulary. */
export function workerProbeFromHealth(health?: PowerShellRunnerHealth): PowerShellWorkerProbe {
  if (health === undefined) return { alive: false }
  return {
    alive: health.alive,
    startedAt: health.startedAt,
    lastStopReason: health.lastStopReason === undefined ? undefined : sanitizeErrorDetail(health.lastStopReason),
    lastStopAt: health.lastStoppedAt,
    activeLeases: health.activeLeases,
  }
}

function boundedNameList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  const names = value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim().slice(0, MAX_NAME_LENGTH))
  return names.slice(0, MAX_NAME_ENTRIES)
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseProcess(value: unknown): PlayerProcessProbe {
  if (!isRecord(value) || typeof value.found !== 'boolean') throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  const processCount = nonNegativeInteger(value.processCount)
  const names = boundedNameList(value.names)
  return {
    found: value.found,
    processCount: processCount ?? (names !== undefined && names.length > 0 ? names.length : undefined),
    names,
  }
}

function parseMediaSession(value: unknown): MediaSessionProbe {
  if (!isRecord(value)) throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  const matching = nonNegativeInteger(value.matchingSessions)
  if (matching === undefined) throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  return {
    matchingSessions: matching,
    totalSessions: nonNegativeInteger(value.totalSessions),
    appUserModelIds: boundedNameList(value.appUserModelIds),
  }
}

function parseAudioSession(value: unknown): AudioSessionProbe {
  if (!isRecord(value) || typeof value.found !== 'boolean') throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  const volumePercent = value.volumePercent
  if (volumePercent !== undefined && (typeof volumePercent !== 'number' || !Number.isFinite(volumePercent) || volumePercent < 0 || volumePercent > 100)) {
    throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  }
  return {
    found: value.found,
    volumePercent: volumePercent === undefined ? undefined : Math.round(volumePercent * 10) / 10,
  }
}

function isCapabilities(value: unknown): value is PlayerCapabilities {
  return isRecord(value) && ['playPause', 'next', 'previous', 'seek', 'volume'].every((key) => typeof value[key] === 'boolean')
}

/**
 * Validate and normalize the PowerShell `diagnose` payload against the exact
 * playerId/playerName pair (kept in sync with the $Players table in the
 * bundled script), dropping anything unexpected.
 */
export function parseWindowsDiagnosis(value: unknown, expected: WindowsDiagnosisExpectation): AdapterDiagnostics {
  if (!isRecord(value)) throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  if (value.playerId !== expected.playerId || value.playerName !== expected.playerName) {
    throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  }
  const state = value.state
  if (state !== undefined && state !== 'unavailable' && state !== 'paused' && state !== 'playing') {
    throw new Error('Windows media bridge returned an invalid diagnosis payload.')
  }
  return {
    process: value.process === undefined ? undefined : parseProcess(value.process),
    mediaSession: value.mediaSession === undefined ? undefined : parseMediaSession(value.mediaSession),
    audioSession: value.audioSession === undefined ? undefined : parseAudioSession(value.audioSession),
    capabilities: value.capabilities === undefined ? undefined : isCapabilities(value.capabilities) ? value.capabilities : undefined,
    state: state as AdapterDiagnostics['state'],
  }
}
