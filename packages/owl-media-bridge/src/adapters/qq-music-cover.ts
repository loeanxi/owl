import type { LyricLine, Track } from '../domain/types.ts'

interface SmartboxSong {
  readonly mid?: string
  readonly name?: string
  readonly singer?: string
}

interface CoverCacheEntry {
  readonly artworkUrl?: string
  readonly artistImageUrl?: string
  readonly backgroundImageUrls?: readonly string[]
  readonly lyrics?: readonly LyricLine[]
  /** True once QQ has successfully answered the lyric request, even if it has no timed lyrics. */
  readonly lyricsResolved?: boolean
  /** Retained privately so a transient lyric failure can be retried without repeating the visual lookup. */
  readonly songMid?: string
  readonly expiresAt: number
}

export interface QqMusicVisuals {
  readonly artworkUrl?: string
  readonly artistImageUrl?: string
  readonly backgroundImageUrls?: readonly string[]
  readonly lyrics?: readonly LyricLine[]
}

interface LyricFetchResult {
  readonly lyrics?: readonly LyricLine[]
  readonly resolved: boolean
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Default per-request ceiling for the public QQ metadata endpoints. */
const REQUEST_TIMEOUT_MS = 3000
const EMPTY_VISUALS_TTL_MS = 15_000
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

/** Resolves QQ Music album art from public metadata, without login cookies. */
export class QqMusicCoverResolver {
  private readonly cache = new Map<string, CoverCacheEntry>()
  private readonly inflight = new Map<string, Promise<QqMusicVisuals>>()

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  async resolve(track: Track, signal?: AbortSignal): Promise<QqMusicVisuals> {
    throwIfAborted(signal)
    const key = `${normalize(track.title)}\u0000${normalize(track.artist)}`
    const cached = this.cache.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      // Artwork can be available even if QQ's separate lyric endpoint timed
      // out. Do not turn that one transient failure into an hour of “暂无歌词”.
      if (cached.lyrics === undefined && cached.lyricsResolved !== true && cached.songMid !== undefined) {
        const lyricResult = await this.fetchLyrics(cached.songMid, signal)
        if (lyricResult.resolved) {
          const refreshed = { ...cached, lyrics: lyricResult.lyrics, lyricsResolved: true }
          this.cache.set(key, refreshed)
          return visualsFromCache(refreshed)
        }
      }
      return visualsFromCache(cached)
    }

    // Multiple UI pollers (launcher dot, deep background, player modal, input
    // wave) hit status around the same track change. Without this guard every
    // poller would fire its own lookup, and one lookup already fans out to up
    // to ten public requests. Share the in-flight lookup instead.
    const pending = this.inflight.get(key)
    if (pending !== undefined) {
      const visuals = await pending
      throwIfAborted(signal)
      return visuals
    }
    const running = this.lookup(track, signal)
    this.inflight.set(key, running)
    try {
      const visuals = await running
      throwIfAborted(signal)
      const hasVisuals = Boolean(visuals.artworkUrl || visuals.artistImageUrl || visuals.backgroundImageUrls?.length || visuals.lyrics?.length)
      this.cache.set(key, { ...visuals, expiresAt: Date.now() + (hasVisuals ? this.ttlMs : EMPTY_VISUALS_TTL_MS) })
      return visuals
    } finally {
      this.inflight.delete(key)
    }
  }

  private async lookup(track: Track, signal?: AbortSignal): Promise<QqMusicVisuals & Pick<CoverCacheEntry, 'songMid' | 'lyricsResolved'>> {
    try {
      const searchTerms = unique([`${track.title} ${track.artist}`, ...titleVariants(track.title)])
      let candidates: SmartboxSong[] = []
      for (const term of searchTerms) {
        const searchUrl = `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&key=${encodeURIComponent(term)}`
        const searchResponse = await this.runFetch(searchUrl, {
          headers: { referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
        }, signal)
        if (!searchResponse.ok) continue
        const search = await searchResponse.json() as { data?: { song?: { itemlist?: SmartboxSong[] } } }
        candidates = search.data?.song?.itemlist ?? []
        if (candidates.length > 0) break
      }
      if (candidates.length === 0) return {}
      const expectedTitles = titleVariants(track.title)
      const expectedArtists = artistVariants(track.artist)
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
      if (match?.mid === undefined) return {}

      const detailResponse = await this.runFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'content-type': 'application/json', referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({
          comm: { ct: 24, cv: 0 },
          'music.pf_song_detail_svr': {
            module: 'music.pf_song_detail_svr',
            method: 'get_song_detail_yqq',
            param: { song_mid: match.mid },
          },
        }),
      }, signal)
      if (!detailResponse.ok) return {}
      const detail = await detailResponse.json() as { ['music.pf_song_detail_svr']?: { data?: { track_info?: { album?: { mid?: string }; singer?: Array<{ mid?: string }> } } } }
      const info = detail['music.pf_song_detail_svr']?.data?.track_info
      const albumMid = info?.album?.mid
      const artistMid = info?.singer?.[0]?.mid
      const lyricResult = await this.fetchLyrics(match.mid, signal)
      const backgroundImageUrls = await this.fetchBackgroundImages(track.artist, match.mid, albumMid, artistMid, signal)
      return {
        artworkUrl: albumMid === undefined || albumMid === '' ? undefined : `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`,
        artistImageUrl: artistMid === undefined || artistMid === '' ? undefined : `https://y.gtimg.cn/music/photo_new/T001R800x800M000${artistMid}.jpg`,
        backgroundImageUrls,
        lyrics: lyricResult.lyrics,
        lyricsResolved: lyricResult.resolved,
        songMid: match.mid,
      }
    } catch {
      return {}
    }
  }

  private async fetchBackgroundImages(artist: string, currentSongMid: string, currentAlbumMid: string | undefined, artistMid: string | undefined, signal?: AbortSignal): Promise<readonly string[]> {
    const images: string[] = []
    if (artistMid) images.push(`https://y.gtimg.cn/music/photo_new/T001R800x800M000${artistMid}.jpg`)
    if (currentAlbumMid) images.push(`https://y.gtimg.cn/music/photo_new/T002R800x800M000${currentAlbumMid}.jpg`)
    try {
      const response = await this.runFetch(`https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&key=${encodeURIComponent(artist)}`, {
        headers: { referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
      }, signal)
      if (!response.ok) return unique(images).slice(0, 6)
      const search = await response.json() as { data?: { song?: { itemlist?: SmartboxSong[] } } }
      const candidates = (search.data?.song?.itemlist ?? [])
        .filter((candidate) => candidate.mid !== undefined && normalize(candidate.singer).includes(normalize(artist)) && candidate.mid !== currentSongMid)
        .slice(0, 6)
      const albumMids = await Promise.all(candidates.map((candidate) => this.fetchAlbumMid(candidate.mid!, signal)))
      for (const albumMid of albumMids) if (albumMid) images.push(`https://y.gtimg.cn/music/photo_new/T002R800x800M000${albumMid}.jpg`)
    } catch {}
    return unique(images).slice(0, 6)
  }

  private async fetchAlbumMid(songMid: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const response = await this.runFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'content-type': 'application/json', referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({
          comm: { ct: 24, cv: 0 },
          'music.pf_song_detail_svr': { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_mid: songMid } },
        }),
      }, signal)
      if (!response.ok) return undefined
      const detail = await response.json() as { ['music.pf_song_detail_svr']?: { data?: { track_info?: { album?: { mid?: string } } } } }
      return detail['music.pf_song_detail_svr']?.data?.track_info?.album?.mid
    } catch {
      return undefined
    }
  }

  private async fetchLyrics(songMid: string, signal?: AbortSignal): Promise<LyricFetchResult> {
    try {
      const response = await this.runFetch(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songMid)}&format=json&nobase64=1`, {
        headers: { referer: 'https://y.qq.com/', 'user-agent': 'Mozilla/5.0' },
      }, signal)
      if (!response.ok) return { resolved: false }
      const payload = await response.json() as { lyric?: string; trans?: string }
      const lines = withTranslations(parseLrc(payload.lyric ?? ''), parseLrc(payload.trans ?? ''))
      return { lyrics: lines.length === 0 ? undefined : lines, resolved: true }
    } catch {
      return { resolved: false }
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

function visualsFromCache(cached: CoverCacheEntry): QqMusicVisuals {
  return {
    artworkUrl: cached.artworkUrl,
    artistImageUrl: cached.artistImageUrl,
    backgroundImageUrls: cached.backgroundImageUrls,
    lyrics: cached.lyrics,
  }
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, '')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('QQ Music metadata lookup aborted.')
}

function titleVariants(value: string): string[] {
  const normalized = normalize(value)
  const withoutVersion = normalize(value.replace(/\s*[([（【].*?[\])）】]\s*$/u, ''))
  return unique([normalized, withoutVersion].filter(Boolean))
}

function artistVariants(value: string): string[] {
  return unique(normalize(value).split(/[\/／、,&，,·・|]/u).filter((artist) => artist.length >= 2))
}

export function parseLrc(value: string): LyricLine[] {
  const result: LyricLine[] = []
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/)
    if (match === null) continue
    const fraction = (match[3] ?? '').padEnd(3, '0').slice(0, 3)
    const text = (match[4] ?? '').trim()
    if (text === '') continue
    result.push({ startMs: (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(fraction), text })
  }
  return result.sort((a, b) => a.startMs - b.startMs)
}

/**
 * Attach aligned translations to their original lines by timestamp. Originals
 * without a matching translation stay untouched, so the UI can still render
 * them and only toggle the optional translation surface.
 */
export function withTranslations(original: readonly LyricLine[], translations: readonly LyricLine[]): readonly LyricLine[] {
  if (original.length === 0) return translations
  const translatedByTime = new Map(translations.map((line) => [line.startMs, line.text]))
  return original.map((line) => {
    const translated = translatedByTime.get(line.startMs)
    return translated === undefined || translated === '' || translated === line.text ? line : { ...line, translation: translated }
  })
}

function unique(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index)
}
