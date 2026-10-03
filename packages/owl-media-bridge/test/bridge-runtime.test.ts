import { describe, expect, it } from 'vitest'
import { BridgeRuntime } from '../src/bridge-runtime.ts'
import { MediaBridge } from '../src/domain/media-bridge.ts'
import type { PlayerAdapter, PlayerVolumeLease } from '../src/domain/player-adapter.ts'
import { NO_CAPABILITIES, type BridgeStatus, type MediaCommand, type PlayerId } from '../src/domain/types.ts'

class StatefulAdapter implements PlayerAdapter {
  readonly commands: MediaCommand[] = []
  readonly leaseEvents: Array<{ kind: 'arm'; lease: PlayerVolumeLease } | { kind: 'clear'; id: string }> = []
  state: BridgeStatus['state'] = 'playing'
  volumePercent = 80
  reads = 0

  constructor(readonly id: PlayerId = 'qq-music', readonly displayName = 'QQ 音乐') {}

  async readStatus(): Promise<BridgeStatus> {
    this.reads += 1
    return {
      playerId: this.id,
      playerName: this.displayName,
      state: this.state,
      track: { title: '测试歌曲', artist: '测试歌手', durationSeconds: 240 },
      positionSeconds: 30,
      volumePercent: this.volumePercent,
      capabilities: { playPause: true, next: true, previous: true, seek: true, volume: true },
    }
  }

  async execute(command: MediaCommand): Promise<void> {
    this.commands.push(command)
    if (command.kind === 'play-pause') this.state = this.state === 'playing' ? 'paused' : 'playing'
    if (command.kind === 'set-volume') this.volumePercent = command.volumePercent
  }

  async armVolumeLease(lease: PlayerVolumeLease): Promise<void> { this.leaseEvents.push({ kind: 'arm', lease }) }
  async clearVolumeLease(id: string): Promise<void> { this.leaseEvents.push({ kind: 'clear', id }) }
}

describe('BridgeRuntime', () => {
  it('keeps Agent playback control disabled until explicitly enabled', async () => {
    const adapter = new StatefulAdapter()
    const runtime = new BridgeRuntime(new MediaBridge([adapter]))

    await expect(runtime.controlFromAgent({ kind: 'play-pause' })).rejects.toMatchObject({ code: 'AGENT_CONTROL_DISABLED' })
    await runtime.controlFromUi({ kind: 'play-pause' })
    runtime.updateConfig({ allowAgentControl: true })
    await runtime.controlFromAgent({ kind: 'play-pause' })

    expect(adapter.commands).toEqual([{ kind: 'play-pause' }, { kind: 'play-pause' }])
  })

  it('exposes control history only in the browser status view', async () => {
    const adapter = new StatefulAdapter()
    const runtime = new BridgeRuntime(new MediaBridge([adapter]), {}, 60_000)
    await runtime.controlFromUi({ kind: 'set-volume', volumePercent: 50 })

    const domain = await runtime.status()
    const ui = await runtime.statusForUi()
    expect(domain).not.toHaveProperty('controlHistory')
    expect(ui.controlHistory[0]).toMatchObject({ source: 'ui', command: { kind: 'set-volume' } })
  })

  it('switches only to a registered explicit player and drops cached state', async () => {
    const qq = new StatefulAdapter()
    const netease = new StatefulAdapter('netease-music', '网易云音乐')
    const runtime = new BridgeRuntime(new MediaBridge([qq, netease]), {}, 60_000)
    await runtime.status()

    expect(() => runtime.updateConfig({ playerId: 'missing' })).toThrow(/No adapter/)
    runtime.updateConfig({ playerId: 'netease-music' })
    await expect(runtime.status()).resolves.toMatchObject({ playerId: 'netease-music' })
    expect(runtime.getConfig().availablePlayers).toHaveLength(2)
  })

  it('shares status reads inside the TTL and primes the cache after control', async () => {
    const adapter = new StatefulAdapter()
    const runtime = new BridgeRuntime(new MediaBridge([adapter]), {}, 60_000)

    await Promise.all([runtime.status(), runtime.status(), runtime.statusForUi()])
    expect(adapter.reads).toBe(1)
    await runtime.controlFromUi({ kind: 'set-volume', volumePercent: 45 })
    const readsAfterControl = adapter.reads
    await runtime.status()
    expect(adapter.reads).toBe(readsAfterControl)
  })

  it('explains only retained capabilities', async () => {
    const runtime = new BridgeRuntime(new MediaBridge([new StatefulAdapter()]), { allowAgentControl: true })

    const explanation = await runtime.explainStatus()
    expect(explanation.summary).toContain('Agent 播放控制已开启')
    expect(explanation.summary).not.toMatch(/专注场景|睡眠定时|番茄钟/)
    expect(await runtime.statusForUi()).not.toHaveProperty('privacy')
  })

  it('projects the live video description only into the browser view, never into BridgeStatus', async () => {
    const adapter = new StatefulAdapter()
    const runtime = new BridgeRuntime(new MediaBridge([adapter]), { preferLiveVideo: true }, 60_000, {}, undefined, undefined, undefined, {
      read: () => ({
        state: 'ready',
        value: {
          provider: 'qq-music',
          kind: 'live',
          vid: 'liveVid001',
          url: 'https://mv.music.tc.qq.com/live001.mp4',
          title: '测试歌曲 (Live)',
          expiresAt: Date.now() + 10 * 60_000,
          durationSeconds: 300,
        },
      }),
    })

    const domain = await runtime.status()
    expect(domain).not.toHaveProperty('liveVideo')
    const ui = await runtime.statusForUi()
    expect(ui.liveVideo).toMatchObject({ vid: 'liveVid001', kind: 'live' })
  })

  it('refuses agent commands while a browser Live session reports itself active, then recovers', async () => {
    const adapter = new StatefulAdapter()
    const runtime = new BridgeRuntime(new MediaBridge([adapter]), { allowAgentControl: true })

    // No live session: commands pass.
    await runtime.controlFromAgent({ kind: 'play-pause' })
    // A fresh browser report locks agent playback control.
    runtime.reportLiveState({ active: true, playing: true })
    await expect(runtime.controlFromAgent({ kind: 'play-pause' })).rejects.toMatchObject({ code: 'LIVE_VIDEO_ACTIVE' })
    await expect(runtime.fadeFromAgent(30, 1)).rejects.toMatchObject({ code: 'LIVE_VIDEO_ACTIVE' })
    await expect(runtime.undoControl(1)).rejects.toMatchObject({ code: 'LIVE_VIDEO_ACTIVE' })
    expect(runtime.liveStateView()).toEqual({ active: true, playing: true })
    // UI control stays available (the web UI owns the video).
    await runtime.controlFromUi({ kind: 'set-volume', volumePercent: 50 })
    // A stale report (no heartbeat) unlocks the agent again.
    runtime.reportLiveState({ active: false, playing: false })
    await runtime.controlFromAgent({ kind: 'play-pause' })
  })

  it('keeps the preferLiveVideo config in sync through updateConfig', () => {
    const runtime = new BridgeRuntime(new MediaBridge([new StatefulAdapter()]))
    expect(runtime.getConfig().preferLiveVideo).toBe(false)
    runtime.updateConfig({ preferLiveVideo: true })
    expect(runtime.getConfig().preferLiveVideo).toBe(true)
    runtime.updateConfig({ preferLiveVideo: false })
    expect(runtime.getConfig().preferLiveVideo).toBe(false)
  })
})
