import { describe, expect, it } from 'vitest'
import { QqLiveVideoResolver } from '../src/adapters/qq-live-video.ts'

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

interface Fixture {
  readonly songs?: ReadonlyArray<{ mid: string; name: string; singer: string }>
  readonly mvs?: ReadonlyArray<{ vid: string; name: string; singer: string }>
  readonly songDetail?: { mvVid?: string; singers?: ReadonlyArray<{ name: string }> }
  readonly videoInfos?: Record<string, { name?: string; duration?: number; playcnt?: number; singers?: ReadonlyArray<{ name: string }> }>
  readonly mvUrls?: Record<string, ReadonlyArray<{ code?: number; expire?: number; fileSize?: number; freeflow_url?: readonly string[] }>>
}

/**
 * Builds a fetcher speaking the four public QQ endpoints the resolver uses:
 * smartbox (song + mv suggestions), song detail, video info batch, MV URLs.
 */
function fetcherFor(fixture: Fixture, log: { urls: string[]; bodies: unknown[] } = { urls: [], bodies: [] }) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    log.urls.push(url)
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : {}
    log.bodies.push(body)
    if (url.includes('smartbox_new.fcg')) {
      const key = decodeURIComponent(url.split('key=')[1] ?? '')
      const wantsMv = /现场|live/i.test(key)
      return response({ data: { song: { itemlist: fixture.songs ?? [] }, mv: { itemlist: (fixture.mvs ?? []).filter((entry) => !wantsMv || /现场|live/i.test(entry.name)) } } })
    }
    if (url.includes('musicu.fcg')) {
      const module = Object.keys(body).find((name) => name !== 'comm') ?? ''
      if (module === 'music.pf_song_detail_svr') {
        return response({ [module]: { data: { track_info: { mv: { vid: fixture.songDetail?.mvVid ?? '' }, singer: fixture.songDetail?.singers ?? [] } } } })
      }
      if (module === 'req') {
        const inner = body.req as { module?: string; param?: Record<string, unknown> }
        if (inner?.module === 'music.video.VideoData') {
          const data: Record<string, unknown> = {}
          for (const vid of inner.param?.vidlist as readonly string[]) {
            if (fixture.videoInfos?.[vid] !== undefined) data[vid] = fixture.videoInfos[vid]
          }
          return response({ req: { data } })
        }
        if (inner?.module === 'music.stream.MvUrlProxy') {
          const data: Record<string, unknown> = {}
          for (const vid of inner.param?.vids as readonly string[]) {
            if (fixture.mvUrls?.[vid] !== undefined) data[vid] = { mp4: fixture.mvUrls[vid] }
          }
          return response({ req: { data } })
        }
      }
      return response({})
    }
    return response({})
  }
}

const TRACK = { title: '知足', artist: '五月天' }

describe('QqLiveVideoResolver', () => {
  it('resolves the song’s own mv.vid when the video is a strictly matched live version', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { mvVid: 'liveVid001', singers: [{ name: '五月天' }] },
      videoInfos: {
        liveVid001: { name: '知足 (五月天 演唱会现场版)', duration: 300, playcnt: 5000, singers: [{ name: '五月天' }] },
      },
      mvUrls: {
        liveVid001: [{ code: 0, expire: 86400, fileSize: 30_000_000, freeflow_url: ['https://mv.music.tc.qq.com/live001.mp4'] }],
      },
    }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture))
    const video = await resolver.resolve(TRACK)
    expect(video).toMatchObject({ provider: 'qq-music', kind: 'live', vid: 'liveVid001', title: '知足 (五月天 演唱会现场版)', durationSeconds: 300, url: 'https://mv.music.tc.qq.com/live001.mp4' })
    // expiresAt stays safely inside the remote validity window.
    expect(video!.expiresAt).toBeGreaterThan(Date.now())
    expect(video!.expiresAt).toBeLessThan(Date.now() + 86400 * 1000)
  })

  it('rejects a same-title video whose singers do not intersect the track artist', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { singers: [{ name: '五月天' }] },
      mvs: [{ vid: 'wrongSingerVid', name: '知足 现场版', singer: '别的歌手' }],
      videoInfos: {
        wrongSingerVid: { name: '知足 现场版', duration: 200, singers: [{ name: '别的歌手' }] },
      },
    }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture))
    await expect(resolver.resolve(TRACK)).resolves.toBeUndefined()
  })

  it('rejects the song’s ordinary studio MV without any live marker', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { mvVid: 'studioVid', singers: [{ name: '五月天' }] },
      videoInfos: {
        studioVid: { name: '知足', duration: 281, singers: [{ name: '五月天' }] },
      },
      mvUrls: { studioVid: [{ code: 0, expire: 86400, freeflow_url: ['https://mv.music.tc.qq.com/studio.mp4'] }] },
    }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture))
    await expect(resolver.resolve(TRACK)).resolves.toBeUndefined()
  })

  it('rejects covers, edits and fan-made uploads even with a live marker', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { singers: [{ name: '五月天' }] },
      mvs: [{ vid: 'coverVid', name: '知足 现场翻唱', singer: '路人' }],
      videoInfos: {
        coverVid: { name: '知足 现场翻唱', duration: 200, singers: [{ name: '路人' }] },
      },
    }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture))
    await expect(resolver.resolve(TRACK)).resolves.toBeUndefined()
  })

  it('picks the lowest sufficient HTTPS MP4 and never an http-only format', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { mvVid: 'liveVid001', singers: [{ name: '五月天' }] },
      videoInfos: {
        liveVid001: { name: '知足 (Live)', duration: 300, singers: [{ name: '五月天' }] },
      },
      mvUrls: {
        liveVid001: [
          { code: 0, expire: 86400, fileSize: 60_000_000, freeflow_url: ['https://mv.music.tc.qq.com/high.mp4'] },
          { code: 0, expire: 86400, fileSize: 300_000, freeflow_url: ['https://mv.music.tc.qq.com/too-low.mp4'] },
          { code: 0, expire: 86400, fileSize: 20_000_000, freeflow_url: ['http://mv.music.tc.qq.com/insecure.mp4', 'https://mv.music.tc.qq.com/low-sufficient.mp4'] },
          { code: 2000, expire: 86400, fileSize: 1_000, freeflow_url: ['https://mv.music.tc.qq.com/failed.mp4'] },
        ],
      },
    }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture))
    const video = await resolver.resolve(TRACK)
    // The 20 MB / 300 s (~533 kbps) entry is the lowest that still clears the
    // ~320 kbps floor via a secure https URL; 300 KB is too low, http-only is
    // never eligible, and the failed format is filtered out.
    expect(video?.url).toBe('https://mv.music.tc.qq.com/low-sufficient.mp4')
    expect(video?.fileSize).toBe(20_000_000)
  })

  it('falls back below the bitrate floor when nothing higher exists', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { mvVid: 'liveVid001', singers: [{ name: '五月天' }] },
      videoInfos: { liveVid001: { name: '知足 (Live)', duration: 300, singers: [{ name: '五月天' }] } },
      mvUrls: { liveVid001: [{ code: 0, expire: 86400, fileSize: 300_000, freeflow_url: ['https://mv.music.tc.qq.com/only.mp4'] }] },
    }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture))
    await expect(resolver.resolve(TRACK)).resolves.toMatchObject({ url: 'https://mv.music.tc.qq.com/only.mp4' })
  })

  it('caches a positive result shorter than the remote URL validity', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { mvVid: 'liveVid001', singers: [{ name: '五月天' }] },
      videoInfos: { liveVid001: { name: '知足 (Live)', duration: 300, singers: [{ name: '五月天' }] } },
      mvUrls: { liveVid001: [{ code: 0, expire: 3600, fileSize: 10_000_000, freeflow_url: ['https://mv.music.tc.qq.com/live001.mp4'] }] },
    }
    const log = { urls: [] as string[], bodies: [] as unknown[] }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture, log))
    const first = await resolver.resolve(TRACK)
    expect(first?.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000)
    await resolver.resolve(TRACK)
    // Cached: no second song-detail/url round trip.
    const detailCalls = log.bodies.filter((entry) => JSON.stringify(entry).includes('pf_song_detail_svr')).length
    expect(detailCalls).toBe(1)
  })

  it('shares one in-flight lookup between concurrent pollers for the same track', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { mvVid: 'liveVid001', singers: [{ name: '五月天' }] },
      videoInfos: { liveVid001: { name: '知足 (Live)', duration: 300, singers: [{ name: '五月天' }] } },
      mvUrls: { liveVid001: [{ code: 0, expire: 86400, fileSize: 10_000_000, freeflow_url: ['https://mv.music.tc.qq.com/live001.mp4'] }] },
    }
    const log = { urls: [] as string[], bodies: [] as unknown[] }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture, log))
    const [first, second] = await Promise.all([resolver.resolve(TRACK), resolver.resolve(TRACK)])
    expect(first?.vid).toBe('liveVid001')
    expect(second?.vid).toBe('liveVid001')
    const detailCalls = log.bodies.filter((entry) => JSON.stringify(entry).includes('pf_song_detail_svr')).length
    expect(detailCalls).toBe(1)
  })

  it('caches empty results so a track without live videos does not refetch constantly', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { singers: [{ name: '五月天' }] },
    }
    const log = { urls: [] as string[], bodies: [] as unknown[] }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture, log))
    await expect(resolver.resolve(TRACK)).resolves.toBeUndefined()
    await expect(resolver.resolve(TRACK)).resolves.toBeUndefined()
    const detailCalls = log.bodies.filter((entry) => JSON.stringify(entry).includes('pf_song_detail_svr')).length
    expect(detailCalls).toBe(1)
  })

  it('propagates a track-switch abort instead of returning a stale video', async () => {
    const controller = new AbortController()
    const resolver = new QqLiveVideoResolver(async (input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        void input
      })
    })
    const pending = resolver.resolve(TRACK, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('degrades to "no live" when a request hangs past the timeout', async () => {
    const resolver = new QqLiveVideoResolver((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }), 50)
    await expect(resolver.resolve(TRACK)).resolves.toBeUndefined()
  })

  it('never throws: a failing play-url stage still resolves to "no live"', async () => {
    const fixture: Fixture = {
      songs: [{ mid: 'song-mid', name: '知足', singer: '五月天' }],
      songDetail: { mvVid: 'liveVid001', singers: [{ name: '五月天' }] },
      videoInfos: { liveVid001: { name: '知足 (Live)', duration: 300, singers: [{ name: '五月天' }] } },
      mvUrls: {},
    }
    const resolver = new QqLiveVideoResolver(fetcherFor(fixture))
    await expect(resolver.resolve(TRACK)).resolves.toBeUndefined()
  })
})
