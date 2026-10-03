import type { BridgeStatus, PlayerId } from '../domain/types.ts'

/** Default freshness window that merges concurrent status reads into one adapter call. */
export const STATUS_CACHE_TTL_MS = 500

/**
 * Owns the short-lived status cache shared by every browser surface. Each
 * surface polls the status route and one underlying read spawns a PowerShell
 * process, so reads inside the TTL window and concurrent in-flight reads share
 * a single adapter call. Commands still read fresh status for their capability
 * check, but prime the cache with the post-command status they already return.
 */
export class StatusCache {
  private cachedStatus: BridgeStatus | undefined
  private cachedAt = 0
  private inflightStatus: Promise<BridgeStatus> | undefined
  /** Invalidates reads that were started before launch/player-policy changes. */
  private generation = 0

  constructor(
    private readonly ttlMs: number,
    /** Guards priming/settling against stale player selections racing a switch. */
    private readonly currentPlayerId: () => PlayerId,
    /** The authoritative loader; must bypass this cache and re-read on each call. */
    private readonly load: () => Promise<BridgeStatus>,
  ) {}

  async read(signal?: AbortSignal): Promise<BridgeStatus> {
    const cached = this.freshCachedStatus()
    if (cached !== undefined) return cached
    const running = this.inflightStatus ?? this.readStatusIntoCache()
    if (signal === undefined) return await running
    return await abortable(running, signal)
  }

  prime(status: BridgeStatus): void {
    if (status.playerId === this.currentPlayerId()) {
      this.cachedStatus = status
      this.cachedAt = Date.now()
    }
  }

  drop(): void {
    this.cachedStatus = undefined
    this.cachedAt = 0
    this.generation += 1
    // Existing callers may still await the old read, but a poll started after
    // this invalidation must create a request for the current player/policy.
    this.inflightStatus = undefined
  }

  freshness(): { updatedAt?: number; ageMs?: number; fresh: boolean } {
    return {
      updatedAt: this.cachedAt > 0 ? this.cachedAt : undefined,
      ageMs: this.cachedAt > 0 ? Date.now() - this.cachedAt : undefined,
      fresh: this.freshCachedStatus() !== undefined,
    }
  }

  private freshCachedStatus(): BridgeStatus | undefined {
    return this.cachedStatus !== undefined && Date.now() - this.cachedAt < this.ttlMs
      ? this.cachedStatus
      : undefined
  }

  /** One shared read serves every concurrent poller; it fills the cache when it lands. */
  private readStatusIntoCache(): Promise<BridgeStatus> {
    const playerId = this.currentPlayerId()
    const generation = this.generation
    const running = this.load().then((status) => {
      if (playerId === this.currentPlayerId() && generation === this.generation) {
        this.cachedStatus = status
        this.cachedAt = Date.now()
      }
      return status
    })
    this.inflightStatus = running
    const settle = () => {
      if (this.inflightStatus === running) this.inflightStatus = undefined
    }
    running.then(settle, settle)
    return running
  }
}

/** Resolve with the shared promise unless the caller's signal fires first; the shared read keeps running either way. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Status read aborted.'))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error) => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}
