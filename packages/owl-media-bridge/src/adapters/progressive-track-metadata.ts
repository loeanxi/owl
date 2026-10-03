import type { Track } from '../domain/types.ts'

export type ProgressiveMetadataState = 'pending' | 'ready' | 'degraded'

export interface ProgressiveMetadataSnapshot<T> {
  readonly state: ProgressiveMetadataState
  readonly value?: T
}

interface MetadataEntry<T> {
  state: ProgressiveMetadataState
  value?: T
  expiresAt: number
  lastUsedAt: number
  controller?: AbortController
}

export interface ProgressiveMetadataOptions<T> {
  readonly hasValue: (value: T) => boolean
  readonly refreshAfterMs?: (value: T) => number
  readonly retryAfterMs?: number
  readonly maxEntries?: number
}

/**
 * Keeps remote metadata work behind the player adapter seam. A status read
 * starts or observes enrichment but never waits for the network.
 */
export class ProgressiveTrackMetadata<T> {
  private readonly entries = new Map<string, MetadataEntry<T>>()
  private activeKey: string | undefined
  private readonly resolve: (track: Track, signal: AbortSignal) => Promise<T | undefined>
  private readonly options: ProgressiveMetadataOptions<T>
  private readonly retryAfterMs: number
  private readonly maxEntries: number

  constructor(
    resolve: (track: Track, signal: AbortSignal) => Promise<T | undefined>,
    options: ProgressiveMetadataOptions<T>,
  ) {
    this.resolve = resolve
    this.options = options
    this.retryAfterMs = options.retryAfterMs ?? 15_000
    this.maxEntries = options.maxEntries ?? 16
  }

  read(track: Track | undefined): ProgressiveMetadataSnapshot<T> | undefined {
    if (track === undefined) {
      this.cancelActive()
      return undefined
    }

    const key = trackKey(track)
    if (this.activeKey !== key) {
      this.cancelActive()
      this.activeKey = key
    }

    const now = Date.now()
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      existing.lastUsedAt = now
      if (existing.state === 'pending') return snapshot(existing)
      if (existing.expiresAt > now) return snapshot(existing)
    }

    return this.start(key, track, existing?.value)
  }

  private start(key: string, track: Track, staleValue: T | undefined): ProgressiveMetadataSnapshot<T> {
    const controller = new AbortController()
    const entry: MetadataEntry<T> = {
      state: 'pending',
      value: staleValue,
      expiresAt: Number.POSITIVE_INFINITY,
      lastUsedAt: Date.now(),
      controller,
    }
    this.entries.set(key, entry)
    this.prune()

    void this.resolve(track, controller.signal).then((value) => {
      if (controller.signal.aborted || this.entries.get(key) !== entry) return
      const hasValue = value !== undefined && this.options.hasValue(value)
      this.entries.set(key, {
        state: hasValue ? 'ready' : 'degraded',
        value: hasValue && value !== undefined ? value : undefined,
        expiresAt: Date.now() + (hasValue ? (this.options.refreshAfterMs?.(value) ?? 60 * 60 * 1000) : this.retryAfterMs),
        lastUsedAt: Date.now(),
      })
    }).catch(() => {
      if (controller.signal.aborted || this.entries.get(key) !== entry) return
      this.entries.set(key, {
        state: staleValue === undefined ? 'degraded' : 'ready',
        value: staleValue,
        expiresAt: Date.now() + this.retryAfterMs,
        lastUsedAt: Date.now(),
      })
    })

    return snapshot(entry)
  }

  private cancelActive(): void {
    if (this.activeKey !== undefined) {
      const entry = this.entries.get(this.activeKey)
      entry?.controller?.abort()
      if (entry?.state === 'pending') this.entries.delete(this.activeKey)
    }
    this.activeKey = undefined
  }

  private prune(): void {
    if (this.entries.size <= this.maxEntries) return
    const candidates = [...this.entries.entries()]
      .filter(([key, entry]) => key !== this.activeKey && entry.state !== 'pending')
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
    for (const [key] of candidates) {
      if (this.entries.size <= this.maxEntries) break
      this.entries.delete(key)
    }
  }
}

function snapshot<T>(entry: MetadataEntry<T>): ProgressiveMetadataSnapshot<T> {
  return entry.value === undefined ? { state: entry.state } : { state: entry.state, value: entry.value }
}

function trackKey(track: Track): string {
  return `${normalize(track.title)}\u0000${normalize(track.artist)}`
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, '')
}
