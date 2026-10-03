import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type WindowsMediaCommand = 'status' | 'diagnose' | 'play-pause' | 'next' | 'previous' | 'seek' | 'set-volume'

export interface VolumeRestoreLease {
  readonly id: string
  readonly player: string
  readonly beforeVolume: number
  readonly appliedVolume: number
  readonly previousAppliedVolume?: number
}

/** Point-in-time liveness of the reusable helper process, for diagnostics. */
export interface PowerShellRunnerHealth {
  /** A worker process is alive right now. Workers are started on demand. */
  readonly alive: boolean
  readonly startedAt?: number
  readonly lastStoppedAt?: number
  /** Sanitized-on-read stop reason; routine idle shutdowns read as "idle". */
  readonly lastStopReason?: string
  readonly activeLeases: number
}

type WorkerRequest =
  | { readonly command: WindowsMediaCommand; readonly player: string; readonly value?: number }
  | ({ readonly command: 'lease-set' } & VolumeRestoreLease)
  | { readonly command: 'lease-clear'; readonly leaseId: string }
  | { readonly command: 'lease-sync'; readonly leases: readonly VolumeRestoreLease[] }

export interface PowerShellRunner {
  run(command: WindowsMediaCommand, positionSeconds?: number, signal?: AbortSignal, player?: string): Promise<unknown>
  launch?(player?: string, signal?: AbortSignal): Promise<void>
  armVolumeLease?(lease: VolumeRestoreLease, signal?: AbortSignal): Promise<void>
  clearVolumeLease?(leaseId: string, signal?: AbortSignal): Promise<void>
  /** Optional in-process worker health probe for diagnostics; no round trip. */
  health?(): PowerShellRunnerHealth
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

type PowerShellWorkerFactory = () => ChildProcessWithoutNullStreams

/** Runs the bundled, same-machine PowerShell bridge without opening a console window. */
export class WindowsPowerShellRunner implements PowerShellRunner {
  private readonly scriptPath = fileURLToPath(new URL('../../scripts/windows-media-session.ps1', import.meta.url))
  private readonly workerPath = fileURLToPath(new URL('../../scripts/windows-media-session-worker.ps1', import.meta.url))
  private readonly workerFactory: PowerShellWorkerFactory
  private worker: ChildProcessWithoutNullStreams | undefined
  private readonly pending: PendingRequest[] = []
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private idleTimer: NodeJS.Timeout | undefined
  private readonly activeLeases = new Map<string, VolumeRestoreLease>()
  private leaseSyncRequired = false
  private leaseSync: Promise<void> | undefined
  private readonly ownerStartedAt = Math.round(Date.now() - process.uptime() * 1000)
  private workerStartedAt: number | undefined
  private lastStoppedAt: number | undefined
  private lastStopReason: string | undefined

  constructor(workerFactory?: PowerShellWorkerFactory) {
    this.workerFactory = workerFactory ?? (() => spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.workerPath,
      '-BridgeScriptPath', this.scriptPath,
      '-OwnerProcessId', String(process.pid),
      '-OwnerStartedAt', String(this.ownerStartedAt),
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
  }

  async run(command: WindowsMediaCommand, positionSeconds?: number, signal?: AbortSignal, player = 'qq-music'): Promise<unknown> {
    if (signal?.aborted === true) throw abortError(signal)
    const value = positionSeconds !== undefined && (command === 'seek' || command === 'set-volume')
      ? positionSeconds
      : undefined
    return await this.send({ command, player, value }, signal)
  }

  async launch(player = 'qq-music', signal?: AbortSignal): Promise<void> {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Command', 'launch', '-Player', player]
    await this.runOneShot(args, signal)
  }

  private async runOneShot(args: string[], signal?: AbortSignal): Promise<void> {
    try {
      await execFileAsync('powershell.exe', args, { windowsHide: true, signal, maxBuffer: 64 * 1024 })
    } catch (error) {
      const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout ?? '') : ''
      const payload = tryParseBridgeJson(stdout)
      if (payload !== undefined) throw asBridgeError(payload)
      throw error
    }
  }

  async armVolumeLease(lease: VolumeRestoreLease, signal?: AbortSignal): Promise<void> {
    assertLease(lease)
    const safeLease = { ...lease, previousAppliedVolume: lease.previousAppliedVolume ?? lease.beforeVolume }
    await this.send({ command: 'lease-set', ...safeLease }, signal)
    this.activeLeases.set(lease.id, safeLease)
    this.clearIdleShutdown()
  }

  /** In-process worker health for the diagnostics center; no PowerShell round trip. */
  health(): PowerShellRunnerHealth {
    const worker = this.worker
    return {
      alive: worker !== undefined && worker.exitCode === null && !worker.killed,
      startedAt: this.workerStartedAt,
      lastStoppedAt: this.lastStoppedAt,
      lastStopReason: this.lastStopReason,
      activeLeases: this.activeLeases.size,
    }
  }

  async clearVolumeLease(leaseId: string, signal?: AbortSignal): Promise<void> {
    if (leaseId.trim() === '') throw new Error('Volume lease id must not be empty.')
    await this.send({ command: 'lease-clear', leaseId }, signal)
    this.activeLeases.delete(leaseId)
    if (this.activeLeases.size === 0 && this.pending.length === 0 && this.worker !== undefined) this.scheduleIdleShutdown()
  }

  /** Stop the reusable helper; primarily useful for explicit host/test teardown. */
  close(): void {
    this.stopWorker(new Error('Windows media bridge worker closed.'))
  }

  private async send(request: WorkerRequest, signal?: AbortSignal): Promise<unknown> {
    this.clearIdleShutdown()
    const worker = this.ensureWorker()
    this.refWorker(worker)
    await this.syncActiveLeases(worker, signal)
    return await this.sendRaw(worker, request, signal)
  }

  private sendRaw(worker: ChildProcessWithoutNullStreams, request: WorkerRequest, signal?: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = signal === undefined ? undefined : () => this.stopWorker(abortError(signal))
      const pending: PendingRequest = { resolve, reject, signal, onAbort }
      this.pending.push(pending)
      if (onAbort !== undefined) signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) {
        onAbort?.()
        return
      }
      worker.stdin.write(`${JSON.stringify(request)}\n`, 'utf8', (error) => {
        if (error !== null && error !== undefined) this.stopWorker(error)
      })
    })
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.worker !== undefined && this.worker.exitCode === null && !this.worker.killed) return this.worker
    const worker = this.workerFactory()
    this.worker = worker
    this.workerStartedAt = Date.now()
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
    this.leaseSyncRequired = this.activeLeases.size > 0
    worker.stdout.setEncoding('utf8')
    worker.stderr.setEncoding('utf8')
    worker.stdout.on('data', (chunk: string) => this.consumeStdout(chunk))
    worker.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-8192)
    })
    worker.once('error', (error) => {
      if (this.worker === worker) this.stopWorker(error, false)
    })
    worker.once('exit', (code, signal) => {
      if (this.worker !== worker) return
      const detail = this.stderrBuffer.trim()
      const suffix = detail === '' ? '' : ` ${detail}`
      this.stopWorker(new Error(`Windows media bridge worker exited (${signal ?? code ?? 'unknown'}).${suffix}`), false)
    })
    return worker
  }

  private async syncActiveLeases(worker: ChildProcessWithoutNullStreams, signal?: AbortSignal): Promise<void> {
    if (!this.leaseSyncRequired) {
      if (this.leaseSync !== undefined) await this.leaseSync
      return
    }
    if (this.leaseSync === undefined) {
      this.leaseSyncRequired = false
      this.leaseSync = this.sendRaw(worker, { command: 'lease-sync', leases: [...this.activeLeases.values()] }, signal)
        .then(() => undefined)
        .finally(() => { this.leaseSync = undefined })
    }
    await this.leaseSync
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line.trim() !== '') this.consumeResponse(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private consumeResponse(line: string): void {
    const pending = this.pending.shift()
    if (pending === undefined) {
      this.stopWorker(new Error('Windows media bridge worker returned an unexpected response.'))
      return
    }
    const payload = tryParseBridgeJson(line)
    if (payload === undefined) {
      this.finish(pending, () => pending.reject(new Error('Windows media bridge worker returned invalid JSON.')))
      this.stopWorker(new Error('Windows media bridge worker protocol is out of sync.'))
      return
    }
    if (isBridgeError(payload)) this.finish(pending, () => pending.reject(asBridgeError(payload)))
    else this.finish(pending, () => pending.resolve(payload))
    if (this.pending.length === 0 && this.worker !== undefined) {
      this.unrefWorker(this.worker)
      this.scheduleIdleShutdown()
    }
  }

  private finish(pending: PendingRequest, settle: () => void): void {
    if (pending.onAbort !== undefined) pending.signal?.removeEventListener('abort', pending.onAbort)
    settle()
  }

  private stopWorker(error: Error, kill = true): void {
    this.clearIdleShutdown()
    const worker = this.worker
    this.worker = undefined
    this.lastStoppedAt = Date.now()
    this.lastStopReason = error.message.length > 300 ? `${error.message.slice(0, 300)}…` : error.message
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
    this.leaseSyncRequired = this.activeLeases.size > 0
    this.leaseSync = undefined
    if (kill && worker !== undefined && worker.exitCode === null && !worker.killed) worker.kill()
    for (const pending of this.pending.splice(0)) this.finish(pending, () => pending.reject(error))
  }

  private refWorker(worker: ChildProcessWithoutNullStreams): void {
    worker.ref()
    streamRef(worker.stdin)
    streamRef(worker.stdout)
    streamRef(worker.stderr)
  }

  private unrefWorker(worker: ChildProcessWithoutNullStreams): void {
    streamUnref(worker.stdin)
    streamUnref(worker.stdout)
    streamUnref(worker.stderr)
    worker.unref()
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleShutdown()
    if (this.activeLeases.size > 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.stopWorker(new Error('Windows media bridge worker became idle.'))
    }, 30_000)
    this.idleTimer.unref()
  }

  private clearIdleShutdown(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

function tryParseBridgeJson(stdout: string): unknown | undefined {
  const text = stdout.trim()
  if (text === '') return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

function asBridgeError(payload: unknown): Error {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const value = payload.error
    if (typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string') {
      return new Error(value.message)
    }
  }
  return new Error('Windows media bridge command failed.')
}

function isBridgeError(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'error' in payload
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Windows media bridge request aborted.')
}

function streamRef(stream: unknown): void {
  if (typeof stream === 'object' && stream !== null && 'ref' in stream && typeof stream.ref === 'function') stream.ref()
}

function streamUnref(stream: unknown): void {
  if (typeof stream === 'object' && stream !== null && 'unref' in stream && typeof stream.unref === 'function') stream.unref()
}

function assertLease(lease: VolumeRestoreLease): void {
  if (lease.id.trim() === '') throw new Error('Volume lease id must not be empty.')
  if (lease.player.trim() === '') throw new Error('Volume lease player must not be empty.')
  for (const value of [lease.beforeVolume, lease.appliedVolume, lease.previousAppliedVolume ?? lease.beforeVolume]) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Volume lease values must be finite numbers from 0 to 100.')
  }
}
