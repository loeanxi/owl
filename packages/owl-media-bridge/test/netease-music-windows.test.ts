import { describe, expect, it } from 'vitest'
import { NeteaseMusicWindowsAdapter } from '../src/adapters/netease-music-windows.ts'
import { NeteaseMusicCoverResolver } from '../src/adapters/netease-music-cover.ts'
import type { PowerShellRunner } from '../src/adapters/powershell-runner.ts'

class FakeRunner implements PowerShellRunner {
  readonly calls: Array<{ command: string; positionSeconds?: number; player?: string }> = []

  private readonly publishTrack: boolean
  private readonly statusState: 'paused' | 'playing'

  constructor(publishTrack = false, statusState: 'paused' | 'playing' = 'paused') {
    this.publishTrack = publishTrack
    this.statusState = statusState
  }

  async run(command: 'status' | 'diagnose' | 'play-pause' | 'next' | 'previous' | 'seek' | 'set-volume', positionSeconds?: number, _signal?: AbortSignal, player = 'qq-music'): Promise<unknown> {
    this.calls.push({ command, positionSeconds, player })
    return {
      playerId: 'netease-music',
      playerName: 'NetEase Cloud Music',
      state: command === 'status' ? this.statusState : 'playing',
      ...(this.publishTrack ? { track: { title: '晴天', artist: '周杰伦', durationSeconds: 0 } } : {}),
      capabilities: { playPause: true, next: true, previous: true, seek: true, volume: false },
    }
  }
}

describe('NeteaseMusicWindowsAdapter', () => {
  function response(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  it('maps the generic bridge vocabulary to PowerShell commands for the netease player', async () => {
    const runner = new FakeRunner()
    const adapter = new NeteaseMusicWindowsAdapter(runner)

    await adapter.execute({ kind: 'seek', positionSeconds: 42 })
    await expect(adapter.readStatus()).resolves.toMatchObject({ state: 'paused', playerId: 'netease-music', playerName: '网易云音乐' })

    expect(runner.calls).toEqual([
      { command: 'seek', positionSeconds: 42, player: 'netease-music' },
      { command: 'status', positionSeconds: undefined, player: 'netease-music' },
    ])
  })

  it('rejects a payload published by a different player', async () => {
    const adapter = new NeteaseMusicWindowsAdapter({
      async run() {
        return {
          playerId: 'qq-music',
          playerName: 'QQ Music',
          state: 'playing',
          capabilities: { playPause: true, next: true, previous: true, seek: true, volume: false },
        }
      },
    })

    await expect(adapter.readStatus()).rejects.toThrow('invalid status payload')
  })

  it('maps an application-volume request to the Core Audio bridge command', async () => {
    const runner = new FakeRunner()
    const adapter = new NeteaseMusicWindowsAdapter(runner)
    await adapter.execute({ kind: 'set-volume', volumePercent: 30 })
    expect(runner.calls).toEqual([{ command: 'set-volume', positionSeconds: 30, player: 'netease-music' }])
  })

  it('fills the zero GSMTC duration from NetEase public metadata', async () => {
    const adapter = new NeteaseMusicWindowsAdapter(new FakeRunner(true, 'playing'), new NeteaseMusicCoverResolver(async (input) => {
      if (input.includes('/search/get/web')) return response({ result: { songs: [{ id: 42, name: '晴天', duration: 257000, artists: [{ id: 7, name: '周杰伦' }], album: { picUrl: 'https://cover.test/晴天.jpg' } }] } })
      if (input.includes('/api/artist/7')) return response({ artist: { img1v1Url: 'https://cover.test/周杰伦.jpg' } })
      return response({ lrc: { lyric: '[00:01.00]第一句' } })
    }))

    await expect(adapter.readStatus()).resolves.toMatchObject({ metadataState: 'pending', track: { durationSeconds: undefined } })
    await expect.poll(async () => (await adapter.readStatus()).metadataState).toBe('ready')
    await expect(adapter.readStatus()).resolves.toMatchObject({
      track: { durationSeconds: 257, artworkUrl: 'https://cover.test/晴天.jpg', artistImageUrl: 'https://cover.test/周杰伦.jpg?param=750y750' },
      backgroundImageUrl: 'https://cover.test/周杰伦.jpg?param=750y750',
      backgroundImageUrls: ['https://cover.test/周杰伦.jpg?param=750y750', 'https://cover.test/晴天.jpg?param=750y750'],
    })
  })

  it('keeps the media-session cover as the only background when metadata lookup fails', async () => {
    const runner: PowerShellRunner = {
      async run() {
        return {
          playerId: 'netease-music', playerName: 'NetEase Cloud Music', state: 'playing',
          track: { title: '晴天', artist: '周杰伦', artworkUrl: 'https://cover.test/current.jpg' },
          capabilities: { playPause: true, next: true, previous: true, seek: true, volume: false },
        }
      },
    }
    const adapter = new NeteaseMusicWindowsAdapter(runner, new NeteaseMusicCoverResolver(async () => new Response('', { status: 503 })))

    await expect(adapter.readStatus()).resolves.toMatchObject({
      backgroundImageUrl: 'https://cover.test/current.jpg',
      backgroundImageUrls: ['https://cover.test/current.jpg'],
      track: { artworkUrl: 'https://cover.test/current.jpg' },
    })
  })

  it('preserves the position reported by the NetEase media session', async () => {
    const adapter = new NeteaseMusicWindowsAdapter(new FakeRunner(true, 'playing'), new NeteaseMusicCoverResolver(async (input) => {
      if (input.includes('/search/get/web')) return response({ result: { songs: [{ id: 42, name: '晴天', duration: 257000, artists: [{ name: '周杰伦' }], album: { picUrl: 'https://cover.test/晴天.jpg' } }] } })
      return response({ lrc: { lyric: '[00:01.00]第一句' } })
    }))

    const first = await adapter.readStatus()
    expect(first.positionSeconds).toBeUndefined()
  })

  it('preserves a non-zero position reported by the NetEase media session', async () => {
    const runner: PowerShellRunner = {
      async run() {
        return {
          playerId: 'netease-music', playerName: 'NetEase Cloud Music', state: 'playing', positionSeconds: 60,
          track: { title: '晴天', artist: '周杰伦', durationSeconds: 257 },
          capabilities: { playPause: true, next: true, previous: true, seek: true, volume: false },
        }
      },
    }
    const resolver = new NeteaseMusicCoverResolver(async (input) => {
      if (input.includes('/search/get/web')) return response({ result: { songs: [{ id: 42, name: '晴天', artists: [{ name: '周杰伦' }], album: { picUrl: 'https://cover.test/晴天.jpg' } }] } })
      return response({ lrc: { lyric: '[00:01.00]第一句' } })
    })
    const adapter = new NeteaseMusicWindowsAdapter(runner, resolver)
    const first = await adapter.readStatus()
    expect(first.positionSeconds).toBe(60)
  })

  it('collects process, session, and audio probes through the diagnose command', async () => {
    const commands: string[] = []
    const runner: PowerShellRunner = {
      run: async (command) => {
        commands.push(command)
        return {
          playerId: 'netease-music', playerName: 'NetEase Cloud Music',
          process: { found: true, processCount: 1, names: ['cloudmusic'] },
          mediaSession: { totalSessions: 2, matchingSessions: 1, appUserModelIds: ['cloudmusic.exe'] },
          audioSession: { found: false },
          state: 'paused',
          capabilities: { playPause: true, next: false, previous: false, seek: false, volume: false },
        }
      },
      health: () => ({ alive: true, startedAt: 5, activeLeases: 0 }),
    }
    const adapter = new NeteaseMusicWindowsAdapter(runner)

    const diagnosis = await adapter.diagnose()

    expect(commands).toEqual(['diagnose'])
    expect(diagnosis.process).toEqual({ found: true, processCount: 1, names: ['cloudmusic'] })
    expect(diagnosis.mediaSession?.matchingSessions).toBe(1)
    expect(diagnosis.audioSession?.found).toBe(false)
    expect(diagnosis.worker).toMatchObject({ alive: true, startedAt: 5 })
  })

  it('degrades a failing PowerShell boundary into sanitized probe data', async () => {
    const runner: PowerShellRunner = {
      run: async () => { throw new Error('worker exited while loading C:\\temp\\worker.ps1') },
      health: () => ({ alive: false, lastStopReason: 'exited C:\\scripts\\windows-media-session-worker.ps1', lastStoppedAt: 9, activeLeases: 0 }),
    }
    const adapter = new NeteaseMusicWindowsAdapter(runner)

    const diagnosis = await adapter.diagnose()

    expect(diagnosis.detail).toBe('worker exited while loading <path>')
    expect(diagnosis.worker?.lastStopReason).not.toContain('C:\\')
    expect(JSON.stringify(diagnosis)).not.toContain('C:\\')
  })
})
