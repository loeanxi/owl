import { describe, expect, it } from 'vitest'
import { MediaBridge } from '../src/domain/media-bridge.ts'
import type { PlayerAdapter } from '../src/domain/player-adapter.ts'
import { type BridgeStatus, NO_CAPABILITIES } from '../src/domain/types.ts'

class Adapter implements PlayerAdapter {
  readonly id = 'qq-music'
  readonly displayName = 'QQ 音乐'
  reads = 0
  async readStatus(): Promise<BridgeStatus> { this.reads += 1; return { playerId: this.id, playerName: this.displayName, state: 'paused', capabilities: { ...NO_CAPABILITIES, playPause: true } } }
  async execute(): Promise<void> {}
}

describe('MediaBridge status cache', () => {
  it('refreshes status before a command capability check', async () => {
    const adapter = new Adapter()
    const bridge = new MediaBridge([adapter])
    await bridge.status()
    await bridge.control({ kind: 'play-pause' })
    expect(adapter.reads).toBe(3)
  })

  it('does not execute a command after capabilities disappear between polls', async () => {
    let capabilities = { ...NO_CAPABILITIES, playPause: true }
    let executed = false
    const adapter: PlayerAdapter = {
      id: 'qq-music',
      displayName: 'QQ 音乐',
      readStatus: async () => ({ playerId: 'qq-music', playerName: 'QQ 音乐', state: 'paused', capabilities }),
      execute: async () => { executed = true },
    }
    const bridge = new MediaBridge([adapter])
    await bridge.status()
    capabilities = NO_CAPABILITIES

    await expect(bridge.control({ kind: 'play-pause' })).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE' })
    expect(executed).toBe(false)
  })
})
