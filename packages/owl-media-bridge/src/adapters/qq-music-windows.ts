import type { AdapterDiagnostics } from '../domain/diagnostics.ts'
import type { PlayerAdapter, PlayerVolumeLease } from '../domain/player-adapter.ts'
import type { BridgeStatus, MediaCommand, PlayerCapabilities, Track } from '../domain/types.ts'
import { type PowerShellRunner, type WindowsMediaCommand, WindowsPowerShellRunner } from './powershell-runner.ts'
import { QqMusicCoverResolver, type QqMusicVisuals } from './qq-music-cover.ts'
import { ProgressiveTrackMetadata } from './progressive-track-metadata.ts'
import { runWindowsDiagnosis } from './windows-media-diagnostics.ts'

interface PowerShellStatus {
  readonly playerId: string
  readonly playerName: string
  readonly state: 'unavailable' | 'paused' | 'playing'
  readonly track?: Track
  readonly positionSeconds?: number
  readonly volumePercent?: number
  readonly capabilities: PlayerCapabilities
  readonly detail?: string
}

/** Windows adapter for the QQ Music session explicitly identified as QQMusic.exe. */
export class QqMusicWindowsAdapter implements PlayerAdapter {
  readonly id = 'qq-music'
  readonly displayName = 'QQ 音乐'
  private readonly metadata: ProgressiveTrackMetadata<QqMusicVisuals>

  constructor(
    private readonly runner: PowerShellRunner = new WindowsPowerShellRunner(),
    coverResolver: Pick<QqMusicCoverResolver, 'resolve'> = new QqMusicCoverResolver(),
  ) {
    this.metadata = new ProgressiveTrackMetadata(
      (track, signal) => coverResolver.resolve(track, signal),
      {
        hasValue: (visuals) => Boolean(visuals.artworkUrl || visuals.artistImageUrl || visuals.backgroundImageUrls?.length || visuals.lyrics?.length),
        refreshAfterMs: (visuals) => visuals.lyrics === undefined ? 15_000 : 60 * 60 * 1000,
      },
    )
  }

  async launch(signal?: AbortSignal): Promise<void> {
    if (this.runner.launch === undefined) throw new Error('QQ 音乐无法自动启动。')
    await this.runner.launch('qq-music', signal)
  }

  async readStatus(signal?: AbortSignal): Promise<BridgeStatus> {
    const status = statusFrom(await this.runner.run('status', undefined, signal))
    const enrichment = this.metadata.read(status.track)
    if (status.track === undefined || enrichment === undefined) return status
    const visuals = enrichment.value
    if (visuals === undefined) return { ...status, metadataState: enrichment.state }
    return {
      ...status,
      backgroundImageUrl: visuals.artistImageUrl,
      backgroundImageUrls: visuals.backgroundImageUrls,
      lyrics: visuals.lyrics,
      metadataState: enrichment.state,
      track: { ...status.track, artworkUrl: visuals.artworkUrl, artistImageUrl: visuals.artistImageUrl },
    }
  }

  async execute(command: MediaCommand, signal?: AbortSignal): Promise<void> {
    const mapped = commandToPowerShell(command)
    await this.runner.run(mapped.command, mapped.positionSeconds, signal)
  }

  async armVolumeLease(lease: PlayerVolumeLease, signal?: AbortSignal): Promise<void> {
    await this.runner.armVolumeLease?.({ ...lease, player: this.id }, signal)
  }

  async clearVolumeLease(leaseId: string, signal?: AbortSignal): Promise<void> {
    await this.runner.clearVolumeLease?.(leaseId, signal)
  }

  /** One-shot connection probes for the diagnostics center; failures degrade into data, never throw. */
  async diagnose(signal?: AbortSignal): Promise<AdapterDiagnostics> {
    return await runWindowsDiagnosis(this.runner, 'qq-music', { playerId: 'qq-music', playerName: 'QQ Music' }, signal)
  }
}

function commandToPowerShell(command: MediaCommand): { command: WindowsMediaCommand; positionSeconds?: number } {
  switch (command.kind) {
    case 'play-pause': return { command: 'play-pause' }
    case 'next': return { command: 'next' }
    case 'previous': return { command: 'previous' }
    case 'seek': return { command: 'seek', positionSeconds: command.positionSeconds }
    case 'set-volume': return { command: 'set-volume', positionSeconds: command.volumePercent }
  }
}

function statusFrom(value: unknown): BridgeStatus {
  if (!isPowerShellStatus(value)) throw new Error('Windows media bridge returned an invalid status payload.')
  return {
    playerId: 'qq-music',
    playerName: 'QQ 音乐',
    state: value.state,
    track: value.track,
    positionSeconds: value.positionSeconds,
    volumePercent: value.volumePercent,
    capabilities: value.capabilities,
    detail: value.detail,
  }
}

function isPowerShellStatus(value: unknown): value is PowerShellStatus {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.playerId !== 'qq-music' || record.playerName !== 'QQ Music') return false
  if (!['unavailable', 'paused', 'playing'].includes(String(record.state))) return false
  if (typeof record.capabilities !== 'object' || record.capabilities === null) return false
  const capabilities = record.capabilities as Record<string, unknown>
  if (!['playPause', 'next', 'previous', 'seek', 'volume'].every((key) => typeof capabilities[key] === 'boolean')) return false
  if (record.track !== undefined && !isTrack(record.track)) return false
  if (record.positionSeconds !== undefined && !isNonNegativeFinite(record.positionSeconds)) return false
  if (record.volumePercent !== undefined && (!isNonNegativeFinite(record.volumePercent) || record.volumePercent > 100)) return false
  return record.detail === undefined || typeof record.detail === 'string'
}

function isTrack(value: unknown): value is Track {
  if (typeof value !== 'object' || value === null) return false
  const track = value as Record<string, unknown>
  return typeof track.title === 'string' && typeof track.artist === 'string'
    && (track.album === undefined || typeof track.album === 'string')
    && (track.durationSeconds === undefined || isNonNegativeFinite(track.durationSeconds))
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
