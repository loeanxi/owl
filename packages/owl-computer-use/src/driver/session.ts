/**
 * 严格串行的 computer-use JSON 行会话；队列、ready、执行分别计时。
 * 取消已下发命令时终止 worker，清除观察；未知动作从不自动重放。
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
	ClickButton,
	NativeActInput,
	NativeActResult,
	NativeObservation,
	ScreenshotMeta,
	WindowRef,
	WindowRow,
} from "./protocol.ts";

export type { ClickButton, ScreenshotMeta, WindowRef, WindowRow } from "./protocol.ts";

export interface DriverSpawnOptions {
	/** 下发后的执行超时，默认 20s。 */
	requestTimeoutMs?: number;
	/** 编译、加载并 ready 的超时，默认 120s。 */
	readyTimeoutMs?: number;
	/** 排队等待超时，默认 120s；0 禁用。 */
	queueTimeoutMs?: number;
	/** 空闲自停，默认 60s；0 禁用。 */
	idleTimeoutMs?: number;
	/** 单条协议行的最大字符数，默认 16 MiB（含 JPEG base64）。 */
	maxResponseChars?: number;
	/** Native control Stop, after authenticating the current worker/control instance. */
	onControlStop?: (event: DriverControlStop) => void;
}

export interface DriverControlStop {
	controlId: string;
	requestId: number;
	workerGeneration: number;
	/** Host-supplied run identity, captured when the authorizing act was queued. */
	ownerId?: string;
}

export type DriverWorkerFactory = () => ChildProcessWithoutNullStreams;
type PayloadFactory = () => Record<string, unknown>;

interface QueuedCommand {
	buildPayload: PayloadFactory;
	accept?: (data: Record<string, unknown>) => void;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	queueTimer?: NodeJS.Timeout;
	started: boolean;
	settled: boolean;
	epoch: number;
	ownerId?: string;
}

interface PendingRequest {
	id: number;
	command: string;
	ownerId?: string;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface DriverWorker {
	process: ChildProcessWithoutNullStreams;
	generation: number;
	ready: Promise<void>;
	resolveReady: () => void;
	rejectReady: (error: Error) => void;
	readySettled: boolean;
	readyTimer?: NodeJS.Timeout;
	pending?: PendingRequest;
	control?: { controlId: string; requestId: number; ownerId?: string };
	stdoutBuffer: string;
	stderrBuffer: string;
	detach: () => void;
}

export class ComputerDriverSession {
	private readonly scriptPath = fileURLToPath(new URL("./computer-driver.ps1", import.meta.url));
	private readonly captureKernelPath = fileURLToPath(
		new URL("../../../coding-agent/src/modes/desktop/mirror/windows-capture.cs", import.meta.url),
	);
	private readonly workerFactory: DriverWorkerFactory;
	private readonly readyTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private readonly queueTimeoutMs: number;
	private readonly idleTimeoutMs: number;
	private readonly maxResponseChars: number;
	private readonly onControlStop: ((event: DriverControlStop) => void) | undefined;
	private controlOwnerId: string | undefined;
	private worker: DriverWorker | undefined;
	private generation = 0;
	private epoch = 0;
	private nextRequestId = 1;
	private readonly queue: QueuedCommand[] = [];
	private active: QueuedCommand | undefined;
	private draining = false;
	private idleTimer: NodeJS.Timeout | undefined;
	private lastScreenshot: ScreenshotMeta | undefined;
	private observationId: string | undefined;

	constructor(workerFactory?: DriverWorkerFactory, options: DriverSpawnOptions = {}) {
		this.workerFactory =
			workerFactory ??
			(() =>
				spawn(
					"powershell.exe",
					["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
					{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
				));
		this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
		this.queueTimeoutMs = options.queueTimeoutMs ?? 120_000;
		this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
		this.maxResponseChars = options.maxResponseChars ?? 16 * 1024 * 1024;
		this.onControlStop = options.onControlStop;
	}

	/** Only the host sets this identity; a new run cannot inherit an old control Stop. */
	setControlOwner(ownerId: string | undefined): void {
		if (this.controlOwnerId === ownerId) return;
		// Native Stop is latched and its HUD belongs to the old run. A new owner
		// needs a fresh native worker, not merely a cleared JavaScript identity.
		if (ownerId !== undefined && this.worker !== undefined) this.close();
		this.controlOwnerId = ownerId;
		if (this.worker) this.worker.control = undefined;
	}

	async observe(
		input: { hwnd?: number; includeImage?: boolean; maxWidth?: number } = {},
		signal?: AbortSignal,
	): Promise<NativeObservation> {
		return (await this.command(
			() => {
				this.invalidateObservation();
				return {
					cmd: "observe",
					...input,
					includeImage: input.includeImage ?? true,
					maxWidth: input.maxWidth ?? 1568,
					quality: 80,
					captureKernelPath: this.captureKernelPath,
				};
			},
			signal,
			(data) => this.acceptObservation(data as unknown as NativeObservation),
		)) as unknown as NativeObservation;
	}

	async act(input: NativeActInput, signal?: AbortSignal): Promise<NativeActResult> {
		return (await this.command(
			() => {
				if (this.observationId !== input.observationId)
					throw new Error("Observation is stale or unavailable; call computer_observe again before acting.");
				if (input.x !== undefined || input.y !== undefined) {
					if (input.x === undefined || input.y === undefined)
						throw new Error("Coordinate actions require both x and y.");
					this.toScreenSpace(input.x, input.y);
				}
				this.invalidateObservation();
				return { cmd: "act", ...input };
			},
			signal,
			(data) => {
				const result = data as unknown as NativeActResult;
				if (result.observation !== undefined) this.acceptObservation(result.observation);
			},
		)) as unknown as NativeActResult;
	}

	async release(signal?: AbortSignal): Promise<void> {
		if (this.worker) this.worker.control = undefined;
		// abort/close 会先停止 worker，再让 drain 异步退出。此时即使 active 尚未
		// 清空，也已经没有原生资源可释放；cleanup 不能为 release 重启进程。
		if (this.worker === undefined) {
			this.invalidateObservation();
			return;
		}
		await this.command(() => {
			this.invalidateObservation();
			return { cmd: "release" };
		}, signal);
	}

	async screenshot(
		monitor: number,
		maxWidth: number,
		quality: number,
		signal?: AbortSignal,
	): Promise<ScreenshotMeta & { jpeg: string }> {
		return (await this.command(
			() => {
				this.invalidateObservation();
				return { cmd: "screenshot", monitor, maxWidth, quality };
			},
			signal,
			(data) => this.acceptScreenshot(data as unknown as ScreenshotMeta),
		)) as unknown as ScreenshotMeta & { jpeg: string };
	}

	async click(
		x: number,
		y: number,
		button: ClickButton,
		double: boolean,
		signal?: AbortSignal,
		expectHwnd?: number,
	): Promise<{ clicked: boolean; blocked?: boolean; x: number; y: number; window?: WindowRef | null }> {
		return (await this.command(() => {
			const screen = this.toScreenSpace(x, y);
			this.observationId = undefined;
			return { cmd: "click", x: screen.x, y: screen.y, button, double, expectHwnd };
		}, signal)) as { clicked: boolean; blocked?: boolean; x: number; y: number; window?: WindowRef | null };
	}

	async type(
		text: string,
		signal?: AbortSignal,
		expectHwnd?: number,
	): Promise<{ typed: boolean; blocked?: boolean; foreground?: WindowRef | null }> {
		return (await this.command({ cmd: "type", text, expectHwnd }, signal)) as {
			typed: boolean;
			blocked?: boolean;
			foreground?: WindowRef | null;
		};
	}

	async key(
		down: number[],
		tap: number[],
		signal?: AbortSignal,
		expectHwnd?: number,
	): Promise<{ sent: boolean; blocked?: boolean; foreground?: WindowRef | null }> {
		return (await this.command({ cmd: "key", down, tap, expectHwnd }, signal)) as {
			sent: boolean;
			blocked?: boolean;
			foreground?: WindowRef | null;
		};
	}

	async scroll(
		x: number,
		y: number,
		delta: number,
		horizontal: boolean,
		signal?: AbortSignal,
		expectHwnd?: number,
	): Promise<{ scrolled: boolean; blocked?: boolean }> {
		return (await this.command(() => {
			const screen = this.toScreenSpace(x, y);
			this.observationId = undefined;
			return { cmd: "scroll", x: screen.x, y: screen.y, delta, horizontal, expectHwnd };
		}, signal)) as { scrolled: boolean; blocked?: boolean };
	}

	async windows(signal?: AbortSignal): Promise<WindowRow[]> {
		const data = (await this.command({ cmd: "windows" }, signal)) as { windows: WindowRow[] };
		return data.windows;
	}

	async focus(hwnd: number, signal?: AbortSignal): Promise<boolean> {
		const data = (await this.command({ cmd: "focus", hwnd }, signal)) as { focused: boolean };
		return data.focused === true;
	}

	async restore(hwnd: number, signal?: AbortSignal): Promise<boolean> {
		const data = (await this.command({ cmd: "restore", hwnd }, signal)) as { restored: boolean };
		return data.restored === true;
	}

	async cursor(signal?: AbortSignal): Promise<{ x: number; y: number }> {
		return (await this.command({ cmd: "cursor" }, signal)) as { x: number; y: number };
	}

	/** 图像坐标必须在观察内；输出物理坐标支持副显示器的负原点。 */
	toScreenSpace(x: number, y: number): { x: number; y: number } {
		const meta = this.lastScreenshot;
		if (meta === undefined)
			throw new Error(
				"No screenshot yet; call computer_screenshot or computer_observe first to establish coordinates.",
			);
		if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= meta.imageWidth || y >= meta.imageHeight)
			throw new Error("Coordinates must be finite and within the current screenshot bounds.");
		return {
			x: Math.min(
				meta.originX + meta.screenWidth - 1,
				Math.round(meta.originX + (x * meta.screenWidth) / meta.imageWidth),
			),
			y: Math.min(
				meta.originY + meta.screenHeight - 1,
				Math.round(meta.originY + (y * meta.screenHeight) / meta.imageHeight),
			),
		};
	}

	get screenshotMeta(): ScreenshotMeta | undefined {
		return this.lastScreenshot === undefined ? undefined : { ...this.lastScreenshot };
	}

	/** 拒绝当前及排队请求；后续独立调用可以新建 worker。 */
	close(): void {
		this.stopWorker(new Error("computer-use driver closed; any issued action outcome may be unknown."));
	}

	private acceptScreenshot(meta: ScreenshotMeta): void {
		if (
			![meta.imageWidth, meta.imageHeight, meta.screenWidth, meta.screenHeight].every(
				(value) => Number.isSafeInteger(value) && value > 0,
			) ||
			![meta.originX, meta.originY].every(Number.isSafeInteger)
		)
			throw new Error("Driver returned invalid screenshot geometry.");
		this.lastScreenshot = {
			imageWidth: meta.imageWidth,
			imageHeight: meta.imageHeight,
			screenWidth: meta.screenWidth,
			screenHeight: meta.screenHeight,
			originX: meta.originX,
			originY: meta.originY,
		};
	}

	private acceptObservation(observation: NativeObservation): void {
		this.invalidateObservation();
		if (typeof observation.observationId !== "string" || observation.observationId.length === 0)
			throw new Error("Driver returned an invalid observation id.");
		if (observation.screenshot !== undefined) this.acceptScreenshot(observation.screenshot);
		this.observationId = observation.observationId;
	}

	private invalidateObservation(): void {
		this.lastScreenshot = undefined;
		this.observationId = undefined;
	}

	private command(
		payload: Record<string, unknown> | PayloadFactory,
		signal?: AbortSignal,
		accept?: (data: Record<string, unknown>) => void,
	): Promise<Record<string, unknown>> {
		if (signal?.aborted === true) return Promise.reject(abortError(signal));
		this.clearIdleShutdown();
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const item: QueuedCommand = {
				buildPayload: typeof payload === "function" ? payload : () => payload,
				accept,
				resolve,
				reject,
				signal,
				started: false,
				settled: false,
				epoch: this.epoch,
				ownerId: this.controlOwnerId,
			};
			item.onAbort = () => {
				if (item.settled) return;
				if (item.started) this.stopWorker(abortError(signal));
				else {
					const index = this.queue.indexOf(item);
					if (index >= 0) this.queue.splice(index, 1);
					this.finishCommand(item, abortError(signal));
				}
			};
			if (this.queueTimeoutMs > 0) {
				item.queueTimer = setTimeout(() => {
					const index = this.queue.indexOf(item);
					if (index >= 0) this.queue.splice(index, 1);
					this.finishCommand(
						item,
						new Error("computer-use command timed out while waiting in the queue; nothing was issued."),
					);
				}, this.queueTimeoutMs);
				item.queueTimer.unref();
			}
			signal?.addEventListener("abort", item.onAbort, { once: true });
			this.queue.push(item);
			void this.drain();
		});
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (item === undefined || item.settled) continue;
				if (item.epoch !== this.epoch || item.signal?.aborted === true) {
					this.finishCommand(item, abortError(item.signal));
					continue;
				}
				this.active = item;
				item.started = true;
				if (item.queueTimer !== undefined) clearTimeout(item.queueTimer);
				try {
					const data = await this.dispatch(item.buildPayload(), item.ownerId);
					if (!item.settled && item.epoch === this.epoch) {
						item.accept?.(data);
						this.finishCommand(item, undefined, data);
					}
				} catch (error) {
					this.finishCommand(item, error instanceof Error ? error : new Error(String(error)));
				} finally {
					this.active = undefined;
				}
			}
		} finally {
			this.draining = false;
			this.scheduleIdleShutdown();
		}
	}

	private finishCommand(item: QueuedCommand, error?: Error, data?: Record<string, unknown>): void {
		if (item.settled) return;
		item.settled = true;
		if (item.queueTimer !== undefined) clearTimeout(item.queueTimer);
		if (item.onAbort !== undefined) item.signal?.removeEventListener("abort", item.onAbort);
		if (error !== undefined) item.reject(error);
		else item.resolve(data ?? {});
	}

	private async dispatch(payload: Record<string, unknown>, ownerId?: string): Promise<Record<string, unknown>> {
		if (["click", "type", "key", "scroll", "focus", "restore"].includes(String(payload.cmd)))
			this.observationId = undefined;
		const state = this.ensureWorker();
		await state.ready;
		if (this.worker !== state) throw new Error("computer-use worker changed before request dispatch.");
		const id = this.nextRequestId++;
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.worker !== state || state.pending?.id !== id) return;
				this.stopWorker(
					new Error(
						"computer-use driver request timed out: " +
							String(payload.cmd) +
							"; issued action outcome may be unknown.",
					),
				);
			}, this.requestTimeoutMs);
			timer.unref();
			state.pending = { id, command: String(payload.cmd), ownerId, resolve, reject, timer };
			try {
				state.process.stdin.write(JSON.stringify({ id, ...payload }) + "\n", "utf8", (error) => {
					if (error !== null && error !== undefined && this.worker === state) this.stopWorker(error);
				});
			} catch (error) {
				if (this.worker === state) this.stopWorker(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private ensureWorker(): DriverWorker {
		if (this.worker !== undefined) return this.worker;
		const process = this.workerFactory();
		let resolveReady = () => {};
		let rejectReady = (_error: Error) => {};
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		const state: DriverWorker = {
			process,
			generation: ++this.generation,
			ready,
			resolveReady,
			rejectReady,
			readySettled: false,
			stdoutBuffer: "",
			stderrBuffer: "",
			detach: () => {},
		};
		this.worker = state;
		process.stdout.setEncoding("utf8");
		process.stderr.setEncoding("utf8");
		const onStdout = (chunk: string) => {
			if (this.worker === state && state.generation === this.generation) this.consumeStdout(state, chunk);
		};
		const onStderr = (chunk: string) => {
			if (this.worker === state) state.stderrBuffer = (state.stderrBuffer + chunk).slice(-8192);
		};
		const onError = (error: Error) => {
			if (this.worker === state) this.stopWorker(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			if (this.worker !== state) return;
			const detail = state.stderrBuffer.trim().slice(-400);
			this.stopWorker(
				new Error(
					"computer-use driver exited (" +
						String(signal ?? code ?? "unknown") +
						"); issued action outcome may be unknown." +
						(detail === "" ? "" : " " + detail),
				),
				false,
			);
		};
		state.detach = () => {
			process.stdout.off("data", onStdout);
			process.stderr.off("data", onStderr);
			process.stdin.off("error", onError);
			process.off("error", onError);
			process.off("exit", onExit);
		};
		process.stdout.on("data", onStdout);
		process.stderr.on("data", onStderr);
		process.stdin.on("error", onError);
		process.on("error", onError);
		process.once("exit", onExit);
		state.readyTimer = setTimeout(() => {
			if (this.worker === state) this.stopWorker(new Error("computer-use driver did not signal ready in time."));
		}, this.readyTimeoutMs);
		state.readyTimer.unref();
		return state;
	}

	private consumeStdout(state: DriverWorker, chunk: string): void {
		state.stdoutBuffer += chunk;
		let newline = state.stdoutBuffer.indexOf("\n");
		while (newline >= 0 && this.worker === state) {
			if (newline > this.maxResponseChars) {
				this.stopWorker(new Error("computer-use driver exceeded the protocol line limit."));
				return;
			}
			const line = state.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
			state.stdoutBuffer = state.stdoutBuffer.slice(newline + 1);
			if (line.trim() !== "") this.consumeResponse(state, line);
			newline = state.stdoutBuffer.indexOf("\n");
		}
		if (this.worker === state && state.stdoutBuffer.length > this.maxResponseChars)
			this.stopWorker(new Error("computer-use driver exceeded the protocol buffer limit."));
	}

	private consumeResponse(state: DriverWorker, line: string): void {
		let payload: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
			payload = parsed as Record<string, unknown>;
		} catch {
			return;
		}
		if (payload.event !== undefined) {
			if (!state.readySettled && payload.event === "ready") {
				state.readySettled = true;
				if (state.readyTimer !== undefined) clearTimeout(state.readyTimer);
				state.resolveReady();
			} else if (payload.event === "control_started" || payload.event === "control_stop") {
				this.acceptControlEvent(state, payload);
			} else if (payload.event === "error")
				this.stopWorker(new Error("computer-use driver failed: " + String(payload.message ?? "unknown")));
			return;
		}
		const pending = state.pending;
		if (pending === undefined || payload.id !== pending.id) return;
		state.pending = undefined;
		clearTimeout(pending.timer);
		if (payload.ok !== true) pending.reject(new Error(String(payload.error ?? "computer-use driver command failed")));
		else if (typeof payload.data !== "object" || payload.data === null || Array.isArray(payload.data))
			pending.reject(new Error("computer-use driver returned invalid response data."));
		else pending.resolve(payload.data as Record<string, unknown>);
	}

	private acceptControlEvent(state: DriverWorker, event: Record<string, unknown>): void {
		if (this.worker !== state || state.generation !== this.generation || !state.readySettled) return;
		const { controlId, requestId } = event;
		if (
			typeof controlId !== "string" ||
			!controlId ||
			controlId.length > 128 ||
			typeof requestId !== "number" ||
			!Number.isSafeInteger(requestId) ||
			requestId <= 0
		)
			return;
		if (event.event === "control_started") {
			const pending = state.pending;
			// Neither an observe nor a tool-call prediction authorizes a control Stop.
			if (
				!pending ||
				pending.id !== requestId ||
				pending.command !== "act" ||
				pending.ownerId !== this.controlOwnerId
			)
				return;
			state.control = { controlId, requestId, ownerId: pending.ownerId };
			return;
		}
		const control = state.control;
		if (
			!control ||
			control.controlId !== controlId ||
			control.requestId !== requestId ||
			control.ownerId !== this.controlOwnerId
		)
			return;
		state.control = undefined;
		try {
			// Revoke host ownership before rejecting active/queued requests.
			this.onControlStop?.({ controlId, requestId, ownerId: control.ownerId, workerGeneration: state.generation });
		} catch (error) {
			console.warn("[owl-computer-use] control Stop callback failed:", error);
		} finally {
			// A callback may already have closed this worker or created a replacement.
			if (this.worker === state && state.generation === this.generation)
				this.stopWorker(
					new Error("computer-use control stopped by the user; any issued action outcome may be unknown."),
				);
		}
	}

	private stopWorker(error: Error, kill = true): void {
		this.clearIdleShutdown();
		const state = this.worker;
		this.worker = undefined;
		this.epoch++;
		this.invalidateObservation();
		if (state !== undefined) {
			if (state.readyTimer !== undefined) clearTimeout(state.readyTimer);
			if (!state.readySettled) {
				state.readySettled = true;
				state.rejectReady(error);
			}
			if (state.pending !== undefined) {
				clearTimeout(state.pending.timer);
				state.pending.reject(error);
				state.pending = undefined;
			}
			state.detach();
			// 终止进程后迟到的 error 不得成为未处理事件。
			state.process.on("error", () => {});
			state.process.stdin.on("error", () => {});
			if (kill && state.process.exitCode === null && !state.process.killed) state.process.kill();
		}
		if (this.active !== undefined) this.finishCommand(this.active, error);
		for (const item of this.queue.splice(0)) this.finishCommand(item, error);
	}

	private scheduleIdleShutdown(): void {
		this.clearIdleShutdown();
		if (this.worker === undefined || this.active !== undefined || this.queue.length > 0 || this.idleTimeoutMs <= 0)
			return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			this.stopWorker(new Error("computer-use driver became idle."));
		}, this.idleTimeoutMs);
		this.idleTimer.unref();
	}

	private clearIdleShutdown(): void {
		if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}
}

function abortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error
		? signal.reason
		: new Error("computer-use request aborted; issued action outcome may be unknown.");
}
