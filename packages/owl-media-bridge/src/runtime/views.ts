/**
 * Browser-only view vocabulary. These types ride the UI status projection
 * (`BridgeUiStatus`) and browser-only routes; model-facing tool output never
 * includes them (see docs/live-video-design.md for the Live projection split).
 */

/** Where a live video description was resolved from. */
export type LiveVideoProviderId = 'qq-music'

/**
 * Normalized description of one playable live/stage video for the current
 * track. `url` is a short-lived HTTPS MP4 resolved from QQ Music's public,
 * cookie-free endpoints: it exists so the same-origin web UI can play the
 * video, and must never reach model tools or be persisted to disk.
 */
export interface LiveVideoDescription {
  readonly provider: LiveVideoProviderId
  readonly kind: 'live'
  readonly vid: string
  readonly url: string
  readonly title: string
  /** Epoch ms after which the resolved URL must be considered stale. */
  readonly expiresAt: number
  readonly durationSeconds?: number
  readonly fileSize?: number
}

/** Browser-owned Live playback mirror reported by the web client. */
export interface LiveStateView {
  /** True while the browser is playing (or holding) a Live video session. */
  readonly active: boolean
  /** True while the Live video itself is actually playing (not paused). */
  readonly playing: boolean
}
