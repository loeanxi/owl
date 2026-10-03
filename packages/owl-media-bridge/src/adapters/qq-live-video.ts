import type { Track } from '../domain/types.ts'
import type { LiveVideoDescription } from '../runtime/views.ts'

interface SmartboxSong {
  readonly mid?: string
  readonly name?: string
  readonly singer?: string
}

interface SmartboxMv {
  readonly vid?: string
  readonly name?: string
  readonly singer?: string
}

interface VideoSinger {
  readonly name?: string
  readonly mid?: string
}

interface VideoInfo {
  readonly vid?: string
  readonly name?: string
  readonly duration?: number
  readonly playcnt?: number
  readonly singers?: readonly VideoSinger[]
}

interface MvUrlFormat {
  readonly code?: number
  readonly expire?: number
  readonly fileSize?: number
  readonly freeflow_url?: readonly string[]
}

interface VideoLookup {
  readonly video?: LiveVideoDescription
  /** How long the (possibly negative) result may be cached. */
  readonly cacheTtlMs: number
}

interface CacheEntry {
  readonly video?: LiveVideoDescription
  readonly expiresAt: number
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Default per-request ceiling for the public QQ endpoints. Live resolution
 * always runs beside the authoritative status read, so a slow lookup must
 * never delay playback control.
 */
const REQUEST_TIMEOUT_MS = 3500
/** A track that QQ's public endpoints cannot match re-checks after 2 minutes. */
const NO_MATCH_TTL_MS = 2 * 60_000
/** Network/format failures back off briefly so a transient outage retries soon. */
const FAILURE_TTL_MS = 30_000
/** Cached URLs must stop being handed out well before the remote key expires. */
const URL_EXPIRY_MARGIN_MS = 5 * 60_000
const MAX_CACHE_TTL_MS = 30 * 60_000
const MIN_CACHE_TTL_MS = 10_000
/** Background playback does not need the top bitrate; ~320 kbps is the floor. */
const MIN_SUFFICIENT_BYTES_PER_SECOND = 40_000

/**
 * Explicit live/stage markers. A video qualifies only when its title carries
 * one of these; ordinary studio MVs must never enter Live mode.
 */
const LIVE_MARKERS = /\blive\b|\bconcert\b|\btour\b|现场|官摄|演唱会|舞台|巡迴|巡回/i
/** Covers, instrumentals, edits and fan-made uploads are rejected outright. */
const REJECT_MARKERS = /翻唱|伴奏|纯音乐|铃声|剪辑|花絮|教学|饭制|自制|网友|reaction|cover|remix|karaoke|instrumental/i

/**
 * Resolves reliable Live/现场/官摄 videos for the current track from QQ
 * Music's public, cookie-free endpoints only. Every candidate passes strict
 * title + artist + live-marker matching before it is offered to the UI; any
 * failure degrades to "no live" without ever breaking a status read.
 */
export class QqLiveVideoResolver {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<VideoLookup>>()

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  async resolve(track: Track, signal?: AbortSignal): Promise<LiveVideoDescription | undefined> {
    throwIfAborted(signal)
    const key = `${normalize(track.title)}\u0000${normalize(track.artist)}`
    const cached = this.cache.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      // Track switches cancel obsolete lookups; concurrent pollers for the
      // same new track share one in-flight lookup instead of fanning out.
      return cached.video
    }
    const pending = this.inflight.get(key)
    if (pending !== undefined) {
      const result = await pending
      throwIfAborted(signal)
      return result.video
    }
    const running = this.lookup(track, signal)
    this.inflight.set(key, running)
    try {
      const result = await running
      throwIfAborted(signal)
      this.cache.set(key, {
        ...(result.video !== undefined ? { video: result.video } : {}),
        expiresAt: Date.now() + result.cacheTtlMs,
      })
      return result.video
    } finally {
      this.inflight.delete(key)
    }
  }

  private async lookup(track: Track, signal?: AbortSignal): Promise<VideoLookup> {
    try {
      const song = await this.matchSong(track, signal)
      if (song === undefined) return { cacheTtlMs: NO_MATCH_TTL_MS }

      const detail = await this.fetchSongDetail(song.mid, signal)
      if (detail === undefined) return { cacheTtlMs: FAILURE_TTL_MS }

      // Candidates: the song's own MV plus public MV suggestions for the same
      // title/artist. Every vid is verified against the authoritative video
      // info batch — suggestion titles alone never authorize a match.
      const suggestionVids = await this.fetchMvSuggestions(track, signal)
      const vids = unique([detail.mvVid ?? '', ...suggestionVids.map((entry) => entry.vid)].filter((vid) => vid !== ''))
      if (vids.length === 0) return { cacheTtlMs: NO_MATCH_TTL_MS }

      const infos = await this.fetchVideoInfos(vids, signal)
      const expectedArtists = artistVariants(track.artist)
      const ranked = rankCandidates(track, detail, suggestionVids, infos, expectedArtists)
      if (ranked === undefined) return { cacheTtlMs: NO_MATCH_TTL_MS }

      const playback = await this.fetchMvPlayUrl(ranked.vid, ranked.durationSeconds, signal)
      if (playback === undefined) return { cacheTtlMs: FAILURE_TTL_MS }
      return {
        video: {
          provider: 'qq-music',
          kind: 'live',
          vid: ranked.vid,
          url: playback.url,
          title: ranked.title,
          expiresAt: playback.expiresAt,
          durationSeconds: ranked.durationSeconds,
          fileSize: playback.fileSize,
        },
        cacheTtlMs: Math.max(MIN_CACHE_TTL_MS, Math.min(MAX_CACHE_TTL_MS, playback.expiresAt - Date.now() - URL_EXPIRY_MARGIN_MS)),
      }
    } catch {
      // Timeout, abort between stages, or malformed payload: an explicit "no
      // live" that never blocks or breaks the normal status flow.
      return { cacheTtlMs: FAILURE_TTL_MS }
    }
  }

  /** Song-level matching reuses the cover resolver's strict title+artist rules. */
  private async matchSong(track: Track, signal?: AbortSignal): Promise<{ mid: string } | undefined> {
    const searchTerms = unique([`${track.title} ${track.artist}`, track.title])
    const expectedTitles = titleVariants(track.title)
    const expectedArtists = artistVariants(track.artist)
    for (const term of searchTerms) {
      const search = await this.runFetch(`https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&key=${encodeURIComponent(term)}`, {
        headers: { referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
      }, signal)
      if (!search.ok) continue
      const payload = await search.json() as { data?: { song?: { itemlist?: SmartboxSong[] } } }
      const candidates = payload.data?.song?.itemlist ?? []
      const matchesTitle = (candidate: SmartboxSong) => expectedTitles.some((title) => {
        const candidateTitle = normalize(candidate.name)
        return candidateTitle === title || candidateTitle.includes(title) || title.includes(candidateTitle)
      })
      const matchesArtist = (candidate: SmartboxSong) => {
        const singer = normalize(candidate.singer)
        return expectedArtists.some((artist) => singer.includes(artist))
      }
      const match = candidates.find((candidate) => matchesTitle(candidate) && matchesArtist(candidate))
        ?? candidates.find((candidate) => matchesTitle(candidate))
      if (match?.mid !== undefined && match.mid !== '') return { mid: match.mid }
    }
    return undefined
  }

  private async fetchSongDetail(songMid: string, signal?: AbortSignal): Promise<{ mvVid?: string; singers: readonly string[] } | undefined> {
    const detail = await this.runFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'content-type': 'application/json', referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        comm: { ct: 24, cv: 0, format: 'json' },
        'music.pf_song_detail_svr': {
          module: 'music.pf_song_detail_svr',
          method: 'get_song_detail_yqq',
          param: { song_mid: songMid },
        },
      }),
    }, signal)
    if (!detail.ok) return undefined
    const payload = await detail.json() as {
      ['music.pf_song_detail_svr']?: { data?: { track_info?: { mv?: { vid?: string }; singer?: readonly VideoSinger[] } } }
    }
    const info = payload['music.pf_song_detail_svr']?.data?.track_info
    const vid = info?.mv?.vid
    return {
      ...(vid !== undefined && vid !== '' ? { mvVid: vid } : {}),
      singers: (info?.singer ?? []).map((singer) => singer.name ?? '').filter((name) => name !== ''),
    }
  }

  /** Public MV suggestions for the plain title/artist; sparse but cookie-free. */
  private async fetchMvSuggestions(track: Track, signal?: AbortSignal): Promise<readonly { vid: string; name?: string; singer?: string }[]> {
    const queries = unique([`${track.title} ${track.artist}`, track.title, track.artist])
    const suggestions: { vid: string; name?: string; singer?: string }[] = []
    for (const query of queries) {
      try {
        const search = await this.runFetch(`https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&key=${encodeURIComponent(query)}`, {
          headers: { referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
        }, signal)
        if (!search.ok) continue
        const payload = await search.json() as { data?: { mv?: { itemlist?: SmartboxMv[] } } }
        for (const item of payload.data?.mv?.itemlist ?? []) {
          if (item.vid !== undefined && item.vid !== '') suggestions.push({ vid: item.vid, ...(item.name !== undefined ? { name: item.name } : {}), ...(item.singer !== undefined ? { singer: item.singer } : {}) })
        }
      } catch { /* one failed suggestion query never kills the lookup */ }
    }
    return suggestions
  }

  private async fetchVideoInfos(vids: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, VideoInfo>> {
    const result = new Map<string, VideoInfo>()
    try {
      const response = await this.runFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'content-type': 'application/json', referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({
          comm: { ct: 24, cv: 0, format: 'json' },
          req: {
            module: 'music.video.VideoData',
            method: 'get_video_info_batch',
            param: { vidlist: [...vids], required: ['vid', 'name', 'duration', 'playcnt', 'singers'] },
          },
        }),
      }, signal)
      if (!response.ok) return result
      const payload = await response.json() as { req?: { data?: Record<string, VideoInfo> } }
      for (const [vid, info] of Object.entries(payload.req?.data ?? {})) {
        if (info !== undefined && info !== null) result.set(vid, info)
      }
    } catch { /* missing infos just fail the strict filter below */ }
    return result
  }

  private async fetchMvPlayUrl(vid: string, durationSeconds: number | undefined, signal?: AbortSignal): Promise<{ url: string; expiresAt: number; fileSize?: number } | undefined> {
    const response = await this.runFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'content-type': 'application/json', referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        comm: { ct: 24, cv: 0, format: 'json' },
        req: {
          module: 'music.stream.MvUrlProxy',
          method: 'GetMvUrls',
          param: { vids: [vid] },
        },
      }),
    }, signal)
    if (!response.ok) return undefined
    const payload = await response.json() as { req?: { data?: Record<string, { mp4?: readonly MvUrlFormat[] }> } }
    const formats = payload.req?.data?.[vid]?.mp4 ?? []
    const playable = formats
      .filter((format) => format?.code === 0 && typeof format.expire === 'number' && format.expire > 0)
      .flatMap((format) => {
        const url = (format.freeflow_url ?? []).find((candidate) => candidate.startsWith('https://') && candidate.endsWith('.mp4'))
        return url === undefined ? [] : [{ url, expireSeconds: format.expire ?? 0, fileSize: format.fileSize }]
      })
      // Lowest sufficient resolution first: a background video does not need
      // the top bitrate, but utter-lowbitrate smudge is not "sufficient".
      .sort((left, right) => (left.fileSize ?? 0) - (right.fileSize ?? 0))
    if (playable.length === 0) return undefined
    const chosen = durationSeconds !== undefined && durationSeconds > 0
      ? playable.find((entry) => (entry.fileSize ?? 0) / durationSeconds >= MIN_SUFFICIENT_BYTES_PER_SECOND) ?? playable[0]
      : playable[0]
    if (chosen === undefined) return undefined
    return {
      url: chosen.url,
      expiresAt: Date.now() + (chosen.expireSeconds * 1000) - URL_EXPIRY_MARGIN_MS,
      ...(chosen.fileSize !== undefined && chosen.fileSize > 0 ? { fileSize: chosen.fileSize } : {}),
    }
  }

  /** One fetcher call under the composed external+timeout signal. */
  private async runFetch(input: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const scoped = scopeSignal(signal, this.timeoutMs)
    try {
      return await this.fetcher(input, { ...init, signal: scoped.signal })
    } finally {
      scoped.done()
    }
  }
}

interface RankedCandidate {
  readonly vid: string
  readonly title: string
  readonly durationSeconds?: number
}

/**
 * Strict Live matching. The song's own MV and every suggestion must clear ALL
 * gates: no reject markers, a live/stage marker present, the video title
 * contains the normalized song title, and at least one authoritative singer
 * intersects the expected artists. Ranking prefers the song's own MV (an
 * official stage video QQ attached to the song), then marker specificity and
 * play count — never the raw search order.
 */
function rankCandidates(
  track: Track,
  detail: { mvVid?: string; singers: readonly string[] },
  suggestions: readonly { vid: string; name?: string; singer?: string }[],
  infos: ReadonlyMap<string, VideoInfo>,
  expectedArtists: readonly string[],
): RankedCandidate | undefined {  const expectedTitles = titleVariants(track.title)
  const suggestionSingerByVid = new Map(suggestions.map((entry) => [entry.vid, entry.singer ?? '']))
  const ranked: Array<RankedCandidate & { score: number }> = []
  for (const [vid, info] of infos) {
    const title = info.name ?? ''
    if (title === '' || REJECT_MARKERS.test(title) || !LIVE_MARKERS.test(title)) continue
    const normalizedTitle = normalize(title)
    if (!expectedTitles.some((expected) => normalizedTitle.includes(expected))) continue
    // Only the video's OWN singers authorize a match — never the song's.
    const singerNames = (info.singers ?? []).map((singer) => singer.name ?? '').filter((name) => name !== '')
    const suggestionSinger = suggestionSingerByVid.get(vid)
    if (suggestionSinger !== undefined && suggestionSinger !== '') singerNames.push(suggestionSinger)
    if (!artistIntersects(singerNames, expectedArtists)) continue
    const score = markerScore(title) * 10
      + (vid === detail.mvVid ? 5 : 0)
      + Math.min(4, Math.log10(Math.max(1, info.playcnt ?? 0)))
    ranked.push({
      vid,
      title,
      ...(info.duration !== undefined && info.duration > 0 ? { durationSeconds: info.duration } : {}),
      score,
    })
  }
  ranked.sort((left, right) => right.score - left.score)
  const best = ranked[0]
  if (best === undefined) return undefined
  const { score: _score, ...candidate } = best
  return candidate
}

function markerScore(title: string): number {
  if (/官摄/i.test(title)) return 4
  if (/演唱会|巡迴|巡回|concert|tour/i.test(title)) return 3
  if (/现场|舞台/i.test(title)) return 2
  return 1
}

/**
 * "至少有一个可靠交集": one of the video's singers must equal or contain an
 * expected artist token (or vice versa). Empty expected artists (media
 * session gap) never authorize a match.
 */
function artistIntersects(singerNames: readonly string[], expectedArtists: readonly string[]): boolean {
  const candidates = singerNames
    .flatMap((name) => artistVariants(name))
  return expectedArtists.some((expected) => candidates.some((candidate) =>
    candidate === expected || candidate.includes(expected) || expected.includes(candidate)))
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, '')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('QQ Music live video lookup aborted.')
}

function titleVariants(value: string): string[] {
  const normalized = normalize(value)
  const withoutVersion = normalize(value.replace(/\s*[([（【].*?[\])）】]\s*$/u, ''))
  return unique([normalized, withoutVersion].filter(Boolean))
}

function artistVariants(value: string): string[] {
  return unique(normalize(value).split(/[\/／、,&，,·・|;]/u).filter((artist) => artist.length >= 2))
}

function unique(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index)
}

/**
 * Combine an optional external signal with a hard timeout. Either firing
 * aborts the returned signal; `done()` releases the timer and listener after
 * the request settles so a fast poller never leaks a pending timer.
 */
function scopeSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done(): void } {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    },
  }
}
