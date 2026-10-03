import { describe, expect, it } from 'vitest'
import { BridgeRuntime } from '../src/bridge-runtime.ts'
import { MediaBridge } from '../src/domain/media-bridge.ts'
import type { PlayerAdapter } from '../src/domain/player-adapter.ts'
import type { BridgeStatus, MediaCommand } from '../src/domain/types.ts'
import { SkipLedger } from '../src/listening-report.ts'
import type { ListeningEntry } from '../src/listening-memory.ts'

class StubAdapter implements PlayerAdapter {
  readonly id = 'qq-music'
  readonly displayName = 'QQ 音乐'
  state: BridgeStatus['state'] = 'playing'
  async readStatus(): Promise<BridgeStatus> {
    return {
      playerId: this.id, playerName: this.displayName, state: this.state,
      track: { title: '晴天', artist: '周杰伦', durationSeconds: 240 },
      capabilities: { playPause: true, next: true, previous: true, seek: true, volume: true },
    }
  }
  async execute(command: MediaCommand): Promise<void> {
    if (command.kind === 'play-pause') this.state = this.state === 'playing' ? 'paused' : 'playing'
  }
}

describe('BridgeRuntime listening report wiring', () => {
  it('records explicit user skips and exposes the retained listening report', async () => {
    const notedArtists: string[] = []
    const ledger = {
      note: (artist: string) => notedArtists.push(artist),
      recent: () => [{ at: Date.now(), artist: '周杰伦' }],
    } as unknown as SkipLedger
    const memory = {
      recent: () => [{
        id: 't1', playerId: 'qq-music', playerName: 'QQ 音乐', title: '晴天', artist: '周杰伦',
        playedSeconds: 200, startedAt: Date.now() - 60_000, lastPlayedAt: Date.now(),
      }] as unknown as ListeningEntry[],
    }
    const runtime = new BridgeRuntime(new MediaBridge([new StubAdapter()]), {}, 60_000, {}, memory as never, ledger)

    await runtime.controlFromUi({ kind: 'next' })
    expect(notedArtists).toEqual(['周杰伦'])
    await expect(runtime.listeningReport('week')).resolves.toMatchObject({ plays: 1, skips: 1, trackSwitches: 1 })
  })
})
