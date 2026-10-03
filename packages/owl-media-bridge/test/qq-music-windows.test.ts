import { describe, expect, it } from 'vitest'
import { QqMusicWindowsAdapter } from '../src/adapters/qq-music-windows.ts'
import type { PowerShellRunner, WindowsMediaCommand } from '../src/adapters/powershell-runner.ts'
import type { QqMusicVisuals } from '../src/adapters/qq-music-cover.ts'

class FakeRunner implements PowerShellRunner {
  readonly calls: Array<{ command: string; positionSeconds?: number }> = []
  async run(command: WindowsMediaCommand, positionSeconds?: number): Promise<unknown> {
    this.calls.push({ command, positionSeconds })
    return {
      playerId: 'qq-music',
      playerName: 'QQ Music',
      state: 'paused',
      capabilities: { playPause: true, next: true, previous: true, seek: true, volume: true },
    }
  }
}

describe('QqMusicWindowsAdapter', () => {
  it('maps the shared bridge vocabulary to PowerShell commands', async () => {
    const runner = new FakeRunner()
    const adapter = new QqMusicWindowsAdapter(runner)
    await adapter.execute({ kind: 'seek', positionSeconds: 42 })
    await adapter.execute({ kind: 'set-volume', volumePercent: 30 })
    await adapter.readStatus()
    expect(runner.calls).toEqual([
      { command: 'seek', positionSeconds: 42 },
      { command: 'set-volume', positionSeconds: 30 },
      { command: 'status', positionSeconds: undefined },
    ])
  })

  it('rejects malformed status metadata at the adapter boundary', async () => {
    const adapter = new QqMusicWindowsAdapter({
      run: async () => ({
        playerId: 'qq-music', playerName: 'QQ Music', state: 'paused',
        track: { title: 123, artist: null },
        capabilities: { playPause: true, next: false, previous: false, seek: false, volume: false },
      }),
    })
    await expect(adapter.readStatus()).rejects.toThrow('invalid status payload')
  })

  it('returns authoritative playback immediately and enriches metadata later', async () => {
    let finish!: (value: QqMusicVisuals) => void
    const metadata = new Promise<QqMusicVisuals>((resolve) => { finish = resolve })
    const runner: PowerShellRunner = {
      run: async () => ({
        playerId: 'qq-music', playerName: 'QQ Music', state: 'playing',
        track: { title: '水星记', artist: '郭顶', durationSeconds: 325 },
        capabilities: { playPause: true, next: true, previous: true, seek: false, volume: true },
      }),
    }
    const adapter = new QqMusicWindowsAdapter(runner, { resolve: async () => await metadata })

    await expect(adapter.readStatus()).resolves.toMatchObject({ state: 'playing', metadataState: 'pending' })
    finish({ artworkUrl: 'https://cover.test/song.jpg', lyrics: [{ startMs: 1000, text: '第一句' }] })
    await expect.poll(async () => (await adapter.readStatus()).metadataState).toBe('ready')
    await expect(adapter.readStatus()).resolves.toMatchObject({ track: { artworkUrl: 'https://cover.test/song.jpg' }, lyrics: [{ text: '第一句' }] })
  })

  it('collects connection probes through diagnose', async () => {
    const runner: PowerShellRunner = {
      run: async () => ({
        playerId: 'qq-music', playerName: 'QQ Music',
        process: { found: true, processCount: 1, names: ['QQMusic'] },
        mediaSession: { totalSessions: 2, matchingSessions: 1, appUserModelIds: ['QQMusic.exe'] },
        audioSession: { found: true, volumePercent: 42 },
        capabilities: { playPause: true, next: true, previous: true, seek: false, volume: true },
      }),
      health: () => ({ alive: true, activeLeases: 0 }),
    }
    const diagnosis = await new QqMusicWindowsAdapter(runner).diagnose()
    expect(diagnosis.mediaSession).toMatchObject({ matchingSessions: 1 })
    expect(diagnosis.audioSession).toMatchObject({ found: true, volumePercent: 42 })
  })
})
