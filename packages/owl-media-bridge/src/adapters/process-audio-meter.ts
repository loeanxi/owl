import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	type AudioSignalFrame,
	type AudioSignalProvider,
	type AudioSignalReading,
	EMPTY_AUDIO_SIGNAL_READING,
	normalizeAudioSignalFrame,
} from "../domain/audio-signal.ts";
import type { PlayerId } from "../domain/types.ts";

const METER_SCRIPT_PATH = fileURLToPath(new URL("../../scripts/windows-process-audio-meter.ps1", import.meta.url));
/** Ring size must match the domain cap so transport bursts never grow unbounded. */
const DEFAULT_MAX_FRAMES = 24;
/** Helper self-stops when nobody consumes readings; mirrors the media worker idle pattern. */
const DEFAULT_IDLE_STOP_MS = 30_000;
const MAX_CONSECUTIVE_CRASHES = 3;
const RESTART_DELAY_MS = 600;
/** A helper alive longer than this counts as stable again for the crash budget. */
const CRASH_STABILITY_MS = 10_000;

export interface WindowsProcessAudioMeterOptions {
	/** Test seam; the default spawns the bundled PowerShell meter script. */
	readonly spawnProcess?: (playerId: PlayerId) => ChildProcessWithoutNullStreams;
	readonly maxFrames?: number;
	readonly idleStopMs?: number;
	readonly restartDelayMs?: number;
	readonly now?: () => number;
}

interface MeterEventLine {
	event?: unknown;
	pids?: unknown;
	targets?: unknown;
	active?: unknown;
	rms?: unknown;
	peak?: unknown;
	bands?: unknown;
	at?: unknown;
	error?: { code?: unknown; message?: unknown };
}

/**
 * Process-scoped loopback meter for the explicitly selected player.
 *
 * It owns one streaming PowerShell helper that captures ONLY the player
 * process's render audio (WASAPI process loopback), computes amplitude/FFT in
 * memory inside that helper, and streams bounded NDJSON frames here. There is
 * deliberately no endpoint-wide fallback: when per-process capture fails the
 * provider surfaces `unsupportedOs`/`failure` and the UI keeps its synthetic
 * animation with an explicit notice. Frames live only in this ring buffer;
 * nothing is persisted and nothing reaches model tools.
 */
export class WindowsProcessAudioMeter implements AudioSignalProvider {
	private readonly options: Required<Omit<WindowsProcessAudioMeterOptions, "spawnProcess">> &
		Pick<WindowsProcessAudioMeterOptions, "spawnProcess">;
	private readonly frames: AudioSignalFrame[] = [];
	private child: ChildProcessWithoutNullStreams | undefined;
	private lineBuffer = "";
	private stderrTail = "";
	private requestedPlayer: PlayerId | undefined;
	private runningPlayer: PlayerId | undefined;
	private intentionalStop = false;
	private benignExit = false;
	private starting = false;
	private unsupportedOs = false;
	private failure: string | undefined;
	private targetProcesses = 0;
	private activeTargetProcesses = 0;
	private crashes = 0;
	private startedAt = 0;
	private restartTimer: NodeJS.Timeout | undefined;
	private idleTimer: NodeJS.Timeout | undefined;

	constructor(options: WindowsProcessAudioMeterOptions = {}) {
		this.options = {
			spawnProcess: options.spawnProcess,
			maxFrames: options.maxFrames ?? DEFAULT_MAX_FRAMES,
			idleStopMs: options.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
			restartDelayMs: options.restartDelayMs ?? RESTART_DELAY_MS,
			now: options.now ?? (() => Date.now()),
		};
	}

	/** Begin capturing for this exact player, restarting the helper on retarget. */
	request(playerId: PlayerId): void {
		this.requestedPlayer = playerId;
		this.clearIdleTimer();
		if (this.child !== undefined && this.runningPlayer === playerId) return;
		this.startHelper();
	}

	/** Stop capturing entirely; buffered frames are dropped with the scope. */
	stop(): void {
		this.intentionalStop = true;
		this.clearRestartTimer();
		this.clearIdleTimer();
		this.killHelper();
		this.resetCaptureState();
		this.requestedPlayer = undefined;
		this.unsupportedOs = false;
		this.failure = undefined;
		this.crashes = 0;
	}

	/** Latest bounded reading; also refreshes the consumer liveness window. */
	read(): AudioSignalReading {
		const gaveUp = this.crashes >= MAX_CONSECUTIVE_CRASHES;
		if (this.requestedPlayer !== undefined && this.child === undefined && !this.benignExit && !gaveUp) {
			// A crashed helper is restarted lazily by consumers, never system-wide.
			this.startHelper();
		}
		this.scheduleIdleStop();
		return this.snapshot();
	}

	dispose(): void {
		this.stop();
	}

	private snapshot(): AudioSignalReading {
		if (this.requestedPlayer === undefined) return EMPTY_AUDIO_SIGNAL_READING;
		const active = this.frames.length > 0 && this.activeTargetProcesses > 0;
		return {
			active,
			starting: this.starting || (this.child !== undefined && !active),
			unsupportedOs: this.unsupportedOs,
			failure: this.failure,
			frames: [...this.frames],
			targetProcesses: this.targetProcesses,
			activeTargetProcesses: this.activeTargetProcesses,
		};
	}

	private startHelper(): void {
		const playerId = this.requestedPlayer;
		if (playerId === undefined) return;
		this.clearRestartTimer();
		this.killHelper();
		this.intentionalStop = false;
		this.benignExit = false;
		this.starting = true;
		this.startedAt = this.options.now();

		const factory = this.options.spawnProcess ?? defaultSpawnProcess;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = factory(playerId);
		} catch (error) {
			this.starting = false;
			this.failure = error instanceof Error ? error.message : String(error);
			this.scheduleCrashRestart();
			return;
		}

		this.runningPlayer = playerId;
		this.child = child;
		this.lineBuffer = "";
		this.stderrTail = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-512);
		});
		child.once("error", (error: Error) => {
			if (this.child === child) this.handleExit(`波形捕获进程启动失败：${error.message}`);
		});
		child.once("exit", () => {
			if (this.child === child) this.handleExit(this.benignExit ? undefined : "波形捕获进程意外退出。");
		});
	}

	private consumeStdout(chunk: string): void {
		this.lineBuffer += chunk;
		let newline = this.lineBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "").trim();
			this.lineBuffer = this.lineBuffer.slice(newline + 1);
			if (line !== "") this.consumeLine(line);
			newline = this.lineBuffer.indexOf("\n");
		}
	}

	private consumeLine(line: string): void {
		let payload: MeterEventLine;
		try {
			payload = JSON.parse(line) as MeterEventLine;
		} catch {
			return;
		}
		if (typeof payload !== "object" || payload === null) return;

		if (payload.error !== undefined) {
			this.absorbError(payload.error);
			return;
		}
		if (typeof payload.rms === "number") {
			const frame = normalizeAudioSignalFrame(payload);
			if (frame !== undefined) {
				this.pushFrame(frame);
				this.targetProcesses = toCount(payload.targets);
				this.activeTargetProcesses = toCount(payload.active);
				this.starting = false;
				// A flowing stream supersedes earlier transient failures.
				this.failure = undefined;
			}
			return;
		}
		if (payload.event === "started") {
			this.targetProcesses = Array.isArray(payload.pids) ? payload.pids.length : toCount(payload.targets);
			this.starting = false;
		} else if (payload.event === "stopped") {
			this.benignExit = true;
			this.starting = false;
		}
	}

	private absorbError(error: { code?: unknown; message?: unknown }): void {
		const message =
			typeof error.message === "string" && error.message.trim() !== "" ? error.message : "未知捕获错误。";
		if (error.code === "PROCESS_LOOPBACK_UNSUPPORTED" || error.code === "PLAYER_PROCESS_NOT_FOUND") {
			if (error.code === "PROCESS_LOOPBACK_UNSUPPORTED") this.unsupportedOs = true;
			this.failure = message;
			this.starting = false;
			return;
		}
		this.failure = message;
		this.starting = false;
	}

	private pushFrame(frame: AudioSignalFrame): void {
		this.frames.push(frame);
		while (this.frames.length > this.options.maxFrames) this.frames.shift();
	}

	private handleExit(detail: string | undefined): void {
		this.child = undefined;
		this.runningPlayer = undefined;
		this.starting = false;
		this.activeTargetProcesses = 0;
		this.targetProcesses = 0;
		if (this.intentionalStop || this.requestedPlayer === undefined) return;
		if (this.benignExit) return;

		const stable = this.options.now() - this.startedAt >= CRASH_STABILITY_MS;
		this.crashes = stable ? 1 : this.crashes + 1;
		if (this.crashes >= MAX_CONSECUTIVE_CRASHES) {
			const tail = this.stderrTail.trim();
			this.failure =
				`波形捕获进程反复退出，已停止重试。${detail ?? ""}${tail === "" ? "" : ` ${tail.slice(-200)}`}`.trim();
			this.clearRestartTimer();
			return;
		}
		this.scheduleCrashRestart();
	}

	private scheduleCrashRestart(): void {
		this.clearRestartTimer();
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (this.requestedPlayer !== undefined && this.child === undefined) this.startHelper();
		}, this.options.restartDelayMs);
		this.restartTimer.unref?.();
	}

	private scheduleIdleStop(): void {
		this.clearIdleTimer();
		if (this.child === undefined && this.restartTimer === undefined) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			this.intentionalStop = true;
			this.killHelper();
			this.resetCaptureState();
		}, this.options.idleStopMs);
		this.idleTimer.unref?.();
	}

	private killHelper(): void {
		const child = this.child;
		this.child = undefined;
		if (child !== undefined && child.exitCode === null && !child.killed) child.kill();
	}

	private resetCaptureState(): void {
		this.frames.length = 0;
		this.lineBuffer = "";
		this.runningPlayer = undefined;
		this.starting = false;
		this.targetProcesses = 0;
		this.activeTargetProcesses = 0;
	}

	private clearRestartTimer(): void {
		if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}
}

function toCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function defaultSpawnProcess(playerId: PlayerId): ChildProcessWithoutNullStreams {
	return spawn(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			METER_SCRIPT_PATH,
			"-Player",
			playerId,
			"-IntervalMs",
			"50",
		],
		{
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
}
