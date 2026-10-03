import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { WindowsPowerShellRunner } from '../src/adapters/powershell-runner.ts'

class FakeWorker extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: unknown[] = []
  exitCode: number | null = null
  killed = false
  private input = ''

  constructor(private readonly respond: (request: any, index: number) => unknown | undefined) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.input += chunk
      let newline = this.input.indexOf('\n')
      while (newline >= 0) {
        const line = this.input.slice(0, newline)
        this.input = this.input.slice(newline + 1)
        const request = JSON.parse(line)
        this.requests.push(request)
        const response = this.respond(request, this.requests.length - 1)
        if (response !== undefined) this.stdout.write(`${JSON.stringify(response)}\n`)
        newline = this.input.indexOf('\n')
      }
    })
  }

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    this.exitCode = 1
    queueMicrotask(() => this.emit('exit', 1, null))
    return true
  }

  ref(): void {}
  unref(): void {}
}

describe('WindowsPowerShellRunner worker protocol', () => {
  it('reuses one worker for sequential status and control requests', async () => {
    let starts = 0
    const worker = new FakeWorker((_request, index) => ({ state: index === 0 ? 'paused' : 'playing' }))
    const runner = new WindowsPowerShellRunner(() => { starts += 1; return worker as any })

    await expect(runner.run('status', undefined, undefined, 'netease-music')).resolves.toEqual({ state: 'paused' })
    await expect(runner.run('play-pause', undefined, undefined, 'netease-music')).resolves.toEqual({ state: 'playing' })

    expect(starts).toBe(1)
    expect(worker.requests).toEqual([
      { command: 'status', player: 'netease-music' },
      { command: 'play-pause', player: 'netease-music' },
    ])
    runner.close()
  })

  it('maps seek and volume values onto the line protocol', async () => {
    const worker = new FakeWorker(() => ({ state: 'paused' }))
    const runner = new WindowsPowerShellRunner(() => worker as any)

    await runner.run('seek', 42.5, undefined, 'qq-music')
    await runner.run('set-volume', 35, undefined, 'qq-music')

    expect(worker.requests).toEqual([
      { command: 'seek', player: 'qq-music', value: 42.5 },
      { command: 'set-volume', player: 'qq-music', value: 35 },
    ])
    runner.close()
  })

  it('rejects a structured bridge error without discarding the healthy worker', async () => {
    const worker = new FakeWorker((_request, index) => index === 0
      ? { error: { code: 'COMMAND_REJECTED', message: 'Player rejected command.' } }
      : { state: 'paused' })
    const runner = new WindowsPowerShellRunner(() => worker as any)

    await expect(runner.run('next')).rejects.toThrowError('Player rejected command.')
    await expect(runner.run('status')).resolves.toEqual({ state: 'paused' })
    expect(worker.requests).toHaveLength(2)
    runner.close()
  })

  it('kills an in-flight worker on abort so later responses cannot desynchronize the protocol', async () => {
    const first = new FakeWorker(() => undefined)
    const second = new FakeWorker(() => ({ state: 'paused' }))
    const workers = [first, second]
    const runner = new WindowsPowerShellRunner(() => workers.shift() as any)
    const controller = new AbortController()

    const pending = runner.run('status', undefined, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrowError('cancelled')
    expect(first.killed).toBe(true)
    await expect(runner.run('status')).resolves.toEqual({ state: 'paused' })
    runner.close()
  })

  it('arms and clears volume leases through the worker protocol', async () => {
    const worker = new FakeWorker((request) => request.command === 'lease-set'
      ? { lease: { id: request.id, armed: true } }
      : { lease: { id: request.leaseId, armed: false } })
    const runner = new WindowsPowerShellRunner(() => worker as any)

    await runner.armVolumeLease({ id: 'focus', player: 'qq-music', beforeVolume: 80, appliedVolume: 35 })
    await runner.clearVolumeLease('focus')

    expect(worker.requests).toEqual([
      { command: 'lease-set', id: 'focus', player: 'qq-music', beforeVolume: 80, appliedVolume: 35, previousAppliedVolume: 80 },
      { command: 'lease-clear', leaseId: 'focus' },
    ])
    runner.close()
  })

  it('resynchronizes active leases after an unexpected worker restart', async () => {
    const first = new FakeWorker(() => ({ lease: { armed: true } }))
    const second = new FakeWorker((request) => request.command === 'lease-sync' ? { leases: { synced: 1 } } : { state: 'paused' })
    const workers = [first, second]
    const runner = new WindowsPowerShellRunner(() => workers.shift() as any)

    await runner.armVolumeLease({ id: 'focus', player: 'qq-music', beforeVolume: 80, appliedVolume: 35 })
    first.kill()
    await new Promise((resolve) => setImmediate(resolve))
    await expect(runner.run('status')).resolves.toEqual({ state: 'paused' })

    expect(second.requests).toEqual([
      { command: 'lease-sync', leases: [{ id: 'focus', player: 'qq-music', beforeVolume: 80, appliedVolume: 35, previousAppliedVolume: 80 }] },
      { command: 'status', player: 'qq-music' },
    ])
    await runner.clearVolumeLease('focus')
    runner.close()
  })
})
