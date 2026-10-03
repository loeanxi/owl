import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ListeningMemory } from '../src/listening-memory.ts'
import type { BridgeStatus } from '../src/domain/types.ts'

function tempStore(): string {
  return join(mkdtempSync(join(tmpdir(), 'dmb-memory-')), 'listening-memory.json')
}

function status(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    playerId: 'qq-music',
    playerName: 'QQ 音乐',
    state: 'playing',
    track: { title: '晴天', artist: '周杰伦', album: '叶惠美' },
    volumePercent: 50,
    capabilities: { playPause: true, next: true, previous: true, seek: true, volume: true },
    ...overrides,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('ListeningMemory', () => {
  it('creates one history entry per track change and accumulates only playing time', () => {
    const path = tempStore()
    let clock = 1_000
    const memory = new ListeningMemory(path, { now: () => clock })

    memory.note(status())                                   // t=1s   new entry
    clock += 10_000
    memory.note(status())                                   // playing gap -> +10s
    clock += 5_000
    memory.note(status({ state: 'paused' }))                // paused gap -> +0
    clock += 30_000
    memory.note(status({ state: 'paused' }))                // long paused gap -> +0
    clock += 4_000
    memory.note(status())                                   // playing gap -> +4s
    memory.note(status({ state: 'playing', track: { title: '七里香', artist: '周杰伦' } })) // switch

    const today = memory.today()
    expect(today).toHaveLength(2)
    expect(today[0]).toMatchObject({ title: '晴天', artist: '周杰伦', album: '叶惠美', playerId: 'qq-music' })
    expect(Math.round(today[0]?.playedSeconds ?? 0)).toBe(14)
    expect(today[1]).toMatchObject({ title: '七里香', artist: '周杰伦' })
    expect(memory.summary({ title: '晴天', artist: '周杰伦' }, 'qq-music').todayTracks).toBe(2)
    expect(Math.round(memory.summary({ title: '晴天', artist: '周杰伦' }, 'qq-music').todaySeconds)).toBe(14)
  })

  it('keeps entries of different players separate and starts a fresh row after unavailable', () => {
    const memory = new ListeningMemory(tempStore())
    memory.note(status({ playerId: 'qq-music', playerName: 'QQ 音乐' }))
    memory.note(status({ playerId: 'netease-music', playerName: '网易云音乐' }))
    memory.note(status({ state: 'unavailable' }))
    memory.note(status({ playerId: 'netease-music', playerName: '网易云音乐' }))

    expect(memory.today().map((entry) => entry.playerId)).toEqual(['qq-music', 'netease-music', 'netease-music'])
  })

  it('toggles favorites by identity and reports membership for the current track', () => {
    const memory = new ListeningMemory(tempStore())

    const added = memory.toggleFavorite({ playerId: 'qq-music', title: '晴天', artist: '周杰伦', album: '叶惠美' })
    expect(added.favorite).toBe(true)
    expect(memory.favorites()).toHaveLength(1)

    // Same song on another player is a distinct favorite key.
    const otherPlayer = memory.toggleFavorite({ playerId: 'netease-music', title: '晴天', artist: '周杰伦' })
    expect(otherPlayer.favorite).toBe(true)
    expect(memory.favorites()).toHaveLength(2)

    // Matching normalizes case/whitespace but stays per-player.
    expect(memory.summary({ title: ' 晴天 ', artist: '周杰伦' }, 'qq-music')).toMatchObject({ favorite: true })
    expect(memory.summary({ title: '晴天', artist: '周杰伦' }, 'netease-music')).toMatchObject({ favorite: true })

    const removed = memory.toggleFavorite({ playerId: 'qq-music', title: '晴天', artist: '周杰伦' })
    expect(removed.favorite).toBe(false)
    expect(memory.favorites()).toHaveLength(1)
    expect(memory.removeFavorite('netease-music|晴天|周杰伦')).toBe(true)
    expect(memory.favorites()).toHaveLength(0)
    expect(memory.summary(undefined, 'qq-music')).toMatchObject({ favorite: false })
  })

  it('persists favorites and history to disk and reloads them', () => {
    const path = tempStore()
    const writer = new ListeningMemory(path, { maxDays: 7 })
    writer.note(status())
    writer.toggleFavorite({ playerId: 'qq-music', title: '晴天', artist: '周杰伦' })
    writer.dispose()

    const reloaded = new ListeningMemory(path, { maxDays: 7 })
    expect(reloaded.today()).toHaveLength(1)
    expect(reloaded.favorites()).toMatchObject([{ title: '晴天', artist: '周杰伦' }])
    expect(existsSync(path)).toBe(true)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { version: number; days: Record<string, unknown[]> }
    expect(stored.version).toBe(1)
    expect(Object.keys(stored.days)).toHaveLength(1)
  })

  it('survives a corrupted store file without throwing', () => {
    const path = tempStore()
    const seed = new ListeningMemory(path)
    seed.note(status())
    seed.flush()

    writeFileSync(path, '{not json', 'utf8')
    const corrupted = new ListeningMemory(path)
    expect(() => corrupted.today()).not.toThrow()
    expect(corrupted.today()).toEqual([])
    expect(() => corrupted.note(status())).not.toThrow()
    expect(() => corrupted.flush()).not.toThrow()
  })

  it('prunes days older than the retention window', () => {
    const path = tempStore()
    let clock = 1_700_000_000_000
    const memory = new ListeningMemory(path, { maxDays: 2, now: () => clock })
    memory.note(status())
    memory.flush()

    clock += 3 * DAY_MS
    memory.note(status({ track: { title: '夜曲', artist: '周杰伦' } }))
    memory.flush()
    memory.dispose()

    const reloaded = new ListeningMemory(path, { maxDays: 2, now: () => clock })
    expect(reloaded.today().map((entry) => entry.title)).toEqual(['夜曲'])
    expect(reloaded.recent(10).map((entry) => entry.title)).toEqual(['夜曲'])
  })

  it('caps recent() across retained days newest-first', () => {
    const path = tempStore()
    let clock = 1_000
    const memory = new ListeningMemory(path, { maxDays: 7, now: () => clock })
    memory.note(status())
    clock += DAY_MS
    memory.note(status({ track: { title: '第二天', artist: '歌手' } }))
    memory.dispose()

    const reloaded = new ListeningMemory(path, { maxDays: 7, now: () => clock })
    const recent = reloaded.recent(1)
    expect(recent).toHaveLength(1)
    expect(recent[0]?.title).toBe('第二天')
  })
})
