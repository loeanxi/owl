import os from 'node:os'
import { MediaBridgeError } from './domain/media-bridge.ts'
import type { MediaBridge, MediaControlReceipt } from './domain/media-bridge.ts'
import { MIN_RAMP_DELTA_PERCENT, TRANSITION_DURATIONS_MS, TransitionAbortedError, planRampSteps, resumeStartPercent, volumeDeviated } from './volume-transition.ts'
import type { VolumeTransitionKind } from './volume-transition.ts'
import { buildSanitizedReport, type BridgeDiagnostics } from './domain/diagnostics.ts'
import type { BridgeStatus, MediaCommand, PlayerId, PlayerOption } from './domain/types.ts'
import type { FavoriteEntry, FavoriteToggleInput, ListeningEntry, ListeningMemory, MemorySummary } from './listening-memory.ts'
import { buildListeningReport, SkipLedger, type ListeningReport, type ListeningReportRange } from './listening-report.ts'
import { audioSignalView, type AudioSignalProvider, type AudioSignalView } from './domain/audio-signal.ts'
import { STATUS_CACHE_TTL_MS, StatusCache } from './runtime/status-cache.ts'
import { formatStatusExplanation, type StatusExplanationGates } from './runtime/status-explanation.ts'
import type { LiveStateView, LiveVideoDescription } from './runtime/views.ts'

export { formatStatusExplanation } from './runtime/status-explanation.ts'
export type { StatusExplanationGates } from './runtime/status-explanation.ts'

export interface BridgeRuntimeConfig {
  readonly allowAgentControl: boolean
  /** Whether the client should show current artwork as a non-interactive page overlay. */
  readonly deepBackground: boolean
  /**
   * Opt-in real waveform: process-scoped loopback capture of the selected
   * player only. Frames stay in memory and never reach model tools or disk;
   * see docs/audio-wave-design.md.
   */
  readonly realWaveEnabled: boolean
  readonly playerId: PlayerId
  /** Soften pause/resume and Agent volume changes with short ramps instead of jumps. */
  readonly softTransitions: boolean
  /** Optional brief fade-out before switching tracks; never pretends to be a crossfade. */
  readonly skipFadeOut: boolean
  /**
   * Client-side opt-in: when a NEW track starts and a reliable live/stage
   * video was resolved, the browser may enter Live mode automatically. It
   * never switches mid-song and always keeps QQ Music audible unless the
   * browser is actually allowed to play the video (see docs/live-video-design.md).
   */
  readonly preferLiveVideo: boolean
}

/** The config view shared with the settings page: the live values plus the picker catalog. */
export interface BridgeRuntimeView extends BridgeRuntimeConfig {
  readonly availablePlayers: ReadonlyArray<PlayerOption>
}

export interface BridgeControlActivity {
  readonly id: number
  readonly source: 'ui' | 'agent'
  readonly command: MediaCommand
  readonly at: number
  readonly before: BridgeControlSnapshot
  readonly after: BridgeControlSnapshot
  readonly undoable: boolean
  readonly undoneAt?: number
  readonly undoOf?: number
}

/** Plain-language status explanation returned by media_bridge_explain_status. */
export interface StatusExplanation {
  readonly summary: string
  readonly status: BridgeStatus
}

export interface BridgeControlSnapshot {
  readonly playerId: PlayerId
  readonly playerName: string
  readonly state: BridgeStatus['state']
  readonly trackTitle?: string
  readonly trackArtist?: string
  readonly positionSeconds?: number
  readonly volumePercent?: number
}

/** Browser-only status view. Model tools keep receiving the domain status alone. */
export interface BridgeUiStatus extends BridgeStatus {
  readonly recentControl?: BridgeControlActivity
  readonly controlHistory: readonly BridgeControlActivity[]
  /** Present only while an automatic smooth transition is driving the volume. */
  readonly transition?: { readonly kind: VolumeTransitionKind }
  /** Local listening memory counters; `favorite` reflects the current track. */
  readonly memory: MemorySummary
  /**
   * Browser-only Live video description for the current track, including its
   * short-lived play URL. Never exposed to model tools and never persisted.
   */
  readonly liveVideo?: LiveVideoDescription
  /** Browser-owned mirror of the web client's Live playback session. */
  readonly live?: LiveStateView
}

/**
 * Non-blocking per-track Live video lookup seam. Implementations start or
 * observe enrichment for the current track and never wait on the network.
 */
export interface LiveVideoProvider {
  read(track: BridgeStatus['track']): { readonly state: 'pending' | 'ready' | 'degraded'; readonly value?: LiveVideoDescription } | undefined
}

/**
 * Browser-only diagnostics view: domain probes plus runtime context, ending in
 * the sanitized plain-text report the client copies verbatim.
 */
export interface BridgeUiDiagnostics extends BridgeDiagnostics {
  readonly config: BridgeRuntimeView
  readonly statusCache: {
    readonly updatedAt?: number
    readonly ageMs?: number
    /** True while still inside the shared short-lived status cache window. */
    readonly fresh: boolean
  }
  /** Sanitized self-check report; never contains titles, artists, URLs, or paths. */
  readonly report: string
}

/** One in-flight gradual volume transition; owned by the serialized transition queue. */
interface ActiveVolumeFade {
  readonly id: number
  readonly source: BridgeControlActivity['source']
  readonly playerId: PlayerId
  readonly startVolume: number
  readonly targetVolume: number
  readonly durationMs: number
  readonly startedAt: number
  lastAppliedVolume: number
  cancelled: boolean
  settle: (status: BridgeStatus) => void
  fail: (error: Error) => void
}

export interface TransitionTimingOptions {
  /** Delay between two applied steps of one smooth transition. */
  readonly transitionStepMs?: number
}

const CONTROL_UNDO_WINDOW_MS = 30_000
/** Crash-recovery lease held only for the seconds a momentary transition runs. */
const MOMENTARY_TRANSITION_LEASE_ID = 'transition:momentary'
/** A browser Live session stays authoritative this long after its last report. */
const LIVE_STATE_TTL_MS = 15_000
/** Delay between two applied steps of one smooth transition. */
const DEFAULT_TRANSITION_STEP_MS = 220
/** Volume fades step at most every ~400ms and never run longer than three minutes. */
const FADE_STEP_MS = 400
const MAX_FADE_SECONDS = 180

/**
 * Owns the mutable policy values shared by UI routes and model tools. It is
 * intentionally process-local: profile YAML remains the only persistent host
 * configuration owner.
 *
 * Cross-layer orchestration lives here: command policy, short-lived status
 * caching, and control history.
 */
export class BridgeRuntime {
  private config: BridgeRuntimeConfig
  private readonly statusCache: StatusCache
  private controlHistory: BridgeControlActivity[] = []
  private nextControlActivityId = 1
  private transitionWork: Promise<void> = Promise.resolve()
  private activeTransition: VolumeTransitionKind | undefined
  private readonly transitionStepMs: number
  private signalPlayerId: PlayerId | undefined
  private activeFade: ActiveVolumeFade | undefined
  private fadeSequence = 1
  private liveState: { active: boolean; playing: boolean; at: number } = { active: false, playing: false, at: 0 }
  private readonly bridge: MediaBridge
  private readonly memory: ListeningMemory | undefined
  private readonly skipLedger: SkipLedger | undefined
  private readonly audioSignals: AudioSignalProvider | undefined
  private readonly liveVideos: LiveVideoProvider | undefined

  constructor(
    bridge: MediaBridge,
    initial: Partial<BridgeRuntimeConfig> = {},
    statusTtlMs: number = STATUS_CACHE_TTL_MS,
    transitionTiming: TransitionTimingOptions = {},
    memory?: ListeningMemory,
    skipLedger?: SkipLedger,
    audioSignals?: AudioSignalProvider,
    liveVideos?: LiveVideoProvider,
  ) {
    this.bridge = bridge
    this.memory = memory
    this.skipLedger = skipLedger
    this.audioSignals = audioSignals
    this.liveVideos = liveVideos
    this.config = {
      allowAgentControl: initial.allowAgentControl === true,
      deepBackground: initial.deepBackground === true,
      realWaveEnabled: initial.realWaveEnabled === true,
      playerId: initial.playerId ?? this.bridge.currentPlayerId(),
      softTransitions: initial.softTransitions === true,
      skipFadeOut: initial.skipFadeOut === true,
      preferLiveVideo: initial.preferLiveVideo === true,
    }
    // Every browser surface polls the status route and one underlying read
    // spawns a PowerShell process, so reads inside the TTL window and
    // concurrent in-flight reads share a single adapter call.
    this.statusCache = new StatusCache(
      statusTtlMs,
      () => this.config.playerId,
      () => this.bridge.status(),
    )
    this.transitionStepMs = transitionTiming.transitionStepMs ?? DEFAULT_TRANSITION_STEP_MS
  }

  getConfig(): BridgeRuntimeView {
    return { ...this.config, availablePlayers: this.bridge.listPlayers() }
  }

  updateConfig(patch: Partial<BridgeRuntimeConfig>): BridgeRuntimeView {
    if (patch.allowAgentControl !== undefined) {
      this.config = { ...this.config, allowAgentControl: patch.allowAgentControl === true }
    }
    if (patch.deepBackground !== undefined) {
      this.config = { ...this.config, deepBackground: patch.deepBackground === true }
    }
    if (patch.realWaveEnabled !== undefined) {
      this.config = { ...this.config, realWaveEnabled: patch.realWaveEnabled === true }
      if (!this.config.realWaveEnabled && this.audioSignals !== undefined) {
        // Turning the seam off ends the capture scope immediately.
        this.audioSignals.stop()
        this.signalPlayerId = undefined
      }
    }
    if (patch.softTransitions !== undefined) {
      this.config = { ...this.config, softTransitions: patch.softTransitions === true }
    }
    if (patch.skipFadeOut !== undefined) {
      this.config = { ...this.config, skipFadeOut: patch.skipFadeOut === true }
    }
    if (patch.preferLiveVideo !== undefined) {
      this.config = { ...this.config, preferLiveVideo: patch.preferLiveVideo === true }
    }
    if (patch.playerId !== undefined && patch.playerId !== this.config.playerId) {
      if (this.activeFade !== undefined) {
        throw new Error('Wait for the active volume transition to finish before switching players.')
      }
      this.bridge.selectPlayer(patch.playerId)
      this.config = { ...this.config, playerId: patch.playerId }
      // Cached status describes the previously selected player.
      this.statusCache.drop()
      this.controlHistory = []
      if (this.audioSignals !== undefined) {
        this.audioSignals.stop()
        this.signalPlayerId = undefined
      }
    }
    return this.getConfig()
  }

  async status(signal?: AbortSignal): Promise<BridgeStatus> {
    return await this.statusCache.read(signal)
  }

  /** Add short-lived UI feedback without leaking browser concerns into BridgeStatus. */
  async statusForUi(signal?: AbortSignal): Promise<BridgeUiStatus> {
    const status = await this.status(signal)
    const newest = this.controlHistory[0]
    const recentControl = newest !== undefined && Date.now() - newest.at <= 15_000
      ? newest
      : undefined
    // Live enrichment is browser-only and never blocks this read: the provider
    // starts or observes a per-track lookup and the URL rides only this view.
    const liveLookup = this.liveVideos?.read(status.track)
    const liveVideo = liveLookup?.state === 'ready' && liveLookup.value !== undefined && liveLookup.value.expiresAt > Date.now()
      ? liveLookup.value
      : undefined
    return {
      ...status,
      recentControl,
      controlHistory: [...this.controlHistory],
      ...(this.activeTransition !== undefined ? { transition: { kind: this.activeTransition } } : {}),
      memory: this.memorySummary(status),
      ...(liveVideo !== undefined ? { liveVideo } : {}),
      ...(this.liveRecentlyActive() ? { live: { active: true, playing: this.liveState.playing } } : {}),
    }
  }

  /**
   * Mirror of the web client's browser-owned Live playback session, reported
   * through /media-bridge/api/live/state. While it is fresh, agent commands
   * are refused: the server cannot touch the browser <video>, and resuming QQ
   * Music underneath it would put two audible sources on at once.
   */
  reportLiveState(state: { active?: boolean; playing?: boolean }): void {
    this.liveState = {
      active: state.active === true,
      playing: state.playing === true,
      at: Date.now(),
    }
  }

  /** Current Live mirror (browser-only view); expired sessions read as inactive. */
  liveStateView(): LiveStateView {
    return this.liveRecentlyActive()
      ? { active: true, playing: this.liveState.playing }
      : { active: false, playing: false }
  }

  private liveRecentlyActive(): boolean {
    return this.liveState.active && Date.now() - this.liveState.at <= LIVE_STATE_TTL_MS
  }

  private assertNoLiveSession(action: string): void {
    if (!this.liveRecentlyActive()) return
    throw new MediaBridgeError(
      'LIVE_VIDEO_ACTIVE',
      `A browser Live video session is playing, so the agent cannot ${action}. Ask the user to exit Live (退出 Live) in the web UI first.`,
    )
  }

  /**
   * Browser-only waveform view behind the AudioSignalProvider seam. Capture
   * starts only while the real-wave opt-in is on and the selected player is
   * playing, and it always targets exactly the selected player's processes.
   * Frames stay in memory; this view never reaches model tools.
   */
  async signalForUi(signal?: AbortSignal): Promise<AudioSignalView> {
    const status = await this.status(signal)
    const provider = this.audioSignals
    const enabled = this.config.realWaveEnabled && provider !== undefined

    if (enabled && provider !== undefined) {
      if (this.signalPlayerId !== undefined && this.signalPlayerId !== status.playerId) {
        provider.stop()
        this.signalPlayerId = undefined
      }
      if (status.state === 'playing') {
        this.signalPlayerId = status.playerId
        provider.request(status.playerId)
        return audioSignalView(status, provider.read(), { realWaveEnabled: true, providerAvailable: true })
      }
    }

    if (provider !== undefined && this.signalPlayerId !== undefined) {
      // Paused, disabled, or switched away: end the capture scope instead of
      // keeping a live loopback client around silently.
      provider.stop()
      this.signalPlayerId = undefined
    }
    return audioSignalView(status, undefined, {
      realWaveEnabled: enabled,
      providerAvailable: provider !== undefined,
    })
  }

  /**
   * One-click self-check behind the connection diagnostics center: fresh
   * adapter probes merged with browser-only context, ending in a sanitized
   * copyable report. Probe failures degrade into failed checks, never errors.
   */
  async diagnoseForUi(signal?: AbortSignal): Promise<BridgeUiDiagnostics> {
    const base = await this.bridge.diagnose(signal)
    const view: Omit<BridgeUiDiagnostics, 'report'> = {
      ...base,
      config: this.getConfig(),
      statusCache: this.statusCache.freshness(),
    }
    const config = view.config
    const extras: ReadonlyArray<readonly [string, string]> = [
      ['allow_agent_control', String(config.allowAgentControl)],
      ['deep_background', String(config.deepBackground)],
      ['status_cache_fresh', String(view.statusCache.fresh)],
      ['node', process.version],
      ['platform', `${process.platform} ${os.release()}`],
    ]
    return { ...view, report: buildSanitizedReport(view, extras) }
  }

  async launch(signal?: AbortSignal): Promise<void> {
    await this.bridge.launch(signal)
    // Playback state is about to change on its own schedule; drop stale data.
    this.statusCache.drop()
  }

  async controlFromUi(command: MediaCommand, signal?: AbortSignal): Promise<BridgeStatus> {
    return await this.controlWithSoftening('ui', command, signal)
  }

  async controlFromAgent(command: MediaCommand, signal?: AbortSignal): Promise<BridgeStatus> {
    this.assertAgentControl('control playback')
    this.assertNoLiveSession('control playback')
    return await this.controlWithSoftening('agent', command, signal)
  }

  async undoControl(activityId: number, signal?: AbortSignal): Promise<BridgeStatus> {
    this.assertNoLiveSession('undo this control while a Live video is playing')
    const activity = this.controlHistory.find((item) => item.id === activityId)
    if (activity === undefined) throw new Error('This media control activity no longer exists.')
    if (!activity.undoable || activity.undoneAt !== undefined || Date.now() - activity.at > CONTROL_UNDO_WINDOW_MS) {
      throw new Error('This media control activity can no longer be undone.')
    }
    if (activity.after.playerId !== this.config.playerId) throw new Error('The selected player changed, so this activity cannot be undone.')

    const inverse = inverseCommand(activity)
    const receipt = await this.bridge.controlWithReceipt(inverse, signal, (current) => {
      if (!matchesUndoTarget(activity, current)) {
        this.primeStatusCache(current)
        throw new Error('The player changed after this activity, so it was not undone.')
      }
    })
    this.primeStatusCache(receipt.after)
    const undoneAt = Date.now()
    this.controlHistory = this.controlHistory.map((item) => item.id === activity.id ? { ...item, undoneAt } : item)
    this.recordControl('ui', inverse, receipt, activity.id)
    return receipt.after
  }

  async dispose(): Promise<void> {
    await this.enqueueTransition(async () => {
      this.cancelActiveFade('cancelled')
    })
    this.audioSignals?.dispose()
    this.signalPlayerId = undefined
  }

  /**
   * Plain-language explanation for model tools: read-only, so it needs no
   * opt-in — exactly like media_bridge_status.
   */
  async explainStatus(signal?: AbortSignal): Promise<StatusExplanation> {
    const status = await this.status(signal)
    return {
      summary: formatStatusExplanation(status, {
        agentPlaybackAllowed: this.config.allowAgentControl,
        liveVideoActive: this.liveRecentlyActive(),
      }),
      status,
    }
  }

  // ------------------------------------------------------------- volume fade

  async fadeFromUi(volumePercent: number, durationSeconds: number, signal?: AbortSignal): Promise<BridgeStatus> {
    return await this.runVolumeFade(volumePercent, durationSeconds, 'ui', signal)
  }

  async fadeFromAgent(volumePercent: number, durationSeconds: number, signal?: AbortSignal): Promise<BridgeStatus> {
    if (!this.config.allowAgentControl) {
      throw new MediaBridgeError(
        'AGENT_CONTROL_DISABLED',
        'Agent control is disabled. Enable it in Settings → 音乐桥 before asking an agent to control playback.',
      )
    }
    this.assertNoLiveSession('fade the player volume')
    return await this.runVolumeFade(volumePercent, durationSeconds, 'agent', signal)
  }

  private async runVolumeFade(volumePercent: number, durationSeconds: number, source: BridgeControlActivity['source'], signal?: AbortSignal): Promise<BridgeStatus> {
    if (!Number.isFinite(volumePercent) || volumePercent < 0 || volumePercent > 100) {
      throw new Error('Fade target volume must be from 0 to 100.')
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > MAX_FADE_SECONDS) {
      throw new Error(`Fade duration must be between 0 and ${MAX_FADE_SECONDS} seconds.`)
    }
    return await this.enqueueTransition(async () => {
      this.cancelActiveFade('superseded')
      let current = await this.bridge.status(signal)
      this.primeStatusCache(current)
      if (!current.capabilities.volume || current.volumePercent === undefined) {
        throw new Error('The selected player does not expose its own audio session volume, so there is nothing to fade.')
      }
      if (Math.abs(current.volumePercent - volumePercent) < 0.5) return current

      // A near-zero duration is an ordinary recorded set-volume command.
      if (durationSeconds < 0.4) {
        return await this.performControl(source, { kind: 'set-volume', volumePercent }, signal)
      }

      const before = current
      const durationMs = Math.round(durationSeconds * 1000)
      let settle!: (status: BridgeStatus) => void
      let fail!: (error: Error) => void
      const settled = new Promise<BridgeStatus>((resolve, reject) => { settle = resolve; fail = reject })
      const fade: ActiveVolumeFade = {
        id: this.fadeSequence,
        source,
        playerId: current.playerId,
        startVolume: current.volumePercent,
        targetVolume: volumePercent,
        durationMs,
        startedAt: Date.now(),
        lastAppliedVolume: current.volumePercent,
        cancelled: false,
        settle,
        fail,
      }
      this.fadeSequence += 1
      this.activeFade = fade
      void this.stepVolumeFade(fade, before, signal)
        .then(settle, fail)
        .finally(() => {
          if (this.activeFade === fade) this.activeFade = undefined
        })
      return await settled
    })
  }

  private async stepVolumeFade(fade: ActiveVolumeFade, before: BridgeStatus, signal?: AbortSignal): Promise<BridgeStatus> {
    const stepCount = Math.max(2, Math.min(80, Math.ceil(fade.durationMs / FADE_STEP_MS)))
    const stepMs = fade.durationMs / stepCount
    let latest = await this.bridge.status(signal)
    for (let step = 1; step <= stepCount; step += 1) {
      if (fade.cancelled || this.activeFade !== fade) return latest
      await delay(stepMs, signal)
      if (fade.cancelled || this.activeFade !== fade) return latest
      latest = await this.bridge.status(signal)
      this.primeStatusCache(latest)
      if (latest.playerId !== fade.playerId) {
        this.activeFade = undefined
        throw new Error('The selected player changed during the volume fade.')
      }
      if (latest.volumePercent !== undefined && Math.abs(latest.volumePercent - fade.lastAppliedVolume) > 1.5) {
        // The user moved volume in the player or UI; stop the fade immediately.
        this.activeFade = undefined
        return latest
      }
      const progress = Math.min(1, (Date.now() - fade.startedAt) / fade.durationMs)
      const target = Math.round(fade.startVolume + (fade.targetVolume - fade.startVolume) * progress)
      if (Math.abs(target - fade.lastAppliedVolume) < 1 && step !== stepCount) continue
      latest = await this.performUnrecordedControl({ kind: 'set-volume', volumePercent: target }, signal)
      fade.lastAppliedVolume = latest.volumePercent ?? target
    }
    // Land exactly on the requested value so the recorded activity matches intent.
    if (!fade.cancelled && this.activeFade === fade && latest.volumePercent !== undefined
      && Math.abs(latest.volumePercent - fade.targetVolume) >= 0.5) {
      latest = await this.performUnrecordedControl({ kind: 'set-volume', volumePercent: fade.targetVolume }, signal)
    }
    if (this.activeFade === fade) {
      this.activeFade = undefined
      this.recordControl(fade.source, { kind: 'set-volume', volumePercent: fade.targetVolume }, { before, after: latest })
    }
    return latest
  }

  private cancelActiveFade(_reason?: string): void {
    const fade = this.activeFade
    if (fade === undefined) return
    fade.cancelled = true
    this.activeFade = undefined
  }

  // ------------------------------------------------------------ local memory

  memoryToday(): readonly ListeningEntry[] {
    return this.memory?.today() ?? []
  }

  memoryRecent(limit: number): readonly ListeningEntry[] {
    return this.memory?.recent(limit) ?? []
  }

  memoryFavorites(): readonly FavoriteEntry[] {
    return this.memory?.favorites() ?? []
  }

  /** Toggle favorite for explicit track data, or for the currently playing track when omitted. */
  async toggleMemoryFavorite(input: FavoriteToggleInput | undefined, signal?: AbortSignal): Promise<{ favorite: boolean; favorites: readonly FavoriteEntry[] }> {
    let target = input
    if (target === undefined) {
      const status = await this.status(signal)
      if (status.track === undefined) throw new Error('当前没有正在播放或已知的歌曲，无法收藏。请先播放一首歌，或提供 title/artist。')
      target = {
        playerId: status.playerId,
        title: status.track.title,
        artist: status.track.artist,
        ...(status.track.album ? { album: status.track.album } : {}),
        ...(status.track.artworkUrl ? { artworkUrl: status.track.artworkUrl } : {}),
      }
    }
    return this.memory !== undefined
      ? this.memory.toggleFavorite(target)
      : { favorite: false, favorites: [] }
  }

  removeMemoryFavorite(key: string): boolean {
    return this.memory?.removeFavorite(key) ?? false
  }

  private memorySummary(status: BridgeStatus): MemorySummary {
    return this.memory?.summary(status.track, status.playerId)
      ?? { favorite: false, favoritesCount: 0, todayTracks: 0, todaySeconds: 0 }
  }

  /**
   * 听歌周报 mini report (listened time / artist ranking / track switches)
   * plus the skip-rate insight, aggregated from the shared listening history
   * and the explicit next/previous ledger.
   */
  async listeningReport(range: ListeningReportRange): Promise<ListeningReport> {
    const days = range === 'today' ? 1 : 7
    const entries = this.memoryRecent(Math.min(4_000, days * 400))
    return buildListeningReport(entries, this.skipLedger?.recent(days) ?? [], { range })
  }

  private assertAgentControl(action: string): void {
    if (this.config.allowAgentControl) return
    throw new MediaBridgeError(
      'AGENT_CONTROL_DISABLED',
      `Agent control is disabled. Enable it in Settings → 音乐桥 before asking an agent to ${action}.`,
    )
  }

  private async performControl(source: BridgeControlActivity['source'], command: MediaCommand, signal?: AbortSignal): Promise<BridgeStatus> {
    const receipt = await this.bridge.controlWithReceipt(command, signal)
    this.primeStatusCache(receipt.after)
    this.recordControl(source, command, receipt)
    return receipt.after
  }

  private async performUnrecordedControl(command: MediaCommand, signal?: AbortSignal): Promise<BridgeStatus> {
    const receipt = await this.bridge.controlWithReceipt(command, signal)
    this.primeStatusCache(receipt.after)
    return receipt.after
  }

  // ---------------------------------------------------- smooth transitions

  /** Softening wrapper for UI/Agent transport commands; falls back to the plain command whenever a fade cannot help. */
  private async controlWithSoftening(source: BridgeControlActivity['source'], command: MediaCommand, signal?: AbortSignal): Promise<BridgeStatus> {
    if (command.kind === 'play-pause' && this.config.softTransitions) {
      return await this.enqueueTransition(() => this.softPlayPause(source, signal))
    }
    if ((command.kind === 'next' || command.kind === 'previous') && this.config.skipFadeOut && this.config.softTransitions) {
      return await this.enqueueTransition(() => this.skipTrackWithDip(source, command.kind, signal))
    }
    return await this.performControl(source, command, signal)
  }

  private async softPlayPause(source: BridgeControlActivity['source'], signal?: AbortSignal): Promise<BridgeStatus> {
    const current = await this.bridge.status(signal)
    this.primeStatusCache(current)
    // Configuration may have changed while this request waited on the queue.
    if (!this.config.softTransitions || current.state === 'unavailable'
      || !current.capabilities.playPause || !current.capabilities.volume
      || current.volumePercent === undefined) {
      return await this.performControl(source, { kind: 'play-pause' }, signal)
    }
    if (current.state === 'playing') return await this.pauseSoftly(source, current.volumePercent, signal)
    return await this.resumeSoftly(source, current.volumePercent, signal)
  }

  private async pauseSoftly(source: BridgeControlActivity['source'], volume: number, signal?: AbortSignal): Promise<BridgeStatus> {
    this.activeTransition = 'pause-fade'
    let fadedToZero = false
    try {
      try {
        await this.softRamp({
          kind: 'pause-fade',
          targetPercent: 0,
          leaseId: MOMENTARY_TRANSITION_LEASE_ID,
          leaseBeforeVolume: volume,
          signal,
        })
        fadedToZero = true
      } catch (error) {
        if (error instanceof TransitionAbortedError) {
          // Manual takeover keeps the listener's level; a player change stops everything.
          if (error.reason === 'player-changed') throw error
        } else {
          // Fade machinery failed: undo what we can, still honor the pause instantly.
          try { await this.restoreQuietly(volume, signal) } catch { /* the pause below still happens */ }
        }
      }
      const paused = await this.performControl(source, { kind: 'play-pause' }, signal)
      if (!fadedToZero) return paused
      // Paused playback is silent, so the listening volume goes back immediately.
      try {
        return await this.restoreQuietly(volume, signal)
      } catch {
        return paused
      }
    } finally {
      try { await this.bridge.clearVolumeLease(MOMENTARY_TRANSITION_LEASE_ID, signal) } catch { /* journal cleanup stays best-effort */ }
      this.activeTransition = undefined
    }
  }

  private async resumeSoftly(source: BridgeControlActivity['source'], volume: number, signal?: AbortSignal): Promise<BridgeStatus> {
    this.activeTransition = 'resume-rise'
    try {
      const startFrom = resumeStartPercent(volume)
      if (volume - startFrom >= MIN_RAMP_DELTA_PERCENT) {
        try {
          await this.bridge.armVolumeLease({
            id: MOMENTARY_TRANSITION_LEASE_ID,
            beforeVolume: volume,
            appliedVolume: startFrom,
            previousAppliedVolume: volume,
          }, signal)
          await this.performUnrecordedControl({ kind: 'set-volume', volumePercent: startFrom }, signal)
        } catch {
          // Pre-drop failed: play at the standing volume rather than blocking playback.
          return await this.performControl(source, { kind: 'play-pause' }, signal)
        }
      }
      const played = await this.performControl(source, { kind: 'play-pause' }, signal)
      try {
        return await this.softRamp({
          kind: 'resume-rise',
          targetPercent: volume,
          leaseId: MOMENTARY_TRANSITION_LEASE_ID,
          leaseBeforeVolume: volume,
          signal,
        })
      } catch (error) {
        if (error instanceof TransitionAbortedError && error.reason === 'player-changed') throw error
        return played
      }
    } finally {
      try { await this.bridge.clearVolumeLease(MOMENTARY_TRANSITION_LEASE_ID, signal) } catch { /* journal cleanup stays best-effort */ }
      this.activeTransition = undefined
    }
  }

  /** Optional short dip before switching tracks: fade out, switch, restore at once 鈥?not a crossfade. */
  private async skipTrackWithDip(source: BridgeControlActivity['source'], kind: 'next' | 'previous', signal?: AbortSignal): Promise<BridgeStatus> {
    const current = await this.bridge.status(signal)
    this.primeStatusCache(current)
    if (current.state !== 'playing' || !current.capabilities.volume
      || current.volumePercent === undefined || current.volumePercent < MIN_RAMP_DELTA_PERCENT
      || !(kind === 'next' ? current.capabilities.next : current.capabilities.previous)) {
      return await this.performControl(source, { kind }, signal)
    }
    const volume = current.volumePercent
    this.activeTransition = 'skip-dip'
    let dippedToZero = false
    try {
      try {
        await this.softRamp({
          kind: 'skip-dip',
          targetPercent: 0,
          leaseId: MOMENTARY_TRANSITION_LEASE_ID,
          leaseBeforeVolume: volume,
          signal,
        })
        dippedToZero = true
      } catch (error) {
        if (error instanceof TransitionAbortedError && error.reason === 'player-changed') throw error
      }
      const switched = await this.performControl(source, { kind }, signal)
      if (!dippedToZero) return switched
      // The new track starts at full listening volume immediately.
      try {
        return await this.restoreQuietly(volume, signal)
      } catch {
        return switched
      }
    } finally {
      try { await this.bridge.clearVolumeLease(MOMENTARY_TRANSITION_LEASE_ID, signal) } catch { /* journal cleanup stays best-effort */ }
      this.activeTransition = undefined
    }
  }

  /** Best-effort silent volume restore; used while nothing should be audible. */
  private async restoreQuietly(volumePercent: number, signal?: AbortSignal): Promise<BridgeStatus> {
    return await this.performUnrecordedControl({ kind: 'set-volume', volumePercent }, signal)
  }

  /**
   * One linear ramp toward the target, following the sleep timer's rules:
   * every step re-arms the crash-recovery lease, guards reject the underlying
   * command before it executes when the player changed or a person took over
   * the volume, and only the optional final step lands in control history.
   */
  private async softRamp(options: {
    kind: VolumeTransitionKind
    targetPercent: number
    leaseId: string
    leaseBeforeVolume: number
    recordFinalSource?: BridgeControlActivity['source']
    signal?: AbortSignal
  }): Promise<BridgeStatus> {
    const durationMs = TRANSITION_DURATIONS_MS[options.kind]
    const current = await this.bridge.status(options.signal)
    this.primeStatusCache(current)
    const start = current.volumePercent
    if (!current.capabilities.volume || start === undefined
      || Math.abs(start - options.targetPercent) < MIN_RAMP_DELTA_PERCENT) {
      return current
    }
    const steps = planRampSteps(start, options.targetPercent, durationMs, this.transitionStepMs)
    const expectedPlayer = this.config.playerId
    let lastApplied = start
    let latest = current
    for (let index = 0; index < steps.length; index += 1) {
      const percent = steps[index]
      if (percent === undefined) continue
      const isFinalStep = index === steps.length - 1
      if (index > 0) {
        await new Promise<void>((resolve) => { setTimeout(resolve, this.transitionStepMs) })
      }
      await this.bridge.armVolumeLease({
        id: options.leaseId,
        beforeVolume: options.leaseBeforeVolume,
        appliedVolume: percent,
        previousAppliedVolume: lastApplied,
      }, options.signal)
      try {
        const receipt = await this.bridge.controlWithReceipt(
          { kind: 'set-volume', volumePercent: percent },
          options.signal,
          (status) => this.assertTransitionAlive(status, expectedPlayer, lastApplied),
        )
        this.primeStatusCache(receipt.after)
        if (isFinalStep && options.recordFinalSource !== undefined) {
          this.recordControl(options.recordFinalSource, { kind: 'set-volume', volumePercent: percent }, receipt)
        }
        latest = receipt.after
        lastApplied = receipt.after.volumePercent ?? percent
      } catch (error) {
        try {
          await this.bridge.armVolumeLease({
            id: options.leaseId,
            beforeVolume: options.leaseBeforeVolume,
            appliedVolume: lastApplied,
            previousAppliedVolume: lastApplied,
          }, options.signal)
        } catch { /* journal repair stays best-effort */ }
        throw error
      }
    }
    return latest
  }

  private assertTransitionAlive(status: BridgeStatus, expectedPlayer: PlayerId, lastApplied: number): void {
    if (status.playerId !== expectedPlayer || !status.capabilities.volume) {
      throw new TransitionAbortedError('player-changed', 'The selected player changed during a smooth transition.')
    }
    if (volumeDeviated(lastApplied, status.volumePercent)) {
      throw new TransitionAbortedError('volume-overridden', 'The player volume changed during a smooth transition.')
    }
  }

  private enqueueTransition<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.transitionWork.then(operation, operation)
    this.transitionWork = running.then(
      () => undefined,
      () => undefined,
    )
    return running
  }

  private recordControl(source: BridgeControlActivity['source'], command: MediaCommand, receipt: MediaControlReceipt, undoOf?: number): void {
    // Skip-rate analysis: an explicit next/previous pressed by the user while
    // the track was actually playing.
    if ((command.kind === 'next' || command.kind === 'previous') && source === 'ui' && receipt.before.state === 'playing') {
      const artist = receipt.before.track?.artist
      if (artist !== undefined) this.skipLedger?.note(artist)
    }
    const activity: BridgeControlActivity = {
      id: this.nextControlActivityId,
      source,
      command,
      at: Date.now(),
      before: snapshotOf(receipt.before),
      after: snapshotOf(receipt.after),
      undoable: undoOf === undefined && isUndoable(command, receipt),
      undoOf,
    }
    this.controlHistory = [activity, ...this.controlHistory].slice(0, 20)
    this.nextControlActivityId += 1
  }

  private primeStatusCache(status: BridgeStatus): void {
    this.statusCache.prime(status)
  }
}

function snapshotOf(status: BridgeStatus): BridgeControlSnapshot {
  return {
    playerId: status.playerId,
    playerName: status.playerName,
    state: status.state,
    trackTitle: status.track?.title,
    trackArtist: status.track?.artist,
    positionSeconds: status.positionSeconds,
    volumePercent: status.volumePercent,
  }
}

function sameTrack(snapshot: BridgeControlSnapshot, status: BridgeStatus): boolean {
  return snapshot.playerId === status.playerId
    && snapshot.trackTitle === status.track?.title
    && snapshot.trackArtist === status.track?.artist
}

function isUndoable(command: MediaCommand, receipt: MediaControlReceipt): boolean {
  if (command.kind === 'play-pause') {
    return receipt.before.state !== receipt.after.state
      && receipt.before.state !== 'unavailable'
      && receipt.after.state !== 'unavailable'
  }
  if (command.kind === 'set-volume') {
    return receipt.before.volumePercent !== undefined
      && receipt.after.volumePercent !== undefined
      && Math.abs(receipt.before.volumePercent - receipt.after.volumePercent) >= 0.5
  }
  return command.kind === 'seek'
    && receipt.before.positionSeconds !== undefined
    && receipt.after.positionSeconds !== undefined
    && sameTrack(snapshotOf(receipt.before), receipt.after)
}

function matchesUndoTarget(activity: BridgeControlActivity, current: BridgeStatus): boolean {
  if (!sameTrack(activity.after, current)) return false
  if (activity.command.kind === 'play-pause') return current.state === activity.after.state
  if (activity.command.kind === 'set-volume') {
    return current.volumePercent !== undefined
      && activity.after.volumePercent !== undefined
      && Math.abs(current.volumePercent - activity.after.volumePercent) <= 1.5
  }
  if (activity.command.kind === 'seek') {
    if (current.positionSeconds === undefined || activity.after.positionSeconds === undefined) return false
    const expectedAdvance = activity.after.state === 'playing' ? (Date.now() - activity.at) / 1000 : 0
    return Math.abs(current.positionSeconds - activity.after.positionSeconds) <= expectedAdvance + 4
  }
  return false
}

function inverseCommand(activity: BridgeControlActivity): MediaCommand {
  if (activity.command.kind === 'play-pause') return { kind: 'play-pause' }
  if (activity.command.kind === 'set-volume' && activity.before.volumePercent !== undefined) {
    return { kind: 'set-volume', volumePercent: activity.before.volumePercent }
  }
  if (activity.command.kind === 'seek' && activity.before.positionSeconds !== undefined) {
    return { kind: 'seek', positionSeconds: activity.before.positionSeconds }
  }
  throw new Error('This media control activity cannot be undone.')
}

/** Sleep for one fade step; rejects early when the caller's signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Volume fade aborted.'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Volume fade aborted.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer.unref?.()
  })
}
